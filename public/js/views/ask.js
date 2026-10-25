import { useEffect, useRef, useState } from "preact/hooks";
import { html, icon, Markdown, personName, post, usePeople, Working } from "../lib.js";

const STORE = "ib-ask-history";

export function Ask() {
  const { people } = usePeople();
  const him = personName(people, "visionary");
  const [msgs, setMsgs] = useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(STORE) ?? "[]");
    } catch {
      return [];
    }
  });
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef();
  useEffect(() => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify(msgs.slice(-20)));
    } catch {
      /* private mode */
    }
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs]);

  const suggestions = [
    `What has ${him} been most excited about this month?`,
    "Which ideas involve AI or automation?",
    "Which ideas could be combined into one business?",
    "What is waiting on me, and what should I do first?",
    `What did ${him} say about pricing or making money?`,
  ];

  async function send(text) {
    const question = (text ?? q).trim();
    if (!question || busy) return;
    const history = msgs.map((m) => ({ role: m.role, content: m.content }));
    setMsgs([...msgs, { role: "user", content: question }]);
    setQ("");
    setBusy(true);
    try {
      const r = await post("/api/ask", { question, history });
      setMsgs((m) => [...m, { role: "assistant", content: r.answer, cited: r.cited }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", content: `**Couldn't answer:** ${e.message}`, error: true }]);
    } finally {
      setBusy(false);
    }
  }

  return html`<div class="page narrow">
    <div class="page-head">
      <div><h1>Ask</h1><div class="sub">Ask anything about the ideas, recordings and plans. Answers cite the ideas they come from.</div></div>
      ${msgs.length > 0 && html`<button class="btn ghost small" onClick=${() => setMsgs([])}>New conversation</button>`}
    </div>
    ${msgs.length === 0 && html`<div class="stack tight">
      <div class="label">Try asking</div>
      ${suggestions.map((s) => html`<button class="btn" style="justify-content:flex-start;white-space:normal;text-align:left" onClick=${() => send(s)}>${s}</button>`)}
    </div>`}
    <div class="chat">
      ${msgs.map((m, i) => m.role === "user"
        ? html`<div class="msg user bidi" key=${i}>${m.content}</div>`
        : html`<div class="msg assistant" key=${i}>
            <${Markdown} text=${m.content} cite />
            ${m.cited?.length > 0 && html`<div class="row" style="margin-top:8px">${m.cited.map((c) => html`<a class="chip tag" href=${`#/ideas/${c.id}`} key=${c.id}>#${c.id} ${c.title}</a>`)}</div>`}
          </div>`)}
      ${busy && html`<div class="msg assistant"><${Working} text="Reading through the library…" /></div>`}
      <div ref=${end}></div>
    </div>
    <form class="row nowrap" style="position:sticky;bottom:calc(var(--nav-h) + 8px + env(safe-area-inset-bottom));background:var(--bg);padding:8px 0" onSubmit=${(e) => { e.preventDefault(); send(); }}>
      <input type="text" value=${q} onInput=${(e) => setQ(e.target.value)} placeholder="Ask a question…" dir="auto" style="min-height:44px" aria-label="Your question" />
      <button class="btn primary" style="min-height:44px" disabled=${busy || !q.trim()}>Ask</button>
    </form>
  </div>`;
}
