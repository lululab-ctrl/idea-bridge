// Voice recording that never loses an idea:
//  1. audio is recorded in small chunks,
//  2. the finished recording is saved on the phone (IndexedDB) BEFORE uploading,
//  3. uploads retry automatically (and when the connection comes back),
//  4. the server ignores duplicates, so a retry can never create a second copy.

const DB_NAME = "ideabridge";
const STORE = "outbox";

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "clientId" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const result = fn(store);
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
  });
}

export const outbox = {
  put: (item) => tx("readwrite", (s) => s.put(item)),
  remove: (clientId) => tx("readwrite", (s) => s.delete(clientId)),
  all: () =>
    tx("readonly", (s) => s.getAll()).then((r) => (Array.isArray(r) ? r : [])),
};

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Picks a format the browser can record and the transcription services accept.
export function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  const options = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus", "audio/aac"];
  return options.find((m) => MediaRecorder.isTypeSupported?.(m)) ?? "";
}

export function recordingSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined");
}

export class Recorder {
  constructor({ onLevel, onTick, maxSeconds = 30 * 60, onAutoStop } = {}) {
    this.onLevel = onLevel;
    this.onTick = onTick;
    this.maxSeconds = maxSeconds;
    this.onAutoStop = onAutoStop;
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const mime = pickMime();
    this.mime = mime || "audio/webm";
    this.rec = new MediaRecorder(this.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: 48000 });
    this.chunks = [];
    this.rec.ondataavailable = (e) => e.data?.size && this.chunks.push(e.data);
    this.startedAt = Date.now();
    this.capturedAt = new Date().toISOString();
    this.rec.start(1000); // a chunk every second, so little is lost if the app is closed
    this.meter();
    this.timer = setInterval(() => {
      const sec = this.elapsed();
      this.onTick?.(sec);
      if (sec >= this.maxSeconds) this.onAutoStop?.();
    }, 250);
    // Keep the screen on while recording where the browser allows it.
    try {
      this.wake = await navigator.wakeLock?.request("screen");
    } catch {
      this.wake = null;
    }
  }

  elapsed() {
    return this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
  }

  meter() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      const src = this.ctx.createMediaStreamSource(this.stream);
      const an = this.ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      const loop = () => {
        if (!this.rec || this.rec.state === "inactive") return;
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += (v - 128) ** 2;
        const rms = Math.sqrt(sum / buf.length) / 128;
        this.onLevel?.(Math.min(1, rms * 4));
        this.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch {
      /* the level meter is optional */
    }
  }

  // Stops and returns { blob, mime, duration, capturedAt }.
  stop() {
    return new Promise((resolve) => {
      if (!this.rec || this.rec.state === "inactive") return resolve(null);
      const duration = this.elapsed();
      this.rec.onstop = () => {
        const type = (this.rec.mimeType || this.mime).split(";")[0];
        const blob = new Blob(this.chunks, { type });
        this.cleanup();
        resolve({ blob, mime: type, duration, capturedAt: this.capturedAt });
      };
      this.rec.stop();
    });
  }

  cancel() {
    if (this.rec && this.rec.state !== "inactive") {
      this.rec.onstop = () => this.cleanup();
      this.rec.stop();
    } else this.cleanup();
  }

  cleanup() {
    clearInterval(this.timer);
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close().catch(() => {});
    this.wake?.release?.().catch(() => {});
    this.rec = null;
    this.startedAt = null;
  }
}

// ------------------------------------------------------------------ uploads
let flushing = null;
const listeners = new Set();
export function onOutboxChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = () => listeners.forEach((fn) => fn());

export async function saveRecording({ blob, mime, duration, capturedAt }, questionId) {
  const item = { clientId: uuid(), blob, mime, duration, capturedAt, questionId: questionId ?? null, tries: 0 };
  await outbox.put(item);
  changed();
  flush();
  return item.clientId;
}

export async function saveText(text, questionId) {
  const item = { clientId: uuid(), text, capturedAt: new Date().toISOString(), questionId: questionId ?? null, tries: 0 };
  await outbox.put(item);
  changed();
  flush();
  return item.clientId;
}

async function uploadOne(item) {
  let res;
  if (item.text != null) {
    res = await fetch("/api/recordings/text", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-ideabridge": "1" },
      body: JSON.stringify({ text: item.text, client_id: item.clientId, captured_at: item.capturedAt, question_id: item.questionId }),
    });
  } else {
    const ext = item.mime.includes("mp4") || item.mime.includes("aac") ? "m4a" : item.mime.includes("ogg") ? "ogg" : "webm";
    const form = new FormData();
    form.append("client_id", item.clientId);
    form.append("captured_at", item.capturedAt);
    form.append("duration", String(Math.round(item.duration ?? 0)));
    if (item.questionId) form.append("question_id", String(item.questionId));
    form.append("file", item.blob, `recording.${ext}`);
    res = await fetch("/api/recordings", { method: "POST", credentials: "same-origin", headers: { "x-ideabridge": "1" }, body: form });
  }
  if (res.status === 401) throw Object.assign(new Error("signed out"), { permanent: false });
  if (res.status === 400 || res.status === 413 || res.status === 415) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || "Upload rejected"), { permanent: true });
  }
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  return res.json();
}

// Uploads everything waiting in the outbox. Safe to call any time.
export function flush() {
  if (flushing) return flushing;
  flushing = (async () => {
    try {
      const items = await outbox.all();
      for (const item of items.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) {
        if (!navigator.onLine) break;
        if (item.failed) continue;
        try {
          await uploadOne(item);
          await outbox.remove(item.clientId);
        } catch (e) {
          item.tries = (item.tries ?? 0) + 1;
          item.lastError = e.message;
          if (e.permanent) item.failed = true;
          await outbox.put(item);
        }
        changed();
      }
    } finally {
      flushing = null;
    }
  })();
  return flushing;
}

export async function pendingUploads() {
  try {
    return await outbox.all();
  } catch {
    return [];
  }
}

export async function discard(clientId) {
  await outbox.remove(clientId);
  changed();
}

window.addEventListener("online", () => flush());
setInterval(() => flush(), 30_000);
