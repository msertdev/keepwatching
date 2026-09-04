/**
 * Gallery builder. Turns the formats directory into `site/gallery.json` plus the
 * preview media the page needs.
 *
 * Ranking rule, applied here and nowhere else: measured formats first, ordered by
 * mean percentage of the clip watched; untested formats after them, alphabetically.
 * Losers are not dropped — a format that measured badly is the most useful row in
 * the table, and it keeps its numbers.
 *
 * Content-axis results ride along on each card but never touch the ordering. The
 * library ranks scene structures; an axis result is a fact about subject matter,
 * and sorting formats by it would be a category error.
 */
import fs from "node:fs";
import path from "node:path";

import { OUT_DIR, ROOT, SITE_DIR, rel } from "./paths.js";
import {
  loadAllFormats,
  loadAxisResults,
  loadContentAxes,
  type AxisResult,
  type LoadedFormat,
} from "./format.js";

export interface GalleryCard {
  slug: string;
  name: string;
  family: string;
  hypothesis: string;
  useWhen: string;
  avoidWhen?: string;
  tags: string[];
  durationSec: number;
  fps: number;
  variantId: string;
  sampleContent: string;
  sources: Array<{ title: string; url: string; claim: string }>;
  /** How the scene structure performed. Orders the gallery. */
  format: {
    n: number;
    status: string;
    platforms: string[];
    hook3s: number | null;
    avgViewedPct: number | null;
    viewsPerHour: number | null;
    vsBaselinePct: number | null;
    retention: Array<{ t: number; p: number }>;
    notes?: string;
    updated?: string;
  };
  /** How the subject matter performed. Displayed apart; never sorted on. */
  contentAxis: {
    n: number;
    status: string;
    axes: AxisResult[];
    updated?: string;
  };
  media: { mp4?: string; webm?: string; poster?: string };
}

export interface Gallery {
  generatedAt: string;
  totals: {
    formats: number;
    measured: number;
    untested: number;
    samples: number;
    platforms: string[];
  };
  /** Repo-wide content-axis roll-up, kept in its own branch for the same reason. */
  contentAxes: {
    declared: Array<{ id: string; name: string; description?: string }>;
    measured: number;
    samples: number;
    baseline: { avgViewedPct: number | null; source: string };
    rows: Array<{
      axis: string;
      name: string;
      n: number;
      hook3s: number | null;
      avgViewedPct: number | null;
      /** Format slugs, plus `not-in-library` where samples came from outside. */
      formats: string[];
    }>;
  };
  cards: GalleryCard[];
}

function rank(a: GalleryCard, b: GalleryCard): number {
  const am = a.format.status === "measured" && a.format.avgViewedPct !== null;
  const bm = b.format.status === "measured" && b.format.avgViewedPct !== null;
  if (am !== bm) return am ? -1 : 1;
  if (am && bm) {
    const d = (b.format.avgViewedPct ?? 0) - (a.format.avgViewedPct ?? 0);
    if (Math.abs(d) > 1e-9) return d;
    return (b.format.hook3s ?? 0) - (a.format.hook3s ?? 0);
  }
  return a.slug.localeCompare(b.slug);
}

function copyMedia(fmt: LoadedFormat, mediaDir: string): GalleryCard["media"] {
  const media: GalleryCard["media"] = {};
  const src = path.join(OUT_DIR, fmt.slug);
  const pairs: Array<[string, string, keyof GalleryCard["media"]]> = [
    ["preview.mp4", `${fmt.slug}.mp4`, "mp4"],
    ["preview.webm", `${fmt.slug}.webm`, "webm"],
    ["poster.jpg", `${fmt.slug}.jpg`, "poster"],
  ];
  for (const [from, to, key] of pairs) {
    const f = path.join(src, from);
    if (fs.existsSync(f)) {
      fs.copyFileSync(f, path.join(mediaDir, to));
      media[key] = `previews/${to}`;
    }
  }
  return media;
}

export interface BuildOptions {
  /** Build even when previews are missing. Only for callers that render a
   *  subset on purpose, such as CI. */
  allowMissing?: boolean;
}

export function buildSite(opts: BuildOptions = {}): Gallery {
  const mediaDir = path.join(SITE_DIR, "previews");
  fs.mkdirSync(mediaDir, { recursive: true });

  const formats = loadAllFormats();
  const declaredAxes = loadContentAxes();

  const cards: GalleryCard[] = formats.map((f) => ({
    slug: f.slug,
    name: f.meta.name || f.slug,
    family: String(f.meta.family ?? "unknown"),
    hypothesis: f.meta.hypothesis ?? "",
    useWhen: f.meta.useWhen ?? "",
    avoidWhen: f.meta.avoidWhen,
    tags: f.meta.tags ?? [],
    durationSec: f.spec.canvas.durationSec,
    fps: f.spec.canvas.fps,
    variantId: f.variantId,
    sampleContent: f.meta.sampleContent ?? "undeclared",
    sources: f.meta.sources ?? [],
    format: {
      n: f.data.format.n,
      status: f.data.format.status,
      platforms: f.data.format.platforms ?? [],
      hook3s: f.data.format.hook3s ?? null,
      avgViewedPct: f.data.format.avgViewedPct ?? null,
      viewsPerHour: f.data.format.viewsPerHour ?? null,
      vsBaselinePct: f.data.format.vsBaselinePct ?? null,
      retention: f.data.format.retention ?? [],
      notes: f.data.format.notes,
      updated: f.data.format.updated,
    },
    contentAxis: {
      n: f.data.contentAxis.n,
      status: f.data.contentAxis.status,
      axes: f.data.contentAxis.axes,
      updated: f.data.contentAxis.updated,
    },
    media: copyMedia(f, mediaDir),
  }));

  cards.sort(rank);

  const measured = cards.filter((c) => c.format.status === "measured" && c.format.n > 0);

  /* The axis board comes from data/content-axis-results.yml, not from pooling
     formats/. An axis can be carried entirely by videos whose format is not in
     this library; pooling from the format directories would silently drop
     exactly those samples, which is the opposite of what the board is for. */
  const axisResults = loadAxisResults();
  const axisRows = axisResults.axes
    .map((a) => ({
      axis: a.axis,
      name: a.name ?? declaredAxes.find((d) => d.id === a.axis)?.name ?? a.axis,
      n: a.n,
      hook3s: a.hook3s ?? null,
      avgViewedPct: a.avgViewedPct ?? null,
      formats: a.carriedBy ?? [],
    }))
    .sort((a, b) => (b.avgViewedPct ?? -1) - (a.avgViewedPct ?? -1));

  const gallery: Gallery = {
    generatedAt: new Date().toISOString(),
    totals: {
      formats: cards.length,
      measured: measured.length,
      untested: cards.length - measured.length,
      samples: cards.reduce((s, c) => s + c.format.n, 0),
      platforms: [...new Set(cards.flatMap((c) => c.format.platforms))].sort(),
    },
    contentAxes: {
      declared: declaredAxes.map((a) => ({ id: a.id, name: a.name, description: a.description })),
      measured: axisRows.length,
      samples: axisRows.reduce((s, a) => s + a.n, 0),
      baseline: axisResults.baseline,
      rows: axisRows,
    },
    cards,
  };

  fs.writeFileSync(path.join(SITE_DIR, "gallery.json"), JSON.stringify(gallery, null, 2) + "\n", "utf8");

  writeFormatIndex(formats);

  const withMedia = cards.filter((c) => c.media.mp4 || c.media.webm).length;
  console.log(`\n▸ gallery built  ${rel(path.join(SITE_DIR, "gallery.json"))}`);
  console.log(
    `  formats:      ${cards.length} · ${measured.length} measured · ${gallery.totals.samples} samples`
  );
  console.log(
    `  content axes: ${declaredAxes.length} declared · ${axisRows.length} measured · ` +
      `${gallery.contentAxes.samples} samples`
  );
  console.log(`  ${withMedia}/${cards.length} have rendered previews`);
  if (withMedia < cards.length) console.log(`  run \`kw render --all\` to fill the gaps\n`);
  else console.log("");

  return gallery;
}

/**
 * The format index the skill reads. Generated by `kw site build` from meta.yml
 * and data.yml, so the documentation can never drift from the library.
 */
function writeFormatIndex(formats: LoadedFormat[]): void {
  const byFamily = new Map<string, LoadedFormat[]>();
  for (const f of formats) {
    const key = String(f.meta.family ?? "unknown");
    if (!byFamily.has(key)) byFamily.set(key, []);
    byFamily.get(key)!.push(f);
  }

  const pct = (v: number | null | undefined) =>
    v === null || v === undefined ? "—" : `${(v * 100).toFixed(0)}%`;
  const oneLine = (v: string | undefined) => (v ?? "").replace(/\s+/g, " ").trim();

  const measured = formats.filter((f) => f.data.format.status === "measured").length;
  const samples = formats.reduce((sum, f) => sum + f.data.format.n, 0);
  const axisSamples = formats.reduce((sum, f) => sum + f.data.contentAxis.n, 0);

  const out: string[] = [
    "# The format library",
    "",
    "Generated by `kw site build` from `formats/*/meta.yml` and `data.yml`. Do not edit by hand.",
    "",
    `${formats.length} formats · ${measured} measured · ${samples} format samples`,
    "",
    "`n` is the number of published videos behind a row. `n = 0` means untested —",
    "a valid state, not a gap to paper over.",
    "",
    "The `n` columns below are **format** sample sizes only. Content-axis results are a",
    `separate measurement (${axisSamples} samples repo-wide) and are never averaged into`,
    "these numbers — see `data/content-axes.yml` and section 2 of `measure/report.md`.",
    "",
    "`content` says where each format's example copy came from: `sourced` (real numbers,",
    "with the source listed in its meta.yml) or `placeholder` (obvious filler).",
    "",
  ];

  for (const [family, list] of [...byFamily].sort((a, b) => a[0].localeCompare(b[0]))) {
    const sorted = [...list].sort((a, b) => a.slug.localeCompare(b.slug));
    out.push(`## ${family}`, "");
    out.push("| Format | content | n | avg viewed | hook @3s | Hypothesis |");
    out.push("|---|---|---|---|---|---|");
    for (const f of sorted) {
      out.push(
        `| \`${f.slug}\` | ${f.meta.sampleContent ?? "—"} | ${f.data.format.n} | ` +
          `${pct(f.data.format.avgViewedPct)} | ${pct(f.data.format.hook3s)} | ` +
          `${oneLine(f.meta.hypothesis)} |`
      );
    }
    out.push("");
    for (const f of sorted) {
      out.push(`**\`${f.slug}\`** — ${f.meta.name}  `);
      out.push(`Use when: ${oneLine(f.meta.useWhen)}  `);
      if (f.meta.avoidWhen) out.push(`Avoid when: ${oneLine(f.meta.avoidWhen)}  `);
      if (f.meta.sampleContent === "sourced" && f.meta.sources?.length) {
        for (const s of f.meta.sources) out.push(`Source: [${s.title}](${s.url}) — ${s.claim}  `);
      }
      out.push(`${f.spec.canvas.durationSec}s · ${f.spec.canvas.fps}fps · \`${f.variantId}\``);
      out.push("");
    }
  }

  fs.writeFileSync(
    path.join(ROOT, "skills", "keepwatching", "references", "formats.md"),
    out.join("\n"),
    "utf8"
  );
}
