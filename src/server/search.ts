import crypto from "node:crypto";
import type { AI } from "./ai/index.js";
import { cosine, fromBlob, toBlob } from "./ai/embeddings.js";
import type { DB } from "./db.js";

// Search combines two signals:
//  - keyword search (SQLite FTS5) over titles, summaries, reports and transcripts
//  - meaning search (embeddings), so "AI business" finds "a bot that sells stuff"
// and merges them with reciprocal rank fusion.

interface IdeaRow {
  id: number;
  title: string;
  summary: string;
  card: string;
  report: string | null;
}

export function ideaSearchText(db: DB, ideaId: number): { title: string; body: string; meaning: string } | null {
  const idea = db.prepare("SELECT id, title, summary, card, report FROM ideas WHERE id = ?").get(ideaId) as IdeaRow | undefined;
  if (!idea) return null;
  const card = safeJson<Record<string, unknown>>(idea.card, {});
  const tags = (db.prepare("SELECT tag FROM tags WHERE idea_id = ?").all(ideaId) as { tag: string }[]).map((t) => t.tag);
  const quotes = (db.prepare("SELECT quote, interpretation FROM fragments WHERE idea_id = ?").all(ideaId) as {
    quote: string;
    interpretation: string | null;
  }[])
    .map((f) => `${f.quote} ${f.interpretation ?? ""}`)
    .join("\n");
  const cardText = ["vision", "problem", "how_it_works", "audience", "business_model"]
    .map((k) => card[k])
    .filter((v) => typeof v === "string")
    .join("\n");
  const report = idea.report ? flattenReport(idea.report) : "";
  return {
    title: idea.title,
    body: [idea.summary, cardText, tags.join(" "), quotes, report].join("\n"),
    // Shorter text for embeddings: what the idea IS, not every word said about it.
    meaning: [idea.title, idea.summary, cardText, tags.join(", ")].join("\n"),
  };
}

function flattenReport(json: string): string {
  const r = safeJson<Record<string, unknown>>(json, {});
  const out: string[] = [];
  for (const v of Object.values(r)) {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object" && Array.isArray((v as { points?: unknown[] }).points)) {
      for (const p of (v as { points: { text: string }[] }).points) out.push(p.text);
    }
  }
  return out.join("\n");
}

export function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export function indexIdea(db: DB, ideaId: number) {
  db.prepare("DELETE FROM search_fts WHERE entity = 'idea' AND entity_id = ?").run(ideaId);
  const t = ideaSearchText(db, ideaId);
  if (!t) return;
  db.prepare("INSERT INTO search_fts (entity, entity_id, title, body) VALUES ('idea', ?, ?, ?)").run(ideaId, t.title, t.body);
}

export function indexRecording(db: DB, recordingId: number) {
  db.prepare("DELETE FROM search_fts WHERE entity = 'recording' AND entity_id = ?").run(recordingId);
  const r = db.prepare("SELECT summary, transcript FROM recordings WHERE id = ?").get(recordingId) as
    | { summary: string | null; transcript: string | null }
    | undefined;
  if (!r?.transcript) return;
  db.prepare("INSERT INTO search_fts (entity, entity_id, title, body) VALUES ('recording', ?, ?, ?)").run(
    recordingId,
    r.summary ?? "",
    r.transcript,
  );
}

export function indexTask(db: DB, taskId: number) {
  db.prepare("DELETE FROM search_fts WHERE entity = 'task' AND entity_id = ?").run(taskId);
  const t = db.prepare("SELECT title, instructions, expected_outcome FROM tasks WHERE id = ?").get(taskId) as
    | { title: string; instructions: string | null; expected_outcome: string | null }
    | undefined;
  if (!t) return;
  db.prepare("INSERT INTO search_fts (entity, entity_id, title, body) VALUES ('task', ?, ?, ?)").run(
    taskId,
    t.title,
    `${t.instructions ?? ""}\n${t.expected_outcome ?? ""}`,
  );
}

const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

// Re-embeds only when the text actually changed (embedding calls cost money).
export async function embedEntities(db: DB, ai: AI, items: { entity: "idea" | "fragment"; id: number; text: string }[]) {
  if (!ai.embedder || !items.length) return;
  const model = ai.embedder.model;
  const stale = items.filter((it) => {
    const row = db.prepare("SELECT text_hash, model FROM embeddings WHERE entity = ? AND entity_id = ?").get(it.entity, it.id) as
      | { text_hash: string; model: string }
      | undefined;
    return !row || row.text_hash !== hash(it.text) || row.model !== model;
  });
  if (!stale.length) return;
  const vectors = await ai.embedder.embed(
    stale.map((s) => s.text),
    "embed",
  );
  const upsert = db.prepare(
    `INSERT INTO embeddings (entity, entity_id, model, text_hash, vector) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entity, entity_id) DO UPDATE SET model = excluded.model, text_hash = excluded.text_hash, vector = excluded.vector`,
  );
  db.transaction(() => {
    stale.forEach((s, i) => upsert.run(s.entity, s.id, model, hash(s.text), toBlob(vectors[i])));
  })();
}

export async function embedIdea(db: DB, ai: AI, ideaId: number) {
  const t = ideaSearchText(db, ideaId);
  if (t) await embedEntities(db, ai, [{ entity: "idea", id: ideaId, text: t.meaning }]);
}

// Turns free text into a safe FTS5 query: every word as a prefix term, OR-ed.
export function ftsQuery(q: string): string | null {
  const terms = q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1)
    .slice(0, 12);
  if (!terms.length) return null;
  return terms.map((t) => `"${t}"*`).join(" OR ");
}

const queryCache = new Map<string, Float32Array>();

async function queryVector(ai: AI, q: string): Promise<Float32Array | null> {
  if (!ai.embedder) return null;
  const key = `${ai.embedder.model}:${q}`;
  const hit = queryCache.get(key);
  if (hit) return hit;
  const [v] = await ai.embedder.embed([q], "search");
  queryCache.set(key, v);
  if (queryCache.size > 200) queryCache.delete(queryCache.keys().next().value!);
  return v;
}

export interface IdeaHit {
  ideaId: number;
  score: number;
  matchedBy: ("words" | "meaning")[];
  snippet?: string;
}

export interface SearchResult {
  ideas: IdeaHit[];
  recordings: { recordingId: number; snippet: string }[];
  tasks: { taskId: number; snippet: string }[];
}

const RRF_K = 60;

export async function search(db: DB, ai: AI, q: string, limit = 50): Promise<SearchResult> {
  const fused = new Map<number, IdeaHit>();
  const add = (ideaId: number, rank: number, by: "words" | "meaning", weight = 1, snippet?: string) => {
    const hit = fused.get(ideaId) ?? { ideaId, score: 0, matchedBy: [] };
    hit.score += weight / (RRF_K + rank);
    if (!hit.matchedBy.includes(by)) hit.matchedBy.push(by);
    if (snippet && !hit.snippet) hit.snippet = snippet;
    fused.set(ideaId, hit);
  };

  const recordings: SearchResult["recordings"] = [];
  const tasks: SearchResult["tasks"] = [];
  const fq = ftsQuery(q);
  if (fq) {
    const rows = db
      .prepare(
        `SELECT entity, entity_id, snippet(search_fts, 3, '«', '»', '…', 14) AS snip
         FROM search_fts WHERE search_fts MATCH ? ORDER BY bm25(search_fts, 0, 0, 4.0, 1.0) LIMIT 200`,
      )
      .all(fq) as { entity: string; entity_id: number; snip: string }[];
    let ideaRank = 0;
    for (const r of rows) {
      if (r.entity === "idea") add(r.entity_id, ideaRank++, "words", 1, r.snip);
      else if (r.entity === "recording") {
        recordings.push({ recordingId: r.entity_id, snippet: r.snip });
        // A transcript hit also counts (more weakly) for the ideas it fed.
        const linked = db
          .prepare("SELECT DISTINCT idea_id FROM fragments WHERE recording_id = ? AND idea_id IS NOT NULL")
          .all(r.entity_id) as { idea_id: number }[];
        for (const l of linked) add(l.idea_id, ideaRank + 5, "words", 0.5);
      } else if (r.entity === "task") tasks.push({ taskId: r.entity_id, snippet: r.snip });
    }
  }

  let qv: Float32Array | null = null;
  try {
    qv = await queryVector(ai, q);
  } catch (err) {
    console.warn("[search] meaning search unavailable:", (err as Error).message);
  }
  if (qv) {
    const rows = db.prepare("SELECT entity, entity_id, vector FROM embeddings").all() as {
      entity: string;
      entity_id: number;
      vector: Buffer;
    }[];
    const fragIdea = new Map(
      (db.prepare("SELECT id, idea_id FROM fragments WHERE idea_id IS NOT NULL").all() as { id: number; idea_id: number }[]).map(
        (f) => [f.id, f.idea_id],
      ),
    );
    const best = new Map<number, number>();
    for (const r of rows) {
      const ideaId = r.entity === "idea" ? r.entity_id : fragIdea.get(r.entity_id);
      if (!ideaId) continue;
      const s = cosine(qv, fromBlob(r.vector));
      if (s > (best.get(ideaId) ?? -1)) best.set(ideaId, s);
    }
    const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
    // Drop weak semantic matches so unrelated ideas don't pad the results.
    const top = ranked[0]?.[1] ?? 0;
    ranked
      .filter(([, s]) => s >= Math.max(0.2, top - 0.25))
      .slice(0, limit)
      .forEach(([id], i) => add(id, i, "meaning"));
  }

  const ideas = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  return { ideas, recordings: recordings.slice(0, 20), tasks: tasks.slice(0, 20) };
}

// Finds existing ideas most similar to a new thought (for duplicate/link detection).
export async function similarIdeas(
  db: DB,
  ai: AI,
  text: string,
  opts: { exclude?: number[]; limit?: number } = {},
): Promise<{ ideaId: number; score: number }[]> {
  const exclude = new Set(opts.exclude ?? []);
  const limit = opts.limit ?? 8;
  const scores = new Map<number, number>();

  const fq = ftsQuery(text);
  if (fq) {
    const rows = db
      .prepare(
        `SELECT entity_id FROM search_fts WHERE entity = 'idea' AND search_fts MATCH ? ORDER BY bm25(search_fts, 0, 0, 4.0, 1.0) LIMIT 20`,
      )
      .all(fq) as { entity_id: number }[];
    rows.forEach((r, i) => scores.set(r.entity_id, (scores.get(r.entity_id) ?? 0) + 1 / (RRF_K + i)));
  }
  if (ai.embedder) {
    const [v] = await ai.embedder.embed([text], "similar");
    const rows = db.prepare("SELECT entity_id, vector FROM embeddings WHERE entity = 'idea'").all() as {
      entity_id: number;
      vector: Buffer;
    }[];
    rows
      .map((r) => ({ id: r.entity_id, s: cosine(v, fromBlob(r.vector)) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, 20)
      .forEach((r, i) => scores.set(r.id, (scores.get(r.id) ?? 0) + 1.5 / (RRF_K + i)));
  }
  return [...scores.entries()]
    .filter(([id]) => !exclude.has(id))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([ideaId, score]) => ({ ideaId, score }));
}
