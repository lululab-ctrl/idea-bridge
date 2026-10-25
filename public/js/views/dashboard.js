import { act, ago, CommitChip, dueLabel, ErrorBox, html, icon, Loading, patch, personName, post, StatusChip, usePeople, useData } from "../lib.js";

const KIND_LABEL = {
  new_idea: "new ideas",
  auto_linked: "updates to ideas",
  possible_duplicate: "possible duplicates",
  possible_link: "connections",
  conflict: "conflicts",
  answer: "answers",
  plan: "plans",
};

function greeting(name) {
  const h = new Date().getHours();
  const part = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  return `${part}, ${name.split(" ")[0]}`;
}

export function Dashboard({ me }) {
  const { data: d, error, reload } = useData("/api/dashboard", { poll: 20000 });
  const { people, ai } = usePeople();
  const him = personName(people, "visionary");
  if (!d) return error ? html`<div class="page"><${ErrorBox} error=${error} retry=${reload} /></div>` : html`<${Loading} />`;

  const statusCount = Object.fromEntries(d.statusCounts.map((s) => [s.status, s.n]));
  const summary = [
    d.review.total ? `${d.review.total} to review` : null,
    d.myTasks.length ? `${d.myTasks.length} tasks this week` : null,
    d.waiting.length ? `${d.waiting.length} waiting on ${him}` : null,
  ].filter(Boolean);

  return html`<div class="page">
    <div class="page-head">
      <div>
        <h1>${greeting(me.name)}</h1>
        <div class="sub">${summary.length ? summary.join(" · ") : "You're all caught up."} · ${d.capturedThisWeek} recordings this week</div>
      </div>
      <a class="btn voice" href="#/capture">${icon("mic")} Record</a>
    </div>

    ${ai && !ai.understanding && html`<div class="banner warn">${icon("bolt")}<div class="grow"><b>AI understanding is not set up yet.</b> Recordings are saved safely and will be processed once the Claude key is added.</div><a class="btn small" href="#/settings">Add keys</a></div>`}
    ${ai && !ai.transcription && html`<div class="banner warn">${icon("mic")}<div class="grow"><b>Transcription is not set up yet.</b> Add the free Groq key in Settings. Recordings wait safely until then.</div><a class="btn small" href="#/settings">Add keys</a></div>`}
    ${d.budget?.exhausted && html`<div class="banner warn">${icon("bolt")}<div class="grow"><b>This month's AI budget is used up</b> ($${d.budget.spent.toFixed(2)} of $${d.budget.budget}). New recordings are saved and will be processed next month, or raise the budget in Settings.</div><a class="btn small" href="#/settings">Settings</a></div>`}
    ${d.waitingJobs?.length > 0 && !d.budget?.exhausted && html`<div class="banner">${icon("bolt")}<div class="grow small"><b>Some work is waiting to retry</b> (usually a free-plan limit that resets soon): ${d.waitingJobs[0].last_error}</div></div>`}
    ${d.failed > 0 && html`<div class="banner bad">${icon("x")}<div class="grow">${d.failed} recording${d.failed > 1 ? "s" : ""} couldn't be processed. The audio is safe.</div><a class="btn small" href="#/recordings?status=failed">See and retry</a></div>`}

    <div class="grid two">
      <div class="card review-hero stack">
        <div class="row between">
          <div class="hero-stat"><b>${d.review.total}</b><span>${d.review.total === 1 ? "item" : "items"} waiting for review</span></div>
          ${d.processing.length > 0 && html`<span class="working" style="color:#a9c0b6"><span class="spinner"></span>${d.processing.length} processing</span>`}
        </div>
        ${d.review.total > 0
          ? html`<div class="kinds">${d.review.byKind.map((k) => html`<span class="chip">${k.n} ${KIND_LABEL[k.kind] ?? k.kind}</span>`)}</div>
              <div><a class="btn voice" href="#/review">Start review ${icon("back", "flip")}</a></div>`
          : html`<p class="muted">Nothing new. New recordings land here, grouped and explained, so you can go through them in one sitting.</p>`}
      </div>

      <div class="card stack">
        <div class="card-head" style="margin:0"><h3>Needs you</h3><a class="small" href="#/tasks?filter=mine">All tasks</a></div>
        ${d.myTasks.length === 0 && html`<div class="muted small">No tasks due in the next 7 days.</div>`}
        <div class="stack tight">
          ${d.myTasks.map((t) => {
            const due = dueLabel(t.due_date, d.today);
            return html`<div class="row nowrap" key=${t.id}>
              <button class="btn ghost small" title="Mark done" onClick=${() => act(() => patch(`/api/tasks/${t.id}`, { status: "done" }), "Done")}>${icon("check")}</button>
              <a class="grow" href=${`#/tasks?open=${t.id}`} style="min-width:0"><div class="clamp2" style="color:var(--ink)">${t.title}</div><div class="tiny muted">${t.project_name ?? ""}</div></a>
              <span class="tiny ${due.cls}">${due.text}</span>
            </div>`;
          })}
        </div>
        ${d.overdue > 0 && html`<a class="small due-over" href="#/tasks?due=overdue">${d.overdue} overdue</a>`}
      </div>
    </div>

    <div class="grid three">
      <div class="card stack">
        <div class="card-head" style="margin:0"><h3>Waiting on ${him}</h3></div>
        ${d.waiting.length === 0
          ? html`<div class="muted small">No open questions. Unclear ideas show suggested questions you can send him with one tap.</div>`
          : d.waiting.map(
              (q) => html`<a href=${`#/ideas/${q.idea_id}`} class="stack tight" key=${q.id} style="color:inherit;text-decoration:none">
                <div class="small strong bidi">${q.text}</div>
                <div class="tiny muted">${q.title} · asked ${ago(q.asked_at)}</div>
              </a>`,
            )}
      </div>

      <div class="card stack">
        <div class="card-head" style="margin:0"><h3>Newly captured</h3><a class="small" href="#/ideas?status=new">All new</a></div>
        ${d.newIdeas.length === 0 && html`<div class="muted small">No new ideas yet. Ask ${him} to record his first one.</div>`}
        ${d.newIdeas.map(
          (i) => html`<a href=${`#/ideas/${i.id}`} key=${i.id} style="color:inherit;text-decoration:none" class="stack tight">
            <div class="row between nowrap"><span class="strong clamp2" style="color:var(--ink)">${i.title}</span><span class="tiny muted" style="flex:none">${ago(i.created_at)}</span></div>
            <div class="row"><${CommitChip} c=${i.commitment} />${i.clarity <= 2 && html`<span class="chip st-needs_clarification st">Unclear</span>`}</div>
          </a>`,
        )}
      </div>

      <div class="card stack">
        <div class="card-head" style="margin:0"><h3>Worth a look</h3><a class="small" href="#/priorities">Priorities</a></div>
        ${d.highPotential.length === 0 && d.promising.length === 0 && html`<div class="muted small">Move ideas into review to get an evaluation. The best-scoring ones appear here with their reasoning.</div>`}
        ${d.highPotential.map(
          (i) => html`<a href=${`#/ideas/${i.id}`} key=${i.id} class="row nowrap" style="color:inherit;text-decoration:none">
            <span class="score-big" style="font-size:1.3rem;min-width:2.4ch">${i.score}</span>
            <span class="grow" style="min-width:0"><span class="strong clamp2" style="color:var(--ink)">${i.title}</span><span class="tiny muted clamp2">${i.take}</span></span>
          </a>`,
        )}
        ${d.promising.length > 0 && html`<div class="label">AI's pick from the last pattern scan</div>`}
        ${d.promising.slice(0, 3).map(
          (p) => html`<a href=${`#/ideas/${p.idea_id}`} key=${p.idea_id} style="color:inherit;text-decoration:none"><div class="small strong" style="color:var(--ink)">${p.title}</div><div class="tiny muted clamp2">${p.why}</div></a>`,
        )}
      </div>
    </div>

    <div class="grid two">
      <div class="card stack">
        <div class="card-head" style="margin:0"><h3>Active projects</h3><a class="small" href="#/projects">All projects</a></div>
        ${d.projects.length === 0 && html`<div class="muted small">When you approve an idea, it becomes a project with a step-by-step plan.</div>`}
        ${d.projects.map(
          (p) => html`<a href=${`#/projects/${p.id}`} key=${p.id} class="stack tight" style="color:inherit;text-decoration:none">
            <div class="row between"><span class="strong" style="color:var(--ink)">${p.name}</span><span class="small muted num">${p.plan_status === "generating" ? "Planning…" : p.plan_status === "draft" ? "Plan ready to review" : `${p.done}/${p.total}`}</span></div>
            <div class="progress"><i style=${`width:${p.total ? (p.done / p.total) * 100 : 0}%`}></i></div>
          </a>`,
        )}
      </div>

      <div class="card stack">
        <div class="card-head" style="margin:0"><h3>The bigger picture</h3><a class="small" href="#/insights">Insights</a></div>
        ${d.insightsOverview
          ? html`<p class="small bidi">${d.insightsOverview}</p><div class="tiny muted">Pattern scan ${ago(d.insightsAt)}</div>`
          : html`<div class="muted small">After a few ideas, run a pattern scan to see recurring themes, conflicts and ideas that could be combined.</div>`}
        ${d.themes.length > 0 && html`<div class="row">${d.themes.map((t) => html`<a class="chip tag" href=${`#/ideas?theme=${t.id}`} key=${t.id}>${t.name} · ${t.n}</a>`)}</div>`}
        <div><button class="btn small" onClick=${() => act(() => post("/api/insights/run"), "Pattern scan started. It takes a minute.")}>${icon("spark")} Scan for patterns</button></div>
      </div>
    </div>

    <div class="grid three">
      <div class="card stack">
        <h3>Pipeline</h3>
        <div class="row">${["new", "needs_clarification", "under_review", "approved", "in_progress", "on_hold"].map(
          (s) => html`<a href=${`#/ideas?status=${s}`} key=${s} style="text-decoration:none"><${StatusChip} status=${s} /> <span class="small num muted">${statusCount[s] ?? 0}</span></a>`,
        )}</div>
      </div>
      <div class="card stack">
        <h3>Recently completed</h3>
        ${d.completed.length === 0 ? html`<div class="muted small">Completed tasks will show here.</div>` : d.completed.map((t) => html`<div class="small row nowrap" key=${t.id}>${icon("check")}<span class="grow clamp2">${t.title}</span><span class="tiny muted">${ago(t.completed_at)}</span></div>`)}
      </div>
      <div class="card stack">
        <h3>Archive</h3>
        <div class="small muted">${d.archivedCount} archived ideas. Nothing is ever lost: archived ideas stay searchable and can come back anytime.</div>
        <a class="small" href="#/ideas?status=archived">Browse archive</a>
      </div>
    </div>
  </div>`;
}
