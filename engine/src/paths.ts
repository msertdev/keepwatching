import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root: the folder that holds engine/, formats/, measure/, site/. */
export const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export const ENGINE_DIR = path.join(ROOT, "engine");
export const COMP_DIR = path.join(ENGINE_DIR, "composition");
export const COMP_HTML = path.join(COMP_DIR, "index.html");
export const COMP_BUNDLE = path.join(COMP_DIR, "comp.js");
export const FONT_DIR = path.join(ENGINE_DIR, "assets", "fonts");
export const FORMATS_DIR = path.join(ROOT, "formats");
export const OUT_DIR = path.join(ROOT, "out");
export const SITE_DIR = path.join(ROOT, "site");
export const MEASURE_DIR = path.join(ROOT, "measure");

export const rel = (p: string): string => path.relative(ROOT, p).replace(/\\/g, "/");
