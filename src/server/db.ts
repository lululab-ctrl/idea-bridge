import Database from "better-sqlite3";
import fs from "node:fs";
import { config } from "./config.js";

export type DB = Database.Database;

// Each migration runs once, in order, inside a transaction. Never edit a
// migration that has shipped; add a new one instead.
const migrations: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT,
    role TEXT NOT NULL DEFAULT 'organizer',      -- 'visionary' (records ideas) | 'organizer' (reviews)
    password_hash TEXT,
    home TEXT NOT NULL DEFAULT 'dashboard',      -- screen opened after sign-in: 'capture' | 'dashboard'
    notify_email INTEGER NOT NULL DEFAULT 1,
    notify_push INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  -- One-time sign-in links (e.g. to put the app on a phone without typing a password).
  CREATE TABLE login_links (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_by INTEGER REFERENCES users(id),
    expires_at TEXT NOT NULL,
    used_at TEXT
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Original recordings (and typed notes). Never modified after transcription
  -- except for status fields; never deleted except by an explicit user action.
  CREATE TABLE recordings (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    kind TEXT NOT NULL DEFAULT 'voice',          -- 'voice' | 'text'
    client_id TEXT UNIQUE,                       -- id generated on the phone, makes uploads idempotent
    audio_path TEXT,
    mime TEXT,
    size_bytes INTEGER,
    duration_sec REAL,
    captured_at TEXT NOT NULL,                   -- when he pressed record (phone clock)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    transcript TEXT,
    segments TEXT,                               -- JSON [{start,end,text}]
    language TEXT,
    status TEXT NOT NULL DEFAULT 'queued',       -- queued|transcribing|analyzing|done|failed
    error TEXT,
    question_id INTEGER,                         -- set when this recording answers a clarification question
    summary TEXT,                                -- one-line AI summary of the whole recording
    analysis TEXT,                               -- JSON extraction result (kept so retries don't re-run it)
    transcribed_by TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    backed_up INTEGER NOT NULL DEFAULT 0          -- audio copied to off-site backup
  );
  CREATE INDEX recordings_status ON recordings(status);
  CREATE INDEX recordings_captured ON recordings(captured_at);

  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',       -- active|on_hold|completed|archived
    priority TEXT NOT NULL DEFAULT 'medium',
    deadline TEXT,
    plan TEXT,                                   -- JSON AI-drafted plan awaiting acceptance
    plan_status TEXT,                            -- generating|draft|accepted|failed
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE themes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE ideas (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    card TEXT NOT NULL DEFAULT '{}',             -- JSON IdeaCard (structured understanding)
    status TEXT NOT NULL DEFAULT 'new',
    priority TEXT NOT NULL DEFAULT 'none',       -- none|low|medium|high|urgent
    commitment TEXT NOT NULL DEFAULT 'brainstorm', -- brainstorm|intention|decision (what HE expressed)
    clarity INTEGER NOT NULL DEFAULT 3,          -- 1 (very unclear) .. 5 (crystal clear)
    project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    theme_id INTEGER REFERENCES themes(id) ON DELETE SET NULL,
    score TEXT,                                  -- JSON evaluation, see ai/schemas.ts
    report TEXT,                                 -- JSON full report
    report_version INTEGER,                      -- idea version the report was generated from
    score_version INTEGER,
    busy TEXT,                                   -- set while the AI is working on it: 'report'|'score'|'plan'|'card'
    version INTEGER NOT NULL DEFAULT 1,
    deadline TEXT,
    last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX ideas_status ON ideas(status);

  CREATE TABLE tags (
    idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (idea_id, tag)
  );

  -- A single thought extracted from a recording. Points at the exact words.
  CREATE TABLE fragments (
    id INTEGER PRIMARY KEY,
    recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
    origin_idea_id INTEGER,                      -- idea it was first attached to (for undo)
    position INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    quote TEXT NOT NULL,                         -- his exact words for this thought
    start_sec REAL,
    end_sec REAL,
    summary TEXT NOT NULL,
    interpretation TEXT,
    kind TEXT NOT NULL DEFAULT 'idea',           -- idea|update|task|question|reflection
    commitment TEXT NOT NULL DEFAULT 'brainstorm',
    link_decision TEXT,                          -- JSON: what the AI decided and why
    clarity INTEGER,
    missing_info TEXT,                           -- JSON string[]
    answers_question INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX fragments_idea ON fragments(idea_id);
  CREATE INDEX fragments_recording ON fragments(recording_id);

  -- Full snapshot of an idea every time it changes.
  CREATE TABLE idea_versions (
    id INTEGER PRIMARY KEY,
    idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    card TEXT NOT NULL,
    change_summary TEXT NOT NULL,
    source TEXT NOT NULL,                        -- 'recording' | 'edit' | 'merge' | 'restore' | 'answer'
    source_id INTEGER,
    user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (idea_id, version)
  );

  CREATE TABLE links (
    id INTEGER PRIMARY KEY,
    idea_a INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
    idea_b INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
    type TEXT NOT NULL,                          -- related|duplicate|builds_on|conflicts|combines
    status TEXT NOT NULL DEFAULT 'suggested',    -- suggested|confirmed|dismissed
    confidence REAL,
    reason TEXT,
    created_by TEXT NOT NULL DEFAULT 'ai',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (idea_a, idea_b, type)
  );

  -- Everything that needs a human decision lands here, to be handled in batches.
  CREATE TABLE review_items (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,                          -- new_idea|auto_linked|possible_duplicate|possible_link|conflict|answer|plan
    idea_id INTEGER REFERENCES ideas(id) ON DELETE CASCADE,
    other_idea_id INTEGER REFERENCES ideas(id) ON DELETE CASCADE,
    fragment_id INTEGER REFERENCES fragments(id) ON DELETE CASCADE,
    link_id INTEGER REFERENCES links(id) ON DELETE CASCADE,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'open',         -- open|done
    resolution TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT,
    resolved_by INTEGER
  );
  CREATE INDEX review_open ON review_items(status);

  -- Clarification questions for the person who had the idea.
  CREATE TABLE questions (
    id INTEGER PRIMARY KEY,
    idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    why TEXT,
    status TEXT NOT NULL DEFAULT 'draft',        -- draft|asked|answered|dismissed
    asked_by INTEGER,
    asked_at TEXT,
    answer_recording_id INTEGER REFERENCES recordings(id),
    answer_text TEXT,
    answered_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
    milestone TEXT,
    title TEXT NOT NULL,
    instructions TEXT,
    expected_outcome TEXT,
    status TEXT NOT NULL DEFAULT 'todo',         -- todo|doing|done|blocked
    priority TEXT NOT NULL DEFAULT 'medium',
    assignee_id INTEGER REFERENCES users(id),
    due_date TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    completed_at TEXT,
    reminded_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX tasks_project ON tasks(project_id);

  CREATE TABLE notes (
    id INTEGER PRIMARY KEY,
    idea_id INTEGER REFERENCES ideas(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    idea_id INTEGER REFERENCES ideas(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                          -- file|link
    name TEXT NOT NULL,
    path TEXT,
    url TEXT,
    mime TEXT,
    size_bytes INTEGER,
    user_id INTEGER REFERENCES users(id),
    backed_up INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- What the AI should know about how you two talk and decide.
  CREATE TABLE memory (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,                          -- glossary|preference|correction
    term TEXT,
    body TEXT NOT NULL,
    source_idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
    user_id INTEGER,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE deliverables (
    id INTEGER PRIMARY KEY,
    idea_id INTEGER REFERENCES ideas(id) ON DELETE CASCADE,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    markdown TEXT NOT NULL,
    user_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE digests (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL,                          -- daily|weekly
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    content TEXT NOT NULL,                       -- JSON
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (kind, period_start)
  );

  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT,
    url TEXT,
    read_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    keys TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE embeddings (
    entity TEXT NOT NULL,                        -- 'idea' | 'fragment'
    entity_id INTEGER NOT NULL,
    model TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    vector BLOB NOT NULL,
    PRIMARY KEY (entity, entity_id)
  );

  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',      -- pending|running|done|failed
    attempts INTEGER NOT NULL DEFAULT 0,
    run_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX jobs_pending ON jobs(status, run_at);

  CREATE TABLE ai_usage (
    id INTEGER PRIMARY KEY,
    purpose TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    audio_seconds REAL NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id INTEGER,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX activity_entity ON activity(entity, entity_id);

  -- Full-text index over everything searchable. Maintained by search.ts.
  CREATE VIRTUAL TABLE search_fts USING fts5(
    entity UNINDEXED, entity_id UNINDEXED, title, body,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  `,
];

export function openDb(file = config.dbPath): DB {
  if (file !== ":memory:") {
    fs.mkdirSync(config.dataDir, { recursive: true });
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let i = current; i < migrations.length; i++) {
    db.transaction(() => {
      db.exec(migrations[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

export function now(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(db: DB, key: string, value: unknown) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(value));
}

export function logActivity(
  db: DB,
  userId: number | null,
  action: string,
  entity?: string,
  entityId?: number,
  detail?: string,
) {
  db.prepare("INSERT INTO activity (user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)").run(
    userId,
    action,
    entity ?? null,
    entityId ?? null,
    detail ?? null,
  );
}
