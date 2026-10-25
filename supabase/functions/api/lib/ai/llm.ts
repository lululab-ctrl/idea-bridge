import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod/v4";
import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { getSetting } from "../db.ts";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface CallOptions {
  purpose: string; // recorded in the usage log
  system: string;
  context?: string;
  prompt: string;
  deep?: boolean; // use the deeper (more capable, more expensive) model
  effort?: Effort;
  maxTokens?: number;
}

export class AIError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
    // When set, the job is postponed by this many seconds without using up a retry.
    public deferSec = 0,
  ) {
    super(message);
  }
}

// USD per million tokens, for the spend estimate and the monthly budget cap.
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};

export async function recordUsage(
  db: DB,
  u: { purpose: string; provider: string; model: string; input?: number; output?: number; audioSec?: number; cost: number },
) {
  await db.run(
    "INSERT INTO ai_usage (purpose, provider, model, input_tokens, output_tokens, audio_seconds, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
    u.purpose,
    u.provider,
    u.model,
    Math.round(u.input ?? 0),
    Math.round(u.output ?? 0),
    u.audioSec ?? 0,
    u.cost,
  );
}

export async function monthSpend(db: DB): Promise<number> {
  const row = await db.get<{ c: number }>(
    "SELECT COALESCE(SUM(cost_usd), 0)::float AS c FROM ai_usage WHERE provider = 'anthropic' AND created_at >= ?",
    new Date().toISOString().slice(0, 7) + "-01",
  );
  return row?.c ?? 0;
}

// The monthly Claude budget keeps usage inside the Team plan's free API credits.
export async function budgetStatus(db: DB) {
  const budget = await getSetting<number>(db, "ai_budget_usd", 18);
  const spent = await monthSpend(db);
  return { budget, spent, exhausted: budget > 0 && spent >= budget };
}

function secondsToNextMonth(): number {
  const d = new Date();
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 0, 5);
  return Math.max(60, Math.round((next - d.getTime()) / 1000));
}

export interface LLM {
  json<S extends z.ZodType>(schema: S, opts: CallOptions): Promise<z.infer<S>>;
  text(opts: CallOptions): Promise<string>;
}

export class ClaudeLLM implements LLM {
  private client: Anthropic;

  constructor(private db: DB) {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 2, timeout: 110_000 });
  }

  private async run(opts: CallOptions, format?: ReturnType<typeof betaZodOutputFormat>) {
    const b = await budgetStatus(this.db);
    if (b.exhausted) {
      throw new AIError(
        `This month's AI budget ($${b.budget}) is used up. Processing continues automatically next month, or raise the budget in Settings.`,
        true,
        secondsToNextMonth(),
      );
    }
    const model = opts.deep ? config.claudeDeepModel : config.claudeModel;
    const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: opts.system }];
    if (opts.context) system.push({ type: "text", text: opts.context });
    system[system.length - 1].cache_control = { type: "ephemeral" };
    // Server-side fallback after a false-positive refusal exists for the larger models only.
    const fallback = model.startsWith("claude-haiku") ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const };

    let message: Anthropic.Beta.BetaMessage;
    try {
      const stream = this.client.beta.messages.stream({
        model,
        max_tokens: opts.maxTokens ?? 16000,
        system,
        messages: [{ role: "user", content: opts.prompt }],
        output_config: { effort: opts.effort ?? "medium", ...(format ? { format } : {}) },
        ...fallback,
      });
      message = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new AIError("The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.", false);
      }
      if (err instanceof Anthropic.BadRequestError) {
        if (/credit balance/i.test(err.message)) {
          throw new AIError("The Claude API credits for this month are used up. Processing resumes when the next monthly credits arrive.", true, 6 * 3600);
        }
        throw new AIError(`Claude rejected the request: ${err.message}`, false);
      }
      if (err instanceof Anthropic.RateLimitError) throw new AIError("Claude is busy. Will retry.", true, 120);
      if (err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
        throw new AIError("Could not reach Claude. Will retry.", true);
      }
      if (err instanceof Anthropic.APIError) throw new AIError(`Claude error ${err.status}: ${err.message}`, (err.status ?? 500) >= 500);
      throw err;
    }

    const u = message.usage;
    const [pin, pout] = PRICES[message.model] ?? PRICES[model] ?? [2, 10];
    const weightedInput = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1;
    await recordUsage(this.db, {
      purpose: opts.purpose,
      provider: "anthropic",
      model: message.model,
      input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      output: u.output_tokens,
      cost: (weightedInput * pin + u.output_tokens * pout) / 1e6,
    });
    if (message.stop_reason === "refusal") throw new AIError("Claude declined to process this item.", false);
    if (message.stop_reason === "max_tokens") throw new AIError("The AI response was cut off (too long).", false);
    return message.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  async json<S extends z.ZodType>(schema: S, opts: CallOptions): Promise<z.infer<S>> {
    const text = await this.run(opts, betaZodOutputFormat(schema as never));
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new AIError("The AI returned malformed data. Will retry.", true);
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new AIError("The AI returned data in an unexpected shape. Will retry.", true);
    return parsed.data;
  }

  text(opts: CallOptions): Promise<string> {
    return this.run(opts);
  }
}
