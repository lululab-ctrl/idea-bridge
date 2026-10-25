import type { z } from "zod/v4";
import type { CallOptions, LLM } from "./llm.ts";
import type { Transcriber, Transcript } from "./speech.ts";
import { estimateSegments } from "./speech.ts";

// Deterministic stand-ins for the AI services, used by automated tests only.

function tag(prompt: string, name: string): string {
  const m = prompt.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : "";
}

function words(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 3),
  );
}

function overlap(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

function titleFrom(text: string): string {
  return text.replace(/[^\p{L}\p{N}\s]/gu, "").split(/\s+/).slice(0, 6).join(" ") || "Untitled thought";
}

const section = (text: string, ids: number[]) => ({
  coverage: "thin" as const,
  points: [{ label: "interpreted" as const, text, fragment_ids: ids }],
});

export class MockLLM implements LLM {
  json<S extends z.ZodType>(schema: S, opts: CallOptions): Promise<z.infer<S>> {
    const p = opts.prompt;
    let out: unknown;
    switch (opts.purpose) {
      case "extract": {
        const transcript = tag(p, "transcript");
        const parts = transcript
          .split(/\b(?:another idea|also|second thing|and another thing)\b[,:]?/i)
          .map((s) => s.trim())
          .filter((s) => s.length > 8);
        out = {
          recording_summary: `Mock summary: ${transcript.slice(0, 60)}`,
          language: "English",
          fragments: parts.map((part) => ({
            title: titleFrom(part),
            quote: part,
            kind: "idea",
            summary: `He said: ${part}`,
            interpretation: `Mock interpretation of "${part.slice(0, 40)}"`,
            commitment: /\bwe will|decided|doing this\b/i.test(part) ? "decision" : "brainstorm",
            clarity: part.length > 60 ? 4 : 2,
            missing_info: part.length > 60 ? [] : ["Who is it for?"],
            mentioned_actions: [],
            tags: [...words(part)].slice(0, 3),
            answers_question: !!tag(p, "question"),
            search_terms: [...words(part)].slice(0, 8),
          })),
        };
        break;
      }
      case "relate": {
        const thought = tag(p, "new_thought");
        const candidates = JSON.parse(tag(p, "candidates") || "[]") as { id: number; title: string; summary: string }[];
        let best: { id: number; s: number } | null = null;
        for (const c of candidates) {
          const s = overlap(thought, `${c.title} ${c.summary}`);
          if (!best || s > best.s) best = { id: c.id, s };
        }
        if (best && best.s >= 0.6) {
          out = { decision: "adds_to_existing", target_idea_id: best.id, confidence: 0.9, reason: "Mock: strong word overlap.", related: [] };
        } else if (best && best.s >= 0.35) {
          out = { decision: "adds_to_existing", target_idea_id: best.id, confidence: 0.6, reason: "Mock: partial overlap.", related: [] };
        } else {
          out = {
            decision: "new_idea",
            target_idea_id: null,
            confidence: 0.8,
            reason: "Mock: no strong overlap.",
            related: best && best.s > 0.2 ? [{ idea_id: best.id, relation: "related", confidence: 0.55, reason: "Mock: shared words." }] : [],
          };
        }
        break;
      }
      case "card": {
        const frags = tag(p, "fragments");
        const existingTitle = tag(p, "current_title");
        const first = frags.split("\n").find((l) => l.trim()) ?? "Idea";
        out = {
          title: existingTitle || titleFrom(first.replace(/^\[.*?\]\s*/, "")),
          summary: `Mock card summary based on: ${frags.slice(0, 160)}`,
          vision: "Mock vision.",
          problem: null,
          how_it_works: null,
          audience: null,
          business_model: null,
          challenges: ["Mock challenge"],
          next_steps: ["Mock next step"],
          open_questions: [{ question: "Who is the first customer?", ask_him: "Who would buy this first?", why: "Shapes everything." }],
          missing_info: ["Audience"],
          clarity: 3,
          commitment: "brainstorm",
          tags: ["mock"],
          change_summary: existingTitle ? "Mock: added new details." : "First captured.",
        };
        break;
      }
      case "report": {
        const ids = (p.match(/fragment #(\d+)/g) ?? []).map((m) => Number(m.replace(/\D/g, "")));
        out = {
          translation: "Mock translation of what he means.",
          confidence_note: "Mock confidence note.",
          summary: { coverage: "covered", points: [{ label: "said", text: "Mock said point.", fragment_ids: ids.slice(0, 1) }] },
          vision: section("Mock vision.", ids),
          problem: section("Mock problem.", ids),
          how_it_works: section("Mock mechanics.", ids),
          audience: { coverage: "not_mentioned", points: [] },
          business_model: { coverage: "not_mentioned", points: [{ label: "suggested", text: "Mock model.", fragment_ids: [] }] },
          feasibility: section("Mock feasibility.", []),
          next_steps: { coverage: "thin", points: [{ label: "suggested", text: "Mock step.", fragment_ids: [] }] },
          open_questions: { coverage: "thin", points: [{ label: "suggested", text: "Mock question?", fragment_ids: [] }] },
        };
        break;
      }
      case "score": {
        const c = (score: number) => ({ score, reason: "Mock reason." });
        out = {
          value: c(4),
          feasibility: c(3),
          cost: c(3),
          complexity: c(2),
          strategic_fit: c(3),
          effort: c(3),
          overall_take: "Mock take.",
          biggest_unknown: "Mock unknown.",
          cheapest_test: "Mock test.",
        };
        break;
      }
      case "plan":
        out = {
          goal: "Mock goal",
          definition_of_done: "Mock done",
          milestones: [
            { name: "Validate", outcome: "Know if people want it", target_offset_days: 7 },
            { name: "Launch", outcome: "First version live", target_offset_days: 30 },
          ],
          tasks: [
            { milestone: "Validate", title: "Talk to 5 potential customers", instructions: "Mock instructions.", expected_outcome: "Notes from 5 calls", priority: "high", due_offset_days: 5, owner: "organizer" },
            { milestone: "Validate", title: "Decide the price", instructions: "Mock.", expected_outcome: "A price", priority: "medium", due_offset_days: 7, owner: "visionary" },
            { milestone: "Launch", title: "Build landing page", instructions: "Mock.", expected_outcome: "Live page", priority: "medium", due_offset_days: 20, owner: "either" },
          ],
          risks: ["Mock risk"],
          first_step_today: "Mock first step",
        };
        break;
      case "insights": {
        const ids = (p.match(/#(\d+)/g) ?? []).map((m) => Number(m.slice(1)));
        out = {
          overview: "Mock overview of the period.",
          patterns: ids.length ? [{ title: "Mock pattern", explanation: "Mock.", idea_ids: ids.slice(0, 2) }] : [],
          promising: ids.length ? [{ idea_id: ids[0], why: "Mock." }] : [],
          conflicts: [],
          combinations: [],
          themes: ids.length ? [{ name: "Mock theme", description: "Mock.", idea_ids: ids }] : [],
        };
        break;
      }
      case "digest":
        out = { headline: "Mock headline", overview: "Mock overview.", attention: [{ text: "Mock attention item", idea_id: null }] };
        break;
      case "query_terms": {
        const q = tag(p, "query");
        // Pretend the AI knows a synonym, to exercise meaning-based search.
        const extra = /\bpets?\b/i.test(q) ? ["dog", "walkers"] : [];
        out = { terms: [...words(q), ...extra] };
        break;
      }
      default:
        throw new Error(`MockLLM has no canned output for purpose "${opts.purpose}"`);
    }
    return Promise.resolve(schema.parse(out));
  }

  text(opts: CallOptions): Promise<string> {
    if (opts.purpose === "ask") {
      const ids = (opts.prompt.match(/\[#(\d+)\]/g) ?? []).slice(0, 2);
      return Promise.resolve(`Mock answer based on ${ids.join(" ") || "nothing relevant"}.`);
    }
    return Promise.resolve(`# Mock ${opts.purpose}\n\nMock document body.`);
  }
}

// Tests upload a text file pretending to be audio; its contents are the "speech".
export class MockTranscriber implements Transcriber {
  name = "mock";
  async transcribe(url: string): Promise<Transcript> {
    const res = await fetch(url);
    const raw = new Uint8Array(await res.arrayBuffer());
    const isText = raw.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127) || b >= 128);
    const text = isText ? new TextDecoder().decode(raw).trim() : "This is a mock transcript of a real audio recording.";
    const duration = Math.max(3, Math.round(text.length / 15));
    return { text, language: "en", duration, segments: estimateSegments(text, duration), timed: false, provider: "mock" };
  }
}
