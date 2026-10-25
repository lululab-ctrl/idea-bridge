import fs from "node:fs";
import type { DB } from "./db.js";
import { logActivity } from "./db.js";
import { addReview } from "./ideas.js";
import { indexRecording, indexTask } from "./search.js";

// Nothing important is destroyed by a single click.
//  - Recordings are only marked as deleted. Ideas, reports and projects built
//    from them are untouched, and the admin can restore them from the trash.
//  - Tasks, files, documents and notes are copied into the trash table before
//    they are removed, and can be put back exactly as they were.
//  - Only the admin can empty the trash, item by item, with a confirmation.

const TABLES: Record<string, { table: string; label: (r: Record<string, unknown>) => string }> = {
  task: { table: "tasks", label: (r) => `Task: ${r.title}` },
  attachment: { table: "attachments", label: (r) => `File: ${r.name}` },
  deliverable: { table: "deliverables", label: (r) => `Document: ${r.title}` },
  note: { table: "notes", label: (r) => `Note: ${String(r.body).slice(0, 60)}` },
};

export function moveToTrash(db: DB, entity: keyof typeof TABLES, id: number, userId: number | null): boolean {
  const t = TABLES[entity];
  const row = db.prepare(`SELECT * FROM ${t.table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return false;
  db.transaction(() => {
    db.prepare("INSERT INTO trash (entity, entity_id, label, data, deleted_by) VALUES (?, ?, ?, ?, ?)").run(
      entity,
      id,
      t.label(row),
      JSON.stringify(row),
      userId,
    );
    db.prepare(`DELETE FROM ${t.table} WHERE id = ?`).run(id);
    if (entity === "task") db.prepare("DELETE FROM search_fts WHERE entity = 'task' AND entity_id = ?").run(id);
    logActivity(db, userId, "trash", entity, id, t.label(row));
  })();
  return true;
}

export function restoreFromTrash(db: DB, trashId: number, userId: number | null): { ok: boolean; reason?: string } {
  const item = db.prepare("SELECT * FROM trash WHERE id = ?").get(trashId) as
    | { entity: string; entity_id: number; data: string; label: string }
    | undefined;
  if (!item) return { ok: false, reason: "Not in the trash any more." };
  const t = TABLES[item.entity];
  const row = JSON.parse(item.data) as Record<string, unknown>;
  // Links to things that no longer exist are cleared instead of blocking the restore.
  for (const [col, table] of [
    ["project_id", "projects"],
    ["idea_id", "ideas"],
    ["task_id", "tasks"],
    ["assignee_id", "users"],
    ["user_id", "users"],
  ] as const) {
    if (row[col] != null && !db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(row[col])) row[col] = null;
  }
  const cols = Object.keys(row);
  db.transaction(() => {
    db.prepare(`INSERT INTO ${t.table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
      ...cols.map((c) => row[c] as never),
    );
    db.prepare("DELETE FROM trash WHERE id = ?").run(trashId);
    if (item.entity === "task") indexTask(db, item.entity_id);
    logActivity(db, userId, "restore", item.entity, item.entity_id, item.label);
  })();
  return { ok: true };
}

// Permanently removes one trash item (and its file, for attachments).
export function purgeTrashItem(db: DB, trashId: number, userId: number | null) {
  const item = db.prepare("SELECT * FROM trash WHERE id = ?").get(trashId) as
    | { entity: string; entity_id: number; data: string; label: string }
    | undefined;
  if (!item) return;
  if (item.entity === "attachment") {
    const path = (JSON.parse(item.data) as { path?: string }).path;
    if (path && fs.existsSync(path)) fs.unlinkSync(path);
  }
  db.prepare("DELETE FROM trash WHERE id = ?").run(trashId);
  logActivity(db, userId, "purge", item.entity, item.entity_id, item.label);
}

// ---------------------------------------------------------------- recordings

export function deleteRecording(db: DB, id: number, user: { id: number; name: string; role: string }) {
  const rec = db.prepare("SELECT id, summary, captured_at, deleted_at FROM recordings WHERE id = ?").get(id) as
    | { id: number; summary: string | null; captured_at: string; deleted_at: string | null }
    | undefined;
  if (!rec || rec.deleted_at) return;
  db.transaction(() => {
    db.prepare("UPDATE recordings SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?").run(user.id, id);
    // Waiting work for it is cancelled; ideas already built from it stay as they are.
    db.prepare("DELETE FROM jobs WHERE type = 'process_recording' AND status = 'pending' AND json_extract(payload, '$.recordingId') = ?").run(id);
    db.prepare("DELETE FROM search_fts WHERE entity = 'recording' AND entity_id = ?").run(id);
    logActivity(db, user.id, "delete", "recording", id, rec.summary ?? undefined);
    if (user.role !== "organizer") {
      const ideas = db
        .prepare("SELECT DISTINCT idea_id FROM fragments WHERE recording_id = ? AND idea_id IS NOT NULL")
        .all(id) as { idea_id: number }[];
      addReview(db, {
        kind: "recording_deleted",
        ideaId: ideas[0]?.idea_id ?? null,
        recordingId: id,
        note: `${user.name} deleted a recording from ${rec.captured_at.slice(0, 16)}${rec.summary ? ` (“${rec.summary}”)` : ""}. ${
          ideas.length
            ? `The ${ideas.length === 1 ? "idea" : `${ideas.length} ideas`} built from it ${ideas.length === 1 ? "is" : "are"} unchanged.`
            : "No ideas were built from it."
        } You can restore it from the trash.`,
      });
    }
  })();
}

export function restoreRecording(db: DB, id: number, userId: number) {
  const rec = db.prepare("SELECT status, purged_at FROM recordings WHERE id = ?").get(id) as
    | { status: string; purged_at: string | null }
    | undefined;
  if (!rec) return;
  db.prepare("UPDATE recordings SET deleted_at = NULL, deleted_by = NULL WHERE id = ?").run(id);
  if (!rec.purged_at) indexRecording(db, id);
  logActivity(db, userId, "restore", "recording", id);
}

// Permanently removes the audio and transcript. The thoughts already taken from
// it (with his quoted words) stay inside their ideas.
export function purgeRecording(db: DB, id: number, userId: number) {
  const rec = db.prepare("SELECT audio_path FROM recordings WHERE id = ? AND deleted_at IS NOT NULL").get(id) as
    | { audio_path: string | null }
    | undefined;
  if (!rec) return false;
  if (rec.audio_path && fs.existsSync(rec.audio_path)) fs.unlinkSync(rec.audio_path);
  db.prepare(
    "UPDATE recordings SET audio_path = NULL, transcript = NULL, segments = NULL, analysis = NULL, purged_at = datetime('now') WHERE id = ?",
  ).run(id);
  db.prepare("DELETE FROM search_fts WHERE entity = 'recording' AND entity_id = ?").run(id);
  logActivity(db, userId, "purge", "recording", id);
  return true;
}
