import type { DB } from "./db.ts";
import { logActivity } from "./db.ts";
import { addReview } from "./ideas.ts";
import { indexRecording, indexTask } from "./search.ts";
import { storage } from "./storage.ts";

// Nothing important is destroyed by a single click.
//  - Recordings are only marked as deleted. Ideas, reports and projects built
//    from them are untouched, and the admin can restore them from the trash.
//  - Tasks, files, documents and notes are copied into the trash table before
//    they are removed, and can be put back exactly as they were.
//  - Only the admin can remove something permanently, item by item.

const TABLES: Record<string, { table: string; label: (r: Record<string, unknown>) => string }> = {
  task: { table: "tasks", label: (r) => `Task: ${r.title}` },
  attachment: { table: "attachments", label: (r) => `File: ${r.name}` },
  deliverable: { table: "deliverables", label: (r) => `Document: ${r.title}` },
  note: { table: "notes", label: (r) => `Note: ${String(r.body).slice(0, 60)}` },
};

export async function moveToTrash(db: DB, entity: keyof typeof TABLES, id: number, userId: number | null): Promise<boolean> {
  const t = TABLES[entity];
  const row = await db.get<Record<string, unknown>>(`SELECT * FROM ${t.table} WHERE id = ?`, id);
  if (!row) return false;
  await db.tx(async (x) => {
    await x.run("INSERT INTO trash (entity, entity_id, label, data, deleted_by) VALUES (?, ?, ?, ?, ?)", entity, id, t.label(row), JSON.stringify(row), userId);
    await x.run(`DELETE FROM ${t.table} WHERE id = ?`, id);
    if (entity === "task") await x.run("DELETE FROM search_index WHERE entity = 'task' AND entity_id = ?", id);
    await logActivity(x, userId, "trash", entity, id, t.label(row));
  });
  return true;
}

export async function restoreFromTrash(db: DB, trashId: number, userId: number | null): Promise<{ ok: boolean; reason?: string }> {
  const item = await db.get<{ entity: string; entity_id: number; data: string; label: string }>("SELECT * FROM trash WHERE id = ?", trashId);
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
    if (row[col] != null && !(await db.get(`SELECT 1 FROM ${table} WHERE id = ?`, row[col] as number))) row[col] = null;
  }
  const cols = Object.keys(row);
  await db.tx(async (x) => {
    await x.run(
      `INSERT INTO ${t.table} (${cols.join(", ")}) OVERRIDING SYSTEM VALUE VALUES (${cols.map(() => "?").join(", ")})`,
      ...cols.map((c) => row[c] as string | number | null),
    );
    await x.run("DELETE FROM trash WHERE id = ?", trashId);
    if (item.entity === "task") await indexTask(x, item.entity_id);
    await logActivity(x, userId, "restore", item.entity, item.entity_id, item.label);
  });
  return { ok: true };
}

export async function purgeTrashItem(db: DB, trashId: number, userId: number | null) {
  const item = await db.get<{ entity: string; entity_id: number; data: string; label: string }>("SELECT * FROM trash WHERE id = ?", trashId);
  if (!item) return;
  if (item.entity === "attachment") {
    const path = (JSON.parse(item.data) as { path?: string }).path;
    if (path) await storage().remove("files", [path]).catch(() => {});
  }
  await db.run("DELETE FROM trash WHERE id = ?", trashId);
  await logActivity(db, userId, "purge", item.entity, item.entity_id, item.label);
}

// ---------------------------------------------------------------- recordings

export async function deleteRecording(db: DB, id: number, user: { id: number; name: string; role: string }) {
  const rec = await db.get<{ id: number; summary: string | null; captured_at: string; deleted_at: string | null }>(
    "SELECT id, summary, captured_at, deleted_at FROM recordings WHERE id = ?",
    id,
  );
  if (!rec || rec.deleted_at) return;
  await db.tx(async (x) => {
    await x.run("UPDATE recordings SET deleted_at = now_text(), deleted_by = ? WHERE id = ?", user.id, id);
    await x.run(
      "DELETE FROM jobs WHERE status = 'pending' AND type IN ('process_recording','analyze_recording','handle_fragment') AND (payload::jsonb->>'recordingId')::int = ?",
      id,
    );
    await x.run("DELETE FROM search_index WHERE entity = 'recording' AND entity_id = ?", id);
    await logActivity(x, user.id, "delete", "recording", id, rec.summary ?? undefined);
    if (user.role !== "organizer") {
      const ideas = await x.all<{ idea_id: number }>("SELECT DISTINCT idea_id FROM fragments WHERE recording_id = ? AND idea_id IS NOT NULL", id);
      await addReview(x, {
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
  });
}

export async function restoreRecording(db: DB, id: number, userId: number) {
  const rec = await db.get<{ purged_at: string | null }>("SELECT purged_at FROM recordings WHERE id = ?", id);
  if (!rec) return;
  await db.run("UPDATE recordings SET deleted_at = NULL, deleted_by = NULL WHERE id = ?", id);
  if (!rec.purged_at) await indexRecording(db, id);
  await db.run(
    "UPDATE review_items SET status = 'done', resolution = 'restored', resolved_at = now_text() WHERE kind = 'recording_deleted' AND status = 'open' AND recording_id = ?",
    id,
  );
  await logActivity(db, userId, "restore", "recording", id);
}

// Permanently removes the audio and transcript. The thoughts already taken from
// it (with his quoted words) stay inside their ideas.
export async function purgeRecording(db: DB, id: number, userId: number): Promise<boolean> {
  const rec = await db.get<{ audio_path: string | null }>("SELECT audio_path FROM recordings WHERE id = ? AND deleted_at IS NOT NULL", id);
  if (!rec) return false;
  if (rec.audio_path) await storage().remove("audio", [rec.audio_path]).catch(() => {});
  await db.run(
    "UPDATE recordings SET audio_path = NULL, transcript = NULL, segments = NULL, analysis = NULL, purged_at = now_text() WHERE id = ?",
    id,
  );
  await db.run("DELETE FROM search_index WHERE entity = 'recording' AND entity_id = ?", id);
  await logActivity(db, userId, "purge", "recording", id);
  return true;
}
