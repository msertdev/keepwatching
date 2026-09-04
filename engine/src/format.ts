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

/**
 * Sentinel `variant_id` for a published video whose format is not in this
 * library and is not going to be.
 *
 * Such a row is a valid content-axis sample and an invalid format sample: there
 * is no spec here to attribute it to, so it can never appear on the format
 * board, in a format's `data.yml`, or in the gallery ranking. It counts only
 * toward content-axis results, where the `carried by` column names it
 * explicitly so a reader can see that part of an axis came from outside the
 * library.
 *
 * The label carries no information about the format itself, by design.
 */
export const NOT_IN_LIBRARY = "not-in-library";

export const isNotInLibrary = (variantId: string): boolean =>
  variantId.trim() === NOT_IN_LIBRARY;

/* --------------------------------------- repo-level content-axis results */

/** Where a number came from. Rendered distinctly everywhere it is shown. */
export type EvidenceSource = "csv" | "manual";

/**
 * One measurement of one published video at one moment.
 *
 * Deliberately not deduplicated: the same video measured twice at different
 * times is two observations, both kept with their own `measuredAt`. A view
 * count that grew between readings is not a conflict to resolve by picking a
 * winner — it is two true readings of a moving number.
 *
 * Every numeric field is nullable and stays null when the export did not
 * contain it. Nothing here is interpolated, extrapolated or approximated.
 */
export interface Observation {
  platform: string;
  externalId: string;
  /** `not-in-library` when the format is deliberately outside this repo. */
  variantId: string;
  title?: string;
  publishedAt?: string | null;
  /** When this reading was taken. */
  measuredAt: string;
  /** Last day the underlying daily series covers. Null for a point reading. */
  dataThrough?: string | null;
  /** Per platform. Two cuts of the same story are two different videos. */
  durationSec?: number | null;

  views?: number | null;
  watchTimeHours?: number | null;
  avgWatchSec?: number | null;
  avgPctViewed?: number | null;
  subscribers?: number | null;

  likes?: number | null;
  comments?: number | null;
  shares?: number | null;

  /** Filled only when the daily series actually covers the window. */
  viewsAt24h?: number | null;
  viewsAt48h?: number | null;
  viewsAt7d?: number | null;

  source: EvidenceSource;
  /** Why a field is null, and any conflict this reading is part of. */
  notes?: string[];
}

/** Per-platform summary. Never combined across platforms — see the report. */
export interface PlatformSummary {
  platform: string;
  videos: number;
  observations: number;
  views: number | null;
  avgPctViewed: number | null;
  sources: EvidenceSource[];
}

export interface AxisRollup {
  axis: string;
  name?: string;
  /** Distinct published videos on this axis. */
  n: number;
  /** Distinct readings, which can exceed `n`. */
  observations?: number;
  hook3s?: number | null;
  /**
   * Only meaningful when a single platform carries the axis. Null whenever the
   * axis spans platforms, because two platforms' percentages describe two
   * different videos and averaging them would invent a number.
   */
  avgViewedPct?: number | null;
  viewsPerHour?: number | null;
  vsAxisBaselinePct?: number | null;
  retention?: RetentionPoint[];
  /** Format slugs, plus the literal `not-in-library` when applicable. */
  carriedBy: string[];
  byPlatform?: PlatformSummary[];
  rows?: Observation[];
  notes?: string[];
}

/** A disagreement between two sources, recorded rather than resolved. */
export interface Conflict {
  subject: string;
  field: string;
  readings: Array<{ value: string; source: EvidenceSource; measuredAt?: string; from: string }>;
  resolution: string;
}

export interface ContentAxisResults {
  updated?: string;
  /** Computed within one platform only; `source` says which. */
  baseline: { avgViewedPct: number | null; source: string };
  axes: AxisRollup[];
  conflicts?: Conflict[];
  /** Fields left null across the dataset, each with the reason. */
  nulls?: Array<{ field: string; reason: string }>;
}

export const AXIS_RESULTS_FILE = path.join(ROOT, "data", "content-axis-results.yml");

export const EMPTY_AXIS_RESULTS: ContentAxisResults = {
  baseline: { avgViewedPct: null, source: "not enough data" },
  axes: [],
};

/**
 * Repo-level axis results. Kept in its own file rather than pooled from the
 * format library, because an axis can legitimately be carried entirely by
 * videos whose format is not in the library — pooling from `formats/` would
 * silently drop exactly those samples.
 */
export function loadAxisResults(): ContentAxisResults {
  if (!fs.existsSync(AXIS_RESULTS_FILE)) return { ...EMPTY_AXIS_RESULTS, axes: [] };
  const parsed = YAML.parse(fs.readFileSync(AXIS_RESULTS_FILE, "utf8")) as ContentAxisResults;
  return {
    updated: parsed?.updated,
    baseline: parsed?.baseline ?? { avgViewedPct: null, source: "not enough data" },
    axes: Array.isArray(parsed?.axes) ? parsed.axes : [],
  };
}

export function writeAxisResults(results: ContentAxisResults): void {
  /* Video titles are dropped on the way out.
     A published title describes the video's premise, and for samples tagged
     `not-in-library` that premise is the withheld format's mechanic — publishing
     it would hand over by accident exactly what the label exists to keep back.
     The platform id stays, which is what makes a row auditable; the title was
     only ever convenience. The local report keeps them, and it is gitignored. */
  const stripped: ContentAxisResults = {
    ...results,
    axes: results.axes.map((a) => ({
      ...a,
      rows: a.rows?.map(({ title, ...rest }) => rest),
    })),
  };
  results = stripped;

  const header =
    "# Repo-level content-axis results. Written by `kw measure apply` — never by hand.\n" +
    "#\n" +
    "# These are claims about SUBJECT MATTER, not about scene structure. They have\n" +
    "# their own baseline and are never averaged with any number in formats/*/data.yml.\n" +
    "#\n" +
    "# `carriedBy` lists which formats produced each axis result. An axis carried by a\n" +
    "# single entry is not isolated from that entry — it is the same videos under a\n" +
    "# second label. The entry `not-in-library` means those samples came from a format\n" +
    "# that is not part of this library; they count here and nowhere else.\n";
  fs.writeFileSync(AXIS_RESULTS_FILE, header + YAML.stringify(results), "utf8");
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

export interface ValidateOptions {
  /**
   * Every format in the library must be vertical. Relaxed only for the social
   * preview card, which uses the same engine but is not a format.
   */
  requireVertical?: boolean;
}

export function validateSpec(
  spec: FormatSpec,
  slug?: string,
  opts: ValidateOptions = {}
): void {
  const fail = (msg: string): never => {
    throw new Error(`Invalid format${slug ? ` "${slug}"` : ""}: ${msg}`);
  };

  if (!spec.id) fail("missing id");
  if (spec.id === NOT_IN_LIBRARY) {
    fail(`"${NOT_IN_LIBRARY}" is a reserved label and cannot be a format id`);
  }
  if (slug && spec.id !== slug) fail(`id "${spec.id}" does not match directory "${slug}"`);
  if (!spec.version) fail("missing version");
  if (!spec.canvas) fail("missing canvas");

  const c = { ...DEFAULT_CANVAS, ...spec.canvas };
  if (!(c.w > 0 && c.h > 0)) fail("canvas.w and canvas.h must be > 0");
  if (opts.requireVertical !== false && c.h <= c.w) {
    fail(`canvas must be vertical (got ${c.w}x${c.h})`);
  }
  if (!(c.fps > 0)) fail("canvas.fps must be > 0");
  if (!(c.durationSec > 0)) fail("canvas.durationSec must be > 0");
  if (Math.abs(c.durationSec * c.fps - Math.round(c.durationSec * c.fps)) > 1e-6) {
    fail(`durationSec x fps must be a whole number of frames (got ${c.durationSec * c.fps})`);
  }

  if (spec.posterSec !== undefined) {
    if (spec.posterSec < 0 || spec.posterSec >= c.durationSec) {
      fail(`posterSec (${spec.posterSec}) must be inside the clip (0 to ${c.durationSec})`);
    }
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

/**
 * A sourced number must never share the screen with a certainty it has not
 * earned yet.
 *
 * A counter animating to 299,792,458 shows a wrong number for six seconds. If
 * "metres per second — exactly" and a BIPM citation sit under it the whole
 * time, then anyone who pauses, screenshots, or simply looks early sees a
 * sourced, precision-marked claim that is false. The citation makes it worse,
 * not better: it lends authority to the wrong figure.
 *
 * So in a `sourced` format, every element on screen while a `claim: "final"`
 * counter is still counting must declare `neutralWhileCounting`. The default is
 * the unsafe case failing, because the author who adds a unit label is the one
 * who has to think about when it becomes true.
 *
 * Counters marked `claim: "running"` are exempt by construction: "390 frames so
 * far" is true at every frame, so its unit can sit beside it throughout.
 */
export function validateClaims(spec: FormatSpec, meta: FormatMeta, slug: string): string[] {
  const problems: string[] = [];
  const duration = spec.canvas.durationSec;

  const counters = spec.scene.filter((el): el is Element & { type: "counter" } =>
    el.type === "counter"
  ) as Array<Element & Record<string, unknown>>;

  if (meta.sampleContent !== "sourced") return problems;

  for (const counter of counters) {
    const claim = counter.claim as string | undefined;
    if (!claim) {
      problems.push(
        `${slug}: counter "${counter.id}" must declare claim: "final" | "running" ` +
          `because this format's sample content is sourced`
      );
      continue;
    }
    if (claim === "running") continue;

    /* The moment the number becomes the sourced fact. */
    const settle =
      (counter.endSec as number | undefined) ??
      (counter.until as number | undefined) ??
      duration;

    for (const el of spec.scene) {
      if (el.id === counter.id) continue;
      if (el.neutralWhileCounting) continue;

      const at = el.at ?? 0;
      const until = el.until ?? duration;
      /* Only elements actually on screen before the number lands. */
      const overlaps = at < settle - 1e-6 && until > 0;
      if (!overlaps) continue;

      problems.push(
        `${slug}: "${el.id}" is on screen from ${at}s while the sourced counter ` +
          `"${counter.id}" is still counting (settles at ${settle}s). Either move it to ` +
          `at >= ${settle}, or mark it neutralWhileCounting: true if its wording stays ` +
          `true while the number is wrong.`
      );
    }
  }

  return problems;
}

/** Cross-check that every axis referenced by a measurement is a declared axis. */
export function validateAxes(fmt: LoadedFormat, axes: ContentAxis[]): string[] {
  const known = new Set(axes.map((a) => a.id));
  const problems = fmt.data.contentAxis.axes
    .filter((a) => !known.has(a.axis))
    .map((a) => `${fmt.slug}: content_axis references unknown axis "${a.axis}"`);

  /* The sentinel marks samples with no spec in this repo. If one reached a
     format's data.yml, an out-of-library video would be contributing to a
     format result — the exact leak the label exists to prevent. */
  for (const a of fmt.data.contentAxis.axes) {
    for (const sample of a.samples ?? []) {
      if (isNotInLibrary(sample.variantId)) {
        problems.push(
          `${fmt.slug}: a "${NOT_IN_LIBRARY}" sample is recorded against a format — ` +
            `it must count toward content axes only`
        );
      }
    }
  }
  for (const sample of fmt.data.format.samples ?? []) {
    if (isNotInLibrary(sample.variantId)) {
      problems.push(
        `${fmt.slug}: a "${NOT_IN_LIBRARY}" sample is in the format block — ` +
          `it must never reach the format board`
      );
    }
  }
  return problems;
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
