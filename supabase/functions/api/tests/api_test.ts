// End-to-end tests of the API against a real local Postgres, with simulated AI
// and local file storage. Run with: deno task test (see deno.json).
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.13";

const PG = Deno.env.get("TEST_PG") ?? "postgres://postgres@localhost:54329";
const DBNAME = "ideabridge_test";
const psql = async (args: string[]) => {
  const out = await new Deno.Command("psql", { args: [PG + "/postgres", "-v", "ON_ERROR_STOP=1", "-q", ...args], stderr: "piped", stdout: "piped" }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
};

// Fresh database with the real migrations.
await psql(["-c", `DROP DATABASE IF EXISTS ${DBNAME} WITH (FORCE)`]);
await psql(["-c", `CREATE DATABASE ${DBNAME}`]);
const migrationsDir = new URL("../../../migrations/", import.meta.url).pathname;
for (const f of [...Deno.readDirSync(migrationsDir)].map((e) => e.name).sort()) {
  const out = await new Deno.Command("psql", { args: [`${PG}/${DBNAME}`, "-v", "ON_ERROR_STOP=1", "-q", "-f", migrationsDir + f], stderr: "piped" }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
}

const storageDir = await Deno.makeTempDir({ prefix: "ib-storage-" });
Deno.env.set("DATABASE_URL", `${PG}/${DBNAME}`);
Deno.env.set("AI_MODE", "mock");
Deno.env.set("STORAGE_MODE", "local");
Deno.env.set("LOCAL_STORAGE_DIR", storageDir);
Deno.env.set("WORKER_SECRET", "test-secret");

const { handle } = await import("../index.ts");
const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, handle);
const BASE = `http://127.0.0.1:${server.addr.port}`;

let admin = "";
let him = "";

async function call<T = any>(method: string, path: string, body?: unknown, token = admin, expect = 200): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status !== expect) throw new Error(`${method} ${path} -> ${res.status} (expected ${expect}): ${text}`);
  return (text && res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text) as T;
}

// Runs the background worker until nothing is left to do.
async function idle() {
  const { connect } = await import("../lib/db.ts");
  const db = connect();
  for (let i = 0; i < 200; i++) {
    await fetch(`${BASE}/api/_worker`, { method: "POST", headers: { "x-worker-secret": "test-secret" } }).then((r) => r.body?.cancel());
    const n = await db.get<{ n: number }>("SELECT COUNT(*)::int AS n FROM jobs WHERE status IN ('pending','running') AND run_at <= now_text()");
    if (!n?.n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("worker never finished");
}

// Uploads like the phone does: register, upload to storage, confirm.
async function record(text: string, extra: Record<string, unknown> = {}, token = him) {
  const data = new TextEncoder().encode(text.padEnd(300, " "));
  const start = await call("POST", "/api/recordings", { client_id: `c-${Math.random()}`, mime: "audio/webm", size: data.length, duration: 12, ...extra }, token);
  const put = await fetch(start.uploadUrl, { method: "PUT", body: data, headers: { "content-type": "audio/webm" } });
  assertEquals(put.status, 200);
  await put.body?.cancel();
  return call("POST", `/api/recordings/${start.id}/uploaded`, {}, token);
}

let dogIdea = 0;
let podcastIdea = 0;

Deno.test({
  name: "Idea Bridge API end to end",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    await t.step("first run creates the admin and the contributor", async () => {
      const state = await call("GET", "/api/state", undefined, "");
      assertEquals(state.setupNeeded, true);
      const res = await call("POST", "/api/setup", { organizer: { name: "Lulu", password: "admin-pass-1" }, visionary: { name: "Matan", password: "matan-pass-1" }, timezone: "Asia/Jerusalem" }, "");
      admin = res.token;
      const me = await call("GET", "/api/state");
      assertEquals(me.user.name, "Lulu");
      assertEquals(me.user.role, "organizer");
      await call("POST", "/api/setup", { organizer: { name: "X", password: "xxxxxxxx" }, visionary: { name: "Y" } }, "", 409);
    });

    await t.step("sign-in link works once", async () => {
      const users = await call<any[]>("GET", "/api/users");
      const matan = users.find((u) => u.role === "visionary");
      const link = await call("POST", `/api/users/${matan.id}/login-link`);
      assertMatch(link.qr, /<svg/);
      const token = link.url.split("/signin/")[1];
      const res = await call("POST", "/api/signin-link", { token }, "");
      him = res.token;
      assertEquals((await call("GET", "/api/state", undefined, him)).user.name, "Matan");
      await call("POST", "/api/signin-link", { token }, "", 410);
    });

    await t.step("password sign-in", async () => {
      await call("POST", "/api/login", { name: "matan", password: "nope" }, "", 401);
      const ok = await call("POST", "/api/login", { name: "Matan", password: "matan-pass-1" }, "");
      assert(ok.token);
    });

    await t.step("one rambling recording becomes separate ideas", async () => {
      const r = await record("So we should build an app that helps busy dog owners find trusted dog walkers in their neighborhood. Another idea: a weekly podcast interviewing Israeli founders about their first failures.");
      assertEquals(r.status, "queued");
      await idle();
      const rec = await call("GET", `/api/recordings/${r.id}`);
      assertEquals(rec.status, "done", rec.error);
      assertEquals(rec.fragments.length, 2);
      const ideas = await call<any[]>("GET", "/api/ideas");
      assertEquals(ideas.length, 2);
      dogIdea = ideas.find((i) => /dog/i.test(i.title + i.summary)).id;
      podcastIdea = ideas.find((i) => /podcast/i.test(i.title + i.summary)).id;
      const review = await call<any[]>("GET", "/api/review");
      assertEquals(review.filter((x) => x.kind === "new_idea").length, 2);
    });

    await t.step("upload retries are idempotent", async () => {
      const body = { client_id: "same-id", mime: "audio/webm", size: 400 };
      const a = await call("POST", "/api/recordings", body, him);
      const b = await call("POST", "/api/recordings", body, him);
      assertEquals(a.id, b.id);
    });

    await t.step("an unfinished upload is not processed", async () => {
      const start = await call("POST", "/api/recordings", { client_id: "never-uploaded", mime: "audio/webm", size: 400 }, him);
      await call("POST", `/api/recordings/${start.id}/uploaded`, {}, him, 400);
    });

    await t.step("a follow-up attaches to the same idea or is flagged", async () => {
      await record("About the app that helps busy dog owners find trusted dog walkers in their neighborhood: owners should pay a monthly subscription.");
      await idle();
      const idea = await call(`GET`, `/api/ideas/${dogIdea}`);
      const review = await call<any[]>("GET", "/api/review");
      assert(idea.fragments.length === 2 || review.some((x) => x.kind === "possible_duplicate" && x.other_idea_id === dogIdea));
    });

    await t.step("search by words and by meaning", async () => {
      const res = await call("GET", "/api/search?q=walkers");
      assert(res.ideas.some((i: any) => i.id === dogIdea));
      const meaning = await call("GET", "/api/search?q=pet%20care");
      assert(meaning.ideas.some((i: any) => i.id === dogIdea && i.matchedBy.includes("meaning")), "found by meaning");
    });

    await t.step("hand corrections survive AI updates", async () => {
      await call("PATCH", `/api/ideas/${podcastIdea}`, { audience: "First-time founders in Tel Aviv", lesson: "Founders means early-stage founders." });
      await call("POST", `/api/ideas/${podcastIdea}/refresh`);
      await idle();
      const idea = await call("GET", `/api/ideas/${podcastIdea}`);
      assertEquals(idea.card.audience, "First-time founders in Tel Aviv");
    });

    await t.step("review prepares report and evaluation", async () => {
      await call("PATCH", `/api/ideas/${dogIdea}`, { status: "under_review" });
      await idle();
      const idea = await call("GET", `/api/ideas/${dogIdea}`);
      assert(idea.report?.translation);
      assertEquals(typeof idea.score, "number");
    });

    await t.step("question to him and his spoken answer", async () => {
      const idea = await call("GET", `/api/ideas/${podcastIdea}`);
      const q = idea.questions.find((x: any) => x.status === "draft");
      await call("POST", `/api/questions/${q.id}/ask`);
      assertEquals((await call<any[]>("GET", "/api/questions/open", undefined, him)).length, 1);
      await record("The first guests would be founders I already know from my network.", { question_id: q.id });
      await idle();
      const after = await call("GET", `/api/ideas/${podcastIdea}`);
      assertEquals(after.questions.find((x: any) => x.id === q.id).status, "answered");
    });

    await t.step("approve, plan, accept tasks", async () => {
      const { projectId } = await call("POST", `/api/ideas/${dogIdea}/approve`, {});
      await idle();
      const p = await call("GET", `/api/projects/${projectId}`);
      assertEquals(p.plan_status, "draft");
      await call("POST", `/api/projects/${projectId}/plan/accept`, { tasks: [0, 1] });
      const p2 = await call("GET", `/api/projects/${projectId}`);
      assertEquals(p2.tasks.length, 2);
      await call("PATCH", `/api/tasks/${p2.tasks[0].id}`, { status: "done" });
      const dash = await call("GET", "/api/dashboard");
      assertEquals(dash.projects[0].done, 1);
    });

    await t.step("merge and undo keep his words", async () => {
      await record("Totally different thing: a rooftop garden subscription for apartment buildings.");
      await idle();
      const garden = (await call<any[]>("GET", "/api/ideas")).find((i) => /garden/i.test(i.title + i.summary));
      const before = await call("GET", `/api/ideas/${podcastIdea}`);
      await call("POST", `/api/ideas/${podcastIdea}/merge`, { other_id: garden.id });
      await idle();
      const merged = await call("GET", `/api/ideas/${podcastIdea}`);
      assertEquals(merged.fragments.length, before.fragments.length + 1);
      const frag = merged.fragments.find((f: any) => /garden/i.test(f.quote));
      await call("POST", `/api/fragments/${frag.id}/move`, { idea_id: null });
      await idle();
      assertEquals((await call("GET", `/api/ideas/${podcastIdea}`)).fragments.length, before.fragments.length);
    });

    await t.step("versions restore", async () => {
      const idea = await call("GET", `/api/ideas/${podcastIdea}`);
      await call("POST", `/api/ideas/${podcastIdea}/versions/1/restore`);
      assertEquals((await call("GET", `/api/ideas/${podcastIdea}`)).version, idea.version + 1);
    });

    await t.step("ask, digests, insights, documents, export", async () => {
      const a = await call("POST", "/api/ask", { question: "What about dog walkers?" });
      assert(a.answer);
      await call("POST", "/api/digests/run", { kind: "weekly" });
      await call("POST", `/api/ideas/${dogIdea}/deliverables`, { kind: "business_concept" });
      await idle();
      assert((await call<any[]>("GET", "/api/digests")).length >= 1);
      assert((await call("GET", "/api/insights")).result.themes.length >= 1);
      assertEquals((await call("GET", `/api/ideas/${dogIdea}`)).deliverables.length, 1);
      const zip = await fetch(`${BASE}/api/export`, { headers: { authorization: `Bearer ${admin}` } });
      const bytes = new Uint8Array(await zip.arrayBuffer());
      assertEquals(String.fromCharCode(bytes[0], bytes[1]), "PK");
    });

    await t.step("audio playback link", async () => {
      const recs = await call<any[]>("GET", "/api/recordings");
      const link = await call("GET", `/api/recordings/${recs.find((r) => r.kind === "voice").id}/audio`);
      const res = await fetch(link.url);
      assertEquals(res.status, 200);
      await res.body?.cancel();
    });

    await t.step("the contributor is limited", async () => {
      for (const [m, u, b] of [
        ["GET", "/api/ideas"],
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
        ["GET", "/api/keys"],
        ["PUT", "/api/keys/groq", { value: "gsk_x" }],
      ] as [string, string, unknown?][]) {
        await call(m, u, b, him, 403);
      }
      const mine = await call<any[]>("GET", "/api/my/ideas", undefined, him);
      assert(mine.length >= 2);
      const one = await call("GET", `/api/my/ideas/${mine[0].id}`, undefined, him);
      assert(one.fragments.length >= 1);
      assertEquals(one.report, undefined);
      const r = await call("POST", "/api/recordings/text", { text: "Admin's own note about the office move." });
      await idle();
      await call("GET", `/api/recordings/${r.id}`, undefined, him, 404);
      await call("DELETE", `/api/recordings/${r.id}`, undefined, him, 404);
    });

    await t.step("deleting a recording keeps ideas and can be undone", async () => {
      const before = await call("GET", `/api/ideas/${dogIdea}`);
      const recId = before.fragments[0].recording_id;
      await call("DELETE", `/api/recordings/${recId}`, undefined, him);
      const after = await call("GET", `/api/ideas/${dogIdea}`);
      assertEquals(after.fragments.length, before.fragments.length);
      const item = (await call<any[]>("GET", "/api/review")).find((x) => x.kind === "recording_deleted");
      assert(item);
      assert((await call("GET", "/api/trash")).recordings.some((x: any) => x.id === recId));
      await call("POST", `/api/review/${item.id}`, { action: "restore" });
      assert((await call<any[]>("GET", "/api/recordings", undefined, him)).some((x) => x.id === recId));
      await call("DELETE", `/api/recordings/${recId}`, undefined, him);
      await call("DELETE", `/api/recordings/${recId}/purge`, {}, admin, 400);
      await call("DELETE", `/api/recordings/${recId}/purge`, { confirm: "DELETE" });
      assertEquals((await call("GET", `/api/ideas/${dogIdea}`)).fragments.length, before.fragments.length);
    });

    await t.step("trash restores tasks exactly", async () => {
      const task = await call("POST", "/api/tasks", { title: "Call the vet association" });
      await call("DELETE", `/api/tasks/${task.id}`);
      const item = (await call("GET", "/api/trash")).items.find((x: any) => x.entity === "task");
      await call("POST", `/api/trash/${item.id}/restore`);
      assert((await call<any[]>("GET", "/api/tasks")).some((x) => x.id === task.id));
    });

    await t.step("admin resets his password and signs him out", async () => {
      const users = await call<any[]>("GET", "/api/users");
      const matan = users.find((u) => u.role === "visionary");
      await call("PATCH", `/api/users/${matan.id}`, { password: "new-pass-123" });
      assertEquals((await call("GET", "/api/state", undefined, him)).user, null);
      assert((await call("POST", "/api/login", { name: "matan", password: "new-pass-123" }, "")).token);
    });

    await t.step("monthly AI budget pauses work instead of overspending", async () => {
      await call("PUT", "/api/settings", { ai_budget_usd: 0.5 });
      const { connect } = await import("../lib/db.ts");
      await connect().run("INSERT INTO ai_usage (purpose, provider, model, cost_usd) VALUES ('test', 'anthropic', 'x', 1)");
      const sys = await call("GET", "/api/system");
      assertEquals(sys.budget.exhausted, true);
      await call("PUT", "/api/settings", { ai_budget_usd: 18 });
    });

    await t.step("AI keys are saved by the admin, never shown or exported", async () => {
      let k = await call("PUT", "/api/keys/groq", { value: "gsk_secret_value_9876" });
      assertEquals(k.groq, { set: true, source: "settings", hint: "…9876" });
      assertEquals(JSON.stringify(await call("GET", "/api/keys")).includes("secret_value"), false);
      await call("PUT", "/api/keys/nope", { value: "x" }, admin, 404);
      const zip = await fetch(`${BASE}/api/export`, { headers: { authorization: `Bearer ${admin}` } });
      const { unzipSync, strFromU8 } = await import("fflate");
      const files = unzipSync(new Uint8Array(await zip.arrayBuffer()));
      const all = Object.values(files).map((f) => strFromU8(f)).join("\n");
      assertEquals(all.includes("gsk_secret_value_9876"), false);
      assertEquals(all.includes("test-secret"), false);
      k = await call("PUT", "/api/keys/groq", { value: "" });
      assertEquals(k.groq.set, false);
    });

    await t.step("cross-site requests are only allowed from the app", async () => {
      const res = await fetch(`${BASE}/api/health`, { method: "OPTIONS", headers: { origin: "https://evil.example" } });
      assertEquals(res.headers.get("access-control-allow-origin"), null);
      await res.body?.cancel();
      await call("GET", "/api/ideas", undefined, "", 401);
    });

    await server.shutdown();
  },
});
