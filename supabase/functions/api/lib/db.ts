import postgres from "postgres";
import { config } from "./config.ts";

// Thin async wrapper around postgres.js. Queries are written with `?`
// placeholders (converted to $1, $2, ...) to keep SQL readable.

type Sql = postgres.Sql | postgres.TransactionSql;
type Param = string | number | boolean | null | undefined;

function convert(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export class DB {
  constructor(
    private sql: Sql,
    private inTx = false,
  ) {}

  private q<T>(query: string, params: Param[]): Promise<T[]> {
    return (this.sql as postgres.Sql).unsafe(convert(query), params.map((p) => (p === undefined ? null : p)) as never[]) as unknown as Promise<T[]>;
  }

  async get<T = Record<string, unknown>>(query: string, ...params: Param[]): Promise<T | undefined> {
    const rows = await this.q<T>(query, params);
    return rows[0];
  }

  all<T = Record<string, unknown>>(query: string, ...params: Param[]): Promise<T[]> {
    return this.q<T>(query, params);
  }

  async run(query: string, ...params: Param[]): Promise<number> {
    const res = (await this.q(query, params)) as unknown as { count: number };
    return res.count ?? 0;
  }

  // INSERT ... and returns the new row id.
  async insert(query: string, ...params: Param[]): Promise<number> {
    const rows = await this.q<{ id: number }>(`${query} RETURNING id`, params);
    return Number(rows[0].id);
  }

  // Runs fn in a transaction (or inside the current one).
  tx<T>(fn: (db: DB) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    return (this.sql as postgres.Sql).begin((t) => fn(new DB(t, true))) as Promise<T>;
  }
}

let shared: postgres.Sql | null = null;

export function connect(url = config.dbUrl): DB {
  shared ??= postgres(url, {
    max: 4,
    prepare: false, // works with Supabase's connection pooler
    fetch_types: false, // skips a lookup on every new connection; no custom types are used
    idle_timeout: 20,
    onnotice: () => {},
  });
  return new DB(shared);
}

export async function getSetting<T>(db: DB, key: string, fallback: T): Promise<T> {
  const row = await db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function setSetting(db: DB, key: string, value: unknown) {
  await db.run(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    key,
    JSON.stringify(value),
  );
}

export async function logActivity(
  db: DB,
  userId: number | null,
  action: string,
  entity?: string,
  entityId?: number,
  detail?: string,
) {
  await db.run(
    "INSERT INTO activity (user_id, action, entity, entity_id, detail) VALUES (?, ?, ?, ?, ?)",
    userId,
    action,
    entity ?? null,
    entityId ?? null,
    detail ?? null,
  );
}

export function nowText(d = new Date()): string {
  return d.toISOString().replace("T", " ").slice(0, 19);
}

export function safeJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
