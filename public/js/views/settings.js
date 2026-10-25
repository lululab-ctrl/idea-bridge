import { useEffect, useState } from "preact/hooks";
import { act, ago, api, del, download, ErrorBox, get, html, icon, Loading, Modal, patch, post, toast, useData, useRoute, when, setToken } from "../lib.js";
import { enablePush, isStandalone, pushSupported } from "../push.js";

export function Settings({ me }) {
  const route = useRoute();
  const welcome = route.query.welcome === "1";
  const users = useData("/api/users");
  const state = useData("/api/state");
  const him = (users.data ?? []).find((u) => u.role === "visionary");
  return html`<div class="page narrow">
    <div class="page-head"><div><h1>Settings</h1><div class="sub">People, goals, what the AI has learned, notifications and your data.</div></div></div>
    ${welcome && html`<div class="card stack" style="border-color:var(--accent)">
      <h2>You're set up. Three steps to get going:</h2>
      <ol class="stack tight" style="margin:0;padding-left:1.3em">
        <li><b>Put the app on ${him?.name ?? "his"} phone:</b> under People, tap “Sign-in link” next to ${him?.name ?? "his name"} and let him scan the QR code (or he signs in with his name and password). Then he taps Share → Add to Home Screen. He only sees the record button and his own ideas.</li>
        <li><b>Write your goals</b> below, so the AI can judge which ideas fit what you're building.</li>
        <li><b>Add the app to your own phone</b> and turn on notifications on this page.</li>
      </ol>
    </div>`}
    <${People} me=${me} users=${users} />
    <${Goals} />
    <${Teach} />
    <${Preferences} />
    <${Notifications} me=${me} vapid=${state.data?.vapidPublicKey} />
    <${System} />
    <div class="card row between">
      <span class="small muted">Signed in as ${me.name}</span>
      <button class="btn" onClick=${async () => { await post("/api/logout").catch(() => {}); setToken(null); location.hash = ""; location.reload(); }}>Sign out</button>
    </div>
  </div>`;
}

function People({ me, users }) {
  const [link, setLink] = useState(null);
  const [pw, setPw] = useState(null);
  if (!users.data) return html`<${Loading} />`;
  return html`<div class="card stack">
    <h2>People</h2>
    ${users.data.map((u) => html`<${Person} u=${u} me=${me} key=${u.id} onLink=${async () => setLink({ u, ...(await post(`/api/users/${u.id}/login-link`)) })} onPw=${() => setPw(u)} />`)}
    ${link && html`<${Modal} title=${`Sign ${link.u.name} in on a phone`} onClose=${() => setLink(null)}>
      <ol class="small stack tight" style="margin:0;padding-left:1.3em">
        <li>On ${link.u.name}'s phone, open the camera and scan this code (or send the link below).</li>
        <li>The app opens, already signed in, straight to the record button.</li>
        <li>Tap <b>Share → Add to Home Screen</b> (iPhone, in Safari) or <b>⋮ → Install app</b> (Android). Now it opens like an app.</li>
      </ol>
      <div class="qr" dangerouslySetInnerHTML=${{ __html: link.qr }} style="align-self:center"></div>
      <div class="code">${link.url}</div>
      <div class="row"><button class="btn" onClick=${() => navigator.clipboard?.writeText(link.url).then(() => toast("Link copied"), () => toast("Select and copy the link above", "error"))}>Copy link</button><span class="small muted">Works once, expires in ${link.expiresHours} hours. Keep it private.</span></div>
    <//>`}
    ${pw && html`<${PasswordModal} onClose=${() => setPw(null)} user=${pw} me=${me} />`}
  </div>`;
}

function Person({ u, me, onLink, onPw }) {
  const [name, setName] = useState(u.name);
  const [email, setEmail] = useState(u.email ?? "");
  const dirty = name !== u.name || email !== (u.email ?? "");
  return html`<div class="stack tight" style="border-top:1px solid var(--line);padding-top:12px">
    <div class="row between"><span class="strong">${u.name}${u.id === me.id ? " (you)" : ""}</span><span class="chip ${u.role === "organizer" ? "st st-approved" : ""}" title=${u.role === "organizer" ? "Full control over ideas, projects, tasks and settings" : "Can record ideas, see his own ideas and recordings, and delete his own recordings"}>${u.role === "organizer" ? "Admin" : "Idea contributor"}</span></div>
    ${u.role === "visionary" && html`<div class="tiny muted">Can record ideas, see the ideas his recordings became, and delete his own recordings (they go to the trash). Can't change organization, projects, tasks or settings.</div>`}
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(180px,1fr))">
      <label class="field">Name<input type="text" value=${name} onInput=${(e) => setName(e.target.value)} /></label>
      <label class="field">Email<input type="email" value=${email} onInput=${(e) => setEmail(e.target.value)} placeholder="For digests and reminders" /></label>
      ${u.role === "organizer" && html`<label class="field">Opens to<select value=${u.home} onChange=${(e) => act(() => patch(`/api/users/${u.id}`, { home: e.target.value }), "Saved")}><option value="capture">The record button</option><option value="dashboard">Today</option></select></label>`}
    </div>
    <div class="row">
      ${dirty && html`<button class="btn primary small" onClick=${() => act(() => patch(`/api/users/${u.id}`, { name, email }), "Saved")}>Save</button>`}
      <button class="btn small" onClick=${onLink}>${icon("link")} Sign-in link for a phone</button>
      <button class="btn small" onClick=${onPw}>${u.id === me.id ? "Change your password" : u.has_password ? `Reset ${u.name}'s password` : `Set a password for ${u.name}`}</button>
    </div>
  </div>`;
}

function PasswordModal({ user, me, onClose }) {
  const [pw, setPw] = useState("");
  const self = user.id === me.id;
  return html`<${Modal} title=${self ? "Your password" : `${user.name}'s password`} onClose=${onClose}>
    ${!self && html`<p class="small">${user.name} will be signed out on his devices and will need this new password (or a new sign-in link).</p>`}
    <label class="field">New password <span class="hint">At least 8 characters.</span><input type="password" value=${pw} onInput=${(e) => setPw(e.target.value)} autocomplete="new-password" /></label>
    <div class="modal-foot"><button class="btn" onClick=${onClose}>Cancel</button><button class="btn primary" disabled=${pw.length < 8} onClick=${async () => { if (await act(() => patch(`/api/users/${user.id}`, { password: pw }), "Password saved")) onClose(); }}>Save</button></div>
  <//>`;
}

function Goals() {
  const { data } = useData("/api/settings");
  const [v, setV] = useState(null);
  useEffect(() => data && v === null && setV(data.north_star), [data]);
  if (!data || v === null) return null;
  return html`<div class="card stack">
    <h2>Our goals</h2>
    <p class="small muted">A few lines about what you're building, what success looks like, your constraints (time, money, skills) and what you won't do. The AI uses this to judge strategic fit and to prioritize.</p>
    <textarea style="min-height:150px" value=${v} onInput=${(e) => setV(e.target.value)} dir="auto" placeholder=${"Example:\n- Build one business that earns €10k/month within 18 months\n- We have ~15 hours a week and €20k to invest\n- Prefer online, low-inventory businesses\n- No ideas that need investors or a big team"}></textarea>
    <div><button class="btn primary" disabled=${v === data.north_star} onClick=${() => act(() => api("PUT", "/api/settings", { north_star: v }), "Goals saved")}>Save goals</button></div>
  </div>`;
}

const KIND = { glossary: "His vocabulary", preference: "Preferences", correction: "Corrections" };

function Teach() {
  const { data, error, reload } = useData("/api/memory");
  const [kind, setKind] = useState("glossary");
  const [term, setTerm] = useState("");
  const [body, setBody] = useState("");
  if (!data) return error ? html`<${ErrorBox} error=${error} retry=${reload} />` : null;
  const add = async () => {
    if (await act(() => post("/api/memory", { kind, term, body }), "The AI will remember this")) {
      setTerm("");
      setBody("");
    }
  };
  return html`<div class="card stack">
    <h2>What the AI has learned</h2>
    <p class="small muted">Teach it how you two talk and what you want. Every entry is used when it interprets recordings and writes reports. Corrections you make on ideas show up here too.</p>
    <div class="stack tight">
      <div class="row">${Object.entries(KIND).map(([k, l]) => html`<button class="chip ${kind === k ? "on" : ""}" onClick=${() => setKind(k)}>${l}</button>`)}</div>
      ${kind === "glossary" && html`<input type="text" value=${term} onInput=${(e) => setTerm(e.target.value)} placeholder="Word or phrase he uses, e.g. “the platform”" dir="auto" />`}
      <textarea value=${body} onInput=${(e) => setBody(e.target.value)} dir="auto" placeholder=${kind === "glossary" ? "What he means by it" : kind === "preference" ? "e.g. Always suggest the cheapest way to test an idea first" : "e.g. He never wants to sell to large corporations"}></textarea>
      <div><button class="btn small primary" disabled=${!body.trim() || (kind === "glossary" && !term.trim())} onClick=${add}>Add</button></div>
    </div>
    ${Object.entries(KIND).map(([k, l]) => {
      const list = data.filter((m) => m.kind === k);
      return list.length > 0 && html`<div class="stack tight" key=${k}>
        <div class="label">${l}</div>
        ${list.map((m) => html`<div class="row nowrap" key=${m.id} style=${m.active ? "" : "opacity:.5"}>
          <div class="grow small bidi">${m.term && html`<b>${m.term}: </b>`}${m.body}${m.idea_title && html`<span class="tiny muted"> · from “${m.idea_title}”</span>`}</div>
          <button class="btn ghost small" onClick=${() => act(() => patch(`/api/memory/${m.id}`, { active: !m.active }))}>${m.active ? "Pause" : "Use"}</button>
          <button class="btn ghost small" aria-label="Delete" onClick=${() => act(() => del(`/api/memory/${m.id}`), "Removed")}>${icon("x")}</button>
        </div>`)}
      </div>`;
    })}
  </div>`;
}

function Preferences() {
  const { data } = useData("/api/settings");
  const [f, setF] = useState(null);
  useEffect(() => data && setF({ output_language: data.output_language, timezone: data.timezone, digest_hour: data.digest_hour, ai_budget_usd: data.ai_budget_usd }), [data]);
  if (!f) return null;
  const known = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  // Some browsers leave aliases such as "UTC" out of the list; always show the saved zone.
  const zones = f.timezone && !known.includes(f.timezone) ? [f.timezone, ...known] : known;
  return html`<div class="card stack">
    <h2>Preferences</h2>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr))">
      <label class="field">Language for summaries and reports<span class="hint">Quotes always stay in the original language.</span>
        <select value=${f.output_language} onChange=${(e) => setF({ ...f, output_language: e.target.value })}>${["English", "Hebrew", "Spanish", "French", "German", "Russian", "Arabic", "Portuguese"].map((l) => html`<option value=${l}>${l}</option>`)}</select></label>
      <label class="field">Time zone<span class="hint">For digests and due dates.</span>
        <select value=${f.timezone} onChange=${(e) => setF({ ...f, timezone: e.target.value })}>${zones.map((z) => html`<option value=${z}>${z}</option>`)}</select></label>
      <label class="field">Monthly AI budget (USD)<span class="hint">Keeps Claude inside the Team plan's free API credits ($20 per Standard seat). 0 = no cap.</span>
        <input type="number" min="0" max="500" step="1" value=${f.ai_budget_usd} onInput=${(e) => setF({ ...f, ai_budget_usd: Number(e.target.value) })} /></label>
      <label class="field">Digest time<span class="hint">Daily digest and reminders.</span>
        <select value=${f.digest_hour} onChange=${(e) => setF({ ...f, digest_hour: Number(e.target.value) })}>${Array.from({ length: 24 }, (_, h) => html`<option value=${h}>${String(h).padStart(2, "0")}:00</option>`)}</select></label>
    </div>
    <div><button class="btn primary" onClick=${() => act(() => api("PUT", "/api/settings", f), "Saved")}>Save preferences</button></div>
  </div>`;
}

function Notifications({ me, vapid }) {
  const [status, setStatus] = useState(typeof Notification !== "undefined" ? Notification.permission : "unsupported");
  return html`<div class="card stack">
    <h2>Notifications</h2>
    <p class="small muted">Kept to a minimum on purpose: questions for him, plans ready for review, the daily digest, and due tasks. Everything else waits in the review queue.</p>
    <div class="row between">
      <span class="small">This device: <b>${status === "granted" ? "on" : status === "denied" ? "blocked in settings" : "off"}</b></span>
      ${status !== "granted" && html`<button class="btn" disabled=${!vapid} onClick=${async () => { try { await enablePush(vapid); setStatus("granted"); } catch (e) { toast(e.message, "error"); } }}>${icon("bell")} Turn on for this device</button>`}
    </div>
    ${!pushSupported() && !isStandalone() && /iPhone|iPad/.test(navigator.userAgent) && html`<div class="banner info"><div class="grow small">On iPhone, notifications work once Idea Bridge is on your Home Screen: tap Share → Add to Home Screen, open it from there, then come back here.</div></div>`}
    <label class="check"><input type="checkbox" checked=${!!me.notify_push} onChange=${(e) => act(() => patch(`/api/users/${me.id}`, { notify_push: e.target.checked }), "Saved")} /><span>Send me push notifications</span></label>
    <label class="check"><input type="checkbox" checked=${!!me.notify_email} onChange=${(e) => act(() => patch(`/api/users/${me.id}`, { notify_email: e.target.checked }), "Saved")} /><span>Email me the digest and reminders (needs an email address and email set up on the server)</span></label>
  </div>`;
}

function System() {
  const { data, error, reload } = useData("/api/system");
  const [exporting, setExporting] = useState(false);
  if (!data) return error ? html`<${ErrorBox} error=${error} retry=${reload} />` : null;
  const month = new Date().toISOString().slice(0, 7);
  const thisMonth = data.usage.filter((u) => u.month === month);
  const minutes = thisMonth.reduce((n, u) => n + (u.audio_minutes ?? 0), 0);
  const ok = (v, label = "Working") => html`<span class="chip ${v ? "st st-approved" : "st st-needs_clarification"}">${v ? label : "Not set up"}</span>`;
  const mb = (b) => `${(b / 1024 / 1024).toFixed(0)} MB`;
  const storagePct = Math.min(100, Math.round((data.storage.used / data.storage.limit) * 100));
  const budgetPct = data.budget.budget ? Math.min(100, Math.round((data.budget.spent / data.budget.budget) * 100)) : 0;
  const exportAll = async () => {
    setExporting(true);
    try {
      await download("/api/export", `idea-bridge-export-${new Date().toISOString().slice(0, 10)}.zip`);
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setExporting(false);
    }
  };
  return html`<div class="card stack">
    <h2>System</h2>
    <div class="stack tight small">
      <div class="row between"><span>AI understanding (Claude: ${data.ai.model} daily, ${data.ai.deepModel} for reports)</span>${ok(data.ai.understanding)}</div>
      <div class="row between"><span>Transcription (Groq, free plan)</span>${ok(!!data.ai.transcription)}</div>
      <div class="row between"><span>Email digests (Resend, optional)</span>${ok(data.email)}</div>
      <div class="row between"><span>Background worker</span>${data.lastWorker ? html`<span class="tiny muted">last ran ${ago(data.lastWorker.at)}</span>` : html`<span class="chip st st-needs_clarification">Not run yet</span>`}</div>
      ${data.ai.mode === "mock" && html`<div class="banner warn"><div class="grow">Test mode: AI responses are simulated.</div></div>`}
    </div>
    <div class="divider"></div>
    <div class="stack tight">
      <div class="row between"><span class="label">Claude this month (paid from the Team plan's API credits)</span><span class="small num">$${data.budget.spent.toFixed(2)} of $${data.budget.budget}</span></div>
      <div class="progress"><i style=${`width:${budgetPct}%;${budgetPct > 85 ? "background:var(--warn)" : ""}`}></i></div>
      ${data.budget.exhausted && html`<div class="banner warn"><div class="grow small">This month's budget is used up. New recordings are saved and will be processed next month, or raise the budget under Preferences.</div></div>`}
      <div class="row between" style="margin-top:6px"><span class="label">Storage (Supabase free plan)</span><span class="small num">${mb(data.storage.used)} of ${mb(data.storage.limit)}</span></div>
      <div class="progress"><i style=${`width:${storagePct}%;${storagePct > 85 ? "background:var(--warn)" : ""}`}></i></div>
      <div class="tiny muted">When storage gets close to full, the audio of the oldest recordings is removed automatically. Their transcripts, quotes and ideas are always kept.</div>
    </div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
      <div><div class="label">Audio this month</div><div class="strong num">${minutes.toFixed(0)} min</div></div>
      <div><div class="label">Recordings</div><div class="strong num">${data.counts.recordings}</div></div>
      <div><div class="label">Ideas</div><div class="strong num">${data.counts.ideas}</div></div>
      <div><div class="label">Waiting jobs</div><div class="strong num">${data.pendingJobs}</div></div>
    </div>
    ${data.waiting.length > 0 && html`<div class="stack tight"><div class="label">Waiting to retry</div>${data.waiting.map((w) => html`<div class="small">${w.type.replace(/_/g, " ")}: ${w.last_error} <span class="tiny muted">· next try ${ago(w.run_at).replace(" ago", "")}</span></div>`)}</div>`}
    ${thisMonth.length > 0 && html`<details><summary class="small muted">Usage breakdown</summary>
      <div style="overflow-x:auto"><table class="small" style="border-collapse:collapse;width:100%;margin-top:8px">
        <tr class="muted"><td>What</td><td>Service</td><td class="num">Calls</td><td class="num">Cost</td></tr>
        ${thisMonth.map((u) => html`<tr><td>${u.purpose}</td><td>${u.provider}</td><td class="num">${u.calls}</td><td class="num">$${u.cost.toFixed(3)}</td></tr>`)}
      </table></div>
    </details>`}
    ${data.failed.length > 0 && html`<div class="stack tight">
      <div class="label">Problems</div>
      ${data.failed.map((j) => html`<div class="row nowrap small" key=${j.id}><span class="grow"><b>${j.type.replace(/_/g, " ")}</b>: ${j.last_error} <span class="tiny muted">${ago(j.updated_at)}</span></span><button class="btn small" onClick=${() => act(() => post(`/api/jobs/${j.id}/retry`), "Retrying")}>Retry</button></div>`)}
    </div>`}
    <div class="divider"></div>
    <div class="stack tight">
      <div class="label">Your data</div>
      <div class="small">The database is backed up every night by GitHub (kept 30 days). See the README for how to restore.</div>
      <div class="row">
        <a class="btn small" href="#/trash">${icon("archive")} Trash</a>
        <button class="btn small" disabled=${exporting} onClick=${exportAll}>${exporting ? "Preparing…" : "Download everything (.zip)"}</button>
      </div>
      <p class="tiny muted">The download has every idea as a readable document, every transcript, all generated documents and a full data file. Audio can be played and downloaded from each recording.</p>
    </div>
  </div>`;
}
