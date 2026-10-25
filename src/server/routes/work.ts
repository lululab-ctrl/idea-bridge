import type { FastifyInstance } from "fastify";
import { ask, type AskTurn } from "../assistant.js";
import { CRITERIA, type Plan, type Score } from "../ai/schemas.js";
import { HttpError, idParam, requireUser, type Ctx } from "../app.js";
import { getSetting, logActivity } from "../db.js";
import { getIdea, setStatus, type IdeaRow } from "../ideas.js";
import { localParts } from "../periodic.js";
import { indexTask, safeJson, search } from "../search.js";
import { defaultWeights } from "./core.js";
import { weightedScore } from "./ideas.js";

const str = (v: unknown, max = 5000) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const TASK_STATUSES = ["todo", "doing", "done", "blocked"];
const PRIORITY = ["low", "medium", "high", "urgent"];

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.max(0, Math.round(days)));
  return d.toISOString().slice(0, 10);
}

export async function workRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, jobs, ai } = ctx;
  const today = () => localParts(getSetting(db, "timezone", "UTC")).date;

  // ----------------------------------------------------------------- projects
  const projectSummary = (p: Record<string, unknown>) => {
    const t = db
      .prepare("SELECT COUNT(*) AS total, SUM(status = 'done') AS done, SUM(status != 'done' AND due_date < ?) AS overdue FROM tasks WHERE project_id = ?")
      .get(today(), p.id) as { total: number; done: number | null; overdue: number | null };
    const next = db
      .prepare("SELECT id, title, due_date FROM tasks WHERE project_id = ? AND status != 'done' ORDER BY due_date IS NULL, due_date, position LIMIT 1")
      .get(p.id);
    return { ...p, plan: undefined, tasks_total: t.total, tasks_done: t.done ?? 0, tasks_overdue: t.overdue ?? 0, next_task: next ?? null };
  };

  app.get("/api/projects", async (req) => {
    requireUser(req);
    const rows = db.prepare("SELECT * FROM projects ORDER BY status = 'active' DESC, updated_at DESC").all() as Record<string, unknown>[];
    return rows.map(projectSummary);
  });

  app.post("/api/projects", async (req) => {
    const me = requireUser(req);
    const b = req.body as { name?: string; description?: string; idea_ids?: number[] };
    const name = str(b.name, 120);
    if (!name) throw new HttpError(400, "Give the project a name.");
    const id = Number(db.prepare("INSERT INTO projects (name, description) VALUES (?, ?)").run(name, str(b.description, 4000) || null).lastInsertRowid);
    for (const ideaId of b.idea_ids ?? []) db.prepare("UPDATE ideas SET project_id = ? WHERE id = ?").run(id, Number(ideaId));
    logActivity(db, me.id, "create", "project", id);
    return { id };
  });

  app.get("/api/projects/:id", async (req) => {
    requireUser(req);
    const id = idParam(req);
    const p = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!p) throw new HttpError(404, "Project not found.");
    const ideas = db.prepare("SELECT id, title, summary, status FROM ideas WHERE project_id = ?").all(id);
    const tasks = db
      .prepare("SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id WHERE t.project_id = ? ORDER BY t.position, t.id")
      .all(id);
    const notes = db
      .prepare("SELECT n.id, n.body, n.created_at, u.name AS user_name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.project_id = ? ORDER BY n.id")
      .all(id);
    return { ...projectSummary(p), plan: safeJson<Plan | null>(p.plan as string, null), ideas, tasks, notes };
  });

  app.patch("/api/projects/:id", async (req) => {
    const me = requireUser(req);
    const id = idParam(req);
    const b = req.body as Record<string, unknown>;
    if (typeof b.name === "string" && b.name.trim()) db.prepare("UPDATE projects SET name = ? WHERE id = ?").run(str(b.name, 120), id);
    if (typeof b.description === "string") db.prepare("UPDATE projects SET description = ? WHERE id = ?").run(str(b.description, 4000), id);
    if (b.deadline !== undefined) db.prepare("UPDATE projects SET deadline = ? WHERE id = ?").run(str(b.deadline, 10) || null, id);
    if (typeof b.priority === "string" && PRIORITY.includes(b.priority)) db.prepare("UPDATE projects SET priority = ? WHERE id = ?").run(b.priority, id);
    if (typeof b.status === "string" && ["active", "on_hold", "completed", "archived"].includes(b.status)) {
      db.prepare("UPDATE projects SET status = ? WHERE id = ?").run(b.status, id);
      // Keep the ideas' status in step with their project.
      const map: Record<string, string> = { active: "in_progress", on_hold: "on_hold", completed: "completed", archived: "archived" };
      for (const i of db.prepare("SELECT id FROM ideas WHERE project_id = ?").all(id) as { id: number }[]) {
        setStatus(db, i.id, map[b.status] as never, me.id);
      }
    }
    db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(id);
    logActivity(db, me.id, "update", "project", id);
    return { ok: true };
  });

  app.post("/api/projects/:id/notes", async (req) => {
    const me = requireUser(req);
    const body = str((req.body as { body?: string }).body, 8000);
    if (!body) throw new HttpError(400, "The note is empty.");
    db.prepare("INSERT INTO notes (project_id, user_id, body) VALUES (?, ?, ?)").run(idParam(req), me.id, body);
    return { ok: true };
  });

  app.post("/api/projects/:id/plan", async (req) => {
    requireUser(req);
    const id = idParam(req);
    if (!db.prepare("SELECT 1 FROM ideas WHERE project_id = ?").get(id)) throw new HttpError(400, "Link at least one idea to this project first.");
    db.prepare("UPDATE projects SET plan_status = 'generating' WHERE id = ?").run(id);
    jobs.enqueue("plan", { projectId: id });
    return { ok: true };
  });

  // Turns the reviewed draft plan into real tasks. Only the chosen tasks are created.
  app.post("/api/projects/:id/plan/accept", async (req) => {
    const me = requireUser(req);
    const id = idParam(req);
    const p = db.prepare("SELECT plan FROM projects WHERE id = ?").get(id) as { plan: string | null } | undefined;
    const plan = safeJson<Plan | null>(p?.plan, null);
    if (!plan) throw new HttpError(400, "There is no draft plan.");
    const chosen = new Set(((req.body as { tasks?: number[] }).tasks ?? plan.tasks.map((_, i) => i)).map(Number));
    const people = db.prepare("SELECT id, role FROM users").all() as { id: number; role: string }[];
    const roleUser = (r: string) => people.find((u) => u.role === r)?.id ?? null;
    const start = today();
    const ideaId = (db.prepare("SELECT id FROM ideas WHERE project_id = ? ORDER BY id LIMIT 1").get(id) as { id: number } | undefined)?.id ?? null;
    let pos = (db.prepare("SELECT COALESCE(MAX(position), 0) AS m FROM tasks WHERE project_id = ?").get(id) as { m: number }).m;
    db.transaction(() => {
      plan.tasks.forEach((t, i) => {
        if (!chosen.has(i)) return;
        const tid = Number(
          db
            .prepare(
              `INSERT INTO tasks (project_id, idea_id, milestone, title, instructions, expected_outcome, priority, assignee_id, due_date, position)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              id,
              ideaId,
              t.milestone,
              t.title,
              t.instructions,
              t.expected_outcome,
              PRIORITY.includes(t.priority) ? t.priority : "medium",
              t.owner === "either" ? null : roleUser(t.owner),
              addDays(start, t.due_offset_days),
              ++pos,
            ).lastInsertRowid,
        );
        indexTask(db, tid);
      });
      db.prepare("UPDATE projects SET plan_status = 'accepted', status = 'active', updated_at = datetime('now') WHERE id = ?").run(id);
      const last = Math.max(0, ...plan.milestones.map((m) => m.target_offset_days));
      db.prepare("UPDATE projects SET deadline = COALESCE(deadline, ?) WHERE id = ?").run(addDays(start, last), id);
      for (const i of db.prepare("SELECT id FROM ideas WHERE project_id = ?").all(id) as { id: number }[]) setStatus(db, i.id, "in_progress", me.id);
    })();
    db.prepare("UPDATE review_items SET status = 'done', resolution = 'accepted', resolved_at = datetime('now') WHERE kind = 'plan' AND status = 'open' AND note LIKE ?").run(
      `%${(db.prepare("SELECT name FROM projects WHERE id = ?").get(id) as { name: string }).name}%`,
    );
    logActivity(db, me.id, "accept_plan", "project", id, `${chosen.size} tasks`);
    return { ok: true };
  });

  // -------------------------------------------------------------------- tasks
  app.get("/api/tasks", async (req) => {
    const me = requireUser(req);
    const q = req.query as Record<string, string | undefined>;
    const where: string[] = [];
    const vals: unknown[] = [];
    if (q.mine) (where.push("(t.assignee_id = ? OR t.assignee_id IS NULL)"), vals.push(me.id));
    if (q.status === "open") where.push("t.status != 'done'");
    else if (q.status && TASK_STATUSES.includes(q.status)) (where.push("t.status = ?"), vals.push(q.status));
    if (q.project) (where.push("t.project_id = ?"), vals.push(Number(q.project)));
    if (q.due === "overdue") (where.push("t.status != 'done' AND t.due_date < ?"), vals.push(today()));
    if (q.due === "week") (where.push("t.status != 'done' AND t.due_date <= ?"), vals.push(addDays(today(), 7)));
    return db
      .prepare(
        `SELECT t.*, p.name AS project_name, u.name AS assignee_name, i.title AS idea_title FROM tasks t
         LEFT JOIN projects p ON p.id = t.project_id LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN ideas i ON i.id = t.idea_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY t.status = 'done', t.due_date IS NULL, t.due_date, t.position, t.id LIMIT 500`,
      )
      .all(...vals);
  });

  app.post("/api/tasks", async (req) => {
    const me = requireUser(req);
    const b = req.body as Record<string, unknown>;
    const title = str(b.title, 300);
    if (!title) throw new HttpError(400, "Give the task a title.");
    const id = Number(
      db
        .prepare(
          "INSERT INTO tasks (project_id, idea_id, milestone, title, instructions, expected_outcome, priority, assignee_id, due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          Number(b.project_id) || null,
          Number(b.idea_id) || null,
          str(b.milestone, 120) || null,
          title,
          str(b.instructions) || null,
          str(b.expected_outcome, 1000) || null,
          PRIORITY.includes(String(b.priority)) ? b.priority : "medium",
          Number(b.assignee_id) || null,
          str(b.due_date, 10) || null,
        ).lastInsertRowid,
    );
    indexTask(db, id);
    logActivity(db, me.id, "create", "task", id);
    return { id };
  });

  app.patch("/api/tasks/:id", async (req) => {
    const me = requireUser(req);
    const id = idParam(req);
    const b = req.body as Record<string, unknown>;
    const t = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as { status: string; project_id: number | null } | undefined;
    if (!t) throw new HttpError(404, "Task not found.");
    const sets: string[] = [];
    const vals: unknown[] = [];
    const text = (k: string, max = 5000) => {
      if (typeof b[k] === "string") (sets.push(`${k} = ?`), vals.push(str(b[k], max) || null));
    };
    text("title", 300);
    text("instructions");
    text("expected_outcome", 1000);
    text("milestone", 120);
    if (b.due_date !== undefined) (sets.push("due_date = ?"), vals.push(str(b.due_date, 10) || null), sets.push("reminded_at = NULL"));
    if (b.assignee_id !== undefined) (sets.push("assignee_id = ?"), vals.push(Number(b.assignee_id) || null));
    if (typeof b.priority === "string" && PRIORITY.includes(b.priority)) (sets.push("priority = ?"), vals.push(b.priority));
    if (typeof b.status === "string" && TASK_STATUSES.includes(b.status)) {
      sets.push("status = ?", "completed_at = ?");
      vals.push(b.status, b.status === "done" ? new Date().toISOString().replace("T", " ").slice(0, 19) : null);
      logActivity(db, me.id, b.status === "done" ? "complete" : "status", "task", id, b.status);
    }
    if (typeof b.position === "number") (sets.push("position = ?"), vals.push(b.position));
    if (sets.length) db.prepare(`UPDATE tasks SET ${sets.join(", ")}, updated_at = datetime('now') WHERE id = ?`).run(...vals, id);
    indexTask(db, id);
    // When the last task of a project is done, offer to complete the project.
    if (b.status === "done" && t.project_id) {
      const left = (db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project_id = ? AND status != 'done'").get(t.project_id) as { n: number }).n;
      return { ok: true, projectAllDone: left === 0 };
    }
    return { ok: true };
  });

  app.delete("/api/tasks/:id", async (req) => {
    const me = requireUser(req);
    const id = idParam(req);
    db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
    db.prepare("DELETE FROM search_fts WHERE entity = 'task' AND entity_id = ?").run(id);
    logActivity(db, me.id, "delete", "task", id);
    return { ok: true };
  });

  // ---------------------------------------------------------------- dashboard
  app.get("/api/dashboard", async (req) => {
    const me = requireUser(req);
    const d = today();
    const count = (sql: string, ...a: unknown[]) => (db.prepare(sql).get(...a) as { n: number }).n;
    const reviewByKind = db.prepare("SELECT kind, COUNT(*) AS n FROM review_items WHERE status = 'open' GROUP BY kind").all() as {
      kind: string;
      n: number;
    }[];
    const statusCounts = db.prepare("SELECT status, COUNT(*) AS n FROM ideas GROUP BY status").all();
    const newIdeas = db
      .prepare("SELECT id, title, summary, commitment, clarity, created_at FROM ideas WHERE status = 'new' ORDER BY id DESC LIMIT 8")
      .all();
    const scored = (db.prepare("SELECT * FROM ideas WHERE score IS NOT NULL AND status NOT IN ('archived','completed')").all() as IdeaRow[])
      .map((i) => ({ id: i.id, title: i.title, status: i.status, score: weightedScore(db, i.score), take: safeJson<Score | null>(i.score, null)?.overall_take }))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 5);
    const insights = getSetting<{ at: string; result: { promising: { idea_id: number; why: string }[]; patterns: unknown[]; overview: string } } | null>(
      db,
      "insights",
      null,
    );
    const promising = (insights?.result.promising ?? [])
      .map((p) => ({ ...p, title: getIdea(db, p.idea_id)?.title, status: getIdea(db, p.idea_id)?.status }))
      .filter((p) => p.title && p.status !== "archived");
    const projects = (db.prepare("SELECT * FROM projects WHERE status = 'active' ORDER BY updated_at DESC").all() as Record<string, unknown>[]).map((p) => {
      const t = db.prepare("SELECT COUNT(*) AS total, SUM(status = 'done') AS done FROM tasks WHERE project_id = ?").get(p.id) as { total: number; done: number | null };
      return { id: p.id, name: p.name, deadline: p.deadline, plan_status: p.plan_status, total: t.total, done: t.done ?? 0 };
    });
    const myTasks = db
      .prepare(
        `SELECT t.id, t.title, t.due_date, t.status, t.priority, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.status != 'done' AND (t.assignee_id = ? OR t.assignee_id IS NULL) AND (t.due_date IS NULL OR t.due_date <= ?)
         ORDER BY t.due_date IS NULL, t.due_date, t.priority = 'urgent' DESC LIMIT 10`,
      )
      .all(me.id, addDays(d, 7));
    const waiting = db
      .prepare("SELECT q.id, q.text, q.asked_at, i.id AS idea_id, i.title FROM questions q JOIN ideas i ON i.id = q.idea_id WHERE q.status = 'asked' ORDER BY q.asked_at")
      .all();
    const themes = db
      .prepare(
        `SELECT t.id, t.name, COUNT(i.id) AS n FROM themes t JOIN ideas i ON i.theme_id = t.id AND i.status != 'archived' GROUP BY t.id ORDER BY n DESC LIMIT 12`,
      )
      .all();
    const completed = db
      .prepare("SELECT id, title, completed_at FROM tasks WHERE status = 'done' ORDER BY completed_at DESC LIMIT 5")
      .all();
    const processing = db
      .prepare("SELECT id, status, captured_at FROM recordings WHERE status NOT IN ('done','failed') ORDER BY id DESC")
      .all();
    const failed = count("SELECT COUNT(*) AS n FROM recordings WHERE status = 'failed' AND archived = 0");
    return {
      today: d,
      review: { total: reviewByKind.reduce((n, r) => n + r.n, 0), byKind: reviewByKind },
      statusCounts,
      newIdeas,
      highPotential: scored,
      promising,
      insightsOverview: insights?.result.overview ?? null,
      insightsAt: insights?.at ?? null,
      projects,
      myTasks,
      overdue: count("SELECT COUNT(*) AS n FROM tasks WHERE status != 'done' AND due_date < ?", d),
      waiting,
      themes,
      completed,
      archivedCount: count("SELECT COUNT(*) AS n FROM ideas WHERE status = 'archived'"),
      processing,
      failed,
      capturedThisWeek: count("SELECT COUNT(*) AS n FROM recordings WHERE created_at >= datetime('now', '-7 days')"),
    };
  });

  // Ranked "what deserves attention" list with the reasoning visible.
  app.get("/api/priorities", async (req) => {
    requireUser(req);
    const w = getSetting<Record<string, number>>(db, "weights", defaultWeights);
    const rows = db.prepare("SELECT * FROM ideas WHERE status NOT IN ('archived','completed')").all() as IdeaRow[];
    return {
      weights: w,
      criteria: CRITERIA,
      ideas: rows
        .map((i) => {
          const s = safeJson<Score | null>(i.score, null);
          return {
            id: i.id,
            title: i.title,
            status: i.status,
            priority: i.priority,
            commitment: i.commitment,
            score: weightedScore(db, i.score),
            current: i.score_version === i.version,
            detail: s,
          };
        })
        .sort((a, b) => (b.score ?? -1) - (a.score ?? -1)),
    };
  });

  // ------------------------------------------------------------ search & ask
  app.get("/api/search", async (req) => {
    requireUser(req);
    const q = str((req.query as { q?: string }).q, 300);
    if (!q) return { ideas: [], recordings: [], tasks: [] };
    const res = await search(db, ai, q, 30);
    return {
      ideas: res.ideas
        .map((h) => {
          const i = getIdea(db, h.ideaId);
          return i ? { id: i.id, title: i.title, summary: i.summary, status: i.status, matchedBy: h.matchedBy, snippet: h.snippet } : null;
        })
        .filter(Boolean),
      recordings: res.recordings.map((r) => ({
        ...r,
        ...(db.prepare("SELECT captured_at, summary FROM recordings WHERE id = ?").get(r.recordingId) as object),
      })),
      tasks: res.tasks.map((t) => ({ ...t, ...(db.prepare("SELECT title, status, project_id FROM tasks WHERE id = ?").get(t.taskId) as object) })),
    };
  });

  app.post("/api/ask", async (req) => {
    requireUser(req);
    const b = req.body as { question?: string; history?: AskTurn[] };
    const question = str(b.question, 2000);
    if (!question) throw new HttpError(400, "Ask a question first.");
    const history = (b.history ?? [])
      .filter((h) => (h.role === "user" || h.role === "assistant") && typeof h.content === "string")
      .slice(-10)
      .map((h) => ({ role: h.role, content: h.content.slice(0, 4000) }));
    return ask(db, ai, question, history);
  });

  // ------------------------------------------------------- digests & insights
  app.get("/api/digests", async (req) => {
    requireUser(req);
    return (db.prepare("SELECT * FROM digests ORDER BY period_end DESC LIMIT 30").all() as { content: string }[]).map((d) => ({
      ...d,
      content: safeJson(d.content, {}),
    }));
  });

  app.post("/api/digests/run", async (req) => {
    requireUser(req);
    const kind = (req.body as { kind?: string }).kind === "weekly" ? "weekly_digest" : "daily_digest";
    jobs.enqueue(kind, { nonce: Date.now() });
    return { ok: true };
  });

  app.get("/api/insights", async (req) => {
    requireUser(req);
    const ins = getSetting<{ at: string; result: Record<string, unknown> } | null>(db, "insights", null);
    const running = !!db.prepare("SELECT 1 FROM jobs WHERE type IN ('insights','weekly_digest') AND status IN ('pending','running')").get();
    if (!ins) return { at: null, result: null, running };
    const titles = Object.fromEntries(
      (db.prepare("SELECT id, title FROM ideas").all() as { id: number; title: string }[]).map((i) => [i.id, i.title]),
    );
    return { ...ins, running, titles };
  });

  app.post("/api/insights/run", async (req) => {
    requireUser(req);
    jobs.enqueue("insights", { nonce: Date.now() });
    return { ok: true };
  });
}
