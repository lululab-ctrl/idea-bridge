import type { IdeaCard } from "./ai/schemas.ts";
import type { DB } from "./db.ts";
import { logActivity, safeJson } from "./db.ts";
import { indexIdea } from "./search.ts";

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
  edited?: string[]; // fields the admin corrected by hand (authoritative)
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

export function getIdea(db: DB, id: number): Promise<IdeaRow | undefined> {
  return db.get<IdeaRow>("SELECT * FROM ideas WHERE id = ?", id);
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

export async function setTags(db: DB, ideaId: number, tags: string[]) {
  await db.run("DELETE FROM tags WHERE idea_id = ?", ideaId);
  for (const t of cleanTags(tags)) {
    await db.run("INSERT INTO tags (idea_id, tag) VALUES (?, ?) ON CONFLICT DO NOTHING", ideaId, t);
  }
}

export function strongerCommitment(a: Commitment, b: Commitment): Commitment {
  return (COMMITMENT_RANK[b] ?? 0) > (COMMITMENT_RANK[a] ?? 0) ? b : a;
}

function storedCard(card: IdeaCard, edited: string[] = []): StoredCard {
  const { change_summary: _c, ...rest } = card;
  return { ...rest, edited };
}

export function createIdea(
  db: DB,
  card: IdeaCard,
  opts: { source: string; sourceId?: number; userId?: number | null; status?: Status },
): Promise<number> {
  return db.tx(async (t) => {
    const id = await t.insert(
      "INSERT INTO ideas (title, summary, card, status, commitment, clarity) VALUES (?, ?, ?, ?, ?, ?)",
      card.title.trim() || "Untitled idea",
      card.summary,
      JSON.stringify(storedCard(card)),
      opts.status ?? "new",
      card.commitment,
      clampClarity(card.clarity),
    );
    await setTags(t, id, card.tags);
    await t.run(
      `INSERT INTO idea_versions (idea_id, version, title, summary, card, change_summary, source, source_id, user_id)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      card.title,
      card.summary,
      JSON.stringify(storedCard(card)),
      "First captured.",
      opts.source,
      opts.sourceId ?? null,
      opts.userId ?? null,
    );
    await syncDraftQuestions(t, id, card);
    await indexIdea(t, id);
    return id;
  });
}

// Writes a new version of an idea's card, keeping hand-corrected fields.
export function applyCard(
  db: DB,
  ideaId: number,
  card: IdeaCard,
  opts: { source: string; sourceId?: number; userId?: number | null; changeSummary?: string },
): Promise<void> {
  return db.tx(async (t) => {
    const idea = await getIdea(t, ideaId);
    if (!idea) return;
    const prev = safeJson<StoredCard>(idea.card, {});
    const edited = prev.edited ?? [];
    const next: StoredCard = storedCard(card, edited);
    for (const f of edited) (next as Record<string, unknown>)[f] = (prev as Record<string, unknown>)[f];
    const version = idea.version + 1;
    const title = edited.includes("title") ? idea.title : card.title.trim() || idea.title;
    const summary = edited.includes("summary") ? idea.summary : card.summary;
    await t.run(
      `UPDATE ideas SET title = ?, summary = ?, card = ?, clarity = ?, commitment = ?, version = ?,
         updated_at = now_text(), last_activity_at = now_text() WHERE id = ?`,
      title,
      summary,
      JSON.stringify(next),
      clampClarity(card.clarity),
      strongerCommitment(idea.commitment, card.commitment),
      version,
      ideaId,
    );
    if (!edited.includes("tags")) await setTags(t, ideaId, card.tags);
    await t.run(
      `INSERT INTO idea_versions (idea_id, version, title, summary, card, change_summary, source, source_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ideaId,
      version,
      title,
      summary,
      JSON.stringify(next),
      opts.changeSummary ?? card.change_summary,
      opts.source,
      opts.sourceId ?? null,
      opts.userId ?? null,
    );
    await syncDraftQuestions(t, ideaId, card);
    await indexIdea(t, ideaId);
  });
}

// A correction by the admin. Edited fields are remembered as authoritative so
// later AI updates don't overwrite them.
export function editIdea(db: DB, ideaId: number, changes: Record<string, unknown>, userId: number): Promise<void> {
  return db.tx(async (t) => {
    const idea = await getIdea(t, ideaId);
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
    await t.run(
      "UPDATE ideas SET title = ?, summary = ?, card = ?, version = ?, updated_at = now_text() WHERE id = ?",
      title,
      summary,
      JSON.stringify(card),
      version,
      ideaId,
    );
    if (Array.isArray(changes.tags)) await setTags(t, ideaId, changes.tags as string[]);
    await t.run(
      `INSERT INTO idea_versions (idea_id, version, title, summary, card, change_summary, source, user_id)
       VALUES (?, ?, ?, ?, ?, ?, 'edit', ?)`,
      ideaId,
      version,
      title,
      summary,
      JSON.stringify(card),
      `Corrected by hand: ${names.join(", ")}.`,
      userId,
    );
    await indexIdea(t, ideaId);
    await logActivity(t, userId, "edit", "idea", ideaId, names.join(", "));
  });
}

export async function restoreVersion(db: DB, ideaId: number, version: number, userId: number): Promise<boolean> {
  const v = await db.get<{ title: string; summary: string; card: string }>(
    "SELECT title, summary, card FROM idea_versions WHERE idea_id = ? AND version = ?",
    ideaId,
    version,
  );
  const idea = await getIdea(db, ideaId);
  if (!v || !idea) return false;
  await db.tx(async (t) => {
    const next = idea.version + 1;
    await t.run("UPDATE ideas SET title = ?, summary = ?, card = ?, version = ?, updated_at = now_text() WHERE id = ?", v.title, v.summary, v.card, next, ideaId);
    await t.run(
      `INSERT INTO idea_versions (idea_id, version, title, summary, card, change_summary, source, source_id, user_id)
       VALUES (?, ?, ?, ?, ?, ?, 'restore', ?, ?)`,
      ideaId,
      next,
      v.title,
      v.summary,
      v.card,
      `Restored version ${version}.`,
      version,
      userId,
    );
    await indexIdea(t, ideaId);
  });
  return true;
}

// AI-suggested questions are kept as drafts the admin can choose to send.
async function syncDraftQuestions(db: DB, ideaId: number, card: IdeaCard) {
  await db.run("DELETE FROM questions WHERE idea_id = ? AND status = 'draft'", ideaId);
  const existing = new Set((await db.all<{ text: string }>("SELECT text FROM questions WHERE idea_id = ?", ideaId)).map((q) => q.text.toLowerCase()));
  for (const q of card.open_questions.slice(0, 5)) {
    if (!existing.has(q.ask_him.toLowerCase())) await db.run("INSERT INTO questions (idea_id, text, why) VALUES (?, ?, ?)", ideaId, q.ask_him, q.why);
  }
}

export async function setStatus(db: DB, ideaId: number, status: Status, userId: number | null) {
  const idea = await getIdea(db, ideaId);
  if (!idea || idea.status === status) return;
  await db.run("UPDATE ideas SET status = ?, updated_at = now_text(), last_activity_at = now_text() WHERE id = ?", status, ideaId);
  await logActivity(db, userId, "status", "idea", ideaId, `${idea.status} → ${status}`);
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

export function addReview(db: DB, r: ReviewInput): Promise<number> {
  return db.insert(
    "INSERT INTO review_items (kind, idea_id, other_idea_id, fragment_id, link_id, recording_id, note) VALUES (?, ?, ?, ?, ?, ?, ?)",
    r.kind,
    r.ideaId ?? null,
    r.otherIdeaId ?? null,
    r.fragmentId ?? null,
    r.linkId ?? null,
    r.recordingId ?? null,
    r.note ?? null,
  );
}

export async function resolveReview(db: DB, id: number, resolution: string, userId: number | null) {
  await db.run(
    "UPDATE review_items SET status = 'done', resolution = ?, resolved_at = now_text(), resolved_by = ? WHERE id = ? AND status = 'open'",
    resolution,
    userId,
    id,
  );
}

// Links are stored once per unordered pair and type.
export async function addLink(
  db: DB,
  a: number,
  b: number,
  type: string,
  opts: { confidence?: number; reason?: string; status?: string; by?: string },
): Promise<number | null> {
  if (a === b) return null;
  const [x, y] = a < b ? [a, b] : [b, a];
  const existing = await db.get<{ id: number; status: string }>("SELECT id, status FROM links WHERE idea_a = ? AND idea_b = ? AND type = ?", x, y, type);
  if (existing) {
    if (opts.status === "confirmed" && existing.status !== "confirmed") await db.run("UPDATE links SET status = 'confirmed' WHERE id = ?", existing.id);
    return existing.status === "dismissed" && opts.status !== "confirmed" ? null : existing.id;
  }
  return db.insert(
    "INSERT INTO links (idea_a, idea_b, type, status, confidence, reason, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
    x,
    y,
    type,
    opts.status ?? "suggested",
    opts.confidence ?? null,
    opts.reason ?? null,
    opts.by ?? "ai",
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

export function ideaFragments(db: DB, ideaId: number): Promise<FragmentForPrompt[]> {
  return db.all<FragmentForPrompt>(
    `SELECT f.id, f.recording_id, r.captured_at, f.quote, f.summary, f.interpretation, f.kind, f.answers_question
     FROM fragments f JOIN recordings r ON r.id = f.recording_id
     WHERE f.idea_id = ? ORDER BY r.captured_at, f.position`,
    ideaId,
  );
}

// Moves every fragment of one idea into another. The merged idea is archived,
// not deleted, and stays reachable through its link and history.
export function mergeInto(db: DB, keepId: number, mergeId: number, userId: number | null): Promise<void> {
  return db.tx(async (t) => {
    await t.run("UPDATE fragments SET idea_id = ? WHERE idea_id = ?", keepId, mergeId);
    await t.run("UPDATE questions SET idea_id = ? WHERE idea_id = ? AND status != 'draft'", keepId, mergeId);
    await t.run("UPDATE attachments SET idea_id = ? WHERE idea_id = ?", keepId, mergeId);
    await t.run("UPDATE notes SET idea_id = ? WHERE idea_id = ?", keepId, mergeId);
    await addLink(t, keepId, mergeId, "duplicate", { status: "confirmed", by: "user", reason: "Merged" });
    await setStatus(t, mergeId, "archived", userId);
    await t.run(
      "UPDATE review_items SET status = 'done', resolution = 'merged', resolved_at = now_text() WHERE status = 'open' AND idea_id = ?",
      mergeId,
    );
    await indexIdea(t, mergeId);
    await logActivity(t, userId, "merge", "idea", keepId, `#${mergeId} merged in`);
  });
}
