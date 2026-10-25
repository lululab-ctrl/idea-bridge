import { ask, type AskTurn } from "../assistant.ts";
import { CRITERIA, type Plan, type Score } from "../ai/schemas.ts";
import { budgetStatus } from "../ai/llm.ts";
import type { App } from "../app.ts";
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { getSetting, logActivity, safeJson } from "../db.ts";
import { HttpError, idParam, type Router, requireUser, str } from "../http.ts";
import { getIdea, type IdeaRow, setStatus } from "../ideas.ts";
import { localParts } from "../periodic.ts";
import { indexTask, search } from "../search.ts";
import { moveToTrash } from "../trash.ts";
import { weightedScore, weights } from "./ideas.ts";

const TASK_STATUSES = ["todo", "doing", "done", "blocked"];
const PRIORITY = ["low", "medium", "high", "urgent"];

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.max(0, Math.round(days)));
  return d.toISOString().slice(0, 10);
}

async function today(db: DB) {
  return localParts(await getSetting(db, "timezone", config.timezone)).date;
}

export function workRoutes(r: Router, app: App) {
  const { jobs, ai } = app;

  const projectSummary = async (db: DB, p: Record<string, unknown>) => {
    const t = await db.get<{ total: number; done: number; overdue: number }>(
      `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'done')::int AS done,
         COUNT(*) FILTER (WHERE status != 'done' AND due_date < ?)::int AS overdue FROM tasks WHERE project_id = ?`,
      await today(db),
      p.id as number,
    );
    const next = await db.get(
      "SELECT id, title, due_date FROM tasks WHERE project_id = ? AND status != 'done' ORDER BY due_date IS NULL, due_date, position LIMIT 1",
      p.id as number,
    );
    return { ...p, plan: undefined, tasks_total: t?.total ?? 0, tasks_done: t?.done ?? 0, tasks_overdue: t?.overdue ?? 0, next_task: next ?? null };
  };

  // ----------------------------------------------------------------- projects
  r.get("/api/projects", async (c) => {
    const rows = await c.db.all<Record<string, unknown>>("SELECT * FROM projects ORDER BY status = 'active' DESC, updated_at DESC");
    const out = [];
    for (const p of rows) out.push(await projectSummary(c.db, p));
    return out;
  });

  r.post("/api/projects", async (c) => {
    const me = requireUser(c);
    const b = await c.body<{ name?: string; description?: string; idea_ids?: number[] }>();
    const name = str(b.name, 120);
    if (!name) throw new HttpError(400, "Give the project a name.");
    const id = await c.db.insert("INSERT INTO projects (name, description) VALUES (?, ?)", name, str(b.description, 4000) || null);
    for (const ideaId of b.idea_ids ?? []) await c.db.run("UPDATE ideas SET project_id = ? WHERE id = ?", id, Number(ideaId));
    await logActivity(c.db, me.id, "create", "project", id);
    return { id };
  });

  r.get("/api/projects/:id", async (c) => {
    const id = idParam(c);
    const p = await c.db.get<Record<string, unknown>>("SELECT * FROM projects WHERE id = ?", id);
    if (!p) throw new HttpError(404, "Project not found.");
    return {
      ...(await projectSummary(c.db, p)),
      plan: safeJson<Plan | null>(p.plan as string, null),
      ideas: await c.db.all("SELECT id, title, summary, status FROM ideas WHERE project_id = ?", id),
      tasks: await c.db.all(
        "SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.project_id = ? ORDER BY t.position, t.id",
        id,
      ),
      notes: await c.db.all(
        "SELECT n.id, n.body, n.created_at, u.name AS user_name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.project_id = ? ORDER BY n.id",
        id,
      ),
    };
  });

  r.patch("/api/projects/:id", async (c) => {
    const me = requireUser(c);
    const id = idParam(c);
    const b = await c.body();
    const db = c.db;
    if (typeof b.name === "string" && b.name.trim()) await db.run("UPDATE projects SET name = ? WHERE id = ?", str(b.name, 120), id);
    if (typeof b.description === "string") await db.run("UPDATE projects SET description = ? WHERE id = ?", str(b.description, 4000), id);
    if (b.deadline !== undefined) await db.run("UPDATE projects SET deadline = ? WHERE id = ?", str(b.deadline, 10) || null, id);
    if (typeof b.priority === "string" && PRIORITY.includes(b.priority)) await db.run("UPDATE projects SET priority = ? WHERE id = ?", b.priority, id);
    if (typeof b.status === "string" && ["active", "on_hold", "completed", "archived"].includes(b.status)) {
      await db.run("UPDATE projects SET status = ? WHERE id = ?", b.status, id);
      const map: Record<string, string> = { active: "in_progress", on_hold: "on_hold", completed: "completed", archived: "archived" };
      for (const i of await db.all<{ id: number }>("SELECT id FROM ideas WHERE project_id = ?", id)) await setStatus(db, i.id, map[b.status] as never, me.id);
    }
    await db.run("UPDATE projects SET updated_at = now_text() WHERE id = ?", id);
    await logActivity(db, me.id, "update", "project", id);
    return { ok: true };
  });

  r.post("/api/projects/:id/notes", async (c) => {
    const body = str((await c.body<{ body?: string }>()).body, 8000);
    if (!body) throw new HttpError(400, "The note is empty.");
    await c.db.run("INSERT INTO notes (project_id, user_id, body) VALUES (?, ?, ?)", idParam(c), requireUser(c).id, body);
    return { ok: true };
  });

  r.post("/api/projects/:id/plan", async (c) => {
    const id = idParam(c);
    if (!(await c.db.get("SELECT 1 FROM ideas WHERE project_id = ?", id))) throw new HttpError(400, "Link at least one idea to this project first.");
    await c.db.run("UPDATE projects SET plan_status = 'generating' WHERE id = ?", id);
    await jobs.enqueue("plan", { projectId: id });
    return { ok: true };
  });

  // Turns the reviewed draft plan into real tasks. Only the chosen tasks are created.
  r.post("/api/projects/:id/plan/accept", async (c) => {
    const me = requireUser(c);
    const id = idParam(c);
    const db = c.db;
    const p = await db.get<{ plan: string | null; name: string }>("SELECT plan, name FROM projects WHERE id = ?", id);
    const plan = safeJson<Plan | null>(p?.plan, null);
    if (!plan) throw new HttpError(400, "There is no draft plan.");
    const chosen = new Set(((await c.body<{ tasks?: number[] }>()).tasks ?? plan.tasks.map((_, i) => i)).map(Number));
    const people = await db.all<{ id: number; role: string }>("SELECT id, role FROM users");
    const roleUser = (role: string) => people.find((u) => u.role === role)?.id ?? null;
    const start = await today(db);
    const ideaId = (await db.get<{ id: number }>("SELECT id FROM ideas WHERE project_id = ? ORDER BY id LIMIT 1", id))?.id ?? null;
    let pos = (await db.get<{ m: number }>("SELECT COALESCE(MAX(position), 0)::int AS m FROM tasks WHERE project_id = ?", id))?.m ?? 0;
    await db.tx(async (t) => {
      for (const [i, task] of plan.tasks.entries()) {
        if (!chosen.has(i)) continue;
        const tid = await t.insert(
          `INSERT INTO tasks (project_id, idea_id, milestone, title, instructions, expected_outcome, priority, assignee_id, due_date, position)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          ideaId,
          task.milestone,
          task.title,
          task.instructions,
          task.expected_outcome,
          PRIORITY.includes(task.priority) ? task.priority : "medium",
          task.owner === "either" ? null : roleUser(task.owner),
          addDays(start, task.due_offset_days),
          ++pos,
        );
        await indexTask(t, tid);
      }
      await t.run("UPDATE projects SET plan_status = 'accepted', status = 'active', updated_at = now_text() WHERE id = ?", id);
      const last = Math.max(0, ...plan.milestones.map((m) => m.target_offset_days));
      await t.run("UPDATE projects SET deadline = COALESCE(deadline, ?) WHERE id = ?", addDays(start, last), id);
      for (const i of await t.all<{ id: number }>("SELECT id FROM ideas WHERE project_id = ?", id)) await setStatus(t, i.id, "in_progress", me.id);
    });
    await db.run(
      "UPDATE review_items SET status = 'done', resolution = 'accepted', resolved_at = now_text() WHERE kind = 'plan' AND status = 'open' AND note LIKE ?",
      `%${p!.name}%`,
    );
    await logActivity(db, me.id, "accept_plan", "project", id, `${chosen.size} tasks`);
    return { ok: true };
  });

  // -------------------------------------------------------------------- tasks
  r.get("/api/tasks", async (c) => {
    const me = requireUser(c);
    const q = c.query;
    const where: string[] = [];
    const vals: (string | number)[] = [];
    const t = await today(c.db);
    if (q.get("mine")) (where.push("(t.assignee_id = ? OR t.assignee_id IS NULL)"), vals.push(me.id));
    const status = q.get("status");
    if (status === "open") where.push("t.status != 'done'");
    else if (status && TASK_STATUSES.includes(status)) (where.push("t.status = ?"), vals.push(status));
    if (q.get("project")) (where.push("t.project_id = ?"), vals.push(Number(q.get("project"))));
    if (q.get("due") === "overdue") (where.push("t.status != 'done' AND t.due_date < ?"), vals.push(t));
    if (q.get("due") === "week") (where.push("t.status != 'done' AND t.due_date <= ?"), vals.push(addDays(t, 7)));
    return c.db.all(
      `SELECT t.*, p.name AS project_name, u.name AS assignee_name, i.title AS idea_title FROM tasks t
       LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN ideas i ON i.id = t.idea_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY t.status = 'done', t.due_date IS NULL, t.due_date, t.position, t.id LIMIT 500`,
      ...vals,
    );
  });

  r.post("/api/tasks", async (c) => {
    const me = requireUser(c);
    const b = await c.body();
    const title = str(b.title, 300);
    if (!title) throw new HttpError(400, "Give the task a title.");
    const id = await c.db.insert(
      "INSERT INTO tasks (project_id, idea_id, milestone, title, instructions, expected_outcome, priority, assignee_id, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      Number(b.project_id) || null,
      Number(b.idea_id) || null,
      str(b.milestone, 120) || null,
      title,
      str(b.instructions) || null,
      str(b.expected_outcome, 1000) || null,
      PRIORITY.includes(String(b.priority)) ? String(b.priority) : "medium",
      Number(b.assignee_id) || null,
      str(b.due_date, 10) || null,
    );
    await indexTask(c.db, id);
    await logActivity(c.db, me.id, "create", "task", id);
    return { id };
  });

  r.patch("/api/tasks/:id", async (c) => {
    const me = requireUser(c);
    const id = idParam(c);
    const b = await c.body();
    const t = await c.db.get<{ status: string; project_id: number | null }>("SELECT status, project_id FROM tasks WHERE id = ?", id);
    if (!t) throw new HttpError(404, "Task not found.");
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    const text = (k: string, max = 5000) => {
      if (typeof b[k] === "string") (sets.push(`${k} = ?`), vals.push(str(b[k], max) || null));
    };
    text("title", 300);
    text("instructions");
    text("expected_outcome", 1000);
    text("milestone", 120);
    if (b.due_date !== undefined) (sets.push("due_date = ?", "reminded_at = NULL"), vals.push(str(b.due_date, 10) || null));
    if (b.assignee_id !== undefined) (sets.push("assignee_id = ?"), vals.push(Number(b.assignee_id) || null));
    if (typeof b.priority === "string" && PRIORITY.includes(b.priority)) (sets.push("priority = ?"), vals.push(b.priority));
    if (typeof b.status === "string" && TASK_STATUSES.includes(b.status)) {
      sets.push("status = ?", "completed_at = ?");
      vals.push(b.status, b.status === "done" ? new Date().toISOString().replace("T", " ").slice(0, 19) : null);
      await logActivity(c.db, me.id, b.status === "done" ? "complete" : "status", "task", id, b.status);
    }
    if (typeof b.position === "number") (sets.push("position = ?"), vals.push(b.position));
    if (sets.length) await c.db.run(`UPDATE tasks SET ${sets.join(", ")}, updated_at = now_text() WHERE id = ?`, ...vals, id);
    await indexTask(c.db, id);
    if (b.status === "done" && t.project_id) {
      const left = (await c.db.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM tasks WHERE project_id = ? AND status != 'done'", t.project_id))?.n ?? 0;
      return { ok: true, projectAllDone: left === 0 };
    }
    return { ok: true };
  });

  r.delete("/api/tasks/:id", async (c) => {
    if (!(await moveToTrash(c.db, "task", idParam(c), requireUser(c).id))) throw new HttpError(404, "Task not found.");
    return { ok: true };
  });

  // ---------------------------------------------------------------- dashboard
  r.get("/api/dashboard", async (c) => {
    const me = requireUser(c);
    const db = c.db;
    const d = await today(db);
    const count = async (sql: string, ...a: (string | number)[]) => (await db.get<{ n: number }>(sql, ...a))?.n ?? 0;
    const reviewByKind = await db.all<{ kind: string; n: number }>("SELECT kind, COUNT(*)::int AS n FROM review_items WHERE status = 'open' GROUP BY kind");
    const w = await weights(db);
    const scored = (await db.all<IdeaRow>("SELECT * FROM ideas WHERE score IS NOT NULL AND status NOT IN ('archived','completed')"))
      .map((i) => ({ id: i.id, title: i.title, status: i.status, score: weightedScore(w, i.score), take: safeJson<Score | null>(i.score, null)?.overall_take }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 5);
    const insights = await getSetting<{ at: string; result: { promising: { idea_id: number; why: string }[]; overview: string } } | null>(db, "insights", null);
    const promising = [];
    for (const p of insights?.result.promising ?? []) {
      const idea = await getIdea(db, p.idea_id);
      if (idea && idea.status !== "archived") promising.push({ ...p, title: idea.title, status: idea.status });
    }
    const projects = [];
    for (const p of await db.all<Record<string, unknown>>("SELECT * FROM projects WHERE status = 'active' ORDER BY updated_at DESC")) {
      const t = await db.get<{ total: number; done: number }>(
        "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'done')::int AS done FROM tasks WHERE project_id = ?",
        p.id as number,
      );
      projects.push({ id: p.id, name: p.name, deadline: p.deadline, plan_status: p.plan_status, total: t?.total ?? 0, done: t?.done ?? 0 });
    }
    return {
      today: d,
      review: { total: reviewByKind.reduce((n, x) => n + x.n, 0), byKind: reviewByKind },
      statusCounts: await db.all("SELECT status, COUNT(*)::int AS n FROM ideas GROUP BY status"),
      newIdeas: await db.all("SELECT id, title, summary, commitment, clarity, created_at FROM ideas WHERE status = 'new' ORDER BY id DESC LIMIT 8"),
      highPotential: scored,
      promising,
      insightsOverview: insights?.result.overview ?? null,
      insightsAt: insights?.at ?? null,
      projects,
      myTasks: await db.all(
        `SELECT t.id, t.title, t.due_date, t.status, t.priority, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.status != 'done' AND (t.assignee_id = ? OR t.assignee_id IS NULL) AND (t.due_date IS NULL OR t.due_date <= ?)
         ORDER BY t.due_date IS NULL, t.due_date, t.priority = 'urgent' DESC LIMIT 10`,
        me.id,
        addDays(d, 7),
      ),
      overdue: await count("SELECT COUNT(*)::int AS n FROM tasks WHERE status != 'done' AND due_date < ?", d),
      waiting: await db.all(
        "SELECT q.id, q.text, q.asked_at, i.id AS idea_id, i.title FROM questions q JOIN ideas i ON i.id = q.idea_id WHERE q.status = 'asked' ORDER BY q.asked_at",
      ),
      themes: await db.all(
        "SELECT t.id, t.name, COUNT(i.id)::int AS n FROM themes t JOIN ideas i ON i.theme_id = t.id AND i.status != 'archived' GROUP BY t.id ORDER BY n DESC LIMIT 12",
      ),
      completed: await db.all("SELECT id, title, completed_at FROM tasks WHERE status = 'done' ORDER BY completed_at DESC LIMIT 5"),
      archivedCount: await count("SELECT COUNT(*)::int AS n FROM ideas WHERE status = 'archived'"),
      processing: await db.all("SELECT id, status, captured_at FROM recordings WHERE status NOT IN ('done','failed','uploading') AND deleted_at IS NULL ORDER BY id DESC"),
      failed: await count("SELECT COUNT(*)::int AS n FROM recordings WHERE status = 'failed' AND archived = 0 AND deleted_at IS NULL"),
      capturedThisWeek: await count("SELECT COUNT(*)::int AS n FROM recordings WHERE created_at >= ago_text(604800) AND deleted_at IS NULL"),
      budget: await budgetStatus(db),
      waitingJobs: await db.all("SELECT type, last_error, run_at FROM jobs WHERE status = 'pending' AND last_error IS NOT NULL ORDER BY run_at LIMIT 3"),
    };
  });

  r.get("/api/priorities", async (c) => {
    const w = await weights(c.db);
    const rows = await c.db.all<IdeaRow>("SELECT * FROM ideas WHERE status NOT IN ('archived','completed')");
    return {
      weights: w,
      criteria: CRITERIA,
      ideas: rows
        .map((i) => ({
          id: i.id,
          title: i.title,
          status: i.status,
          priority: i.priority,
          commitment: i.commitment,
          score: weightedScore(w, i.score),
          current: i.score_version === i.version,
          detail: safeJson<Score | null>(i.score, null),
        }))
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1)),
    };
  });

  // ------------------------------------------------------------ search & ask
  r.get("/api/search", async (c) => {
    const q = str(c.query.get("q"), 300);
    if (!q) return { ideas: [], recordings: [], tasks: [] };
    const res = await search(c.db, ai, q, 30);
    const ideas = [];
    for (const h of res.ideas) {
      const i = await getIdea(c.db, h.ideaId);
      if (i) ideas.push({ id: i.id, title: i.title, summary: i.summary, status: i.status, matchedBy: h.matchedBy, snippet: h.snippet });
    }
    const recordings = [];
    for (const x of res.recordings) {
      const rec = await c.db.get<{ captured_at: string; summary: string | null; deleted_at: string | null }>(
        "SELECT captured_at, summary, deleted_at FROM recordings WHERE id = ?",
        x.recordingId,
      );
      if (rec && !rec.deleted_at) recordings.push({ ...x, captured_at: rec.captured_at, summary: rec.summary });
    }
    const tasks = [];
    for (const x of res.tasks) {
      const t = await c.db.get<Record<string, unknown>>("SELECT title, status, project_id FROM tasks WHERE id = ?", x.taskId);
      if (t) tasks.push({ ...x, ...t });
    }
    return { ideas, recordings, tasks };
  });

  r.post("/api/ask", async (c) => {
    const b = await c.body<{ question?: string; history?: AskTurn[] }>();
    const question = str(b.question, 2000);
    if (!question) throw new HttpError(400, "Ask a question first.");
    const history = (b.history ?? [])
      .filter((h) => (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
      .slice(-10)
      .map((h) => ({ role: h.role, content: h.content.slice(0, 4000) }));
    return ask(c.db, ai, question, history);
  });

  // ------------------------------------------------------- digests & insights
  r.get("/api/digests", async (c) =>
    (await c.db.all<{ content: string }>("SELECT * FROM digests ORDER BY period_end DESC LIMIT 30")).map((d) => ({ ...d, content: safeJson(d.content, {}) })),
  );

  r.post("/api/digests/run", async (c) => {
    const kind = (await c.body<{ kind?: string }>()).kind === "weekly" ? "weekly_digest" : "daily_digest";
    await jobs.enqueue(kind, { nonce: Date.now() });
    return { ok: true };
  });

  r.get("/api/insights", async (c) => {
    const ins = await getSetting<{ at: string; result: Record<string, unknown> } | null>(c.db, "insights", null);
    const running = !!(await c.db.get("SELECT 1 FROM jobs WHERE type IN ('insights','weekly_digest') AND status IN ('pending','running')"));
    if (!ins) return { at: null, result: null, running };
    const titles = Object.fromEntries((await c.db.all<{ id: number; title: string }>("SELECT id, title FROM ideas")).map((i) => [i.id, i.title]));
    return { ...ins, running, titles };
  });

  r.post("/api/insights/run", async (c) => {
    await jobs.enqueue("insights", { nonce: Date.now() });
    return { ok: true };
  });
}
