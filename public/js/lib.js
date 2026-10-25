import { h, render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { marked } from "marked";
import DOMPurify from "dompurify";

export const html = htm.bind(h);
export { render };

// ------------------------------------------------------------------ API
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(method, url, body) {
  const opts = { method, headers: { "x-ideabridge": "1" }, credentials: "same-origin" };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ApiError(0, "You seem to be offline. Check your connection and try again.");
  }
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !url.includes("/api/login")) window.dispatchEvent(new Event("ib:signedout"));
    throw new ApiError(res.status, data?.error || `Request failed (${res.status}).`);
  }
  return data;
}
export const get = (url) => api("GET", url);
export const post = (url, body = {}) => api("POST", url, body);
export const patch = (url, body) => api("PATCH", url, body);
export const del = (url) => api("DELETE", url);

// Loads data for a view and refreshes it; `poll` keeps it fresh while visible.
export function useData(url, { poll = 0, deps = [] } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const alive = useRef(true);
  const load = useCallback(async () => {
    if (!url) return;
    try {
      const data = await get(url);
      if (alive.current) setState({ data, error: null, loading: false });
    } catch (e) {
      if (alive.current) setState((s) => ({ data: s.data, error: e.message, loading: false }));
    }
  }, [url]);
  useEffect(() => {
    alive.current = true;
    setState((s) => ({ ...s, loading: true }));
    load();
    let t;
    if (poll) {
      t = setInterval(() => document.visibilityState === "visible" && load(), poll);
    }
    const onFocus = () => load();
    // Phones resume an installed app without a focus event; refresh when it becomes visible.
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);
    window.addEventListener("ib:refresh", onFocus);
    return () => {
      alive.current = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("ib:refresh", onFocus);
    };
  }, [url, poll, ...deps]);
  return { ...state, reload: load };
}

export const refreshAll = () => window.dispatchEvent(new Event("ib:refresh"));

// ------------------------------------------------------------------ routing
export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  return { parts: path.split("/").filter(Boolean), query: Object.fromEntries(new URLSearchParams(query)) };
}

export function useRoute() {
  const [route, setRoute] = useState(parseHash());
  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export function go(path) {
  location.hash = path.startsWith("#") ? path : `#${path}`;
}

export function setQuery(params) {
  const { parts, query } = parseHash();
  const next = { ...query, ...params };
  for (const k of Object.keys(next)) if (next[k] === "" || next[k] == null) delete next[k];
  const qs = new URLSearchParams(next).toString();
  history.replaceState(null, "", `#/${parts.join("/")}${qs ? `?${qs}` : ""}`);
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

// ------------------------------------------------------------------ toast & modal
let toastHost;
export function toast(message, kind = "ok") {
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toast-wrap";
    toastHost.setAttribute("role", "status");
    document.body.appendChild(toastHost);
  }
  const el = document.createElement("div");
  el.className = `toast ${kind === "error" ? "error" : ""}`;
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3200);
}

// Runs an action with a toast on success and a readable error on failure.
export async function act(fn, success) {
  try {
    const r = await fn();
    if (success) toast(success);
    refreshAll();
    return r;
  } catch (e) {
    toast(e.message, "error");
    return null;
  }
}

export function Modal({ title, onClose, children, wide }) {
  useEffect(() => {
    const k = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  return html`<div class="modal-back" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-label=${title}>
      <div class="row between"><h2>${title}</h2><button class="btn ghost small" onClick=${onClose} aria-label="Close">${icon("x")}</button></div>
      ${children}
    </div>
  </div>`;
}

// ------------------------------------------------------------------ formatting
const UTC = (s) => (s ? new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z") : null);

export function ago(s) {
  const d = UTC(s);
  if (!d) return "";
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ago`;
  if (sec < 7 * 86400) return `${Math.floor(sec / 86400)} d ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: d.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function when(s) {
  const d = UTC(s);
  return d ? d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
}

export function dueLabel(date, today) {
  if (!date) return { text: "", cls: "" };
  const t = today ?? new Date().toLocaleDateString("en-CA");
  const days = Math.round((Date.parse(date) - Date.parse(t)) / 86400000);
  if (days < 0) return { text: `${-days} d overdue`, cls: "due-over" };
  if (days === 0) return { text: "Due today", cls: "due-soon" };
  if (days === 1) return { text: "Due tomorrow", cls: "due-soon" };
  if (days < 7) return { text: `Due ${new Date(date + "T12:00").toLocaleDateString(undefined, { weekday: "short" })}`, cls: "" };
  return { text: `Due ${new Date(date + "T12:00").toLocaleDateString(undefined, { day: "numeric", month: "short" })}`, cls: "" };
}

export function clock(sec) {
  if (sec == null || Number.isNaN(sec)) return "";
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const STATUS = {
  new: "New",
  needs_clarification: "Needs clarification",
  under_review: "Under review",
  approved: "Approved",
  in_progress: "In progress",
  on_hold: "On hold",
  completed: "Completed",
  archived: "Archived",
};
export const STATUS_ORDER = Object.keys(STATUS);
export const COMMITMENT = { brainstorm: "Brainstorm", intention: "Intention", decision: "Decision" };
export const PRIORITY = { none: "No priority", low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };

export function StatusChip({ status }) {
  return html`<span class="chip st st-${status}">${STATUS[status] ?? status}</span>`;
}
export function CommitChip({ c }) {
  if (!c || c === "brainstorm") return html`<span class="chip" title="A spontaneous thought, not a commitment">Brainstorm</span>`;
  return html`<span class="chip cm-${c}" title=${c === "decision" ? "He stated a decision" : "He expressed an intention"}>${COMMITMENT[c]}</span>`;
}

// Hebrew and other right-to-left text gets the right direction automatically.
export const isRtl = (s) => /[֐-׿؀-ۿ]/.test((s ?? "").slice(0, 80));

export function Quote({ text, children }) {
  return html`<blockquote class="quote" dir=${isRtl(text) ? "rtl" : "ltr"}>${text}${children}</blockquote>`;
}

export function markdown(text) {
  return DOMPurify.sanitize(marked.parse(text ?? "", { gfm: true, breaks: false }));
}

export function Markdown({ text, cite }) {
  let out = markdown(text);
  // Turn [#12] citations into links to the idea.
  if (cite) out = out.replace(/\[#(\d+)\]/g, (_, id) => `<a class="cite" href="#/ideas/${id}">#${id}</a>`);
  return html`<div class="md bidi" dangerouslySetInnerHTML=${{ __html: out }}></div>`;
}

export function Working({ text = "Working…" }) {
  return html`<span class="working"><span class="spinner"></span>${text}</span>`;
}

export function Loading() {
  return html`<div class="page"><${Working} text="Loading…" /></div>`;
}

export function ErrorBox({ error, retry }) {
  return html`<div class="banner bad"><div class="grow">${error}</div>${retry && html`<button class="btn small" onClick=${retry}>Try again</button>`}</div>`;
}

// ------------------------------------------------------------------ icons
const P = {
  mic: "M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm0 0v4m-5-7a5 5 0 0 0 10 0M9 21h6",
  home: "M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1v-7.5Z",
  inbox: "M4 13h4l1.5 2.5h5L16 13h4M5.5 6h13L20 13v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5l1.5-7Z",
  library: "M5 4h3v16H5zM10.5 4h3v16h-3zM16 5.2l2.8-.7 3 15.5-2.8.6z",
  folder: "M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4.2l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5V7Z",
  check: "M5 12.5 9.5 17 19 7.5",
  checklist: "M10 6h10M10 12h10M10 18h10M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17",
  chat: "M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-7l-4.5 3.5V16H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18",
  gear: "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8-3.5-.1-1.2 2-1.6-2-3.4-2.4.9a8 8 0 0 0-2-1.2L15 3h-4l-.4 2.5a8 8 0 0 0-2 1.2l-2.4-.9-2 3.4 2 1.6a8 8 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-.9a8 8 0 0 0 2 1.2L11 21h4l.4-2.5a8 8 0 0 0 2-1.2l2.4.9 2-3.4-2-1.6.1-1.2Z",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm9 2-4-4",
  play: "M8 5.5v13l11-6.5-11-6.5Z",
  pause: "M8 5h3v14H8zM13 5h3v14h-3z",
  x: "M6 6l12 12M18 6 6 18",
  plus: "M12 5v14M5 12h14",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  doc: "M7 3.5h7l4.5 4.5v12a.5.5 0 0 1-.5.5H7a.5.5 0 0 1-.5-.5v-16a.5.5 0 0 1 .5-.5ZM14 3.5V8h4.5M9.5 12.5h6M9.5 16h6",
  back: "M14.5 5.5 8 12l6.5 6.5",
  keyboard: "M3.5 6.5h17v11h-17zM7 10h.01M10.5 10h.01M14 10h.01M17.5 10h.01M7.5 14h9",
  question: "M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z",
  bolt: "M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Zm4 4h4",
  merge: "M7 4v5a5 5 0 0 0 5 5h5M7 20v-4M14 11l3 3-3 3M7 4a0 0 0 0 0 0 0",
  archive: "M4 5h16v4H4zM5.5 9v10h13V9M10 13h4",
  undo: "M9 7 4.5 11.5 9 16M5 11.5h9.5a5 5 0 0 1 0 10H12",
  menu: "M4 7h16M4 12h16M4 17h16",
};
export function icon(name, cls = "") {
  return html`<svg class=${`i ${cls}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${P[name] ?? ""} /></svg>`;
}

// Single shared audio element so only one recording plays at a time.
let player;
export function playAudio(recordingId, start = 0) {
  window.dispatchEvent(new CustomEvent("ib:play", { detail: { recordingId, start } }));
}

export function AudioDock() {
  const [cur, setCur] = useState(null);
  const ref = useRef();
  useEffect(() => {
    const on = (e) => setCur({ ...e.detail, n: Date.now() });
    window.addEventListener("ib:play", on);
    return () => window.removeEventListener("ib:play", on);
  }, []);
  useEffect(() => {
    const a = ref.current;
    if (!a || !cur) return;
    const seek = () => {
      a.currentTime = Math.max(0, (cur.start ?? 0) - 0.5);
      a.play().catch(() => {});
    };
    if (a.readyState >= 1 && a.dataset.rec === String(cur.recordingId)) seek();
    else {
      a.dataset.rec = String(cur.recordingId);
      a.src = `/api/recordings/${cur.recordingId}/audio`;
      a.addEventListener("loadedmetadata", seek, { once: true });
    }
  }, [cur]);
  player = ref;
  if (!cur) return null;
  return html`<div class="player no-print" style="position:fixed;left:50%;transform:translateX(-50%);bottom:calc(var(--nav-h) + 14px + env(safe-area-inset-bottom));width:min(560px,calc(100% - 24px));z-index:40;top:auto">
    <span class="small muted">Recording ${cur.recordingId}</span>
    <audio ref=${ref} controls preload="metadata"></audio>
    <button class="btn ghost small" onClick=${() => { ref.current?.pause(); setCur(null); }} aria-label="Close player">${icon("x")}</button>
  </div>`;
}

export function usePeople() {
  const { data } = useData("/api/state");
  return { me: data?.user, people: data?.people ?? [], ai: data?.ai };
}

export function personName(people, role) {
  return people.find((p) => p.role === role)?.name ?? (role === "visionary" ? "him" : "you");
}
