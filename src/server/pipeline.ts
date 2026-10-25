import fs from "node:fs";
import type { AI } from "./ai/index.js";
import { AIError, type LLM } from "./ai/llm.js";
import {
  baseSystem,
  CARD_INSTRUCTIONS,
  EXTRACT_INSTRUCTIONS,
  PLAN_INSTRUCTIONS,
  RELATE_INSTRUCTIONS,
  REPORT_INSTRUCTIONS,
  SCORE_INSTRUCTIONS,
  sharedContext,
} from "./ai/prompts.js";
import {
  ExtractResult,
  IdeaCard,
  Plan,
  Report,
  RelateResult,
  Score,
  type ExtractedFragment,
} from "./ai/schemas.js";
import { estimateSegments, type Segment } from "./ai/speech.js";
import type { DB } from "./db.js";
import { logActivity } from "./db.js";
import {
  addLink,
  addReview,
  applyCard,
  clampClarity,
  createIdea,
  getIdea,
  ideaFragments,
  setStatus,
  type StoredCard,
} from "./ideas.js";
import type { JobQueue } from "./jobs.js";
import { notifyRole } from "./notify.js";
import { embedEntities, embedIdea, indexIdea, indexRecording, safeJson, similarIdeas } from "./search.js";

// Decision thresholds for connecting a new thought to an existing idea.
// Above AUTO_ATTACH the AI attaches it (visible in the review queue, undoable).
// Between SUGGEST and AUTO_ATTACH it becomes a separate idea plus a "possible
// duplicate" suggestion for a person to decide. Below SUGGEST it is new.
export const AUTO_ATTACH = 0.85;
export const SUGGEST = 0.5;
const LINK_MIN = 0.5;

interface RecordingRow {
  id: number;
  user_id: number | null;
  kind: string;
  audio_path: string | null;
  mime: string | null;
  duration_sec: number | null;
  captured_at: string;
  transcript: string | null;
  segments: string | null;
  status: string;
  question_id: number | null;
  analysis: string | null;
}

export class Pipeline {
  constructor(
    private db: DB,
    private ai: AI,
    private jobs: JobQueue,
  ) {
    jobs.register("process_recording", (p) => this.processRecording(Number(p.recordingId)), (p, error) => {
      db.prepare("UPDATE recordings SET status = 'failed', error = ? WHERE id = ?").run(error, Number(p.recordingId));
    });
    jobs.register("refresh_card", (p) => this.refreshCard(Number(p.ideaId), String(p.reason ?? "Updated.")), (p) =>
      this.clearBusy(Number(p.ideaId)),
    );
    jobs.register("report", (p) => this.generateReport(Number(p.ideaId)), (p) => this.clearBusy(Number(p.ideaId)));
    jobs.register("score", (p) => this.generateScore(Number(p.ideaId)), (p) => this.clearBusy(Number(p.ideaId)));
    jobs.register("plan", (p) => this.generatePlan(Number(p.projectId)), (p) => {
      db.prepare("UPDATE projects SET plan_status = 'failed' WHERE id = ?").run(Number(p.projectId));
    });
    jobs.register("embed_idea", (p) => embedIdea(db, ai, Number(p.ideaId)));
    jobs.register("move_fragment", (p) =>
      this.moveFragment(Number(p.fragmentId), p.ideaId ? Number(p.ideaId) : null, (p.userId as number) ?? null),
    );
  }

  private llm(): LLM {
    if (!this.ai.llm) throw new AIError("AI understanding is not set up yet. Add ANTHROPIC_API_KEY in the server settings.", false);
    return this.ai.llm;
  }

  private system() {
    return { system: baseSystem(this.db), context: sharedContext(this.db) };
  }

  private clearBusy(ideaId: number) {
    this.db.prepare("UPDATE ideas SET busy = NULL WHERE id = ?").run(ideaId);
  }

  // ---------------------------------------------------------------- recordings

  async processRecording(id: number) {
    const db = this.db;
    let rec = db.prepare("SELECT * FROM recordings WHERE id = ?").get(id) as RecordingRow | undefined;
    if (!rec || rec.status === "done") return;
    // Deleted before it was processed: leave it alone (it can be restored later).
    if ((rec as RecordingRow & { deleted_at?: string | null }).deleted_at) return;
    db.prepare("UPDATE recordings SET error = NULL WHERE id = ?").run(id);

    if (rec.transcript === null) {
      if (!rec.audio_path || !fs.existsSync(rec.audio_path)) throw new AIError("The audio file is missing.", false);
      db.prepare("UPDATE recordings SET status = 'transcribing' WHERE id = ?").run(id);
      const t = await this.ai.transcriber.transcribe(rec.audio_path, rec.mime ?? "audio/webm", this.transcriptionHints());
      const duration = t.duration ?? rec.duration_sec;
      const segments: Segment[] = t.timed ? t.segments : estimateSegments(t.text, duration);
      db.prepare(
        "UPDATE recordings SET transcript = ?, segments = ?, language = ?, duration_sec = COALESCE(duration_sec, ?), transcribed_by = ? WHERE id = ?",
      ).run(t.text, JSON.stringify({ timed: t.timed, segments }), t.language, duration, t.provider, id);
      indexRecording(db, id);
      rec = db.prepare("SELECT * FROM recordings WHERE id = ?").get(id) as RecordingRow;
    }

    const transcript = (rec.transcript ?? "").trim();
    if (transcript.split(/\s+/).filter(Boolean).length < 3) {
      db.prepare("UPDATE recordings SET status = 'done', summary = ? WHERE id = ?").run("No speech detected.", id);
      return;
    }

    db.prepare("UPDATE recordings SET status = 'analyzing' WHERE id = ?").run(id);
    let analysis = safeJson<ExtractResult | null>(rec.analysis, null);
    const question = rec.question_id
      ? (db
          .prepare("SELECT q.id, q.text, q.idea_id, i.title FROM questions q JOIN ideas i ON i.id = q.idea_id WHERE q.id = ?")
          .get(rec.question_id) as { id: number; text: string; idea_id: number; title: string } | undefined)
      : undefined;
    if (!analysis) {
      analysis = await this.llm().json(ExtractResult, {
        purpose: "extract",
        ...this.system(),
        effort: "medium",
        prompt: `${EXTRACT_INSTRUCTIONS}
${question ? `\nThis recording was made to answer a clarification question about the idea "${question.title}".\n<question>${question.text}</question>\nMark fragments that answer it with answers_question = true.\n` : ""}
Recorded: ${rec.captured_at} (UTC)
<transcript>
${transcript}
</transcript>`,
      });
      db.prepare("UPDATE recordings SET analysis = ?, summary = ?, language = COALESCE(language, ?) WHERE id = ?").run(
        JSON.stringify(analysis),
        analysis.recording_summary,
        analysis.language,
        id,
      );
    }

    const segments = safeJson<{ segments: Segment[] }>(rec.segments, { segments: [] }).segments;
    // Fragments already stored by an earlier, interrupted attempt are skipped.
    const done = new Set(
      (db.prepare("SELECT position FROM fragments WHERE recording_id = ?").all(id) as { position: number }[]).map((r) => r.position),
    );
    for (let i = 0; i < analysis.fragments.length; i++) {
      if (done.has(i)) continue;
      await this.handleFragment(rec, analysis.fragments[i], i, segments, question);
    }

    if (question && analysis.fragments.some((f) => f.answers_question)) {
      db.prepare(
        "UPDATE questions SET status = 'answered', answer_recording_id = ?, answer_text = ?, answered_at = datetime('now') WHERE id = ?",
      ).run(id, analysis.fragments.filter((f) => f.answers_question).map((f) => f.summary).join(" "), question.id);
      if (getIdea(db, question.idea_id)?.status === "needs_clarification") {
        setStatus(db, question.idea_id, "under_review", null);
      }
      addReview(db, { kind: "answer", ideaId: question.idea_id, note: `Answered: "${question.text}"` });
    }

    db.prepare("UPDATE recordings SET status = 'done' WHERE id = ?").run(id);
    logActivity(db, rec.user_id, "processed", "recording", id, `${analysis.fragments.length} thoughts`);
  }

  private transcriptionHints(): string[] {
    const terms = this.db.prepare("SELECT term FROM memory WHERE kind = 'glossary' AND active = 1 AND term IS NOT NULL").all() as {
      term: string;
    }[];
    const names = this.db.prepare("SELECT name FROM users").all() as { name: string }[];
    return [...new Set([...terms.map((t) => t.term), ...names.map((n) => n.name)])].filter((t) => t.length <= 50);
  }

  private async handleFragment(
    rec: RecordingRow,
    f: ExtractedFragment,
    position: number,
    segments: Segment[],
    question?: { id: number; idea_id: number },
  ) {
    const db = this.db;
    const { start, end } = locateQuote(f.quote, segments);
    const fragmentId = Number(
      db
        .prepare(
          `INSERT INTO fragments (recording_id, position, title, quote, start_sec, end_sec, summary, interpretation, kind, commitment, clarity, missing_info, answers_question)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          rec.id,
          position,
          f.title,
          f.quote,
          start,
          end,
          f.summary,
          f.interpretation,
          f.kind,
          f.commitment,
          clampClarity(f.clarity),
          JSON.stringify(f.missing_info),
          f.answers_question ? 1 : 0,
        ).lastInsertRowid,
    );
    const thoughtText = `${f.title}\n${f.summary}\n${f.interpretation}`;
    await embedEntities(db, this.ai, [{ entity: "fragment", id: fragmentId, text: thoughtText }]).catch((e) =>
      console.warn("[embed] fragment", e.message),
    );

    // An answer to a clarification question goes straight to that idea.
    if (question && f.answers_question && getIdea(db, question.idea_id)) {
      await this.attach(fragmentId, question.idea_id, {
        decision: "answer",
        confidence: 1,
        reason: "Answer to a clarification question.",
      }, false);
      return;
    }

    const candidates = await similarIdeas(db, this.ai, thoughtText, { limit: 8 });
    let decision: RelateResult = {
      decision: "new_idea",
      target_idea_id: null,
      confidence: 1,
      reason: "No similar ideas in the library yet.",
      related: [],
    };
    if (candidates.length) {
      const rows = candidates
        .map((c) => {
          const idea = getIdea(db, c.ideaId);
          if (!idea) return null;
          const quotes = ideaFragments(db, idea.id)
            .slice(-3)
            .map((q) => q.quote.slice(0, 300));
          return { id: idea.id, title: idea.title, status: idea.status, summary: idea.summary, recent_quotes: quotes };
        })
        .filter(Boolean);
      decision = await this.llm().json(RelateResult, {
        purpose: "relate",
        ...this.system(),
        effort: "low",
        prompt: `${RELATE_INSTRUCTIONS}

<new_thought>
Title: ${f.title}
His words: "${f.quote}"
Summary: ${f.summary}
Interpretation: ${f.interpretation}
</new_thought>

<candidates>
${JSON.stringify(rows, null, 1)}
</candidates>`,
      });
      const ids = new Set(rows.map((r) => r!.id));
      if (decision.target_idea_id !== null && !ids.has(decision.target_idea_id)) {
        decision = { ...decision, decision: "new_idea", target_idea_id: null, confidence: 0.5 };
      }
      decision.related = decision.related.filter((r) => ids.has(r.idea_id) && r.idea_id !== decision.target_idea_id);
    }

    const confidence = Math.max(0, Math.min(1, decision.confidence));
    const target = decision.target_idea_id;
    let ideaId: number;
    if (decision.decision !== "new_idea" && target && confidence >= AUTO_ATTACH) {
      ideaId = target;
      await this.attach(fragmentId, target, decision, true);
    } else {
      ideaId = await this.newIdeaFromFragment(fragmentId, f, rec, decision);
      if (decision.decision !== "new_idea" && target && confidence >= SUGGEST) {
        const linkId = addLink(db, ideaId, target, "duplicate", { confidence, reason: decision.reason });
        if (linkId) {
          addReview(db, { kind: "possible_duplicate", ideaId, otherIdeaId: target, linkId, fragmentId, note: decision.reason });
        }
      }
    }

    for (const r of decision.related) {
      if (r.confidence < LINK_MIN) continue;
      const linkId = addLink(db, ideaId, r.idea_id, r.relation, { confidence: r.confidence, reason: r.reason });
      if (!linkId) continue;
      const open = db.prepare("SELECT 1 FROM review_items WHERE link_id = ? AND status = 'open'").get(linkId);
      if (!open) {
        addReview(db, {
          kind: r.relation === "conflicts" ? "conflict" : "possible_link",
          ideaId,
          otherIdeaId: r.idea_id,
          linkId,
          note: r.reason,
        });
      }
    }
  }

  private async newIdeaFromFragment(
    fragmentId: number,
    f: ExtractedFragment,
    rec: RecordingRow,
    decision: RelateResult,
  ): Promise<number> {
    const db = this.db;
    const card = await this.llm().json(IdeaCard, {
      purpose: "card",
      ...this.system(),
      effort: "medium",
      prompt: `${CARD_INSTRUCTIONS}

This is a newly captured idea.
<fragments>
[fragment #${fragmentId}, ${rec.captured_at}] "${f.quote}"
Summary: ${f.summary}
Interpretation: ${f.interpretation}
Missing info: ${f.missing_info.join("; ") || "none noted"}
Actions mentioned: ${f.mentioned_actions.join("; ") || "none"}
Suggested tags: ${f.tags.join(", ")}
</fragments>`,
    });
    if (!card.commitment) card.commitment = f.commitment;
    const ideaId = createIdea(db, card, { source: "recording", sourceId: rec.id, userId: rec.user_id });
    db.prepare("UPDATE fragments SET idea_id = ?, origin_idea_id = ?, link_decision = ? WHERE id = ?").run(
      ideaId,
      ideaId,
      JSON.stringify({ ...decision, applied: "new_idea" }),
      fragmentId,
    );
    indexIdea(db, ideaId);
    await embedIdea(db, this.ai, ideaId).catch(() => this.jobs.enqueue("embed_idea", { ideaId }, 60));
    addReview(db, { kind: "new_idea", ideaId, fragmentId });
    return ideaId;
  }

  // Attaches a thought to an existing idea and updates that idea's card.
  async attach(
    fragmentId: number,
    ideaId: number,
    decision: { decision: string; confidence: number; reason: string },
    reviewable: boolean,
  ) {
    const db = this.db;
    db.prepare("UPDATE fragments SET idea_id = ?, origin_idea_id = COALESCE(origin_idea_id, ?), link_decision = ? WHERE id = ?").run(
      ideaId,
      ideaId,
      JSON.stringify({ ...decision, applied: "attached" }),
      fragmentId,
    );
    const idea = getIdea(db, ideaId)!;
    if (reviewable) {
      const revived = idea.status === "archived" || idea.status === "completed";
      addReview(db, {
        kind: "auto_linked",
        ideaId,
        fragmentId,
        note: revived ? `He brought back an idea that was ${idea.status}. ${decision.reason}` : decision.reason,
      });
    }
    await this.refreshCard(ideaId, "New recording added.", fragmentId);
  }

  // Rebuilds an idea's card from all of its fragments (newest information wins).
  async refreshCard(ideaId: number, reason: string, sourceFragmentId?: number) {
    const db = this.db;
    const idea = getIdea(db, ideaId);
    if (!idea) return;
    db.prepare("UPDATE ideas SET busy = 'card' WHERE id = ?").run(ideaId);
    try {
      const frags = ideaFragments(db, ideaId);
      const card = safeJson<StoredCard>(idea.card, {});
      const answers = db
        .prepare("SELECT text, answer_text FROM questions WHERE idea_id = ? AND status = 'answered'")
        .all(ideaId) as { text: string; answer_text: string }[];
      const notes = db
        .prepare("SELECT n.body, u.name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.idea_id = ? ORDER BY n.id DESC LIMIT 10")
        .all(ideaId) as { body: string; name: string }[];
      const next = await this.llm().json(IdeaCard, {
        purpose: "card",
        ...this.system(),
        effort: "medium",
        prompt: `${CARD_INSTRUCTIONS}

This is an UPDATE to an existing idea (${reason}). Rewrite the full card using everything below.
<current_title>${idea.title}</current_title>
<current_card>
${JSON.stringify({ ...card, edited: undefined }, null, 1)}
</current_card>
${card.edited?.length ? `Fields corrected by hand (authoritative, keep their meaning): ${card.edited.join(", ")}\n` : ""}
<fragments>
${frags.map((f) => `[fragment #${f.id}, ${f.captured_at}${f.id === sourceFragmentId ? ", NEW" : ""}] "${f.quote}"\nInterpretation: ${f.interpretation ?? ""}`).join("\n\n")}
</fragments>
${answers.length ? `<answers>\n${answers.map((a) => `Q: ${a.text}\nA: ${a.answer_text}`).join("\n")}\n</answers>` : ""}
${notes.length ? `<team_notes>\n${notes.map((n) => `${n.name}: ${n.body}`).join("\n")}\n</team_notes>` : ""}`,
      });
      const source = sourceFragmentId ? "recording" : "merge";
      const sourceId = sourceFragmentId
        ? (db.prepare("SELECT recording_id FROM fragments WHERE id = ?").get(sourceFragmentId) as { recording_id: number }).recording_id
        : undefined;
      applyCard(db, ideaId, next, { source, sourceId });
      await embedIdea(db, this.ai, ideaId).catch(() => this.jobs.enqueue("embed_idea", { ideaId }, 60));
    } finally {
      this.clearBusy(ideaId);
    }
  }

  // Undo for automatic linking: a thought moves to another idea, or becomes its own.
  async moveFragment(fragmentId: number, targetIdeaId: number | null, userId: number | null) {
    const db = this.db;
    const frag = db.prepare("SELECT * FROM fragments WHERE id = ?").get(fragmentId) as
      | { id: number; recording_id: number; idea_id: number | null; title: string; quote: string; summary: string; interpretation: string | null; commitment: string; clarity: number | null; missing_info: string | null }
      | undefined;
    if (!frag) return;
    const oldIdeaId = frag.idea_id;
    if (targetIdeaId) {
      await this.attach(fragmentId, targetIdeaId, { decision: "moved_by_person", confidence: 1, reason: "Moved by hand." }, false);
    } else {
      const rec = db.prepare("SELECT * FROM recordings WHERE id = ?").get(frag.recording_id) as RecordingRow;
      db.prepare("UPDATE fragments SET idea_id = NULL WHERE id = ?").run(fragmentId);
      await this.newIdeaFromFragment(
        fragmentId,
        {
          title: frag.title,
          quote: frag.quote,
          kind: "idea",
          summary: frag.summary,
          interpretation: frag.interpretation ?? "",
          commitment: frag.commitment as ExtractedFragment["commitment"],
          clarity: frag.clarity ?? 3,
          missing_info: safeJson<string[]>(frag.missing_info, []),
          mentioned_actions: [],
          tags: [],
          answers_question: false,
        },
        rec,
        { decision: "new_idea", target_idea_id: null, confidence: 1, reason: "Separated by hand.", related: [] },
      );
    }
    logActivity(db, userId, "move_fragment", "fragment", fragmentId, `${oldIdeaId ?? "-"} → ${targetIdeaId ?? "new"}`);
    if (oldIdeaId && oldIdeaId !== targetIdeaId) {
      const remaining = (db.prepare("SELECT COUNT(*) AS n FROM fragments WHERE idea_id = ?").get(oldIdeaId) as { n: number }).n;
      if (remaining > 0) await this.refreshCard(oldIdeaId, "A recording was moved out of this idea.");
      else setStatus(db, oldIdeaId, "archived", userId);
    }
  }

  // ------------------------------------------------------------- reports etc.

  private ideaDossier(ideaId: number): string {
    const db = this.db;
    const idea = getIdea(db, ideaId)!;
    const frags = ideaFragments(db, ideaId);
    const answers = db
      .prepare("SELECT text, answer_text FROM questions WHERE idea_id = ? AND status = 'answered'")
      .all(ideaId) as { text: string; answer_text: string }[];
    const links = db
      .prepare(
        `SELECT l.type, i.id, i.title, i.summary FROM links l JOIN ideas i ON i.id = CASE WHEN l.idea_a = ? THEN l.idea_b ELSE l.idea_a END
         WHERE (l.idea_a = ? OR l.idea_b = ?) AND l.status = 'confirmed'`,
      )
      .all(ideaId, ideaId, ideaId) as { type: string; id: number; title: string; summary: string }[];
    const notes = db
      .prepare("SELECT n.body, u.name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.idea_id = ? ORDER BY n.id")
      .all(ideaId) as { body: string; name: string }[];
    return `<idea id="${idea.id}" status="${idea.status}">
<title>${idea.title}</title>
<card>
${JSON.stringify({ summary: idea.summary, ...safeJson<StoredCard>(idea.card, {}), edited: undefined }, null, 1)}
</card>
<fragments>
${frags.map((f) => `[fragment #${f.id}, ${f.captured_at}] "${f.quote}"`).join("\n\n")}
</fragments>
${answers.length ? `<answers>\n${answers.map((a) => `Q: ${a.text}\nA: ${a.answer_text}`).join("\n")}\n</answers>` : ""}
${links.length ? `<connected_ideas>\n${links.map((l) => `#${l.id} (${l.type}) ${l.title}: ${l.summary}`).join("\n")}\n</connected_ideas>` : ""}
${notes.length ? `<team_notes>\n${notes.map((n) => `${n.name}: ${n.body}`).join("\n")}\n</team_notes>` : ""}
</idea>`;
  }

  async generateReport(ideaId: number) {
    const idea = getIdea(this.db, ideaId);
    if (!idea) return;
    this.db.prepare("UPDATE ideas SET busy = 'report' WHERE id = ?").run(ideaId);
    try {
      const report = await this.llm().json(Report, {
        purpose: "report",
        ...this.system(),
        effort: "high",
        prompt: `${REPORT_INSTRUCTIONS}\n\n${this.ideaDossier(ideaId)}`,
      });
      const validIds = new Set(ideaFragments(this.db, ideaId).map((f) => f.id));
      for (const v of Object.values(report)) {
        if (v && typeof v === "object" && "points" in v) {
          for (const p of v.points) p.fragment_ids = p.fragment_ids.filter((id) => validIds.has(id));
        }
      }
      this.db.prepare("UPDATE ideas SET report = ?, report_version = version WHERE id = ?").run(JSON.stringify(report), ideaId);
      indexIdea(this.db, ideaId);
    } finally {
      this.clearBusy(ideaId);
    }
  }

  async generateScore(ideaId: number) {
    const idea = getIdea(this.db, ideaId);
    if (!idea) return;
    this.db.prepare("UPDATE ideas SET busy = 'score' WHERE id = ?").run(ideaId);
    try {
      const score = await this.llm().json(Score, {
        purpose: "score",
        ...this.system(),
        effort: "high",
        prompt: `${SCORE_INSTRUCTIONS}\n\n${this.ideaDossier(ideaId)}`,
      });
      for (const k of ["value", "feasibility", "cost", "complexity", "strategic_fit", "effort"] as const) {
        score[k].score = Math.max(1, Math.min(5, Math.round(score[k].score)));
      }
      this.db.prepare("UPDATE ideas SET score = ?, score_version = version WHERE id = ?").run(JSON.stringify(score), ideaId);
    } finally {
      this.clearBusy(ideaId);
    }
  }

  async generatePlan(projectId: number) {
    const db = this.db;
    const project = db.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as
      | { id: number; name: string; description: string | null }
      | undefined;
    if (!project) return;
    db.prepare("UPDATE projects SET plan_status = 'generating' WHERE id = ?").run(projectId);
    const ideas = db.prepare("SELECT id FROM ideas WHERE project_id = ?").all(projectId) as { id: number }[];
    const today = new Date().toISOString().slice(0, 10);
    const plan = await this.llm().json(Plan, {
      purpose: "plan",
      ...this.system(),
      effort: "high",
      prompt: `${PLAN_INSTRUCTIONS}

Today is ${today}.
<project name="${project.name}">${project.description ?? ""}</project>
${ideas.map((i) => this.ideaDossier(i.id)).join("\n\n")}`,
    });
    db.prepare("UPDATE projects SET plan = ?, plan_status = 'draft', updated_at = datetime('now') WHERE id = ?").run(
      JSON.stringify(plan),
      projectId,
    );
    addReview(db, { kind: "plan", ideaId: ideas[0]?.id ?? null, note: `Draft plan ready for "${project.name}"` });
    notifyRole(db, "organizer", { title: "Draft plan ready", body: project.name, url: `#/projects/${projectId}` });
  }
}

// Finds where a quote sits in the timed transcript so the UI can play that part.
export function locateQuote(quote: string, segments: Segment[]): { start: number | null; end: number | null } {
  if (!segments.length || !quote) return { start: null, end: null };
  const norm = (s: string) =>
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
  const q = norm(quote);
  if (!q.length) return { start: null, end: null };
  // Flatten segment words with the segment index they belong to.
  const flat: { w: string; seg: number }[] = [];
  segments.forEach((s, i) => norm(s.text).forEach((w) => flat.push({ w, seg: i })));
  const head = q.slice(0, Math.min(6, q.length));
  const tail = q.slice(-Math.min(6, q.length));
  const find = (needle: string[], from = 0): number => {
    let best = -1;
    let bestScore = 0;
    for (let i = from; i <= flat.length - needle.length; i++) {
      let s = 0;
      for (let j = 0; j < needle.length; j++) if (flat[i + j].w === needle[j]) s++;
      if (s > bestScore) {
        bestScore = s;
        best = i;
        if (s === needle.length) break;
      }
    }
    return bestScore >= Math.ceil(needle.length * 0.6) ? best : -1;
  };
  const s = find(head);
  if (s < 0) return { start: null, end: null };
  const e = find(tail, s);
  const startSeg = flat[s].seg;
  const endSeg = e >= 0 ? flat[e + tail.length - 1].seg : startSeg;
  return { start: segments[startSeg].start, end: segments[Math.max(startSeg, endSeg)].end };
}

// Queues the full report and evaluation unless they are already current.
export function scheduleReportAndScore(db: DB, jobs: JobQueue, ideaId: number, force = false) {
  const idea = getIdea(db, ideaId);
  if (!idea) return;
  let queued = false;
  if (force || idea.report_version !== idea.version) {
    jobs.enqueue("report", { ideaId });
    queued = true;
  }
  if (force || idea.score_version !== idea.version) {
    jobs.enqueue("score", { ideaId });
    queued = true;
  }
  if (queued) db.prepare("UPDATE ideas SET busy = COALESCE(busy, 'report') WHERE id = ?").run(ideaId);
}
