import { DELIVERABLES } from "../assistant.ts";
import { CRITERIA, REPORT_SECTIONS, type Report, type Score } from "../ai/schemas.ts";
import type { App } from "../app.ts";
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { getSetting, logActivity, safeJson } from "../db.ts";
import { HttpError, idParam, type Router, requireUser, str } from "../http.ts";
import {
  addLink,
  editIdea,
  getIdea,
  type IdeaRow,
  mergeInto,
  PRIORITIES,
  resolveReview,
  restoreVersion,
  setStatus,
  type Status,
  STATUSES,
  type StoredCard,
} from "../ideas.ts";
import { notifyRole } from "../notify.ts";
import { scheduleReportAndScore } from "../pipeline.ts";
import { indexIdea, search } from "../search.ts";
import { storage } from "../storage.ts";
import { moveToTrash, restoreRecording } from "../trash.ts";

const defaultWeights = { value: 1.5, feasibility: 1, cost: 1, complexity: 0.75, strategic_fit: 1.5, effort: 1 };

export function weightedScore(w: Record<string, number>, scoreJson: string | null): number | null {
  const s = safeJson<Score | null>(scoreJson, null);
  if (!s) return null;
  let total = 0;
  let wsum = 0;
  for (const [k] of CRITERIA) {
    const weight = w[k] ?? 1;
    total += (s[k]?.score ?? 3) * weight;
    wsum += weight;
  }
  return wsum ? Math.round(((total / wsum - 1) / 4) * 100) : null;
}

export const weights = (db: DB) => getSetting<Record<string, number>>(db, "weights", defaultWeights);

// Jobs queued or running for an idea, so the app can show progress.
export async function ideaJobs(db: DB, ideaId: number): Promise<string[]> {
  return (
    await db.all<{ type: string }>(
      "SELECT DISTINCT type FROM jobs WHERE status IN ('pending','running') AND (payload::jsonb->>'ideaId') = ?",
      String(ideaId),
    )
  ).map((j) => j.type);
}

async function listItem(db: DB, w: Record<string, number>, i: IdeaRow) {
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
    score: weightedScore(w, i.score),
    has_report: !!i.report,
    tags: (await db.all<{ tag: string }>("SELECT tag FROM tags WHERE idea_id = ? ORDER BY tag", i.id)).map((t) => t.tag),
    mentions: (await db.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM fragments WHERE idea_id = ?", i.id))?.n ?? 0,
  };
}

export function ideaRoutes(r: Router, app: App) {
  const { jobs, ai } = app;

  const mustIdea = async (db: DB, id: number) => {
    const idea = await getIdea(db, id);
    if (!idea) throw new HttpError(404, "Idea not found.");
    return idea;
  };

  r.get("/api/ideas", async (c) => {
    const q = c.query;
    const where: string[] = [];
    const vals: (string | number)[] = [];
    const status = q.get("status");
    if (status === "active") where.push("i.status NOT IN ('archived','completed')");
    else if (status === "open") where.push("i.status IN ('new','needs_clarification','under_review')");
    else if (status && STATUSES.includes(status as Status)) (where.push("i.status = ?"), vals.push(status));
    if (q.get("priority")) (where.push("i.priority = ?"), vals.push(q.get("priority")!));
    if (q.get("commitment")) (where.push("i.commitment = ?"), vals.push(q.get("commitment")!));
    if (q.get("theme")) (where.push("i.theme_id = ?"), vals.push(Number(q.get("theme"))));
    if (q.get("project")) (where.push("i.project_id = ?"), vals.push(Number(q.get("project"))));
    if (q.get("tag")) (where.push("EXISTS (SELECT 1 FROM tags t WHERE t.idea_id = i.id AND t.tag = ?)"), vals.push(q.get("tag")!));
    let rows = await c.db.all<IdeaRow>(`SELECT i.* FROM ideas i ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`, ...vals);
    const w = await weights(c.db);
    let hits: Map<number, { matchedBy: string[]; snippet?: string; rank: number }> | null = null;
    const text = q.get("q")?.trim();
    if (text) {
      const res = await search(c.db, ai, text, 200);
      hits = new Map(res.ideas.map((h, rank) => [h.ideaId, { matchedBy: h.matchedBy, snippet: h.snippet, rank }]));
      rows = rows.filter((x) => hits!.has(x.id)).sort((a, b) => hits!.get(a.id)!.rank - hits!.get(b.id)!.rank);
    } else {
      const sort = q.get("sort") ?? "recent";
      const pr = (p: string) => PRIORITIES.indexOf(p as (typeof PRIORITIES)[number]);
      if (sort === "created") rows.sort((a, b) => b.id - a.id);
      else if (sort === "priority") rows.sort((a, b) => pr(b.priority) - pr(a.priority) || b.last_activity_at.localeCompare(a.last_activity_at));
      else if (sort === "score") rows.sort((a, b) => (weightedScore(w, b.score) ?? -1) - (weightedScore(w, a.score) ?? -1));
      else if (sort === "title") rows.sort((a, b) => a.title.localeCompare(b.title));
      else rows.sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at) || b.id - a.id);
    }
    const limit = Math.min(Number(q.get("limit")) || 300, 1000);
    const out = [];
    for (const row of rows.slice(0, limit)) out.push({ ...(await listItem(c.db, w, row)), match: hits?.get(row.id) ?? null });
    return out;
  });

  r.get("/api/tags", (c) => c.db.all("SELECT tag, COUNT(*)::int AS n FROM tags GROUP BY tag ORDER BY n DESC, tag LIMIT 200"));

  r.get("/api/themes", (c) =>
    c.db.all(
      `SELECT t.id, t.name, t.description, COUNT(i.id)::int AS n FROM themes t LEFT JOIN ideas i ON i.theme_id = t.id AND i.status != 'archived'
       GROUP BY t.id ORDER BY n DESC`,
    ));

  r.get("/api/ideas/:id", async (c) => {
    const db = c.db;
    const id = idParam(c);
    const idea = await mustIdea(db, id);
    const fragments = await db.all<Record<string, unknown>>(
      `SELECT f.id, f.recording_id, f.title, f.quote, f.start_sec, f.end_sec, f.summary, f.interpretation, f.kind, f.commitment,
         f.clarity, f.link_decision, f.answers_question, r.captured_at, r.kind AS recording_kind, r.audio_path IS NOT NULL AS has_audio,
         r.deleted_at AS recording_deleted_at, u.name AS speaker
       FROM fragments f JOIN recordings r ON r.id = f.recording_id LEFT JOIN users u ON u.id = r.user_id
       WHERE f.idea_id = ? ORDER BY r.captured_at DESC, f.position`,
      id,
    );
    const w = await weights(db);
    return {
      ...(await listItem(db, w, idea)),
      card: safeJson<StoredCard>(idea.card, {}),
      report: safeJson<Report | null>(idea.report, null),
      report_current: idea.report_version === idea.version,
      score_detail: safeJson<Score | null>(idea.score, null),
      score_current: idea.score_version === idea.version,
      busy: await ideaJobs(db, id),
      fragments: fragments.map((f) => ({ ...f, link_decision: safeJson(f.link_decision as string, null) })),
      links: await db.all(
        `SELECT l.id, l.type, l.status, l.confidence, l.reason, l.created_by, i.id AS other_id, i.title AS other_title, i.status AS other_status
         FROM links l JOIN ideas i ON i.id = CASE WHEN l.idea_a = ? THEN l.idea_b ELSE l.idea_a END
         WHERE (l.idea_a = ? OR l.idea_b = ?) AND l.status != 'dismissed' ORDER BY l.status = 'confirmed' DESC, l.confidence DESC NULLS LAST`,
        id,
        id,
        id,
      ),
      versions: await db.all(
        `SELECT v.version, v.title, v.change_summary, v.source, v.source_id, v.created_at, u.name AS user_name
         FROM idea_versions v LEFT JOIN users u ON u.id = v.user_id WHERE v.idea_id = ? ORDER BY v.version DESC`,
        id,
      ),
      questions: await db.all(
        `SELECT q.*, u.name AS asked_by_name FROM questions q LEFT JOIN users u ON u.id = q.asked_by
         WHERE q.idea_id = ? AND q.status != 'dismissed' ORDER BY q.status = 'draft', q.id`,
        id,
      ),
      tasks: await db.all("SELECT * FROM tasks WHERE idea_id = ? ORDER BY status = 'done', position, id", id),
      notes: await db.all(
        "SELECT n.id, n.body, n.created_at, u.name AS user_name, n.user_id FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.idea_id = ? ORDER BY n.id",
        id,
      ),
      attachments: await db.all(
        "SELECT a.id, a.kind, a.name, a.url, a.mime, a.size_bytes, a.created_at, u.name AS user_name FROM attachments a LEFT JOIN users u ON u.id = a.user_id WHERE a.idea_id = ? ORDER BY a.id",
        id,
      ),
      deliverables: await db.all("SELECT id, kind, title, created_at FROM deliverables WHERE idea_id = ? ORDER BY id DESC", id),
      review: await db.all("SELECT id, kind, note FROM review_items WHERE idea_id = ? AND status = 'open'", id),
      project: idea.project_id ? await db.get("SELECT id, name, status FROM projects WHERE id = ?", idea.project_id) : null,
      theme: idea.theme_id ? await db.get("SELECT id, name FROM themes WHERE id = ?", idea.theme_id) : null,
      activity: await db.all(
        "SELECT a.action, a.detail, a.created_at, u.name AS user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id WHERE a.entity = 'idea' AND a.entity_id = ? ORDER BY a.id DESC LIMIT 30",
        id,
      ),
    };
  });

  r.get("/api/ideas/:id/versions/:v", async (c) => {
    const v = await c.db.get<Record<string, unknown>>("SELECT * FROM idea_versions WHERE idea_id = ? AND version = ?", idParam(c), Number(c.params.v));
    if (!v) throw new HttpError(404, "Version not found.");
    return { ...v, card: safeJson(v.card as string, {}) };
  });

  r.post("/api/ideas/:id/versions/:v/restore", async (c) => {
    if (!(await restoreVersion(c.db, idParam(c), Number(c.params.v), requireUser(c).id))) throw new HttpError(404, "Version not found.");
    return { ok: true };
  });

  r.patch("/api/ideas/:id", async (c) => {
    const me = requireUser(c);
    const db = c.db;
    const id = idParam(c);
    await mustIdea(db, id);
    const b = await c.body();
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status as Status)) throw new HttpError(400, "Unknown status.");
      await setStatus(db, id, b.status as Status, me.id);
      // Moving an idea into review prepares the full report and evaluation.
      if (b.status === "under_review") await scheduleReportAndScore(db, jobs, id);
    }
    if (b.priority !== undefined) {
      if (!PRIORITIES.includes(b.priority as (typeof PRIORITIES)[number])) throw new HttpError(400, "Unknown priority.");
      await db.run("UPDATE ideas SET priority = ? WHERE id = ?", b.priority as string, id);
      await logActivity(db, me.id, "priority", "idea", id, String(b.priority));
    }
    if (b.deadline !== undefined) await db.run("UPDATE ideas SET deadline = ? WHERE id = ?", str(b.deadline, 10) || null, id);
    if (b.project_id !== undefined) await db.run("UPDATE ideas SET project_id = ? WHERE id = ?", Number(b.project_id) || null, id);
    if (b.commitment !== undefined && ["brainstorm", "intention", "decision"].includes(String(b.commitment))) {
      await db.run("UPDATE ideas SET commitment = ? WHERE id = ?", String(b.commitment), id);
    }
    const editable = ["title", "summary", "vision", "problem", "how_it_works", "audience", "business_model", "challenges", "next_steps", "tags"];
    const changes: Record<string, unknown> = {};
    for (const k of editable) {
      if (b[k] === undefined) continue;
      if (Array.isArray(b[k])) changes[k] = (b[k] as unknown[]).map((x) => str(x, 500)).filter(Boolean);
      else changes[k] = str(b[k], 4000) || null;
    }
    if (Object.keys(changes).length) await editIdea(db, id, changes, me.id);
    // "Teach the AI": the correction becomes a lasting lesson.
    if (typeof b.lesson === "string" && b.lesson.trim()) {
      await db.run("INSERT INTO memory (kind, body, source_idea_id, user_id) VALUES ('correction', ?, ?, ?)", str(b.lesson, 1000), id, me.id);
    }
    await db.run("UPDATE ideas SET updated_at = now_text() WHERE id = ?", id);
    return { ok: true };
  });

  r.post("/api/ideas/:id/report", async (c) => {
    const id = idParam(c);
    await mustIdea(c.db, id);
    await jobs.enqueue("report", { ideaId: id });
    return { ok: true };
  });

  r.post("/api/ideas/:id/score", async (c) => {
    const id = idParam(c);
    await mustIdea(c.db, id);
    await jobs.enqueue("score", { ideaId: id });
    return { ok: true };
  });

  r.post("/api/ideas/:id/refresh", async (c) => {
    const id = idParam(c);
    await mustIdea(c.db, id);
    await jobs.enqueue("refresh_card", { ideaId: id, reason: "Refreshed on request." });
    return { ok: true };
  });

  // Approval is the line between a thought and a commitment.
  r.post("/api/ideas/:id/approve", async (c) => {
    const me = requireUser(c);
    const db = c.db;
    const id = idParam(c);
    const idea = await mustIdea(db, id);
    const b = await c.body<{ project_id?: number; project_name?: string; plan?: boolean }>();
    let projectId = Number(b.project_id) || idea.project_id;
    if (!projectId) {
      projectId = await db.insert(
        "INSERT INTO projects (name, description, priority) VALUES (?, ?, ?)",
        str(b.project_name, 120) || idea.title,
        idea.summary,
        idea.priority === "none" ? "medium" : idea.priority,
      );
    }
    await db.run("UPDATE ideas SET project_id = ?, commitment = 'decision' WHERE id = ?", projectId, id);
    await setStatus(db, id, "approved", me.id);
    if (b.plan !== false) {
      await db.run("UPDATE projects SET plan_status = 'generating' WHERE id = ?", projectId);
      await jobs.enqueue("plan", { projectId });
    }
    await logActivity(db, me.id, "approve", "idea", id, `project ${projectId}`);
    return { ok: true, projectId };
  });

  r.post("/api/ideas/:id/merge", async (c) => {
    const me = requireUser(c);
    const keep = idParam(c);
    const other = Number((await c.body<{ other_id?: number }>()).other_id);
    await mustIdea(c.db, keep);
    await mustIdea(c.db, other);
    if (keep === other) throw new HttpError(400, "Pick a different idea.");
    await mergeInto(c.db, keep, other, me.id);
    await jobs.enqueue("refresh_card", { ideaId: keep, reason: `Merged with idea #${other}.` });
    return { ok: true };
  });

  r.post("/api/fragments/:id/move", async (c) => {
    const me = requireUser(c);
    const target = (await c.body<{ idea_id?: number | null }>()).idea_id;
    if (target) await mustIdea(c.db, Number(target));
    await jobs.enqueue("move_fragment", { fragmentId: idParam(c), ideaId: target ? Number(target) : null, userId: me.id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- questions
  r.post("/api/ideas/:id/questions", async (c) => {
    const id = idParam(c);
    await mustIdea(c.db, id);
    const text = str((await c.body<{ text?: string }>()).text, 500);
    if (!text) throw new HttpError(400, "Write the question first.");
    return { id: await c.db.insert("INSERT INTO questions (idea_id, text) VALUES (?, ?)", id, text) };
  });

  r.post("/api/questions/:id/ask", async (c) => {
    const me = requireUser(c);
    const qid = idParam(c);
    const q = await c.db.get<{ idea_id: number; text: string }>("SELECT idea_id, text FROM questions WHERE id = ?", qid);
    if (!q) throw new HttpError(404, "Question not found.");
    const text = str((await c.body<{ text?: string }>()).text, 500) || q.text;
    await c.db.run("UPDATE questions SET text = ?, status = 'asked', asked_by = ?, asked_at = now_text() WHERE id = ?", text, me.id, qid);
    const idea = await getIdea(c.db, q.idea_id);
    if (idea && ["new", "under_review"].includes(idea.status)) await setStatus(c.db, q.idea_id, "needs_clarification", me.id);
    await notifyRole(c.db, "visionary", { title: `${me.name} has a question`, body: text, url: "#/capture" });
    return { ok: true };
  });

  r.post("/api/questions/:id/dismiss", async (c) => {
    await c.db.run("UPDATE questions SET status = 'dismissed' WHERE id = ?", idParam(c));
    return { ok: true };
  });

  // An answer given in person, typed by the admin.
  r.post("/api/questions/:id/answer", async (c) => {
    const me = requireUser(c);
    const qid = idParam(c);
    const q = await c.db.get<{ idea_id: number }>("SELECT idea_id FROM questions WHERE id = ?", qid);
    if (!q) throw new HttpError(404, "Question not found.");
    const text = str((await c.body<{ text?: string }>()).text, 4000);
    if (!text) throw new HttpError(400, "Write the answer first.");
    await c.db.run("UPDATE questions SET status = 'answered', answer_text = ?, answered_at = now_text() WHERE id = ?", text, qid);
    if ((await getIdea(c.db, q.idea_id))?.status === "needs_clarification") await setStatus(c.db, q.idea_id, "under_review", me.id);
    await jobs.enqueue("refresh_card", { ideaId: q.idea_id, reason: "A clarification question was answered." });
    return { ok: true };
  });

  // -------------------------------------------------------- notes/attachments
  r.post("/api/ideas/:id/notes", async (c) => {
    const me = requireUser(c);
    const id = idParam(c);
    await mustIdea(c.db, id);
    const body = str((await c.body<{ body?: string }>()).body, 8000);
    if (!body) throw new HttpError(400, "The note is empty.");
    await c.db.run("INSERT INTO notes (idea_id, user_id, body) VALUES (?, ?, ?)", id, me.id, body);
    await c.db.run("UPDATE ideas SET last_activity_at = now_text() WHERE id = ?", id);
    return { ok: true };
  });

  r.delete("/api/notes/:id", async (c) => {
    await moveToTrash(c.db, "note", idParam(c), requireUser(c).id);
    return { ok: true };
  });

  // Files: step 1 gets a one-time upload link, step 2 records the file.
  r.post("/api/ideas/:id/attachments/upload-url", async (c) => {
    const id = idParam(c);
    await mustIdea(c.db, id);
    const b = await c.body<{ name?: string; size?: number }>();
    if (Number(b.size) > config.maxUploadMb * 1024 * 1024) throw new HttpError(413, `Files can be up to ${config.maxUploadMb} MB.`);
    const safe = (str(b.name, 200) || "file").replace(/[^\w.\- ]+/g, "_").slice(-80);
    const path = `${id}/${crypto.randomUUID().slice(0, 8)}-${safe}`;
    return { path, uploadUrl: await storage(c.url.origin + "/api").uploadUrl("files", path) };
  });

  r.post("/api/ideas/:id/attachments", async (c) => {
    const me = requireUser(c);
    const id = idParam(c);
    await mustIdea(c.db, id);
    const b = await c.body<{ path?: string; name?: string; mime?: string; url?: string }>();
    if (b.path) {
      const path = str(b.path, 300);
      if (!path.startsWith(`${id}/`)) throw new HttpError(400, "Invalid file.");
      const size = await storage(c.url.origin + "/api").size("files", path);
      if (!size) throw new HttpError(400, "The file didn't finish uploading. Try again.");
      await c.db.run(
        "INSERT INTO attachments (idea_id, kind, name, path, mime, size_bytes, user_id) VALUES (?, 'file', ?, ?, ?, ?, ?)",
        id,
        str(b.name, 200) || path.split("/").pop()!,
        path,
        str(b.mime, 100) || "application/octet-stream",
        size,
        me.id,
      );
    } else {
      const url = str(b.url, 2000);
      if (!/^https?:\/\//i.test(url)) throw new HttpError(400, "Links must start with http:// or https://");
      await c.db.run("INSERT INTO attachments (idea_id, kind, name, url, user_id) VALUES (?, 'link', ?, ?, ?)", id, str(b.name, 200) || url, url, me.id);
    }
    return { ok: true };
  });

  r.get("/api/attachments/:id/file", async (c) => {
    const a = await c.db.get<{ path: string | null }>("SELECT path FROM attachments WHERE id = ?", idParam(c));
    if (!a?.path) throw new HttpError(404, "File not found.");
    return { url: await storage(c.url.origin + "/api").signedUrl("files", a.path, 600) };
  });

  r.delete("/api/attachments/:id", async (c) => {
    if (!(await moveToTrash(c.db, "attachment", idParam(c), requireUser(c).id))) throw new HttpError(404, "Attachment not found.");
    return { ok: true };
  });

  // -------------------------------------------------------------------- links
  r.post("/api/links", async (c) => {
    const me = requireUser(c);
    const b = await c.body<{ a?: number; b?: number; type?: string; reason?: string }>();
    const type = ["related", "builds_on", "conflicts", "combines", "duplicate"].includes(String(b.type)) ? String(b.type) : "related";
    await mustIdea(c.db, Number(b.a));
    await mustIdea(c.db, Number(b.b));
    const id = await addLink(c.db, Number(b.a), Number(b.b), type, { status: "confirmed", by: "user", reason: str(b.reason, 500) || undefined });
    await logActivity(c.db, me.id, "link", "idea", Number(b.a), `#${b.b} ${type}`);
    return { id };
  });

  r.patch("/api/links/:id", async (c) => {
    const status = (await c.body<{ status?: string }>()).status;
    if (!["confirmed", "dismissed", "suggested"].includes(String(status))) throw new HttpError(400, "Unknown status.");
    await c.db.run("UPDATE links SET status = ? WHERE id = ?", String(status), idParam(c));
    await c.db.run(
      "UPDATE review_items SET status = 'done', resolution = ?, resolved_at = now_text() WHERE link_id = ? AND status = 'open'",
      String(status),
      idParam(c),
    );
    return { ok: true };
  });

  // -------------------------------------------------------------- deliverables
  r.get("/api/deliverable-kinds", () => Object.entries(DELIVERABLES).map(([kind, d]) => ({ kind, title: d.title })));

  r.post("/api/ideas/:id/deliverables", async (c) => {
    const me = requireUser(c);
    const id = idParam(c);
    await mustIdea(c.db, id);
    const b = await c.body<{ kind?: string; instructions?: string }>();
    const kind = String(b.kind ?? "");
    if (!DELIVERABLES[kind] && kind !== "custom") throw new HttpError(400, "Unknown document type.");
    if (kind === "custom" && !str(b.instructions)) throw new HttpError(400, "Describe the document you want.");
    await jobs.enqueue("deliverable", { ideaId: id, kind, instructions: str(b.instructions, 2000), userId: me.id, nonce: Date.now() });
    return { ok: true };
  });

  r.get("/api/deliverables/:id", async (c) => {
    const d = await c.db.get("SELECT * FROM deliverables WHERE id = ?", idParam(c));
    if (!d) throw new HttpError(404, "Document not found.");
    return d;
  });

  r.delete("/api/deliverables/:id", async (c) => {
    await moveToTrash(c.db, "deliverable", idParam(c), requireUser(c).id);
    return { ok: true };
  });

  r.get("/api/ideas/:id/export.md", async (c) => {
    const id = idParam(c);
    await mustIdea(c.db, id);
    return new Response(await ideaMarkdown(c.db, id), { headers: { "content-type": "text/markdown; charset=utf-8" } });
  });

  // ------------------------------------------------------------------- review
  r.get("/api/review", async (c) => {
    const items = await c.db.all<Record<string, unknown>>(
      `SELECT r.*, i.title AS idea_title, i.summary AS idea_summary, i.status AS idea_status, i.clarity AS idea_clarity,
         i.commitment AS idea_commitment, o.title AS other_title, o.summary AS other_summary, o.status AS other_status,
         f.quote AS fragment_quote, f.recording_id AS fragment_recording_id, f.start_sec, f.interpretation AS fragment_interpretation,
         l.type AS link_type, l.confidence
       FROM review_items r
       LEFT JOIN ideas i ON i.id = r.idea_id LEFT JOIN ideas o ON o.id = r.other_idea_id
       LEFT JOIN fragments f ON f.id = r.fragment_id LEFT JOIN links l ON l.id = r.link_id
       WHERE r.status = 'open' ORDER BY r.id`,
    );
    const out = [];
    for (const it of items) {
      const ideaId = it.idea_id as number | null;
      out.push({
        ...it,
        recording_id: it.fragment_recording_id ?? it.recording_id,
        tags: ideaId ? (await c.db.all<{ tag: string }>("SELECT tag FROM tags WHERE idea_id = ?", ideaId)).map((t) => t.tag) : [],
        questions: ideaId ? await c.db.all("SELECT id, text, why, status FROM questions WHERE idea_id = ? AND status IN ('draft','asked')", ideaId) : [],
      });
    }
    return out;
  });

  r.post("/api/review/bulk", async (c) => {
    const me = requireUser(c);
    const ids = ((await c.body<{ ids?: number[] }>()).ids ?? []).map(Number).filter(Boolean);
    for (const id of ids) await resolveReview(c.db, id, "ok", me.id);
    return { ok: true, count: ids.length };
  });

  r.post("/api/review/:id", async (c) => {
    const me = requireUser(c);
    const db = c.db;
    const rid = idParam(c);
    const action = String((await c.body<{ action?: string }>()).action ?? "");
    const item = await db.get<{
      id: number;
      kind: string;
      idea_id: number | null;
      other_idea_id: number | null;
      fragment_id: number | null;
      link_id: number | null;
      recording_id: number | null;
      status: string;
    }>("SELECT * FROM review_items WHERE id = ?", rid);
    if (!item) throw new HttpError(404, "Item not found.");
    if (item.status !== "open") return { ok: true };
    const ideaId = item.idea_id;
    switch (action) {
      case "ok":
        break;
      case "review":
        if (ideaId) {
          await setStatus(db, ideaId, "under_review", me.id);
          await scheduleReportAndScore(db, jobs, ideaId);
        }
        break;
      case "archive":
        if (ideaId) await setStatus(db, ideaId, "archived", me.id);
        break;
      case "hold":
        if (ideaId) await setStatus(db, ideaId, "on_hold", me.id);
        break;
      case "undo":
        if (item.fragment_id) await jobs.enqueue("move_fragment", { fragmentId: item.fragment_id, ideaId: null, userId: me.id });
        break;
      case "merge":
        if (ideaId && item.other_idea_id) {
          await mergeInto(db, item.other_idea_id, ideaId, me.id);
          await jobs.enqueue("refresh_card", { ideaId: item.other_idea_id, reason: `Merged with idea #${ideaId}.` });
        }
        break;
      case "confirm":
        if (item.link_id) await db.run("UPDATE links SET status = 'confirmed' WHERE id = ?", item.link_id);
        break;
      case "link":
        if (ideaId && item.other_idea_id) {
          if (item.link_id) await db.run("UPDATE links SET status = 'dismissed' WHERE id = ?", item.link_id);
          await addLink(db, ideaId, item.other_idea_id, "related", { status: "confirmed", by: "user" });
        }
        break;
      case "dismiss":
        if (item.link_id) await db.run("UPDATE links SET status = 'dismissed' WHERE id = ?", item.link_id);
        break;
      case "restore":
        if (item.recording_id) {
          await restoreRecording(db, item.recording_id, me.id);
          const rec = await db.get<{ status: string; purged_at: string | null }>("SELECT status, purged_at FROM recordings WHERE id = ?", item.recording_id);
          if (rec && !rec.purged_at && !["done", "failed", "uploading"].includes(rec.status)) {
            await jobs.enqueue("process_recording", { recordingId: item.recording_id });
          }
        }
        break;
      default:
        throw new HttpError(400, "Unknown action.");
    }
    await resolveReview(db, rid, action, me.id);
    if (ideaId) await indexIdea(db, ideaId);
    return { ok: true };
  });
}

// Readable Markdown for one idea: used for export and sharing.
export async function ideaMarkdown(db: DB, id: number): Promise<string> {
  const idea = await getIdea(db, id);
  if (!idea) return "";
  const card = safeJson<StoredCard>(idea.card, {});
  const report = safeJson<Report | null>(idea.report, null);
  const score = safeJson<Score | null>(idea.score, null);
  const frags = await db.all<{ quote: string; recording_id: number; start_sec: number | null; captured_at: string }>(
    "SELECT f.quote, f.recording_id, f.start_sec, r.captured_at FROM fragments f JOIN recordings r ON r.id = f.recording_id WHERE f.idea_id = ? ORDER BY r.captured_at",
    id,
  );
  const tags = (await db.all<{ tag: string }>("SELECT tag FROM tags WHERE idea_id = ?", id)).map((t) => t.tag);
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
  for (const f of frags) {
    const at = f.start_sec != null ? ` at ${Math.floor(f.start_sec / 60)}:${String(Math.floor(f.start_sec % 60)).padStart(2, "0")}` : "";
    out.push(`> ${f.quote.replace(/\n/g, " ")}`, `> — recording ${f.recording_id}, ${f.captured_at}${at}`, "");
  }
  return out.join("\n");
}
