import { useEffect, useState } from "preact/hooks";
import { act, ago, dueLabel, ErrorBox, html, icon, Loading, Modal, patch, post, StatusChip, useData, Working } from "../lib.js";
import { TaskRow, TaskModal } from "./tasks.js";

const PSTATUS = { active: "Active", on_hold: "On hold", completed: "Completed", archived: "Archived" };

export function Projects() {
  const { data, error, reload } = useData("/api/projects", { poll: 15000 });
  const [creating, setCreating] = useState(false);
  if (!data) return error ? html`<div class="page"><${ErrorBox} error=${error} retry=${reload} /></div>` : html`<${Loading} />`;
  const groups = Object.keys(PSTATUS).map((s) => [s, data.filter((p) => p.status === s)]);
  return html`<div class="page">
    <div class="page-head">
      <div><h1>Projects</h1><div class="sub">Approved ideas you've committed to, with plans and progress.</div></div>
      <button class="btn" onClick=${() => setCreating(true)}>${icon("plus")} New project</button>
    </div>
    ${data.length === 0 && html`<div class="empty">No projects yet. Open an idea and press Approve to turn it into a project with a plan.</div>`}
    ${groups.filter(([, list]) => list.length).map(([s, list]) => html`<div class="stack" key=${s}>
      <div class="label">${PSTATUS[s]}</div>
      <div class="grid three">${list.map((p) => {
        const pct = p.tasks_total ? Math.round((p.tasks_done / p.tasks_total) * 100) : 0;
        const due = dueLabel(p.deadline);
        return html`<a class="card stack" href=${`#/projects/${p.id}`} style="color:inherit;text-decoration:none" key=${p.id}>
          <div class="row between nowrap"><h3>${p.name}</h3><span class="small num muted">${pct}%</span></div>
          <div class="progress"><i style=${`width:${pct}%`}></i></div>
          <div class="small muted">
            ${p.plan_status === "generating" ? "Drafting plan…" : p.plan_status === "draft" ? "Draft plan waiting for your review" : `${p.tasks_done} of ${p.tasks_total} tasks done`}
            ${p.tasks_overdue > 0 && html` · <span class="due-over">${p.tasks_overdue} overdue</span>`}
          </div>
          ${p.next_task && html`<div class="small">Next: ${p.next_task.title}</div>`}
          ${p.deadline && html`<div class="tiny ${due.cls}">Target ${p.deadline}</div>`}
        </a>`;
      })}</div>
    </div>`)}
    ${creating && html`<${NewProject} onClose=${() => setCreating(false)} />`}
  </div>`;
}

function NewProject({ onClose }) {
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  return html`<${Modal} title="New project" onClose=${onClose}>
    <label class="field">Name<input type="text" value=${name} onInput=${(e) => setName(e.target.value)} autofocus /></label>
    <label class="field">Description<textarea value=${desc} onInput=${(e) => setDesc(e.target.value)}></textarea></label>
    <p class="small muted">Tip: approving an idea creates a project automatically and drafts a plan for it.</p>
    <div class="modal-foot"><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${!name.trim()} onClick=${async () => { const r = await act(() => post("/api/projects", { name, description: desc }), "Project created"); if (r) { onClose(); location.hash = `#/projects/${r.id}`; } }}>Create</button></div>
  <//>`;
}

export function ProjectView({ id, me }) {
  const [poll, setPoll] = useState(0);
  const { data: p, error, reload } = useData(`/api/projects/${id}`, { poll });
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => setPoll(p?.plan_status === "generating" ? 3000 : 0), [p?.plan_status]);
  if (!p) return error ? html`<div class="page"><${ErrorBox} error=${error} retry=${reload} /></div>` : html`<${Loading} />`;

  const pct = p.tasks_total ? Math.round((p.tasks_done / p.tasks_total) * 100) : 0;
  const milestones = [...new Set(p.tasks.map((t) => t.milestone ?? "Tasks"))];

  return html`<div class="page">
    <div class="row small muted"><a href="#/projects">${icon("back")} Projects</a></div>
    <div class="page-head">
      <div class="stack tight" style="min-width:0">
        <h1>${p.name}</h1>
        ${p.description && html`<p class="muted bidi">${p.description}</p>`}
      </div>
      <div class="row">
        <select style="width:auto" value=${p.status} aria-label="Project status" onChange=${(e) => act(() => patch(`/api/projects/${id}`, { status: e.target.value }), "Updated")}>
          ${Object.entries(PSTATUS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}
        </select>
        <label class="small muted row nowrap">Target <input type="date" style="width:auto" value=${p.deadline ?? ""} onChange=${(e) => act(() => patch(`/api/projects/${id}`, { deadline: e.target.value }), "Target date set")} /></label>
      </div>
    </div>

    <div class="card stack">
      <div class="row between"><span class="strong">${p.tasks_done} of ${p.tasks_total} tasks done</span><span class="num muted">${pct}%</span></div>
      <div class="progress"><i style=${`width:${pct}%`}></i></div>
      ${p.tasks_overdue > 0 && html`<span class="small due-over">${p.tasks_overdue} overdue</span>`}
    </div>

    ${p.plan_status === "generating" && html`<div class="card"><${Working} text="Drafting a step-by-step plan from the idea… about a minute." /></div>`}
    ${p.plan_status === "failed" && html`<div class="banner bad"><div class="grow">The plan couldn't be drafted.</div><button class="btn small" onClick=${() => act(() => post(`/api/projects/${id}/plan`), "Trying again")}>Try again</button></div>`}
    ${p.plan_status === "draft" && p.plan && html`<${PlanReview} project=${p} />`}

    ${p.tasks.length > 0 && html`<div class="stack">
      <div class="row between"><h2>Tasks</h2><button class="btn small" onClick=${() => setAdding(true)}>${icon("plus")} Add task</button></div>
      ${milestones.map((m) => html`<div class="card flush" key=${m}>
        <div style="padding:12px 14px 6px" class="row between"><h3>${m}</h3><span class="tiny muted">${p.tasks.filter((t) => (t.milestone ?? "Tasks") === m && t.status === "done").length}/${p.tasks.filter((t) => (t.milestone ?? "Tasks") === m).length}</span></div>
        ${p.tasks.filter((t) => (t.milestone ?? "Tasks") === m).map((t) => html`<${TaskRow} t=${t} key=${t.id} onOpen=${() => setOpen(t)} />`)}
      </div>`)}
    </div>`}
    ${p.tasks.length === 0 && p.plan_status !== "draft" && p.plan_status !== "generating" && html`<div class="empty">No tasks yet. <button class="btn small" onClick=${() => setAdding(true)}>Add a task</button>${p.ideas.length > 0 && html` <button class="btn small" onClick=${() => act(() => post(`/api/projects/${id}/plan`), "Drafting a plan")}>Draft a plan with AI</button>`}</div>`}

    <div class="grid two" style="align-items:start">
      <div class="card stack">
        <h3>Ideas in this project</h3>
        ${p.ideas.map((i) => html`<a href=${`#/ideas/${i.id}`} class="stack tight" style="color:inherit" key=${i.id}><span class="strong">${i.title}</span><span class="small muted clamp2">${i.summary}</span><${StatusChip} status=${i.status} /></a>`)}
      </div>
      <div class="card stack">
        <h3>Project notes</h3>
        ${p.notes.map((n) => html`<div key=${n.id}><div class="small bidi" style="white-space:pre-wrap">${n.body}</div><div class="tiny muted">${n.user_name} · ${ago(n.created_at)}</div></div>`)}
        <textarea value=${note} onInput=${(e) => setNote(e.target.value)} placeholder="Decisions, progress, links…" dir="auto"></textarea>
        <div><button class="btn small" disabled=${!note.trim()} onClick=${() => act(() => post(`/api/projects/${id}/notes`, { body: note }), "Note added").then(() => setNote(""))}>Add note</button></div>
      </div>
    </div>
    ${(open || adding) && html`<${TaskModal} task=${open} projectId=${id} onClose=${() => { setOpen(null); setAdding(false); }} />`}
  </div>`;
}

function PlanReview({ project }) {
  const plan = project.plan;
  const [chosen, setChosen] = useState(() => new Set(plan.tasks.map((_, i) => i)));
  const toggle = (i) => {
    const n = new Set(chosen);
    n.has(i) ? n.delete(i) : n.add(i);
    setChosen(n);
  };
  return html`<div class="card stack">
    <div class="row between"><h2>Draft plan</h2><span class="chip">Review before it becomes real</span></div>
    <div class="stack tight">
      <p><b>Goal:</b> ${plan.goal}</p>
      <p><b>Done when:</b> ${plan.definition_of_done}</p>
      <p><b>First step today:</b> ${plan.first_step_today}</p>
    </div>
    ${plan.milestones.map((m) => html`<div class="stack tight" key=${m.name}>
      <div class="row between"><h3>${m.name}</h3><span class="tiny muted">~ day ${m.target_offset_days}</span></div>
      <div class="small muted">${m.outcome}</div>
      ${plan.tasks.map((t, i) => t.milestone === m.name && html`<label class="check" key=${i} style="padding:6px 0;border-top:1px dashed var(--line)">
        <input type="checkbox" checked=${chosen.has(i)} onChange=${() => toggle(i)} />
        <span class="stack tight"><span class="strong">${t.title}</span><span class="small">${t.instructions}</span><span class="tiny muted">Outcome: ${t.expected_outcome} · ${t.owner === "either" ? "Either of you" : t.owner === "visionary" ? "Him" : "You"} · day ${t.due_offset_days} · ${t.priority}</span></span>
      </label>`)}
    </div>`)}
    ${plan.tasks.some((t) => !plan.milestones.find((m) => m.name === t.milestone)) && html`<div class="stack tight"><h3>Other tasks</h3>${plan.tasks.map((t, i) => !plan.milestones.find((m) => m.name === t.milestone) && html`<label class="check" key=${i}><input type="checkbox" checked=${chosen.has(i)} onChange=${() => toggle(i)} /><span>${t.title}</span></label>`)}</div>`}
    ${plan.risks.length > 0 && html`<div class="stack tight"><div class="label">Risks to keep in mind</div><ul style="margin:0;padding-left:1.2em" class="small">${plan.risks.map((r) => html`<li>${r}</li>`)}</ul></div>`}
    <div class="row">
      <button class="btn primary" disabled=${!chosen.size} onClick=${() => act(() => post(`/api/projects/${project.id}/plan/accept`, { tasks: [...chosen] }), `${chosen.size} tasks created`)}>Create ${chosen.size} tasks</button>
      <button class="btn" onClick=${() => act(() => post(`/api/projects/${project.id}/plan`), "Drafting a new plan")}>Draft again</button>
    </div>
  </div>`;
}
