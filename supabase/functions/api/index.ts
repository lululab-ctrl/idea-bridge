// Idea Bridge API: one Supabase Edge Function that serves every /api route and
// runs the background worker.
import { syncAI } from "./lib/ai/index.ts";
import { AIError } from "./lib/ai/llm.ts";
import { type App, createApp } from "./lib/app.ts";
import { userFromRequest } from "./lib/auth.ts";
import { config } from "./lib/config.ts";
import { connect, type DB, nowText, setSetting } from "./lib/db.ts";
import { type Ctx, HttpError, isAdmin, json, Router } from "./lib/http.ts";
import { coreRoutes } from "./lib/routes/core.ts";
import { ideaRoutes } from "./lib/routes/ideas.ts";
import { workRoutes } from "./lib/routes/work.ts";
import { loadKeys, workerSecret } from "./lib/keys.ts";
import { localStorageImpl, storage } from "./lib/storage.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

let state: { db: DB; app: App; router: Router } | null = null;
function init() {
  if (state) return state;
  const db = connect();
  const app = createApp(db);
  const router = new Router();
  coreRoutes(router, app);
  ideaRoutes(router, app);
  workRoutes(router, app);
  state = { db, app, router };
  return state;
}

function background(p: Promise<unknown>) {
  const guarded = p.catch((err) => console.error("[background]", err));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(guarded);
}

// The scheduler calls the worker every minute. As a safety net, any request
// that finds work waiting also starts the worker (at most every 20 seconds).
let workerRegistered = false;
let lastKick = 0;
async function runWorker(app: App, budgetMs = 100_000) {
  await loadKeys(app.db);
  syncAI(app.ai, app.db);
  try {
    await app.periodic.check();
  } catch (err) {
    console.error("[periodic]", err);
  }
  const done = await app.jobs.drain(budgetMs);
  await setSetting(app.db, "worker_last_run", { at: nowText(), jobs: done });
}

function kick(app: App) {
  if (Date.now() - lastKick < 20_000) return;
  lastKick = Date.now();
  background(
    (async () => {
      if ((await app.jobs.dueNow()) > 0) await runWorker(app, 90_000);
    })(),
  );
}

async function registerWorker(db: DB) {
  if (workerRegistered || config.storageMode === "local") return;
  workerRegistered = true;
  await setSetting(db, "worker_url", `${config.supabaseUrl}/functions/v1/api/_worker`);
  await setSetting(db, "worker_secret", await workerSecret(db));
}

// APP_URL may include a path (e.g. GitHub Pages); browsers send only the origin.
const appOrigin = (() => {
  try {
    return new URL(config.appUrl).origin;
  } catch {
    return config.appUrl;
  }
})();

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = origin === appOrigin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  return allowed
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-headers": "authorization, content-type, x-ideabridge, x-upsert",
        "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "access-control-expose-headers": "content-disposition",
        "access-control-max-age": "86400",
        vary: "origin",
      }
    : { vary: "origin" };
}

export async function handle(req: Request): Promise<Response> {
  const { db, app, router } = init();
  const url = new URL(req.url);
  // Supabase passes "/api/...", other hosts may pass "/functions/v1/api/...".
  const path = url.pathname.replace(/^\/functions\/v1/, "");
  const corsHeaders = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });

  const withCors = (res: Response) => {
    for (const [k, v] of Object.entries(corsHeaders)) res.headers.set(k, v);
    res.headers.set("x-content-type-options", "nosniff");
    return res;
  };

  try {
    await registerWorker(db);

    if (path === "/api/_worker" && req.method === "POST") {
      if (req.headers.get("x-worker-secret") !== (await workerSecret(db))) throw new HttpError(403, "Forbidden.");
      const run = runWorker(app);
      if (typeof EdgeRuntime !== "undefined") {
        background(run);
        return json({ ok: true }, 202);
      }
      await run;
      return json({ ok: true });
    }

    // Local-only file storage for tests (never used on Supabase).
    const local = localStorageImpl();
    const lm = /^\/api\/_local\/([^/]+)\/(.+)$/.exec(path);
    if (local && lm) {
      const [bucket, file] = [lm[1], decodeURIComponent(lm[2])];
      if (req.method === "PUT") {
        await local.put(bucket, file, new Uint8Array(await req.arrayBuffer()));
        return withCors(json({ ok: true }));
      }
      const data = await local.read(bucket, file);
      return withCors(data ? new Response(data as Uint8Array<ArrayBuffer>) : json({ error: "Not found" }, 404));
    }

    await loadKeys(db);
    syncAI(app.ai, db);
    const m = router.match(req.method, path);
    if (!m) throw new HttpError(404, "Not found.");
    const user = await userFromRequest(db, req);
    if (!m.route.opts.public) {
      if (!user) throw new HttpError(401, "Please sign in.");
      // Everything is admin-only unless the route is open to the idea contributor.
      if (!isAdmin(user) && !m.route.opts.contributor) throw new HttpError(403, "This part of the app is managed by the admin.");
      // Previewing as the other person is look-only: nothing can be changed.
      if (user.viewed_by && req.method !== "GET" && path !== "/api/logout") {
        throw new HttpError(403, `You're previewing ${user.name}'s view, so nothing can be changed here. Go back to your own view to make changes.`);
      }
    }
    let parsed: unknown;
    const ctx: Ctx = {
      req,
      url,
      params: m.params,
      query: url.searchParams,
      user,
      db,
      body: async <T>() => {
        if (parsed === undefined) {
          try {
            parsed = (await req.json()) ?? {};
          } catch {
            parsed = {};
          }
        }
        return parsed as T;
      },
      waitUntil: background,
    };
    // Make sure the browser's storage handle exists before any file route uses it.
    storage(`${url.origin}/api`);
    const out = await m.route.handler(ctx);
    if (user) kick(app);
    return withCors(out instanceof Response ? out : json(out));
  } catch (err) {
    if (err instanceof HttpError) return withCors(json({ error: err.message }, err.status));
    if (err instanceof AIError) return withCors(json({ error: err.message }, err.retryable ? 503 : 422));
    console.error(err);
    return withCors(json({ error: "Something went wrong on the server. It has been logged." }, 500));
  }
}

if (import.meta.main) Deno.serve(handle);
