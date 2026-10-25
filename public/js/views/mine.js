import { useState } from "preact/hooks";
import { act, ago, clock, del, ErrorBox, go, html, icon, Loading, Modal, playAudio, post, Quote, useData, when } from "../lib.js";

// The contributor's own space: the ideas his recordings became, and his recordings.
// Read-only apart from deleting his own recordings (which the admin can restore).

const STATUS_FOR_HIM = {
  new: "Received",
  needs_clarification: "Has a question for you",
  under_review: "Being looked into",
  approved: "Approved",
  in_progress: "In progress",
  on_hold: "On hold",
  completed: "Done",
  archived: "Set aside",
};

function TopBar({ back = "#/capture", backLabel = "Record" }) {
  return html`<div class="row between" style="margin-bottom:4px">
    <a href=${back} class="small">${icon("back")} ${backLabel}</a>
    <button class="btn ghost small" onClick=${async () => { await post("/api/logout"); location.hash = ""; location.reload(); }}>Sign out</button>
  </div>`;
}

export function Mine({ tab = "ideas" }) {
  return html`<div class="main" style="max-width:720px;margin:0 auto">
    <div class="page narrow">
      <${TopBar} />
      <h1>Your ideas</h1>
      <div class="tabs">
        <button class=${tab === "ideas" ? "on" : ""} onClick=${() => go("/mine")}>Ideas</button>
        <button class=${tab === "recordings" ? "on" : ""} onClick=${() => go("/mine/recordings")}>Recordings</button>
      </div>
      ${tab === "ideas" ? html`<${MyIdeas} />` : html`<${MyRecordings} />`}
    </div>
    <a class="btn voice" href="#/capture" style="position:fixed;right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));border-radius:999px;min-height:52px;padding:0 20px;box-shadow:var(--shadow)">${icon("mic")} Record</a>
  </div>`;
}

function MyIdeas() {
  const { data, error, reload } = useData("/api/my/ideas", { poll: 15000 });
  if (!data) return error ? html`<${ErrorBox} error=${error} retry=${reload} />` : html`<${Loading} />`;
  if (!data.length) return html`<div class="empty">Ideas you record will appear here once they've been understood (usually within a minute).</div>`;
  return html`<div class="card flush list">
    ${data.map((i) => html`<a class="item" href=${`#/mine/ideas/${i.id}`} key=${i.id}>
      <div class="grow stack tight">
        <div class="row between nowrap"><span class="item-title clamp2">${i.title}</span><span class="tiny muted" style="flex:none">${ago(i.last_mentioned)}</span></div>
        <div class="small muted clamp2 bidi">${i.summary}</div>
        <div class="row"><span class="chip st st-${i.status}">${STATUS_FOR_HIM[i.status] ?? i.status}</span><span class="tiny muted">${i.mentions} ${i.mentions === 1 ? "recording" : "recordings"}</span></div>
      </div>
    </a>`)}
  </div>`;
}

function MyRecordings() {
  const { data, error, reload } = useData("/api/recordings?mine=1&limit=100", { poll: 8000 });
  if (!data) return error ? html`<${ErrorBox} error=${error} retry=${reload} />` : html`<${Loading} />`;
  if (!data.length) return html`<div class="empty">No recordings yet.</div>`;
  return html`<div class="card flush list">
    ${data.map((r) => html`<a class="item" href=${`#/mine/recordings/${r.id}`} key=${r.id}>
      <span style="width:20px;flex:none;color:var(--muted)">${icon(r.kind === "text" ? "keyboard" : "mic")}</span>
      <div class="grow stack tight">
        <div class="row between nowrap"><span class="item-title clamp2">${r.summary ?? (r.status === "done" ? "Recording" : "Being understood…")}</span><span class="tiny muted" style="flex:none">${ago(r.captured_at)}</span></div>
        ${r.ideas.length > 0 && html`<div class="row">${r.ideas.map((i) => html`<span class="chip tag" key=${i.id}>${i.title}</span>`)}</div>`}
      </div>
    </a>`)}
  </div>`;
}

export function MyIdea({ id }) {
  const { data: i, error, reload } = useData(`/api/my/ideas/${id}`);
  if (!i) return html`<div class="main"><div class="page narrow">${error ? html`<${TopBar} back="#/mine" backLabel="Your ideas" /><${ErrorBox} error=${error} retry=${reload} />` : html`<${Loading} />`}</div></div>`;
  return html`<div class="main" style="max-width:720px;margin:0 auto"><div class="page narrow">
    <${TopBar} back="#/mine" backLabel="Your ideas" />
    <div class="stack tight">
      <h1 class="bidi">${i.title}</h1>
      <div class="row"><span class="chip st st-${i.status}">${STATUS_FOR_HIM[i.status] ?? i.status}</span>${i.project_name && html`<span class="chip">Project: ${i.project_name}</span>`}</div>
    </div>
    <div class="card"><p class="bidi">${i.summary}</p></div>
    ${i.questions.length > 0 && html`<div class="card stack">
      <h3>Questions about it</h3>
      ${i.questions.map((q) => html`<div class="stack tight" key=${q.id}>
        <div class="small strong bidi">${q.text}</div>
        ${q.status === "answered" ? html`<div class="small muted bidi">You answered: ${q.answer_text}</div>` : html`<a class="small" href="#/capture">Answer it on the record screen</a>`}
      </div>`)}
    </div>`}
    <div class="stack">
      <div class="label">What you said</div>
      ${i.fragments.map((f) => html`<div class="card stack tight" key=${f.id}>
        <div class="row between"><span class="small muted">${when(f.captured_at)}</span>
          ${!!f.has_audio && html`<button class="play" onClick=${() => playAudio(f.recording_id, f.start_sec ?? 0)}>${icon("play")} Listen</button>`}
        </div>
        <${Quote} text=${f.quote} />
      </div>`)}
    </div>
    <p class="tiny muted">Your ideas are organized and developed in the workspace. You can always add more by recording again.</p>
  </div></div>`;
}

export function MyRecording({ id }) {
  const { data: r, error, reload } = useData(`/api/recordings/${id}`, { poll: 5000 });
  const [confirm, setConfirm] = useState(false);
  if (!r) return html`<div class="main"><div class="page narrow">${error ? html`<${TopBar} back="#/mine/recordings" backLabel="Recordings" /><${ErrorBox} error=${error} retry=${reload} />` : html`<${Loading} />`}</div></div>`;
  const remove = async () => {
    if (await act(() => del(`/api/recordings/${id}`), "Recording deleted")) go("/mine/recordings");
  };
  return html`<div class="main" style="max-width:720px;margin:0 auto"><div class="page narrow">
    <${TopBar} back="#/mine/recordings" backLabel="Recordings" />
    <div class="stack tight">
      <h1>${r.summary ?? "Recording"}</h1>
      <div class="small muted">${when(r.captured_at)}${r.duration_sec ? ` · ${clock(r.duration_sec)}` : ""}</div>
    </div>
    <div class="row">
      ${!!!!r.has_audio && html`<button class="btn" onClick=${() => playAudio(r.id, 0)}>${icon("play")} Play</button>`}
      <span class="spacer"></span>
      <button class="btn danger" onClick=${() => setConfirm(true)}>Delete recording</button>
    </div>
    ${r.fragments.length > 0 && html`<div class="card stack">
      <h3>Became</h3>
      ${r.fragments.map((f) => html`<div key=${f.id} class="stack tight">
        ${f.idea_id ? html`<a class="strong" href=${`#/mine/ideas/${f.idea_id}`}>${f.idea_title}</a>` : html`<span class="strong">${f.title}</span>`}
        <span class="small muted bidi">${f.summary}</span>
      </div>`)}
    </div>`}
    ${r.transcript && html`<div class="card stack"><h3>What you said</h3><p class="bidi" style="white-space:pre-wrap" dir="auto">${r.transcript}</p></div>`}
    ${confirm && html`<${Modal} title="Delete this recording?" onClose=${() => setConfirm(false)}>
      <p>It disappears from your list. Ideas that were already made from it stay as they are, and it can be restored if you change your mind.</p>
      <div class="modal-foot"><button class="btn" onClick=${() => setConfirm(false)}>Keep it</button><button class="btn danger" onClick=${remove}>Delete</button></div>
    <//>`}
  </div></div>`;
}
