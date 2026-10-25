import { useState } from "preact/hooks";
import { html, post } from "../lib.js";

export function Setup({ onDone }) {
  const [f, setF] = useState({ oName: "", oEmail: "", oPw: "", vName: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post("/api/setup", {
        organizer: { name: f.oName, email: f.oEmail, password: f.oPw },
        visionary: { name: f.vName },
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      location.hash = "#/settings?welcome=1";
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return html`<div class="auth">
    <form class="card" onSubmit=${submit}>
      <img class="logo" src="/icons/icon-192.png" alt="" />
      <div class="stack tight">
        <h1>Welcome to Idea Bridge</h1>
        <p class="muted">Two quick questions and you're ready. Everything stays private to the two of you.</p>
      </div>
      <div class="label">You review and organize</div>
      <label class="field">Your name<input type="text" required value=${f.oName} onInput=${set("oName")} autocomplete="given-name" /></label>
      <label class="field">Email <span class="hint">Optional. Used for the daily digest and reminders.</span><input type="email" value=${f.oEmail} onInput=${set("oEmail")} autocomplete="email" /></label>
      <label class="field">Password <span class="hint">At least 8 characters.</span><input type="password" required minlength="8" value=${f.oPw} onInput=${set("oPw")} autocomplete="new-password" /></label>
      <div class="divider"></div>
      <div class="label">He records ideas</div>
      <label class="field">His name<input type="text" required value=${f.vName} onInput=${set("vName")} /></label>
      <p class="small muted">He won't need a password. Next you'll get a QR code that puts the app on his phone, already signed in.</p>
      ${error && html`<div class="banner bad"><div class="grow">${error}</div></div>`}
      <button class="btn primary" disabled=${busy}>${busy ? "Setting up…" : "Create our space"}</button>
    </form>
  </div>`;
}

export function Login({ onDone }) {
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post("/api/login", { name, password: pw });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return html`<div class="auth">
    <form class="card" onSubmit=${submit}>
      <img class="logo" src="/icons/icon-192.png" alt="" />
      <h1>Sign in</h1>
      <label class="field">Name or email<input type="text" required value=${name} onInput=${(e) => setName(e.target.value)} autocomplete="username" /></label>
      <label class="field">Password<input type="password" required value=${pw} onInput=${(e) => setPw(e.target.value)} autocomplete="current-password" /></label>
      ${error && html`<div class="banner bad"><div class="grow">${error}</div></div>`}
      <button class="btn primary" disabled=${busy}>${busy ? "Signing in…" : "Sign in"}</button>
      <p class="small muted">No password? Ask your partner to open Settings → People and send you a sign-in link.</p>
    </form>
  </div>`;
}
