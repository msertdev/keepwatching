/**
 * Report: normalised samples + variant mapping -> "which format won", and,
 * separately, "which content axis won".
 *
 * The join is the whole point. A published video means nothing on its own; it
 * means something once it is attached to the exact variant id that produced it.
 * Videos with no mapping row are reported as unmatched, never quietly averaged in.
 *
 * The two leaderboards are computed independently and compared against their own
 * baselines. A format number is never mixed with an axis number, because one
 * video contributes a row to both and averaging them would answer neither
 * question. See engine/src/format.ts for the same separation at the type level.
 */
import fs from "node:fs";
import path from "node:path";

import { MEASURE_DIR, rel } from "../../engine/src/paths.js";
import {
  NOT_IN_LIBRARY,
  isNotInLibrary,
  loadAllFormats,
  loadContentAxes,
  parseVariantId,
  readEvidence,
  writeAxisResults,
  writeEvidence,
  type AxisResult,
  type AxisRollup,
  type ContentAxis,
  type FormatMeasurement,
  type SampleRef,
} from "../../engine/src/format.js";
import { parseCsv, pick, mean, median } from "./csv.js";
import { SAMPLES_FILE, type Sample } from "./ingest.js";

export const MAPPING_FILE = path.join(MEASURE_DIR, "mapping.csv");
export const REPORT_JSON = path.join(MEASURE_DIR, "report.json");
export const REPORT_MD = path.join(MEASURE_DIR, "report.md");

export interface MappingRow {
  platform: string;
  externalId: string;
  variantId: string;
  publishedAt?: string;
  /** Optional. Must match an id in data/content-axes.yml when present. */
  contentAxis?: string;
}

interface Joined {
  sample: Sample;
  mapping: MappingRow;
}

export interface FormatResult {
  slug: string;
  name: string;
  n: number;
  platforms: string[];
  hook3s: number | null;
  avgViewedPct: number | null;
  viewsPerHour: number | null;
  retention: Array<{ t: number; p: number }>;
  samples: SampleRef[];
}

export interface AxisReportRow {
  axis: string;
  name: string;
  n: number;
  hook3s: number | null;
  avgViewedPct: number | null;
  viewsPerHour: number | null;
  retention: Array<{ t: number; p: number }>;
  /** Which formats carried this axis, so a reader can see the confound. */
  formats: string[];
  samples: SampleRef[];
}

export interface Report {
  generatedAt: string;
  /** Samples whose format is deliberately outside this library. Axis-only. */
  notInLibrary: { n: number; axes: string[] };
  formats: {
    baseline: { avgViewedPct: number | null; source: string };
    results: FormatResult[];
  };
  contentAxes: {
    baseline: { avgViewedPct: number | null; source: string };
    results: AxisReportRow[];
    /** Per format, per axis — what `kw measure apply` writes into data.yml. */
    byFormat: Record<string, AxisResult[]>;
  };
  unmatched: Array<{ platform: string; externalId: string; title?: string }>;
  unmappedVariants: string[];
  unknownAxes: string[];
}

export function readMapping(): MappingRow[] {
  if (!fs.existsSync(MAPPING_FILE)) return [];
  return parseCsv(fs.readFileSync(MAPPING_FILE, "utf8"))
    .map((row) => ({
      platform: (pick(row, "platform") ?? "").toLowerCase(),
      externalId: pick(row, "external_id", "externalid", "video id", "id") ?? "",
      variantId: pick(row, "variant_id", "variantid", "variant") ?? "",
      publishedAt: pick(row, "published_at", "publishedat", "date"),
      contentAxis: pick(row, "content_axis", "contentaxis", "axis"),
    }))
    .filter((r) => r.externalId && r.variantId);
}

/* ------------------------------------------------------------- statistics */

/** Resample a set of curves onto a shared 0.5 s grid and average them. */
function averageCurves(curves: Array<Array<{ t: number; p: number }>>, durationSec: number) {
  const usable = curves.filter((c) => c.length > 1);
  if (usable.length === 0) return [];
  const step = 0.5;
  const out: Array<{ t: number; p: number }> = [];
  for (let t = 0; t <= durationSec + 1e-6; t += step) {
    const values: number[] = [];
    for (const c of usable) {
      if (t < c[0].t || t > c[c.length - 1].t) continue;
      for (let i = 0; i < c.length - 1; i++) {
        if (t >= c[i].t && t <= c[i + 1].t) {
          const u = c[i + 1].t === c[i].t ? 0 : (t - c[i].t) / (c[i + 1].t - c[i].t);
          values.push(c[i].p + (c[i + 1].p - c[i].p) * u);
          break;
        }
      }
    }
    const m = mean(values);
    if (m !== null) out.push({ t: Number(t.toFixed(2)), p: Number(m.toFixed(4)) });
  }
  return out;
}

function hoursSince(iso: string | undefined): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const h = (Date.now() - d.getTime()) / 3.6e6;
  return h > 0 ? h : null;
}

const round = (v: number | null, places = 4): number | null =>
  v === null ? null : Number(v.toFixed(places));

/** Everything a leaderboard row needs, computed the same way for both boards. */
function aggregate(rows: Joined[], durationSec: number) {
  return {
    n: rows.length,
    hook3s: round(mean(rows.map((r) => r.sample.hook3s ?? NaN).filter(Number.isFinite))),
    avgViewedPct: round(mean(rows.map((r) => r.sample.avgViewedPct ?? NaN).filter(Number.isFinite))),
    viewsPerHour: round(
      median(
        rows
          .map((r) => {
            const h = hoursSince(r.mapping.publishedAt ?? r.sample.publishedAt);
            return h && r.sample.views ? r.sample.views / Math.min(h, 24) : NaN;
          })
          .filter(Number.isFinite)
      ),
      1
    ),
    retention: averageCurves(
      rows.map((r) => r.sample.retention ?? []),
      durationSec
    ),
    samples: rows.map((r) => ({
      platform: r.sample.platform,
      externalId: r.sample.externalId,
      variantId: r.mapping.variantId,
      publishedAt: r.mapping.publishedAt ?? r.sample.publishedAt,
    })),
  };
}

/* ------------------------------------------------------------------ build */

export function buildReport(): Report {
  const samples: Sample[] = fs.existsSync(SAMPLES_FILE)
    ? JSON.parse(fs.readFileSync(SAMPLES_FILE, "utf8"))
    : [];
  const mapping = readMapping();
  const formats = loadAllFormats();
  const axes = loadContentAxes();
  const axisById = new Map(axes.map((a) => [a.id, a]));

  const byExternal = new Map(mapping.map((m) => [m.externalId, m]));
  const bySlug = new Map<string, { fmt: (typeof formats)[number]; rows: Joined[] }>();
  for (const f of formats) bySlug.set(f.slug, { fmt: f, rows: [] });

  const unmatched: Report["unmatched"] = [];
  const unmappedVariants = new Set<string>();
  const unknownAxes = new Set<string>();
  /* Videos whose format is deliberately outside this library. They are real
     content-axis samples and are not format samples at all, so they are held
     apart from `bySlug` and never reach the format board. */
  const outsideRows: Joined[] = [];

  for (const sample of samples) {
    const m = byExternal.get(sample.externalId);
    if (!m) {
      unmatched.push({ platform: sample.platform, externalId: sample.externalId, title: sample.title });
      continue;
    }
    if (m.contentAxis && !axisById.has(m.contentAxis)) unknownAxes.add(m.contentAxis);

    if (isNotInLibrary(m.variantId)) {
      outsideRows.push({ sample, mapping: m });
      continue;
    }

    const parsed = parseVariantId(m.variantId);
    if (!parsed || !bySlug.has(parsed.slug)) {
      unmappedVariants.add(m.variantId);
      continue;
    }
    bySlug.get(parsed.slug)!.rows.push({ sample, mapping: m });
  }

  /* --- leaderboard 1: formats --- */
  const formatResults: FormatResult[] = [];
  for (const [slug, { fmt, rows }] of bySlug) {
    if (rows.length === 0) continue;
    const agg = aggregate(rows, fmt.spec.canvas.durationSec);
    formatResults.push({
      slug,
      name: fmt.meta.name || slug,
      platforms: [...new Set(rows.map((r) => r.sample.platform))].sort(),
      ...agg,
    });
  }
  formatResults.sort((a, b) => (b.avgViewedPct ?? -1) - (a.avgViewedPct ?? -1));

  /* --- leaderboard 2: content axes, computed from the same joined rows but
         never mixed with the numbers above --- */
  const axisRows = new Map<string, Joined[]>();
  const axisFormats = new Map<string, Set<string>>();
  const byFormatAxis = new Map<string, Map<string, Joined[]>>();

  for (const [slug, { rows }] of bySlug) {
    for (const row of rows) {
      const axis = row.mapping.contentAxis;
      if (!axis || !axisById.has(axis)) continue;
      if (!axisRows.has(axis)) axisRows.set(axis, []);
      axisRows.get(axis)!.push(row);
      if (!axisFormats.has(axis)) axisFormats.set(axis, new Set());
      axisFormats.get(axis)!.add(slug);
      if (!byFormatAxis.has(slug)) byFormatAxis.set(slug, new Map());
      const inner = byFormatAxis.get(slug)!;
      if (!inner.has(axis)) inner.set(axis, []);
      inner.get(axis)!.push(row);
    }
  }

  /* Out-of-library rows join the axis board here and nowhere else. They are
     tagged into `axisFormats` under the sentinel so the "carried by" column
     shows plainly that part of the axis came from outside the library. */
  const outsideAxes = new Set<string>();
  for (const row of outsideRows) {
    const axis = row.mapping.contentAxis;
    if (!axis || !axisById.has(axis)) continue;
    if (!axisRows.has(axis)) axisRows.set(axis, []);
    axisRows.get(axis)!.push(row);
    if (!axisFormats.has(axis)) axisFormats.set(axis, new Set());
    axisFormats.get(axis)!.add(NOT_IN_LIBRARY);
    outsideAxes.add(axis);
  }

  const axisResults: AxisReportRow[] = [];
  for (const [axis, rows] of axisRows) {
    /* Axis curves span clips of different lengths; resample against the longest
       so a short clip does not truncate the average. An out-of-library row has
       no spec here, so its own reported duration is used when it has one. */
    const longest = Math.max(
      ...rows.map((r) => {
        if (isNotInLibrary(r.mapping.variantId)) return r.sample.videoDurationSec ?? 0;
        const p = parseVariantId(r.mapping.variantId);
        return p ? bySlug.get(p.slug)?.fmt.spec.canvas.durationSec ?? 0 : 0;
      }),
      1
    );
    axisResults.push({
      axis,
      name: axisById.get(axis)?.name ?? axis,
      formats: [...(axisFormats.get(axis) ?? [])].sort(),
      ...aggregate(rows, longest),
    });
  }
  axisResults.sort((a, b) => (b.avgViewedPct ?? -1) - (a.avgViewedPct ?? -1));

  /* Each board gets its own baseline. Crossing them would be the exact mistake
     this whole separation exists to prevent. */
  const formatBaseline =
    formatResults.length > 1
      ? round(mean(formatResults.map((r) => r.avgViewedPct ?? NaN).filter(Number.isFinite)))
      : null;
  const axisBaseline =
    axisResults.length > 1
      ? round(mean(axisResults.map((r) => r.avgViewedPct ?? NaN).filter(Number.isFinite)))
      : null;

  const byFormat: Record<string, AxisResult[]> = {};
  for (const [slug, inner] of byFormatAxis) {
    byFormat[slug] = [...inner]
      .map(([axis, rows]) => {
        const durationSec = bySlug.get(slug)!.fmt.spec.canvas.durationSec;
        const agg = aggregate(rows, durationSec);
        return {
          axis,
          n: agg.n,
          hook3s: agg.hook3s,
          avgViewedPct: agg.avgViewedPct,
          viewsPerHour: agg.viewsPerHour,
          vsAxisBaselinePct:
            axisBaseline !== null && agg.avgViewedPct !== null
              ? Number(((agg.avgViewedPct - axisBaseline) * 100).toFixed(2))
              : null,
          retention: agg.retention,
          samples: agg.samples,
        };
      })
      .sort((a, b) => (b.avgViewedPct ?? -1) - (a.avgViewedPct ?? -1));
  }

  const report: Report = {
    generatedAt: new Date().toISOString(),
    notInLibrary: { n: outsideRows.length, axes: [...outsideAxes].sort() },
    formats: {
      baseline: {
        avgViewedPct: formatBaseline,
        source:
          formatResults.length > 1
            ? `mean of ${formatResults.length} measured formats`
            : "not enough data",
      },
      results: formatResults,
    },
    contentAxes: {
      baseline: {
        avgViewedPct: axisBaseline,
        source:
          axisResults.length > 1 ? `mean of ${axisResults.length} measured axes` : "not enough data",
      },
      results: axisResults,
      byFormat,
    },
    unmatched,
    unmappedVariants: [...unmappedVariants].sort(),
    unknownAxes: [...unknownAxes].sort(),
  };

  fs.mkdirSync(MEASURE_DIR, { recursive: true });
  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2) + "\n", "utf8");
  fs.writeFileSync(REPORT_MD, renderMarkdown(report, axes), "utf8");

  console.log(`\n▸ report`);
  console.log(`  ${samples.length} samples, ${mapping.length} mapping rows`);
  console.log(`  formats:      ${formatResults.length} with at least one measurement`);
  console.log(`  content axes: ${axisResults.length} with at least one measurement`);
  if (outsideRows.length) {
    console.log(
      `  ${outsideRows.length} sample(s) tagged ${NOT_IN_LIBRARY} — content axis only, ` +
        `excluded from the format board`
    );
  }
  if (unmatched.length) console.log(`  ${unmatched.length} published videos have no mapping row`);
  if (report.unmappedVariants.length) {
    console.log(`  ${report.unmappedVariants.length} mapped variant id(s) match no format here`);
  }
  if (report.unknownAxes.length) {
    console.log(`  ${report.unknownAxes.length} unknown content axis id(s) — add to data/content-axes.yml`);
  }
  console.log(`  -> ${rel(REPORT_MD)}\n`);

  return report;
}

/* --------------------------------------------------------------- markdown */

const pct = (v: number | null | undefined): string =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`;

const delta = (v: number | null, baseline: number | null): string =>
  baseline === null || v === null ? "—" : `${((v - baseline) * 100).toFixed(1)} pp`;

function renderMarkdown(r: Report, axes: ContentAxis[]): string {
  const lines: string[] = [];
  lines.push("# Measurement report\n");
  lines.push(`Generated ${r.generatedAt}. Regenerate with \`kw measure report\`.\n`);
  lines.push(
    "Two independent leaderboards. **A format number and an axis number are never " +
      "averaged together** — one published video contributes a row to both, so combining " +
      "them would produce a figure that answers neither question.\n"
  );

  /* --- formats --- */
  lines.push("## 1. Which format won\n");
  lines.push("_A claim about scene structure. This is the board that orders the library._\n");

  if (r.formats.results.length === 0) {
    lines.push("No format has a measurement yet.\n");
    lines.push("1. Render a format and note its `variantId` from `out/<slug>/variant.json`.");
    lines.push("2. Publish it, then add a row to `measure/mapping.csv`.");
    lines.push("3. Export analytics CSVs into `measure/inbox/` and run `kw measure`.\n");
  } else {
    lines.push(`Baseline: ${pct(r.formats.baseline.avgViewedPct)} (${r.formats.baseline.source}).\n`);
    lines.push("| # | Format | n | Avg % viewed | vs format baseline | Hook @3s | Views/hr |");
    lines.push("|---|--------|---|--------------|--------------------|----------|----------|");
    r.formats.results.forEach((res, i) => {
      lines.push(
        `| ${i + 1} | \`${res.slug}\` | ${res.n} | ${pct(res.avgViewedPct)} | ` +
          `${delta(res.avgViewedPct, r.formats.baseline.avgViewedPct)} | ` +
          `${pct(res.hook3s)} | ${res.viewsPerHour ?? "—"} |`
      );
    });
    lines.push("");
  }

  /* --- content axes --- */
  lines.push("## 2. Which content axis won\n");
  lines.push(
    "_A claim about subject matter, not about scene structure. Compared only against " +
      "other axes._\n"
  );

  if (r.contentAxes.results.length === 0) {
    lines.push("No content axis has a measurement yet.\n");
    lines.push(
      "Add a `content_axis` column to `measure/mapping.csv` naming an axis from " +
        "`data/content-axes.yml`, then re-run `kw measure`.\n"
    );
  } else {
    lines.push(
      `Baseline: ${pct(r.contentAxes.baseline.avgViewedPct)} (${r.contentAxes.baseline.source}).\n`
    );
    lines.push("| # | Content axis | n | Avg % viewed | vs axis baseline | Hook @3s | Carried by |");
    lines.push("|---|--------------|---|--------------|------------------|----------|------------|");
    r.contentAxes.results.forEach((res, i) => {
      const carriedBy =
        res.formats
          .map((f) => (f === NOT_IN_LIBRARY ? `**\`${f}\`**` : `\`${f}\``))
          .join(", ") || "—";
      lines.push(
        `| ${i + 1} | ${res.name} (\`${res.axis}\`) | ${res.n} | ${pct(res.avgViewedPct)} | ` +
          `${delta(res.avgViewedPct, r.contentAxes.baseline.avgViewedPct)} | ` +
          `${pct(res.hook3s)} | ${carriedBy} |`
      );
    });
    lines.push("");
    if (r.notInLibrary.n > 0) {
      lines.push(
        `**\`${NOT_IN_LIBRARY}\`** in the carried-by column means those samples came from a ` +
          `format that is not part of this library. ${r.notInLibrary.n} sample(s) here. They ` +
          `count toward the axis result above and appear nowhere on the format board, because ` +
          `there is no spec in this repo to attribute them to.`
      );
      lines.push("");
    }
    lines.push(
      "**Read the last column.** If an axis was only ever carried by one format, that axis " +
        "result and that format result are the same videos wearing two labels, and neither " +
        "is isolated. To separate them, run the same subject through two formats, or the " +
        "same format across two subjects.\n"
    );
  }

  lines.push("Small n is small n. Two videos is an anecdote; treat anything under n=5 as a direction.\n");

  /* --- hygiene --- */
  if (r.unmatched.length) {
    lines.push("## Published but unmapped\n");
    lines.push("In the analytics export, but with no row in `measure/mapping.csv`, so excluded");
    lines.push("from every number above.\n");
    for (const u of r.unmatched.slice(0, 40)) {
      lines.push(`- \`${u.platform}:${u.externalId}\`${u.title ? ` — ${u.title}` : ""}`);
    }
    if (r.unmatched.length > 40) lines.push(`- …and ${r.unmatched.length - 40} more`);
    lines.push("");
  }

  if (r.unmappedVariants.length) {
    lines.push("## Variant ids with no matching format\n");
    for (const v of r.unmappedVariants) lines.push(`- \`${v}\``);
    lines.push("");
  }

  if (r.unknownAxes.length) {
    lines.push("## Unknown content axes\n");
    lines.push("Named in `mapping.csv` but not declared in `data/content-axes.yml`, so ignored:\n");
    for (const a of r.unknownAxes) lines.push(`- \`${a}\``);
    lines.push(`\nDeclared axes: ${axes.map((a) => `\`${a.id}\``).join(", ") || "none"}\n`);
  }

  lines.push("---\n");
  lines.push("Write these results into the format library with `kw measure apply`.\n");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ apply */

export function applyReport(report?: Report): void {
  const r = report ?? (JSON.parse(fs.readFileSync(REPORT_JSON, "utf8")) as Report);
  const formats = new Map(loadAllFormats().map((f) => [f.slug, f]));
  const today = new Date().toISOString().slice(0, 10);

  /* Every format that gained a measurement on either board is rewritten once,
     with both blocks, so the two can never drift out of step. */
  const touched = new Set([
    ...r.formats.results.map((x) => x.slug),
    ...Object.keys(r.contentAxes.byFormat),
  ]);

  let written = 0;
  for (const slug of touched) {
    const fmt = formats.get(slug);
    if (!fmt) continue;

    const existing = readEvidence(fmt.dir);
    const res = r.formats.results.find((x) => x.slug === slug);

    const formatBlock: FormatMeasurement = res
      ? {
          n: res.n,
          status: "measured",
          platforms: res.platforms,
          hook3s: res.hook3s,
          avgViewedPct: res.avgViewedPct,
          viewsPerHour: res.viewsPerHour,
          vsBaselinePct:
            r.formats.baseline.avgViewedPct !== null && res.avgViewedPct !== null
              ? Number(((res.avgViewedPct - r.formats.baseline.avgViewedPct) * 100).toFixed(2))
              : null,
          retention: res.retention,
          notes: existing.format.notes,
          updated: today,
          samples: res.samples,
        }
      : existing.format;

    const axisRows = r.contentAxes.byFormat[slug] ?? existing.contentAxis.axes;

    writeEvidence(fmt.dir, {
      format: formatBlock,
      contentAxis: {
        n: axisRows.reduce((s, a) => s + a.n, 0),
        status: axisRows.length ? "measured" : "untested",
        axes: axisRows,
        notes: existing.contentAxis.notes,
        updated: axisRows.length ? today : existing.contentAxis.updated,
      },
    });
    written++;
  }

  /* The repo-level axis roll-up. This file, not the format library, is the
     authoritative axis board: an axis can be carried entirely by out-of-library
     videos, and pooling from formats/ would silently drop exactly those. */
  const rollups: AxisRollup[] = r.contentAxes.results.map((res) => ({
    axis: res.axis,
    name: res.name,
    n: res.n,
    hook3s: res.hook3s,
    avgViewedPct: res.avgViewedPct,
    viewsPerHour: res.viewsPerHour,
    vsAxisBaselinePct:
      r.contentAxes.baseline.avgViewedPct !== null && res.avgViewedPct !== null
        ? Number(((res.avgViewedPct - r.contentAxes.baseline.avgViewedPct) * 100).toFixed(2))
        : null,
    retention: res.retention,
    carriedBy: res.formats,
  }));

  writeAxisResults({
    updated: rollups.length ? today : undefined,
    baseline: r.contentAxes.baseline,
    axes: rollups,
  });

  console.log(`\n▸ apply`);
  console.log(`  ${written} data.yml file(s) updated from ${rel(REPORT_JSON)}`);
  console.log(`  format and content_axis blocks written separately`);
  console.log(`  ${rollups.length} axis roll-up(s) -> data/content-axis-results.yml`);
  if (r.notInLibrary.n > 0) {
    console.log(
      `  ${r.notInLibrary.n} ${NOT_IN_LIBRARY} sample(s) counted toward axes only`
    );
  }
  console.log(`  run \`kw site build\` to reorder the gallery\n`);
}
