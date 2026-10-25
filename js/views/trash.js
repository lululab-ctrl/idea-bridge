import { useState } from "preact/hooks";
import { act, ago, api, clock, ErrorBox, html, icon, Loading, Modal, post, useData, when } from "../lib.js";

// Everything deleted lands here first. Restoring puts it back exactly as it was;
// removing permanently requires typing DELETE.
export function Trash() {
  const { data, error, reload } = useData("/api/trash");
  const [purge, setPurge] = useState(null); // { kind: 'recording'|'item', id, label }
  if (!data) return error ? html`<div class="page"><${ErrorBox} error=${error} retry=${reload} /></div>` : html`<${Loading} />`;
  const recs = data.recordings;
  return html`<div class="page narrow">
    <div class="page-head"><div><h1>Trash</h1><div class="sub">Deleted recordings, tasks, files, documents and notes. Nothing here is gone until you remove it permanently.</div></div></div>

    <div class="stack">
      <h2>Recordings</h2>
      ${recs.length === 0 && html`<div class="empty">No deleted recordings.</div>`}
      ${recs.length > 0 && html`<div class="card flush list">${recs.map((r) => html`<div class="item" key=${r.id}>
        <span style="color:var(--muted);width:20px;flex:none">${icon("mic")}</span>
        <div class="grow stack tight">
          <a class="item-title" href=${`#/recordings/${r.id}`}>${r.summary ?? `Recording from ${when(r.captured_at)}`}</a>
          <div class="tiny muted">${r.user_name ?? ""} · recorded ${when(r.captured_at)}${r.duration_sec ? ` · ${clock(r.duration_sec)}` : ""} · deleted by ${r.deleted_by_name ?? "someone"} ${ago(r.deleted_at)}</div>
          <div class="tiny muted">${r.ideas ? `${r.ideas} idea${r.ideas > 1 ? "s" : ""} built from it (unchanged)` : "No ideas built from it"}${r.purged_at ? " · audio and transcript permanently removed" : ""}</div>
        </div>
        <div class="row">
          <button class="btn small" onClick=${() => act(() => post(`/api/recordings/${r.id}/restore`), "Restored")}>Restore</button>
          ${!r.purged_at && html`<button class="btn ghost small danger" onClick=${() => setPurge({ kind: "recording", id: r.id, label: r.summary ?? "this recording" })}>Remove permanently</button>`}
        </div>
      </div>`)}</div>`}
    </div>

    <div class="stack">
      <h2>Tasks, files, documents and notes</h2>
      ${data.items.length === 0 && html`<div class="empty">Nothing here.</div>`}
      ${data.items.length > 0 && html`<div class="card flush list">${data.items.map((t) => html`<div class="item" key=${t.id}>
        <div class="grow stack tight"><span class="item-title">${t.label}</span><span class="tiny muted">Deleted by ${t.deleted_by_name ?? "someone"} ${ago(t.deleted_at)}</span></div>
        <div class="row">
          <button class="btn small" onClick=${() => act(() => post(`/api/trash/${t.id}/restore`), "Restored")}>Restore</button>
          <button class="btn ghost small danger" onClick=${() => setPurge({ kind: "item", id: t.id, label: t.label })}>Remove permanently</button>
        </div>
      </div>`)}</div>`}
    </div>
    ${purge && html`<${PurgeModal} purge=${purge} onClose=${() => setPurge(null)} />`}
  </div>`;
}

function PurgeModal({ purge, onClose }) {
  const [text, setText] = useState("");
  const isRec = purge.kind === "recording";
  const go = async () => {
    const url = isRec ? `/api/recordings/${purge.id}/purge` : `/api/trash/${purge.id}`;
    if (await act(() => api("DELETE", url, { confirm: text }), "Removed permanently")) onClose();
  };
  return html`<${Modal} title="Remove permanently?" onClose=${onClose}>
    <p><b>${purge.label}</b></p>
    <p class="small">${isRec
      ? "The audio file and full transcript will be erased and can't be recovered, including from this app. The ideas built from it keep the quoted words."
      : "This can't be undone from inside the app."} Nightly backups from before today still contain it.</p>
    <label class="field">Type DELETE to confirm<input type="text" value=${text} onInput=${(e) => setText(e.target.value)} autocomplete="off" /></label>
    <div class="modal-foot"><button class="btn" onClick=${onClose}>Cancel</button><button class="btn danger" disabled=${text !== "DELETE"} onClick=${go}>Remove permanently</button></div>
  <//>`;
}
