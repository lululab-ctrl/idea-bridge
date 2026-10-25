// Deploy and backup helpers that need only a Supabase access token.
//
//   deno run -A --node-modules-dir=none scripts/ops.ts migrate            apply new files in supabase/migrations
//   deno run -A --node-modules-dir=none scripts/ops.ts secrets NAME=value set function secrets
//   deno run -A --node-modules-dir=none scripts/ops.ts backup out.json    every table as JSON
//   deno run -A --node-modules-dir=none scripts/ops.ts restore in.json    put a backup back (replaces current data)
//
// Environment: SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF talk to Supabase's
// Management API. For local testing, DATABASE_URL talks to Postgres directly.

const token = Deno.env.get("SUPABASE_ACCESS_TOKEN") ?? "";
const ref = Deno.env.get("SUPABASE_PROJECT_REF") ?? "";
const dbUrl = Deno.env.get("DATABASE_URL") ?? "";
const API = `https://api.supabase.com/v1/projects/${ref}`;

type Row = Record<string, unknown>;

async function management(method: string, path: string, body?: unknown): Promise<unknown> {
  if (!token || !ref) throw new Error("Set SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF.");
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API + path, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.ok) return text ? JSON.parse(text) : null;
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await new Promise((r) => setTimeout(r, attempt * 3000));
      continue;
    }
    throw new Error(`Supabase API ${method} ${path} failed (${res.status}): ${text.slice(0, 500)}`);
  }
}

let sql: ((q: string) => Promise<Row[]>) | null = null;
async function query(q: string): Promise<Row[]> {
  if (!sql) {
    if (dbUrl) {
      const { default: postgres } = await import("npm:postgres@3.4.9");
      const conn = postgres(dbUrl, { max: 1, onnotice: () => {} });
      sql = async (text) => (await conn.unsafe(text).simple()).flat?.() ?? [];
      addEventListener("unload", () => conn.end());
    } else {
      sql = async (text) => ((await management("POST", "/database/query", { query: text })) as Row[]) ?? [];
    }
  }
  return sql(q);
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

async function migrate() {
  await query("CREATE SCHEMA IF NOT EXISTS ib_meta; CREATE TABLE IF NOT EXISTS ib_meta.migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const done = new Set((await query("SELECT name FROM ib_meta.migrations")).map((r) => String(r.name)));
  const dir = new URL("../supabase/migrations/", import.meta.url);
  const files = [...Deno.readDirSync(dir)].map((e) => e.name).filter((n) => n.endsWith(".sql")).sort();
  for (const name of files) {
    if (done.has(name)) continue;
    const body = await Deno.readTextFile(new URL(name, dir));
    console.log(`Applying ${name}`);
    await query(`BEGIN;\n${body}\n;INSERT INTO ib_meta.migrations (name) VALUES (${lit(name)});\nCOMMIT;`);
  }
  console.log("Database is up to date.");
}

async function secrets(pairs: string[]) {
  const list = pairs
    .map((p) => {
      const i = p.indexOf("=");
      return { name: p.slice(0, i), value: p.slice(i + 1) };
    })
    .filter((s) => s.name && s.value);
  if (!list.length) return;
  await management("POST", "/secrets", list);
  console.log(`Set ${list.map((s) => s.name).join(", ")}.`);
}

// Tables in an order where every row's references exist before it.
async function tablesInOrder(): Promise<string[]> {
  const tables = (await query(
    "SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1",
  )).map((r) => String(r.name));
  const deps = await query(
    `SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
     FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE c.contype = 'f' AND n.nspname = 'public'`,
  );
  const parents = new Map(tables.map((t) => [t, new Set<string>()]));
  for (const d of deps) {
    const child = String(d.child).replace(/^public\./, "").replace(/"/g, "");
    const parent = String(d.parent).replace(/^public\./, "").replace(/"/g, "");
    if (child !== parent) parents.get(child)?.add(parent);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (t: string) => {
    if (seen.has(t)) return;
    seen.add(t);
    for (const p of parents.get(t) ?? []) visit(p);
    out.push(t);
  };
  tables.forEach(visit);
  return out;
}

async function backup(file: string) {
  const data: Record<string, Row[]> = {};
  for (const t of await tablesInOrder()) {
    const r = await query(`SELECT COALESCE(json_agg(t), '[]'::json) AS rows FROM public.${ident(t)} t`);
    const rows = r[0]?.rows;
    data[t] = (typeof rows === "string" ? JSON.parse(rows) : rows) as Row[];
  }
  const meta = { app: "idea-bridge", made_at: new Date().toISOString(), tables: Object.fromEntries(Object.entries(data).map(([t, r]) => [t, r.length])) };
  await Deno.writeTextFile(file, JSON.stringify({ meta, data }));
  console.log(`Backed up ${Object.values(meta.tables).reduce((a, b) => a + b, 0)} rows from ${Object.keys(data).length} tables to ${file}.`);
}

async function restore(file: string) {
  const { data } = JSON.parse(await Deno.readTextFile(file)) as { data: Record<string, Row[]> };
  const order = (await tablesInOrder()).filter((t) => t in data);
  const stmts = ["BEGIN", `TRUNCATE ${order.map((t) => `public.${ident(t)}`).join(", ")} RESTART IDENTITY CASCADE`];
  for (const t of order) {
    if (!data[t].length) continue;
    // Generated columns (like the search vector) are rebuilt by Postgres.
    const cols = (await query(
      `SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${lit(t)} AND is_generated = 'NEVER' ORDER BY ordinal_position`,
    )).map((r) => String(r.c));
    const list = cols.map(ident).join(", ");
    for (let i = 0; i < data[t].length; i += 500) {
      const chunk = JSON.stringify(data[t].slice(i, i + 500));
      stmts.push(
        `INSERT INTO public.${ident(t)} (${list}) OVERRIDING SYSTEM VALUE SELECT ${list} FROM json_populate_recordset(NULL::public.${ident(t)}, ${lit(chunk)}::json)`,
      );
    }
  }
  // Identity counters continue after the restored rows.
  for (const r of await query(
    "SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND is_identity = 'YES'",
  )) {
    const t = String(r.t), c = String(r.c);
    if (!order.includes(t)) continue;
    stmts.push(
      `SELECT setval(pg_get_serial_sequence(${lit(`public.${ident(t)}`)}, ${lit(c)}), COALESCE((SELECT MAX(${ident(c)}) FROM public.${ident(t)}), 0) + 1, false)`,
    );
  }
  stmts.push("COMMIT");
  await query(stmts.join(";\n"));
  console.log(`Restored ${order.length} tables from ${file}.`);
}

// The region the database runs in (e.g. "eu-central-1").
async function region() {
  const project = (await management("GET", "")) as { region?: string };
  console.log(project.region ?? "");
}

const [cmd, ...args] = Deno.args;
try {
  if (cmd === "migrate") await migrate();
  else if (cmd === "secrets") await secrets(args);
  else if (cmd === "backup") await backup(args[0] ?? "idea-bridge-backup.json");
  else if (cmd === "restore") await restore(args[0]);
  else if (cmd === "region") await region();
  else {
    console.error("Usage: ops.ts migrate | secrets NAME=value… | backup FILE | restore FILE | region");
    Deno.exit(2);
  }
  Deno.exit(0);
} catch (err) {
  console.error((err as Error).message);
  Deno.exit(1);
}
