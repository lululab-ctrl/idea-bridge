import { type AI } from "./ai/index.ts";
import { baseSystem, sharedContext } from "./ai/prompts.ts";
import { DigestText, Insights } from "./ai/schemas.ts";
import { config } from "./config.ts";
import type { DB } from "./db.ts";
import { getSetting, logActivity, nowText, setSetting } from "./db.ts";
import { addLink, addReview, getIdea } from "./ideas.ts";
import type { JobQueue } from "./jobs.ts";
import { notifyRole, notifyUser } from "./notify.ts";
import { storage } from "./storage.ts";

// Time-based work, checked every time the worker wakes up (once a minute):
// daily/weekly digests, pattern finding, deadline reminders and keeping audio
// storage inside the free plan.

export function localParts(tz: string, d = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24, weekday: parts.weekday };
}

export class Periodic {
  constructor(
    private db: DB,
    private ai: AI,
    private jobs: JobQueue,
  ) {
    jobs.register("daily_digest", () => this.digest("daily"));
    jobs.register("weekly_digest", () => this.digest("weekly"));
    jobs.register("insights", () => this.insights().then(() => undefined));
    jobs.register("reminders", () => this.reminders());
    jobs.register("storage_cleanup", () => this.storageCleanup());
  }

  tz(): Promise<string> {
    return getSetting(this.db, "timezone", config.timezone);
  }

  async check() {
    const { date, hour, weekday } = localParts(await this.tz());
    const digestHour = await getSetting(this.db, "digest_hour", 7);
    const ran = await getSetting<Record<string, string>>(this.db, "periodic_ran", {});
    const due = (key: string, atHour: number) => hour >= atHour && ran[key] !== date;
    let changed = false;
    if (due("daily", digestHour)) {
      ran.daily = date;
      changed = true;
      await this.jobs.enqueue("daily_digest", { date });
      await this.jobs.enqueue("reminders", { date });
    }
    if (weekday === "Mon" && due("weekly", digestHour)) {
      ran.weekly = date;
      changed = true;
      await this.jobs.enqueue("weekly_digest", { date });
    }
    if (due("cleanup", 3)) {
      ran.cleanup = date;
      changed = true;
      await this.jobs.enqueue("storage_cleanup", { date });
    }
    if (changed) await setSetting(this.db, "periodic_ran", ran);
  }

  // ------------------------------------------------------------------ digests
  async collect(sinceIso: string) {
    const db = this.db;
    const today = localParts(await this.tz()).date;
    return {
      newIdeas: await db.all<{ id: number; title: string; summary: string; commitment: string; clarity: number }>(
        "SELECT id, title, summary, commitment, clarity FROM ideas WHERE created_at >= ? AND status != 'archived' ORDER BY id",
        sinceIso,
      ),
      updated: await db.all<{ id: number; title: string }>(
        "SELECT DISTINCT i.id, i.title FROM review_items r JOIN ideas i ON i.id = r.idea_id WHERE r.kind = 'auto_linked' AND r.created_at >= ?",
        sinceIso,
      ),
      recordings: (await db.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM recordings WHERE created_at >= ? AND deleted_at IS NULL", sinceIso))?.n ?? 0,
      openReview: (await db.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM review_items WHERE status = 'open'"))?.n ?? 0,
      waiting: await db.all("SELECT q.id, q.text, i.id AS idea_id, i.title FROM questions q JOIN ideas i ON i.id = q.idea_id WHERE q.status = 'asked'"),
      dueTasks: await db.all(
        `SELECT t.id, t.title, t.due_date, p.name AS project FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.status != 'done' AND t.due_date IS NOT NULL AND t.due_date <= ? ORDER BY t.due_date`,
        today,
      ),
      completed: await db.all<{ id: number; title: string }>("SELECT id, title FROM tasks WHERE status = 'done' AND completed_at >= ?", sinceIso),
    };
  }

  async digest(kind: "daily" | "weekly") {
    const db = this.db;
    const end = new Date();
    const start = new Date(end.getTime() - (kind === "daily" ? 1 : 7) * 86400_000);
    const data = await this.collect(nowText(start));
    const quiet = !data.recordings && !data.newIdeas.length && !data.dueTasks.length && !data.openReview;
    let text: DigestText | null = null;
    let insights: Insights | null = null;
    if (this.ai.llm && !quiet) {
      if (kind === "weekly") insights = await this.insights().catch(() => null);
      text = await this.ai.llm.json(DigestText, {
        purpose: "digest",
        system: await baseSystem(db),
        context: await sharedContext(db),
        effort: "low",
        prompt: `Write the ${kind} digest for the admin: a specific headline, a short overview paragraph, and up to 5 "attention" items - the things most worth their time next, each tied to an idea id when relevant. Be concrete; do not repeat the raw lists back.

<data>
${JSON.stringify(data, null, 1)}
</data>
${insights ? `<insights>\n${JSON.stringify(insights, null, 1)}\n</insights>` : ""}`,
      });
    }
    const content = { ...data, text, insights, quiet };
    await db.run(
      `INSERT INTO digests (kind, period_start, period_end, content) VALUES (?, ?, ?, ?)
       ON CONFLICT (kind, period_start) DO UPDATE SET content = excluded.content, period_end = excluded.period_end`,
      kind,
      nowText(start).slice(0, 10),
      nowText(end),
      JSON.stringify(content),
    );
    if (quiet) return;
    const title = text?.headline ?? `${kind === "daily" ? "Daily" : "Weekly"} digest: ${data.newIdeas.length} new ideas`;
    const emailBody = [
      text?.overview ?? "",
      "",
      `${data.newIdeas.length} new ideas, ${data.updated.length} updated, ${data.openReview} waiting for review.`,
      ...(text?.attention ?? []).map((a) => `• ${a.text}`),
    ].join("\n");
    await notifyRole(db, "organizer", { title, body: `${data.openReview} items to review`, url: "#/digests" }, { email: emailBody });
  }

  // Looks across recent ideas for patterns, conflicts, combinations and themes.
  async insights(): Promise<Insights | null> {
    const db = this.db;
    if (!this.ai.llm) return null;
    const ideas = await db.all<{ id: number; title: string; summary: string; status: string; commitment: string; created_at: string }>(
      "SELECT id, title, summary, status, commitment, created_at FROM ideas WHERE status != 'archived' ORDER BY last_activity_at DESC LIMIT 150",
    );
    if (ideas.length < 3) return null;
    const result = await this.ai.llm.json(Insights, {
      purpose: "insights",
      system: await baseSystem(db),
      context: await sharedContext(db),
      deep: true,
      effort: "medium",
      prompt: `Look across all of these ideas and help the admin see the bigger picture.
- patterns: recurring opportunities, problems or obsessions in his thinking (only real ones, with the ideas that show them)
- promising: up to 5 ideas that most deserve evaluation now, with a specific reason
- conflicts: ideas that compete for the same time/money or contradict each other
- combinations: compatible ideas that would be stronger together, with a concrete proposal
- themes: group the ideas into 3-12 broad themes; every idea should belong to the best-fitting theme
Use only the idea ids listed.

<ideas>
${ideas.map((i) => `#${i.id} [${i.status}, ${i.commitment}, ${i.created_at.slice(0, 10)}] ${i.title}: ${i.summary}`).join("\n")}
</ideas>`,
    });
    const valid = new Set(ideas.map((i) => i.id));
    const keep = (ids: number[]) => ids.filter((id) => valid.has(id));
    await db.tx(async (t) => {
      await t.run("UPDATE ideas SET theme_id = NULL");
      await t.run("DELETE FROM themes");
      for (const th of result.themes) {
        const themeId = await t.insert("INSERT INTO themes (name, description) VALUES (?, ?)", th.name, th.description);
        for (const id of keep(th.idea_ids)) await t.run("UPDATE ideas SET theme_id = ? WHERE id = ?", themeId, id);
      }
      for (const c of result.conflicts) {
        const ids = keep(c.idea_ids);
        if (ids.length < 2) continue;
        const linkId = await addLink(t, ids[0], ids[1], "conflicts", { confidence: 0.7, reason: c.explanation });
        if (linkId && !(await t.get("SELECT 1 FROM review_items WHERE link_id = ?", linkId))) {
          await addReview(t, { kind: "conflict", ideaId: ids[0], otherIdeaId: ids[1], linkId, note: c.explanation });
        }
      }
      for (const c of result.combinations) {
        const ids = keep(c.idea_ids);
        if (ids.length < 2) continue;
        const linkId = await addLink(t, ids[0], ids[1], "combines", { confidence: 0.7, reason: c.proposal });
        if (linkId && !(await t.get("SELECT 1 FROM review_items WHERE link_id = ?", linkId))) {
          await addReview(t, { kind: "possible_link", ideaId: ids[0], otherIdeaId: ids[1], linkId, note: c.proposal });
        }
      }
    });
    await setSetting(db, "insights", { at: nowText(), result });
    return result;
  }

  // ---------------------------------------------------------------- reminders
  async reminders() {
    const db = this.db;
    const today = localParts(await this.tz()).date;
    const overdue = await db.all<{ id: number; title: string; due_date: string; assignee_id: number | null }>(
      `SELECT id, title, due_date, assignee_id FROM tasks
       WHERE status != 'done' AND due_date IS NOT NULL AND due_date <= ? AND (reminded_at IS NULL OR substr(reminded_at, 1, 10) < ?)`,
      today,
      today,
    );
    const byUser = new Map<number | null, typeof overdue>();
    for (const t of overdue) byUser.set(t.assignee_id, [...(byUser.get(t.assignee_id) ?? []), t]);
    for (const [userId, tasks] of byUser) {
      const lines = tasks.map((t) => `${t.title} (due ${t.due_date})`);
      const note = { title: tasks.length === 1 ? `Due: ${tasks[0].title}` : `${tasks.length} tasks due or overdue`, body: lines.slice(0, 3).join("\n"), url: "#/tasks" };
      if (userId) await notifyUser(db, userId, note, { email: lines.join("\n") });
      else await notifyRole(db, "organizer", note, { email: lines.join("\n") });
    }
    for (const t of overdue) await db.run("UPDATE tasks SET reminded_at = now_text() WHERE id = ?", t.id);
  }

  // ---------------------------------------------------------- storage (1 GB free)
  async storageUsage() {
    const r = await this.db.get<{ audio: number; files: number }>(
      `SELECT (SELECT COALESCE(SUM(size_bytes), 0) FROM recordings WHERE audio_path IS NOT NULL)::float AS audio,
              (SELECT COALESCE(SUM(size_bytes), 0) FROM attachments WHERE path IS NOT NULL)::float AS files`,
    );
    const trashFiles = await this.db.all<{ data: string }>("SELECT data FROM trash WHERE entity = 'attachment'");
    const trashBytes = trashFiles.reduce((n, t) => n + (Number(JSON.parse(t.data).size_bytes) || 0), 0);
    const used = (r?.audio ?? 0) + (r?.files ?? 0) + trashBytes;
    return { used, limit: config.storageLimitMb * 1024 * 1024 };
  }

  // When storage gets close to the free limit, the oldest audio of processed
  // recordings is removed. Transcripts, quotes and ideas are kept.
  async storageCleanup() {
    const db = this.db;
    let { used, limit } = await this.storageUsage();
    if (used < limit * 0.9) return;
    const target = limit * 0.75;
    const oldest = await db.all<{ id: number; audio_path: string; size_bytes: number | null }>(
      `SELECT id, audio_path, size_bytes FROM recordings
       WHERE audio_path IS NOT NULL AND status = 'done' AND transcript IS NOT NULL ORDER BY captured_at LIMIT 500`,
    );
    let removed = 0;
    for (const r of oldest) {
      if (used <= target) break;
      await storage().remove("audio", [r.audio_path]);
      await db.run("UPDATE recordings SET audio_path = NULL, audio_removed_at = now_text() WHERE id = ?", r.id);
      used -= r.size_bytes ?? 0;
      removed++;
    }
    if (removed) {
      await logActivity(db, null, "storage_cleanup", undefined, undefined, `${removed} old audio files removed; transcripts kept`);
      await notifyRole(db, "organizer", {
        title: "Storage tidied up",
        body: `To stay within the free 1 GB, the audio of the ${removed} oldest recordings was removed. Their transcripts and ideas are kept.`,
        url: "#/settings",
      });
    }
  }

  async ideaTitle(id: number) {
    return (await getIdea(this.db, id))?.title;
  }
}
