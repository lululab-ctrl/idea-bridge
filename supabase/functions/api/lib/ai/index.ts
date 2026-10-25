import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { ClaudeLLM, type LLM } from "./llm.ts";
import { MockLLM, MockTranscriber } from "./mock.ts";
import { GroqTranscriber, type Transcriber } from "./speech.ts";
import { AIError } from "./llm.ts";

export interface AI {
  llm: LLM | null;
  transcriber: Transcriber | null;
}

export function createAI(db: DB): AI {
  if (config.aiMode === "mock") return { llm: new MockLLM(), transcriber: new MockTranscriber() };
  return {
    llm: config.anthropicApiKey ? new ClaudeLLM(db) : null,
    transcriber: config.groqApiKey ? new GroqTranscriber(db) : null,
  };
}

export function requireLLM(ai: AI): LLM {
  if (!ai.llm) throw new AIError("AI understanding is not set up yet. Add ANTHROPIC_API_KEY to the Supabase function secrets.", false);
  return ai.llm;
}

export function aiStatus() {
  const mock = config.aiMode === "mock";
  return {
    mode: config.aiMode,
    understanding: mock || !!config.anthropicApiKey,
    transcription: mock ? "mock" : config.groqApiKey ? "groq" : null,
    transcriptionBackup: false,
    semanticSearch: mock || !!config.anthropicApiKey,
    model: config.claudeModel,
    deepModel: config.claudeDeepModel,
  };
}
