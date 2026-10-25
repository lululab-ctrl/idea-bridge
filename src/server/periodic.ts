import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { AI } from "./ai/index.js";
import { baseSystem, sharedContext } from "./ai/prompts.js";
import { DigestText, Insights } from "./ai/schemas.js";
import { config } from "./config.js";
import type { DB } from "./db.js";
import { getSetting, setSetting } from "./db.js";
import { addLink, addReview } from "./ideas.js";
import type { JobQueue } from "./jobs.js";
import { notifyRole, notifyUser } from "./notify.js";

// Time-based work: daily/weekly digests, pattern finding, deadline reminders
// and backups. A one-minute timer checks what is due in the household's time zone.

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

const sqlTime = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

export class Periodic {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private db: DB,
    private ai: AI,
    private jobs: JobQueue,
  ) {
    jobs.register("daily_digest", () => this.digest("daily"));
    jobs.register("weekly_digest", () => this.digest("weekly"));
    jobs.register("insights", () => this.insights().then(() => undefined));
    jobs.register("backup", () => this.backup().then(() => undefined));
    jobs.register("reminders", () => this.reminders());
  }

  start() {
    this.timer = setInterval(() => this.check(), 60_000);
    setTimeout(() => this.check(), 5_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  tz(): string {
    return getSetting(this.db, "timezone", config.timezone);
  }

  check() {
    const { date, hour, weekday } = localParts(this.tz());
    const digestHour = getSetting(this.db, "digest_hour", 7);
    const ran = getSetting<Record<string, string>>(this.db, "periodic_ran", {});
    const due = (key: string, atHour: number) => hour >= atHour && ran[key] !== date;
    const mark = (key: string) => {
      ran[key] = date;
      setSetting(this.db, "periodic_ran", ran);
    };
    if (due("daily", digestHour)) {
      mark("daily");
      this.jobs.enqueue("daily_digest");
      this.jobs.enqueue("reminders");
    }
    if (weekday === "Mon" && due("weekly", digestHour)) {
      mark("weekly");
      this.jobs.enqueue("weekly_digest");
    }
    if (due("backup", 3)) {
      mark("backup");
      this.jobs.enqueue("backup");
    }
  }

  // ------------------------------------------------------------------ digests

  collect(sinceIso: string) {
    const db = this.db;
    const newIdeas = db
      .prepare("SELECT id, title, summary, commitment, clarity FROM ideas WHERE created_at >= ? AND status != 'archived' ORDER BY id")
      .all(sinceIso) as { id: number; title: string; summary: string; commitment: string; clarity: number }[];
    const updated = db
      .prepare(
        `SELECT DISTINCT i.id, i.title FROM review_items r JOIN ideas i ON i.id = r.idea_id
         WHERE r.kind = 'auto_linked' AND r.created_at >= ?`,
      )
      .all(sinceIso) as { id: number; title: string }[];
    const recordings = (db.prepare("SELECT COUNT(*) AS n FROM recordings WHERE created_at >= ?").get(sinceIso) as { n: number }).n;
    const openReview = (db.prepare("SELECT COUNT(*) AS n FROM review_items WHERE status = 'open'").get() as { n: number }).n;
    const waiting = db
      .prepare("SELECT q.id, q.text, i.id AS idea_id, i.title FROM questions q JOIN ideas i ON i.id = q.idea_id WHERE q.status = 'asked'")
      .all() as { id: number; text: string; idea_id: number; title: string }[];
    const today = localParts(this.tz()).date;
    const dueTasks = db
      .prepare(
        `SELECT t.id, t.title, t.due_date, p.name AS project FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
         WHERE t.status != 'done' AND t.due_date IS NOT NULL AND t.due_date <= ? ORDER BY t.due_date`,
      )
      .all(today) as { id: number; title: string; due_date: string; project: string | null }[];
    const completed = db
      .prepare("SELECT id, title FROM tasks WHERE status = 'done' AND completed_at >= ?")
      .all(sinceIso) as { id: number; title: string }[];
    return { newIdeas, updated, recordings, openReview, waiting, dueTasks, completed };
  }

  async digest(kind: "daily" | "weekly") {
    const db = this.db;
    const end = new Date();
    const start = new Date(end.getTime() - (kind === "daily" ? 1 : 7) * 86400_000);
    const data = this.collect(sqlTime(start));
    const quiet = !data.recordings && !data.newIdeas.length && !data.dueTasks.length && !data.openReview;
    let text: DigestText | null = null;
    let insights: Insights | null = null;
    if (this.ai.llm && !quiet) {
      if (kind === "weekly") insights = await this.insights().catch(() => null);
      text = await this.ai.llm.json(DigestText, {
        purpose: "digest",
        system: baseSystem(db),
        context: sharedContext(db),
        effort: "low",
        prompt: `Write the ${kind} digest for the organizer: a specific headline, a short overview paragraph, and up to 5 "attention" items - the things most worth their time next, each tied to an idea id when relevant. Be concrete; do not repeat the raw lists back.

<data>
${JSON.stringify(data, null, 1)}
</data>
${insights ? `<insights>\n${JSON.stringify(insights, null, 1)}\n</insights>` : ""}`,
      });
    }
    const content = { ...data, text, insights, quiet };
    db.prepare(
      `INSERT INTO digests (kind, period_start, period_end, content) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, period_start) DO UPDATE SET content = excluded.content, period_end = excluded.period_end`,
    ).run(kind, sqlTime(start).slice(0, 10), sqlTime(end), JSON.stringify(content));
    if (quiet) return;
    const title = text?.headline ?? `${kind === "daily" ? "Daily" : "Weekly"} digest: ${data.newIdeas.length} new ideas`;
    const emailBody = [
      text?.overview ?? "",
      "",
      `${data.newIdeas.length} new ideas, ${data.updated.length} updated, ${data.openReview} waiting for review.`,
      ...(text?.attention ?? []).map((a) => `• ${a.text}`),
    ].join("\n");
    notifyRole(db, "organizer", { title, body: `${data.openReview} items to review`, url: "#/digests" }, { email: emailBody });
  }

  // Looks across recent ideas for patterns, conflicts, combinations and themes.
  async insights(): Promise<Insights | null> {
    const db = this.db;
    if (!this.ai.llm) return null;
    const ideas = db
      .prepare(
        `SELECT id, title, summary, status, commitment, created_at FROM ideas WHERE status != 'archived'
         ORDER BY last_activity_at DESC LIMIT 150`,
      )
      .all() as { id: number; title: string; summary: string; status: string; commitment: string; created_at: string }[];
    if (ideas.length < 3) return null;
    const result = await this.ai.llm.json(Insights, {
      purpose: "insights",
      system: baseSystem(db),
      context: sharedContext(db),
      effort: "high",
      prompt: `Look across all of these ideas and help the organizer see the bigger picture.
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
    db.transaction(() => {
      db.prepare("UPDATE ideas SET theme_id = NULL").run();
      db.prepare("DELETE FROM themes").run();
      for (const t of result.themes) {
        const themeId = Number(db.prepare("INSERT INTO themes (name, description) VALUES (?, ?)").run(t.name, t.description).lastInsertRowid);
        const upd = db.prepare("UPDATE ideas SET theme_id = ? WHERE id = ?");
        for (const id of keep(t.idea_ids)) upd.run(themeId, id);
      }
      for (const c of result.conflicts) {
        const ids = keep(c.idea_ids);
        if (ids.length < 2) continue;
        const linkId = addLink(db, ids[0], ids[1], "conflicts", { confidence: 0.7, reason: c.explanation });
        if (linkId && !db.prepare("SELECT 1 FROM review_items WHERE link_id = ?").get(linkId)) {
          addReview(db, { kind: "conflict", ideaId: ids[0], otherIdeaId: ids[1], linkId, note: c.explanation });
        }
      }
      for (const c of result.combinations) {
        const ids = keep(c.idea_ids);
        if (ids.length < 2) continue;
        const linkId = addLink(db, ids[0], ids[1], "combines", { confidence: 0.7, reason: c.proposal });
        if (linkId && !db.prepare("SELECT 1 FROM review_items WHERE link_id = ?").get(linkId)) {
          addReview(db, { kind: "possible_link", ideaId: ids[0], otherIdeaId: ids[1], linkId, note: c.proposal });
        }
      }
    })();
    setSetting(db, "insights", { at: sqlTime(new Date()), result });
    return result;
  }

  // ---------------------------------------------------------------- reminders

  async reminders() {
    const db = this.db;
    const today = localParts(this.tz()).date;
    const overdue = db
      .prepare(
        `SELECT t.id, t.title, t.due_date, t.assignee_id FROM tasks t
         WHERE t.status != 'done' AND t.due_date IS NOT NULL AND t.due_date <= ?
           AND (t.reminded_at IS NULL OR substr(t.reminded_at, 1, 10) < ?)`,
      )
      .all(today, today) as { id: number; title: string; due_date: string; assignee_id: number | null }[];
    const byUser = new Map<number | null, typeof overdue>();
    for (const t of overdue) byUser.set(t.assignee_id, [...(byUser.get(t.assignee_id) ?? []), t]);
    for (const [userId, tasks] of byUser) {
      const lines = tasks.map((t) => `${t.title} (due ${t.due_date})`);
      const note = {
        title: tasks.length === 1 ? `Due: ${tasks[0].title}` : `${tasks.length} tasks due or overdue`,
        body: lines.slice(0, 3).join("\n"),
        url: "#/tasks",
      };
      if (userId) await notifyUser(db, userId, note, { email: lines.join("\n") });
      else notifyRole(db, "organizer", note, { email: lines.join("\n") });
    }
    const mark = db.prepare("UPDATE tasks SET reminded_at = datetime('now') WHERE id = ?");
    for (const t of overdue) mark.run(t.id);
  }

  // ------------------------------------------------------------------ backups

  async backup(): Promise<string> {
    fs.mkdirSync(config.backupDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const file = path.join(config.backupDir, `ideabridge-${stamp}.db`);
    await this.db.backup(file);
    const gz = `${file}.gz`;
    fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(file)));
    fs.unlinkSync(file);
    // Keep the last N days of local snapshots.
    const cutoff = Date.now() - config.backupKeepDays * 86400_000;
    for (const f of fs.readdirSync(config.backupDir)) {
      const full = path.join(config.backupDir, f);
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
    }
    await this.offsite(gz);
    setSetting(this.db, "last_backup", { at: sqlTime(new Date()), file: path.basename(gz), offsite: !!s3() });
    return gz;
  }

  private async offsite(snapshot: string) {
    const client = s3();
    if (!client) return;
    const put = (key: string, body: Buffer, type: string) =>
      client.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, Body: body, ContentType: type }));
    await put(`db/${path.basename(snapshot)}`, fs.readFileSync(snapshot), "application/gzip");
    // Audio and attachments never change, so each file is uploaded once.
    const audio = this.db.prepare("SELECT id, audio_path, mime FROM recordings WHERE backed_up = 0 AND audio_path IS NOT NULL").all() as {
      id: number;
      audio_path: string;
      mime: string;
    }[];
    for (const a of audio) {
      if (!fs.existsSync(a.audio_path)) continue;
      await put(`audio/${path.basename(a.audio_path)}`, fs.readFileSync(a.audio_path), a.mime ?? "application/octet-stream");
      this.db.prepare("UPDATE recordings SET backed_up = 1 WHERE id = ?").run(a.id);
    }
    const files = this.db.prepare("SELECT id, path, mime FROM attachments WHERE backed_up = 0 AND path IS NOT NULL").all() as {
      id: number;
      path: string;
      mime: string;
    }[];
    for (const f of files) {
      if (!fs.existsSync(f.path)) continue;
      await put(`files/${path.basename(f.path)}`, fs.readFileSync(f.path), f.mime ?? "application/octet-stream");
      this.db.prepare("UPDATE attachments SET backed_up = 1 WHERE id = ?").run(f.id);
    }
  }
}

let s3client: S3Client | null | undefined;
function s3(): S3Client | null {
  if (s3client !== undefined) return s3client;
  s3client =
    config.s3Bucket && config.s3AccessKey && config.s3SecretKey
      ? new S3Client({
          region: config.s3Region,
          endpoint: config.s3Endpoint || undefined,
          credentials: { accessKeyId: config.s3AccessKey, secretAccessKey: config.s3SecretKey },
        })
      : null;
  return s3client;
}

export function offsiteConfigured(): boolean {
  return !!(config.s3Bucket && config.s3AccessKey && config.s3SecretKey);
}
