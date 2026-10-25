import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

// Configure before any app module reads the environment.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ideabridge-test-"));
process.env.DATA_DIR = dataDir;
process.env.AI_MODE = "mock";
process.env.NODE_ENV = "test";

const { createServer } = await import("../src/server/index.js");
const { openDb } = await import("../src/server/db.js");

type Server = Awaited<ReturnType<typeof createServer>>;
let srv: Server;
let cookie = "";
let hisCookie = "";

const H = { "x-ideabridge": "1" };

async function api<T = any>(method: string, url: string, body?: unknown, who = cookie): Promise<T> {
  const res = await srv.app.inject({
    method: method as "GET",
    url,
    headers: { ...H, cookie: who, ...(body ? { "content-type": "application/json" } : {}) },
    payload: body ? JSON.stringify(body) : undefined,
  });
  if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode}: ${res.body}`);
  return res.json() as T;
}

function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Buffer }) {
  const boundary = "----ibtest" + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { body: Buffer.concat(parts), type: `multipart/form-data; boundary=${boundary}` };
}

async function record(text: string, extra: Record<string, string> = {}, who = hisCookie) {
  // The mock transcriber treats the uploaded bytes as the spoken words.
  const m = multipart(
    { client_id: `c-${Math.random()}`, captured_at: new Date().toISOString(), duration: "12", ...extra },
    { name: "rec.webm", type: "audio/webm", data: Buffer.from(text.padEnd(300, " ")) },
  );
  const res = await srv.app.inject({ method: "POST", url: "/api/recordings", headers: { ...H, cookie: who, "content-type": m.type }, payload: m.body });
  assert.equal(res.statusCode, 200, res.body);
  return res.json() as { id: number };
}

before(async () => {
  srv = await createServer(openDb(path.join(dataDir, "test.db")), { background: false });
});

after(async () => {
  await srv.app.close();
  srv.ctx.db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Idea Bridge end to end (mock AI)", () => {
  it("rejects API writes without the CSRF header", async () => {
    const res = await srv.app.inject({ method: "POST", url: "/api/setup", payload: {} });
    assert.equal(res.statusCode, 403);
  });

  it("sets up both people and signs the visionary in with a one-time link", async () => {
    const state = await api("GET", "/api/state");
    assert.equal(state.setupNeeded, true);
    const res = await srv.app.inject({
      method: "POST",
      url: "/api/setup",
      headers: { ...H, "content-type": "application/json" },
      payload: JSON.stringify({ organizer: { name: "Lulu", password: "correct horse 1" }, visionary: { name: "Matan" }, timezone: "Asia/Jerusalem" }),
    });
    assert.equal(res.statusCode, 200, res.body);
    cookie = String(res.headers["set-cookie"]).split(";")[0];
    const me = await api("GET", "/api/state");
    assert.equal(me.user.name, "Lulu");
    assert.equal(me.user.role, "organizer");

    const users = await api<any[]>("GET", "/api/users");
    const avi = users.find((u) => u.role === "visionary");
    const link = await api("POST", `/api/users/${avi.id}/login-link`, {});
    assert.match(link.qr, /<svg/);
    const token = link.url.split("/login/")[1];
    // Opening the link (as a messaging app's preview would) must not use it up.
    const preview = await srv.app.inject({ method: "GET", url: `/login/${token}` });
    assert.match(preview.body, /Continue/);
    // Sent exactly as the browser's form does.
    const login = await srv.app.inject({ method: "POST", url: `/login/${token}`, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "" });
    assert.equal(login.statusCode, 302);
    hisCookie = String(login.headers["set-cookie"]).split(";")[0];
    const his = await api("GET", "/api/state", undefined, hisCookie);
    assert.equal(his.user.name, "Matan");
    assert.equal(his.user.home, "capture");
    // Links work once.
    const again = await srv.app.inject({ method: "POST", url: `/login/${token}` });
    assert.equal(again.statusCode, 410);
  });

  it("rejects a wrong password and accepts the right one", async () => {
    const bad = await srv.app.inject({ method: "POST", url: "/api/login", headers: { ...H, "content-type": "application/json" }, payload: JSON.stringify({ name: "lulu", password: "nope" }) });
    assert.equal(bad.statusCode, 401);
    const good = await srv.app.inject({ method: "POST", url: "/api/login", headers: { ...H, "content-type": "application/json" }, payload: JSON.stringify({ name: "lulu", password: "correct horse 1" }) });
    assert.equal(good.statusCode, 200);
  });

  let dogIdea = 0;
  let podcastIdea = 0;

  it("splits one rambling recording into separate ideas", async () => {
    const r = await record(
      "So I was thinking we should build an app that helps busy dog owners find trusted dog walkers in their neighborhood. Another idea: a weekly podcast interviewing Israeli founders about their first failures.",
    );
    await srv.ctx.jobs.idle();
    const rec = await api("GET", `/api/recordings/${r.id}`);
    assert.equal(rec.status, "done", rec.error);
    assert.equal(rec.fragments.length, 2);
    const ideas = await api<any[]>("GET", "/api/ideas");
    assert.equal(ideas.length, 2);
    dogIdea = ideas.find((i) => /dog/i.test(i.title + i.summary)).id;
    podcastIdea = ideas.find((i) => /podcast/i.test(i.title + i.summary)).id;
    assert.ok(dogIdea && podcastIdea);
    const review = await api<any[]>("GET", "/api/review");
    assert.equal(review.filter((x) => x.kind === "new_idea").length, 2);
    // Every new idea starts as a brainstorm, not an obligation.
    assert.ok(ideas.every((i) => i.status === "new"));
  });

  it("is idempotent when the phone retries an upload", async () => {
    const m = multipart({ client_id: "same-id" }, { name: "a.webm", type: "audio/webm", data: Buffer.from("hello there this is a retry test".padEnd(300)) });
    const send = () => srv.app.inject({ method: "POST", url: "/api/recordings", headers: { ...H, cookie: hisCookie, "content-type": m.type }, payload: m.body });
    const a = (await send()).json();
    const b = (await send()).json();
    assert.equal(a.id, b.id);
    await srv.ctx.jobs.idle();
  });

  it("attaches a follow-up about the same idea and keeps version history", async () => {
    await record("About the app that helps busy dog owners find trusted dog walkers in their neighborhood: owners should pay a monthly subscription.");
    await srv.ctx.jobs.idle();
    const idea = await api(`GET`, `/api/ideas/${dogIdea}`);
    const review = await api<any[]>("GET", "/api/review");
    const attached = idea.fragments.length === 2;
    const flagged = review.some((x) => x.kind === "possible_duplicate" && x.other_idea_id === dogIdea);
    assert.ok(attached || flagged, "follow-up should be attached or flagged for review");
    if (attached) {
      assert.ok(idea.versions.length >= 2);
      assert.ok(review.some((x) => x.kind === "auto_linked" && x.idea_id === dogIdea));
    }
  });

  it("finds ideas by keyword and by meaning", async () => {
    const res = await api("GET", "/api/search?q=walkers");
    assert.ok(res.ideas.some((i: any) => i.id === dogIdea));
    const list = await api<any[]>("GET", `/api/ideas?q=${encodeURIComponent("podcast founders")}`);
    assert.equal(list[0].id, podcastIdea);
  });

  it("keeps hand corrections when the AI updates the idea later", async () => {
    await api("PATCH", `/api/ideas/${podcastIdea}`, { audience: "First-time founders in Tel Aviv", lesson: "'Founders' means early-stage startup founders." });
    await api("POST", `/api/ideas/${podcastIdea}/refresh`, {});
    await srv.ctx.jobs.idle();
    const idea = await api("GET", `/api/ideas/${podcastIdea}`);
    assert.equal(idea.card.audience, "First-time founders in Tel Aviv");
    assert.ok(idea.card.edited.includes("audience"));
    const mem = await api<any[]>("GET", "/api/memory");
    assert.ok(mem.some((m) => m.kind === "correction"));
  });

  it("prepares a report and evaluation when an idea moves into review", async () => {
    await api("PATCH", `/api/ideas/${dogIdea}`, { status: "under_review" });
    await srv.ctx.jobs.idle();
    const idea = await api("GET", `/api/ideas/${dogIdea}`);
    assert.ok(idea.report?.translation);
    assert.ok(idea.score_detail?.value?.reason);
    assert.equal(typeof idea.score, "number");
    const pr = await api("GET", "/api/priorities");
    assert.equal(pr.ideas[0].id, dogIdea);
  });

  it("asks him a question and attaches his spoken answer", async () => {
    const idea = await api("GET", `/api/ideas/${podcastIdea}`);
    const q = idea.questions.find((x: any) => x.status === "draft");
    assert.ok(q, "AI should draft a clarification question");
    await api("POST", `/api/questions/${q.id}/ask`, {});
    const open = await api<any[]>("GET", "/api/questions/open", undefined, hisCookie);
    assert.equal(open.length, 1);
    const after1 = await api("GET", `/api/ideas/${podcastIdea}`);
    assert.equal(after1.status, "needs_clarification");
    await record("The first guests would be founders I already know from my network.", { question_id: String(q.id) });
    await srv.ctx.jobs.idle();
    const after2 = await api("GET", `/api/ideas/${podcastIdea}`);
    assert.equal(after2.questions.find((x: any) => x.id === q.id).status, "answered");
    assert.equal(after2.status, "under_review");
    assert.ok(after2.fragments.some((f: any) => f.answers_question));
  });

  it("turns an approved idea into a project with a reviewed plan", async () => {
    const { projectId } = await api("POST", `/api/ideas/${dogIdea}/approve`, {});
    await srv.ctx.jobs.idle();
    const p = await api("GET", `/api/projects/${projectId}`);
    assert.equal(p.plan_status, "draft");
    assert.ok(p.plan.tasks.length >= 2);
    assert.equal(p.tasks.length, 0, "no tasks until the plan is accepted");
    await api("POST", `/api/projects/${projectId}/plan/accept`, { tasks: [0, 1] });
    const p2 = await api("GET", `/api/projects/${projectId}`);
    assert.equal(p2.tasks.length, 2);
    assert.ok(p2.tasks.every((t: any) => /^\d{4}-\d{2}-\d{2}$/.test(t.due_date)));
    const idea = await api("GET", `/api/ideas/${dogIdea}`);
    assert.equal(idea.status, "in_progress");
    const done = await api("PATCH", `/api/tasks/${p2.tasks[0].id}`, { status: "done" });
    assert.equal(done.ok, true);
    const dash = await api("GET", "/api/dashboard");
    assert.equal(dash.projects[0].done, 1);
  });

  it("merges a duplicate without losing the original words", async () => {
    await record("Totally different thing: a rooftop garden subscription for apartment buildings.");
    await srv.ctx.jobs.idle();
    const ideas = await api<any[]>("GET", "/api/ideas");
    const garden = ideas.find((i) => /garden/i.test(i.title + i.summary));
    const before1 = await api("GET", `/api/ideas/${podcastIdea}`);
    await api("POST", `/api/ideas/${podcastIdea}/merge`, { other_id: garden.id });
    await srv.ctx.jobs.idle();
    const merged = await api("GET", `/api/ideas/${podcastIdea}`);
    assert.equal(merged.fragments.length, before1.fragments.length + 1);
    const old = await api("GET", `/api/ideas/${garden.id}`);
    assert.equal(old.status, "archived");
    // Undo: move the garden thought back out into its own idea.
    const frag = merged.fragments.find((f: any) => /garden/i.test(f.quote));
    await api("POST", `/api/fragments/${frag.id}/move`, { idea_id: null });
    await srv.ctx.jobs.idle();
    const after1 = await api("GET", `/api/ideas/${podcastIdea}`);
    assert.equal(after1.fragments.length, before1.fragments.length);
  });

  it("restores an earlier version", async () => {
    const idea = await api("GET", `/api/ideas/${podcastIdea}`);
    await api("POST", `/api/ideas/${podcastIdea}/versions/1/restore`, {});
    const restored = await api("GET", `/api/ideas/${podcastIdea}`);
    assert.equal(restored.version, idea.version + 1);
    assert.match(restored.versions[0].change_summary, /Restored version 1/);
  });

  it("answers questions about the library with citations", async () => {
    const res = await api("POST", "/api/ask", { question: "What did he say about dog walkers?" });
    assert.ok(res.answer.length > 0);
    assert.ok(Array.isArray(res.cited));
  });

  it("captures typed notes too", async () => {
    const r = await api("POST", "/api/recordings/text", { text: "Quick thought: a newsletter for dog walkers about running their business." }, hisCookie);
    await srv.ctx.jobs.idle();
    const rec = await api("GET", `/api/recordings/${r.id}`);
    assert.equal(rec.status, "done");
    assert.equal(rec.fragments.length, 1);
  });

  it("produces digests, insights, documents and backups", async () => {
    await srv.ctx.periodic.digest("daily");
    await srv.ctx.periodic.digest("weekly");
    const digests = await api<any[]>("GET", "/api/digests");
    assert.equal(digests.length, 2);
    const insights = await api("GET", "/api/insights");
    assert.ok(insights.result.themes.length >= 1);
    await api("POST", `/api/ideas/${dogIdea}/deliverables`, { kind: "business_concept" });
    await srv.ctx.jobs.idle();
    const idea = await api("GET", `/api/ideas/${dogIdea}`);
    assert.equal(idea.deliverables.length, 1);
    const file = await srv.ctx.periodic.backup();
    assert.ok(fs.existsSync(file));
    const md = await srv.app.inject({ method: "GET", url: `/api/ideas/${dogIdea}/export.md`, headers: { cookie } });
    assert.match(md.body, /## Original words/);
    const zip = await srv.app.inject({ method: "GET", url: "/api/export", headers: { cookie } });
    assert.equal(zip.statusCode, 200);
    assert.equal(zip.rawPayload.subarray(0, 2).toString(), "PK");
  });

  it("serves audio with byte ranges for phone players", async () => {
    const recs = await api<any[]>("GET", "/api/recordings");
    const voice = recs.find((r) => r.kind === "voice");
    const res = await srv.app.inject({ method: "GET", url: `/api/recordings/${voice.id}/audio`, headers: { cookie, range: "bytes=0-9" } });
    assert.equal(res.statusCode, 206);
    assert.equal(res.rawPayload.length, 10);
  });

  it("limits the contributor to recording and his own ideas", async () => {
    const as = (method: string, url: string, body?: unknown) =>
      srv.app.inject({ method: method as "GET", url, headers: { ...H, cookie: hisCookie, ...(body ? { "content-type": "application/json" } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    for (const [m, u, b] of [
      ["GET", "/api/ideas"],
      ["GET", `/api/ideas/${dogIdea}`],
      ["PATCH", `/api/ideas/${dogIdea}`, { status: "archived" }],
      ["POST", `/api/ideas/${dogIdea}/merge`, { other_id: podcastIdea }],
      ["GET", "/api/review"],
      ["GET", "/api/settings"],
      ["PUT", "/api/settings", { north_star: "x" }],
      ["GET", "/api/users"],
      ["PATCH", "/api/users/1", { password: "takeover123" }],
      ["POST", "/api/users/1/login-link"],
      ["GET", "/api/projects"],
      ["GET", "/api/tasks"],
      ["GET", "/api/export"],
      ["GET", "/api/trash"],
      ["POST", "/api/ask", { question: "x" }],
      ["GET", "/api/system"],
    ] as [string, string, unknown?][]) {
      const res = await as(m, u, b);
      assert.equal(res.statusCode, 403, `${m} ${u} should be admin-only`);
    }
    const mine = (await as("GET", "/api/my/ideas")).json();
    assert.ok(mine.length >= 2, "he sees the ideas his recordings created");
    const one = (await as("GET", `/api/my/ideas/${mine[0].id}`)).json();
    assert.ok(one.fragments.length >= 1);
    assert.equal(one.report, undefined, "reports stay in the admin workspace");
  });

  it("only shows the contributor his own recordings", async () => {
    const r = await api("POST", "/api/recordings/text", { text: "Admin's own note about the office move." });
    await srv.ctx.jobs.idle();
    const res = await srv.app.inject({ method: "GET", url: `/api/recordings/${r.id}`, headers: { cookie: hisCookie } });
    assert.equal(res.statusCode, 404);
    const list = (await srv.app.inject({ method: "GET", url: "/api/recordings", headers: { cookie: hisCookie } })).json();
    assert.ok(list.every((x: any) => x.user_name === "Matan"));
    const del = await srv.app.inject({ method: "DELETE", url: `/api/recordings/${r.id}`, headers: { ...H, cookie: hisCookie } });
    assert.equal(del.statusCode, 404, "he can't delete someone else's recording");
  });

  it("deleting a recording keeps its ideas and can be undone", async () => {
    const before = await api("GET", `/api/ideas/${dogIdea}`);
    const recId = before.fragments[0].recording_id;
    const del = await srv.app.inject({ method: "DELETE", url: `/api/recordings/${recId}`, headers: { ...H, cookie: hisCookie } });
    assert.equal(del.statusCode, 200);
    const after = await api("GET", `/api/ideas/${dogIdea}`);
    assert.equal(after.fragments.length, before.fragments.length, "idea keeps his words");
    assert.equal(after.status, before.status);
    const his = (await srv.app.inject({ method: "GET", url: "/api/recordings", headers: { cookie: hisCookie } })).json();
    assert.ok(!his.some((x: any) => x.id === recId), "gone from his list");
    const review = await api<any[]>("GET", "/api/review");
    const item = review.find((x) => x.kind === "recording_deleted");
    assert.ok(item, "admin is told about it");
    const trash = await api("GET", "/api/trash");
    assert.ok(trash.recordings.some((x: any) => x.id === recId));
    await api("POST", `/api/review/${item.id}`, { action: "restore" });
    const back = (await srv.app.inject({ method: "GET", url: "/api/recordings", headers: { cookie: hisCookie } })).json();
    assert.ok(back.some((x: any) => x.id === recId), "restored");
    // Permanent removal needs explicit confirmation and still keeps the idea.
    await srv.app.inject({ method: "DELETE", url: `/api/recordings/${recId}`, headers: { ...H, cookie: hisCookie } });
    const noConfirm = await srv.app.inject({ method: "DELETE", url: `/api/recordings/${recId}/purge`, headers: { ...H, cookie } });
    assert.equal(noConfirm.statusCode, 400);
    await api("DELETE", `/api/recordings/${recId}/purge`, { confirm: "DELETE" });
    const still = await api("GET", `/api/ideas/${dogIdea}`);
    assert.equal(still.fragments.length, before.fragments.length);
  });

  it("deleted tasks go to the trash and come back", async () => {
    const t = await api("POST", "/api/tasks", { title: "Call the vet association" });
    await api("DELETE", `/api/tasks/${t.id}`);
    const trash = await api("GET", "/api/trash");
    const item = trash.items.find((x: any) => x.entity === "task");
    assert.ok(item);
    await api("POST", `/api/trash/${item.id}/restore`);
    const tasks = await api<any[]>("GET", "/api/tasks");
    assert.ok(tasks.some((x) => x.id === t.id && x.title === "Call the vet association"));
  });

  it("lets the admin reset the contributor's password", async () => {
    const users = await api<any[]>("GET", "/api/users");
    const him = users.find((u) => u.role === "visionary");
    await api("PATCH", `/api/users/${him.id}`, { password: "new-pass-123" });
    const old = await srv.app.inject({ method: "GET", url: "/api/state", headers: { cookie: hisCookie } });
    assert.equal(old.json().user, null, "his old session was signed out");
    const login = await srv.app.inject({ method: "POST", url: "/api/login", headers: { ...H, "content-type": "application/json" }, payload: JSON.stringify({ name: "matan", password: "new-pass-123" }) });
    assert.equal(login.statusCode, 200);
  });

  it("keeps unauthenticated visitors out", async () => {
    const res = await srv.app.inject({ method: "GET", url: "/api/ideas" });
    assert.equal(res.statusCode, 401);
  });
});
