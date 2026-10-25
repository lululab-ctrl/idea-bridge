import { act, clock, ErrorBox, html, icon, isRtl, Loading, patch, playAudio, post, StatusChip, useData, when, Working } from "../lib.js";
import { statusText } from "./library.js";

export function RecordingView({ id }) {
  const { data: r, error, reload } = useData(`/api/recordings/${id}`, { poll: 4000 });
  if (!r) return error ? html`<div class="page"><${ErrorBox} error=${error} retry=${reload} /></div>` : html`<${Loading} />`;
  const segs = r.segments?.segments ?? [];
  const timed = r.segments?.timed;
  const rtl = isRtl(r.transcript);
  return html`<div class="page narrow">
    <div class="row small muted"><a href="#/recordings">${icon("back")} Recordings</a></div>
    <div class="page-head">
      <div>
        <h1>${r.summary ?? (r.kind === "text" ? "Typed note" : "Recording")}</h1>
        <div class="sub">${when(r.captured_at)}${r.user_name ? ` · ${r.user_name}` : ""}${r.duration_sec ? ` · ${clock(r.duration_sec)}` : ""}${r.language ? ` · ${r.language}` : ""}</div>
      </div>
      <div class="row">
        ${r.has_audio && html`<button class="btn" onClick=${() => playAudio(r.id, 0)}>${icon("play")} Play</button>`}
        <button class="btn ghost" onClick=${() => act(() => patch(`/api/recordings/${r.id}`, { archived: true }), "Hidden from the recordings list")}>Hide</button>
      </div>
    </div>

    ${r.status === "failed" && html`<div class="banner bad"><div class="grow"><b>This recording couldn't be processed.</b> ${r.error ?? ""} The audio is safe.</div><button class="btn small" onClick=${() => act(() => post(`/api/recordings/${r.id}/retry`), "Trying again")}>Try again</button></div>`}
    ${!["done", "failed"].includes(r.status) && html`<${Working} text=${statusText(r)} />`}
    ${r.question && html`<div class="banner info"><div class="grow">Answer to: “${r.question.text}” · <a href=${`#/ideas/${r.question.idea_id}`}>open idea</a></div></div>`}

    ${r.fragments.length > 0 && html`<div class="card stack">
      <h3>Thoughts found in this recording</h3>
      ${r.fragments.map((f) => html`<div class="stack tight" key=${f.id}>
        <div class="row between nowrap">
          <span class="strong">${f.title}</span>
          ${f.idea_id ? html`<a class="small" href=${`#/ideas/${f.idea_id}`}>→ ${f.idea_title}</a>` : html`<span class="small muted">Not linked</span>`}
        </div>
        <div class="row">${f.idea_status && html`<${StatusChip} status=${f.idea_status} />`}<span class="tiny muted">${f.link_decision?.applied === "attached" ? "Added to an existing idea" : "Started a new idea"}${f.link_decision?.reason ? `: ${f.link_decision.reason}` : ""}</span></div>
        <p class="small bidi">${f.summary}</p>
        ${f.start_sec != null && r.has_audio && html`<div><button class="play" onClick=${() => playAudio(r.id, f.start_sec)}>${icon("play")} ${clock(f.start_sec)}</button></div>`}
      </div>`)}
    </div>`}

    ${r.transcript != null && html`<div class="card stack">
      <div class="row between"><h3>Transcript</h3><span class="tiny muted">${r.transcribed_by === "typed" ? "Typed" : `Transcribed by ${r.transcribed_by ?? "AI"}${timed ? "" : " · times are approximate"}`}</span></div>
      ${segs.length
        ? html`<div class="stack tight" dir=${rtl ? "rtl" : "ltr"}>${segs.map((s, i) => html`<div class="row nowrap" style="align-items:flex-start" key=${i}>
            ${r.has_audio && html`<button class="ref" style="flex:none;margin-top:3px" onClick=${() => playAudio(r.id, s.start)}>${clock(s.start)}</button>`}
            <span class="bidi">${s.text}</span>
          </div>`)}</div>`
        : html`<p class="bidi" style="white-space:pre-wrap" dir=${rtl ? "rtl" : "ltr"}>${r.transcript}</p>`}
    </div>`}
  </div>`;
}
