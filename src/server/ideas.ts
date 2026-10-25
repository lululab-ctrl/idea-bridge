import type { IdeaCard } from "./ai/schemas.js";
import type { DB } from "./db.js";
import { logActivity, now } from "./db.js";
import { indexIdea, safeJson } from "./search.js";

export const STATUSES = [
  "new",
  "needs_clarification",
  "under_review",
  "approved",
  "in_progress",
  "on_hold",
  "completed",
  "archived",
] as const;
export type Status = (typeof STATUSES)[number];
export const PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;

const COMMITMENT_RANK = { brainstorm: 0, intention: 1, decision: 2 } as const;
export type Commitment = keyof typeof COMMITMENT_RANK;

export interface StoredCard extends Partial<IdeaCard> {
  edited?: string[]; // fields the organizer corrected by hand (authoritative)
}

export interface IdeaRow {
  id: number;
  title: string;
  summary: string;
  card: string;
  status: Status;
  priority: string;
  commitment: Commitment;
  clarity: number;
  project_id: number | null;
  theme_id: number | null;
  score: string | null;
  report: string | null;
  report_version: number | null;
  score_version: number | null;
  busy: string | null;
  version: number;
  deadline: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
}

export function getIdea(db: DB, id: number): IdeaRow | undefined {
  return db.prepare("SELECT * FROM ideas WHERE id = ?").get(id) as IdeaRow | undefined;
}

export function clampClarity(n: number): number {
  return Math.max(1, Math.min(5, Math.round(Number.isFinite(n) ? n : 3)));
}

export function cleanTags(tags: string[]): string[] {
  const out = new Set<string>();
  for (const t of tags) {
    const v = t.trim().toLowerCase().replace(/^#/, "").replace(/\s+/g, "-").slice(0, 32);
    if (v) out.add(v);
  }
  return [...out].slice(0, 8);
}

export function setTags(db: DB, ideaId: number, tags: string[]) {
  db.prepare("DELETE FROM tags WHERE idea_id = ?").run(ideaId);
  const ins = db.prepare("INSERT OR IGNORE INTO tags (idea_id, tag) VALUES (?, ?)");
  for (const t of cleanTags(tags)) ins.run(ideaId, t);
}

export function strongerCommitment(a: Commitment, b: Commitment): Commitment {
  return COMMITMENT_RANK[b] > COMMITMENT_RANK[a] ? b : a;
}

function storedCard(card: IdeaCard, edited: string[] = []): StoredCard {
  const { change_summary: _c, ...rest } = card;
  return { ...rest, edited };
}

export function createIdea(
  db: DB,
  card: IdeaCard,
  opts: { source: string; sourceId?: number; userId?: number | null; status?: Status },
): number {
  return db.transaction(() => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO ideas (title, summary, card, status, commitment, clarity)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          card.title.trim() || "Untitled idea",
          card.summary,
          JSON.stringify(storedCard(card)),
          opts.status ?? "new",
          card.commitment,
          clampClarity(card.clarity),
        ).lastInsertRowid,
    );
    setTags(db, id, card.tags);
    db.prepare(
      `INSERT INTO idea_versions (idea_id, version, title, summary, card, change_summary, source, source_id, user_id)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, card.title, card.summary, JSON.stringify(storedCard(card)), "First captured.", opts.source, opts.sourceId ?? null, opts.userId ?? null);
    syncDraftQuestions(db, id, card);
    indexIdea(db, id);
    return id;
  })();
}

// Writes a new version of an idea's card, keeping hand-corrected fields.
export function applyCard(
  db: DB,
  ideaId: number,
  card: IdeaCard,
  opts: { source: string; sourceId?: number; userId?: number | null; changeSummary?: string },
) {
  db.transaction(() => {
    const idea = getIdea(db, ideaId);
    if (!idea) return;
    const prev = safeJson<StoredCard>(idea.card, {});
    const edited = prev.edited ?? [];
    const next: StoredCard = storedCard(card, edited);
    for (const f of edited) (next as Record<string, unknown>)[f] = (prev as Record<string, unknown>)[f];
    const version = idea.version + 1;
    const title = edited.includes("title") ? idea.title : card.title.trim() || idea.title;
    const summary = edited.includes("summary") ? idea.summary : card.summary;
    db.prepare(
      `UPDATE ideas SET title = ?, summary = ?, card = ?, clarity = ?, commitment = ?, version = ?,
         updated_at = datetime('now'), last_activity_at = datetime('now') WHERE id = ?`,
    ).run(
      title,
      summary,
      JSON.stringify(next),
      clampClarity(card.clarity),
      strongerCommitment(idea.commitment, card.commitment),
      version,
      ideaId,
    );
    if (!edited.includes("tags")) setTags(db, ideaId, card.tags);
    db.prepare(
      `INSERT INTO idea_versions (idea_id, version, title, summary, card, change_summary, source, source_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(ideaId, version, title, summary, JSON.stringify(next), opts.changeSummary ?? card.change_summary, opts.source, opts.sourceId ?? null, opts.userId ?? null);
    syncDraftQuestions(db, ideaId, card);
    indexIdea(db, ideaId);
  })();
}

// Manual edit by a person. Edited fields are remembered as authoritative so
// later AI updates don't overwrite the correction.
export function editIdea(
  db: DB,
  ideaId: number,
  changes: Partial<Record<keyof IdeaCard, unknown>>,
  userId: number,
): void {
  db.transaction(() => {
    const idea = getIdea(db, ideaId);
    if (!idea) return;
    const card = safeJson<StoredCard>(idea.card, {});
    const edited = new Set(card.edited ?? []);
    const names: string[] = [];
    for (const [k, v] of Object.entries(changes)) {
      if (v === undefined) continue;
      (card as Record<string, unknown>)[k] = v;
      edited.add(k);
      names.push(k.replace(/_/g, " "));
    }
    card.edited = [...edited];
    const title = typeof changes.title === "string" && changes.title.trim() ? changes.title.trim() : idea.title;
    const summary = typeof changes.summary === "string" ? changes.summary : idea.summary;
    const version = idea.version + 1;
    db.prepare(
      "UPDATE ideas SET title = ?, summary = ?, card = ?, version = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(title, summary, JSON.stringify(card), version, ideaId);
    if (Array.isArray(changes.tags)) setTags(db, ideaId, changes.tags as string[]);
    db.prepare(
      `INSERT INTO idea_versions (idea_id, version, title, summary, card, change_summary, source, user_id)
       VALUES (?, ?, ?, ?, ?, ?, 'edit', ?)`,
    ).run(ideaId, version, title, summary, JSON.stringify(card), `Corrected by hand: ${names.join(", ")}.`, userId);
    indexIdea(db, ideaId);
    logActivity(db, userId, "edit", "idea", ideaId, names.join(", "));
  })();
}

export function restoreVersion(db: DB, ideaId: number, version: number, userId: number) {
  const v = db.prepare("SELECT * FROM idea_versions WHERE idea_id = ? AND version = ?").get(ideaId, version) as
    | { title: string; summary: string; card: string }
    | undefined;
  const idea = getIdea(db, ideaId);
  if (!v || !idea) return false;
  db.transaction(() => {
    const next = idea.version + 1;
    db.prepare("UPDATE ideas SET title = ?, summary = ?, card = ?, version = ?, updated_at = datetime('now') WHERE id = ?").run(
      v.title,
      v.summary,
      v.card,
      next,
      ideaId,
    );
    db.prepare(
      `INSERT INTO idea_versions (idea_id, version, title, summary, card, change_summary, source, source_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?, 'restore', ?, ?)`,
    ).run(ideaId, next, v.title, v.summary, v.card, `Restored version ${version}.`, version, userId);
    indexIdea(db, ideaId);
  })();
  return true;
}

// Keeps AI-suggested questions as drafts the organizer can choose to send.
function syncDraftQuestions(db: DB, ideaId: number, card: IdeaCard) {
  db.prepare("DELETE FROM questions WHERE idea_id = ? AND status = 'draft'").run(ideaId);
  const existing = new Set(
    (db.prepare("SELECT text FROM questions WHERE idea_id = ?").all(ideaId) as { text: string }[]).map((q) =>
      q.text.toLowerCase(),
    ),
  );
  const ins = db.prepare("INSERT INTO questions (idea_id, text, why) VALUES (?, ?, ?)");
  for (const q of card.open_questions.slice(0, 5)) {
    if (!existing.has(q.ask_him.toLowerCase())) ins.run(ideaId, q.ask_him, q.why);
  }
}

export function setStatus(db: DB, ideaId: number, status: Status, userId: number | null) {
  const idea = getIdea(db, ideaId);
  if (!idea || idea.status === status) return;
  db.prepare("UPDATE ideas SET status = ?, updated_at = datetime('now'), last_activity_at = datetime('now') WHERE id = ?").run(
    status,
    ideaId,
  );
  logActivity(db, userId, "status", "idea", ideaId, `${idea.status} → ${status}`);
}

export interface ReviewInput {
  kind: string;
  ideaId?: number | null;
  otherIdeaId?: number | null;
  fragmentId?: number | null;
  linkId?: number | null;
  recordingId?: number | null;
  note?: string;
}

export function addReview(db: DB, r: ReviewInput): number {
  return Number(
    db
      .prepare(
        "INSERT INTO review_items (kind, idea_id, other_idea_id, fragment_id, link_id, recording_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(r.kind, r.ideaId ?? null, r.otherIdeaId ?? null, r.fragmentId ?? null, r.linkId ?? null, r.recordingId ?? null, r.note ?? null)
      .lastInsertRowid,
  );
}

export function resolveReview(db: DB, id: number, resolution: string, userId: number | null) {
  db.prepare(
    "UPDATE review_items SET status = 'done', resolution = ?, resolved_at = datetime('now'), resolved_by = ? WHERE id = ? AND status = 'open'",
  ).run(resolution, userId, id);
}

// Links are stored once per unordered pair and type.
export function addLink(
  db: DB,
  a: number,
  b: number,
  type: string,
  opts: { confidence?: number; reason?: string; status?: string; by?: string },
): number | null {
  if (a === b) return null;
  const [x, y] = a < b ? [a, b] : [b, a];
  const existing = db.prepare("SELECT id, status FROM links WHERE idea_a = ? AND idea_b = ? AND type = ?").get(x, y, type) as
    | { id: number; status: string }
    | undefined;
  if (existing) {
    if (opts.status === "confirmed" && existing.status !== "confirmed") {
      db.prepare("UPDATE links SET status = 'confirmed' WHERE id = ?").run(existing.id);
    }
    return existing.status === "dismissed" ? null : existing.id;
  }
  return Number(
    db
      .prepare("INSERT INTO links (idea_a, idea_b, type, status, confidence, reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(x, y, type, opts.status ?? "suggested", opts.confidence ?? null, opts.reason ?? null, opts.by ?? "ai").lastInsertRowid,
  );
}

export interface FragmentForPrompt {
  id: number;
  recording_id: number;
  captured_at: string;
  quote: string;
  summary: string;
  interpretation: string | null;
  kind: string;
  answers_question: number;
}

export function ideaFragments(db: DB, ideaId: number): FragmentForPrompt[] {
  return db
    .prepare(
      `SELECT f.id, f.recording_id, r.captured_at, f.quote, f.summary, f.interpretation, f.kind, f.answers_question
       FROM fragments f JOIN recordings r ON r.id = f.recording_id
       WHERE f.idea_id = ? ORDER BY r.captured_at, f.position`,
    )
    .all(ideaId) as FragmentForPrompt[];
}

// Moves every fragment of one idea into another. The merged idea is archived,
// not deleted, and remains reachable through its link and version history.
export function mergeInto(db: DB, keepId: number, mergeId: number, userId: number | null) {
  db.transaction(() => {
    db.prepare("UPDATE fragments SET idea_id = ? WHERE idea_id = ?").run(keepId, mergeId);
    db.prepare("UPDATE questions SET idea_id = ? WHERE idea_id = ? AND status != 'draft'").run(keepId, mergeId);
    db.prepare("UPDATE attachments SET idea_id = ? WHERE idea_id = ?").run(keepId, mergeId);
    db.prepare("UPDATE notes SET idea_id = ? WHERE idea_id = ?").run(keepId, mergeId);
    const linkId = addLink(db, keepId, mergeId, "duplicate", { status: "confirmed", by: "user", reason: "Merged" });
    if (linkId) db.prepare("UPDATE links SET status = 'confirmed' WHERE id = ?").run(linkId);
    setStatus(db, mergeId, "archived", userId);
    db.prepare("UPDATE ideas SET busy = NULL WHERE id = ?").run(mergeId);
    db.prepare("UPDATE review_items SET status = 'done', resolution = 'merged', resolved_at = ? WHERE status = 'open' AND idea_id = ?").run(
      now(),
      mergeId,
    );
    indexIdea(db, mergeId);
    logActivity(db, userId, "merge", "idea", keepId, `#${mergeId} merged in`);
  })();
}
