import { config } from "../config.js";
import type { DB } from "../db.js";
import { AIError, recordUsage } from "./llm.js";

export interface Embedder {
  model: string;
  embed(texts: string[], purpose: string): Promise<Float32Array[]>;
}

export class OpenAIEmbedder implements Embedder {
  model = `${config.embeddingModel}@${config.embeddingDims}`;
  constructor(private db: DB) {}

  async embed(texts: string[], purpose: string): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const out: Float32Array[] = [];
    // The API accepts batches; 100 short texts per request keeps payloads small.
    for (let i = 0; i < texts.length; i += 100) {
      const batch = texts.slice(i, i + 100).map((t) => t.slice(0, 24000) || " ");
      const res = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.openaiApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.embeddingModel, input: batch, dimensions: config.embeddingDims }),
      }).catch((e) => {
        throw new AIError(`Could not reach OpenAI: ${e.message}`, true);
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        throw new AIError(`OpenAI embeddings failed (${res.status}): ${body}`, res.status >= 500 || res.status === 429);
      }
      const data = (await res.json()) as { data: { index: number; embedding: number[] }[]; usage?: { total_tokens: number } };
      const tokens = data.usage?.total_tokens ?? 0;
      recordUsage(this.db, {
        purpose,
        provider: "openai",
        model: config.embeddingModel,
        input: tokens,
        cost: (tokens / 1e6) * (config.embeddingModel.includes("large") ? 0.13 : 0.02),
      });
      for (const d of data.data.sort((a, b) => a.index - b.index)) out.push(normalize(Float32Array.from(d.embedding)));
    }
    return out;
  }
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

// Vectors are stored normalized, so the dot product is the cosine similarity.
export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function fromBlob(b: Buffer): Float32Array {
  const copy = new Uint8Array(b.byteLength);
  copy.set(b);
  return new Float32Array(copy.buffer);
}
