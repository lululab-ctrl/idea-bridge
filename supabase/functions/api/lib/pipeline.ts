import { type AI, requireLLM } from "./ai/index.ts";
import { AIError } from "./ai/llm.ts";
import {
  baseSystem,
  CARD_INSTRUCTIONS,
  EXTRACT_INSTRUCTIONS,
  PLAN_INSTRUCTIONS,
  RELATE_INSTRUCTIONS,
  REPORT_INSTRUCTIONS,
  SCORE_INSTRUCTIONS,
  sharedContext,
} from "./ai/prompts.ts";
import { ExtractResult, IdeaCard, Plan, Report, RelateResult, Score, type ExtractedFragment } from "./ai/schemas.ts";
import { estimateSegments, extForMime, type Segment } from "./ai/speech.ts";
import type { DB } from "./db.ts";
import { logActivity, safeJson } from "./db.ts";
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
} from "./ideas.ts";
import type { JobQueue } from "./jobs.ts";
import { notifyRole } from "./notify.ts";
import { indexIdea, indexRecording, similarIdeas } from "./search.ts";
import { storage } from "./storage.ts";

// When a new thought clearly continues an existing idea (confidence >= AUTO_ATTACH)
// it is attached automatically (visible in the review queue and undoable).
// Between SUGGEST and AUTO_ATTACH it becomes its own idea plus a "possible
// duplicate" for the admin to decide. Below SUGGEST it is new.
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
  deleted_at: string | null;
}

type Question = { id: number; text: string; idea_id: number; title: string } | undefined;

export class Pipeline {
  constructor(
    private db: DB,
    private ai: AI,
    private jobs: JobQueue,
  ) {
    const failRecording = async (p: Record<string, unknown>, error: string) => {
      await db.run("UPDATE recordings SET status = 'failed', error = ? WHERE id = ?", error, Number(p.recordingId));
    };
    jobs.register("process_recording", (p) => this.transcribe(Number(p.recordingId)), failRecording);
    jobs.register("analyze_recording", (p) => this.analyze(Number(p.recordingId)), failRecording);
    jobs.register("handle_fragment", (p) => this.handleFragment(Number(p.recordingId), Number(p.position)), failRecording);
    jobs.register("refresh_card", (p) => this.refreshCard(Number(p.ideaId), String(p.reason ?? "Updated.")));
    jobs.register("report", (p) => this.generateReport(Number(p.ideaId)));
    jobs.register("score", (p) => this.generateScore(Number(p.ideaId)));
    jobs.register("plan", (p) => this.generatePlan(Number(p.projectId)), async (p) => {
      await db.run("UPDATE projects SET plan_status = 'failed' WHERE id = ?", Number(p.projectId));
    });
    jobs.register("move_fragment", (p) => this.moveFragment(Number(p.fragmentId), p.ideaId ? Number(p.ideaId) : null, (p.userId as number) ?? null));
  }

  private async system() {
    return { system: await baseSystem(this.db), context: await sharedContext(this.db) };
  }

  private recording(id: number) {
    return this.db.get<RecordingRow>("SELECT * FROM recordings WHERE id = ?", id);
  }

  // ------------------------------------------------------------ step 1: transcribe
  async transcribe(id: number) {
    const db = this.db;
    const rec = await this.recording(id);
    if (!rec || rec.deleted_at || rec.status === "done" || rec.status === "uploading") return;
    await db.run("UPDATE recordings SET error = NULL WHERE id = ?", id);
    if (rec.transcript === null) {
      if (!rec.audio_path) throw new AIError("The audio file is missing.", false);
      if (!this.ai.transcriber) throw new AIError("Transcription is not set up yet. The admin can add the Groq key in Settings → System.", true, 3600);
      await db.run("UPDATE recordings SET status = 'transcribing' WHERE id = ?", id);
      const url = await storage().signedUrl("audio", rec.audio_path, 3600);
      const t = await this.ai.transcriber.transcribe(url, `recording.${extForMime(rec.mime ?? "audio/webm")}`, await this.hints());
      const duration = t.duration ?? rec.duration_sec;
      const segments: Segment[] = t.timed ? t.segments : estimateSegments(t.text, duration);
      await db.run(
        "UPDATE recordings SET transcript = ?, segments = ?, language = ?, duration_sec = COALESCE(duration_sec, ?), transcribed_by = ? WHERE id = ?",
        t.text,
        JSON.stringify({ timed: t.timed, segments }),
        t.language,
        duration,
        t.provider,
        id,
      );
      await indexRecording(db, id);
    }
    await this.jobs.enqueue("analyze_recording", { recordingId: id });
  }

  private async hints(): Promise<string[]> {
    const terms = await this.db.all<{ term: string }>("SELECT term FROM memory WHERE kind = 'glossary' AND active = 1 AND term IS NOT NULL");
    const names = await this.db.all<{ name: string }>("SELECT name FROM users");
    return [...new Set([...terms.map((t) => t.term), ...names.map((n) => n.name)])].filter((t) => t.length <= 50);
  }

  private question(rec: RecordingRow): Promise<Question> {
    if (!rec.question_id) return Promise.resolve(undefined);
    return this.db.get("SELECT q.id, q.text, q.idea_id, i.title FROM questions q JOIN ideas i ON i.id = q.idea_id WHERE q.id = ?", rec.question_id);
  }

  // -------------------------------------------------------- step 2: find thoughts
  async analyze(id: number) {
    const db = this.db;
    const rec = await this.recording(id);
    if (!rec || rec.deleted_at || rec.status === "done") return;
    const transcript = (rec.transcript ?? "").trim();
    if (transcript.split(/\s+/).filter(Boolean).length < 3) {
      await db.run("UPDATE recordings SET status = 'done', summary = ? WHERE id = ?", "No speech detected.", id);
      return;
    }
    await db.run("UPDATE recordings SET status = 'analyzing' WHERE id = ?", id);
    let analysis = safeJson<ExtractResult | null>(rec.analysis, null);
    if (!analysis) {
      const question = await this.question(rec);
      analysis = await requireLLM(this.ai).json(ExtractResult, {
        purpose: "extract",
        ...(await this.system()),
        effort: "medium",
        prompt: `${EXTRACT_INSTRUCTIONS}
${question ? `\nThis recording was made to answer a clarification question about the idea "${question.title}".\n<question>${question.text}</question>\nMark fragments that answer it with answers_question = true.\n` : ""}
Recorded: ${rec.captured_at} (UTC)
<transcript>
${transcript}
</transcript>`,
      });
      await db.run(
        "UPDATE recordings SET analysis = ?, summary = ?, language = COALESCE(language, ?) WHERE id = ?",
        JSON.stringify(analysis),
        analysis.recording_summary,
        analysis.language,
        id,
      );
    }
    if (!analysis.fragments.length) return this.finish(id);
    for (let i = 0; i < analysis.fragments.length; i++) await this.jobs.enqueue("handle_fragment", { recordingId: id, position: i });
  }

  // ------------------------------------------- step 3: connect each thought to ideas
  async handleFragment(recordingId: number, position: number) {
    const db = this.db;
    const rec = await this.recording(recordingId);
    if (!rec || rec.deleted_at) return;
    const analysis = safeJson<ExtractResult | null>(rec.analysis, null);
    const f = analysis?.fragments[position];
    if (!f) return;
    const already = await db.get("SELECT id FROM fragments WHERE recording_id = ? AND position = ?", recordingId, position);
    if (!already) {
      const segments = safeJson<{ segments: Segment[] }>(rec.segments, { segments: [] }).segments;
      await this.placeFragment(rec, f, position, segments, await this.question(rec));
    }
    const done = await db.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM fragments WHERE recording_id = ?", recordingId);
    if ((done?.n ?? 0) >= analysis!.fragments.length) await this.finish(recordingId);
  }

  private async finish(id: number) {
    const db = this.db;
    const rec = await this.recording(id);
    if (!rec || rec.status === "done") return;
    const analysis = safeJson<ExtractResult | null>(rec.analysis, null);
    const question = await this.question(rec);
    const answers = analysis?.fragments.filter((f) => f.answers_question) ?? [];
    if (question && answers.length) {
      await db.run(
        "UPDATE questions SET status = 'answered', answer_recording_id = ?, answer_text = ?, answered_at = now_text() WHERE id = ?",
        id,
        answers.map((f) => f.summary).join(" "),
        question.id,
      );
      if ((await getIdea(db, question.idea_id))?.status === "needs_clarification") await setStatus(db, question.idea_id, "under_review", null);
      await addReview(db, { kind: "answer", ideaId: question.idea_id, note: `Answered: "${question.text}"` });
    }
    await db.run("UPDATE recordings SET status = 'done' WHERE id = ?", id);
    await logActivity(db, rec.user_id, "processed", "recording", id, `${analysis?.fragments.length ?? 0} thoughts`);
  }

  private async placeFragment(rec: RecordingRow, f: ExtractedFragment, position: number, segments: Segment[], question: Question) {
    const db = this.db;
    const { start, end } = locateQuote(f.quote, segments);
    const fragmentId = await db.insert(
      `INSERT INTO fragments (recording_id, position, title, quote, start_sec, end_sec, summary, interpretation, kind, commitment, clarity, missing_info, search_terms, answers_question)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      JSON.stringify(f.search_terms ?? []),
      f.answers_question ? 1 : 0,
    );

    if (question && f.answers_question && (await getIdea(db, question.idea_id))) {
      await this.attach(fragmentId, question.idea_id, { decision: "answer", confidence: 1, reason: "Answer to a clarification question." }, false);
      return;
    }

    const candidateIds = await similarIdeas(db, [f.title, f.summary, ...(f.search_terms ?? [])], { limit: 10 });
    let decision: RelateResult = { decision: "new_idea", target_idea_id: null, confidence: 1, reason: "No similar ideas in the library yet.", related: [] };
    if (candidateIds.length) {
      const rows = [];
      for (const cid of candidateIds) {
        const idea = await getIdea(db, cid);
        if (!idea) continue;
        const quotes = (await ideaFragments(db, idea.id)).slice(-2).map((q) => q.quote.slice(0, 280));
        rows.push({ id: idea.id, title: idea.title, status: idea.status, summary: idea.summary, recent_quotes: quotes });
      }
      decision = await requireLLM(this.ai).json(RelateResult, {
        purpose: "relate",
        ...(await this.system()),
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
      const ids = new Set(rows.map((r) => r.id));
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
        const linkId = await addLink(db, ideaId, target, "duplicate", { confidence, reason: decision.reason });
        if (linkId) await addReview(db, { kind: "possible_duplicate", ideaId, otherIdeaId: target, linkId, fragmentId, note: decision.reason });
      }
    }
    for (const r of decision.related) {
      if (r.confidence < LINK_MIN) continue;
      const linkId = await addLink(db, ideaId, r.idea_id, r.relation, { confidence: r.confidence, reason: r.reason });
      if (!linkId) continue;
      if (!(await db.get("SELECT 1 FROM review_items WHERE link_id = ? AND status = 'open'", linkId))) {
        await addReview(db, { kind: r.relation === "conflicts" ? "conflict" : "possible_link", ideaId, otherIdeaId: r.idea_id, linkId, note: r.reason });
      }
    }
  }

  private async newIdeaFromFragment(fragmentId: number, f: ExtractedFragment, rec: RecordingRow, decision: RelateResult): Promise<number> {
    const db = this.db;
    const card = await requireLLM(this.ai).json(IdeaCard, {
      purpose: "card",
      ...(await this.system()),
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
    const ideaId = await createIdea(db, card, { source: "recording", sourceId: rec.id, userId: rec.user_id });
    await db.run(
      "UPDATE fragments SET idea_id = ?, origin_idea_id = ?, link_decision = ? WHERE id = ?",
      ideaId,
      ideaId,
      JSON.stringify({ ...decision, applied: "new_idea" }),
      fragmentId,
    );
    await indexIdea(db, ideaId);
    await addReview(db, { kind: "new_idea", ideaId, fragmentId });
    return ideaId;
  }

  async attach(fragmentId: number, ideaId: number, decision: { decision: string; confidence: number; reason: string }, reviewable: boolean) {
    const db = this.db;
    await db.run(
      "UPDATE fragments SET idea_id = ?, origin_idea_id = COALESCE(origin_idea_id, ?), link_decision = ? WHERE id = ?",
      ideaId,
      ideaId,
      JSON.stringify({ ...decision, applied: "attached" }),
      fragmentId,
    );
    const idea = (await getIdea(db, ideaId))!;
    if (reviewable) {
      const revived = idea.status === "archived" || idea.status === "completed";
      await addReview(db, {
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
    const idea = await getIdea(db, ideaId);
    if (!idea) return;
    const frags = await ideaFragments(db, ideaId);
    const card = safeJson<StoredCard>(idea.card, {});
    const answers = await db.all<{ text: string; answer_text: string }>("SELECT text, answer_text FROM questions WHERE idea_id = ? AND status = 'answered'", ideaId);
    const notes = await db.all<{ body: string; name: string }>(
      "SELECT n.body, u.name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.idea_id = ? ORDER BY n.id DESC LIMIT 10",
      ideaId,
    );
    const next = await requireLLM(this.ai).json(IdeaCard, {
      purpose: "card",
      ...(await this.system()),
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
    let sourceId: number | undefined;
    if (sourceFragmentId) sourceId = (await db.get<{ recording_id: number }>("SELECT recording_id FROM fragments WHERE id = ?", sourceFragmentId))?.recording_id;
    await applyCard(db, ideaId, next, { source: sourceFragmentId ? "recording" : "merge", sourceId });
  }

  // Undo for automatic linking: a thought moves to another idea, or becomes its own.
  async moveFragment(fragmentId: number, targetIdeaId: number | null, userId: number | null) {
    const db = this.db;
    const frag = await db.get<{
      id: number;
      recording_id: number;
      idea_id: number | null;
      title: string;
      quote: string;
      summary: string;
      interpretation: string | null;
      commitment: string;
      clarity: number | null;
      missing_info: string | null;
    }>("SELECT * FROM fragments WHERE id = ?", fragmentId);
    if (!frag) return;
    const oldIdeaId = frag.idea_id;
    if (targetIdeaId) {
      await this.attach(fragmentId, targetIdeaId, { decision: "moved_by_person", confidence: 1, reason: "Moved by hand." }, false);
    } else {
      const rec = (await this.recording(frag.recording_id))!;
      await db.run("UPDATE fragments SET idea_id = NULL WHERE id = ?", fragmentId);
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
          search_terms: [],
        },
        rec,
        { decision: "new_idea", target_idea_id: null, confidence: 1, reason: "Separated by hand.", related: [] },
      );
    }
    await logActivity(db, userId, "move_fragment", "fragment", fragmentId, `${oldIdeaId ?? "-"} → ${targetIdeaId ?? "new"}`);
    if (oldIdeaId && oldIdeaId !== targetIdeaId) {
      const remaining = await db.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM fragments WHERE idea_id = ?", oldIdeaId);
      if ((remaining?.n ?? 0) > 0) await this.jobs.enqueue("refresh_card", { ideaId: oldIdeaId, reason: "A recording was moved out of this idea." });
      else await setStatus(db, oldIdeaId, "archived", userId);
    }
  }

  // ------------------------------------------------------------ reports etc.
  async ideaDossier(ideaId: number): Promise<string> {
    const db = this.db;
    const idea = (await getIdea(db, ideaId))!;
    const frags = await ideaFragments(db, ideaId);
    const answers = await db.all<{ text: string; answer_text: string }>("SELECT text, answer_text FROM questions WHERE idea_id = ? AND status = 'answered'", ideaId);
    const links = await db.all<{ type: string; id: number; title: string; summary: string }>(
      `SELECT l.type, i.id, i.title, i.summary FROM links l JOIN ideas i ON i.id = CASE WHEN l.idea_a = ? THEN l.idea_b ELSE l.idea_a END
       WHERE (l.idea_a = ? OR l.idea_b = ?) AND l.status = 'confirmed'`,
      ideaId,
      ideaId,
      ideaId,
    );
    const notes = await db.all<{ body: string; name: string }>("SELECT n.body, u.name FROM notes n LEFT JOIN users u ON u.id = n.user_id WHERE n.idea_id = ? ORDER BY n.id", ideaId);
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
    if (!(await getIdea(this.db, ideaId))) return;
    const report = await requireLLM(this.ai).json(Report, {
      purpose: "report",
      ...(await this.system()),
      deep: true,
      effort: "medium",
      prompt: `${REPORT_INSTRUCTIONS}\n\n${await this.ideaDossier(ideaId)}`,
    });
    const validIds = new Set((await ideaFragments(this.db, ideaId)).map((f) => f.id));
    for (const v of Object.values(report)) {
      if (v && typeof v === "object" && "points" in v) for (const p of v.points) p.fragment_ids = p.fragment_ids.filter((id) => validIds.has(id));
    }
    await this.db.run("UPDATE ideas SET report = ?, report_version = version WHERE id = ?", JSON.stringify(report), ideaId);
    await indexIdea(this.db, ideaId);
  }

  async generateScore(ideaId: number) {
    if (!(await getIdea(this.db, ideaId))) return;
    const score = await requireLLM(this.ai).json(Score, {
      purpose: "score",
      ...(await this.system()),
      deep: true,
      effort: "medium",
      prompt: `${SCORE_INSTRUCTIONS}\n\n${await this.ideaDossier(ideaId)}`,
    });
    for (const k of ["value", "feasibility", "cost", "complexity", "strategic_fit", "effort"] as const) {
      score[k].score = Math.max(1, Math.min(5, Math.round(score[k].score)));
    }
    await this.db.run("UPDATE ideas SET score = ?, score_version = version WHERE id = ?", JSON.stringify(score), ideaId);
  }

  async generatePlan(projectId: number) {
    const db = this.db;
    const project = await db.get<{ id: number; name: string; description: string | null }>("SELECT * FROM projects WHERE id = ?", projectId);
    if (!project) return;
    await db.run("UPDATE projects SET plan_status = 'generating' WHERE id = ?", projectId);
    const ideas = await db.all<{ id: number }>("SELECT id FROM ideas WHERE project_id = ?", projectId);
    const today = new Date().toISOString().slice(0, 10);
    const dossiers = [];
    for (const i of ideas) dossiers.push(await this.ideaDossier(i.id));
    const plan = await requireLLM(this.ai).json(Plan, {
      purpose: "plan",
      ...(await this.system()),
      deep: true,
      effort: "medium",
      prompt: `${PLAN_INSTRUCTIONS}

Today is ${today}.
<project name="${project.name}">${project.description ?? ""}</project>
${dossiers.join("\n\n")}`,
    });
    await db.run("UPDATE projects SET plan = ?, plan_status = 'draft', updated_at = now_text() WHERE id = ?", JSON.stringify(plan), projectId);
    await addReview(db, { kind: "plan", ideaId: ideas[0]?.id ?? null, note: `Draft plan ready for "${project.name}"` });
    await notifyRole(db, "organizer", { title: "Draft plan ready", body: project.name, url: `#/projects/${projectId}` });
  }
}

// Finds where a quote sits in the timed transcript so the app can play that part.
export function locateQuote(quote: string, segments: Segment[]): { start: number | null; end: number | null } {
  if (!segments.length || !quote) return { start: null, end: null };
  const norm = (s: string) =>
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean);
  const q = norm(quote);
  if (!q.length) return { start: null, end: null };
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

export async function scheduleReportAndScore(db: DB, jobs: JobQueue, ideaId: number, force = false) {
  const idea = await getIdea(db, ideaId);
  if (!idea) return;
  if (force || idea.report_version !== idea.version) await jobs.enqueue("report", { ideaId });
  if (force || idea.score_version !== idea.version) await jobs.enqueue("score", { ideaId });
}
