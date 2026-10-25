import type { DB } from "./db.ts";
import type { User } from "./auth.ts";

// A small router. Every route is admin-only unless it is explicitly marked as
// open to the idea contributor (`contributor`) or to signed-out visitors (`public`).

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Ctx {
  req: Request;
  url: URL;
  params: Record<string, string>;
  query: URLSearchParams;
  user: User | null;
  db: DB;
  body<T = Record<string, unknown>>(): Promise<T>;
  waitUntil(p: Promise<unknown>): void;
}

export type Handler = (c: Ctx) => Promise<unknown> | unknown;

export interface RouteOpts {
  public?: boolean; // no sign-in needed
  contributor?: boolean; // idea contributor may use it (ownership checked inside)
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  path: string;
  handler: Handler;
  opts: RouteOpts;
}

export class Router {
  routes: Route[] = [];

  add(method: string, path: string, handler: Handler, opts: RouteOpts = {}) {
    const keys: string[] = [];
    const pattern = new RegExp(
      "^" +
        path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\/:(\w+)/g, (_m, k) => {
          keys.push(k);
          return "/([^/]+)";
        }) +
        "/?$",
    );
    this.routes.push({ method, pattern, keys, path, handler, opts });
  }
  get = (p: string, h: Handler, o?: RouteOpts) => this.add("GET", p, h, o);
  post = (p: string, h: Handler, o?: RouteOpts) => this.add("POST", p, h, o);
  patch = (p: string, h: Handler, o?: RouteOpts) => this.add("PATCH", p, h, o);
  put = (p: string, h: Handler, o?: RouteOpts) => this.add("PUT", p, h, o);
  delete = (p: string, h: Handler, o?: RouteOpts) => this.add("DELETE", p, h, o);

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return null;
  }
}

export const isAdmin = (u: User | null) => u?.role === "organizer";

export function requireUser(c: Ctx): User {
  if (!c.user) throw new HttpError(401, "Please sign in.");
  return c.user;
}

export function idParam(c: Ctx, name = "id"): number {
  const v = Number(c.params[name]);
  if (!Number.isInteger(v) || v <= 0) throw new HttpError(400, "Invalid id.");
  return v;
}

export const str = (v: unknown, max = 5000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data ?? null), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "untitled"
  );
}
