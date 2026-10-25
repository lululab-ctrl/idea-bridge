import { type AI, requireLLM } from "./ai/index.ts";
import { baseSystem, sharedContext } from "./ai/prompts.ts";
import type { DB } from "./db.ts";
import { safeJson } from "./db.ts";
import { getIdea, ideaFragments, type StoredCard } from "./ideas.ts";
import type { JobQueue } from "./jobs.ts";
import { search } from "./search.ts";

// The question-and-answer assistant and document generator.

export const DELIVERABLES: Record<string, { title: string; brief: string }> = {
  business_concept: {
    title: "Business concept",
    brief:
      "A business concept document: the opportunity, the customer and their problem, the offer, how it makes money, why now, why them, key risks, and what must be true for it to work. Mark clearly what is his stated vision, what is interpretation and what are your assumptions.",
  },
  implementation_plan: {
    title: "Implementation plan",
    brief:
      "An implementation plan: phases with goals, concrete tasks with owners (visionary/organizer), dependencies, a realistic timeline, decision points, and what to measure. Start with the smallest version that proves the idea.",
  },
  research_brief: {
    title: "Research brief",
    brief:
      "A research brief for validating the idea: the key questions to answer, why each matters, how to research each (desk research, customer interviews with a short interview guide, competitor scan, quick experiments), and what result would change the decision. Do not state market facts as known; frame them as questions.",
  },
  product_requirements: {
    title: "Product requirements",
    brief:
      "A product requirements document: problem, users and their jobs to be done, goals and non-goals, user stories, functional requirements (prioritized must/should/could), key flows, open questions and success metrics.",
  },
  one_pager: {
    title: "One-page summary",
    brief:
      "A one-page summary someone outside the company could read in two minutes: what it is, who it's for, why it matters, how it works, and what's being asked or next.",
  },
};

export async function generateDeliverable(
  db: DB,
  ai: AI,
  ideaId: number,
  kind: string,
  instructions: string,
  userId: number | null,
): Promise<number> {
  const llm = requireLLM(ai);
  const idea = await getIdea(db, ideaId);
  if (!idea) return 0;
  const spec = DELIVERABLES[kind] ?? { title: "Document", brief: "A useful document as described in the instructions." };
  const card = safeJson<StoredCard>(idea.card, {});
  const frags = await ideaFragments(db, ideaId);
  const report = idea.report ? `<report>\n${idea.report}\n</report>` : "";
  const markdown = await llm.text({
    purpose: "deliverable",
    system: await baseSystem(db),
    context: await sharedContext(db),
    deep: true,
    effort: "medium",
    maxTokens: 12000,
    prompt: `Write ${spec.brief}
${instructions ? `\nAdditional instructions from the organizer: ${instructions}\n` : ""}
Format: Markdown with clear headings, short paragraphs and lists where they help. Start with a level-1 heading naming the idea and document type. Do not invent facts, figures or names; where information is missing, say what is needed. End with a short "Open questions" section.

<idea id="${idea.id}">
<title>${idea.title}</title>
<summary>${idea.summary}</summary>
<card>${JSON.stringify({ ...card, edited: undefined })}</card>
<his_words>
${frags.map((f) => `[${f.captured_at}] "${f.quote}"`).join("\n")}
</his_words>
${report}
</idea>`,
  });
  return db.insert(
    "INSERT INTO deliverables (idea_id, kind, title, markdown, user_id) VALUES (?, ?, ?, ?, ?)",
    ideaId,
    kind,
    `${spec.title}: ${idea.title}`,
    markdown,
    userId,
  );
}

export function registerDeliverableJob(db: DB, ai: AI, jobs: JobQueue) {
  jobs.register("deliverable", async (p) => {
    await generateDeliverable(db, ai, Number(p.ideaId), String(p.kind), String(p.instructions ?? ""), (p.userId as number) ?? null);
  });
}

export interface AskTurn {
  role: "user" | "assistant";
  content: string;
}

// Answers a question about everything stored, citing ideas as [#id].
export async function ask(db: DB, ai: AI, question: string, history: AskTurn[]) {
  const llm = requireLLM(ai);
  const retrievalQuery = [...history.filter((h) => h.role === "user").slice(-2).map((h) => h.content), question].join(" ");
  const hits = await search(db, ai, retrievalQuery, 15);
  const ids = new Set(hits.ideas.map((h) => h.ideaId));
  // Always include the most active ideas so general questions have context.
  for (const r of await db.all<{ id: number }>("SELECT id FROM ideas WHERE status != 'archived' ORDER BY last_activity_at DESC LIMIT 10")) {
    if (ids.size >= 25) break;
    ids.add(r.id);
  }
  const blocks: string[] = [];
  for (const id of ids) {
    const idea = await getIdea(db, id);
    if (!idea) continue;
    const quotes = (await ideaFragments(db, id))
      .slice(-4)
      .map((f) => `  - [${f.captured_at.slice(0, 10)}] "${f.quote.slice(0, 400)}"`)
      .join("\n");
    const tasks = await db.all<{ title: string; status: string; due_date: string | null }>(
      "SELECT title, status, due_date FROM tasks WHERE idea_id = ?",
      id,
    );
    blocks.push(
      `[#${id}] ${idea.title} (status: ${idea.status}, priority: ${idea.priority}, captured ${idea.created_at.slice(0, 10)})
Summary: ${idea.summary}
His words:
${quotes}${tasks.length ? `\nTasks: ${tasks.map((t) => `${t.title} [${t.status}${t.due_date ? `, due ${t.due_date}` : ""}]`).join("; ")}` : ""}`,
    );
  }
  const recs = hits.recordings
    .slice(0, 5)
    .map((r) => `Recording ${r.recordingId}: …${r.snippet.replace(/[«»]/g, "")}…`)
    .join("\n");
  const convo = history
    .slice(-6)
    .map((h) => `${h.role === "user" ? "Q" : "A"}: ${h.content}`)
    .join("\n");
  const answer = await llm.text({
    purpose: "ask",
    system: await baseSystem(db),
    context: await sharedContext(db),
    effort: "medium",
    maxTokens: 16000,
    prompt: `Answer the organizer's question using only the library excerpts below. Cite ideas inline as [#id] wherever you use them. If the library doesn't contain the answer, say so plainly and suggest what to ask him. Be concise and well-structured (Markdown).

<library>
${blocks.join("\n\n")}
${recs ? `\nMatching transcript passages:\n${recs}` : ""}
</library>
${convo ? `\n<conversation_so_far>\n${convo}\n</conversation_so_far>` : ""}

Question: ${question}`,
  });
  const cited = [];
  for (const id of new Set([...answer.matchAll(/\[#(\d+)\]/g)].map((m) => Number(m[1])))) {
    const i = await getIdea(db, id);
    if (i) cited.push({ id: i.id, title: i.title, status: i.status });
  }
  return { answer, cited };
}
