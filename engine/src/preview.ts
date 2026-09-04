/**
 * Local scrub preview. Serves the composition with a scrubber so a format can be
 * iterated on without encoding anything. The renderer never takes this path.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { COMP_DIR, ENGINE_DIR, ROOT } from "./paths.js";
import { ensureBundle } from "./bundle.js";
import { totalFrames } from "../shared/spec.js";
import type { LoadedFormat } from "./format.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

export function startPreview(fmt: LoadedFormat, port = 5173): void {
  ensureBundle();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    let relPath = decodeURIComponent(url.pathname);
    if (relPath === "/") relPath = "/index.html";

    if (relPath === "/format.json") {
      res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
      res.end(JSON.stringify(fmt.spec));
      return;
    }

    const candidates = [
      path.join(COMP_DIR, relPath),
      path.join(ENGINE_DIR, relPath),
      path.join(fmt.dir, relPath),
    ];
    const file = candidates.find(
      (f) => f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile()
    );
    if (!file) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });

  server.listen(port, () => {
    console.log(`\n▸ preview  ${fmt.slug}  —  ${totalFrames(fmt.spec)} frames`);
    console.log(`  http://localhost:${port}/index.html?preview=1`);
    console.log(`  The scrubber is preview-only; the renderer never uses it.`);
    console.log(`  Ctrl+C to stop.\n`);
  });
}
