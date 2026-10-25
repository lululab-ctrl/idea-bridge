import { config } from "../config.js";
import type { DB } from "../db.js";
import { OpenAIEmbedder, type Embedder } from "./embeddings.js";
import { ClaudeLLM, type LLM } from "./llm.js";
import { MockEmbedder, MockLLM, MockTranscriber } from "./mock.js";
import { ElevenLabsTranscriber, OpenAITranscriber, TranscriberChain, type Transcriber } from "./speech.js";

export interface AI {
  llm: LLM | null;
  transcriber: Transcriber;
  embedder: Embedder | null;
}

export function createAI(db: DB): AI {
  if (config.aiMode === "mock") {
    return { llm: new MockLLM(), transcriber: new MockTranscriber(), embedder: new MockEmbedder() };
  }
  const transcribers: Transcriber[] = [];
  if (config.elevenlabsApiKey) transcribers.push(new ElevenLabsTranscriber(db));
  if (config.openaiApiKey) transcribers.push(new OpenAITranscriber(db));
  return {
    llm: config.anthropicApiKey ? new ClaudeLLM(db) : null,
    transcriber: new TranscriberChain(transcribers),
    embedder: config.openaiApiKey ? new OpenAIEmbedder(db) : null,
  };
}

// Shown in Settings so a missing key is obvious instead of failing silently.
export function aiStatus() {
  const mock = config.aiMode === "mock";
  return {
    mode: config.aiMode,
    understanding: mock || !!config.anthropicApiKey,
    transcription: mock ? "mock" : config.elevenlabsApiKey ? "elevenlabs" : config.openaiApiKey ? "openai" : null,
    transcriptionBackup: !mock && !!config.elevenlabsApiKey && !!config.openaiApiKey,
    semanticSearch: mock || !!config.openaiApiKey,
    model: config.claudeModel,
  };
}
