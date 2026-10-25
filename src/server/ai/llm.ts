import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod/v4";
import { config } from "../config.js";
import type { DB } from "../db.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface CallOptions {
  purpose: string; // recorded in the usage log, e.g. "extract", "report"
  system: string; // stable instructions (cached)
  context?: string; // stable-ish shared context such as glossary (cached)
  prompt: string; // the per-call content
  model?: string;
  effort?: Effort;
  maxTokens?: number;
}

export class AIError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}

// USD per million tokens. Used only for the cost estimate shown in Settings.
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-fable-5-1": [10, 50],
};

export function recordUsage(
  db: DB,
  u: { purpose: string; provider: string; model: string; input?: number; output?: number; audioSec?: number; cost: number },
) {
  db.prepare(
    "INSERT INTO ai_usage (purpose, provider, model, input_tokens, output_tokens, audio_seconds, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(u.purpose, u.provider, u.model, u.input ?? 0, u.output ?? 0, u.audioSec ?? 0, u.cost);
}

export interface LLM {
  json<S extends z.ZodType>(schema: S, opts: CallOptions): Promise<z.infer<S>>;
  text(opts: CallOptions): Promise<string>;
}

export class ClaudeLLM implements LLM {
  private client: Anthropic;

  constructor(private db: DB) {
    this.client = new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 3 });
  }

  private async run(opts: CallOptions, format?: ReturnType<typeof betaZodOutputFormat>) {
    const model = opts.model ?? config.claudeModel;
    const system: Anthropic.Beta.BetaTextBlockParam[] = [{ type: "text", text: opts.system }];
    if (opts.context) system.push({ type: "text", text: opts.context });
    // Cache the instructions + shared context; only the prompt varies per call.
    system[system.length - 1].cache_control = { type: "ephemeral" };

    let message: Anthropic.Beta.BetaMessage;
    try {
      const stream = this.client.beta.messages.stream({
        model,
        max_tokens: opts.maxTokens ?? 32000,
        system,
        messages: [{ role: "user", content: opts.prompt }],
        output_config: { effort: opts.effort ?? "medium", ...(format ? { format } : {}) },
        // If a safety classifier wrongly declines a benign request, retry on
        // Anthropic's recommended fallback model instead of failing.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      message = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new AIError("The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.", false);
      }
      if (err instanceof Anthropic.BadRequestError) {
        throw new AIError(`Claude rejected the request: ${err.message}`, false);
      }
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError) {
        throw new AIError(`Claude is busy (${err.status}). Will retry.`, true);
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new AIError("Could not reach Claude. Will retry.", true);
      }
      if (err instanceof Anthropic.APIError) {
        throw new AIError(`Claude error ${err.status}: ${err.message}`, (err.status ?? 500) >= 500);
      }
      throw err;
    }

    const usage = message.usage;
    const [pin, pout] = PRICES[message.model] ?? PRICES[model] ?? [4, 20];
    const input =
      (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) * 1.25 + (usage.cache_read_input_tokens ?? 0) * 0.1;
    recordUsage(this.db, {
      purpose: opts.purpose,
      provider: "anthropic",
      model: message.model,
      input: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
      output: usage.output_tokens,
      cost: (input * pin + usage.output_tokens * pout) / 1e6,
    });

    if (message.stop_reason === "refusal") {
      throw new AIError("Claude declined to process this item.", false);
    }
    if (message.stop_reason === "max_tokens") {
      throw new AIError("The AI response was cut off (too long). Will retry.", true);
    }
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

  async text(opts: CallOptions): Promise<string> {
    return this.run(opts);
  }
}
