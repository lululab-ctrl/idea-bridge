import path from "node:path";

// All configuration comes from environment variables so the app can be
// deployed anywhere by filling in a single .env file (see .env.example).

function str(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== "" ? v : fallback;
}

const dataDir = path.resolve(str("DATA_DIR", "./data"));

export const config = {
  port: num("PORT", 3000),
  host: str("HOST", "0.0.0.0"),
  // Public URL is used in sign-in links, emails and push notifications.
  publicUrl: str("PUBLIC_URL", "http://localhost:3000").replace(/\/$/, ""),
  dataDir,
  dbPath: path.join(dataDir, "ideabridge.db"),
  audioDir: path.join(dataDir, "audio"),
  filesDir: path.join(dataDir, "files"),
  backupDir: path.join(dataDir, "backups"),
  timezone: str("TZ", "UTC"),

  // "live" uses the real providers below; "mock" uses deterministic fakes
  // (only for automated tests and local UI work - never for real use).
  aiMode: str("AI_MODE", "live") as "live" | "mock",

  anthropicApiKey: str("ANTHROPIC_API_KEY"),
  // Main model for understanding ideas, reports and plans.
  claudeModel: str("CLAUDE_MODEL", "claude-opus-5-5"),

  // Transcription: ElevenLabs first (word timestamps, strong Hebrew), OpenAI as backup.
  elevenlabsApiKey: str("ELEVENLABS_API_KEY"),
  elevenlabsModel: str("ELEVENLABS_MODEL", "scribe_v2"),
  openaiApiKey: str("OPENAI_API_KEY"),
  openaiTranscribeModel: str("OPENAI_TRANSCRIBE_MODEL", "gpt-transcribe"),
  // Embeddings power meaning-based search and duplicate detection.
  embeddingModel: str("EMBEDDING_MODEL", "text-embedding-3-large"),
  embeddingDims: num("EMBEDDING_DIMS", 1024),

  // Optional off-site backup to any S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS).
  s3Endpoint: str("BACKUP_S3_ENDPOINT"),
  s3Bucket: str("BACKUP_S3_BUCKET"),
  s3AccessKey: str("BACKUP_S3_ACCESS_KEY_ID"),
  s3SecretKey: str("BACKUP_S3_SECRET_ACCESS_KEY"),
  s3Region: str("BACKUP_S3_REGION", "auto"),

  // Optional email (digests + overdue reminders).
  smtpUrl: str("SMTP_URL"),
  mailFrom: str("MAIL_FROM"),

  // Optional web push. Generated automatically on first start if empty.
  vapidPublicKey: str("VAPID_PUBLIC_KEY"),
  vapidPrivateKey: str("VAPID_PRIVATE_KEY"),
  vapidSubject: str("VAPID_SUBJECT", "mailto:admin@example.com"),

  // Session cookie lifetime: phones stay signed in for a year.
  sessionDays: num("SESSION_DAYS", 365),
  maxUploadMb: num("MAX_UPLOAD_MB", 200),
  backupKeepDays: num("BACKUP_KEEP_DAYS", 14),
};

export type Config = typeof config;
