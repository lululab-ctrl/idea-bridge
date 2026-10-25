import { z } from "zod/v4";

// Structured outputs the AI must return. Keep these schemas simple (no numeric
// bounds, few nullables) so they work with Claude's structured outputs; values
// are clamped/cleaned in code afterwards.

export const Commitment = z.enum(["brainstorm", "intention", "decision"]);
export type Commitment = z.infer<typeof Commitment>;

export const FragmentKind = z.enum(["idea", "update", "task", "question", "reflection"]);

// Step 1: split one recording into separate thoughts.
export const ExtractResult = z.object({
  recording_summary: z.string().describe("One sentence: what this recording is about overall."),
  language: z.string().describe("Main language spoken, e.g. 'English', 'Hebrew', 'Hebrew + English'."),
  fragments: z.array(
    z.object({
      title: z.string().describe("Short, specific name for this thought (max ~8 words)."),
      quote: z
        .string()
        .describe("His exact words for this thought, copied verbatim and contiguously from the transcript."),
      kind: FragmentKind,
      summary: z.string().describe("Plain restatement of what he actually said, 1-3 sentences."),
      interpretation: z
        .string()
        .describe("What he is most likely trying to achieve or communicate, in plain professional language."),
      commitment: Commitment,
      clarity: z.number().describe("1 = very unclear, 5 = crystal clear."),
      missing_info: z.array(z.string()).describe("Specific information needed before this could be acted on."),
      mentioned_actions: z.array(z.string()).describe("Concrete actions he mentioned, if any."),
      tags: z.array(z.string()).describe("2-5 short lowercase topic tags."),
      answers_question: z
        .boolean()
        .describe("True only if this passage answers the clarification question he was asked (if any)."),
    }),
  ),
});
export type ExtractResult = z.infer<typeof ExtractResult>;
export type ExtractedFragment = ExtractResult["fragments"][number];

// Step 2: decide how one new thought relates to existing ideas.
export const RelateResult = z.object({
  decision: z.enum(["new_idea", "adds_to_existing", "duplicate_of_existing"]),
  target_idea_id: z.number().nullable().describe("Existing idea id when decision is not new_idea; otherwise null."),
  confidence: z.number().describe("0.0-1.0 confidence in the decision."),
  reason: z.string().describe("One or two sentences explaining the decision, citing the overlap or difference."),
  related: z
    .array(
      z.object({
        idea_id: z.number(),
        relation: z.enum(["related", "builds_on", "conflicts", "combines"]),
        confidence: z.number(),
        reason: z.string(),
      }),
    )
    .describe("Other existing ideas this thought connects to (not the target)."),
});
export type RelateResult = z.infer<typeof RelateResult>;

// The living, structured understanding of one idea.
export const IdeaCard = z.object({
  title: z.string(),
  summary: z.string().describe("2-3 sentences: the idea as he described it, in plain language."),
  vision: z.string().nullable().describe("What he is ultimately trying to achieve. null if there is no basis."),
  problem: z.string().nullable(),
  how_it_works: z.string().nullable(),
  audience: z.string().nullable(),
  business_model: z.string().nullable(),
  challenges: z.array(z.string()),
  next_steps: z.array(z.string()),
  open_questions: z.array(
    z.object({
      question: z.string().describe("Question for the organizer's understanding."),
      ask_him: z.string().describe("Same question phrased casually and briefly, to be asked to him out loud."),
      why: z.string().describe("Why the answer matters."),
    }),
  ),
  missing_info: z.array(z.string()),
  clarity: z.number(),
  commitment: Commitment,
  tags: z.array(z.string()),
  change_summary: z
    .string()
    .describe("For an update: what changed and whether the direction shifted. For a new idea: 'First captured.'"),
});
export type IdeaCard = z.infer<typeof IdeaCard>;

const Point = z.object({
  label: z.enum(["said", "interpreted", "suggested"]),
  text: z.string(),
  fragment_ids: z.array(z.number()).describe("Fragments this point is grounded in (required for 'said')."),
});
export type ReportPoint = z.infer<typeof Point>;

const Section = z.object({
  coverage: z.enum(["covered", "thin", "not_mentioned"]),
  points: z.array(Point),
});
export type ReportSection = z.infer<typeof Section>;

export const REPORT_SECTIONS = [
  ["summary", "Idea summary"],
  ["vision", "Underlying vision"],
  ["problem", "Problem being solved"],
  ["how_it_works", "How it might work"],
  ["audience", "Target audience or customers"],
  ["business_model", "Potential business model"],
  ["feasibility", "Feasibility and considerations"],
  ["next_steps", "Recommended next steps"],
  ["open_questions", "Open questions"],
] as const;

export const Report = z.object({
  translation: z
    .string()
    .describe("A short paragraph: 'What he is trying to say', written for the organizer in clear, warm language."),
  confidence_note: z.string().describe("How confident this interpretation is and what it rests on."),
  summary: Section,
  vision: Section,
  problem: Section,
  how_it_works: Section,
  audience: Section,
  business_model: Section,
  feasibility: Section,
  next_steps: Section,
  open_questions: Section,
});
export type Report = z.infer<typeof Report>;

export const CRITERIA = [
  ["value", "Potential value", "5 = very valuable"],
  ["feasibility", "Feasibility", "5 = clearly doable"],
  ["cost", "Cost", "5 = cheap to try"],
  ["complexity", "Complexity", "5 = simple"],
  ["strategic_fit", "Strategic fit", "5 = fits our goals"],
  ["effort", "Effort", "5 = little effort"],
] as const;

const Criterion = z.object({ score: z.number(), reason: z.string() });
export const Score = z.object({
  value: Criterion,
  feasibility: Criterion,
  cost: Criterion,
  complexity: Criterion,
  strategic_fit: Criterion,
  effort: Criterion,
  overall_take: z.string().describe("Two or three sentences: is this worth attention now, and why."),
  biggest_unknown: z.string().describe("The single unknown that most affects this evaluation."),
  cheapest_test: z.string().describe("The cheapest, fastest way to test whether this idea is worth pursuing."),
});
export type Score = z.infer<typeof Score>;

export const Plan = z.object({
  goal: z.string(),
  definition_of_done: z.string(),
  milestones: z.array(z.object({ name: z.string(), outcome: z.string(), target_offset_days: z.number() })),
  tasks: z.array(
    z.object({
      milestone: z.string(),
      title: z.string(),
      instructions: z.string().describe("Clear step-by-step instructions someone could follow without asking."),
      expected_outcome: z.string(),
      priority: z.enum(["low", "medium", "high", "urgent"]),
      due_offset_days: z.number(),
      owner: z.enum(["visionary", "organizer", "either"]),
    }),
  ),
  risks: z.array(z.string()),
  first_step_today: z.string(),
});
export type Plan = z.infer<typeof Plan>;

export const Insights = z.object({
  overview: z.string().describe("A short paragraph on what is happening across his thinking this period."),
  patterns: z.array(z.object({ title: z.string(), explanation: z.string(), idea_ids: z.array(z.number()) })),
  promising: z.array(z.object({ idea_id: z.number(), why: z.string() })),
  conflicts: z.array(z.object({ idea_ids: z.array(z.number()), explanation: z.string() })),
  combinations: z.array(z.object({ idea_ids: z.array(z.number()), proposal: z.string() })),
  themes: z.array(z.object({ name: z.string(), description: z.string(), idea_ids: z.array(z.number()) })),
});
export type Insights = z.infer<typeof Insights>;

export const DigestText = z.object({
  headline: z.string(),
  overview: z.string(),
  attention: z.array(z.object({ text: z.string(), idea_id: z.number().nullable() })),
});
export type DigestText = z.infer<typeof DigestText>;

export const Merge = IdeaCard;
