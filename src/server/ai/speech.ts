import fs from "node:fs";
import { config } from "../config.js";
import type { DB } from "../db.js";
import { AIError, recordUsage } from "./llm.js";

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
  // false when the provider gave no timing and segment times are estimates
  timed: boolean;
  provider: string;
}

export interface Transcriber {
  name: string;
  transcribe(file: string, mime: string, hints: string[]): Promise<Transcript>;
}

const EXT_BY_MIME: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "aac",
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

function audioBlob(file: string, mime: string) {
  // Providers detect the format from the file name, so it must carry the right extension.
  const name = `recording.${extForMime(mime)}`;
  return { blob: new Blob([fs.readFileSync(file)], { type: mime.split(";")[0] }), name };
}

async function failFromResponse(provider: string, res: Response): Promise<never> {
  const body = (await res.text()).slice(0, 300);
  if (res.status === 401 || res.status === 403) {
    throw new AIError(`${provider} rejected the API key (${res.status}).`, false);
  }
  throw new AIError(`${provider} transcription failed (${res.status}): ${body}`, res.status >= 500 || res.status === 429);
}

// Groups word timings into readable segments: break on sentence ends or pauses.
export function wordsToSegments(words: { text: string; start: number; end: number }[]): Segment[] {
  const segments: Segment[] = [];
  let cur: Segment | null = null;
  let prevEnd = 0;
  for (const w of words) {
    const pause = cur ? w.start - prevEnd : 0;
    if (!cur || pause > 0.9 || (cur.text.length > 40 && /[.!?…]$/.test(cur.text.trim()))) {
      if (cur) segments.push(cur);
      cur = { start: w.start, end: w.end, text: w.text.trim() };
    } else {
      cur.text += (/^[,.!?;:…]/.test(w.text) ? "" : " ") + w.text.trim();
      cur.end = w.end;
    }
    prevEnd = w.end;
  }
  if (cur) segments.push(cur);
  return segments;
}

// Primary: ElevenLabs Scribe - strong multilingual accuracy (incl. Hebrew),
// automatic language detection and word-level timestamps.
export class ElevenLabsTranscriber implements Transcriber {
  name = "elevenlabs";
  constructor(private db: DB) {}

  async transcribe(file: string, mime: string, hints: string[]): Promise<Transcript> {
    const { blob, name } = audioBlob(file, mime);
    const form = new FormData();
    form.append("file", blob, name);
    form.append("model_id", config.elevenlabsModel);
    form.append("timestamps_granularity", "word");
    form.append("tag_audio_events", "false");
    for (const k of hints.slice(0, 50)) form.append("keyterms", k);

    let res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": config.elevenlabsApiKey },
      body: form,
    }).catch((e) => {
      throw new AIError(`Could not reach ElevenLabs: ${e.message}`, true);
    });
    if (res.status === 400 && hints.length) {
      // Keyterms are an optional extra; retry once without them before failing.
      form.delete("keyterms");
      res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": config.elevenlabsApiKey },
        body: form,
      });
    }
    if (!res.ok) await failFromResponse("ElevenLabs", res);
    const data = (await res.json()) as {
      text: string;
      language_code?: string;
      words?: { text: string; type: string; start: number; end: number }[];
    };
    const words = (data.words ?? []).filter((w) => w.type === "word");
    const duration = words.length ? words[words.length - 1].end : null;
    recordUsage(this.db, {
      purpose: "transcribe",
      provider: "elevenlabs",
      model: config.elevenlabsModel,
      audioSec: duration ?? 0,
      cost: ((duration ?? 0) / 3600) * 0.22,
    });
    return {
      text: data.text.trim(),
      language: data.language_code ?? null,
      duration,
      segments: wordsToSegments(words),
      timed: true,
      provider: this.name,
    };
  }
}

// Backup: OpenAI. Good multilingual text, but current models return no
// timestamps, so segment times are estimated from position in the text.
export class OpenAITranscriber implements Transcriber {
  name = "openai";
  constructor(private db: DB) {}

  async transcribe(file: string, mime: string, hints: string[]): Promise<Transcript> {
    const size = fs.statSync(file).size;
    if (size > 25 * 1024 * 1024) throw new AIError("Recording is larger than OpenAI's 25 MB limit.", false);
    const { blob, name } = audioBlob(file, mime);
    const form = new FormData();
    form.append("file", blob, name);
    form.append("model", config.openaiTranscribeModel);
    form.append("response_format", "json");
    if (hints.length) form.append("prompt", `Names and terms that may appear: ${hints.slice(0, 40).join(", ")}.`);
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openaiApiKey}` },
      body: form,
    }).catch((e) => {
      throw new AIError(`Could not reach OpenAI: ${e.message}`, true);
    });
    if (!res.ok) await failFromResponse("OpenAI", res);
    const data = (await res.json()) as { text: string; language?: string; languages?: string[]; usage?: { seconds?: number } };
    const seconds = data.usage?.seconds ?? 0;
    recordUsage(this.db, {
      purpose: "transcribe",
      provider: "openai",
      model: config.openaiTranscribeModel,
      audioSec: seconds,
      cost: (seconds / 60) * 0.006,
    });
    return {
      text: data.text.trim(),
      language: data.language ?? data.languages?.join(", ") ?? null,
      duration: seconds || null,
      segments: [],
      timed: false,
      provider: this.name,
    };
  }
}

// Splits untimed text into sentence segments with times spread by length,
// so quotes still jump to roughly the right place in the audio.
export function estimateSegments(text: string, duration: number | null): Segment[] {
  const parts = text.match(/[^.!?…\n]+[.!?…]*\s*/g)?.map((s) => s.trim()).filter(Boolean) ?? [text];
  const total = parts.reduce((n, p) => n + p.length, 0) || 1;
  const d = duration ?? total / 15; // ~15 characters per second of speech
  let t = 0;
  return parts.map((p) => {
    const len = (p.length / total) * d;
    const seg = { start: Math.round(t * 10) / 10, end: Math.round((t + len) * 10) / 10, text: p };
    t += len;
    return seg;
  });
}

// Tries each configured provider in order; the first one that works wins.
export class TranscriberChain implements Transcriber {
  name = "chain";
  constructor(private providers: Transcriber[]) {}

  async transcribe(file: string, mime: string, hints: string[]): Promise<Transcript> {
    if (!this.providers.length) {
      throw new AIError("No transcription service is configured. Add ELEVENLABS_API_KEY or OPENAI_API_KEY.", false);
    }
    let lastErr: unknown;
    let anyRetryable = false;
    for (const p of this.providers) {
      try {
        return await p.transcribe(file, mime, hints);
      } catch (err) {
        lastErr = err;
        if (err instanceof AIError && err.retryable) anyRetryable = true;
        console.warn(`[transcribe] ${p.name} failed: ${(err as Error).message}`);
      }
    }
    if (lastErr instanceof AIError) throw new AIError(lastErr.message, anyRetryable);
    throw lastErr;
  }
}
