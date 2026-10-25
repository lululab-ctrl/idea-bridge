import { createClient } from "@supabase/supabase-js";
import { config } from "./config.ts";

// Files (audio, attachments) live in private storage buckets. The phone uploads
// straight to storage with a one-time signed link, and playback uses short-lived
// signed links, so large files never pass through this function.

export interface Storage {
  uploadUrl(bucket: string, path: string): Promise<string>;
  signedUrl(bucket: string, path: string, expiresSec?: number): Promise<string>;
  size(bucket: string, path: string): Promise<number | null>;
  remove(bucket: string, paths: string[]): Promise<void>;
}

class SupabaseStorage implements Storage {
  private client = createClient(config.supabaseUrl, config.serviceRoleKey, { auth: { persistSession: false } });

  async uploadUrl(bucket: string, path: string): Promise<string> {
    const { data, error } = await this.client.storage.from(bucket).createSignedUploadUrl(path, { upsert: true });
    if (error || !data) throw new Error(`Storage upload link failed: ${error?.message}`);
    return data.signedUrl;
  }

  async signedUrl(bucket: string, path: string, expiresSec = 3600): Promise<string> {
    const { data, error } = await this.client.storage.from(bucket).createSignedUrl(path, expiresSec);
    if (error || !data) throw new Error(`Storage link failed: ${error?.message}`);
    return data.signedUrl;
  }

  async size(bucket: string, path: string): Promise<number | null> {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    const name = path.slice(path.lastIndexOf("/") + 1);
    const { data, error } = await this.client.storage.from(bucket).list(dir, { search: name, limit: 5 });
    if (error) throw new Error(`Storage lookup failed: ${error.message}`);
    const hit = data?.find((f) => f.name === name);
    return hit ? Number((hit.metadata as { size?: number } | null)?.size ?? 0) : null;
  }

  async remove(bucket: string, paths: string[]): Promise<void> {
    if (!paths.length) return;
    const { error } = await this.client.storage.from(bucket).remove(paths);
    if (error) throw new Error(`Storage delete failed: ${error.message}`);
  }
}

// Local stand-in for tests: files on disk, served by the function itself.
class LocalStorage implements Storage {
  constructor(private base: string) {}
  private file(bucket: string, path: string) {
    return `${config.localStorageDir}/${bucket}/${path}`;
  }
  uploadUrl(bucket: string, path: string): Promise<string> {
    return Promise.resolve(`${this.base}/_local/${bucket}/${encodeURIComponent(path)}`);
  }
  signedUrl(bucket: string, path: string): Promise<string> {
    return Promise.resolve(`${this.base}/_local/${bucket}/${encodeURIComponent(path)}`);
  }
  async size(bucket: string, path: string): Promise<number | null> {
    try {
      return (await Deno.stat(this.file(bucket, path))).size;
    } catch {
      return null;
    }
  }
  async remove(bucket: string, paths: string[]): Promise<void> {
    for (const p of paths) await Deno.remove(this.file(bucket, p)).catch(() => {});
  }
  async put(bucket: string, path: string, body: Uint8Array) {
    const f = this.file(bucket, path);
    await Deno.mkdir(f.slice(0, f.lastIndexOf("/")), { recursive: true });
    await Deno.writeFile(f, body);
  }
  async read(bucket: string, path: string): Promise<Uint8Array | null> {
    try {
      return await Deno.readFile(this.file(bucket, path));
    } catch {
      return null;
    }
  }
}

let instance: Storage | null = null;
export function storage(baseUrl = ""): Storage {
  instance ??= config.storageMode === "local" ? new LocalStorage(baseUrl) : new SupabaseStorage();
  return instance;
}

export function localStorageImpl(): LocalStorage | null {
  return instance instanceof LocalStorage ? instance : null;
}
