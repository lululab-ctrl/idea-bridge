import webpush from "web-push";
import { config } from "./config.ts";
import type { DB } from "./db.ts";
import { getSetting, setSetting } from "./db.ts";

// Notifications are deliberately sparse: the admin works through the review
// queue in batches, so only things that need a person now are pushed.

let pushKey: string | null | undefined;

export async function initPush(db: DB): Promise<string | null> {
  if (pushKey !== undefined) return pushKey;
  try {
    const stored = await getSetting<{ publicKey: string; privateKey: string } | null>(db, "vapid", null);
    const keys = stored ?? webpush.generateVAPIDKeys();
    if (!stored) await setSetting(db, "vapid", keys);
    webpush.setVapidDetails(config.vapidSubject, keys.publicKey, keys.privateKey);
    pushKey = keys.publicKey;
  } catch (err) {
    console.warn("[push] disabled:", (err as Error).message);
    pushKey = null;
  }
  return pushKey ?? null;
}

export interface Note {
  title: string;
  body?: string;
  url?: string;
}

export async function notifyUser(db: DB, userId: number, note: Note, opts: { push?: boolean; email?: string } = {}) {
  await db.run("INSERT INTO notifications (user_id, title, body, url) VALUES (?, ?, ?, ?)", userId, note.title, note.body ?? null, note.url ?? null);
  const user = await db.get<{ email: string | null; notify_push: number; notify_email: number }>(
    "SELECT email, notify_push, notify_email FROM users WHERE id = ?",
    userId,
  );
  if (!user) return;
  if (opts.push !== false && user.notify_push && (await initPush(db))) {
    const subs = await db.all<{ endpoint: string; keys: string }>("SELECT endpoint, keys FROM push_subscriptions WHERE user_id = ?", userId);
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: JSON.parse(s.keys) },
          JSON.stringify({ title: note.title, body: note.body ?? "", url: note.url ?? "/" }),
          { TTL: 24 * 3600 },
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) await db.run("DELETE FROM push_subscriptions WHERE endpoint = ?", s.endpoint);
        else console.warn("[push] failed:", (err as Error).message);
      }
    }
  }
  if (opts.email && config.resendApiKey && user.email && user.notify_email) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.resendApiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: config.mailFrom,
          to: [user.email],
          subject: note.title,
          text: `${opts.email}\n\n${config.appUrl}/${note.url ?? ""}`,
        }),
      });
      if (!res.ok) console.warn("[email] failed:", res.status, (await res.text()).slice(0, 200));
    } catch (err) {
      console.warn("[email] failed:", (err as Error).message);
    }
  }
}

export async function notifyRole(db: DB, role: "organizer" | "visionary", note: Note, opts: { push?: boolean; email?: string } = {}) {
  const users = await db.all<{ id: number }>("SELECT id FROM users WHERE role = ?", role);
  for (const u of users) await notifyUser(db, u.id, note, opts);
}

export function emailConfigured(): boolean {
  return !!config.resendApiKey;
}
