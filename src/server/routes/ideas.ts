import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { DELIVERABLES } from "../assistant.js";
import { CRITERIA, REPORT_SECTIONS, type Report, type Score } from "../ai/schemas.js";
import { HttpError, idParam, requireUser, type Ctx } from "../app.js";
import { config } from "../config.js";
import type { DB } from "../db.js";
import { getSetting, logActivity } from "../db.js";
import {
  addLink,
  editIdea,
  getIdea,
  mergeInto,
  PRIORITIES,
  resolveReview,
  restoreVersion,
  setStatus,
  STATUSES,
  type IdeaRow,
  type Status,
  type StoredCard,
} from "../ideas.js";
import { notifyRole } from "../notify.js";
import { scheduleReportAndScore } from "../pipeline.js";
import { indexIdea, safeJson, search } from "../search.js";
import { defaultWeights, sendFileWithRange, slug } from "./core.js";

const str = (v: unknown, max = 5000) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function weightedScore(db: DB, scoreJson: string | null): number | null {
  const s = safeJson<Score | null>(scoreJson, null);
  if (!s) return null;
  const w = getSetting<Record<string, number>>(db, "weights", defaultWeights);
  let total = 0;
  let wsum = 0;
  for (const [k] of CRITERIA) {
    const weight = w[k] ?? 1;
    total += (s[k]?.score ?? 3) * weight;
    wsum += weight;
  }
  return wsum ? Math.round(((total / wsum - 1) / 4) * 100) : null;
}

// Jobs currently queued or running for an idea, so the UI can show progress.
export function ideaJobs(db: DB, ideaId: number): string[] {
  return (
    db
      .prepare("SELECT DISTINCT type FROM jobs WHERE status IN ('pending','running') AND json_extract(payload, '$.ideaId') = ?")
      .all(ideaId) as { type: string }[]
  ).map((j) => j.type);
}

function listItem(db: DB, i: IdeaRow) {
  return {
    id: i.id,
    title: i.title,
    summary: i.summary,
    status: i.status,
    priority: i.priority,
    commitment: i.commitment,
    clarity: i.clarity,
    project_id: i.project_id,
    theme_id: i.theme_id,
    deadline: i.deadline,
    created_at: i.created_at,
    updated_at: i.updated_at,
    last_activity_at: i.last_activity_at,
    version: i.version,
    score: weightedScore(db, i.score),
    has_report: !!i.report,
    tags: (db.prepare("SELECT tag FROM tags WHERE idea_id = ? ORDER BY tag").all(i.id) as { tag: string }[]).map((t) => t.tag),
    mentions: (db.prepare("SELECT COUNT(*) AS n FROM fragments WHERE idea_id = ?").get(i.id) as { n: number }).n,
  };
}

export async function ideaRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, jobs, ai } = ctx;

  const mustIdea = (id: number) => {
    const idea = getIdea(db, id);
    if (!idea) throw new HttpError(404, "Idea not found.");
    return idea;
  };

  app.get("/api/ideas", async (req) => {
    requireUser(req);
    const q = req.query as Record<string, string | undefined>;
    const where: string[] = [];
    const vals: unknown[] = [];
    if (q.status === "active") where.push("i.status NOT IN ('archived','completed')");
    else if (q.status === "open") where.push("i.status IN ('new','needs_clarification','under_review')");
    else if (q.status && STATUSES.includes(q.status as Status)) (where.push("i.status = ?"), vals.push(q.status));
    if (q.priority) (where.push("i.priority = ?"), vals.push(q.priority));
    if (q.commitment) (where.push("i.commitment = ?"), vals.push(q.commitment));
    if (q.theme) (where.push("i.theme_id = ?"), vals.push(Number(q.theme)));
    if (q.project) (where.push("i.project_id = ?"), vals.push(Number(q.project)));
    if (q.tag) (where.push("EXISTS (SELECT 1 FROM tags t WHERE t.idea_id = i.id AND t.tag = ?)"), vals.push(q.tag));
    if (q.since) (where.push("i.created_at >= ?"), vals.push(q.since));
    const sql = `SELECT i.* FROM ideas i ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
    let rows = db.prepare(sql).all(...vals) as IdeaRow[];

    let hits: Map<number, { matchedBy: string[]; snippet?: string; rank: number }> | null = null;
    if (q.q?.trim()) {
      const res = await search(db, ai, q.q.trim(), 200);
      hits = new Map(res.ideas.map((h, rank) => [h.ideaId, { matchedBy: h.matchedBy, snippet: h.snippet, rank }]));
      rows = rows.filter((r) => hits!.has(r.id)).sort((a, b) => hits!.get(a.id)!.rank - hits!.get(b.id)!.rank);
    } else {
      const sort = q.sort ?? "recent";
      const pr = (p: string) => PRIORITIES.indexOf(p as (typeof PRIORITIES)[number]);
      if (sort === "created") rows.sort((a, b) => b.id - a.id);
      else if (sort === "priority") rows.sort((a, b) => pr(b.priority) - pr(a.priority) || b.last_activity_at.localeCompare(a.last_activity_at));
      else if (sort === "score") rows.sort((a, b) => (weightedScore(db, b.score) ?? -1) - (weightedScore(db, a.score) ?? -1));
      else if (sort === "title") rows.sort((a, b) => a.title.localeCompare(b.title));
      else rows.sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at) || b.id - a.id);
    }
    const limit = Math.min(Number(q.limit) || 300, 1000);
    return rows.slice(0, limit).map((r) => ({ ...listItem(db, r), match: hits?.get(r.id) ?? null }));
  });

  app.get("/api/tags", async (req) => {
    requireUser(req);
    return db.prepare("SELECT tag, COUNT(*) AS n FROM tags GROUP BY tag ORDER BY n DESC, tag LIMIT 200").all();
  });

  app.get("/api/themes", async (req) => {
    requireUser(req);
    return db
      .prepare(
        `SELECT t.id, t.name, t.description, COUNT(i.id) AS n FROM themes t LEFT JOIN ideas i ON i.theme_id = t.id AND i.status != 'archived'
         GROUP BY t.id ORDER BY n DESC`,
      )
      .all();
  });

  app.get("/api/ideas/:id", async (req) => {
    requireUser(req);
    const id = idParam(req);
    const idea = mustIdea(id);
    const fragments = db
      .prepare(
        `SELECT f.id, f.recording_id, f.title, f.quote, f.start_sec, f.end_sec, f.summary, f.interpretation, f.kind, f.commitment,
           f.clarity, f.link_decision, f.answers_question, r.captured_at, r.kind AS recording_kind, r.audio_path IS NOT NULL AS has_audio,
           u.name AS speaker
         FROM fragments f JOIN recordings r ON r.id = f.recording_id LEFT JOIN users u ON u.id = r.user_id
         WHERE f.idea_id = ? ORDER BY r.captured_at DESC, f.position`,
      )
      .all(id) as Record<string, unknown>[];
    const links = db
      .prepare(
        `SELECT l.id, l.type, l.status, l.confidence, l.reason, l.created_by, i.id AS other_id, i.title AS other_title, i.status AS other_status
         FROM links l JOIN ideas i ON i.id = CASE WHEN l.idea_a = ? THEN l.idea_b ELSE l.idea_a END
         WHERE (l.idea_a = ? OR l.idea_b = ?) AND l.status != 'dismissed' ORDER BY l.status = 'confirmed' DESC, l.confidence DESC`,
      )
      .all(id, id, id);
    const versions = db
      .prepare(
        `SELECT v.version, v.title, v.change_summary, v.source, v.source_id, v.created_at, u.name AS user_name
         FROM idea_versions v LEFT JOIN users u ON u.id = v.user_id WHERE v.idea_id = ? ORDER BY v.version DESC`,
      )
      .all(id);
    const questions = db
      .prepare(
        `SELECT q.*, u.name AS asked_by_name FROM questions q LEFT JOIN users u ON u.id = q.asked_by
         WHERE q.idea_id = ? AND q.status != 'dismissed' ORDER BY q.status = 'draft', q.id`,
      )
      .all(id);
    const tasks = db.prepare("SELECT * FROM tasks WHERE idea_id = ? ORDER BY status = 'done', position, id").all(id);
    const notes = db
      .prepare("SELECT n.id, n.body, n.created_at, u.name AS user_name, n.user_id FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.idea_id = ? ORDER BY n.id")
      .all(id);
    const attachments = db
      .prepare("SELECT a.id, a.kind, a.name, a.url, a.mime, a.size_bytes, a.created_at, u.name AS user_name FROM attachments a LEFT JOIN users u ON u.id = a.user_id WHERE a.idea_id = ? ORDER BY a.id")
      .all(id);
    const deliverables = db
      .prepare("SELECT id, kind, title, created_at FROM deliverables WHERE idea_id = ? ORDER BY id DESC")
      .all(id);
    const review = db.prepare("SELECT id, kind, note FROM review_items WHERE idea_id = ? AND status = 'open'").all(id);
    const project = idea.project_id ? db.prepare("SELECT id, name, status FROM projects WHERE id = ?").get(idea.project_id) : null;
    const theme = idea.theme_id ? db.prepare("SELECT id, name FROM themes WHERE id = ?").get(idea.theme_id) : null;
    const activity = db
      .prepare("SELECT a.action, a.detail, a.created_at, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity = 'idea' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 30")
      .all(id);
    return {
      ...listItem(db, idea),
      card: safeJson<StoredCard>(idea.card, {}),
      report: safeJson<Report | null>(idea.report, null),
      report_current: idea.report_version === idea.version,
      score_detail: safeJson<Score | null>(idea.score, null),
      score_current: idea.score_version === idea.version,
      busy: ideaJobs(db, id),
      fragments: fragments.map((f) => ({ ...f, link_decision: safeJson(f.link_decision as string, null) })),
      links,
      versions,
      questions,
      tasks,
      notes,
      attachments,
      deliverables,
      review,
      project,
      theme,
      activity,
    };
  });

  app.get("/api/ideas/:id/versions/:v", async (req) => {
    requireUser(req);
    const v = db
      .prepare("SELECT * FROM idea_versions WHERE idea_id = ? AND version = ?")
      .get(idParam(req), Number((req.params as { v: string }).v)) as Record<string, unknown> | undefined;
    if (!v) throw new HttpError(404, "Version not found.");
    return { ...v, card: safeJson(v.card as string, {}) };
  });

  app.post("/api/ideas/:id/versions/:v/restore", async (req) => {
    const me = requireUser(req);
    if (!restoreVersion(db, idParam(req), Number((req.params as { v: string }).v), me.id)) throw new HttpError(404, "Version not found.");
    jobs.enqueue("embed_idea", { ideaId: idParam(req) });
    return { ok: true };
  });

  app.patch("/api/ideas/:id", async (req) => {
    const me = requireUser(req);
    const id = idParam(req);
    const idea = mustIdea(id);
    const b = req.body as Record<string, unknown>;
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status as Status)) throw new HttpError(400, "Unknown status.");
      setStatus(db, id, b.status as Status, me.id);
      // Moving an idea into review prepares the full report and evaluation.
      if (b.status === "under_review") scheduleReportAndScore(db, jobs, id);
    }
    if (b.priority !== undefined) {
      if (!PRIORITIES.includes(b.priority as (typeof PRIORITIES)[number])) throw new HttpError(400, "Unknown priority.");
      db.prepare("UPDATE ideas SET priority = ? WHERE id = ?").run(b.priority, id);
      logActivity(db, me.id, "priority", "idea", id, String(b.priority));
    }
    if (b.deadline !== undefined) db.prepare("UPDATE ideas SET deadline = ? WHERE id = ?").run(str(b.deadline, 10) || null, id);
    if (b.project_id !== undefined) db.prepare("UPDATE ideas SET project_id = ? WHERE id = ?").run(Number(b.project_id) || null, id);
    if (b.commitment !== undefined && ["brainstorm", "intention", "decision"].includes(String(b.commitment))) {
      db.prepare("UPDATE ideas SET commitment = ? WHERE id = ?").run(b.commitment, id);
    }
    const editable = ["title", "summary", "vision", "problem", "how_it_works", "audience", "business_model", "challenges", "next_steps", "tags"];
    const changes: Record<string, unknown> = {};
    for (const k of editable) {
      if (b[k] === undefined) continue;
      if (Array.isArray(b[k])) changes[k] = (b[k] as unknown[]).map((x) => str(x, 500)).filter(Boolean);
      else changes[k] = str(b[k], 4000) || null;
    }
    if (Object.keys(changes).length) {
      editIdea(db, id, changes, me.id);
      jobs.enqueue("embed_idea", { ideaId: id });
    }
    // "Teach the AI": the correction becomes a lasting lesson.
    if (typeof b.lesson === "string" && b.lesson.trim()) {
      db.prepare("INSERT INTO memory (kind, body, source_idea_id, user_id) VALUES ('correction', ?, ?, ?)").run(str(b.lesson, 1000), id, me.id);
    }
    db.prepare("UPDATE ideas SET updated_at = datetime('now') WHERE id = ?").run(idea.id);
    return { ok: true };
  });

  app.post("/api/ideas/:id/report", async (req) => {
    requireUser(req);
    const id = idParam(req);
    mustIdea(id);
    jobs.enqueue("report", { ideaId: id });
    return { ok: true };
  });

  app.post("/api/ideas/:id/score", async (req) => {
    requireUser(req);
    const id = idParam(req);
    mustIdea(id);
    jobs.enqueue("score", { ideaId: id });
    return { ok: true };
  });

  app.post("/api/ideas/:id/refresh", async (req) => {
    requireUser(req);
    const id = idParam(req);
    mustIdea(id);
    jobs.enqueue("refresh_card", { ideaId: id, reason: "Refreshed on request." });
    return { ok: true };
  });

  // Approval is the line between a thought and a commitment.
  app.post("/api/ideas/:id/approve", async (req) => {
    const me = requireUser(req);
    const id = idParam(req);
    const idea = mustIdea(id);
    const b = (req.body ?? {}) as { project_id?: number; project_name?: string; plan?: boolean };
    let projectId = Number(b.project_id) || idea.project_id;
    if (!projectId) {
      projectId = Number(
        db
          .prepare("INSERT INTO projects (name, description, priority) VALUES (?, ?, ?)")
          .run(str(b.project_name, 120) || idea.title, idea.summary, idea.priority === "none" ? "medium" : idea.priority).lastInsertRowid,
      );
    }
    db.prepare("UPDATE ideas SET project_id = ?, commitment = 'decision' WHERE id = ?").run(projectId, id);
    setStatus(db, id, "approved", me.id);
    if (b.plan !== false) {
      db.prepare("UPDATE projects SET plan_status = 'generating' WHERE id = ?").run(projectId);
      jobs.enqueue("plan", { projectId });
    }
    logActivity(db, me.id, "approve", "idea", id, `project ${projectId}`);
    return { ok: true, projectId };
  });

  app.post("/api/ideas/:id/merge", async (req) => {
    const me = requireUser(req);
    const keep = idParam(req);
    const other = Number((req.body as { other_id?: number }).other_id);
    mustIdea(keep);
    mustIdea(other);
    if (keep === other) throw new HttpError(400, "Pick a different idea.");
    mergeInto(db, keep, other, me.id);
    jobs.enqueue("refresh_card", { ideaId: keep, reason: `Merged with idea #${other}.` });
    return { ok: true };
  });

  app.post("/api/fragments/:id/move", async (req) => {
    const me = requireUser(req);
    const fragmentId = idParam(req);
    const target = (req.body as { idea_id?: number | null }).idea_id;
    if (target) mustIdea(Number(target));
    jobs.enqueue("move_fragment", { fragmentId, ideaId: target ? Number(target) : null, userId: me.id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- questions
  app.post("/api/ideas/:id/questions", async (req) => {
    requireUser(req);
    const id = idParam(req);
    mustIdea(id);
    const text = str((req.body as { text?: string }).text, 500);
    if (!text) throw new HttpError(400, "Write the question first.");
    const qid = db.prepare("INSERT INTO questions (idea_id, text) VALUES (?, ?)").run(id, text).lastInsertRowid;
    return { id: Number(qid) };
  });

  app.post("/api/questions/:id/ask", async (req) => {
    const me = requireUser(req);
    const qid = idParam(req);
    const q = db.prepare("SELECT idea_id, text FROM questions WHERE id = ?").get(qid) as { idea_id: number; text: string } | undefined;
    if (!q) throw new HttpError(404, "Question not found.");
    const b = (req.body ?? {}) as { text?: string };
    const text = str(b.text, 500) || q.text;
    db.prepare("UPDATE questions SET text = ?, status = 'asked', asked_by = ?, asked_at = datetime('now') WHERE id = ?").run(text, me.id, qid);
    const idea = getIdea(db, q.idea_id)!;
    if (["new", "under_review"].includes(idea.status)) setStatus(db, q.idea_id, "needs_clarification", me.id);
    notifyRole(db, "visionary", { title: `${me.name} has a question`, body: text, url: "#/capture" });
    return { ok: true };
  });

  app.post("/api/questions/:id/dismiss", async (req) => {
    requireUser(req);
    db.prepare("UPDATE questions SET status = 'dismissed' WHERE id = ?").run(idParam(req));
    return { ok: true };
  });

  // Record an answer given in person (typed by whoever heard it).
  app.post("/api/questions/:id/answer", async (req) => {
    const me = requireUser(req);
    const qid = idParam(req);
    const q = db.prepare("SELECT idea_id, text FROM questions WHERE id = ?").get(qid) as { idea_id: number; text: string } | undefined;
    if (!q) throw new HttpError(404, "Question not found.");
    const text = str((req.body as { text?: string }).text, 4000);
    if (!text) throw new HttpError(400, "Write the answer first.");
    db.prepare("UPDATE questions SET status = 'answered', answer_text = ?, answered_at = datetime('now') WHERE id = ?").run(text, qid);
    if (getIdea(db, q.idea_id)?.status === "needs_clarification") setStatus(db, q.idea_id, "under_review", me.id);
    jobs.enqueue("refresh_card", { ideaId: q.idea_id, reason: "A clarification question was answered." });
    return { ok: true };
  });

  // -------------------------------------------------------- notes/attachments
  app.post("/api/ideas/:id/notes", async (req) => {
    const me = requireUser(req);
    const id = idParam(req);
    mustIdea(id);
    const body = str((req.body as { body?: string }).body, 8000);
    if (!body) throw new HttpError(400, "The note is empty.");
    db.prepare("INSERT INTO notes (idea_id, user_id, body) VALUES (?, ?, ?)").run(id, me.id, body);
    db.prepare("UPDATE ideas SET last_activity_at = datetime('now') WHERE id = ?").run(id);
    return { ok: true };
  });

  app.delete("/api/notes/:id", async (req) => {
    const me = requireUser(req);
    db.prepare("DELETE FROM notes WHERE id = ? AND user_id = ?").run(idParam(req), me.id);
    return { ok: true };
  });

  app.post("/api/ideas/:id/attachments", async (req) => {
    const me = requireUser(req);
    const id = idParam(req);
    mustIdea(id);
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw new HttpError(400, "No file received.");
      fs.mkdirSync(config.filesDir, { recursive: true });
      const safe = path.basename(file.filename || "file").replace(/[^\w.\- ]+/g, "_").slice(-80);
      const dest = path.join(config.filesDir, `${crypto.randomBytes(6).toString("hex")}-${safe}`);
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        file.file.pipe(out);
        out.on("finish", resolve);
        out.on("error", reject);
      });
      if (file.file.truncated) {
        fs.unlinkSync(dest);
        throw new HttpError(413, `File is larger than ${config.maxUploadMb} MB.`);
      }
      db.prepare("INSERT INTO attachments (idea_id, kind, name, path, mime, size_bytes, user_id) VALUES (?, 'file', ?, ?, ?, ?, ?)").run(
        id,
        safe,
        dest,
        file.mimetype,
        fs.statSync(dest).size,
        me.id,
      );
    } else {
      const b = req.body as { url?: string; name?: string };
      const url = str(b.url, 2000);
      if (!/^https?:\/\//i.test(url)) throw new HttpError(400, "Links must start with http:// or https://");
      db.prepare("INSERT INTO attachments (idea_id, kind, name, url, user_id) VALUES (?, 'link', ?, ?, ?)").run(id, str(b.name, 200) || url, url, me.id);
    }
    return { ok: true };
  });

  app.get("/api/attachments/:id/file", async (req, reply) => {
    requireUser(req);
    const a = db.prepare("SELECT name, path, mime FROM attachments WHERE id = ?").get(idParam(req)) as
      | { name: string; path: string | null; mime: string | null }
      | undefined;
    if (!a?.path || !fs.existsSync(a.path)) throw new HttpError(404, "File not found.");
    const mime = a.mime ?? "application/octet-stream";
    // Only images, audio, video and PDFs open inline; everything else downloads.
    const inline = /^(image\/(png|jpeg|gif|webp)|audio\/|video\/|application\/pdf)/.test(mime);
    reply.header("Content-Disposition", `${inline ? "inline" : "attachment"}; filename="${a.name.replace(/"/g, "")}"`);
    reply.header("Content-Security-Policy", "sandbox");
    return sendFileWithRange(req, reply, a.path, inline ? mime : "application/octet-stream");
  });

  app.delete("/api/attachments/:id", async (req) => {
    const me = requireUser(req);
    const a = db.prepare("SELECT path, idea_id FROM attachments WHERE id = ?").get(idParam(req)) as { path: string | null; idea_id: number } | undefined;
    if (!a) throw new HttpError(404, "Attachment not found.");
    db.prepare("DELETE FROM attachments WHERE id = ?").run(idParam(req));
    if (a.path && fs.existsSync(a.path)) fs.unlinkSync(a.path);
    logActivity(db, me.id, "delete_attachment", "idea", a.idea_id);
    return { ok: true };
  });

  // -------------------------------------------------------------------- links
  app.post("/api/links", async (req) => {
    const me = requireUser(req);
    const b = req.body as { a?: number; b?: number; type?: string; reason?: string };
    const type = ["related", "builds_on", "conflicts", "combines", "duplicate"].includes(String(b.type)) ? String(b.type) : "related";
    mustIdea(Number(b.a));
    mustIdea(Number(b.b));
    const id = addLink(db, Number(b.a), Number(b.b), type, { status: "confirmed", by: "user", reason: str(b.reason, 500) || undefined });
    logActivity(db, me.id, "link", "idea", Number(b.a), `#${b.b} ${type}`);
    return { id };
  });

  app.patch("/api/links/:id", async (req) => {
    requireUser(req);
    const status = (req.body as { status?: string }).status;
    if (!["confirmed", "dismissed", "suggested"].includes(String(status))) throw new HttpError(400, "Unknown status.");
    db.prepare("UPDATE links SET status = ? WHERE id = ?").run(status, idParam(req));
    db.prepare("UPDATE review_items SET status = 'done', resolution = ?, resolved_at = datetime('now') WHERE link_id = ? AND status = 'open'").run(
      status,
      idParam(req),
    );
    return { ok: true };
  });

  // -------------------------------------------------------------- deliverables
  app.get("/api/deliverable-kinds", async () =>
    Object.entries(DELIVERABLES).map(([kind, d]) => ({ kind, title: d.title })),
  );

  app.post("/api/ideas/:id/deliverables", async (req) => {
    const me = requireUser(req);
    const id = idParam(req);
    mustIdea(id);
    const b = req.body as { kind?: string; instructions?: string };
    const kind = String(b.kind ?? "");
    if (!DELIVERABLES[kind] && kind !== "custom") throw new HttpError(400, "Unknown document type.");
    if (kind === "custom" && !str(b.instructions)) throw new HttpError(400, "Describe the document you want.");
    jobs.enqueue("deliverable", { ideaId: id, kind, instructions: str(b.instructions, 2000), userId: me.id, nonce: Date.now() });
    return { ok: true };
  });

  app.get("/api/deliverables/:id", async (req) => {
    requireUser(req);
    const d = db.prepare("SELECT * FROM deliverables WHERE id = ?").get(idParam(req));
    if (!d) throw new HttpError(404, "Document not found.");
    return d;
  });

  app.get("/api/deliverables/:id/download", async (req, reply) => {
    requireUser(req);
    const d = db.prepare("SELECT title, markdown FROM deliverables WHERE id = ?").get(idParam(req)) as
      | { title: string; markdown: string }
      | undefined;
    if (!d) throw new HttpError(404, "Document not found.");
    reply.header("Content-Disposition", `attachment; filename="${slug(d.title)}.md"`);
    return reply.type("text/markdown; charset=utf-8").send(d.markdown);
  });

  app.delete("/api/deliverables/:id", async (req) => {
    requireUser(req);
    db.prepare("DELETE FROM deliverables WHERE id = ?").run(idParam(req));
    return { ok: true };
  });

  app.get("/api/ideas/:id/export.md", async (req, reply) => {
    requireUser(req);
    const id = idParam(req);
    const idea = mustIdea(id);
    reply.header("Content-Disposition", `attachment; filename="${id}-${slug(idea.title)}.md"`);
    return reply.type("text/markdown; charset=utf-8").send(ideaMarkdown(db, id));
  });

  // ------------------------------------------------------------------- review
  app.get("/api/review", async (req) => {
    requireUser(req);
    const items = db
      .prepare(
        `SELECT r.*, i.title AS idea_title, i.summary AS idea_summary, i.status AS idea_status, i.clarity AS idea_clarity,
           i.commitment AS idea_commitment, o.title AS other_title, o.summary AS other_summary, o.status AS other_status,
           f.quote AS fragment_quote, f.recording_id, f.start_sec, f.interpretation AS fragment_interpretation, l.type AS link_type, l.confidence
         FROM review_items r
         LEFT JOIN ideas i ON i.id = r.idea_id LEFT JOIN ideas o ON o.id = r.other_idea_id
         LEFT JOIN fragments f ON f.id = r.fragment_id LEFT JOIN links l ON l.id = r.link_id
         WHERE r.status = 'open' ORDER BY r.id`,
      )
      .all() as Record<string, unknown>[];
    return items.map((it) => ({
      ...it,
      tags: it.idea_id
        ? (db.prepare("SELECT tag FROM tags WHERE idea_id = ?").all(it.idea_id) as { tag: string }[]).map((t) => t.tag)
        : [],
      questions: it.idea_id
        ? db.prepare("SELECT id, text, why, status FROM questions WHERE idea_id = ? AND status IN ('draft','asked')").all(it.idea_id)
        : [],
    }));
  });

  app.post("/api/review/:id", async (req) => {
    const me = requireUser(req);
    const rid = idParam(req);
    const action = String((req.body as { action?: string }).action ?? "");
    const item = db.prepare("SELECT * FROM review_items WHERE id = ?").get(rid) as
      | { id: number; kind: string; idea_id: number | null; other_idea_id: number | null; fragment_id: number | null; link_id: number | null; status: string }
      | undefined;
    if (!item) throw new HttpError(404, "Item not found.");
    if (item.status !== "open") return { ok: true };
    const ideaId = item.idea_id;
    switch (action) {
      case "ok":
        break;
      case "review":
        if (ideaId) {
          setStatus(db, ideaId, "under_review", me.id);
          scheduleReportAndScore(db, jobs, ideaId);
        }
        break;
      case "archive":
        if (ideaId) setStatus(db, ideaId, "archived", me.id);
        break;
      case "hold":
        if (ideaId) setStatus(db, ideaId, "on_hold", me.id);
        break;
      case "undo":
        // The AI attached a thought to the wrong idea: make it its own idea.
        if (item.fragment_id) jobs.enqueue("move_fragment", { fragmentId: item.fragment_id, ideaId: null, userId: me.id });
        break;
      case "merge":
        // Merge the newly created idea into the existing one it duplicates.
        if (ideaId && item.other_idea_id) {
          mergeInto(db, item.other_idea_id, ideaId, me.id);
          jobs.enqueue("refresh_card", { ideaId: item.other_idea_id, reason: `Merged with idea #${ideaId}.` });
        }
        break;
      case "confirm":
        if (item.link_id) db.prepare("UPDATE links SET status = 'confirmed' WHERE id = ?").run(item.link_id);
        break;
      case "link":
        // Not the same idea, but related.
        if (ideaId && item.other_idea_id) {
          if (item.link_id) db.prepare("UPDATE links SET status = 'dismissed' WHERE id = ?").run(item.link_id);
          addLink(db, ideaId, item.other_idea_id, "related", { status: "confirmed", by: "user" });
        }
        break;
      case "dismiss":
        if (item.link_id) db.prepare("UPDATE links SET status = 'dismissed' WHERE id = ?").run(item.link_id);
        break;
      default:
        throw new HttpError(400, "Unknown action.");
    }
    resolveReview(db, rid, action, me.id);
    if (ideaId) indexIdea(db, ideaId);
    return { ok: true };
  });

  app.post("/api/review/bulk", async (req) => {
    const me = requireUser(req);
    const ids = ((req.body as { ids?: number[] }).ids ?? []).map(Number).filter(Boolean);
    for (const id of ids) resolveReview(db, id, "ok", me.id);
    return { ok: true, count: ids.length };
  });
}

// Readable Markdown for one idea: used for export and sharing.
export function ideaMarkdown(db: DB, id: number): string {
  const idea = getIdea(db, id);
  if (!idea) return "";
  const card = safeJson<StoredCard>(idea.card, {});
  const report = safeJson<Report | null>(idea.report, null);
  const score = safeJson<Score | null>(idea.score, null);
  const frags = db
    .prepare("SELECT f.quote, f.recording_id, f.start_sec, r.captured_at FROM fragments f JOIN recordings r ON r.id = f.recording_id WHERE f.idea_id = ? ORDER BY r.captured_at")
    .all(id) as { quote: string; recording_id: number; start_sec: number | null; captured_at: string }[];
  const tags = (db.prepare("SELECT tag FROM tags WHERE idea_id = ?").all(id) as { tag: string }[]).map((t) => t.tag);
  const out: string[] = [];
  out.push(`# ${idea.title}`, "");
  out.push(`Status: ${idea.status.replace(/_/g, " ")} · Priority: ${idea.priority} · Commitment: ${idea.commitment} · Captured: ${idea.created_at.slice(0, 10)}`);
  if (tags.length) out.push(`Tags: ${tags.join(", ")}`);
  out.push("", "## Summary", "", idea.summary, "");
  const field = (label: string, v: unknown) => {
    if (typeof v === "string" && v) out.push(`## ${label}`, "", v, "");
    if (Array.isArray(v) && v.length) out.push(`## ${label}`, "", ...v.map((x) => `- ${typeof x === "string" ? x : (x as { question: string }).question}`), "");
  };
  if (report) {
    out.push("## What he is trying to say", "", report.translation, "", `_${report.confidence_note}_`, "");
    for (const [key, label] of REPORT_SECTIONS) {
      const s = report[key];
      out.push(`## ${label}`, "");
      if (!s.points.length) out.push("_Not mentioned yet._", "");
      for (const p of s.points) out.push(`- **${p.label === "said" ? "He said" : p.label === "interpreted" ? "Interpretation" : "Suggestion"}:** ${p.text}`);
      out.push("");
    }
  } else {
    field("Underlying vision", card.vision);
    field("Problem being solved", card.problem);
    field("How it might work", card.how_it_works);
    field("Target audience", card.audience);
    field("Potential business model", card.business_model);
    field("Challenges", card.challenges);
    field("Next steps", card.next_steps);
    field("Open questions", card.open_questions);
  }
  if (score) {
    out.push("## Evaluation", "");
    for (const [k, label, scale] of CRITERIA) out.push(`- **${label}** ${score[k].score}/5 (${scale}): ${score[k].reason}`);
    out.push("", score.overall_take, "", `Biggest unknown: ${score.biggest_unknown}`, "", `Cheapest test: ${score.cheapest_test}`, "");
  }
  out.push("## Original words", "");
  for (const f of frags) out.push(`> ${f.quote.replace(/\n/g, " ")}`, `> — recording ${f.recording_id}, ${f.captured_at}${f.start_sec != null ? ` at ${Math.floor(f.start_sec / 60)}:${String(Math.floor(f.start_sec % 60)).padStart(2, "0")}` : ""}`, "");
  return out.join("\n");
}
