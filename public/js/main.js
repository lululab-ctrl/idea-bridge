import { useEffect, useState } from "preact/hooks";
import { AudioDock, get, go, html, icon, render, useData, useRoute } from "./lib.js";
import { Capture } from "./views/capture.js";
import { Login, Setup } from "./views/auth.js";
import { Dashboard } from "./views/dashboard.js";
import { Review } from "./views/review.js";
import { Library } from "./views/library.js";
import { IdeaView } from "./views/idea.js";
import { RecordingView } from "./views/recording.js";
import { Projects, ProjectView } from "./views/projects.js";
import { Tasks } from "./views/tasks.js";
import { Ask } from "./views/ask.js";
import { Insights } from "./views/insights.js";
import { Settings } from "./views/settings.js";

const NAV = [
  { path: "today", label: "Today", icon: "home" },
  { path: "review", label: "Review", icon: "inbox", badge: true },
  { path: "ideas", label: "Library", icon: "library" },
  { path: "projects", label: "Projects", icon: "folder" },
  { path: "tasks", label: "Tasks", icon: "checklist" },
  { path: "ask", label: "Ask", icon: "chat" },
  { path: "insights", label: "Insights", icon: "spark" },
  { path: "settings", label: "Settings", icon: "gear" },
];

function Shell({ me, route, children }) {
  const counts = useData("/api/dashboard", { poll: 60000 });
  const reviewCount = counts.data?.review?.total ?? 0;
  const section = route.parts[0] ?? "today";
  const on = (p) => (section === p || (p === "ideas" && section === "recordings") ? "on" : "");
  return html`<div class="shell">
    <aside class="sidebar">
      <div class="brandmark"><img src="/icons/icon-192.png" alt="" />Idea Bridge</div>
      <nav class="nav">
        ${NAV.map(
          (n, i) => html`${i === 6 && html`<div class="nav-sep"></div>`}
            <a href=${`#/${n.path}`} class=${on(n.path)} key=${n.path}>
              ${icon(n.icon)}${n.label}${n.badge && reviewCount > 0 && html`<span class="badge">${reviewCount}</span>`}
            </a>`,
        )}
      </nav>
      <a class="record-cta" href="#/capture">${icon("mic")} Record</a>
      <div class="tiny" style="color:#8fa89e;padding:10px 6px 0">Signed in as ${me.name}</div>
    </aside>
    <main class="main" id="main">${children}</main>
    <nav class="tabbar" aria-label="Main">
      <a href="#/today" class=${on("today")}>${icon("home")}Today</a>
      <a href="#/review" class=${on("review")}>${icon("inbox")}Review${reviewCount > 0 && html`<span class="badge">${reviewCount}</span>`}</a>
      <a href="#/capture" class="rec-tab">${icon("mic")}Record</a>
      <a href="#/ideas" class=${on("ideas")}>${icon("library")}Library</a>
      <a href="#/more" class=${["more", "projects", "tasks", "ask", "insights", "settings"].includes(section) ? "on" : ""}>${icon("menu")}More</a>
    </nav>
    <${AudioDock} />
  </div>`;
}

function More() {
  return html`<div class="page narrow">
    <h1>More</h1>
    <div class="card flush list">
      ${NAV.filter((n) => !["today", "review", "ideas"].includes(n.path)).map(
        (n) => html`<a class="item" href=${`#/${n.path}`}>${icon(n.icon)}<span class="grow item-title">${n.label}</span></a>`,
      )}
      <a class="item" href="#/recordings">${icon("mic")}<span class="grow item-title">All recordings</span></a>
    </div>
  </div>`;
}

function Router({ me }) {
  const route = useRoute();
  const [a, b] = route.parts;
  useEffect(() => {
    document.getElementById("main")?.scrollTo?.(0, 0);
    window.scrollTo(0, 0);
  }, [a, b]);

  if (a === "capture") return html`<${Capture} me=${me} />`;

  let view;
  switch (a) {
    case undefined:
    case "today":
      view = html`<${Dashboard} me=${me} />`;
      break;
    case "review":
      view = html`<${Review} me=${me} />`;
      break;
    case "ideas":
      view = b ? html`<${IdeaView} id=${Number(b)} me=${me} tab=${route.parts[2]} key=${b} />` : html`<${Library} query=${route.query} />`;
      break;
    case "recordings":
      view = b ? html`<${RecordingView} id=${Number(b)} key=${b} />` : html`<${Library} query=${{ ...route.query, view: "recordings" }} />`;
      break;
    case "projects":
      view = b ? html`<${ProjectView} id=${Number(b)} me=${me} key=${b} />` : html`<${Projects} />`;
      break;
    case "tasks":
      view = html`<${Tasks} me=${me} query=${route.query} />`;
      break;
    case "ask":
      view = html`<${Ask} />`;
      break;
    case "insights":
    case "digests":
    case "priorities":
      view = html`<${Insights} tab=${a === "insights" ? route.query.tab : a} />`;
      break;
    case "settings":
      view = html`<${Settings} me=${me} />`;
      break;
    case "more":
      view = html`<${More} />`;
      break;
    default:
      view = html`<div class="page"><h1>Not found</h1><a href="#/today">Go to Today</a></div>`;
  }
  return html`<${Shell} me=${me} route=${route}>${view}<//>`;
}

function App() {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const load = () =>
    get("/api/state")
      .then((s) => {
        setState(s);
        setError(null);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const out = () => load();
    window.addEventListener("ib:signedout", out);
    return () => window.removeEventListener("ib:signedout", out);
  }, []);
  useEffect(() => {
    // First open after signing in: go to the person's home screen.
    if (state?.user && (!location.hash || location.hash === "#/" || location.hash === "#")) {
      go(state.user.home === "capture" ? "/capture" : "/today");
    }
  }, [state?.user?.id]);

  if (error && !state) {
    return html`<div class="auth"><div class="card"><h2>Can't reach Idea Bridge</h2><p class="muted">${error}</p><button class="btn primary" onClick=${load}>Try again</button></div></div>`;
  }
  if (!state) return html`<div class="boot">Idea Bridge</div>`;
  if (state.setupNeeded) return html`<${Setup} onDone=${load} />`;
  if (!state.user) return html`<${Login} onDone=${load} />`;
  return html`<${Router} me=${state.user} />`;
}

render(html`<${App} />`, document.getElementById("app"));

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "navigate" && e.data.url) location.hash = e.data.url.replace(/^.*#/, "#");
  });
}
