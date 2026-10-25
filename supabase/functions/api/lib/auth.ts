import { Buffer } from "node:buffer";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { config } from "./config.ts";
import type { DB } from "./db.ts";
import { nowText } from "./db.ts";

// Two people with long-lived sessions. The app keeps the session token on the
// device and sends it as a bearer token (the app and the API live on
// different domains, so cookies are not used).
// Roles: 'organizer' is the Admin, 'visionary' is the Idea contributor.

export interface User {
  id: number;
  name: string;
  email: string | null;
  role: "visionary" | "organizer";
  home: "capture" | "dashboard";
  notify_email: number;
  notify_push: number;
  // Set when the admin is previewing the app as this person (read-only).
  viewed_by?: { id: number; name: string } | null;
}

// How long a preview as the other person lasts.
export const PREVIEW_HOURS = 2;

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string | null): boolean {
  if (!stored?.startsWith("scrypt$")) return false;
  const [, salt, hash] = stored.split("$");
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(pw, Buffer.from(salt, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return timingSafeEqual(expected, actual);
}

export const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (ms: number) => nowText(new Date(ms));

export async function createSession(db: DB, userId: number, device: string | null, opts: { impersonatorId?: number } = {}): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const ms = opts.impersonatorId ? PREVIEW_HOURS * 3600_000 : config.sessionDays * 86400_000;
  await db.run(
    "INSERT INTO sessions (id, user_id, device, expires_at, impersonator_id) VALUES (?, ?, ?, ?, ?)",
    sha(token),
    userId,
    device?.slice(0, 200) ?? null,
    iso(Date.now() + ms),
    opts.impersonatorId ?? null,
  );
  return token;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

export async function userFromRequest(db: DB, req: Request): Promise<User | null> {
  const token = bearer(req);
  if (!token) return null;
  const row = await db.get<User & { sid: string; last_seen_at: string; imp_id: number | null; imp_name: string | null }>(
    `SELECT u.id, u.name, u.email, u.role, u.home, u.notify_email, u.notify_push, s.id AS sid, s.last_seen_at,
            s.impersonator_id AS imp_id, a.name AS imp_name
     FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN users a ON a.id = s.impersonator_id
     WHERE s.id = ? AND s.expires_at > ?`,
    sha(token),
    nowText(),
  );
  if (!row) return null;
  // A preview only works while the admin who opened it is still an admin.
  if (row.imp_id && !(await db.get("SELECT 1 FROM users WHERE id = ? AND role = 'organizer'", row.imp_id))) return null;
  // Sessions stay alive as long as the app is used: each visit (at most once an
  // hour) pushes the expiry a full SESSION_DAYS ahead. Previews never extend.
  if (Date.now() - Date.parse(row.last_seen_at.replace(" ", "T") + "Z") > 3600_000) {
    if (row.imp_id) await db.run("UPDATE sessions SET last_seen_at = now_text() WHERE id = ?", row.sid);
    else await db.run("UPDATE sessions SET last_seen_at = now_text(), expires_at = ? WHERE id = ?", iso(Date.now() + config.sessionDays * 86400_000), row.sid);
  }
  const { sid: _s, last_seen_at: _l, imp_id, imp_name, ...user } = row;
  return { ...user, viewed_by: imp_id ? { id: imp_id, name: imp_name ?? "Admin" } : null };
}

export async function endSession(db: DB, req: Request) {
  const token = bearer(req);
  if (token) await db.run("DELETE FROM sessions WHERE id = ?", sha(token));
}

// One-time link that signs a phone in. It opens a page in the app with a
// "Continue" button, so link previews in messaging apps can't use it up.
export async function createLoginLink(db: DB, userId: number, createdBy: number, hours = 72): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await db.run(
    "INSERT INTO login_links (token_hash, user_id, created_by, expires_at) VALUES (?, ?, ?, ?)",
    sha(token),
    userId,
    createdBy,
    iso(Date.now() + hours * 3600_000),
  );
  return `${config.appUrl}/#/signin/${token}`;
}

export async function redeemLoginLink(db: DB, token: string): Promise<number | null> {
  const row = await db.get<{ user_id: number }>(
    "SELECT user_id FROM login_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
    sha(token),
    nowText(),
  );
  if (!row) return null;
  await db.run("UPDATE login_links SET used_at = now_text() WHERE token_hash = ?", sha(token));
  return row.user_id;
}

// Brute-force protection, kept in the database because function instances come and go.
export async function loginAllowed(db: DB, key: string): Promise<boolean> {
  const row = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", `login_fail:${key}`);
  if (!row) return true;
  const v = JSON.parse(row.value) as { n: number; until: number };
  return v.until < Date.now() || v.n < 8;
}

export async function loginFailed(db: DB, key: string) {
  const row = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", `login_fail:${key}`);
  const prev = row ? (JSON.parse(row.value) as { n: number; until: number }) : null;
  const next = !prev || prev.until < Date.now() ? { n: 1, until: Date.now() + 15 * 60_000 } : { ...prev, n: prev.n + 1 };
  await db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    `login_fail:${key}`,
    JSON.stringify(next),
  );
}

export async function loginSucceeded(db: DB, key: string) {
  await db.run("DELETE FROM settings WHERE key = ?", `login_fail:${key}`);
}
