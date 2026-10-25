import { useEffect, useRef, useState } from "preact/hooks";
import { ago, html, icon, useData, toast } from "../lib.js";
import {
  Recorder,
  discard,
  flush,
  onOutboxChange,
  pendingUploads,
  recordingSupported,
  saveRecording,
  saveText,
} from "../recorder.js";

// The screen he uses: one big button. Everything else is optional.
export function Capture({ me }) {
  const [state, setState] = useState("idle"); // idle | starting | recording | saving
  const [secs, setSecs] = useState(0);
  const [level, setLevel] = useState(0);
  const [answering, setAnswering] = useState(null); // question being answered
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const [flash, setFlash] = useState("");
  const [outbox, setOutbox] = useState([]);
  const rec = useRef(null);
  const questions = useData("/api/questions/open", { poll: 30000 });
  const mine = useData("/api/recordings?mine=1&limit=8", { poll: 5000 });
  const supported = recordingSupported();

  useEffect(() => {
    const load = () => pendingUploads().then(setOutbox);
    load();
    flush();
    return onOutboxChange(load);
  }, []);

  // Phones suspend the microphone when the app goes to the background:
  // save what we have instead of losing it.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden" && rec.current) stop();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  });

  useEffect(() => {
    const onKey = (e) => {
      if (e.code === "Space" && !typing && !["INPUT", "TEXTAREA", "BUTTON"].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // While the admin previews this view, nothing is recorded or saved.
  const preview = !!me.viewed_by;
  const previewOnly = () => setFlash(`Preview: this is exactly what ${me.name} sees. Recording and saving are turned off.`);

  async function start(question = answering) {
    if (preview) return previewOnly();
    if (state !== "idle") return;
    setState("starting");
    setFlash("");
    const r = new Recorder({ onLevel: setLevel, onTick: setSecs, onAutoStop: () => stop() });
    try {
      await r.start();
      rec.current = r;
      setAnswering(question ?? null);
      setState("recording");
      navigator.vibrate?.(30);
    } catch (e) {
      setState("idle");
      const denied = e?.name === "NotAllowedError" || e?.name === "SecurityError";
      toast(
        denied
          ? "Microphone access is blocked. Allow it for this site in your phone's settings, then try again."
          : "Could not start the microphone. Close other apps using it and try again.",
        "error",
      );
    }
  }

  async function stop() {
    const r = rec.current;
    if (!r) return;
    rec.current = null;
    setState("saving");
    const result = await r.stop();
    setLevel(0);
    if (!result || result.duration < 1 || result.blob.size < 500) {
      setState("idle");
      setSecs(0);
      setFlash("Too short to save. Hold on a little longer next time.");
      return;
    }
    await saveRecording(result, answering?.id);
    navigator.vibrate?.([20, 60, 20]);
    setFlash(answering ? "Answer saved. Thank you." : "Saved. The AI is on it.");
    setAnswering(null);
    setState("idle");
    setSecs(0);
    setTimeout(() => {
      mine.reload();
      questions.reload();
    }, 1500);
  }

  function toggle() {
    if (state === "recording") stop();
    else if (state === "idle") start();
  }

  async function submitText() {
    if (preview) return previewOnly();
    if (text.trim().length < 3) return;
    await saveText(text.trim(), answering?.id);
    setText("");
    setTyping(false);
    setFlash(answering ? "Answer saved. Thank you." : "Saved. The AI is on it.");
    setAnswering(null);
    setTimeout(() => {
      mine.reload();
      questions.reload();
    }, 1500);
  }

  async function uploadFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (preview) {
      e.target.value = "";
      return previewOnly();
    }
    await saveRecording({ blob: file, mime: file.type || "audio/mp4", duration: 0, capturedAt: new Date().toISOString() }, answering?.id);
    setFlash("Uploaded. The AI is on it.");
    e.target.value = "";
  }

  const recording = state === "recording";
  const qs = questions.data ?? [];
  const waiting = outbox.filter((o) => !o.failed);
  const failed = outbox.filter((o) => o.failed);
  const firstName = me?.name?.split(" ")[0] ?? "";
  const isContributor = me?.role === "visionary";

  return html`<div class="capture">
    <div class="capture-top">
      ${isContributor ? html`<a href="#/mine">Your ideas</a>` : html`<a href="#/today">← Workspace</a>`}
      <span style="opacity:.7">Idea Bridge</span>
      ${isContributor ? html`<a href="#/mine/recordings">Recordings</a>` : html`<a href="#/settings">Settings</a>`}
    </div>

    <div class="capture-center">
      ${!recording && !typing && html`<div class="stack tight" style="align-items:center">
        <div class="capture-hello">${answering ? "Answer the question" : qs.length ? `Hi ${firstName}` : `What's on your mind${firstName ? `, ${firstName}` : ""}?`}</div>
        <div class="capture-sub">${answering
          ? `“${answering.text}”`
          : qs.length
            ? `${qs[0].asked_by_name ?? "Someone"} has ${qs.length === 1 ? "a question" : `${qs.length} questions`} for you below. Or just tap and talk.`
            : "Tap the button and just talk. Half-finished thoughts are welcome."}</div>
      </div>`}

      ${recording && answering && html`<div class="answering">Answering: ${answering.text}</div>`}

      ${supported
        ? !typing &&
          html`<button
            class="recbtn ${recording ? "on" : ""}"
            style=${`--lvl:${level.toFixed(2)}`}
            onClick=${toggle}
            disabled=${state === "starting" || state === "saving"}
            aria-label=${recording ? "Stop and save" : "Start recording"}
          >
            ${recording ? html`<span class="stop"></span>` : icon("mic")}
          </button>`
        : html`<div class="qcard"><div class="q">This browser can't record audio.</div><div class="meta">On iPhone, open this page in Safari. You can still upload a voice memo or type.</div></div>`}

      ${recording
        ? html`<div class="stack tight" style="align-items:center">
            <div class="rec-time">${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, "0")}</div>
            <div class="rec-hint">Recording… tap to stop and save</div>
            <button class="btn small" onClick=${() => { rec.current?.cancel(); rec.current = null; setState("idle"); setSecs(0); setLevel(0); setFlash("Discarded."); }}>Discard</button>
          </div>`
        : html`<div class="rec-hint" role="status">${state === "saving" ? "Saving…" : flash}</div>`}

      ${!recording && typing && html`<div class="typebox">
        <textarea autofocus value=${text} onInput=${(e) => setText(e.target.value)} placeholder=${answering ? "Type your answer…" : "Type the idea any way you like…"} dir="auto"></textarea>
        <div class="row" style="justify-content:flex-end">
          <button class="btn" onClick=${() => { setTyping(false); setAnswering(null); }}>Cancel</button>
          <button class="btn voice" onClick=${submitText} disabled=${text.trim().length < 3}>Save</button>
        </div>
      </div>`}

      ${!recording && !typing && html`<div class="capture-actions">
        <button class="btn small" onClick=${() => setTyping(true)}>${icon("keyboard")} Type instead</button>
        <label class="btn small" style="cursor:pointer">${icon("plus")} Upload a voice memo<input type="file" accept="audio/*,video/mp4,.m4a" hidden onChange=${uploadFile} /></label>
        ${answering && html`<button class="btn small" onClick=${() => setAnswering(null)}>Not now</button>`}
      </div>`}

      ${!recording && !typing && !answering && qs.length > 0 && html`<div class="stack" style="width:100%;align-items:center">
        <div class="label" style="color:#a9c0b6">${qs.length === 1 ? "A question for you" : `${qs.length} questions for you`}</div>
        ${qs.slice(0, 3).map(
          (q) => html`<div class="qcard" key=${q.id}>
            <div class="meta">${q.asked_by_name ?? "Someone"} asked about “${q.idea_title}”</div>
            <div class="q" dir="auto">${q.text}</div>
            <div class="row">
              <button class="btn voice small" onClick=${() => start(q)}>${icon("mic")} Answer by voice</button>
              <button class="btn small" onClick=${() => { setAnswering(q); setTyping(true); }}>Type</button>
            </div>
          </div>`,
        )}
      </div>`}
    </div>

    ${(waiting.length > 0 || failed.length > 0) && html`<div class="mine" style="margin-bottom:10px">
      ${waiting.length > 0 && html`<div class="r"><span class="dot work"></span><span class="t">${waiting.length} saved on this phone, waiting to upload${navigator.onLine ? "…" : " (offline)"}</span><button class="btn small" onClick=${() => flush()}>Retry</button></div>`}
      ${failed.map((f) => html`<div class="r" key=${f.clientId}><span class="dot fail"></span><span class="t">Couldn't upload: ${f.lastError}</span><button class="btn small" onClick=${() => discard(f.clientId)}>Remove</button></div>`)}
    </div>`}

    ${!recording && (mine.data?.length ?? 0) > 0 && html`<div class="mine">
      <div class="label" style="color:#a9c0b6;text-align:left">Your recent recordings</div>
      ${mine.data.slice(0, 5).map((r) => {
        const cls = r.status === "done" ? "done" : r.status === "failed" ? "fail" : "work";
        const label =
          r.status === "done"
            ? r.ideas.length
              ? r.ideas.map((i) => i.title).join(" · ")
              : r.summary ?? "Saved"
            : r.status === "failed"
              ? "Needs attention. Your recording is safe."
              : r.retrying
                ? "Waiting to retry…"
                : r.status === "transcribing"
                  ? "Transcribing…"
                  : r.status === "analyzing"
                    ? "Understanding…"
                    : "Queued…";
        return html`<a class="r" href=${isContributor ? `#/mine/recordings/${r.id}` : `#/recordings/${r.id}`} key=${r.id} style="text-decoration:none"><span class="dot ${cls}"></span><span class="t">${label}</span><span class="tiny" style="opacity:.6">${ago(r.captured_at)}</span></a>`;
      })}
    </div>`}
  </div>`;
}
