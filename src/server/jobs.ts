import { AIError } from "./ai/llm.js";
import type { DB } from "./db.js";
import { now } from "./db.js";

// A small persistent job queue. Jobs survive restarts; transient failures
// (network, rate limits) retry with backoff; permanent failures are recorded
// so the UI can show what went wrong and offer a retry button.

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

const BACKOFF_SEC = [20, 60, 300, 1800, 3600, 3 * 3600];
const MAX_ATTEMPTS = BACKOFF_SEC.length + 1;
const SERIAL = new Set(["process_recording", "move_fragment", "insights"]);

export class JobQueue {
  private handlers = new Map<string, JobHandler>();
  private failHooks = new Map<string, (payload: Record<string, unknown>, error: string) => void>();
  private running = 0;
  private timer: NodeJS.Timeout | null = null;
  private idleWaiters: (() => void)[] = [];

  constructor(
    private db: DB,
    private concurrency = 2,
  ) {
    // Anything that was mid-flight when the server stopped gets picked up again.
    db.prepare("UPDATE jobs SET status = 'pending' WHERE status = 'running'").run();
  }

  register(type: string, handler: JobHandler, onFinalFailure?: (payload: Record<string, unknown>, error: string) => void) {
    this.handlers.set(type, handler);
    if (onFinalFailure) this.failHooks.set(type, onFinalFailure);
  }

  // Adds a job unless an identical one is already waiting.
  enqueue(type: string, payload: Record<string, unknown> = {}, delaySec = 0): number {
    const body = JSON.stringify(payload);
    const existing = this.db
      .prepare("SELECT id FROM jobs WHERE type = ? AND payload = ? AND status = 'pending'")
      .get(type, body) as { id: number } | undefined;
    if (existing) return existing.id;
    const runAt = new Date(Date.now() + delaySec * 1000).toISOString().replace("T", " ").slice(0, 19);
    const id = Number(
      this.db.prepare("INSERT INTO jobs (type, payload, run_at) VALUES (?, ?, ?)").run(type, body, runAt).lastInsertRowid,
    );
    setImmediate(() => this.tick());
    return id;
  }

  start(intervalMs = 1000) {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  pending(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('pending','running')").get() as { n: number }).n;
  }

  // Resolves once no job is pending or running (used by tests).
  async idle(timeoutMs = 20000): Promise<void> {
    const start = Date.now();
    while (this.pendingNow() > 0 || this.running > 0) {
      if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for jobs");
      await this.tick();
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  private pendingNow(): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending' AND run_at <= ?")
        .get(now()) as { n: number }
    ).n;
  }

  async tick(): Promise<void> {
    while (this.running < this.concurrency) {
      const job = this.claim();
      if (!job) break;
      this.running++;
      this.execute(job).finally(() => {
        this.running--;
        if (this.running === 0) this.idleWaiters.splice(0).forEach((f) => f());
        setImmediate(() => this.tick());
      });
    }
  }

  private claim(): { id: number; type: string; payload: string; attempts: number } | null {
    return this.db.transaction(() => {
      // Some job types must run one at a time (e.g. recordings, so two thoughts
      // about the same new idea can't both create it simultaneously).
      const busy = (
        this.db.prepare("SELECT DISTINCT type FROM jobs WHERE status = 'running'").all() as { type: string }[]
      )
        .map((r) => r.type)
        .filter((t) => SERIAL.has(t));
      const job = this.db
        .prepare(
          `SELECT id, type, payload, attempts FROM jobs WHERE status = 'pending' AND run_at <= ?
           ${busy.length ? `AND type NOT IN (${busy.map(() => "?").join(",")})` : ""} ORDER BY run_at, id LIMIT 1`,
        )
        .get(now(), ...busy) as { id: number; type: string; payload: string; attempts: number } | undefined;
      if (!job) return null;
      this.db
        .prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = datetime('now') WHERE id = ?")
        .run(job.id);
      return job;
    })();
  }

  private async execute(job: { id: number; type: string; payload: string; attempts: number }) {
    const handler = this.handlers.get(job.type);
    const payload = JSON.parse(job.payload) as Record<string, unknown>;
    try {
      if (!handler) throw new AIError(`No handler for job type ${job.type}`, false);
      await handler(payload);
      this.db.prepare("UPDATE jobs SET status = 'done', last_error = NULL, updated_at = datetime('now') WHERE id = ?").run(job.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const retryable = err instanceof AIError ? err.retryable : true;
      const attempts = job.attempts + 1;
      console.warn(`[job ${job.id} ${job.type}] attempt ${attempts} failed: ${message}`);
      if (retryable && attempts < MAX_ATTEMPTS) {
        const delay = BACKOFF_SEC[attempts - 1];
        const runAt = new Date(Date.now() + delay * 1000).toISOString().replace("T", " ").slice(0, 19);
        this.db
          .prepare("UPDATE jobs SET status = 'pending', run_at = ?, last_error = ?, updated_at = datetime('now') WHERE id = ?")
          .run(runAt, message, job.id);
      } else {
        this.db.prepare("UPDATE jobs SET status = 'failed', last_error = ?, updated_at = datetime('now') WHERE id = ?").run(message, job.id);
        try {
          this.failHooks.get(job.type)?.(payload, message);
        } catch (hookErr) {
          console.error("[jobs] failure hook threw", hookErr);
        }
      }
    }
  }
}
