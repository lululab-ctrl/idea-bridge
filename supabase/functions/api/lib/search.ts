import type { AI } from "./ai/index.ts";
import { baseSystem } from "./ai/prompts.ts";
import { QueryTerms } from "./ai/schemas.ts";
import type { DB } from "./db.ts";
import { getSetting, safeJson, setSetting } from "./db.ts";

// Search = Postgres full-text search, widened by meaning: the AI turns a query
// into related words and synonyms in English and Hebrew ("AI business" also
// looks for "automation", "bot", "בינה מלאכותית", ...). New thoughts carry their
// own bilingual search terms (written while the recording is understood).

export async function ideaSearchText(db: DB, ideaId: number) {
  const idea = await db.get<{ title: string; summary: string; card: string; report: string | null }>(
    "SELECT title, summary, card, report FROM ideas WHERE id = ?",
    ideaId,
  );
  if (!idea) return null;
  const card = safeJson<Record<string, unknown>>(idea.card, {});
  const tags = (await db.all<{ tag: string }>("SELECT tag FROM tags WHERE idea_id = ?", ideaId)).map((t) => t.tag);
  const frags = await db.all<{ quote: string; interpretation: string | null; search_terms: string | null }>(
    "SELECT quote, interpretation, search_terms FROM fragments WHERE idea_id = ?",
    ideaId,
  );
  const cardText = ["vision", "problem", "how_it_works", "audience", "business_model"]
    .map((k) => card[k])
    .filter((v) => typeof v === "string")
    .join("\n");
  const terms = frags.flatMap((f) => safeJson<string[]>(f.search_terms, [])).join(" ");
  const report = idea.report ? flattenReport(idea.report) : "";
  return {
    title: idea.title,
    body: [idea.summary, cardText, tags.join(" "), terms, frags.map((f) => `${f.quote} ${f.interpretation ?? ""}`).join("\n"), report].join("\n"),
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

async function upsertIndex(db: DB, entity: string, id: number, title: string, body: string) {
  await db.run(
    `INSERT INTO search_index (entity, entity_id, title, body) VALUES (?, ?, ?, ?)
     ON CONFLICT (entity, entity_id) DO UPDATE SET title = excluded.title, body = excluded.body`,
    entity,
    id,
    title,
    body,
  );
}

export async function indexIdea(db: DB, ideaId: number) {
  const t = await ideaSearchText(db, ideaId);
  if (!t) return void (await db.run("DELETE FROM search_index WHERE entity = 'idea' AND entity_id = ?", ideaId));
  await upsertIndex(db, "idea", ideaId, t.title, t.body);
}

export async function indexRecording(db: DB, recordingId: number) {
  const r = await db.get<{ summary: string | null; transcript: string | null }>(
    "SELECT summary, transcript FROM recordings WHERE id = ?",
    recordingId,
  );
  if (!r?.transcript) return void (await db.run("DELETE FROM search_index WHERE entity = 'recording' AND entity_id = ?", recordingId));
  await upsertIndex(db, "recording", recordingId, r.summary ?? "", r.transcript);
}

export async function indexTask(db: DB, taskId: number) {
  const t = await db.get<{ title: string; instructions: string | null; expected_outcome: string | null }>(
    "SELECT title, instructions, expected_outcome FROM tasks WHERE id = ?",
    taskId,
  );
  if (!t) return void (await db.run("DELETE FROM search_index WHERE entity = 'task' AND entity_id = ?", taskId));
  await upsertIndex(db, "task", taskId, t.title, `${t.instructions ?? ""}\n${t.expected_outcome ?? ""}`);
}

export function words(q: string): string[] {
  return [
    ...new Set(
      q
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 1),
    ),
  ].slice(0, 24);
}

// Safe tsquery: each word as a prefix term, OR-ed together.
export function tsQuery(terms: string[]): string | null {
  const ws = [...new Set(terms.flatMap((t) => words(t)))].slice(0, 40);
  return ws.length ? ws.map((w) => `${w}:*`).join(" | ") : null;
}

// Related words for a query, in both languages. Cached, so each phrase costs once.
export async function expandQuery(db: DB, ai: AI, q: string): Promise<string[]> {
  if (!ai.llm || words(q).length === 0) return [];
  const key = `qterms:${q.toLowerCase().slice(0, 120)}`;
  const cached = await getSetting<string[] | null>(db, key, null);
  if (cached) return cached;
  try {
    const r = await ai.llm.json(QueryTerms, {
      purpose: "query_terms",
      system: await baseSystem(db),
      effort: "low",
      maxTokens: 2000,
      prompt: `Someone is searching their idea library. Give search keywords that would find ideas MEANING the same thing, even if worded differently or written in Hebrew instead of English (or the reverse). Include synonyms, related concepts and translations. Single words or short phrases only.\n<query>${q}</query>`,
    });
    const terms = r.terms.slice(0, 20);
    await setSetting(db, key, terms);
    return terms;
  } catch (err) {
    console.warn("[search] query expansion failed:", (err as Error).message);
    return [];
  }
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

async function ftsRows(db: DB, query: string, limit: number) {
  return await db.all<{ entity: string; entity_id: number; snip: string }>(
    `SELECT entity, entity_id,
       ts_headline('simple', body, to_tsquery('simple', ?), 'StartSel=«,StopSel=»,MaxWords=22,MinWords=8,MaxFragments=1') AS snip
     FROM search_index WHERE tsv @@ to_tsquery('simple', ?)
     ORDER BY ts_rank(tsv, to_tsquery('simple', ?)) DESC LIMIT ?`,
    query,
    query,
    query,
    limit,
  );
}

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
  const direct = tsQuery([q]);
  if (direct) {
    let ideaRank = 0;
    for (const r of await ftsRows(db, direct, 200)) {
      if (r.entity === "idea") add(r.entity_id, ideaRank++, "words", 1, r.snip);
      else if (r.entity === "recording") {
        recordings.push({ recordingId: r.entity_id, snippet: r.snip });
        const linked = await db.all<{ idea_id: number }>(
          "SELECT DISTINCT idea_id FROM fragments WHERE recording_id = ? AND idea_id IS NOT NULL",
          r.entity_id,
        );
        for (const l of linked) add(l.idea_id, ideaRank + 5, "words", 0.5);
      } else if (r.entity === "task") tasks.push({ taskId: r.entity_id, snippet: r.snip });
    }
  }
  const expanded = await expandQuery(db, ai, q);
  const meaning = tsQuery(expanded);
  if (meaning) {
    const rows = (await ftsRows(db, meaning, 100)).filter((r) => r.entity === "idea");
    rows.forEach((r, i) => add(r.entity_id, i, "meaning", 0.9, r.snip));
  }
  const ideas = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  return { ideas, recordings: recordings.slice(0, 20), tasks: tasks.slice(0, 20) };
}

// Candidate ideas a new thought might belong to: matches on its bilingual search
// terms, plus the most recently active ideas so nothing obvious is missed.
export async function similarIdeas(
  db: DB,
  terms: string[],
  opts: { exclude?: number[]; limit?: number } = {},
): Promise<number[]> {
  const exclude = new Set(opts.exclude ?? []);
  const limit = opts.limit ?? 10;
  const out: number[] = [];
  const q = tsQuery(terms);
  if (q) {
    const rows = await db.all<{ entity_id: number }>(
      `SELECT entity_id FROM search_index WHERE entity = 'idea' AND tsv @@ to_tsquery('simple', ?)
       ORDER BY ts_rank(tsv, to_tsquery('simple', ?)) DESC LIMIT 20`,
      q,
      q,
    );
    for (const r of rows) if (!exclude.has(r.entity_id) && !out.includes(r.entity_id)) out.push(r.entity_id);
  }
  const recent = await db.all<{ id: number }>(
    "SELECT id FROM ideas WHERE status != 'archived' ORDER BY last_activity_at DESC LIMIT 6",
  );
  for (const r of recent) if (!exclude.has(r.id) && !out.includes(r.id)) out.push(r.id);
  return out.slice(0, limit);
}
