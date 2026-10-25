import { zipSync, strToU8 } from "fflate";
import QRCode from "qrcode";
import { aiStatus, syncAI } from "../ai/index.ts";
import { budgetStatus } from "../ai/llm.ts";
import { extForMime } from "../ai/speech.ts";
import type { App } from "../app.ts";
import {
  createLoginLink,
  createSession,
  endSession,
  bearer,
  hashPassword,
  loginAllowed,
  loginFailed,
  loginSucceeded,
  redeemLoginLink,
  sha,
  verifyPassword,
} from "../auth.ts";
import { config } from "../config.ts";
import { getSetting, logActivity, safeJson, setSetting } from "../db.ts";
import { HttpError, idParam, isAdmin, type Router, requireUser, slug, str } from "../http.ts";
import { emailConfigured, initPush, notifyRole } from "../notify.ts";
import { checkKey, type KeyName, keySummary, saveKey } from "../keys.ts";
import { storage } from "../storage.ts";
import { deleteRecording, purgeRecording, purgeTrashItem, restoreFromTrash, restoreRecording } from "../trash.ts";
import { ideaMarkdown } from "./ideas.ts";

export const defaultWeights = { value: 1.5, feasibility: 1, cost: 1, complexity: 0.75, strategic_fit: 1.5, effort: 1 };

function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function capturedAt(v: unknown): string {
  const d = typeof v === "string" && v ? new Date(v) : new Date();
  const t = Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 86400_000 ? new Date() : d;
  return t.toISOString().replace("T", " ").slice(0, 19);
}

export function coreRoutes(r: Router, app: App) {
  const { jobs } = app;

  r.get("/api/health", async (c) => {
    await c.db.get("SELECT 1");
    return { ok: true };
  }, { public: true });

  r.get("/api/state", async (c) => {
    const n = (await c.db.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM users"))?.n ?? 0;
    return {
      setupNeeded: n === 0,
      user: c.user,
      ai: aiStatus(),
      vapidPublicKey: await initPush(c.db),
      people: c.user ? await c.db.all("SELECT id, name, role FROM users ORDER BY id") : [],
    };
  }, { public: true });

  // First run: the first person to open the app creates both accounts.
  r.post("/api/setup", async (c) => {
    const b = await c.body<{ organizer?: Record<string, string>; visionary?: Record<string, string>; timezone?: string }>();
    return await c.db.tx(async (db) => {
      const n = (await db.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM users"))?.n ?? 0;
      if (n > 0) throw new HttpError(409, "Already set up.");
      const oName = str(b.organizer?.name, 60);
      const vName = str(b.visionary?.name, 60);
      const pw = str(b.organizer?.password, 200);
      const vPw = str(b.visionary?.password, 200);
      if (!oName || !vName) throw new HttpError(400, "Both names are required.");
      if (pw.length < 8) throw new HttpError(400, "Choose a password of at least 8 characters.");
      if (vPw && vPw.length < 8) throw new HttpError(400, "The contributor's password needs at least 8 characters (or leave it empty).");
      if (oName.toLowerCase() === vName.toLowerCase()) throw new HttpError(400, "Use two different names, so each of you can sign in.");
      const ins = "INSERT INTO users (name, email, role, password_hash, home) VALUES (?, ?, ?, ?, ?)";
      const oid = await db.insert(ins, oName, str(b.organizer?.email, 200) || null, "organizer", hashPassword(pw), "dashboard");
      await db.insert(ins, vName, str(b.visionary?.email, 200) || null, "visionary", vPw ? hashPassword(vPw) : null, "capture");
      if (b.timezone && isValidTz(b.timezone)) await setSetting(db, "timezone", b.timezone);
      await logActivity(db, oid, "setup");
      return { ok: true, token: await createSession(db, oid, c.req.headers.get("user-agent")) };
    });
  }, { public: true });

  r.post("/api/login", async (c) => {
    const b = await c.body<{ name?: string; password?: string }>();
    const key = c.req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
    if (!(await loginAllowed(c.db, key))) throw new HttpError(429, "Too many attempts. Try again in 15 minutes.");
    const name = str(b.name, 200).toLowerCase();
    const user = await c.db.get<{ id: number; password_hash: string | null }>(
      "SELECT id, password_hash FROM users WHERE lower(name) = ? OR lower(email) = ?",
      name,
      name,
    );
    if (!user || !verifyPassword(str(b.password, 200), user.password_hash)) {
      await loginFailed(c.db, key);
      throw new HttpError(401, "Name or password is incorrect.");
    }
    await loginSucceeded(c.db, key);
    return { ok: true, token: await createSession(c.db, user.id, c.req.headers.get("user-agent")) };
  }, { public: true });

  r.post("/api/logout", async (c) => {
    await endSession(c.db, c.req);
    return { ok: true };
  }, { contributor: true });

  // One-time sign-in link (opened from a QR code on the other person's phone).
  r.post("/api/signin-link", async (c) => {
    const token = str((await c.body<{ token?: string }>()).token, 200);
    const userId = token ? await redeemLoginLink(c.db, token) : null;
    if (!userId) throw new HttpError(410, "This sign-in link has expired or was already used. Ask for a new one.");
    await logActivity(c.db, userId, "login_link");
    return { ok: true, token: await createSession(c.db, userId, c.req.headers.get("user-agent")) };
  }, { public: true });

  r.post("/api/users/:id/login-link", async (c) => {
    const me = requireUser(c);
    const id = idParam(c);
    if (!(await c.db.get("SELECT 1 FROM users WHERE id = ?", id))) throw new HttpError(404, "Person not found.");
    const url = await createLoginLink(c.db, id, me.id);
    const qr = await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { url, qr, expiresHours: 72 };
  });

  r.get("/api/users", (c) =>
    c.db.all("SELECT id, name, email, role, home, created_at, password_hash IS NOT NULL AS has_password FROM users ORDER BY id"),
  );

  r.patch("/api/users/:id", async (c) => {
    const me = requireUser(c);
    const id = idParam(c);
    const b = await c.body();
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
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
    if (sets.length) await c.db.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, ...vals, id);
    if (typeof b.password === "string") {
      // A new password signs that person out everywhere else.
      const mine = sha(bearer(c.req) ?? "");
      if (id === me.id) await c.db.run("DELETE FROM sessions WHERE user_id = ? AND id != ?", id, mine);
      else await c.db.run("DELETE FROM sessions WHERE user_id = ?", id);
      await logActivity(c.db, me.id, "password", "user", id);
    }
    return { ok: true };
  });

  // ------------------------------------------------------------- push/notes
  r.post("/api/push/subscribe", async (c) => {
    const me = requireUser(c);
    const b = await c.body<{ endpoint?: string; keys?: unknown }>();
    if (!b.endpoint || !b.keys) throw new HttpError(400, "Invalid subscription.");
    await c.db.run(
      "INSERT INTO push_subscriptions (endpoint, user_id, keys) VALUES (?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, keys = excluded.keys",
      b.endpoint,
      me.id,
      JSON.stringify(b.keys),
    );
    return { ok: true };
  }, { contributor: true });

  r.get("/api/notifications", (c) => c.db.all("SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50", requireUser(c).id), { contributor: true });

  r.post("/api/notifications/read", async (c) => {
    await c.db.run("UPDATE notifications SET read_at = now_text() WHERE user_id = ? AND read_at IS NULL", requireUser(c).id);
    return { ok: true };
  }, { contributor: true });

  // ---------------------------------------------------------------- capture
  // Step 1 of an upload: register the recording and get a one-time upload link.
  // Safe to repeat: the phone's id for the recording makes it idempotent.
  r.post("/api/recordings", async (c) => {
    const me = requireUser(c);
    const b = await c.body();
    const clientId = str(b.client_id, 100) || crypto.randomUUID();
    const mime = (str(b.mime, 100) || "audio/webm").split(";")[0];
    if (!/^(audio|video)\//.test(mime)) throw new HttpError(415, "That file is not an audio recording.");
    const size = Number(b.size) || 0;
    if (size > config.maxUploadMb * 1024 * 1024) throw new HttpError(413, `Recordings can be up to ${config.maxUploadMb} MB (about 25 minutes).`);
    let rec = await c.db.get<{ id: number; status: string; audio_path: string; user_id: number }>(
      "SELECT id, status, audio_path, user_id FROM recordings WHERE client_id = ?",
      clientId,
    );
    if (rec && rec.user_id !== me.id) throw new HttpError(409, "Duplicate upload id.");
    if (!rec) {
      const path = `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${extForMime(mime)}`;
      const id = await c.db.insert(
        `INSERT INTO recordings (user_id, kind, client_id, audio_path, mime, size_bytes, duration_sec, captured_at, question_id, status)
         VALUES (?, 'voice', ?, ?, ?, ?, ?, ?, ?, 'uploading')`,
        me.id,
        clientId,
        path,
        mime,
        size || null,
        Number(b.duration) || null,
        capturedAt(b.captured_at),
        Number(b.question_id) || null,
      );
      rec = { id, status: "uploading", audio_path: path, user_id: me.id };
    }
    if (rec.status !== "uploading") return { id: rec.id, status: rec.status, uploaded: true };
    return { id: rec.id, status: rec.status, uploadUrl: await storage(c.url.origin + "/api").uploadUrl("audio", rec.audio_path), mime };
  }, { contributor: true });

  // Step 2: the phone finished uploading.
  r.post("/api/recordings/:id/uploaded", async (c) => {
    const me = requireUser(c);
    const id = idParam(c);
    const rec = await c.db.get<{ status: string; audio_path: string; user_id: number }>("SELECT status, audio_path, user_id FROM recordings WHERE id = ?", id);
    if (!rec || rec.user_id !== me.id) throw new HttpError(404, "Recording not found.");
    if (rec.status !== "uploading") return { id, status: rec.status };
    const size = await storage(c.url.origin + "/api").size("audio", rec.audio_path);
    if (!size || size < 200) throw new HttpError(400, "The upload didn't arrive. It will be retried.");
    await c.db.run("UPDATE recordings SET status = 'queued', size_bytes = ? WHERE id = ?", size, id);
    await jobs.enqueue("process_recording", { recordingId: id });
    return { id, status: "queued" };
  }, { contributor: true });

  r.post("/api/recordings/text", async (c) => {
    const me = requireUser(c);
    const b = await c.body();
    const text = str(b.text, 20000);
    if (text.length < 3) throw new HttpError(400, "Write a little more first.");
    const clientId = str(b.client_id, 100) || crypto.randomUUID();
    const existing = await c.db.get<{ id: number; status: string }>("SELECT id, status FROM recordings WHERE client_id = ?", clientId);
    if (existing) return existing;
    const id = await c.db.insert(
      `INSERT INTO recordings (user_id, kind, client_id, captured_at, transcript, segments, question_id, transcribed_by, status)
       VALUES (?, 'text', ?, ?, ?, ?, ?, 'typed', 'queued')`,
      me.id,
      clientId,
      capturedAt(b.captured_at),
      text,
      JSON.stringify({ timed: false, segments: [] }),
      Number(b.question_id) || null,
    );
    await jobs.enqueue("process_recording", { recordingId: id });
    return { id, status: "queued" };
  }, { contributor: true });

  r.get("/api/recordings", async (c) => {
    const me = requireUser(c);
    const q = c.query;
    const where = ["r.archived = 0", "r.deleted_at IS NULL", "r.status != 'uploading'"];
    const vals: (string | number)[] = [];
    if (q.get("mine") || !isAdmin(me)) (where.push("r.user_id = ?"), vals.push(me.id));
    if (q.get("status")) (where.push("r.status = ?"), vals.push(q.get("status")!));
    const rows = await c.db.all<{ id: number }>(
      `SELECT r.id, r.kind, r.captured_at, r.duration_sec, r.status, r.error, r.summary, r.question_id, r.user_id,
         u.name AS user_name, substr(r.transcript, 1, 280) AS excerpt,
         (SELECT last_error FROM jobs j WHERE j.type IN ('process_recording','analyze_recording','handle_fragment')
            AND (j.payload::jsonb->>'recordingId')::int = r.id AND j.status = 'pending' AND j.last_error IS NOT NULL ORDER BY j.id DESC LIMIT 1) AS retrying
       FROM recordings r LEFT JOIN users u ON u.id = r.user_id
       WHERE ${where.join(" AND ")} ORDER BY r.id DESC LIMIT ?`,
      ...vals,
      Math.min(Number(q.get("limit")) || 30, 200),
    );
    const out = [];
    for (const row of rows) {
      out.push({ ...row, ideas: await c.db.all("SELECT DISTINCT i.id, i.title FROM fragments f JOIN ideas i ON i.id = f.idea_id WHERE f.recording_id = ?", row.id) });
    }
    return out;
  }, { contributor: true });

  r.get("/api/recordings/:id", async (c) => {
    const me = requireUser(c);
    const id = idParam(c);
    const rec = await c.db.get<Record<string, unknown>>(
      `SELECT r.id, r.kind, r.captured_at, r.duration_sec, r.status, r.error, r.summary, r.transcript, r.segments, r.language,
         r.transcribed_by, r.question_id, r.user_id, u.name AS user_name, r.audio_path IS NOT NULL AS has_audio,
         r.deleted_at, r.purged_at, r.audio_removed_at, d.name AS deleted_by_name
       FROM recordings r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN users d ON d.id = r.deleted_by WHERE r.id = ?`,
      id,
    );
    if (!rec || (!isAdmin(me) && (rec.user_id !== me.id || rec.deleted_at))) throw new HttpError(404, "Recording not found.");
    const fragments = await c.db.all<Record<string, unknown>>(
      `SELECT f.id, f.title, f.quote, f.start_sec, f.end_sec, f.summary, f.interpretation, f.kind, f.commitment, f.link_decision,
         f.idea_id, i.title AS idea_title, i.status AS idea_status
       FROM fragments f LEFT JOIN ideas i ON i.id = f.idea_id WHERE f.recording_id = ? ORDER BY f.position`,
      id,
    );
    const question = rec.question_id ? await c.db.get("SELECT id, text, idea_id FROM questions WHERE id = ?", rec.question_id as number) : null;
    return {
      ...rec,
      segments: safeJson(rec.segments as string, { timed: false, segments: [] }),
      fragments: fragments.map((f) => ({ ...f, link_decision: safeJson(f.link_decision as string, null) })),
      question,
    };
  }, { contributor: true });

  // Returns a short-lived link the audio player can stream from.
  r.get("/api/recordings/:id/audio", async (c) => {
    const me = requireUser(c);
    const rec = await c.db.get<{ audio_path: string | null; user_id: number | null; deleted_at: string | null }>(
      "SELECT audio_path, user_id, deleted_at FROM recordings WHERE id = ?",
      idParam(c),
    );
    if (!rec || (!isAdmin(me) && (rec.user_id !== me.id || rec.deleted_at))) throw new HttpError(404, "Audio not found.");
    if (!rec.audio_path) throw new HttpError(404, "The audio of this recording is no longer stored. Its transcript is kept.");
    return { url: await storage(c.url.origin + "/api").signedUrl("audio", rec.audio_path, 3600) };
  }, { contributor: true });

  r.post("/api/recordings/:id/retry", async (c) => {
    const me = requireUser(c);
    const id = idParam(c);
    const rec = await c.db.get<{ status: string; user_id: number | null; deleted_at: string | null }>("SELECT status, user_id, deleted_at FROM recordings WHERE id = ?", id);
    if (!rec || rec.deleted_at || (!isAdmin(me) && rec.user_id !== me.id)) throw new HttpError(404, "Recording not found.");
    if (rec.status === "done" || rec.status === "uploading") return { ok: true };
    await c.db.run("UPDATE recordings SET status = 'queued', error = NULL WHERE id = ?", id);
    await jobs.enqueue("process_recording", { recordingId: id });
    return { ok: true };
  }, { contributor: true });

  // Deleting moves it to the trash; ideas and projects built from it are untouched.
  r.delete("/api/recordings/:id", async (c) => {
    const me = requireUser(c);
    const id = idParam(c);
    const rec = await c.db.get<{ user_id: number | null }>("SELECT user_id FROM recordings WHERE id = ?", id);
    if (!rec || (!isAdmin(me) && rec.user_id !== me.id)) throw new HttpError(404, "Recording not found.");
    await deleteRecording(c.db, id, me);
    if (!isAdmin(me)) {
      await notifyRole(c.db, "organizer", { title: `${me.name} deleted a recording`, body: "It's in the trash. Ideas from it are unchanged.", url: "#/review" }, { push: false });
    }
    return { ok: true };
  }, { contributor: true });

  r.post("/api/recordings/:id/restore", async (c) => {
    const me = requireUser(c);
    const id = idParam(c);
    await restoreRecording(c.db, id, me.id);
    const rec = await c.db.get<{ status: string; purged_at: string | null }>("SELECT status, purged_at FROM recordings WHERE id = ?", id);
    if (rec && !rec.purged_at && !["done", "failed", "uploading"].includes(rec.status)) await jobs.enqueue("process_recording", { recordingId: id });
    return { ok: true };
  });

  r.delete("/api/recordings/:id/purge", async (c) => {
    const me = requireUser(c);
    if ((await c.body<{ confirm?: string }>()).confirm !== "DELETE") throw new HttpError(400, "Type DELETE to confirm.");
    if (!(await purgeRecording(c.db, idParam(c), me.id))) throw new HttpError(400, "Only recordings in the trash can be removed permanently.");
    return { ok: true };
  });

  // ------------------------------------------------------------------- trash
  r.get("/api/trash", async (c) => ({
    recordings: await c.db.all(
      `SELECT r.id, r.captured_at, r.summary, r.deleted_at, r.purged_at, r.duration_sec, u.name AS user_name, d.name AS deleted_by_name,
         (SELECT COUNT(DISTINCT idea_id)::int FROM fragments f WHERE f.recording_id = r.id AND f.idea_id IS NOT NULL) AS ideas
       FROM recordings r LEFT JOIN users u ON u.id = r.user_id LEFT JOIN users d ON d.id = r.deleted_by
       WHERE r.deleted_at IS NOT NULL ORDER BY r.deleted_at DESC`,
    ),
    items: await c.db.all("SELECT t.id, t.entity, t.label, t.deleted_at, u.name AS deleted_by_name FROM trash t LEFT JOIN users u ON u.id = t.deleted_by ORDER BY t.id DESC"),
  }));

  r.post("/api/trash/:id/restore", async (c) => {
    const res = await restoreFromTrash(c.db, idParam(c), requireUser(c).id);
    if (!res.ok) throw new HttpError(404, res.reason ?? "Can't restore.");
    return { ok: true };
  });

  r.delete("/api/trash/:id", async (c) => {
    if ((await c.body<{ confirm?: string }>()).confirm !== "DELETE") throw new HttpError(400, "Type DELETE to confirm.");
    await purgeTrashItem(c.db, idParam(c), requireUser(c).id);
    return { ok: true };
  });

  // ------------------------------------------------- the contributor's own ideas
  r.get("/api/my/ideas", (c) =>
    c.db.all(
      `SELECT i.id, i.title, i.summary, i.status, i.last_activity_at, i.created_at, COUNT(f.id)::int AS mentions, MAX(r.captured_at) AS last_mentioned
       FROM ideas i JOIN fragments f ON f.idea_id = i.id JOIN recordings r ON r.id = f.recording_id
       WHERE r.user_id = ? AND r.deleted_at IS NULL GROUP BY i.id ORDER BY last_mentioned DESC LIMIT 300`,
      requireUser(c).id,
    ), { contributor: true });

  r.get("/api/my/ideas/:id", async (c) => {
    const me = requireUser(c);
    const id = idParam(c);
    const fragments = await c.db.all(
      `SELECT f.id, f.quote, f.start_sec, f.recording_id, r.captured_at, r.audio_path IS NOT NULL AS has_audio
       FROM fragments f JOIN recordings r ON r.id = f.recording_id
       WHERE f.idea_id = ? AND r.user_id = ? AND r.deleted_at IS NULL ORDER BY r.captured_at DESC`,
      id,
      me.id,
    );
    if (!fragments.length) throw new HttpError(404, "Idea not found.");
    const idea = await c.db.get("SELECT i.id, i.title, i.summary, i.status, i.created_at, p.name AS project_name FROM ideas i LEFT JOIN projects p ON p.id = i.project_id WHERE i.id = ?", id);
    const questions = await c.db.all("SELECT id, text, status, answer_text FROM questions WHERE idea_id = ? AND status IN ('asked','answered') ORDER BY id", id);
    return { ...(idea as object), fragments, questions };
  }, { contributor: true });

  r.get("/api/questions/open", (c) =>
    c.db.all(
      `SELECT q.id, q.text, q.asked_at, q.idea_id, i.title AS idea_title, u.name AS asked_by_name
       FROM questions q JOIN ideas i ON i.id = q.idea_id LEFT JOIN users u ON u.id = q.asked_by
       WHERE q.status = 'asked' ORDER BY q.asked_at`,
    ), { contributor: true });

  // ---------------------------------------------------------------- service keys
  r.get("/api/keys", async (c) => keySummary(c.db));

  r.put("/api/keys/:name", async (c) => {
    const name = c.params.name as KeyName;
    if (!["anthropic", "groq", "resend"].includes(name)) throw new HttpError(404, "Unknown key.");
    const value = str((await c.body<{ value?: string }>()).value, 400)?.trim() || null;
    if (value) {
      const problem = await checkKey(name, value);
      if (problem) throw new HttpError(400, problem);
    }
    await saveKey(c.db, name, value);
    syncAI(app.ai, c.db);
    await logActivity(c.db, requireUser(c).id, value ? `key_set:${name}` : `key_removed:${name}`);
    // Anything that was waiting for this key can run now.
    if (value) await c.db.run("UPDATE jobs SET run_at = now_text() WHERE status = 'pending' AND run_at > now_text() AND last_error IS NOT NULL");
    return keySummary(c.db);
  });

  // ---------------------------------------------------------------- settings
  r.get("/api/settings", async (c) => ({
    north_star: await getSetting(c.db, "north_star", ""),
    output_language: await getSetting(c.db, "output_language", "English"),
    timezone: await getSetting(c.db, "timezone", config.timezone),
    digest_hour: await getSetting(c.db, "digest_hour", 7),
    weights: await getSetting(c.db, "weights", defaultWeights),
    ai_budget_usd: await getSetting(c.db, "ai_budget_usd", 18),
  }));

  r.put("/api/settings", async (c) => {
    const me = requireUser(c);
    const b = await c.body();
    if (typeof b.north_star === "string") await setSetting(c.db, "north_star", str(b.north_star, 8000));
    if (typeof b.output_language === "string" && b.output_language.trim()) await setSetting(c.db, "output_language", str(b.output_language, 40));
    if (typeof b.timezone === "string") {
      if (!isValidTz(b.timezone)) throw new HttpError(400, "Unknown time zone.");
      await setSetting(c.db, "timezone", b.timezone);
    }
    if (typeof b.digest_hour === "number" && b.digest_hour >= 0 && b.digest_hour <= 23) await setSetting(c.db, "digest_hour", Math.round(b.digest_hour));
    if (typeof b.ai_budget_usd === "number" && b.ai_budget_usd >= 0 && b.ai_budget_usd <= 500) await setSetting(c.db, "ai_budget_usd", Math.round(b.ai_budget_usd * 100) / 100);
    if (b.weights && typeof b.weights === "object") {
      const w: Record<string, number> = {};
      for (const k of Object.keys(defaultWeights)) {
        const v = Number((b.weights as Record<string, unknown>)[k]);
        w[k] = Number.isFinite(v) ? Math.max(0, Math.min(3, v)) : 1;
      }
      await setSetting(c.db, "weights", w);
    }
    await logActivity(c.db, me.id, "settings");
    return { ok: true };
  });

  r.get("/api/memory", (c) =>
    c.db.all(
      `SELECT m.*, u.name AS user_name, i.title AS idea_title FROM memory m
       LEFT JOIN users u ON u.id = m.user_id LEFT JOIN ideas i ON i.id = m.source_idea_id ORDER BY m.kind, m.id DESC`,
    ));

  r.post("/api/memory", async (c) => {
    const me = requireUser(c);
    const b = await c.body();
    const kind = ["glossary", "preference", "correction"].includes(String(b.kind)) ? String(b.kind) : "preference";
    const body = str(b.body, 1000);
    if (!body) throw new HttpError(400, "Write what the AI should learn.");
    if (kind === "glossary" && !str(b.term, 80)) throw new HttpError(400, "A glossary entry needs the word or phrase.");
    const id = await c.db.insert(
      "INSERT INTO memory (kind, term, body, source_idea_id, user_id) VALUES (?, ?, ?, ?, ?)",
      kind,
      str(b.term, 80) || null,
      body,
      Number(b.idea_id) || null,
      me.id,
    );
    return { id };
  });

  r.patch("/api/memory/:id", async (c) => {
    const b = await c.body();
    const id = idParam(c);
    if (typeof b.body === "string") await c.db.run("UPDATE memory SET body = ? WHERE id = ?", str(b.body, 1000), id);
    if (typeof b.term === "string") await c.db.run("UPDATE memory SET term = ? WHERE id = ?", str(b.term, 80) || null, id);
    if (typeof b.active === "boolean") await c.db.run("UPDATE memory SET active = ? WHERE id = ?", b.active ? 1 : 0, id);
    return { ok: true };
  });

  r.delete("/api/memory/:id", async (c) => {
    await c.db.run("DELETE FROM memory WHERE id = ?", idParam(c));
    return { ok: true };
  });

  // -------------------------------------------------------------- system/ops
  r.get("/api/system", async (c) => {
    const usage = await c.db.all(
      `SELECT substr(created_at, 1, 7) AS month, provider, purpose, ROUND(SUM(cost_usd)::numeric, 4)::float AS cost,
         SUM(input_tokens)::int AS input_tokens, SUM(output_tokens)::int AS output_tokens,
         ROUND((SUM(audio_seconds) / 60.0)::numeric, 1)::float AS audio_minutes, COUNT(*)::int AS calls
       FROM ai_usage GROUP BY month, provider, purpose ORDER BY month DESC, cost DESC`,
    );
    const failed = await c.db.all("SELECT id, type, payload, last_error, updated_at FROM jobs WHERE status = 'failed' ORDER BY id DESC LIMIT 20");
    const waiting = await c.db.all(
      "SELECT type, last_error, run_at FROM jobs WHERE status = 'pending' AND last_error IS NOT NULL ORDER BY run_at LIMIT 5",
    );
    const counts = await c.db.get(
      `SELECT (SELECT COUNT(*)::int FROM recordings) AS recordings, (SELECT COUNT(*)::int FROM ideas) AS ideas,
         (SELECT COUNT(*)::int FROM tasks) AS tasks`,
    );
    return {
      ai: aiStatus(),
      email: emailConfigured(),
      budget: await budgetStatus(c.db),
      storage: await app.periodic.storageUsage(),
      lastWorker: await getSetting(c.db, "worker_last_run", null),
      pendingJobs: await jobs.pending(),
      failed,
      waiting,
      usage,
      counts,
      appUrl: config.appUrl,
    };
  });

  r.post("/api/jobs/:id/retry", async (c) => {
    const job = await c.db.get<{ type: string; payload: string }>("SELECT type, payload FROM jobs WHERE id = ? AND status = 'failed'", idParam(c));
    if (!job) throw new HttpError(404, "Nothing to retry.");
    await c.db.run("UPDATE jobs SET status = 'done', last_error = last_error || ' (retried)' WHERE id = ?", idParam(c));
    await jobs.enqueue(job.type, JSON.parse(job.payload));
    return { ok: true };
  });

  // Everything as readable files: every idea as a document, every transcript,
  // generated documents and a full data file. Audio is downloaded separately
  // (per recording) because it is too large to bundle here.
  r.get("/api/export", async (c) => {
    const me = requireUser(c);
    await logActivity(c.db, me.id, "export");
    const files: Record<string, Uint8Array> = {};
    const tables = ["users", "ideas", "tags", "fragments", "idea_versions", "links", "questions", "projects", "tasks", "notes", "attachments", "memory", "deliverables", "digests", "themes", "settings"];
    const data: Record<string, unknown[]> = {};
    for (const t of tables) {
      const rows = await c.db.all<Record<string, unknown>>(`SELECT * FROM ${t}`);
      data[t] = t === "users" ? rows.map(({ password_hash: _p, ...u }) => u) : t === "settings" ? rows.filter((s) => !/^(vapid|worker_secret|worker_url|api_keys|login_fail|qterms)/.test(String(s.key))) : rows;
    }
    data.recordings = await c.db.all("SELECT id, user_id, kind, captured_at, duration_sec, transcript, summary, language, status, deleted_at FROM recordings");
    files["data/idea-bridge.json"] = strToU8(JSON.stringify(data, null, 1));
    for (const i of await c.db.all<{ id: number; title: string }>("SELECT id, title FROM ideas ORDER BY id")) {
      files[`ideas/${i.id}-${slug(i.title)}.md`] = strToU8(await ideaMarkdown(c.db, i.id));
    }
    for (const rec of data.recordings as { id: number; captured_at: string; transcript: string | null }[]) {
      files[`transcripts/${rec.id}.txt`] = strToU8(`Recorded ${rec.captured_at}\n\n${rec.transcript ?? "(no transcript)"}\n`);
    }
    for (const d of await c.db.all<{ id: number; title: string; markdown: string }>("SELECT id, title, markdown FROM deliverables")) {
      files[`documents/${d.id}-${slug(d.title)}.md`] = strToU8(d.markdown);
    }
    const zip = zipSync(files, { level: 6 });
    return new Response(zip, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="idea-bridge-export-${new Date().toISOString().slice(0, 10)}.zip"`,
      },
    });
  });
}
