import { config } from "../config.ts";
import type { DB } from "../db.ts";
import { AIError, recordUsage } from "./llm.ts";

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  text: string;
  language: string | null;
  duration: number | null;
  segments: Segment[];
  timed: boolean;
  provider: string;
}

export interface Transcriber {
  name: string;
  // `url` is a short-lived signed link to the audio file.
  transcribe(url: string, filename: string, hints: string[]): Promise<Transcript>;
}

const EXT_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

export function extForMime(mime: string): string {
  return EXT_BY_MIME[mime.split(";")[0].trim().toLowerCase()] ?? "webm";
}

// Groq's free plan runs Whisper large-v3 and returns timestamped segments.
// Passing a URL means the audio never has to pass through this function.
export class GroqTranscriber implements Transcriber {
  name = "groq";
  constructor(private db: DB, private apiKey: string) {}

  async transcribe(url: string, _filename: string, hints: string[]): Promise<Transcript> {
    const form = new FormData();
    form.append("url", url);
    form.append("model", config.groqModel);
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    if (hints.length) form.append("prompt", `Names and terms: ${hints.slice(0, 30).join(", ")}.`.slice(0, 800));
    const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    }).catch((e) => {
      throw new AIError(`Could not reach Groq: ${e.message}`, true);
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after")) || 600;
      throw new AIError("The free transcription limit was reached for now. Will continue automatically.", true, Math.min(wait + 30, 6 * 3600));
    }
    if (res.status === 401 || res.status === 403) throw new AIError("Groq rejected the API key. Check the Groq key in Settings → System.", false);
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new AIError(`Transcription failed (${res.status}): ${body}`, res.status >= 500);
    }
    const data = (await res.json()) as {
      text: string;
      language?: string;
      duration?: number;
      segments?: { start: number; end: number; text: string }[];
    };
    await recordUsage(this.db, { purpose: "transcribe", provider: "groq", model: config.groqModel, audioSec: data.duration ?? 0, cost: 0 });
    const segments = (data.segments ?? []).map((s) => ({ start: s.start, end: s.end, text: s.text.trim() })).filter((s) => s.text);
    return {
      text: (data.text ?? "").trim(),
      language: data.language ?? null,
      duration: data.duration ?? null,
      segments,
      timed: segments.length > 0,
      provider: this.name,
    };
  }
}

// Splits untimed text into sentence segments with times spread by length.
export function estimateSegments(text: string, duration: number | null): Segment[] {
  const parts = text.match(/[^.!?…\n]+[.!?…]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const total = parts.reduce((n, p) => n + p.length, 0) || 1;
  const d = duration ?? total / 15;
  let t = 0;
  return parts.map((p) => {
    const len = (p.length / total) * d;
    const seg = { start: Math.round(t * 10) / 10, end: Math.round((t + len) * 10) / 10, text: p };
    t += len;
    return seg;
  });
}
