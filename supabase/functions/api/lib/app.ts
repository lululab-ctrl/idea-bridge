import { type AI, createAI } from "./ai/index.ts";
import { registerDeliverableJob } from "./assistant.ts";
import type { DB } from "./db.ts";
import { JobQueue } from "./jobs.ts";
import { Periodic } from "./periodic.ts";
import { Pipeline } from "./pipeline.ts";

export interface App {
  db: DB;
  ai: AI;
  jobs: JobQueue;
  pipeline: Pipeline;
  periodic: Periodic;
}

export function createApp(db: DB): App {
  const ai = createAI(db);
  const jobs = new JobQueue(db);
  const pipeline = new Pipeline(db, ai, jobs);
  const periodic = new Periodic(db, ai, jobs);
  registerDeliverableJob(db, ai, jobs);
  return { db, ai, jobs, pipeline, periodic };
}
