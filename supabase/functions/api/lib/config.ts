// All configuration comes from environment variables. On Supabase they are set
// as function secrets (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
// SUPABASE_DB_URL are provided automatically).

function str(name: string, fallback = ""): string {
  const v = Deno.env.get(name);
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const v = Number(raw);
  return raw && Number.isFinite(v) ? v : fallback;
}

export const config = {
  // Address of the app (Cloudflare Pages). Used for sign-in links, emails and CORS.
  appUrl: str("APP_URL", "http://localhost:8788").replace(/\/$/, ""),
  supabaseUrl: str("SUPABASE_URL", "http://localhost:54321").replace(/\/$/, ""),
  serviceRoleKey: str("SUPABASE_SERVICE_ROLE_KEY"),
  dbUrl: str("SUPABASE_DB_URL", str("DATABASE_URL")),
  // Shared secret the once-a-minute scheduler uses to wake the worker.
  workerSecret: str("WORKER_SECRET"),
  timezone: str("TZ_DEFAULT", "Asia/Jerusalem"),

  // "live" uses real providers; "mock" uses deterministic fakes (tests only).
  aiMode: str("AI_MODE", "live") as "live" | "mock",
  // "supabase" stores files in Supabase Storage; "local" is for tests.
  storageMode: str("STORAGE_MODE", "supabase") as "supabase" | "local",
  localStorageDir: str("LOCAL_STORAGE_DIR", "/tmp/ideabridge-storage"),

  // Claude, paid from the Team plan's monthly API credits.
  anthropicApiKey: str("ANTHROPIC_API_KEY"),
  // Everyday understanding (thoughts, linking, idea cards, digests, search).
  claudeModel: str("CLAUDE_MODEL", "claude-haiku-5-5"),
  // Deeper writing done a few times a day (reports, evaluations, plans, documents).
  claudeDeepModel: str("CLAUDE_DEEP_MODEL", "claude-sonnet-5-5"),

  // Groq free plan: Whisper transcription.
  groqApiKey: str("GROQ_API_KEY"),
  groqModel: str("GROQ_WHISPER_MODEL", "whisper-large-v3"),

  // Optional email via Resend's free plan.
  resendApiKey: str("RESEND_API_KEY"),
  mailFrom: str("MAIL_FROM", "Idea Bridge <onboarding@resend.dev>"),

  vapidSubject: str("VAPID_SUBJECT", "mailto:admin@example.com"),

  sessionDays: num("SESSION_DAYS", 365),
  // Supabase free plan has 1 GB of file storage; old audio is cleared (transcripts
  // kept) when this is reached.
  storageLimitMb: num("STORAGE_LIMIT_MB", 900),
  maxUploadMb: num("MAX_UPLOAD_MB", 25),
};
