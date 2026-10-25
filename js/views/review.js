import { useEffect, useState } from "preact/hooks";
import { act, clock, CommitChip, ErrorBox, html, icon, Loading, personName, playAudio, post, Quote, StatusChip, toast, usePeople, useData } from "../lib.js";

const KINDS = {
  new_idea: "New idea",
  auto_linked: "Added to an existing idea",
  possible_duplicate: "Possible duplicate",
  possible_link: "Possible connection",
  conflict: "Possible conflict",
  answer: "Question answered",
  plan: "Plan ready",
  recording_deleted: "Recording deleted",
};

// Each kind of item gets the actions that make sense for it; the first is the default.
function actionsFor(item, him) {
  switch (item.kind) {
    case "new_idea":
      return [
        { a: "review", label: "Look into it", key: "r", primary: true, hint: "Moves it to Under review and prepares a full report and evaluation" },
        { a: "ok", label: "Keep as idea", key: "k", hint: "Stays in the library as a brainstorm" },
        { a: "hold", label: "Later", key: "l" },
        { a: "archive", label: "Archive", key: "a" },
      ];
    case "auto_linked":
      return [
        { a: "ok", label: "Looks right", key: "k", primary: true },
        { a: "undo", label: "Wrong idea, separate it", key: "u" },
      ];
    case "possible_duplicate":
      return [
        { a: "merge", label: "Same idea, merge", key: "m", primary: true, hint: "Keeps every recording, combines them into the existing idea" },
        { a: "link", label: "Related, keep both", key: "r" },
        { a: "dismiss", label: "Different ideas", key: "d" },
      ];
    case "possible_link":
    case "conflict":
      return [
        { a: "confirm", label: item.kind === "conflict" ? "Yes, they conflict" : "Yes, connect them", key: "y", primary: true },
        { a: "dismiss", label: "No", key: "n" },
      ];
    case "recording_deleted":
      return [
        { a: "ok", label: "Fine, keep it deleted", key: "k", primary: true, hint: "Stays in the trash; ideas are unchanged" },
        { a: "restore", label: "Restore the recording", key: "r" },
      ];
    default:
      return [{ a: "ok", label: "Got it", key: "k", primary: true }];
  }
}

function IdeaBox({ id, title, summary, status, label }) {
  return html`<div class="stack tight">
    ${label && html`<div class="label">${label}</div>`}
    <a href=${`#/ideas/${id}`} class="strong" style="color:var(--ink)">${title}</a>
    ${status && html`<div><${StatusChip} status=${status} /></div>`}
    <p class="small muted bidi clamp3">${summary}</p>
  </div>`;
}

function ItemBody({ item, him }) {
  const quote = item.fragment_quote && html`<div class="stack tight">
    <div class="row between"><span class="label">${him}'s words</span>
      ${item.recording_id && html`<button class="play" onClick=${() => playAudio(item.recording_id, item.start_sec ?? 0)}>${icon("play")} Listen${item.start_sec != null ? ` from ${clock(item.start_sec)}` : ""}</button>`}
    </div>
    <${Quote} text=${item.fragment_quote} />
  </div>`;
  switch (item.kind) {
    case "new_idea":
      return html`<div class="stack">
        <div class="stack tight">
          <a href=${`#/ideas/${item.idea_id}`}><h2 style="color:var(--ink)">${item.idea_title}</h2></a>
          <div class="row"><${CommitChip} c=${item.idea_commitment} />${item.idea_clarity <= 2 && html`<span class="chip st st-needs_clarification">Unclear (${item.idea_clarity}/5)</span>`}${item.tags.map((t) => html`<span class="chip tag" key=${t}>${t}</span>`)}</div>
        </div>
        <p class="bidi">${item.idea_summary}</p>
        ${item.fragment_interpretation && html`<div class="reason"><b>What he likely means:</b> ${item.fragment_interpretation}</div>`}
        ${quote}
        ${item.questions.length > 0 && html`<${Questions} item=${item} him=${him} />`}
      </div>`;
    case "auto_linked":
      return html`<div class="stack">
        <p>This recording was added to <a href=${`#/ideas/${item.idea_id}`} class="strong">${item.idea_title}</a> and the idea was updated.</p>
        ${quote}
        ${item.note && html`<div class="reason">${item.note}</div>`}
      </div>`;
    case "possible_duplicate":
    case "possible_link":
    case "conflict":
      return html`<div class="stack">
        <div class="compare">
          <div><${IdeaBox} id=${item.idea_id} title=${item.idea_title} summary=${item.idea_summary} status=${item.idea_status} label=${item.kind === "possible_duplicate" ? "New" : "This idea"} /></div>
          <div><${IdeaBox} id=${item.other_idea_id} title=${item.other_title} summary=${item.other_summary} status=${item.other_status} label=${item.kind === "possible_duplicate" ? "Existing" : "That idea"} /></div>
        </div>
        ${item.note && html`<div class="reason"><b>Why the AI flagged it${item.confidence ? ` (${Math.round(item.confidence * 100)}% sure)` : ""}:</b> ${item.note}</div>`}
        ${quote}
      </div>`;
    case "answer":
      return html`<div class="stack">
        <p>${him} answered a question about <a href=${`#/ideas/${item.idea_id}`} class="strong">${item.idea_title}</a>. The idea has been updated with his answer.</p>
        ${item.note && html`<div class="reason">${item.note}</div>`}
      </div>`;
    case "plan":
      return html`<div class="stack">
        <p>${item.note}</p>
        <a class="btn" href=${`#/ideas/${item.idea_id}`}>Open the idea</a>
      </div>`;
    default:
      return html`<p>${item.note}</p>`;
  }
}

function Questions({ item, him }) {
  const [sent, setSent] = useState({});
  return html`<div class="stack tight">
    <div class="label">Questions you could ask ${him}</div>
    ${item.questions.map(
      (q) => html`<div class="row nowrap" key=${q.id}>
        <span class="grow small bidi">${q.text}<span class="tiny muted"> · ${q.why ?? ""}</span></span>
        ${q.status === "asked" || sent[q.id]
          ? html`<span class="chip">Asked</span>`
          : html`<button class="btn small" onClick=${async () => { if (await act(() => post(`/api/questions/${q.id}/ask`), `Sent to ${him}`)) setSent({ ...sent, [q.id]: true }); }}>Ask ${him}</button>`}
      </div>`,
    )}
  </div>`;
}

export function Review({ me }) {
  const { data, error, reload } = useData("/api/review", { poll: 30000 });
  const { people } = usePeople();
  const him = personName(people, "visionary");
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const items = data ?? [];
  const item = items[Math.min(index, items.length - 1)];
  const actions = item ? actionsFor(item, him) : [];

  async function run(a) {
    if (!item || busy) return;
    setBusy(true);
    try {
      await post(`/api/review/${item.id}`, { action: a });
      setDone((n) => n + 1);
      await reload();
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const onKey = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
      if (e.key === "ArrowRight" || e.key === "j") setIndex((i) => Math.min(i + 1, items.length - 1));
      else if (e.key === "ArrowLeft" || e.key === "h") setIndex((i) => Math.max(i - 1, 0));
      else if (e.key === "Enter") actions[0] && run(actions[0].a);
      else {
        const hit = actions.find((x) => x.key === e.key.toLowerCase());
        if (hit) run(hit.a);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!data) return error ? html`<div class="page"><${ErrorBox} error=${error} retry=${reload} /></div>` : html`<${Loading} />`;

  const fyi = items.filter((i) => i.kind === "auto_linked" || i.kind === "answer");

  if (!items.length) {
    return html`<div class="page narrow">
      <h1>Review</h1>
      <div class="card stack" style="align-items:center;text-align:center;padding:40px 20px">
        <div style="color:var(--ok)">${icon("check", "big")}</div>
        <h2>${done ? `All done, ${done} handled` : "Nothing to review"}</h2>
        <p class="muted">New recordings appear here once they've been transcribed, understood and connected to existing ideas.</p>
        <div class="row" style="justify-content:center"><a class="btn" href="#/ideas">Browse the library</a><a class="btn" href="#/today">Back to Today</a></div>
      </div>
    </div>`;
  }

  return html`<div class="page narrow">
    <div class="page-head">
      <div><h1>Review</h1><div class="sub">${index + 1} of ${items.length}${done ? ` · ${done} handled this session` : ""}</div></div>
      <div class="row">
        ${fyi.length > 1 && html`<button class="btn small" onClick=${() => act(() => post("/api/review/bulk", { ids: fyi.map((i) => i.id) }), `${fyi.length} updates acknowledged`)}>Acknowledge ${fyi.length} updates</button>`}
        <button class="btn small" disabled=${index === 0} onClick=${() => setIndex(index - 1)} aria-label="Previous">${icon("back")}</button>
        <button class="btn small" disabled=${index >= items.length - 1} onClick=${() => setIndex(index + 1)} aria-label="Next">${icon("back", "flip")}</button>
      </div>
    </div>
    <div class="progress"><i style=${`width:${((index + 1) / items.length) * 100}%`}></i></div>
    <div class="card review-card" key=${item.id}>
      <div class="review-kind k-${item.kind}">${KINDS[item.kind] ?? item.kind}</div>
      <${ItemBody} item=${item} him=${him} />
      <div class="review-actions">
        ${actions.map(
          (x) => html`<button class="btn ${x.primary ? "primary" : ""}" disabled=${busy} title=${x.hint ?? ""} onClick=${() => run(x.a)}>${x.label}<span class="kbd">${x.key.toUpperCase()}</span></button>`,
        )}
        <span class="spacer"></span>
        ${item.idea_id && html`<a class="btn ghost" href=${`#/ideas/${item.idea_id}`}>Open</a>`}
      </div>
    </div>
    <p class="tiny muted">Shortcuts: the letter on each button, Enter for the highlighted action, ← → to move between items.</p>
  </div>`;
}
