import { config } from "./config.ts";
import type { DB } from "./db.ts";
import { getSetting, setSetting } from "./db.ts";

// Service keys can be pasted by the admin in Settings (stored in the database,
// which only the server can read) or set as function secrets. Secrets win.

export interface Keys {
  anthropic: string;
  groq: string;
  resend: string;
}
export type KeyName = keyof Keys;

const fromEnv = (): Keys => ({ anthropic: config.anthropicApiKey, groq: config.groqApiKey, resend: config.resendApiKey });

let current: Keys = fromEnv();
let loadedAt = 0;

export function keys(): Keys {
  return current;
}

// Reads stored keys at most every 30 seconds per server instance.
export async function loadKeys(db: DB, force = false): Promise<Keys> {
  if (!force && Date.now() - loadedAt < 30_000) return current;
  const stored = await getSetting<Partial<Keys>>(db, "api_keys", {});
  const env = fromEnv();
  current = {
    anthropic: env.anthropic || stored.anthropic || "",
    groq: env.groq || stored.groq || "",
    resend: env.resend || stored.resend || "",
  };
  loadedAt = Date.now();
  return current;
}

export async function saveKey(db: DB, name: KeyName, value: string | null) {
  const stored = await getSetting<Partial<Keys>>(db, "api_keys", {});
  if (value) stored[name] = value;
  else delete stored[name];
  await setSetting(db, "api_keys", stored);
  return loadKeys(db, true);
}

// What the admin sees: never the key itself, only where it comes from and its end.
export async function keySummary(db: DB) {
  await loadKeys(db);
  const env = fromEnv();
  const out: Record<string, { set: boolean; source: "secret" | "settings" | null; hint: string | null }> = {};
  for (const name of ["anthropic", "groq", "resend"] as KeyName[]) {
    const v = current[name];
    out[name] = { set: !!v, source: env[name] ? "secret" : v ? "settings" : null, hint: v ? `…${v.slice(-4)}` : null };
  }
  return out;
}

// A free request that only succeeds with a valid key.
export async function checkKey(name: KeyName, value: string): Promise<string | null> {
  if (config.aiMode === "mock") return null;
  const req =
    name === "anthropic"
      ? fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": value, "anthropic-version": "2023-06-01" } })
      : name === "groq"
      ? fetch("https://api.groq.com/openai/v1/models", { headers: { Authorization: `Bearer ${value}` } })
      : fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${value}` } });
  try {
    const res = await req;
    await res.body?.cancel();
    if (res.status === 401 || res.status === 403) return "This key was rejected. Check that you copied all of it.";
    if (!res.ok && res.status !== 429) return `The service answered with an error (${res.status}). Try again in a minute.`;
    return null;
  } catch {
    return "Couldn't reach the service to check the key. Try again in a minute.";
  }
}

// The worker secret is made once and kept in the database, unless set as a secret.
export async function workerSecret(db: DB): Promise<string> {
  if (config.workerSecret) return config.workerSecret;
  let s = await getSetting<string | null>(db, "worker_secret", null);
  if (!s) {
    s = crypto.randomUUID() + crypto.randomUUID();
    await setSetting(db, "worker_secret", s);
  }
  return s;
}
