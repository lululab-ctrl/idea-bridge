import { useEffect, useState } from "preact/hooks";
import { ago, clock, CommitChip, ErrorBox, html, icon, Loading, PRIORITY, setQuery, STATUS, StatusChip, useData, Working } from "../lib.js";

const FILTERS = [
  ["active", "All active"],
  ["new", "New"],
  ["needs_clarification", "Needs clarification"],
  ["under_review", "Under review"],
  ["approved", "Approved"],
  ["in_progress", "In progress"],
  ["on_hold", "On hold"],
  ["completed", "Completed"],
  ["archived", "Archived"],
  ["all", "Everything"],
];

export function Library({ query }) {
  const view = query.view === "recordings" ? "recordings" : "ideas";
  return html`<div class="page">
    <div class="page-head">
      <div><h1>Library</h1><div class="sub">Every idea and every recording, searchable by words and by meaning.</div></div>
      <div class="tabs" style="border:0">
        <button class=${view === "ideas" ? "on" : ""} onClick=${() => (location.hash = "#/ideas")}>Ideas</button>
        <button class=${view === "recordings" ? "on" : ""} onClick=${() => (location.hash = "#/recordings")}>Recordings</button>
      </div>
    </div>
    ${view === "ideas" ? html`<${Ideas} query=${query} />` : html`<${Recordings} query=${query} />`}
  </div>`;
}

function Ideas({ query }) {
  const [text, setText] = useState(query.q ?? "");
  useEffect(() => setText(query.q ?? ""), [query.q]);
  // Search as you type, but only after a short pause.
  useEffect(() => {
    const t = setTimeout(() => text !== (query.q ?? "") && setQuery({ q: text }), 350);
    return () => clearTimeout(t);
  }, [text]);

  const status = query.status ?? (query.q ? "all" : "active");
  const params = new URLSearchParams();
  if (status !== "all") params.set("status", status);
  for (const k of ["q", "tag", "theme", "priority", "commitment", "sort", "project"]) if (query[k]) params.set(k, query[k]);
  const { data, error, loading, reload } = useData(`/api/ideas?${params}`);
  const themes = useData("/api/themes");
  const tags = useData("/api/tags");

  return html`<div class="stack">
    <div class="search">${icon("search")}<input type="search" placeholder="Search ideas… e.g. “AI business” or “something for parents”" value=${text} onInput=${(e) => setText(e.target.value)} aria-label="Search ideas" /></div>
    <div class="row">
      ${FILTERS.map(([v, l]) => html`<button class="chip ${status === v ? "on" : ""}" key=${v} onClick=${() => setQuery({ status: v === "active" && !query.q ? "" : v })}>${l}</button>`)}
    </div>
    <div class="row">
      <select style="width:auto" value=${query.theme ?? ""} onChange=${(e) => setQuery({ theme: e.target.value })} aria-label="Theme">
        <option value="">All themes</option>
        ${(themes.data ?? []).map((t) => html`<option value=${t.id}>${t.name} (${t.n})</option>`)}
      </select>
      <select style="width:auto" value=${query.tag ?? ""} onChange=${(e) => setQuery({ tag: e.target.value })} aria-label="Tag">
        <option value="">All tags</option>
        ${(tags.data ?? []).map((t) => html`<option value=${t.tag}>${t.tag} (${t.n})</option>`)}
      </select>
      <select style="width:auto" value=${query.priority ?? ""} onChange=${(e) => setQuery({ priority: e.target.value })} aria-label="Priority">
        <option value="">Any priority</option>
        ${Object.entries(PRIORITY).map(([k, v]) => html`<option value=${k}>${v}</option>`)}
      </select>
      <select style="width:auto" value=${query.commitment ?? ""} onChange=${(e) => setQuery({ commitment: e.target.value })} aria-label="Commitment">
        <option value="">Brainstorms and commitments</option>
        <option value="brainstorm">Brainstorms</option>
        <option value="intention">Intentions</option>
        <option value="decision">Decisions</option>
      </select>
      ${!query.q && html`<select style="width:auto" value=${query.sort ?? "recent"} onChange=${(e) => setQuery({ sort: e.target.value })} aria-label="Sort">
        <option value="recent">Recently active</option>
        <option value="created">Newest first</option>
        <option value="priority">Priority</option>
        <option value="score">Evaluation score</option>
        <option value="title">A–Z</option>
      </select>`}
      ${(query.theme || query.tag || query.priority || query.commitment || query.project) && html`<button class="btn ghost small" onClick=${() => setQuery({ theme: "", tag: "", priority: "", commitment: "", project: "" })}>Clear filters</button>`}
    </div>
    ${error && html`<${ErrorBox} error=${error} retry=${reload} />`}
    ${!data && loading && html`<${Working} text="Searching…" />`}
    ${data && html`<div class="small muted">${data.length} ${data.length === 1 ? "idea" : "ideas"}${query.q ? ` matching “${query.q}”` : ""}</div>`}
    ${data && data.length === 0 && html`<div class="empty">${query.q ? "Nothing matches. Try other words; search also understands meaning, so describe what you're looking for." : "No ideas here yet."}</div>`}
    ${data && data.length > 0 && html`<div class="card flush list">
      ${data.map((i) => html`<${IdeaRow} i=${i} key=${i.id} />`)}
    </div>`}
  </div>`;
}

export function IdeaRow({ i }) {
  return html`<a class="item" href=${`#/ideas/${i.id}`}>
    <div class="grow stack tight">
      <div class="row between nowrap">
        <span class="item-title clamp2">${i.title}</span>
        ${i.score != null && html`<span class="small num strong" style="color:var(--accent);flex:none" title="Weighted evaluation score">${i.score}</span>`}
      </div>
      <div class="small muted clamp2 bidi">${i.match?.snippet ? html`<span dangerouslySetInnerHTML=${{ __html: escapeSnippet(i.match.snippet) }}></span>` : i.summary}</div>
      <div class="row">
        <${StatusChip} status=${i.status} />
        <${CommitChip} c=${i.commitment} />
        ${i.priority !== "none" && html`<span class="chip pr-${i.priority}">${PRIORITY[i.priority]}</span>`}
        ${i.tags.slice(0, 3).map((t) => html`<span class="chip tag" key=${t}>${t}</span>`)}
        ${i.match?.matchedBy?.includes("meaning") && !i.match.matchedBy.includes("words") && html`<span class="chip" title="Found by meaning, not exact words">by meaning</span>`}
        <span class="tiny muted">${i.mentions} ${i.mentions === 1 ? "mention" : "mentions"} · ${ago(i.last_activity_at)}</span>
      </div>
    </div>
  </a>`;
}

function escapeSnippet(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/«/g, "<mark>").replace(/»/g, "</mark>");
}

function Recordings({ query }) {
  const params = new URLSearchParams({ limit: "100" });
  if (query.status) params.set("status", query.status);
  const { data, error, reload } = useData(`/api/recordings?${params}`, { poll: 10000 });
  if (!data) return error ? html`<${ErrorBox} error=${error} retry=${reload} />` : html`<${Loading} />`;
  return html`<div class="stack">
    <div class="row">
      ${[["", "All"], ["failed", "Needs attention"], ["queued", "Queued"]].map(([v, l]) => html`<button class="chip ${(query.status ?? "") === v ? "on" : ""}" onClick=${() => setQuery({ status: v })}>${l}</button>`)}
    </div>
    ${data.length === 0 && html`<div class="empty">No recordings yet.</div>`}
    <div class="card flush list">
      ${data.map(
        (r) => html`<a class="item" href=${`#/recordings/${r.id}`} key=${r.id}>
          <span style="color:${r.status === "failed" ? "var(--bad)" : "var(--muted)"};width:20px;flex:none">${icon(r.kind === "text" ? "keyboard" : "mic")}</span>
          <div class="grow stack tight">
            <div class="row between nowrap">
              <span class="item-title clamp2">${r.summary ?? (r.status === "done" ? "Recording" : statusText(r))}</span>
              <span class="tiny muted" style="flex:none">${ago(r.captured_at)}${r.duration_sec ? ` · ${clock(r.duration_sec)}` : ""}</span>
            </div>
            ${r.excerpt && html`<div class="small muted clamp2 bidi">${r.excerpt}</div>`}
            <div class="row">
              ${r.status !== "done" && html`<span class="chip ${r.status === "failed" ? "st st-needs_clarification" : ""}">${statusText(r)}</span>`}
              ${r.ideas.map((i) => html`<span class="chip tag" key=${i.id}>${i.title}</span>`)}
              ${r.user_name && html`<span class="tiny muted">by ${r.user_name}</span>`}
            </div>
          </div>
        </a>`,
      )}
    </div>
  </div>`;
}

export function statusText(r) {
  if (r.status === "failed") return "Needs attention";
  if (r.retrying) return "Waiting to retry";
  return { queued: "Queued", transcribing: "Transcribing…", analyzing: "Understanding…", done: "Done" }[r.status] ?? r.status;
}

export { STATUS };
