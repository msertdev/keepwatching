/**
 * Format loading, validation and identity.
 *
 * A format directory holds three files with three different jobs:
 *   format.json — the render spec (machine-owned, deterministic)
 *   meta.yml    — the claim: name, family, explicit hypothesis, when to use it
 *   data.yml    — the evidence: sample size and measured retention, or `untested`
 *
 * Nothing here fabricates evidence. A format with no measurements loads with
 * status "untested" and n = 0, and stays visible everywhere it is listed.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";

import { FORMATS_DIR } from "./paths.js";
import {
  DEFAULT_CANVAS,
  DEFAULT_SAFE,
  type Element,
  type FormatSpec,
} from "../shared/spec.js";

export type FormatFamily =
  | "stat-counter"
  | "countdown"
  | "ranking"
  | "comparison"
  | "reveal"
  | "myth-fact"
  | "cold-open"
  | "progress"
  | "escalation"
  | "reverse";

export interface FormatMeta {
  name: string;
  family: FormatFamily | string;
  /** One sentence, testable. What this format is claimed to do, and when. */
  hypothesis: string;
  /** When a creator should reach for it. */
  useWhen: string;
  /** When it is the wrong tool. */
  avoidWhen?: string;
  tags?: string[];
  /** Fields a user is expected to fill in `format.json`'s `data` block. */
  inputs?: Array<{ key: string; description: string; example?: string }>;
  authors?: string[];
}

export interface RetentionPoint {
  /** Seconds from the start of the clip. */
  t: number;
  /** Fraction of viewers still watching, 0..1. */
  p: number;
}

export interface Measurement {
  /** Number of published videos this format's numbers are based on. */
  n: number;
  status: "untested" | "measured" | "deprecated";
  platforms?: string[];
  /** Fraction of viewers still watching at 3 s. Null when untested. */
  hook3s?: number | null;
  /** Mean fraction of the clip watched. Null when untested. */
  avgViewedPct?: number | null;
  /** Views per hour in the first 24 h, median across samples. */
  viewsPerHour?: number | null;
  /** Percentage-point difference in avgViewedPct against the repo baseline. */
  vsBaselinePct?: number | null;
  retention?: RetentionPoint[];
  /** Free-text caveats. Read before believing any of the above. */
  notes?: string;
  updated?: string;
  samples?: Array<{
    platform: string;
    externalId: string;
    variantId: string;
    publishedAt?: string;
  }>;
}

export interface LoadedFormat {
  slug: string;
  dir: string;
  spec: FormatSpec;
  meta: FormatMeta;
  data: Measurement;
  /** Stable identity for this exact spec — see variantId(). */
  variantId: string;
  specHash: string;
}

/* --------------------------------------------------------------- identity */

/** Content hash of the spec, ignoring key order and formatting. */
export function specHash(spec: FormatSpec): string {
  const canonical = JSON.stringify(sortDeep(spec));
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.keys(o)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortDeep(o[k]);
        return acc;
      }, {});
  }
  return v;
}

/**
 * Variant id: `<slug>@<version>+<specHash>`.
 *
 * It is stamped into the sidecar and the MP4 metadata so a published video can
 * be matched back to the exact spec that produced it, months later, without
 * trusting a filename. Changing any pixel-affecting field changes the hash.
 */
export function variantId(slug: string, spec: FormatSpec): string {
  return `${slug}@${spec.version}+${specHash(spec)}`;
}

export function parseVariantId(
  id: string
): { slug: string; version: string; hash: string } | null {
  const m = /^([a-z0-9-]+)@([^+]+)\+([0-9a-f]+)$/.exec(id.trim());
  return m ? { slug: m[1], version: m[2], hash: m[3] } : null;
}

/* ---------------------------------------------------------------- loading */

const UNTESTED: Measurement = {
  n: 0,
  status: "untested",
  hook3s: null,
  avgViewedPct: null,
  viewsPerHour: null,
  vsBaselinePct: null,
  retention: [],
};

export function listFormatSlugs(): string[] {
  if (!fs.existsSync(FORMATS_DIR)) return [];
  return fs
    .readdirSync(FORMATS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(FORMATS_DIR, d.name, "format.json")))
    .map((d) => d.name)
    .sort();
}

export function loadFormat(slugOrPath: string): LoadedFormat {
  const dir = fs.existsSync(path.join(FORMATS_DIR, slugOrPath))
    ? path.join(FORMATS_DIR, slugOrPath)
    : path.resolve(process.cwd(), slugOrPath);

  const specFile = path.join(dir, "format.json");
  if (!fs.existsSync(specFile)) throw new Error(`No format.json in ${dir}`);
  const slug = path.basename(dir);

  const spec = JSON.parse(fs.readFileSync(specFile, "utf8")) as FormatSpec;
  validateSpec(spec, slug);

  const metaFile = path.join(dir, "meta.yml");
  const meta: FormatMeta = fs.existsSync(metaFile)
    ? (YAML.parse(fs.readFileSync(metaFile, "utf8")) as FormatMeta)
    : { name: slug, family: "unknown", hypothesis: "", useWhen: "" };

  const dataFile = path.join(dir, "data.yml");
  const data: Measurement = fs.existsSync(dataFile)
    ? { ...UNTESTED, ...(YAML.parse(fs.readFileSync(dataFile, "utf8")) as Measurement) }
    : { ...UNTESTED };

  /* An empty sample set is untested, whatever the file claims. */
  if (!data.n || data.n <= 0) {
    data.n = 0;
    data.status = data.status === "deprecated" ? "deprecated" : "untested";
  }

  return { slug, dir, spec, meta, data, variantId: variantId(slug, spec), specHash: specHash(spec) };
}

export function loadAllFormats(): LoadedFormat[] {
  return listFormatSlugs().map(loadFormat);
}

/* ------------------------------------------------------------- validation */

const ELEMENT_TYPES = new Set([
  "text",
  "counter",
  "bar",
  "iconGrid",
  "list",
  "split",
  "card",
  "image",
]);

export function validateSpec(spec: FormatSpec, slug?: string): void {
  const fail = (msg: string): never => {
    throw new Error(`Invalid format${slug ? ` "${slug}"` : ""}: ${msg}`);
  };

  if (!spec.id) fail("missing id");
  if (slug && spec.id !== slug) fail(`id "${spec.id}" does not match directory "${slug}"`);
  if (!spec.version) fail("missing version");
  if (!spec.canvas) fail("missing canvas");

  const c = { ...DEFAULT_CANVAS, ...spec.canvas };
  if (!(c.w > 0 && c.h > 0)) fail("canvas.w and canvas.h must be > 0");
  if (c.h <= c.w) fail(`canvas must be vertical (got ${c.w}x${c.h})`);
  if (!(c.fps > 0)) fail("canvas.fps must be > 0");
  if (!(c.durationSec > 0)) fail("canvas.durationSec must be > 0");
  if (Math.abs(c.durationSec * c.fps - Math.round(c.durationSec * c.fps)) > 1e-6) {
    fail(`durationSec x fps must be a whole number of frames (got ${c.durationSec * c.fps})`);
  }

  const safe = { ...DEFAULT_SAFE, ...(spec.safe ?? {}) };
  if (safe.top + safe.bottom >= c.h) fail("safe.top + safe.bottom exceeds the canvas height");

  if (!Array.isArray(spec.scene) || spec.scene.length === 0) fail("scene must be a non-empty array");

  const ids = new Set<string>();
  spec.scene.forEach((el: Element, i) => {
    if (!el.id) fail(`scene[${i}] missing id`);
    if (ids.has(el.id)) fail(`duplicate element id "${el.id}"`);
    ids.add(el.id);
    if (!ELEMENT_TYPES.has(el.type)) fail(`scene[${i}] unknown type "${el.type}"`);
    if (!el.box || typeof el.box.y !== "number") fail(`scene[${i}] (${el.id}) missing box.y`);
    if (el.at !== undefined && el.at < 0) fail(`${el.id}: at must be >= 0`);
    if (el.until !== undefined && el.at !== undefined && el.until <= el.at) {
      fail(`${el.id}: until must be > at`);
    }
    if (el.until !== undefined && el.until > c.durationSec + 1e-6) {
      fail(`${el.id}: until (${el.until}) is past the end of the clip (${c.durationSec}s)`);
    }
    for (const track of el.tracks ?? []) {
      for (let k = 1; k < track.keys.length; k++) {
        if (track.keys[k][0] < track.keys[k - 1][0]) {
          fail(`${el.id}: track "${track.prop}" keys must ascend in time`);
        }
      }
    }
    if (el.type === "counter") {
      const cc = el as { from?: number; to?: number };
      if (typeof cc.from !== "number" || typeof cc.to !== "number") {
        fail(`${el.id}: counter needs numeric from and to`);
      }
    }
    if (el.type === "list") {
      const ll = el as { rows?: unknown[] };
      if (!Array.isArray(ll.rows) || ll.rows.length === 0) fail(`${el.id}: list needs rows`);
    }
    if (el.type === "iconGrid") {
      const g = el as { count?: number };
      const count = g.count ?? 0;
      if (count < 1) fail(`${el.id}: iconGrid needs count >= 1`);
      if (count > 200) fail(`${el.id}: iconGrid count is capped at 200`);
    }
  });
}

/* -------------------------------------------------------------- data.yml */

export function writeMeasurement(dir: string, data: Measurement): void {
  const ordered: Measurement = {
    n: data.n,
    status: data.status,
    platforms: data.platforms,
    hook3s: data.hook3s ?? null,
    avgViewedPct: data.avgViewedPct ?? null,
    viewsPerHour: data.viewsPerHour ?? null,
    vsBaselinePct: data.vsBaselinePct ?? null,
    retention: data.retention ?? [],
    notes: data.notes,
    updated: data.updated,
    samples: data.samples,
  };
  const header =
    "# Measured evidence for this format. Written by `kw measure apply`.\n" +
    "# n is the number of published videos behind these numbers. n: 0 means untested —\n" +
    "# that is a valid, honest state. Do not fill these in by hand from memory.\n";
  fs.writeFileSync(path.join(dir, "data.yml"), header + YAML.stringify(ordered), "utf8");
}
