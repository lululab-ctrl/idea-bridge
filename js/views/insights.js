import { useEffect, useState } from "preact/hooks";
import { act, ago, ErrorBox, get, html, icon, Loading, post, StatusChip, toast, useData, when, Working, api } from "../lib.js";

const CRIT = [
  ["value", "Value"],
  ["feasibility", "Feasibility"],
  ["cost", "Cost"],
  ["complexity", "Complexity"],
  ["strategic_fit", "Strategic fit"],
  ["effort", "Effort"],
];

export function Insights({ tab = "patterns" }) {
  const t = ["patterns", "priorities", "digests"].includes(tab) ? tab : "patterns";
  const go = (x) => (location.hash = x === "patterns" ? "#/insights" : `#/${x}`);
  return html`<div class="page">
    <div class="page-head">
      <div><h1>Insights</h1><div class="sub">The bigger picture: patterns in his thinking, what deserves attention first, and your digests.</div></div>
    </div>
    <div class="tabs">
      ${[["patterns", "Patterns"], ["priorities", "Priorities"], ["digests", "Digests"]].map(([k, l]) => html`<button class=${t === k ? "on" : ""} onClick=${() => go(k)}>${l}</button>`)}
    </div>
    ${t === "patterns" && html`<${Patterns} />`}
    ${t === "priorities" && html`<${Priorities} />`}
    ${t === "digests" && html`<${Digests} />`}
  </div>`;
}

function IdeaLink({ id, titles }) {
  return html`<a href=${`#/ideas/${id}`} class="chip tag">${titles?.[id] ?? `#${id}`}</a>`;
}

function Patterns() {
  const [poll, setPoll] = useState(0);
  const { data, error, reload } = useData("/api/insights", { poll });
  useEffect(() => setPoll(data?.running ? 4000 : 0), [data?.running]);
  if (!data) return error ? html`<${ErrorBox} error=${error} retry=${reload} />` : html`<${Loading} />`;
  const r = data.result;
  const T = data.titles;
  return html`<div class="stack">
    <div class="row between">
      <span class="small muted">${data.at ? `Last scan ${ago(data.at)}. A new scan runs every Monday with the weekly digest.` : "No scan yet."}</span>
      ${data.running ? html`<${Working} text="Scanning all ideas…" />` : html`<button class="btn" onClick=${() => act(() => post("/api/insights/run"), "Scanning. It takes a minute or two.")}>${icon("spark")} Scan now</button>`}
    </div>
    ${!r && html`<div class="empty">Once there are at least three ideas, a scan finds recurring patterns, the most promising opportunities, conflicts between ideas, combinations worth considering, and groups everything into themes.</div>`}
    ${r && html`
      <div class="card"><p class="bidi">${r.overview}</p></div>
      <div class="grid two" style="align-items:start">
        <div class="card stack"><h3>Recurring patterns</h3>
          ${r.patterns.length === 0 && html`<div class="small muted">None found.</div>`}
          ${r.patterns.map((p) => html`<div class="stack tight"><span class="strong">${p.title}</span><span class="small">${p.explanation}</span><div class="row">${p.idea_ids.map((id) => html`<${IdeaLink} id=${id} titles=${T} />`)}</div></div>`)}
        </div>
        <div class="card stack"><h3>Most promising now</h3>
          ${r.promising.map((p) => html`<div class="stack tight"><a class="strong" href=${`#/ideas/${p.idea_id}`}>${T[p.idea_id] ?? `#${p.idea_id}`}</a><span class="small">${p.why}</span></div>`)}
        </div>
        <div class="card stack"><h3>Possible conflicts</h3>
          ${r.conflicts.length === 0 && html`<div class="small muted">No conflicts found.</div>`}
          ${r.conflicts.map((c) => html`<div class="stack tight"><span class="small">${c.explanation}</span><div class="row">${c.idea_ids.map((id) => html`<${IdeaLink} id=${id} titles=${T} />`)}</div></div>`)}
        </div>
        <div class="card stack"><h3>Worth combining</h3>
          ${r.combinations.length === 0 && html`<div class="small muted">No combinations suggested.</div>`}
          ${r.combinations.map((c) => html`<div class="stack tight"><span class="small">${c.proposal}</span><div class="row">${c.idea_ids.map((id) => html`<${IdeaLink} id=${id} titles=${T} />`)}</div></div>`)}
        </div>
      </div>
      <div class="card stack"><h3>Themes</h3>
        <div class="grid three">${r.themes.map((th) => html`<div class="stack tight"><span class="strong">${th.name}</span><span class="small muted">${th.description}</span><span class="tiny muted">${th.idea_ids.length} ideas</span></div>`)}</div>
        <a class="small" href="#/ideas">Filter the library by theme</a>
      </div>`}
  </div>`;
}

function Priorities() {
  const { data, error, reload } = useData("/api/priorities");
  const [weights, setWeights] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => data && setWeights(data.weights), [data]);
  if (!data || !weights) return error ? html`<${ErrorBox} error=${error} retry=${reload} />` : html`<${Loading} />`;
  const scored = data.ideas.filter((i) => i.score != null);
  const unscored = data.ideas.filter((i) => i.score == null);
  const saveWeights = async () => {
    await act(() => api("PUT", "/api/settings", { weights }), "Weights saved. Scores recalculated.");
  };
  return html`<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));align-items:start">
    <div class="stack">
      <p class="small muted">Ideas ranked by their weighted evaluation (0–100). Open one to see the reasoning behind every score. Nothing is ranked on a hunch.</p>
      ${scored.length === 0 && html`<div class="empty">No evaluations yet. Moving an idea to “Under review” evaluates it automatically.</div>`}
      <div class="card flush list">
        ${scored.map((i, n) => html`<div class="item" key=${i.id} style="flex-direction:column">
          <div class="row nowrap" style="width:100%">
            <span class="num muted" style="width:1.6em">${n + 1}</span>
            <span class="score-big" style="font-size:1.4rem;min-width:2.3ch">${i.score}</span>
            <a class="grow strong" href=${`#/ideas/${i.id}`} style="min-width:0">${i.title}</a>
            <${StatusChip} status=${i.status} />
            <button class="btn ghost small" onClick=${() => setOpen(open === i.id ? null : i.id)}>${open === i.id ? "Hide" : "Why"}</button>
          </div>
          ${open === i.id && i.detail && html`<div class="stack tight" style="padding:8px 0 0 3.2em;width:100%">
            ${CRIT.map(([k, l]) => html`<div class="small"><b>${l} ${i.detail[k].score}/5</b> · ${i.detail[k].reason}</div>`)}
            <div class="small">${i.detail.overall_take}</div>
            ${!i.current && html`<div class="tiny muted">New information since this evaluation. Re-evaluate from the idea page.</div>`}
          </div>`}
        </div>`)}
      </div>
      ${unscored.length > 0 && html`<details><summary class="small muted">${unscored.length} active ideas not evaluated yet</summary>
        <div class="stack tight" style="margin-top:8px">${unscored.slice(0, 50).map((i) => html`<div class="row nowrap" key=${i.id}><a class="grow" href=${`#/ideas/${i.id}`}>${i.title}</a><button class="btn small" onClick=${() => act(() => post(`/api/ideas/${i.id}/score`), "Evaluating")}>Evaluate</button></div>`)}</div>
      </details>`}
    </div>
    <div class="card stack">
      <h3>What matters most to you</h3>
      <p class="small muted">Adjust how much each factor counts. 0 ignores it, 3 counts triple.</p>
      ${CRIT.map(([k, l]) => html`<label class="field" key=${k}><span class="row between"><span>${l}</span><span class="num muted">${Number(weights[k] ?? 1).toFixed(2)}</span></span>
        <input type="range" min="0" max="3" step="0.25" value=${weights[k] ?? 1} onInput=${(e) => setWeights({ ...weights, [k]: Number(e.target.value) })} /></label>`)}
      <button class="btn primary" onClick=${saveWeights}>Save weights</button>
    </div>
  </div>`;
}

function Digests() {
  const { data, error, reload } = useData("/api/digests");
  if (!data) return error ? html`<${ErrorBox} error=${error} retry=${reload} />` : html`<${Loading} />`;
  return html`<div class="stack">
    <div class="row between">
      <span class="small muted">A daily digest arrives each morning and a weekly one on Mondays (time and time zone in Settings).</span>
      <div class="row">
        <button class="btn small" onClick=${() => act(() => post("/api/digests/run", { kind: "daily" }), "Preparing today's digest")}>Daily digest now</button>
        <button class="btn small" onClick=${() => act(() => post("/api/digests/run", { kind: "weekly" }), "Preparing the weekly digest")}>Weekly digest now</button>
      </div>
    </div>
    ${data.length === 0 && html`<div class="empty">No digests yet.</div>`}
    ${data.map((d) => {
      const c = d.content;
      return html`<div class="card stack" key=${d.id}>
        <div class="row between"><span class="label">${d.kind === "weekly" ? "Weekly" : "Daily"} · ${when(d.period_end)}</span></div>
        ${c.quiet ? html`<p class="muted">A quiet ${d.kind === "weekly" ? "week" : "day"}: nothing new.</p>` : html`
          <h2>${c.text?.headline ?? `${c.newIdeas.length} new ideas`}</h2>
          ${c.text?.overview && html`<p class="bidi">${c.text.overview}</p>`}
          ${c.text?.attention?.length > 0 && html`<div class="stack tight"><div class="label">Worth your attention</div>${c.text.attention.map((a) => html`<div class="small">• ${a.text}${a.idea_id && html` <a href=${`#/ideas/${a.idea_id}`}>open</a>`}</div>`)}</div>`}
          <div class="row small muted"><span>${c.recordings} recordings</span><span>· ${c.newIdeas.length} new ideas</span><span>· ${c.updated.length} updated</span><span>· ${c.openReview} to review</span><span>· ${c.completed.length} tasks completed</span></div>
          ${c.newIdeas.length > 0 && html`<div class="row">${c.newIdeas.map((i) => html`<a class="chip tag" href=${`#/ideas/${i.id}`} key=${i.id}>${i.title}</a>`)}</div>`}`}
      </div>`;
    })}
  </div>`;
}
