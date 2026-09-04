/**
 * Format loading, validation and identity.
 *
 * A format directory holds three files with three different jobs:
 *   format.json — the render spec (machine-owned, deterministic)
 *   meta.yml    — the claim: name, family, explicit hypothesis, when to use it
 *   data.yml    — the evidence, in TWO separate blocks that never merge
 *
 * The two blocks in data.yml answer different questions:
 *
 *   format:       how does this SCENE STRUCTURE perform?
 *   content_axis: how does this SUBJECT MATTER perform, when carried by this
 *                 format?
 *
 * They are kept apart at the type level, in the report, in data.yml, and in the
 * gallery, because a single published video carries both labels and averaging
 * them produces a number that answers neither question. Only the `format` block
 * ever orders the library.
 *
 * Nothing here fabricates evidence. A format with no measurements loads with
 * status "untested" and n = 0, and stays visible everywhere it is listed.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";

import { FORMATS_DIR, ROOT } from "./paths.js";
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

/** Where the example copy in `format.json`'s `data` block came from. */
export type SampleContent = "sourced" | "placeholder";

export interface Source {
  title: string;
  url: string;
  /** The specific claim this source backs. */
  claim: string;
}

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
  /**
   * Every format must declare this. `sourced` means the example numbers are
   * real and `sources` lists where each came from; `placeholder` means the
   * example copy is obvious filler that nobody could mistake for a fact.
   * There is no third option — see validateMeta().
   */
  sampleContent?: SampleContent;
  sources?: Source[];
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

export interface SampleRef {
  platform: string;
  externalId: string;
  variantId: string;
  publishedAt?: string;
}

/** How a scene structure performed. This block, and only this block, ranks the library. */
export interface FormatMeasurement {
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
  /** Percentage points against the mean of all measured FORMATS. */
  vsBaselinePct?: number | null;
  retention?: RetentionPoint[];
  /** Free-text caveats. Read before believing any of the above. */
  notes?: string;
  updated?: string;
  samples?: SampleRef[];
}

/** How one content axis performed, among videos published with this format. */
export interface AxisResult {
  /** Must match an `id` in data/content-axes.yml. */
  axis: string;
  n: number;
  hook3s?: number | null;
  avgViewedPct?: number | null;
  viewsPerHour?: number | null;
  /** Percentage points against the mean of all measured AXES. Never against formats. */
  vsAxisBaselinePct?: number | null;
  retention?: RetentionPoint[];
  samples?: SampleRef[];
}

/**
 * How the subject matter performed. Deliberately a sibling of FormatMeasurement
 * rather than a field inside it: there is no code path that can add an axis
 * number into a format average, because they are different types in different
 * places.
 */
export interface ContentAxisMeasurement {
  n: number;
  status: "untested" | "measured";
  axes: AxisResult[];
  notes?: string;
  updated?: string;
}

export interface Evidence {
  format: FormatMeasurement;
  contentAxis: ContentAxisMeasurement;
}

export interface LoadedFormat {
  slug: string;
  dir: string;
  spec: FormatSpec;
  meta: FormatMeta;
  data: Evidence;
  /** Stable identity for this exact spec — see variantId(). */
  variantId: string;
  specHash: string;
}

/* ------------------------------------------------------------ content axes */

export interface ContentAxis {
  id: string;
  name: string;
  description?: string;
  pole?: string;
}

export const AXES_FILE = path.join(ROOT, "data", "content-axes.yml");

export function loadContentAxes(): ContentAxis[] {
  if (!fs.existsSync(AXES_FILE)) return [];
  const parsed = YAML.parse(fs.readFileSync(AXES_FILE, "utf8")) as { axes?: ContentAxis[] };
  return parsed?.axes ?? [];
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

export const UNTESTED_FORMAT: FormatMeasurement = {
  n: 0,
  status: "untested",
  platforms: [],
  hook3s: null,
  avgViewedPct: null,
  viewsPerHour: null,
  vsBaselinePct: null,
  retention: [],
};

export const UNTESTED_AXIS: ContentAxisMeasurement = {
  n: 0,
  status: "untested",
  axes: [],
};

export function listFormatSlugs(): string[] {
  if (!fs.existsSync(FORMATS_DIR)) return [];
  return fs
    .readdirSync(FORMATS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(FORMATS_DIR, d.name, "format.json")))
    .map((d) => d.name)
    .sort();
}

/** Read data.yml into the two-block shape, tolerating the older flat layout. */
export function readEvidence(dir: string): Evidence {
  const file = path.join(dir, "data.yml");
  if (!fs.existsSync(file)) {
    return { format: { ...UNTESTED_FORMAT }, contentAxis: { ...UNTESTED_AXIS, axes: [] } };
  }

  const raw = (YAML.parse(fs.readFileSync(file, "utf8")) ?? {}) as Record<string, unknown>;

  /* A pre-schema data.yml has n/status at the top level. Read it as the format
     block so an old checkout keeps its measurements instead of losing them. */
  const formatRaw = (raw.format ?? (("n" in raw) ? raw : {})) as Partial<FormatMeasurement>;
  const axisRaw = (raw.content_axis ?? raw.contentAxis ?? {}) as Partial<ContentAxisMeasurement>;

  const format: FormatMeasurement = { ...UNTESTED_FORMAT, ...formatRaw };
  const contentAxis: ContentAxisMeasurement = {
    ...UNTESTED_AXIS,
    ...axisRaw,
    axes: Array.isArray(axisRaw.axes) ? axisRaw.axes : [],
  };

  /* An empty sample set is untested, whatever the file claims. Applied to each
     block independently — a format can be untested while its axis is measured,
     and that is a normal, honest state. */
  if (!format.n || format.n <= 0) {
    format.n = 0;
    format.status = format.status === "deprecated" ? "deprecated" : "untested";
  }
  const axisTotal = contentAxis.axes.reduce((s, a) => s + (a.n ?? 0), 0);
  contentAxis.n = axisTotal;
  contentAxis.status = axisTotal > 0 ? "measured" : "untested";

  return { format, contentAxis };
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

  return {
    slug,
    dir,
    spec,
    meta,
    data: readEvidence(dir),
    variantId: variantId(slug, spec),
    specHash: specHash(spec),
  };
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

/**
 * Every format must say where its example numbers came from.
 *
 * This is the rule that keeps a library about honest measurement from shipping
 * invented facts in its own demo copy. Either the sample content is `sourced`
 * and every source carries a URL and the claim it backs, or it is `placeholder`
 * and reads as obvious filler. Silence is not allowed, because silence is what
 * an invented number looks like.
 */
export function validateMeta(meta: FormatMeta, slug: string): string[] {
  const problems: string[] = [];

  if (!meta.sampleContent) {
    problems.push(
      `${slug}: meta.yml must declare sampleContent: sourced | placeholder ` +
        `(say where the example numbers came from)`
    );
  } else if (meta.sampleContent === "sourced") {
    if (!meta.sources?.length) {
      problems.push(`${slug}: sampleContent is "sourced" but no sources are listed`);
    } else {
      meta.sources.forEach((s, i) => {
        if (!s.url || !/^https?:\/\//.test(s.url)) {
          problems.push(`${slug}: sources[${i}] needs a http(s) url`);
        }
        if (!s.claim) problems.push(`${slug}: sources[${i}] needs a claim it backs`);
      });
    }
  } else if (meta.sampleContent === "placeholder" && meta.sources?.length) {
    problems.push(`${slug}: sampleContent is "placeholder" but sources are listed — pick one`);
  }

  return problems;
}

/** Cross-check that every axis referenced by a measurement is a declared axis. */
export function validateAxes(fmt: LoadedFormat, axes: ContentAxis[]): string[] {
  const known = new Set(axes.map((a) => a.id));
  return fmt.data.contentAxis.axes
    .filter((a) => !known.has(a.axis))
    .map((a) => `${fmt.slug}: content_axis references unknown axis "${a.axis}"`);
}

/* -------------------------------------------------------------- data.yml */

const HEADER =
  "# Evidence for this format. Written by `kw measure apply` — never by hand.\n" +
  "#\n" +
  "# Two blocks, deliberately separate:\n" +
  "#   format:       how this SCENE STRUCTURE performed. Only this block ranks the library.\n" +
  "#   content_axis: how the SUBJECT MATTER performed, carried by this format.\n" +
  "#\n" +
  "# They are never averaged together. One published video carries both labels, so\n" +
  "# combining them would produce a number that answers neither question.\n" +
  "# n: 0 means untested. That is a valid, honest state — do not fill it in.\n";

export function writeEvidence(dir: string, evidence: Evidence): void {
  const format: FormatMeasurement = {
    n: evidence.format.n,
    status: evidence.format.status,
    platforms: evidence.format.platforms ?? [],
    hook3s: evidence.format.hook3s ?? null,
    avgViewedPct: evidence.format.avgViewedPct ?? null,
    viewsPerHour: evidence.format.viewsPerHour ?? null,
    vsBaselinePct: evidence.format.vsBaselinePct ?? null,
    retention: evidence.format.retention ?? [],
    notes: evidence.format.notes,
    updated: evidence.format.updated,
    samples: evidence.format.samples ?? [],
  };

  const contentAxis: ContentAxisMeasurement = {
    n: evidence.contentAxis.axes.reduce((s, a) => s + (a.n ?? 0), 0),
    status: evidence.contentAxis.axes.length ? "measured" : "untested",
    axes: evidence.contentAxis.axes,
    notes: evidence.contentAxis.notes,
    updated: evidence.contentAxis.updated,
  };

  const body = YAML.stringify({ format, content_axis: contentAxis });
  fs.writeFileSync(path.join(dir, "data.yml"), HEADER + body, "utf8");
}
