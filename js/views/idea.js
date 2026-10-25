import { useEffect, useState } from "preact/hooks";
import {
  act,
  ago,
  api,
  clock,
  COMMITMENT,
  del,
  download,
  dueLabel,
  ErrorBox,
  get,
  go,
  html,
  icon,
  Loading,
  Markdown,
  Modal,
  openFile,
  patch,
  personName,
  playAudio,
  post,
  PRIORITY,
  Quote,
  saveBlob,
  slugify,
  STATUS,
  StatusChip,
  toast,
  usePeople,
  uploadTo,
  useData,
  when,
  Working,
} from "../lib.js";

const SECTIONS = [
  ["summary", "Idea summary"],
  ["vision", "Underlying vision"],
  ["problem", "Problem being solved"],
  ["how_it_works", "How it might work"],
  ["audience", "Target audience or customers"],
  ["business_model", "Potential business model"],
  ["feasibility", "Feasibility and considerations"],
  ["next_steps", "Recommended next steps"],
  ["open_questions", "Open questions"],
];
const CRITERIA = [
  ["value", "Potential value", "5 = very valuable"],
  ["feasibility", "Feasibility", "5 = clearly doable"],
  ["cost", "Cost", "5 = cheap to try"],
  ["complexity", "Complexity", "5 = simple"],
  ["strategic_fit", "Strategic fit", "5 = fits your goals"],
  ["effort", "Effort", "5 = little effort"],
];
const LINK_TYPES = { related: "Related", builds_on: "Builds on", conflicts: "Conflicts with", combines: "Could combine with", duplicate: "Duplicate of" };
const BUSY = { report: "writing the full report", score: "evaluating", refresh_card: "updating the idea", move_fragment: "moving a recording", deliverable: "writing a document", embed_idea: "indexing" };
const TABS = [
  ["overview", "Overview"],
  ["report", "Report"],
  ["words", "His words"],
  ["connections", "Connections"],
  ["work", "Work"],
  ["history", "History"],
];

export function IdeaView({ id, me, tab = "overview" }) {
  const [poll, setPoll] = useState(0);
  const { data: idea, error, reload } = useData(`/api/ideas/${id}`, { poll });
  const { people } = usePeople();
  const him = personName(people, "visionary");
  const [modal, setModal] = useState(null);
  useEffect(() => setPoll(idea?.busy?.length ? 3000 : 0), [idea?.busy?.length]);

  if (!idea) return error ? html`<div class="page"><${ErrorBox} error=${error} retry=${reload} /></div>` : html`<${Loading} />`;
  const setTab = (t) => history.replaceState(null, "", `#/ideas/${id}/${t}`) || window.dispatchEvent(new HashChangeEvent("hashchange"));
  const busy = idea.busy.filter((b) => b !== "embed_idea");

  return html`<div class="page">
    <div class="idea-head">
      <div class="row small muted"><a href="#/ideas">${icon("back")} Library</a>${idea.theme && html`<span>· Theme: <a href=${`#/ideas?theme=${idea.theme.id}`}>${idea.theme.name}</a></span>`}${idea.project && html`<span>· Project: <a href=${`#/projects/${idea.project.id}`}>${idea.project.name}</a></span>`}</div>
      <${EditableTitle} idea=${idea} />
      <div class="row">
        <select style="width:auto" value=${idea.status} aria-label="Status" onChange=${(e) => act(() => patch(`/api/ideas/${id}`, { status: e.target.value }), `Moved to ${STATUS[e.target.value]}`)}>
          ${Object.entries(STATUS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}
        </select>
        <select style="width:auto" value=${idea.priority} aria-label="Priority" onChange=${(e) => act(() => patch(`/api/ideas/${id}`, { priority: e.target.value }), "Priority set")}>
          ${Object.entries(PRIORITY).map(([k, v]) => html`<option value=${k}>${v}</option>`)}
        </select>
        <select style="width:auto" value=${idea.commitment} aria-label="Commitment" title="What he expressed: a passing thought, an intention or a decision" onChange=${(e) => act(() => patch(`/api/ideas/${id}`, { commitment: e.target.value }), "Updated")}>
          ${Object.entries(COMMITMENT).map(([k, v]) => html`<option value=${k}>${v}</option>`)}
        </select>
        <span class="spacer"></span>
        ${!["approved", "in_progress", "completed"].includes(idea.status) && html`<button class="btn primary" onClick=${() => setModal("approve")}>${icon("check")} Approve</button>`}
        <button class="btn" onClick=${() => setModal("doc")}>${icon("doc")} Create document</button>
        <button class="btn" onClick=${() => setModal("more")}>More…</button>
      </div>
      ${busy.length > 0 && html`<${Working} text=${`The AI is ${busy.map((b) => BUSY[b] ?? b).join(" and ")}…`} />`}
      ${idea.review.length > 0 && html`<div class="banner info">${icon("inbox")}<div class="grow">This idea has ${idea.review.length} item${idea.review.length > 1 ? "s" : ""} in the review queue.</div><a class="btn small" href="#/review">Review</a></div>`}
    </div>

    <div class="tabs" role="tablist">
      ${TABS.map(([k, l]) => html`<button role="tab" class=${tab === k ? "on" : ""} onClick=${() => setTab(k)}>${l}${k === "words" ? ` (${idea.fragments.length})` : k === "connections" && idea.links.length ? ` (${idea.links.length})` : ""}</button>`)}
    </div>

    ${tab === "overview" && html`<${Overview} idea=${idea} him=${him} />`}
    ${tab === "report" && html`<${ReportTab} idea=${idea} him=${him} />`}
    ${tab === "words" && html`<${Words} idea=${idea} him=${him} />`}
    ${tab === "connections" && html`<${Connections} idea=${idea} />`}
    ${tab === "work" && html`<${Work} idea=${idea} people=${people} />`}
    ${tab === "history" && html`<${History} idea=${idea} />`}

    ${modal === "approve" && html`<${ApproveModal} idea=${idea} onClose=${() => setModal(null)} />`}
    ${modal === "doc" && html`<${DocModal} idea=${idea} onClose=${() => setModal(null)} />`}
    ${modal === "more" && html`<${MoreModal} idea=${idea} onClose=${() => setModal(null)} />`}
  </div>`;
}

function EditableTitle({ idea }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(idea.title);
  if (!editing) return html`<h1 class="idea-title editable bidi" onClick=${() => { setV(idea.title); setEditing(true); }} title="Click to rename">${idea.title}</h1>`;
  const save = async () => {
    if (v.trim() && v !== idea.title) await act(() => patch(`/api/ideas/${idea.id}`, { title: v }), "Renamed");
    setEditing(false);
  };
  return html`<div class="row nowrap"><input type="text" value=${v} onInput=${(e) => setV(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && save()} autofocus style="font-size:1.3rem;font-weight:700" /><button class="btn primary" onClick=${save}>Save</button><button class="btn" onClick=${() => setEditing(false)}>Cancel</button></div>`;
}

// One editable field of the idea card. Corrections are remembered and can teach the AI.
function Field({ idea, k, label, list, him }) {
  const card = idea.card;
  const value = k === "summary" ? idea.summary : card[k];
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [lesson, setLesson] = useState("");
  const edited = card.edited?.includes(k);
  const empty = list ? !value?.length : !value;
  const start = () => {
    setText(list ? (value ?? []).join("\n") : value ?? "");
    setLesson("");
    setEditing(true);
  };
  const save = async () => {
    const payload = { [k]: list ? text.split("\n").map((s) => s.trim()).filter(Boolean) : text };
    if (lesson.trim()) payload.lesson = lesson.trim();
    if (await act(() => patch(`/api/ideas/${idea.id}`, payload), lesson.trim() ? "Saved. The AI will remember this." : "Saved")) setEditing(false);
  };
  return html`<div class="fieldset">
    <div class="row between"><span class="label">${label}</span>${edited && html`<span class="edited-mark" title="Corrected by hand. AI updates keep this.">Corrected</span>`}</div>
    ${editing
      ? html`<div class="stack tight">
          <textarea value=${text} onInput=${(e) => setText(e.target.value)} dir="auto" placeholder=${list ? "One item per line" : ""}></textarea>
          <input type="text" value=${lesson} onInput=${(e) => setLesson(e.target.value)} placeholder=${`Optional: teach the AI (e.g. “When ${him} says ‘the app’, he means…”)`} />
          <div class="row"><button class="btn primary small" onClick=${save}>Save</button><button class="btn small" onClick=${() => setEditing(false)}>Cancel</button></div>
        </div>`
      : html`<div class="editable" onClick=${start} title="Click to correct">
          ${empty
            ? html`<div class="v none">Not mentioned yet</div>`
            : list
              ? html`<ul style="margin:0;padding-left:1.2em" class="bidi">${value.map((x, i) => html`<li key=${i}>${x}</li>`)}</ul>`
              : html`<div class="v">${value}</div>`}
        </div>`}
  </div>`;
}

function Overview({ idea, him }) {
  const c = idea.card;
  return html`<div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));align-items:start">
    <div class="card stack" style="grid-column:span 1">
      <${Field} idea=${idea} k="summary" label="Summary" him=${him} />
      <${Field} idea=${idea} k="vision" label="Underlying vision" him=${him} />
      <${Field} idea=${idea} k="problem" label="Problem being solved" him=${him} />
      <${Field} idea=${idea} k="how_it_works" label="How it might work" him=${him} />
      <${Field} idea=${idea} k="audience" label="Target audience or customers" him=${him} />
      <${Field} idea=${idea} k="business_model" label="Potential business model" him=${him} />
      <${Field} idea=${idea} k="challenges" label="Challenges and risks" list him=${him} />
      <${Field} idea=${idea} k="next_steps" label="Next steps" list him=${him} />
      ${c.missing_info?.length > 0 && html`<div class="fieldset"><span class="label">Missing information</span><ul style="margin:0;padding-left:1.2em" class="muted">${c.missing_info.map((m) => html`<li>${m}</li>`)}</ul></div>`}
      <${TagEditor} idea=${idea} />
    </div>
    <div class="stack">
      <${ScoreCard} idea=${idea} />
      <${QuestionsCard} idea=${idea} him=${him} />
      <div class="card stack">
        <h3>At a glance</h3>
        <div class="small stack tight">
          <div class="row between"><span class="muted">Captured</span><span>${when(idea.created_at)}</span></div>
          <div class="row between"><span class="muted">Mentioned</span><span>${idea.fragments.length} ${idea.fragments.length === 1 ? "time" : "times"}</span></div>
          <div class="row between"><span class="muted">Clarity</span><span>${idea.clarity}/5</span></div>
          <div class="row between"><span class="muted">Version</span><span>${idea.version}</span></div>
          <div class="row between"><span class="muted">Deadline</span><input type="date" style="width:auto;min-height:30px;padding:2px 6px" value=${idea.deadline ?? ""} onChange=${(e) => act(() => patch(`/api/ideas/${idea.id}`, { deadline: e.target.value }), "Deadline set")} /></div>
        </div>
      </div>
    </div>
  </div>`;
}

function TagEditor({ idea }) {
  const [v, setV] = useState("");
  const tags = idea.tags;
  const save = (next) => act(() => patch(`/api/ideas/${idea.id}`, { tags: next }));
  return html`<div class="fieldset">
    <span class="label">Tags</span>
    <div class="row">
      ${tags.map((t) => html`<span class="chip tag" key=${t}><a href=${`#/ideas?tag=${encodeURIComponent(t)}`}>${t}</a><button class="ref" style="margin:0;background:none;color:var(--muted)" aria-label=${`Remove ${t}`} onClick=${() => save(tags.filter((x) => x !== t))}>×</button></span>`)}
      <input type="text" value=${v} placeholder="Add tag" style="width:120px;min-height:28px;padding:2px 8px" onInput=${(e) => setV(e.target.value)} onKeyDown=${(e) => { if (e.key === "Enter" && v.trim()) { save([...tags, v.trim()]); setV(""); } }} />
    </div>
  </div>`;
}

function ScoreCard({ idea }) {
  const s = idea.score_detail;
  const evaluating = idea.busy.includes("score");
  return html`<div class="card stack">
    <div class="row between"><h3>Evaluation</h3>${s && html`<span class="score-big" title="Weighted score out of 100 (weights in Insights → Priorities)">${idea.score}</span>`}</div>
    ${!s && !evaluating && html`<p class="small muted">A transparent evaluation on value, feasibility, cost, complexity, strategic fit and effort, with the reasoning for each.</p>`}
    ${evaluating && html`<${Working} text="Evaluating…" />`}
    ${s && html`<div class="stack tight">
      ${CRITERIA.map(([k, label, scale]) => html`<div key=${k} class="stack tight">
        <div class="scorebar"><span class="small" title=${scale}>${label}</span><span class="bar"><i style=${`width:${(s[k].score / 5) * 100}%`}></i></span><span class="small num">${s[k].score}</span></div>
        <div class="tiny muted" style="padding-left:2px">${s[k].reason}</div>
      </div>`)}
      <div class="divider"></div>
      <p class="small">${s.overall_take}</p>
      <p class="small"><b>Biggest unknown:</b> ${s.biggest_unknown}</p>
      <p class="small"><b>Cheapest test:</b> ${s.cheapest_test}</p>
      ${!idea.score_current && html`<div class="tiny muted">There is newer information since this evaluation.</div>`}
    </div>`}
    <div><button class="btn small" disabled=${evaluating} onClick=${() => act(() => post(`/api/ideas/${idea.id}/score`), "Evaluation started")}>${s ? "Re-evaluate" : "Evaluate"}</button></div>
  </div>`;
}

function QuestionsCard({ idea, him }) {
  const [custom, setCustom] = useState("");
  const [answering, setAnswering] = useState(null);
  const [answer, setAnswer] = useState("");
  const drafts = idea.questions.filter((q) => q.status === "draft");
  const asked = idea.questions.filter((q) => q.status === "asked");
  const answered = idea.questions.filter((q) => q.status === "answered");
  return html`<div class="card stack">
    <h3>Questions for ${him}</h3>
    ${asked.map((q) => html`<div class="stack tight" key=${q.id}>
      <div class="small bidi"><span class="chip st st-needs_clarification">Waiting</span> ${q.text}</div>
      <div class="tiny muted">Asked ${ago(q.asked_at)}. He'll see it when he opens the app.</div>
      ${answering === q.id
        ? html`<div class="stack tight"><textarea value=${answer} onInput=${(e) => setAnswer(e.target.value)} placeholder="Type the answer he gave you in person" dir="auto"></textarea><div class="row"><button class="btn small primary" onClick=${async () => { if (await act(() => post(`/api/questions/${q.id}/answer`, { text: answer }), "Answer saved. Updating the idea.")) { setAnswering(null); setAnswer(""); } }}>Save answer</button><button class="btn small" onClick=${() => setAnswering(null)}>Cancel</button></div></div>`
        : html`<div><button class="btn ghost small" onClick=${() => setAnswering(q.id)}>He told me the answer</button></div>`}
    </div>`)}
    ${drafts.map((q) => html`<div class="row nowrap" key=${q.id}>
      <div class="grow small bidi">${q.text}${q.why && html`<div class="tiny muted">${q.why}</div>`}</div>
      <button class="btn small" onClick=${() => act(() => post(`/api/questions/${q.id}/ask`), `Sent to ${him}`)}>Ask</button>
      <button class="btn ghost small" aria-label="Dismiss" onClick=${() => act(() => post(`/api/questions/${q.id}/dismiss`))}>${icon("x")}</button>
    </div>`)}
    ${drafts.length === 0 && asked.length === 0 && html`<p class="small muted">No open questions.</p>`}
    <div class="row nowrap"><input type="text" value=${custom} onInput=${(e) => setCustom(e.target.value)} placeholder="Write your own question" /><button class="btn small" disabled=${!custom.trim()} onClick=${async () => { const r = await act(() => post(`/api/ideas/${idea.id}/questions`, { text: custom })); if (r) { await act(() => post(`/api/questions/${r.id}/ask`), `Sent to ${him}`); setCustom(""); } }}>Ask</button></div>
    ${answered.length > 0 && html`<details><summary class="small muted">${answered.length} answered</summary>${answered.map((q) => html`<div class="small" style="margin-top:8px" key=${q.id}><b class="bidi">${q.text}</b><div class="muted bidi">${q.answer_text}</div></div>`)}</details>`}
  </div>`;
}

function ReportTab({ idea, him }) {
  const r = idea.report;
  const working = idea.busy.includes("report");
  const frag = (fid) => idea.fragments.find((f) => f.id === fid);
  if (!r) {
    return html`<div class="card stack" style="align-items:flex-start">
      <h2>Full report</h2>
      <p class="muted">A complete write-up: what ${him} is trying to say, the vision, problem, how it might work, audience, business model, feasibility, next steps and open questions. Every point is labeled as something he said, an interpretation, or a suggestion.</p>
      ${working ? html`<${Working} text="Writing the report… this takes about a minute." />` : html`<button class="btn primary" onClick=${() => act(() => post(`/api/ideas/${idea.id}/report`), "Writing the report")}>Prepare full report</button>`}
    </div>`;
  }
  return html`<div class="stack">
    ${!idea.report_current && html`<div class="banner info"><div class="grow">${him} has added information since this report was written.</div><button class="btn small" disabled=${working} onClick=${() => act(() => post(`/api/ideas/${idea.id}/report`), "Updating the report")}>${working ? "Updating…" : "Update report"}</button></div>`}
    <div class="card stack">
      <div class="label">What ${him} is trying to say</div>
      <p class="bidi" style="font-size:1.05rem">${r.translation}</p>
      <p class="small muted">${r.confidence_note}</p>
    </div>
    <div class="legend"><span style="color:var(--said)">He said</span><span style="color:var(--interp)">Interpretation</span><span style="color:var(--sugg)">AI suggestion</span></div>
    ${SECTIONS.map(([k, label]) => {
      const s = r[k];
      return html`<div class="card stack tight" key=${k}>
        <div class="row between"><h3>${label}</h3><span class="cov">${s.coverage === "covered" ? "Covered" : s.coverage === "thin" ? "Touched on" : "Not mentioned"}</span></div>
        ${s.points.length === 0 && html`<div class="small muted">Nothing yet.</div>`}
        ${s.points.map((p, i) => html`<div class="point" key=${i}>
          <span class="pl pl-${p.label}">${p.label === "said" ? "He said" : p.label === "interpreted" ? "Interpretation" : "Suggestion"}</span>
          <span class="bidi">${p.text}${p.fragment_ids.map((fid) => {
            const f = frag(fid);
            return f && html`<button class="ref" title=${f.quote} onClick=${() => f.has_audio ? playAudio(f.recording_id, f.start_sec ?? 0) : toast(f.quote)}>${f.has_audio ? "▶ " : ""}${new Date(f.captured_at.replace(" ", "T") + "Z").toLocaleDateString(undefined, { day: "numeric", month: "short" })}</button>`;
          })}</span>
        </div>`)}
      </div>`;
    })}
    <div class="row"><button class="btn" disabled=${working} onClick=${() => act(() => post(`/api/ideas/${idea.id}/report`), "Rewriting the report")}>Rewrite report</button><button class="btn" onClick=${() => download(`/api/ideas/${idea.id}/export.md`, `${idea.id}-${slugify(idea.title)}.md`).catch((e) => toast(e.message, "error"))}>Download as Markdown</button></div>
  </div>`;
}

function Words({ idea, him }) {
  const [moving, setMoving] = useState(null);
  return html`<div class="stack">
    <p class="small muted">Every time ${him} talked about this idea, newest first. Tap Listen to hear the exact moment.</p>
    <div class="card flush">
      ${idea.fragments.map((f) => html`<div class="frag" key=${f.id}>
        <div class="row between">
          <span class="small strong">${when(f.captured_at)}${f.answers_question ? " · answer to your question" : ""}${f.recording_deleted_at ? html` <span class="chip" title="The recording is in the trash; his words are kept here">recording deleted</span>` : ""}</span>
          <div class="row">
            ${f.has_audio ? html`<button class="play" onClick=${() => playAudio(f.recording_id, f.start_sec ?? 0)}>${icon("play")} Listen${f.start_sec != null ? ` from ${clock(f.start_sec)}` : ""}</button>` : html`<span class="chip">Typed</span>`}
            <a class="btn ghost small" href=${`#/recordings/${f.recording_id}`}>Full recording</a>
          </div>
        </div>
        <${Quote} text=${f.quote} />
        ${f.interpretation && html`<div class="small"><span class="pl pl-interpreted">Interpretation</span> <span class="bidi">${f.interpretation}</span></div>`}
        ${f.link_decision?.reason && html`<div class="tiny muted">Why it's here: ${f.link_decision.reason}${f.link_decision.confidence != null && f.link_decision.applied === "attached" ? ` (${Math.round(f.link_decision.confidence * 100)}% sure)` : ""}</div>`}
        ${idea.fragments.length > 1 && html`<div class="row"><button class="btn ghost small" onClick=${() => setMoving(f)}>Doesn't belong here…</button></div>`}
      </div>`)}
    </div>
    ${moving && html`<${Modal} title="Move this recording" onClose=${() => setMoving(null)}>
      <${Quote} text=${moving.quote} />
      <button class="btn" onClick=${async () => { await act(() => post(`/api/fragments/${moving.id}/move`, { idea_id: null }), "Making it a separate idea"); setMoving(null); }}>Make it a separate idea</button>
      <div class="label">Or move it to another idea</div>
      <${IdeaPicker} exclude=${idea.id} onPick=${async (other) => { await act(() => post(`/api/fragments/${moving.id}/move`, { idea_id: other.id }), `Moving to “${other.title}”`); setMoving(null); }} />
    <//>`}
  </div>`;
}

export function IdeaPicker({ exclude, onPick }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState([]);
  useEffect(() => {
    const t = setTimeout(async () => {
      if (!q.trim()) {
        const recent = await get("/api/ideas?status=all&limit=8").catch(() => []);
        setRes(recent);
        return;
      }
      const r = await get(`/api/search?q=${encodeURIComponent(q)}`).catch(() => ({ ideas: [] }));
      setRes(r.ideas);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);
  return html`<div class="stack tight">
    <input type="search" placeholder="Search ideas" value=${q} onInput=${(e) => setQ(e.target.value)} autofocus />
    <div class="card flush list" style="max-height:300px;overflow:auto">
      ${res.filter((i) => i.id !== exclude).map((i) => html`<button class="item" style="background:none;border:0;border-bottom:1px solid var(--line);text-align:left;cursor:pointer;width:100%" key=${i.id} onClick=${() => onPick(i)}>
        <div class="grow"><div class="item-title">${i.title}</div><div class="tiny muted clamp2">${i.summary}</div></div><${StatusChip} status=${i.status} />
      </button>`)}
      ${res.length === 0 && html`<div class="empty">No matches.</div>`}
    </div>
  </div>`;
}

function Connections({ idea }) {
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState("related");
  return html`<div class="stack">
    <div class="row between"><p class="small muted">Ideas connected to this one. Suggested connections come from the AI and need your confirmation.</p><button class="btn" onClick=${() => setAdding(true)}>${icon("link")} Connect an idea</button></div>
    ${idea.links.length === 0 && html`<div class="empty">No connections yet.</div>`}
    ${idea.links.length > 0 && html`<div class="card flush list">${idea.links.map((l) => html`<div class="item" key=${l.id}>
      <div class="grow stack tight">
        <div class="row"><span class="chip ${l.type === "conflicts" ? "st st-needs_clarification" : ""}">${LINK_TYPES[l.type] ?? l.type}</span><a class="strong" href=${`#/ideas/${l.other_id}`}>${l.other_title}</a><${StatusChip} status=${l.other_status} />${l.status === "suggested" && html`<span class="chip">Suggested${l.confidence ? ` · ${Math.round(l.confidence * 100)}%` : ""}</span>`}</div>
        ${l.reason && html`<div class="small muted">${l.reason}</div>`}
      </div>
      <div class="row">
        ${l.status === "suggested" && html`<button class="btn small" onClick=${() => act(() => patch(`/api/links/${l.id}`, { status: "confirmed" }), "Connected")}>Confirm</button>`}
        <button class="btn ghost small" onClick=${() => act(() => patch(`/api/links/${l.id}`, { status: "dismissed" }), "Removed")}>Remove</button>
      </div>
    </div>`)}</div>`}
    ${adding && html`<${Modal} title="Connect an idea" onClose=${() => setAdding(false)}>
      <label class="field">How are they connected?<select value=${type} onChange=${(e) => setType(e.target.value)}>${Object.entries(LINK_TYPES).filter(([k]) => k !== "duplicate").map(([k, v]) => html`<option value=${k}>${v}</option>`)}</select></label>
      <${IdeaPicker} exclude=${idea.id} onPick=${async (o) => { await act(() => post("/api/links", { a: idea.id, b: o.id, type }), "Connected"); setAdding(false); }} />
    <//>`}
  </div>`;
}

function Work({ idea, people }) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [link, setLink] = useState("");
  const [doc, setDoc] = useState(null);
  const upload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    await act(async () => {
      const { path, uploadUrl } = await post(`/api/ideas/${idea.id}/attachments/upload-url`, { name: file.name, size: file.size });
      await uploadTo(uploadUrl, file);
      return post(`/api/ideas/${idea.id}/attachments`, { path, name: file.name, mime: file.type });
    }, "Attached");
  };
  return html`<div class="grid two" style="align-items:start">
    <div class="card stack">
      <h3>Tasks</h3>
      ${idea.tasks.length === 0 && html`<p class="small muted">No tasks. Approve the idea to get a full plan, or add a quick task here.</p>`}
      <div>${idea.tasks.map((t) => {
        const due = dueLabel(t.due_date);
        return html`<div class="task ${t.status === "done" ? "done" : ""}" key=${t.id}>
          <button class="tick" aria-label="Toggle done" onClick=${() => act(() => patch(`/api/tasks/${t.id}`, { status: t.status === "done" ? "todo" : "done" }))}>${t.status === "done" ? icon("check") : ""}</button>
          <a class="grow ttl" href=${`#/tasks?open=${t.id}`} style="color:inherit">${t.title}</a><span class="tiny ${due.cls}">${due.text}</span>
        </div>`;
      })}</div>
      <div class="row nowrap"><input type="text" value=${title} onInput=${(e) => setTitle(e.target.value)} placeholder="Add a task" onKeyDown=${(e) => e.key === "Enter" && title.trim() && act(() => post("/api/tasks", { title, idea_id: idea.id, project_id: idea.project_id }), "Task added").then(() => setTitle(""))} /><button class="btn small" disabled=${!title.trim()} onClick=${() => act(() => post("/api/tasks", { title, idea_id: idea.id, project_id: idea.project_id }), "Task added").then(() => setTitle(""))}>Add</button></div>
    </div>
    <div class="card stack">
      <h3>Notes</h3>
      ${idea.notes.map((n) => html`<div class="stack tight" key=${n.id}><div class="small bidi" style="white-space:pre-wrap">${n.body}</div><div class="tiny muted">${n.user_name} · ${ago(n.created_at)}</div></div>`)}
      <textarea value=${note} onInput=${(e) => setNote(e.target.value)} placeholder="Add a note. The AI reads notes when it updates the idea." dir="auto"></textarea>
      <div><button class="btn small" disabled=${!note.trim()} onClick=${() => act(() => post(`/api/ideas/${idea.id}/notes`, { body: note }), "Note added").then(() => setNote(""))}>Add note</button></div>
    </div>
    <div class="card stack">
      <h3>Files and links</h3>
      ${idea.attachments.map((a) => html`<div class="row nowrap" key=${a.id}>
        ${icon(a.kind === "link" ? "link" : "doc")}
        ${a.kind === "link"
          ? html`<a class="grow" href=${a.url} target="_blank" rel="noopener noreferrer">${a.name}</a>`
          : html`<button class="grow" style="background:none;border:0;padding:0;text-align:left;color:var(--accent);cursor:pointer" onClick=${() => openFile(`/api/attachments/${a.id}/file`)}>${a.name}</button>`}
        <span class="tiny muted">${a.user_name ?? ""}</span>
        <button class="btn ghost small" aria-label="Remove" onClick=${() => act(() => del(`/api/attachments/${a.id}`), "Moved to trash")}>${icon("x")}</button>
      </div>`)}
      <div class="row nowrap"><input type="url" value=${link} onInput=${(e) => setLink(e.target.value)} placeholder="Paste a link" /><button class="btn small" disabled=${!link.trim()} onClick=${() => act(() => post(`/api/ideas/${idea.id}/attachments`, { url: link }), "Link added").then(() => setLink(""))}>Add</button></div>
      <label class="btn small" style="cursor:pointer;align-self:flex-start">${icon("plus")} Upload a file or photo<input type="file" hidden onChange=${upload} /></label>
    </div>
    <div class="card stack">
      <h3>Documents</h3>
      ${idea.deliverables.length === 0 && html`<p class="small muted">Generate a business concept, implementation plan, research brief, product requirements or a one-pager from this idea.</p>`}
      ${idea.deliverables.map((d) => html`<div class="row nowrap" key=${d.id}>${icon("doc")}<button class="grow" style="background:none;border:0;text-align:left;color:var(--accent);cursor:pointer;padding:0" onClick=${async () => setDoc(await get(`/api/deliverables/${d.id}`))}>${d.title}</button><span class="tiny muted">${ago(d.created_at)}</span></div>`)}
      ${idea.busy.includes("deliverable") && html`<${Working} text="Writing the document…" />`}
    </div>
    ${doc && html`<${Modal} title=${doc.title} wide onClose=${() => setDoc(null)}>
      <${Markdown} text=${doc.markdown} />
      <div class="modal-foot">
        <button class="btn danger" onClick=${async () => { await act(() => del(`/api/deliverables/${doc.id}`), "Moved to trash"); setDoc(null); }}>Delete</button>
        <button class="btn" onClick=${() => navigator.clipboard?.writeText(doc.markdown).then(() => toast("Copied"), () => toast("Couldn't copy", "error"))}>Copy</button>
        <button class="btn primary" onClick=${() => saveBlob(new Blob([doc.markdown], { type: "text/markdown" }), `${slugify(doc.title)}.md`)}>Download</button>
      </div>
    <//>`}
  </div>`;
}

function History({ idea }) {
  const [view, setView] = useState(null);
  return html`<div class="grid two" style="align-items:start">
    <div class="card flush">
      <div style="padding:14px 16px 4px"><h3>Versions</h3><p class="small muted">The idea is saved in full every time it changes, so you can see how it evolved and go back.</p></div>
      ${idea.versions.map((v) => html`<div class="version" key=${v.version}>
        <span class="chip num">v${v.version}</span>
        <div class="stack tight"><span class="small">${v.change_summary}</span><span class="tiny muted">${when(v.created_at)} · ${v.source === "recording" ? "from a recording" : v.source === "edit" ? `corrected by ${v.user_name ?? "hand"}` : v.source}</span></div>
        <button class="btn ghost small" onClick=${async () => setView(await get(`/api/ideas/${idea.id}/versions/${v.version}`))}>View</button>
      </div>`)}
    </div>
    <div class="card stack">
      <h3>Activity</h3>
      ${idea.activity.length === 0 && html`<div class="small muted">No activity yet.</div>`}
      ${idea.activity.map((a, i) => html`<div class="small" key=${i}><b>${a.user_name ?? "AI"}</b> ${a.action.replace(/_/g, " ")}${a.detail ? `: ${a.detail}` : ""} <span class="tiny muted">· ${ago(a.created_at)}</span></div>`)}
    </div>
    ${view && html`<${Modal} title=${`Version ${view.version}`} wide onClose=${() => setView(null)}>
      <div class="small muted">${view.change_summary} · ${when(view.created_at)}</div>
      <h3>${view.title}</h3>
      <p class="bidi">${view.summary}</p>
      ${["vision", "problem", "how_it_works", "audience", "business_model"].map((k) => view.card[k] && html`<div class="fieldset" key=${k}><span class="label">${k.replace(/_/g, " ")}</span><div class="v ${view.card[k] !== idea.card[k] ? "diff-old" : ""}" style="text-decoration:none">${view.card[k]}</div></div>`)}
      <div class="tiny muted">Highlighted fields differ from the current version.</div>
      <div class="modal-foot">${view.version !== idea.version && html`<button class="btn primary" onClick=${async () => { await act(() => post(`/api/ideas/${idea.id}/versions/${view.version}/restore`), `Restored version ${view.version}`); setView(null); }}>Restore this version</button>`}</div>
    <//>`}
  </div>`;
}

function ApproveModal({ idea, onClose }) {
  const projects = useData("/api/projects");
  const [mode, setMode] = useState("new");
  const [name, setName] = useState(idea.title);
  const [pid, setPid] = useState("");
  const [plan, setPlan] = useState(true);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r = await act(() => post(`/api/ideas/${idea.id}/approve`, mode === "new" ? { project_name: name, plan } : { project_id: Number(pid), plan }), "Approved");
    setBusy(false);
    if (r) {
      onClose();
      go(`/projects/${r.projectId}`);
    }
  };
  const active = (projects.data ?? []).filter((p) => p.status === "active");
  return html`<${Modal} title="Approve and commit" onClose=${onClose}>
    <p class="small">Approving turns this idea into a commitment: it becomes part of a project with tasks and deadlines. Ideas that are not approved stay as brainstorms and never create obligations.</p>
    <label class="check"><input type="radio" checked=${mode === "new"} onChange=${() => setMode("new")} /><span>Start a new project</span></label>
    ${mode === "new" && html`<input type="text" value=${name} onInput=${(e) => setName(e.target.value)} />`}
    ${active.length > 0 && html`<label class="check"><input type="radio" checked=${mode === "existing"} onChange=${() => setMode("existing")} /><span>Add to an existing project</span></label>`}
    ${mode === "existing" && html`<select value=${pid} onChange=${(e) => setPid(e.target.value)}><option value="">Choose…</option>${active.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select>`}
    <label class="check"><input type="checkbox" checked=${plan} onChange=${(e) => setPlan(e.target.checked)} /><span>Draft a step-by-step plan with milestones and tasks (you review it before anything is created)</span></label>
    <div class="modal-foot"><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${busy || (mode === "existing" && !pid)} onClick=${submit}>Approve</button></div>
  <//>`;
}

function DocModal({ idea, onClose }) {
  const kinds = useData("/api/deliverable-kinds");
  const [kind, setKind] = useState("business_concept");
  const [instructions, setInstructions] = useState("");
  return html`<${Modal} title="Create a document" onClose=${onClose}>
    <p class="small muted">The AI writes it from everything known about this idea. You'll find it under Work → Documents in about a minute.</p>
    <div class="stack tight">
      ${[...(kinds.data ?? []), { kind: "custom", title: "Something else…" }].map((k) => html`<label class="check" key=${k.kind}><input type="radio" name="kind" checked=${kind === k.kind} onChange=${() => setKind(k.kind)} /><span>${k.title}</span></label>`)}
    </div>
    <label class="field">${kind === "custom" ? "Describe the document" : "Anything to emphasize? (optional)"}<textarea value=${instructions} onInput=${(e) => setInstructions(e.target.value)} placeholder=${kind === "custom" ? "e.g. A one-page pitch for a potential partner" : "e.g. Focus on the first 3 months"}></textarea></label>
    <div class="modal-foot"><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${kind === "custom" && !instructions.trim()} onClick=${async () => { if (await act(() => post(`/api/ideas/${idea.id}/deliverables`, { kind, instructions }), "Writing the document")) { onClose(); history.replaceState(null, "", `#/ideas/${idea.id}/work`); window.dispatchEvent(new HashChangeEvent("hashchange")); } }}>Create</button></div>
  <//>`;
}

function MoreModal({ idea, onClose }) {
  const [merging, setMerging] = useState(false);
  if (merging) {
    return html`<${Modal} title="Merge another idea into this one" onClose=${onClose}>
      <p class="small">All recordings, notes, files and answered questions of the other idea move here. The other idea is archived, not deleted, and you can move individual recordings back out later.</p>
      <${IdeaPicker} exclude=${idea.id} onPick=${async (o) => { await act(() => post(`/api/ideas/${idea.id}/merge`, { other_id: o.id }), `Merged “${o.title}”`); onClose(); }} />
    <//>`;
  }
  return html`<${Modal} title="More actions" onClose=${onClose}>
    <div class="stack tight">
      <button class="btn" onClick=${() => setMerging(true)}>${icon("merge")} Merge another idea into this one</button>
      <button class="btn" onClick=${() => act(() => post(`/api/ideas/${idea.id}/refresh`), "Rebuilding the idea from all recordings").then(onClose)}>${icon("undo")} Rebuild the card from all recordings</button>
      <button class="btn" onClick=${() => download(`/api/ideas/${idea.id}/export.md`, `${idea.id}-${slugify(idea.title)}.md`).catch((e) => toast(e.message, "error"))}>${icon("doc")} Download as Markdown</button>
      <button class="btn" onClick=${() => { onClose(); setTimeout(() => window.print(), 100); }}>Print or save as PDF</button>
      ${idea.status !== "archived" && html`<button class="btn danger" onClick=${() => act(() => patch(`/api/ideas/${idea.id}`, { status: "archived" }), "Archived").then(onClose)}>${icon("archive")} Archive</button>`}
    </div>
  <//>`;
}
