import fs from "node:fs";
import { createAI, aiStatus } from "./ai/index.js";
import { buildApp, type Ctx } from "./app.js";
import { registerDeliverableJob } from "./assistant.js";
import { config } from "./config.js";
import { openDb, type DB } from "./db.js";
import { JobQueue } from "./jobs.js";
import { initPush } from "./notify.js";
import { Periodic } from "./periodic.js";
import { Pipeline } from "./pipeline.js";

export async function createServer(db: DB = openDb(), opts: { background?: boolean } = {}) {
  for (const dir of [config.audioDir, config.filesDir, config.backupDir]) fs.mkdirSync(dir, { recursive: true });
  const ai = createAI(db);
  const jobs = new JobQueue(db);
  const pipeline = new Pipeline(db, ai, jobs);
  const periodic = new Periodic(db, ai, jobs);
  registerDeliverableJob(db, ai, jobs);
  const ctx: Ctx = { db, ai, jobs, pipeline, periodic, vapidPublicKey: initPush(db) };
  const app = await buildApp(ctx);
  // Recordings that failed only because a service wasn't configured yet are
  // picked up again automatically once it is.
  if (ai.llm) {
    const stuck = db
      .prepare("SELECT id FROM recordings WHERE status = 'failed' AND (error LIKE '%not set up%' OR error LIKE '%configured%' OR error LIKE '%API key%')")
      .all() as { id: number }[];
    for (const r of stuck) {
      db.prepare("UPDATE recordings SET status = 'queued', error = NULL WHERE id = ?").run(r.id);
      jobs.enqueue("process_recording", { recordingId: r.id });
    }
  }
  if (opts.background !== false) {
    jobs.start();
    periodic.start();
  }
  return { app, ctx };
}

async function main() {
  const { app, ctx } = await createServer();
  const status = aiStatus();
  console.log(`Idea Bridge listening on ${config.publicUrl} (port ${config.port})`);
  console.log(
    `AI: understanding=${status.understanding ? "on" : "OFF (set ANTHROPIC_API_KEY)"}, transcription=${status.transcription ?? "OFF (set ELEVENLABS_API_KEY or OPENAI_API_KEY)"}, meaning search=${status.semanticSearch ? "on" : "off"}`,
  );
  await app.listen({ port: config.port, host: config.host });
  const shutdown = async () => {
    ctx.jobs.stop();
    ctx.periodic.stop();
    await app.close();
    ctx.db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop()!)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
