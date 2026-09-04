/**
 * Report: normalised samples + variant mapping -> "which format won".
 *
 * The join is the whole point. A published video means nothing on its own; it
 * means something once it is attached to the exact variant id that produced it.
 * Videos with no mapping row are reported as unmatched, never quietly averaged in.
 */
import fs from "node:fs";
import path from "node:path";

import { MEASURE_DIR, ROOT, rel } from "../../engine/src/paths.js";
import {
  loadAllFormats,
  parseVariantId,
  writeMeasurement,
  type Measurement,
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
  samples: Array<{ platform: string; externalId: string; variantId: string; publishedAt?: string }>;
}

export interface Report {
  generatedAt: string;
  baseline: { avgViewedPct: number | null; source: string };
  results: FormatResult[];
  unmatched: Array<{ platform: string; externalId: string; title?: string }>;
  unmappedVariants: string[];
}

export function readMapping(): MappingRow[] {
  if (!fs.existsSync(MAPPING_FILE)) return [];
  return parseCsv(fs.readFileSync(MAPPING_FILE, "utf8"))
    .map((row) => ({
      platform: (pick(row, "platform") ?? "").toLowerCase(),
      externalId: pick(row, "external_id", "externalid", "video id", "id") ?? "",
      variantId: pick(row, "variant_id", "variantid", "variant") ?? "",
      publishedAt: pick(row, "published_at", "publishedat", "date"),
    }))
    .filter((r) => r.externalId && r.variantId);
}

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

export function buildReport(): Report {
  const samples: Sample[] = fs.existsSync(SAMPLES_FILE)
    ? JSON.parse(fs.readFileSync(SAMPLES_FILE, "utf8"))
    : [];
  const mapping = readMapping();
  const formats = loadAllFormats();

  const byExternal = new Map(mapping.map((m) => [`${m.externalId}`, m]));
  const bySlug = new Map<string, { fmt: (typeof formats)[number]; rows: Array<{ s: Sample; m: MappingRow }> }>();
  for (const f of formats) bySlug.set(f.slug, { fmt: f, rows: [] });

  const unmatched: Report["unmatched"] = [];
  const unmappedVariants = new Set<string>();

  for (const s of samples) {
    const m = byExternal.get(s.externalId);
    if (!m) {
      unmatched.push({ platform: s.platform, externalId: s.externalId, title: s.title });
      continue;
    }
    const parsed = parseVariantId(m.variantId);
    if (!parsed || !bySlug.has(parsed.slug)) {
      unmappedVariants.add(m.variantId);
      continue;
    }
    bySlug.get(parsed.slug)!.rows.push({ s, m });
  }

  const results: FormatResult[] = [];
  for (const [slug, { fmt, rows }] of bySlug) {
    if (rows.length === 0) continue;
    const avg = mean(rows.map((r) => r.s.avgViewedPct ?? NaN).filter(Number.isFinite));
    const hook = mean(rows.map((r) => r.s.hook3s ?? NaN).filter(Number.isFinite));
    const vph = median(
      rows
        .map((r) => {
          const h = hoursSince(r.m.publishedAt ?? r.s.publishedAt);
          return h && r.s.views ? r.s.views / Math.min(h, 24) : NaN;
        })
        .filter(Number.isFinite)
    );
    results.push({
      slug,
      name: fmt.meta.name || slug,
      n: rows.length,
      platforms: [...new Set(rows.map((r) => r.s.platform))].sort(),
      hook3s: hook === null ? null : Number(hook.toFixed(4)),
      avgViewedPct: avg === null ? null : Number(avg.toFixed(4)),
      viewsPerHour: vph === null ? null : Number(vph.toFixed(1)),
      retention: averageCurves(
        rows.map((r) => r.s.retention ?? []),
        fmt.spec.canvas.durationSec
      ),
      samples: rows.map((r) => ({
        platform: r.s.platform,
        externalId: r.s.externalId,
        variantId: r.m.variantId,
        publishedAt: r.m.publishedAt ?? r.s.publishedAt,
      })),
    });
  }

  results.sort((a, b) => (b.avgViewedPct ?? -1) - (a.avgViewedPct ?? -1));

  /* Baseline: the mean across every measured format, weighted by nothing at all.
     A single format cannot be its own baseline, so with one format measured the
     comparison column stays empty rather than reading 0.0. */
  const baselineValue =
    results.length > 1 ? mean(results.map((r) => r.avgViewedPct ?? NaN).filter(Number.isFinite)) : null;

  const report: Report = {
    generatedAt: new Date().toISOString(),
    baseline: {
      avgViewedPct: baselineValue === null ? null : Number(baselineValue.toFixed(4)),
      source: results.length > 1 ? `mean of ${results.length} measured formats` : "not enough data",
    },
    results,
    unmatched,
    unmappedVariants: [...unmappedVariants].sort(),
  };

  fs.mkdirSync(MEASURE_DIR, { recursive: true });
  fs.writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2) + "\n", "utf8");
  fs.writeFileSync(REPORT_MD, renderMarkdown(report), "utf8");

  console.log(`\n▸ report`);
  console.log(`  ${samples.length} samples, ${mapping.length} mapping rows`);
  console.log(`  ${results.length} formats with at least one measurement`);
  if (unmatched.length) console.log(`  ${unmatched.length} published videos have no mapping row`);
  if (report.unmappedVariants.length) {
    console.log(`  ${report.unmappedVariants.length} mapped variant id(s) match no format in this repo`);
  }
  console.log(`  -> ${rel(REPORT_MD)}\n`);

  return report;
}

const pct = (v: number | null | undefined): string =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`;

function renderMarkdown(r: Report): string {
  const lines: string[] = [];
  lines.push("# Which format won\n");
  lines.push(`Generated ${r.generatedAt}. Regenerate with \`kw measure report\`.\n`);

  if (r.results.length === 0) {
    lines.push("No format has a measurement yet.\n");
    lines.push("1. Render a format and note its `variantId` from `out/<slug>/variant.json`.");
    lines.push("2. Publish it, then add a row to `measure/mapping.csv`.");
    lines.push("3. Export analytics CSVs into `measure/inbox/` and run `kw measure`.\n");
  } else {
    lines.push(`Baseline: ${pct(r.baseline.avgViewedPct)} (${r.baseline.source}).\n`);
    lines.push("| # | Format | n | Avg % viewed | vs baseline | Hook @3s | Views/hr |");
    lines.push("|---|--------|---|--------------|-------------|----------|----------|");
    r.results.forEach((res, i) => {
      const delta =
        r.baseline.avgViewedPct !== null && res.avgViewedPct !== null
          ? `${((res.avgViewedPct - r.baseline.avgViewedPct) * 100).toFixed(1)} pp`
          : "—";
      lines.push(
        `| ${i + 1} | \`${res.slug}\` | ${res.n} | ${pct(res.avgViewedPct)} | ${delta} | ` +
          `${pct(res.hook3s)} | ${res.viewsPerHour ?? "—"} |`
      );
    });
    lines.push("");
    lines.push(
      "Small n is small n. Two videos is an anecdote; treat anything under n=5 as a direction, not a result.\n"
    );
  }

  if (r.unmatched.length) {
    lines.push("## Published but unmapped\n");
    lines.push("These videos were in the analytics export but have no row in `measure/mapping.csv`,");
    lines.push("so they were excluded from every number above.\n");
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

  lines.push("---\n");
  lines.push("Write these results into the format library with `kw measure apply`.\n");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ apply */

export function applyReport(report?: Report): void {
  const r = report ?? (JSON.parse(fs.readFileSync(REPORT_JSON, "utf8")) as Report);
  const formats = new Map(loadAllFormats().map((f) => [f.slug, f]));
  const today = new Date().toISOString().slice(0, 10);
  let written = 0;

  for (const res of r.results) {
    const fmt = formats.get(res.slug);
    if (!fmt) continue;
    const measurement: Measurement = {
      n: res.n,
      status: "measured",
      platforms: res.platforms,
      hook3s: res.hook3s,
      avgViewedPct: res.avgViewedPct,
      viewsPerHour: res.viewsPerHour,
      vsBaselinePct:
        r.baseline.avgViewedPct !== null && res.avgViewedPct !== null
          ? Number(((res.avgViewedPct - r.baseline.avgViewedPct) * 100).toFixed(2))
          : null,
      retention: res.retention,
      notes: fmt.data.notes,
      updated: today,
      samples: res.samples,
    };
    writeMeasurement(fmt.dir, measurement);
    written++;
  }

  console.log(`\n▸ apply`);
  console.log(`  ${written} data.yml file(s) updated from ${rel(REPORT_JSON)}`);
  console.log(`  run \`kw site build\` to reorder the gallery\n`);
}
