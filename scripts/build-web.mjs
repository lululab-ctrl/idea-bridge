// Builds the static web app into dist/ for Cloudflare Pages (or any static host).
//   IDEA_BRIDGE_API_URL=https://<project>.supabase.co/functions/v1 node scripts/build-web.mjs
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "dist");
const api = (process.env.IDEA_BRIDGE_API_URL ?? "").replace(/\/$/, "");
if (!api && !process.argv.includes("--local")) {
  console.error("Set IDEA_BRIDGE_API_URL to https://<project-ref>.supabase.co/functions/v1");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
cpSync(join(root, "public"), out, { recursive: true });

const vendor = {
  "preact.mjs": "preact/dist/preact.mjs",
  "hooks.mjs": "preact/hooks/dist/hooks.mjs",
  "htm.mjs": "htm/dist/htm.mjs",
  "marked.mjs": "marked/lib/marked.esm.js",
  "purify.mjs": "dompurify/dist/purify.es.mjs",
};
mkdirSync(join(out, "vendor"), { recursive: true });
for (const [name, src] of Object.entries(vendor)) cpSync(join(root, "node_modules", src), join(out, "vendor", name));

// The server runs in the same region as the database (much faster).
const region = process.env.IDEA_BRIDGE_REGION ?? "";
writeFileSync(join(out, "config.js"), `window.IDEA_BRIDGE_API = ${JSON.stringify(api)};\nwindow.IDEA_BRIDGE_REGION = ${JSON.stringify(region)};\n`);
// Cloudflare Pages: never cache the config or the service worker, so updates arrive at once.
writeFileSync(
  join(out, "_headers"),
  ["/config.js", "  Cache-Control: no-cache", "/sw.js", "  Cache-Control: no-cache", "/*", "  X-Content-Type-Options: nosniff", "  Referrer-Policy: same-origin", ""].join("\n"),
);
// GitHub Pages: serve files as they are (no Jekyll processing).
writeFileSync(join(out, ".nojekyll"), "");
console.log(`Built dist/ (API: ${api || "same origin"})`);
