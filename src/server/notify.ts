import nodemailer, { type Transporter } from "nodemailer";
import webpush from "web-push";
import { config } from "./config.js";
import type { DB } from "./db.js";
import { getSetting, setSetting } from "./db.js";

// Notifications are deliberately sparse: the organizer works through the review
// queue in batches, so only things that need a person now are pushed.

let pushReady = false;

export function initPush(db: DB): string | null {
  let pub = config.vapidPublicKey;
  let priv = config.vapidPrivateKey;
  if (!pub || !priv) {
    // Generate once and keep in the database so subscriptions stay valid.
    const stored = getSetting<{ publicKey: string; privateKey: string } | null>(db, "vapid", null);
    if (stored) {
      pub = stored.publicKey;
      priv = stored.privateKey;
    } else {
      const keys = webpush.generateVAPIDKeys();
      setSetting(db, "vapid", keys);
      pub = keys.publicKey;
      priv = keys.privateKey;
    }
  }
  try {
    webpush.setVapidDetails(config.vapidSubject, pub, priv);
    pushReady = true;
    return pub;
  } catch (err) {
    console.warn("[push] disabled:", (err as Error).message);
    return null;
  }
}

let transport: Transporter | null = null;
function mailer(): Transporter | null {
  if (!config.smtpUrl) return null;
  transport ??= nodemailer.createTransport(config.smtpUrl);
  return transport;
}

export interface Note {
  title: string;
  body?: string;
  url?: string;
}

export async function notifyUser(db: DB, userId: number, note: Note, opts: { push?: boolean; email?: string } = {}) {
  db.prepare("INSERT INTO notifications (user_id, title, body, url) VALUES (?, ?, ?, ?)").run(
    userId,
    note.title,
    note.body ?? null,
    note.url ?? null,
  );
  const user = db.prepare("SELECT email, notify_push, notify_email FROM users WHERE id = ?").get(userId) as
    | { email: string | null; notify_push: number; notify_email: number }
    | undefined;
  if (!user) return;
  if (opts.push !== false && user.notify_push && pushReady) {
    const subs = db.prepare("SELECT endpoint, keys FROM push_subscriptions WHERE user_id = ?").all(userId) as {
      endpoint: string;
      keys: string;
    }[];
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: JSON.parse(s.keys) },
          JSON.stringify({ title: note.title, body: note.body ?? "", url: note.url ?? "/" }),
          { TTL: 24 * 3600 },
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        // 404/410: the browser dropped the subscription; forget it.
        if (status === 404 || status === 410) db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(s.endpoint);
        else console.warn("[push] failed:", (err as Error).message);
      }
    }
  }
  const m = mailer();
  if (opts.email && m && user.email && user.notify_email) {
    try {
      await m.sendMail({
        from: config.mailFrom || "Idea Bridge <no-reply@localhost>",
        to: user.email,
        subject: note.title,
        text: `${opts.email}\n\n${config.publicUrl}/${note.url ?? ""}`,
      });
    } catch (err) {
      console.warn("[email] failed:", (err as Error).message);
    }
  }
}

export function notifyRole(db: DB, role: "organizer" | "visionary", note: Note, opts: { push?: boolean; email?: string } = {}) {
  const users = db.prepare("SELECT id FROM users WHERE role = ?").all(role) as { id: number }[];
  for (const u of users) void notifyUser(db, u.id, note, opts);
}

export function emailConfigured(): boolean {
  return !!config.smtpUrl;
}
