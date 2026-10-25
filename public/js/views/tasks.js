import { useEffect, useState } from "preact/hooks";
import { act, del, dueLabel, ErrorBox, get, html, icon, Loading, Modal, patch, post, setQuery, usePeople, useData } from "../lib.js";

export function TaskRow({ t, onOpen, showProject }) {
  const due = dueLabel(t.due_date);
  return html`<div class="task ${t.status === "done" ? "done" : ""}">
    <button class="tick" aria-label=${t.status === "done" ? "Mark not done" : "Mark done"} onClick=${async () => {
      const r = await act(() => patch(`/api/tasks/${t.id}`, { status: t.status === "done" ? "todo" : "done" }), t.status === "done" ? null : "Done");
      if (r?.projectAllDone) setTimeout(() => alertDone(t.project_id), 300);
    }}>${t.status === "done" ? icon("check") : ""}</button>
    <button class="grow" style="background:none;border:0;padding:0;text-align:left;cursor:pointer;min-width:0;color:inherit" onClick=${onOpen}>
      <div class="ttl bidi">${t.title}</div>
      <div class="tiny muted row" style="gap:6px">
        ${showProject && t.project_name && html`<span>${t.project_name}</span>`}
        ${t.assignee_name && html`<span>· ${t.assignee_name}</span>`}
        ${t.status === "doing" && html`<span class="chip">In progress</span>`}
        ${t.status === "blocked" && html`<span class="chip st st-needs_clarification">Blocked</span>`}
        ${(t.priority === "high" || t.priority === "urgent") && html`<span class="pr-${t.priority}">${t.priority}</span>`}
      </div>
    </button>
    ${t.status !== "done" && html`<span class="tiny ${due.cls}" style="flex:none">${due.text}</span>`}
  </div>`;
}

function alertDone(projectId) {
  if (!projectId) return;
  // Offer to complete the project when its last task is done.
  window.dispatchEvent(new CustomEvent("ib:project-done", { detail: projectId }));
}

export function TaskModal({ task, projectId, ideaId, onClose }) {
  const { people } = usePeople();
  const projects = useData("/api/projects");
  const [f, setF] = useState(() => ({
    title: task?.title ?? "",
    instructions: task?.instructions ?? "",
    expected_outcome: task?.expected_outcome ?? "",
    due_date: task?.due_date ?? "",
    assignee_id: task?.assignee_id ?? "",
    priority: task?.priority ?? "medium",
    status: task?.status ?? "todo",
    project_id: task?.project_id ?? projectId ?? "",
    milestone: task?.milestone ?? "",
  }));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    const body = { ...f, assignee_id: Number(f.assignee_id) || null, project_id: Number(f.project_id) || null, idea_id: ideaId };
    const ok = task ? await act(() => patch(`/api/tasks/${task.id}`, body), "Saved") : await act(() => post("/api/tasks", body), "Task added");
    if (ok) onClose();
  };
  return html`<${Modal} title=${task ? "Task" : "New task"} onClose=${onClose}>
    <label class="field">Title<input type="text" value=${f.title} onInput=${set("title")} autofocus=${!task} dir="auto" /></label>
    <label class="field">Instructions<textarea value=${f.instructions} onInput=${set("instructions")} dir="auto"></textarea></label>
    <label class="field">Expected outcome<input type="text" value=${f.expected_outcome} onInput=${set("expected_outcome")} dir="auto" /></label>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">
      <label class="field">Due<input type="date" value=${f.due_date} onInput=${set("due_date")} /></label>
      <label class="field">Who<select value=${f.assignee_id} onChange=${set("assignee_id")}><option value="">Either of us</option>${people.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select></label>
      <label class="field">Priority<select value=${f.priority} onChange=${set("priority")}>${["low", "medium", "high", "urgent"].map((p) => html`<option value=${p}>${p[0].toUpperCase() + p.slice(1)}</option>`)}</select></label>
      <label class="field">Status<select value=${f.status} onChange=${set("status")}><option value="todo">To do</option><option value="doing">In progress</option><option value="blocked">Blocked</option><option value="done">Done</option></select></label>
      <label class="field">Project<select value=${f.project_id} onChange=${set("project_id")}><option value="">No project</option>${(projects.data ?? []).map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select></label>
      <label class="field">Milestone<input type="text" value=${f.milestone} onInput=${set("milestone")} /></label>
    </div>
    ${task?.idea_id && html`<a class="small" href=${`#/ideas/${task.idea_id}`}>Open the idea behind this task</a>`}
    <div class="modal-foot">
      ${task && html`<button class="btn danger" onClick=${async () => { if (await act(() => del(`/api/tasks/${task.id}`), "Deleted")) onClose(); }}>Delete</button>`}
      <span class="spacer"></span>
      <button class="btn" onClick=${onClose}>Cancel</button>
      <button class="btn primary" disabled=${!f.title.trim()} onClick=${save}>Save</button>
    </div>
  <//>`;
}

const GROUPS = [
  ["overdue", "Overdue"],
  ["today", "Today"],
  ["week", "Next 7 days"],
  ["later", "Later"],
  ["nodate", "No date"],
  ["done", "Done"],
];

function bucket(t, today) {
  if (t.status === "done") return "done";
  if (!t.due_date) return "nodate";
  const days = Math.round((Date.parse(t.due_date) - Date.parse(today)) / 86400000);
  if (days < 0) return "overdue";
  if (days === 0) return "today";
  if (days <= 7) return "week";
  return "later";
}

export function Tasks({ me, query }) {
  const filter = query.filter ?? "all";
  const url = `/api/tasks?${filter === "mine" ? "mine=1&" : ""}${query.due ? `due=${query.due}&` : ""}`;
  const { data, error, reload } = useData(url);
  const [open, setOpen] = useState(null);
  const [adding, setAdding] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [doneProject, setDoneProject] = useState(null);
  useEffect(() => {
    if (query.open) get("/api/tasks").then((all) => setOpen(all.find((t) => t.id === Number(query.open)) ?? null)).catch(() => {});
  }, [query.open]);
  useEffect(() => {
    const on = (e) => setDoneProject(e.detail);
    window.addEventListener("ib:project-done", on);
    return () => window.removeEventListener("ib:project-done", on);
  }, []);
  if (!data) return error ? html`<div class="page"><${ErrorBox} error=${error} retry=${reload} /></div>` : html`<${Loading} />`;
  const today = new Date().toLocaleDateString("en-CA");
  const grouped = Object.fromEntries(GROUPS.map(([k]) => [k, []]));
  for (const t of data) grouped[bucket(t, today)].push(t);

  return html`<div class="page narrow">
    <div class="page-head">
      <div><h1>Tasks</h1><div class="sub">Commitments only. Ideas never create tasks until you approve them.</div></div>
      <button class="btn primary" onClick=${() => setAdding(true)}>${icon("plus")} Add task</button>
    </div>
    <div class="row">
      ${[["all", "Everyone"], ["mine", `Mine (${me.name})`]].map(([k, l]) => html`<button class="chip ${filter === k ? "on" : ""}" onClick=${() => setQuery({ filter: k === "all" ? "" : k })}>${l}</button>`)}
      ${query.due && html`<button class="chip on" onClick=${() => setQuery({ due: "" })}>${query.due === "overdue" ? "Overdue only" : "This week"} ×</button>`}
    </div>
    ${data.length === 0 && html`<div class="empty">No tasks yet. Approve an idea to get a step-by-step plan, or add a task yourself.</div>`}
    ${GROUPS.map(([k, label]) => {
      const list = grouped[k];
      if (!list.length) return null;
      if (k === "done" && !showDone) return html`<button class="btn ghost small" onClick=${() => setShowDone(true)}>Show ${list.length} done</button>`;
      return html`<div class="card flush" key=${k}>
        <div style="padding:12px 14px 4px" class="row between"><h3 class=${k === "overdue" ? "due-over" : ""}>${label}</h3><span class="tiny muted">${list.length}</span></div>
        ${list.map((t) => html`<${TaskRow} t=${t} key=${t.id} showProject onOpen=${() => setOpen(t)} />`)}
      </div>`;
    })}
    ${(open || adding) && html`<${TaskModal} task=${open} onClose=${() => { setOpen(null); setAdding(false); if (query.open) setQuery({ open: "" }); }} />`}
    ${doneProject && html`<${Modal} title="All tasks done" onClose=${() => setDoneProject(null)}>
      <p>That was the last open task in this project. Mark the project as completed?</p>
      <div class="modal-foot"><button class="btn" onClick=${() => setDoneProject(null)}>Not yet</button><button class="btn primary" onClick=${async () => { await act(() => patch(`/api/projects/${doneProject}`, { status: "completed" }), "Project completed"); setDoneProject(null); }}>Complete project</button></div>
    <//>`}
  </div>`;
}
