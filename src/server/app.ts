import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AI } from "./ai/index.js";
import { AIError } from "./ai/llm.js";
import { userFromRequest, type User } from "./auth.js";
import { config } from "./config.js";
import type { DB } from "./db.js";
import type { JobQueue } from "./jobs.js";
import type { Periodic } from "./periodic.js";
import type { Pipeline } from "./pipeline.js";
import { coreRoutes } from "./routes/core.js";
import { ideaRoutes } from "./routes/ideas.js";
import { workRoutes } from "./routes/work.js";

export interface Ctx {
  db: DB;
  ai: AI;
  jobs: JobQueue;
  pipeline: Pipeline;
  periodic: Periodic;
  vapidPublicKey: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    user: User | null;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function requireUser(req: FastifyRequest): User {
  if (!req.user) throw new HttpError(401, "Please sign in.");
  return req.user;
}

export const isAdmin = (u: User | null) => u?.role === "organizer";

// What the idea contributor may do. Everything else under /api requires the admin.
// Ownership (only his own recordings and ideas) is checked inside each route.
const CONTRIBUTOR_ROUTES = new Set([
  "GET /api/state",
  "GET /api/health",
  "POST /api/logout",
  "POST /api/push/subscribe",
  "GET /api/notifications",
  "POST /api/notifications/read",
  "POST /api/recordings",
  "POST /api/recordings/text",
  "GET /api/recordings",
  "GET /api/recordings/:id",
  "GET /api/recordings/:id/audio",
  "POST /api/recordings/:id/retry",
  "DELETE /api/recordings/:id",
  "GET /api/questions/open",
  "GET /api/my/ideas",
  "GET /api/my/ideas/:id",
]);

export function idParam(req: FastifyRequest, name = "id"): number {
  const v = Number((req.params as Record<string, string>)[name]);
  if (!Number.isInteger(v) || v <= 0) throw new HttpError(400, "Invalid id.");
  return v;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from src/ (tsx) and dist/ (compiled): both sit one level below the project root.
export const projectRoot = path.resolve(here, "..", "..");

export async function buildApp(ctx: Ctx) {
  const app = Fastify({
    logger: process.env.NODE_ENV === "test" ? false : { level: "warn" },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

  // Plain HTML forms (the sign-in "Continue" button) post url-encoded bodies.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) =>
    done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    req.user = userFromRequest(ctx.db, req);
    // Basic CSRF protection: state-changing API calls must come from our own
    // frontend, which always sends this header (a cross-site form cannot).
    if (req.url.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (req.headers["x-ideabridge"] !== "1") throw new HttpError(403, "Missing request header.");
    }
  });

  // Role check runs after routing, so it sees the route pattern (e.g. /api/ideas/:id).
  app.addHook("preHandler", async (req) => {
    if (!req.url.startsWith("/api/") || !req.user || isAdmin(req.user)) return;
    const key = `${req.method} ${req.routeOptions.url}`;
    if (!CONTRIBUTOR_ROUTES.has(key)) throw new HttpError(403, "This part of the app is managed by the admin.");
  });

  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Permissions-Policy", "microphone=(self), camera=(), geolocation=()");
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
    return payload;
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof AIError) return reply.status(err.retryable ? 503 : 422).send({ error: err.message });
    const e = err as { statusCode?: number; message?: string; code?: string };
    if (e.code === "FST_REQ_FILE_TOO_LARGE") return reply.status(413).send({ error: `File is larger than ${config.maxUploadMb} MB.` });
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message });
    req.log.error(err);
    console.error(err);
    return reply.status(500).send({ error: "Something went wrong on the server. It has been logged." });
  });

  await coreRoutes(app, ctx);
  await ideaRoutes(app, ctx);
  await workRoutes(app, ctx);

  // Frontend: static files plus vendored browser libraries from node_modules.
  await app.register(fastifyStatic, {
    root: path.join(projectRoot, "public"),
    prefix: "/",
    index: false,
    wildcard: false,
    // Always revalidate app files so an update reaches phones on the next open.
    setHeaders: (reply) => reply.header("Cache-Control", "no-cache"),
  });
  const vendor: Record<string, string> = {
    "preact.mjs": "node_modules/preact/dist/preact.mjs",
    "hooks.mjs": "node_modules/preact/hooks/dist/hooks.mjs",
    "htm.mjs": "node_modules/htm/dist/htm.module.js",
    "marked.mjs": "node_modules/marked/lib/marked.esm.js",
    "purify.mjs": "node_modules/dompurify/dist/purify.es.mjs",
  };
  for (const f of Object.values(vendor)) {
    if (!fs.existsSync(path.join(projectRoot, f))) throw new Error(`Missing browser library ${f}. Run npm install.`);
  }
  app.get("/vendor/:file", async (req, reply) => {
    const file = vendor[(req.params as { file: string }).file];
    if (!file) throw new HttpError(404, "Not found");
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.type("text/javascript").send(fs.createReadStream(path.join(projectRoot, file)));
  });

  const indexHtml = () => fs.readFileSync(path.join(projectRoot, "public", "index.html"), "utf8");
  const sendIndex = (_req: FastifyRequest, reply: FastifyReply) => reply.type("text/html").header("Cache-Control", "no-cache").send(indexHtml());
  app.get("/", sendIndex);
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/")) return reply.status(404).send({ error: "Not found" });
    return sendIndex(req, reply);
  });

  return app;
}
