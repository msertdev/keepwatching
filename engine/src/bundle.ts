/**
 * Build the composition bundle. Kept in-process (esbuild's JS API) so `kw render`
 * is a single command with no build step to forget.
 */
import fs from "node:fs";
import path from "node:path";
import { buildSync } from "esbuild";

import { COMP_BUNDLE, COMP_DIR } from "./paths.js";

const SOURCES = ["comp.ts", "icons.ts"].map((f) => path.join(COMP_DIR, f));

function newestSourceMtime(): number {
  const shared = path.join(COMP_DIR, "..", "shared", "spec.ts");
  return [...SOURCES, shared]
    .filter((f) => fs.existsSync(f))
    .reduce((max, f) => Math.max(max, fs.statSync(f).mtimeMs), 0);
}

export function ensureBundle(force = false): void {
  const stale =
    force || !fs.existsSync(COMP_BUNDLE) || fs.statSync(COMP_BUNDLE).mtimeMs < newestSourceMtime();
  if (!stale) return;

  buildSync({
    entryPoints: [path.join(COMP_DIR, "comp.ts")],
    bundle: true,
    format: "iife",
    target: "chrome110",
    outfile: COMP_BUNDLE,
    logLevel: "warning",
  });
}
