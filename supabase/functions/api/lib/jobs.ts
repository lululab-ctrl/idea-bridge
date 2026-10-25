import { AIError } from "./ai/llm.ts";
import type { DB } from "./db.ts";
import { nowText } from "./db.ts";

// Persistent job queue processed by one worker at a time. Each wake-up (the
// once-a-minute scheduler, or a person using the app) works through jobs for up
// to ~100 seconds, staying inside the platform's per-run time limit. Jobs left
// half-done by an interrupted run are picked up again.

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;
type FailHook = (payload: Record<string, unknown>, error: string) => Promise<void>;

const BACKOFF_SEC = [30, 120, 600, 1800, 3600, 3 * 3600];
const MAX_ATTEMPTS = BACKOFF_SEC.length + 1;
const STALE_RUNNING_SEC = 300;

const at = (secFromNow: number) => nowText(new Date(Date.now() + secFromNow * 1000));

export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private failHooks = new Map<string, FailHook>();

  constructor(private db: DB) {}

  register(type: string, handler: JobHandler, onFinalFailure?: FailHook) {
    this.handlers.set(type, handler);
    if (onFinalFailure) this.failHooks.set(type, onFinalFailure);
  }

  // Adds a job unless an identical one is already waiting.
  async enqueue(type: string, payload: Record<string, unknown> = {}, delaySec = 0): Promise<number> {
    const body = JSON.stringify(payload);
    const existing = await this.db.get<{ id: number }>(
      "SELECT id FROM jobs WHERE type = ? AND payload = ? AND status = 'pending'",
      type,
      body,
    );
    if (existing) return existing.id;
    return this.db.insert("INSERT INTO jobs (type, payload, run_at) VALUES (?, ?, ?)", type, body, at(delaySec));
  }

  async pending(): Promise<number> {
    const r = await this.db.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM jobs WHERE status IN ('pending','running')");
    return r?.n ?? 0;
  }

  async dueNow(): Promise<number> {
    const r = await this.db.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM jobs WHERE status = 'pending' AND run_at <= ?", nowText());
    return r?.n ?? 0;
  }

  // Works through due jobs until none are left or the time budget is spent.
  async drain(budgetMs = 100_000): Promise<number> {
    const started = Date.now();
    const holder = crypto.randomUUID();
    const leaseSec = Math.ceil(budgetMs / 1000) + 40;
    const got = await this.db.get(
      "UPDATE worker_lease SET holder = ?, until = ? WHERE id = 1 AND (until < ? OR holder = ?) RETURNING id",
      holder,
      at(leaseSec),
      nowText(),
      holder,
    );
    if (!got) return 0; // another worker is busy
    let done = 0;
    try {
      await this.db.run(
        "UPDATE jobs SET status = 'pending', updated_at = now_text() WHERE status = 'running' AND updated_at < ?",
        at(-STALE_RUNNING_SEC),
      );
      while (Date.now() - started < budgetMs) {
        const job = await this.claim();
        if (!job) break;
        await this.execute(job);
        done++;
      }
    } finally {
      await this.db.run("UPDATE worker_lease SET until = ? WHERE id = 1 AND holder = ?", at(-1), holder);
    }
    return done;
  }

  private claim(): Promise<{ id: number; type: string; payload: string; attempts: number } | undefined> {
    return this.db.tx(async (t) => {
      const job = await t.get<{ id: number; type: string; payload: string; attempts: number }>(
        "SELECT id, type, payload, attempts FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at, id LIMIT 1 FOR UPDATE SKIP LOCKED",
        nowText(),
      );
      if (!job) return undefined;
      await t.run("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = now_text() WHERE id = ?", job.id);
      return job;
    });
  }

  private async execute(job: { id: number; type: string; payload: string; attempts: number }) {
    const handler = this.handlers.get(job.type);
    const payload = JSON.parse(job.payload) as Record<string, unknown>;
    try {
      if (!handler) throw new AIError(`No handler for job type ${job.type}`, false);
      await handler(payload);
      await this.db.run("UPDATE jobs SET status = 'done', last_error = NULL, updated_at = now_text() WHERE id = ?", job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = job.attempts + 1;
      console.warn(`[job ${job.id} ${job.type}] attempt ${attempts} failed: ${message}`);
      if (err instanceof AIError && err.deferSec > 0) {
        // Waiting for a limit to reset does not use up a retry.
        await this.db.run(
          "UPDATE jobs SET status = 'pending', attempts = attempts - 1, run_at = ?, last_error = ?, updated_at = now_text() WHERE id = ?",
          at(err.deferSec),
          message,
          job.id,
        );
        return;
      }
      const retryable = err instanceof AIError ? err.retryable : true;
      if (retryable && attempts < MAX_ATTEMPTS) {
        await this.db.run(
          "UPDATE jobs SET status = 'pending', run_at = ?, last_error = ?, updated_at = now_text() WHERE id = ?",
          at(BACKOFF_SEC[attempts - 1]),
          message,
          job.id,
        );
      } else {
        await this.db.run("UPDATE jobs SET status = 'failed', last_error = ?, updated_at = now_text() WHERE id = ?", message, job.id);
        try {
          await this.failHooks.get(job.type)?.(payload, message);
        } catch (hookErr) {
          console.error("[jobs] failure hook threw", hookErr);
        }
      }
    }
  }
}
