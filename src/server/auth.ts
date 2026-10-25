import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import type { DB } from "./db.js";

// Two people, long-lived sessions. Passwords are optional for the person who
// only records: a one-time sign-in link (shown as a QR code) puts the app on
// their phone, and it stays signed in.

export const COOKIE = "ib_session";

export interface User {
  id: number;
  name: string;
  email: string | null;
  role: "visionary" | "organizer";
  home: "capture" | "dashboard";
  notify_email: number;
  notify_push: number;
}

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(pw: string, stored: string | null): boolean {
  if (!stored?.startsWith("scrypt$")) return false;
  const [, salt, hash] = stored.split("$");
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(pw, Buffer.from(salt, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function createSession(db: DB, userId: number, device: string | undefined): string {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + config.sessionDays * 86400_000).toISOString();
  db.prepare("INSERT INTO sessions (id, user_id, device, expires_at) VALUES (?, ?, ?, ?)").run(sha(token), userId, device?.slice(0, 200) ?? null, expires);
  return token;
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.setCookie(COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: config.publicUrl.startsWith("https://"),
    maxAge: config.sessionDays * 86400,
  });
}

export function userFromRequest(db: DB, req: FastifyRequest): User | null {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.home, u.notify_email, u.notify_push, s.id AS sid, s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`,
    )
    .get(sha(token), new Date().toISOString()) as (User & { sid: string; last_seen_at: string }) | undefined;
  if (!row) return null;
  // Touch at most hourly to avoid a write on every request.
  if (Date.now() - Date.parse(row.last_seen_at + "Z") > 3600_000) {
    db.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?").run(row.sid);
  }
  const { sid: _s, last_seen_at: _l, ...user } = row;
  return user;
}

export function endSession(db: DB, req: FastifyRequest) {
  const token = req.cookies[COOKIE];
  if (token) db.prepare("DELETE FROM sessions WHERE id = ?").run(sha(token));
}

export function createLoginLink(db: DB, userId: number, createdBy: number, hours = 72): string {
  const token = crypto.randomBytes(24).toString("base64url");
  const expires = new Date(Date.now() + hours * 3600_000).toISOString();
  db.prepare("INSERT INTO login_links (token_hash, user_id, created_by, expires_at) VALUES (?, ?, ?, ?)").run(sha(token), userId, createdBy, expires);
  return `${config.publicUrl}/login/${token}`;
}

export function redeemLoginLink(db: DB, token: string): number | null {
  const row = db
    .prepare("SELECT user_id FROM login_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .get(sha(token), new Date().toISOString()) as { user_id: number } | undefined;
  if (!row) return null;
  db.prepare("UPDATE login_links SET used_at = datetime('now') WHERE token_hash = ?").run(sha(token));
  return row.user_id;
}

// Simple brute-force protection for the password form.
const attempts = new Map<string, { n: number; until: number }>();
export function loginAllowed(key: string): boolean {
  const a = attempts.get(key);
  return !a || a.until < Date.now() || a.n < 8;
}
export function loginFailed(key: string) {
  const a = attempts.get(key);
  if (!a || a.until < Date.now()) attempts.set(key, { n: 1, until: Date.now() + 15 * 60_000 });
  else a.n++;
}
export function loginSucceeded(key: string) {
  attempts.delete(key);
}
