import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { ClaudeLLM, type LLM } from "./llm.ts";
import { MockLLM, MockTranscriber } from "./mock.ts";
import { GroqTranscriber, type Transcriber } from "./speech.ts";
import { AIError } from "./llm.ts";
import { keys } from "../keys.ts";

export interface AI {
  llm: LLM | null;
  transcriber: Transcriber | null;
}

export function createAI(db: DB): AI {
  const ai: AI = { llm: null, transcriber: null };
  syncAI(ai, db);
  return ai;
}

// Rebuilds the clients when keys are added or changed in Settings.
const built = new WeakMap<AI, string>();
export function syncAI(ai: AI, db: DB) {
  if (config.aiMode === "mock") {
    ai.llm ??= new MockLLM();
    ai.transcriber ??= new MockTranscriber();
    return;
  }
  const k = keys();
  const sig = `${k.anthropic}|${k.groq}`;
  if (built.get(ai) === sig) return;
  built.set(ai, sig);
  ai.llm = k.anthropic ? new ClaudeLLM(db, k.anthropic) : null;
  ai.transcriber = k.groq ? new GroqTranscriber(db, k.groq) : null;
}

export function requireLLM(ai: AI): LLM {
  if (!ai.llm) throw new AIError("AI understanding is not set up yet. The admin can add the Claude API key in Settings → System.", true, 3600);
  return ai.llm;
}

export function aiStatus() {
  const mock = config.aiMode === "mock";
  return {
    mode: config.aiMode,
    understanding: mock || !!keys().anthropic,
    transcription: mock ? "mock" : keys().groq ? "groq" : null,
    transcriptionBackup: false,
    semanticSearch: mock || !!keys().anthropic,
    model: config.claudeModel,
    deepModel: config.claudeDeepModel,
  };
}
