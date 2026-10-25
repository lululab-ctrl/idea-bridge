import { ZipArchive } from "archiver";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { aiStatus } from "../ai/index.js";
import { extForMime } from "../ai/speech.js";
import { HttpError, idParam, isAdmin, requireUser, type Ctx } from "../app.js";
import {
  createLoginLink,
  createSession,
  endSession,
  hashPassword,
  loginAllowed,
  loginFailed,
  loginSucceeded,
  redeemLoginLink,
  setSessionCookie,
  verifyPassword,
} from "../auth.js";
import { config } from "../config.js";
import { getSetting, logActivity, setSetting } from "../db.js";
import { emailConfigured, notifyRole } from "../notify.js";
import { offsiteConfigured } from "../periodic.js";
import { deleteRecording, purgeRecording, purgeTrashItem, restoreFromTrash, restoreRecording } from "../trash.js";
import { safeJson } from "../search.js";
import { ideaMarkdown } from "./ideas.js";

const str = (v: unknown, max = 5000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function coreRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, jobs } = ctx;
  const userCount = () => (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n;

  // Used by the hosting platform to check the app is alive.
  app.get("/api/health", async () => {
    db.prepare("SELECT 1").get();
    return { ok: true };
  });

  // ------------------------------------------------------------ session/state
  app.get("/api/state", async (req) => ({
    setupNeeded: userCount() === 0,
    user: req.user,
    ai: aiStatus(),
    vapidPublicKey: ctx.vapidPublicKey,
    people: req.user ? db.prepare("SELECT id, name, role FROM users ORDER BY id").all() : [],
  }));

  app.post("/api/setup", async (req, reply) => {
    if (userCount() > 0) throw new HttpError(409, "Already set up.");
    const b = req.body as { organizer?: Record<string, string>; visionary?: Record<string, string>; timezone?: string };
    const oName = str(b.organizer?.name, 60);
    const vName = str(b.visionary?.name, 60);
    const pw = str(b.organizer?.password, 200);
    if (!oName || !vName) throw new HttpError(400, "Both names are required.");
    if (pw.length < 8) throw new HttpError(400, "Choose a password of at least 8 characters.");
    const vPwIn = str(b.visionary?.password, 200);
    if (vPwIn && vPwIn.length < 8) throw new HttpError(400, "The contributor's password needs at least 8 characters (or leave it empty).");
    if (oName.toLowerCase() === vName.toLowerCase()) throw new HttpError(400, "Use two different names, so each of you can sign in.");
    const ins = db.prepare("INSERT INTO users (name, email, role, password_hash, home) VALUES (?, ?, ?, ?, ?)");
    const oid = Number(ins.run(oName, str(b.organizer?.email, 200) || null, "organizer", hashPassword(pw), "dashboard").lastInsertRowid);
    const vPw = str(b.visionary?.password, 200);
    ins.run(vName, str(b.visionary?.email, 200) || null, "visionary", vPw.length >= 8 ? hashPassword(vPw) : null, "capture");
    if (b.timezone && isValidTz(b.timezone)) setSetting(db, "timezone", b.timezone);
    setSessionCookie(reply, createSession(db, oid, req.headers["user-agent"]));
    logActivity(db, oid, "setup");
    return { ok: true };
  });

  app.post("/api/login", async (req, reply) => {
    const b = req.body as { name?: string; password?: string };
    const key = `${req.ip}`;
    if (!loginAllowed(key)) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
    const name = str(b.name, 200).toLowerCase();
    const user = db
      .prepare("SELECT id, password_hash FROM users WHERE lower(name) = ? OR lower(email) = ?")
      .get(name, name) as { id: number; password_hash: string | null } | undefined;
    if (!user || !verifyPassword(str(b.password, 200), user.password_hash)) {
      loginFailed(key);
      throw new HttpError(401, "Name or password is incorrect.");
    }
    loginSucceeded(key);
    setSessionCookie(reply, createSession(db, user.id, req.headers["user-agent"]));
    return { ok: true };
  });

  app.post("/api/logout", async (req, reply) => {
    endSession(db, req);
    reply.clearCookie("ib_session", { path: "/" });
    return { ok: true };
  });

  // One-time sign-in link, opened on the other person's phone. Opening the link
  // shows a button; only pressing it signs in. Messaging apps fetch links to
  // build previews, and that must not use up the one-time link.
  app.get("/login/:token", async (req, reply) => {
    const token = (req.params as { token: string }).token.replace(/[^\w-]/g, "");
    return reply.type("text/html").header("Cache-Control", "no-store").send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Idea Bridge</title><link rel="icon" href="/icons/icon.svg">
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#14332b;font-family:system-ui,sans-serif;color:#e8efe9;text-align:center">
<form method="post" action="/login/${token}" style="padding:24px;max-width:22rem">
<img src="/icons/icon-192.png" alt="" width="72" height="72" style="border-radius:16px">
<h1 style="font-size:1.5rem">Idea Bridge</h1>
<p style="color:#a9c0b6">Tap below to open your ideas app on this phone.</p>
<button style="font:inherit;font-weight:700;background:#f0b44c;color:#5b3d05;border:0;border-radius:12px;padding:14px 28px;font-size:1.1rem;cursor:pointer">Continue</button>
</form></body>`);
  });

  app.post("/login/:token", async (req, reply) => {
    const userId = redeemLoginLink(db, (req.params as { token: string }).token);
    if (!userId) {
      return reply
        .type("text/html")
        .status(410)
        .send(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;padding:2rem;max-width:30rem;margin:auto">
<h1>This sign-in link has expired</h1><p>Sign-in links work once and expire after 3 days. Ask for a new one from Settings → People.</p><p><a href="/">Open Idea Bridge</a></p>`);
    }
    setSessionCookie(reply, createSession(db, userId, req.headers["user-agent"]));
    logActivity(db, userId, "login_link");
    return reply.redirect("/");
  });

  app.post("/api/users/:id/login-link", async (req) => {
    const me = requireUser(req);
    const id = idParam(req);
    if (!db.prepare("SELECT 1 FROM users WHERE id = ?").get(id)) throw new HttpError(404, "Person not found.");
    const url = createLoginLink(db, id, me.id);
    const qr = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { url, qr, expiresHours: 72 };
  });

  app.get("/api/users", async (req) => {
    requireUser(req);
    return db.prepare("SELECT id, name, email, role, home, created_at, password_hash IS NOT NULL AS has_password FROM users ORDER BY id").all();
  });

  app.patch("/api/users/:id", async (req) => {
    const me = requireUser(req);
    const id = idParam(req);
    const b = req.body as Record<string, unknown>;
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (typeof b.name === "string" && b.name.trim()) (sets.push("name = ?"), vals.push(str(b.name, 60)));
    if (typeof b.email === "string") (sets.push("email = ?"), vals.push(str(b.email, 200) || null));
    if (b.home === "capture" || b.home === "dashboard") (sets.push("home = ?"), vals.push(b.home));
    if (typeof b.notify_email === "boolean") (sets.push("notify_email = ?"), vals.push(b.notify_email ? 1 : 0));
    if (typeof b.notify_push === "boolean") (sets.push("notify_push = ?"), vals.push(b.notify_push ? 1 : 0));
    if (typeof b.password === "string") {
      if (b.password.length < 8) throw new HttpError(400, "Choose a password of at least 8 characters.");
      sets.push("password_hash = ?");
      vals.push(hashPassword(b.password));
    }
    if (sets.length) db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals, id);
    if (typeof b.password === "string") {
      // A new password signs that person out everywhere else.
      if (id === me.id) {
        const mine = crypto.createHash("sha256").update(req.cookies.ib_session ?? "").digest("hex");
        db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(id, mine);
      } else db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
      logActivity(db, me.id, "password", "user", id);
    }
    return { ok: true };
  });

  app.get("/api/sessions", async (req) => {
    const me = requireUser(req);
    return db.prepare("SELECT u.name, s.device, s.created_at, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id ORDER BY s.last_seen_at DESC").all().map((s) => ({ ...(s as object), me: me.id }));
  });

  app.post("/api/sessions/revoke-others", async (req) => {
    requireUser(req);
    const token = req.cookies.ib_session ?? "";
    const mine = crypto.createHash("sha256").update(token).digest("hex");
    db.prepare("DELETE FROM sessions WHERE id != ?").run(mine);
    return { ok: true };
  });

  // ------------------------------------------------------------- push/notes
  app.post("/api/push/subscribe", async (req) => {
    const me = requireUser(req);
    const b = req.body as { endpoint?: string; keys?: unknown };
    if (!b.endpoint || !b.keys) throw new HttpError(400, "Invalid subscription.");
    db.prepare(
      "INSERT INTO push_subscriptions (endpoint, user_id, keys) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys",
    ).run(b.endpoint, me.id, JSON.stringify(b.keys));
    return { ok: true };
  });

  app.get("/api/notifications", async (req) => {
    const me = requireUser(req);
    return db.prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50").all(me.id);
  });

  app.post("/api/notifications/read", async (req) => {
    const me = requireUser(req);
    db.prepare("UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL").run(me.id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- capture
  app.post("/api/recordings", async (req) => {
    const me = requireUser(req);
    const file = await req.file();
    if (!file) throw new HttpError(400, "No audio received.");
    const fields = Object.fromEntries(
      Object.entries(file.fields).map(([k, v]) => [k, (v as { value?: unknown })?.value]),
    ) as Record<string, string | undefined>;
    const clientId = str(fields.client_id, 100) || crypto.randomUUID();
    const existing = db.prepare("SELECT id, status FROM recordings WHERE client_id = ?").get(clientId) as
      | { id: number; status: string }
      | undefined;
    if (existing) {
      file.file.resume(); // already have it (the phone retried); drain the upload
      return existing;
    }
    const mime = (file.mimetype || "audio/webm").split(";")[0];
    if (!/^(audio|video)\//.test(mime)) throw new HttpError(415, "That file is not an audio recording.");
    fs.mkdirSync(config.audioDir, { recursive: true });
    const name = `${new Date().toISOString().slice(0, 10)}-${crypto.randomBytes(6).toString("hex")}.${extForMime(mime)}`;
    const dest = path.join(config.audioDir, name);
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      file.file.pipe(out);
      out.on("finish", resolve);
      out.on("error", reject);
      file.file.on("error", reject);
    });
    if (file.file.truncated) {
      fs.unlinkSync(dest);
      throw new HttpError(413, `Recording is larger than ${config.maxUploadMb} MB.`);
    }
    const size = fs.statSync(dest).size;
    if (size < 200) {
      fs.unlinkSync(dest);
      throw new HttpError(400, "The recording is empty.");
    }
    const questionId = Number(fields.question_id) || null;
    const id = Number(
      db
        .prepare(
          `INSERT INTO recordings (user_id, kind, client_id, audio_path, mime, size_bytes, duration_sec, captured_at, question_id)
           VALUES (?, 'voice', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(me.id, clientId, dest, mime, size, Number(fields.duration) || null, capturedAt(fields.captured_at), questionId).lastInsertRowid,
    );
    jobs.enqueue("process_recording", { recordingId: id });
    return { id, status: "queued" };
  });

  app.post("/api/recordings/text", async (req) => {
    const me = requireUser(req);
    const b = req.body as { text?: string; client_id?: string; question_id?: number; captured_at?: string };
    const text = str(b.text, 20000);
    if (text.length < 3) throw new HttpError(400, "Write a little more first.");
    const clientId = str(b.client_id, 100) || crypto.randomUUID();
    const existing = db.prepare("SELECT id, status FROM recordings WHERE client_id = ?").get(clientId);
    if (existing) return existing;
    const id = Number(
      db
        .prepare(
          `INSERT INTO recordings (user_id, kind, client_id, captured_at, transcript, segments, question_id, transcribed_by)
           VALUES (?, 'text', ?, ?, ?, ?, ?, 'typed')`,
        )
        .run(me.id, clientId, capturedAt(b.captured_at), text, JSON.stringify({ timed: false, segments: [] }), Number(b.question_id) || null)
        .lastInsertRowid,
    );
    jobs.enqueue("process_recording", { recordingId: id });
    return { id, status: "queued" };
  });

  app.get("/api/recordings", async (req) => {
    const me = requireUser(req);
    const q = req.query as { mine?: string; limit?: string; status?: string; before?: string };
    const where: string[] = ["r.archived = 0", "r.deleted_at IS NULL"];
    const vals: unknown[] = [];
    if (q.mine || !isAdmin(me)) (where.push("r.user_id = ?"), vals.push(me.id));
    if (q.status) (where.push("r.status = ?"), vals.push(q.status));
    if (q.before) (where.push("r.id < ?"), vals.push(Number(q.before)));
    const rows = db
      .prepare(
        `SELECT r.id, r.kind, r.captured_at, r.duration_sec, r.status, r.error, r.summary, r.question_id, r.user_id,
           u.name AS user_name, substr(r.transcript, 1, 280) AS excerpt,
           (SELECT last_error FROM jobs j WHERE j.type = 'process_recording' AND j.payload = json_object('recordingId', r.id) AND j.status = 'pending' ORDER BY j.id DESC LIMIT 1) AS retrying
         FROM recordings r LEFT JOIN users u ON u.id = r.user_id
         WHERE ${where.join(" AND ")} ORDER BY r.id DESC LIMIT ?`,
      )
      .all(...vals, Math.min(Number(q.limit) || 30, 200)) as { id: number }[];
    const ideasFor = db.prepare(
      "SELECT DISTINCT i.id, i.title FROM fragments f JOIN ideas i ON i.id = f.idea_id WHERE f.recording_id = ?",
    );
    return rows.map((r) => ({ ...r, ideas: ideasFor.all(r.id) }));
  });

  app.get("/api/recordings/:id", async (req) => {
    const me = requireUser(req);
    const id = idParam(req);
    const r = db
      .prepare(
        `SELECT r.id, r.kind, r.captured_at, r.duration_sec, r.status, r.error, r.summary, r.transcript, r.segments, r.language,
           r.transcribed_by, r.question_id, r.user_id, u.name AS user_name, r.audio_path IS NOT NULL AS has_audio,
           r.deleted_at, r.purged_at, d.name AS deleted_by_name
         FROM recordings r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN users d ON d.id = r.deleted_by WHERE r.id = ?`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!r || (!isAdmin(me) && (r.user_id !== me.id || r.deleted_at))) throw new HttpError(404, "Recording not found.");
    const fragments = db
      .prepare(
        `SELECT f.id, f.title, f.quote, f.start_sec, f.end_sec, f.summary, f.interpretation, f.kind, f.commitment, f.link_decision,
           f.idea_id, i.title AS idea_title, i.status AS idea_status
         FROM fragments f LEFT JOIN ideas i ON i.id = f.idea_id WHERE f.recording_id = ? ORDER BY f.position`,
      )
      .all(id) as Record<string, unknown>[];
    const question = r.question_id ? db.prepare("SELECT id, text, idea_id FROM questions WHERE id = ?").get(r.question_id) : null;
    return {
      ...r,
      segments: safeJson(r.segments as string, { timed: false, segments: [] }),
      fragments: fragments.map((f) => ({ ...f, link_decision: safeJson(f.link_decision as string, null) })),
      question,
    };
  });

  app.get("/api/recordings/:id/audio", async (req, reply) => {
    const me = requireUser(req);
    const r = db.prepare("SELECT audio_path, mime, user_id, deleted_at FROM recordings WHERE id = ?").get(idParam(req)) as
      | { audio_path: string | null; mime: string | null; user_id: number | null; deleted_at: string | null }
      | undefined;
    if (r && !isAdmin(me) && (r.user_id !== me.id || r.deleted_at)) throw new HttpError(404, "Audio not found.");
    if (!r?.audio_path || !fs.existsSync(r.audio_path)) throw new HttpError(404, "Audio not found.");
    return sendFileWithRange(req, reply, r.audio_path, r.mime ?? "audio/webm");
  });

  app.post("/api/recordings/:id/retry", async (req) => {
    const me = requireUser(req);
    const id = idParam(req);
    const r = db.prepare("SELECT status, user_id, deleted_at FROM recordings WHERE id = ?").get(id) as
      | { status: string; user_id: number | null; deleted_at: string | null }
      | undefined;
    if (!r || r.deleted_at || (!isAdmin(me) && r.user_id !== me.id)) throw new HttpError(404, "Recording not found.");
    if (r.status === "done") return { ok: true };
    db.prepare("UPDATE recordings SET status = 'queued', error = NULL WHERE id = ?").run(id);
    db.prepare("DELETE FROM jobs WHERE type = 'process_recording' AND payload = ? AND status = 'pending'").run(JSON.stringify({ recordingId: id }));
    jobs.enqueue("process_recording", { recordingId: id });
    return { ok: true };
  });

  app.patch("/api/recordings/:id", async (req) => {
    const me = requireUser(req);
    const b = req.body as { archived?: boolean };
    if (typeof b.archived === "boolean") {
      db.prepare("UPDATE recordings SET archived = ? WHERE id = ?").run(b.archived ? 1 : 0, idParam(req));
      logActivity(db, me.id, b.archived ? "archive" : "unarchive", "recording", idParam(req));
    }
    return { ok: true };
  });

  // Deleting a recording moves it to the trash. Ideas, reports and projects built
  // from it are not touched, and the admin can restore it.
  app.delete("/api/recordings/:id", async (req) => {
    const me = requireUser(req);
    const id = idParam(req);
    const r = db.prepare("SELECT user_id, deleted_at FROM recordings WHERE id = ?").get(id) as
      | { user_id: number | null; deleted_at: string | null }
      | undefined;
    if (!r || (!isAdmin(me) && r.user_id !== me.id)) throw new HttpError(404, "Recording not found.");
    deleteRecording(db, id, me);
    if (!isAdmin(me)) notifyRole(db, "organizer", { title: `${me.name} deleted a recording`, body: "It's in the trash. Ideas from it are unchanged.", url: "#/review" }, { push: false });
    return { ok: true };
  });

  app.post("/api/recordings/:id/restore", async (req) => {
    const me = requireUser(req);
    const id = idParam(req);
    restoreRecording(db, id, me.id);
    const r = db.prepare("SELECT status, purged_at FROM recordings WHERE id = ?").get(id) as { status: string; purged_at: string | null } | undefined;
    if (r && !r.purged_at && !["done", "failed"].includes(r.status)) jobs.enqueue("process_recording", { recordingId: id });
    db.prepare("UPDATE review_items SET status = 'done', resolution = 'restored', resolved_at = datetime('now') WHERE kind = 'recording_deleted' AND status = 'open' AND recording_id = ?").run(id);
    return { ok: true };
  });

  app.delete("/api/recordings/:id/purge", async (req) => {
    const me = requireUser(req);
    if ((req.body as { confirm?: string } | undefined)?.confirm !== "DELETE") throw new HttpError(400, "Type DELETE to confirm.");
    if (!purgeRecording(db, idParam(req), me.id)) throw new HttpError(400, "Only recordings in the trash can be removed permanently.");
    return { ok: true };
  });

  // ------------------------------------------------------------------- trash
  app.get("/api/trash", async (req) => {
    requireUser(req);
    const recordings = db
      .prepare(
        `SELECT r.id, r.captured_at, r.summary, r.deleted_at, r.purged_at, r.duration_sec, u.name AS user_name, d.name AS deleted_by_name,
           (SELECT COUNT(DISTINCT idea_id) FROM fragments f WHERE f.recording_id = r.id AND f.idea_id IS NOT NULL) AS ideas
         FROM recordings r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN users d ON d.id = r.deleted_by
         WHERE r.deleted_at IS NOT NULL ORDER BY r.deleted_at DESC`,
      )
      .all();
    const items = db
      .prepare("SELECT t.id, t.entity, t.label, t.deleted_at, u.name AS deleted_by_name FROM trash t LEFT JOIN users u ON u.id = t.deleted_by ORDER BY t.id DESC")
      .all();
    return { recordings, items };
  });

  app.post("/api/trash/:id/restore", async (req) => {
    const me = requireUser(req);
    const r = restoreFromTrash(db, idParam(req), me.id);
    if (!r.ok) throw new HttpError(404, r.reason ?? "Can't restore.");
    return { ok: true };
  });

  app.delete("/api/trash/:id", async (req) => {
    const me = requireUser(req);
    if ((req.body as { confirm?: string } | undefined)?.confirm !== "DELETE") throw new HttpError(400, "Type DELETE to confirm.");
    purgeTrashItem(db, idParam(req), me.id);
    return { ok: true };
  });

  // His ideas, read-only: the ideas his own recordings fed into.
  app.get("/api/my/ideas", async (req) => {
    const me = requireUser(req);
    return db
      .prepare(
        `SELECT i.id, i.title, i.summary, i.status, i.last_activity_at, i.created_at, COUNT(f.id) AS mentions, MAX(r.captured_at) AS last_mentioned
         FROM ideas i JOIN fragments f ON f.idea_id = i.id JOIN recordings r ON r.id = f.recording_id
         WHERE r.user_id = ? AND r.deleted_at IS NULL GROUP BY i.id ORDER BY last_mentioned DESC LIMIT 300`,
      )
      .all(me.id);
  });

  app.get("/api/my/ideas/:id", async (req) => {
    const me = requireUser(req);
    const id = idParam(req);
    const fragments = db
      .prepare(
        `SELECT f.id, f.quote, f.start_sec, f.recording_id, r.captured_at, r.audio_path IS NOT NULL AS has_audio
         FROM fragments f JOIN recordings r ON r.id = f.recording_id
         WHERE f.idea_id = ? AND r.user_id = ? AND r.deleted_at IS NULL ORDER BY r.captured_at DESC`,
      )
      .all(id, me.id);
    if (!fragments.length) throw new HttpError(404, "Idea not found.");
    const idea = db
      .prepare("SELECT i.id, i.title, i.summary, i.status, i.created_at, p.name AS project_name FROM ideas i LEFT JOIN projects p ON p.id = i.project_id WHERE i.id = ?")
      .get(id);
    const questions = db
      .prepare("SELECT id, text, status, answer_text FROM questions WHERE idea_id = ? AND status IN ('asked','answered') ORDER BY id")
      .all(id);
    return { ...(idea as object), fragments, questions };
  });

  // Questions waiting for the person who records ideas.
  app.get("/api/questions/open", async (req) => {
    requireUser(req);
    return db
      .prepare(
        `SELECT q.id, q.text, q.asked_at, q.idea_id, i.title AS idea_title, u.name AS asked_by_name
         FROM questions q JOIN ideas i ON i.id = q.idea_id LEFT JOIN users u ON u.id = q.asked_by
         WHERE q.status = 'asked' ORDER BY q.asked_at`,
      )
      .all();
  });

  // ---------------------------------------------------------------- settings
  app.get("/api/settings", async (req) => {
    requireUser(req);
    return {
      north_star: getSetting(db, "north_star", ""),
      output_language: getSetting(db, "output_language", "English"),
      timezone: getSetting(db, "timezone", config.timezone),
      digest_hour: getSetting(db, "digest_hour", 7),
      weights: getSetting(db, "weights", defaultWeights),
    };
  });

  app.put("/api/settings", async (req) => {
    const me = requireUser(req);
    const b = req.body as Record<string, unknown>;
    if (typeof b.north_star === "string") setSetting(db, "north_star", str(b.north_star, 8000));
    if (typeof b.output_language === "string" && b.output_language.trim()) setSetting(db, "output_language", str(b.output_language, 40));
    if (typeof b.timezone === "string") {
      if (!isValidTz(b.timezone)) throw new HttpError(400, "Unknown time zone.");
      setSetting(db, "timezone", b.timezone);
    }
    if (typeof b.digest_hour === "number" && b.digest_hour >= 0 && b.digest_hour <= 23) setSetting(db, "digest_hour", Math.round(b.digest_hour));
    if (b.weights && typeof b.weights === "object") {
      const w: Record<string, number> = {};
      for (const k of Object.keys(defaultWeights)) {
        const v = Number((b.weights as Record<string, unknown>)[k]);
        w[k] = Number.isFinite(v) ? Math.max(0, Math.min(3, v)) : 1;
      }
      setSetting(db, "weights", w);
    }
    logActivity(db, me.id, "settings");
    return { ok: true };
  });

  // What the AI has been taught: vocabulary and preferences.
  app.get("/api/memory", async (req) => {
    requireUser(req);
    return db
      .prepare(
        `SELECT m.*, u.name AS user_name, i.title AS idea_title FROM memory m
         LEFT JOIN users u ON u.id = m.user_id LEFT JOIN ideas i ON i.id = m.source_idea_id ORDER BY m.kind, m.id DESC`,
      )
      .all();
  });

  app.post("/api/memory", async (req) => {
    const me = requireUser(req);
    const b = req.body as { kind?: string; term?: string; body?: string; idea_id?: number };
    const kind = ["glossary", "preference", "correction"].includes(String(b.kind)) ? String(b.kind) : "preference";
    const body = str(b.body, 1000);
    if (!body) throw new HttpError(400, "Write what the AI should learn.");
    if (kind === "glossary" && !str(b.term, 80)) throw new HttpError(400, "A glossary entry needs the word or phrase.");
    const id = db
      .prepare("INSERT INTO memory (kind, term, body, source_idea_id, user_id) VALUES (?, ?, ?, ?, ?)")
      .run(kind, str(b.term, 80) || null, body, Number(b.idea_id) || null, me.id).lastInsertRowid;
    return { id: Number(id) };
  });

  app.patch("/api/memory/:id", async (req) => {
    requireUser(req);
    const b = req.body as { term?: string; body?: string; active?: boolean };
    const id = idParam(req);
    if (typeof b.body === "string") db.prepare("UPDATE memory SET body = ? WHERE id = ?").run(str(b.body, 1000), id);
    if (typeof b.term === "string") db.prepare("UPDATE memory SET term = ? WHERE id = ?").run(str(b.term, 80) || null, id);
    if (typeof b.active === "boolean") db.prepare("UPDATE memory SET active = ? WHERE id = ?").run(b.active ? 1 : 0, id);
    return { ok: true };
  });

  app.delete("/api/memory/:id", async (req) => {
    requireUser(req);
    db.prepare("DELETE FROM memory WHERE id = ?").run(idParam(req));
    return { ok: true };
  });

  // -------------------------------------------------------------- system/ops
  app.get("/api/system", async (req) => {
    requireUser(req);
    const usage = db
      .prepare(
        `SELECT substr(created_at, 1, 7) AS month, provider, purpose, ROUND(SUM(cost_usd), 4) AS cost,
           SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, ROUND(SUM(audio_seconds) / 60.0, 1) AS audio_minutes, COUNT(*) AS calls
         FROM ai_usage GROUP BY month, provider, purpose ORDER BY month DESC, cost DESC`,
      )
      .all();
    const failed = db
      .prepare("SELECT id, type, payload, last_error, updated_at FROM jobs WHERE status = 'failed' ORDER BY id DESC LIMIT 20")
      .all();
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM recordings) AS recordings, (SELECT COUNT(*) FROM ideas) AS ideas,
           (SELECT COALESCE(SUM(size_bytes), 0) FROM recordings) AS audio_bytes, (SELECT COUNT(*) FROM tasks) AS tasks`,
      )
      .get();
    return {
      ai: aiStatus(),
      email: emailConfigured(),
      offsiteBackup: offsiteConfigured(),
      lastBackup: getSetting(db, "last_backup", null),
      pendingJobs: jobs.pending(),
      failed,
      usage,
      counts,
      publicUrl: config.publicUrl,
    };
  });

  app.post("/api/jobs/:id/retry", async (req) => {
    requireUser(req);
    const job = db.prepare("SELECT type, payload FROM jobs WHERE id = ? AND status = 'failed'").get(idParam(req)) as
      | { type: string; payload: string }
      | undefined;
    if (!job) throw new HttpError(404, "Nothing to retry.");
    db.prepare("UPDATE jobs SET status = 'done', last_error = last_error || ' (retried)' WHERE id = ?").run(idParam(req));
    jobs.enqueue(job.type, JSON.parse(job.payload));
    return { ok: true };
  });

  app.post("/api/backup", async (req) => {
    requireUser(req);
    const file = await ctx.periodic.backup();
    return { ok: true, file: path.basename(file) };
  });

  // Everything in one zip: database snapshot, readable Markdown for every idea,
  // all original audio and attachments. Nothing is locked in.
  app.get("/api/export", async (req, reply) => {
    const me = requireUser(req);
    logActivity(db, me.id, "export");
    const snapshot = path.join(config.backupDir, `export-${Date.now()}.db`);
    fs.mkdirSync(config.backupDir, { recursive: true });
    await db.backup(snapshot);
    const zip = new ZipArchive({ zlib: { level: 6 } });
    zip.on("end", () => fs.rm(snapshot, () => undefined));
    reply.header("Content-Disposition", `attachment; filename="idea-bridge-export-${new Date().toISOString().slice(0, 10)}.zip"`);
    reply.type("application/zip");
    zip.file(snapshot, { name: "database/ideabridge.db" });
    const ideas = db.prepare("SELECT id, title FROM ideas ORDER BY id").all() as { id: number; title: string }[];
    for (const i of ideas) zip.append(ideaMarkdown(db, i.id), { name: `ideas/${i.id}-${slug(i.title)}.md` });
    const recs = db.prepare("SELECT id, captured_at, transcript, audio_path FROM recordings ORDER BY id").all() as {
      id: number;
      captured_at: string;
      transcript: string | null;
      audio_path: string | null;
    }[];
    for (const r of recs) {
      zip.append(`Recorded ${r.captured_at}\n\n${r.transcript ?? "(not transcribed)"}\n`, { name: `transcripts/${r.id}.txt` });
      if (r.audio_path && fs.existsSync(r.audio_path)) zip.file(r.audio_path, { name: `audio/${r.id}-${path.basename(r.audio_path)}` });
    }
    const atts = db.prepare("SELECT id, name, path FROM attachments WHERE path IS NOT NULL").all() as { id: number; name: string; path: string }[];
    for (const a of atts) if (fs.existsSync(a.path)) zip.file(a.path, { name: `attachments/${a.id}-${a.name}` });
    const deliverables = db.prepare("SELECT id, title, markdown FROM deliverables").all() as { id: number; title: string; markdown: string }[];
    for (const d of deliverables) zip.append(d.markdown, { name: `documents/${d.id}-${slug(d.title)}.md` });
    void zip.finalize();
    return reply.send(zip);
  });
}

export const defaultWeights = { value: 1.5, feasibility: 1, cost: 1, complexity: 0.75, strategic_fit: 1.5, effort: 1 };

function capturedAt(v: string | undefined): string {
  const d = v ? new Date(v) : new Date();
  const t = Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 86400_000 ? new Date() : d;
  return t.toISOString().replace("T", " ").slice(0, 19);
}

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
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

// Audio players on phones request byte ranges; Safari refuses to play without them.
export function sendFileWithRange(req: FastifyRequest, reply: FastifyReply, file: string, mime: string) {
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  reply.header("Accept-Ranges", "bytes");
  reply.header("Cache-Control", "private, max-age=3600");
  reply.type(mime);
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? Number(m[1]) : 0;
    let end = m && m[2] ? Number(m[2]) : size - 1;
    if (m && !m[1] && m[2]) {
      start = size - Number(m[2]);
      end = size - 1;
    }
    if (start >= size || end >= size || start > end) {
      reply.header("Content-Range", `bytes */${size}`);
      return reply.status(416).send();
    }
    reply.status(206);
    reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
    reply.header("Content-Length", end - start + 1);
    return reply.send(fs.createReadStream(file, { start, end }));
  }
  reply.header("Content-Length", size);
  return reply.send(fs.createReadStream(file));
}
