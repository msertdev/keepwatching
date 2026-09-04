/**
 * Seed reader: the three raw analytics exports -> content-axis results.
 *
 * This path exists alongside the generic contributor ingest because the seed
 * dataset needs things a format-measurement CSV does not: per-platform video
 * durations, the same video read twice at different moments, hand-entered
 * numbers sitting next to exported ones, and age windows that must stay null
 * unless the daily series genuinely covers them.
 *
 * Rules this file enforces, none of them negotiable:
 *   - Absolute numbers. No indexing, no rounding for presentation, no hiding.
 *   - A missing field stays null, with the reason recorded. Never interpolated,
 *     never extrapolated, never "approximately".
 *   - Two readings that disagree are two rows, each with its own measuredAt and
 *     source. Conflicts are recorded, not resolved by picking a winner.
 *   - Percentages are never compared across platforms. A YouTube cut and a
 *     TikTok cut of the same story are different videos with different lengths.
 *   - Thumbnail impressions and CTR are read past deliberately: on Shorts they
 *     cover a small fraction of views, the rest arriving from the feed, so the
 *     column measures something other than what its name suggests.
 */
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

import { ROOT } from "../../engine/src/paths.js";
import {
  NOT_IN_LIBRARY,
  loadContentAxes,
  type AxisRollup,
  type Conflict,
  type ContentAxisResults,
  type EvidenceSource,
  type Observation,
  type PlatformSummary,
} from "../../engine/src/format.js";
import { readMapping } from "./report.js";
import {
  inferDecimalSeparator,
  isoDate,
  duration,
  mean,
  numWithLocale,
  parseCsv,
  parseDate,
  pick,
  sniffDelimiter,
  type Row,
} from "./csv.js";

export const RAW_DIR = path.join(ROOT, "data", "seed", "raw");
export const MANUAL_FILE = path.join(ROOT, "measure", "manual.yml");

/** The three exports, by the names the platforms give them. */
const FILES = {
  ytTable: ["Tablo verileri.csv", "Table data.csv"],
  ytDaily: ["Grafik verileri.csv", "Chart data.csv"],
  tiktok: ["Content.csv"],
};

const DAY = 86_400_000;
export const addDays = (iso: string, n: number): string =>
  new Date(Date.parse(iso) + n * DAY).toISOString().slice(0, 10);

function findFile(names: string[]): string | null {
  for (const n of names) {
    const p = path.join(RAW_DIR, n);
    if (fs.existsSync(p)) return p;
  }
  /* Fall back to a case-insensitive match so an export renamed by the browser
     still resolves. */
  if (!fs.existsSync(RAW_DIR)) return null;
  const listing = fs.readdirSync(RAW_DIR);
  for (const n of names) {
    const hit = listing.find((f) => f.toLowerCase() === n.toLowerCase());
    if (hit) return path.join(RAW_DIR, hit);
  }
  return null;
}

function readTable(file: string): { rows: Row[]; decimal: "." | "," | undefined } {
  const text = fs.readFileSync(file, "utf8");
  const rows = parseCsv(text, sniffDelimiter(text));
  return { rows, decimal: inferDecimalSeparator(rows) };
}

/** YouTube's export leads with a channel-total row that is not a video. */
const isTotalRow = (row: Row): boolean => {
  const id = pick(row, "İçerik", "Icerik", "Content", "Video") ?? "";
  return /^(toplam|total)$/i.test(id.trim());
};

/* ------------------------------------------------------------- youtube */

export interface DailySeries {
  /** date -> views on that date */
  byDate: Map<string, number>;
  maxDate: string | null;
}

function readYouTubeDaily(file: string | null): Map<string, DailySeries> {
  const out = new Map<string, DailySeries>();
  if (!file) return out;
  const { rows, decimal } = readTable(file);

  for (const row of rows) {
    if (isTotalRow(row)) continue;
    const id = pick(row, "İçerik", "Icerik", "Content", "Video ID");
    const date = isoDate(pick(row, "Tarih", "Date"));
    const views = numWithLocale(pick(row, "Görüntüleme", "Goruntuleme", "Views"), decimal);
    if (!id || !date || views === undefined) continue;

    if (!out.has(id)) out.set(id, { byDate: new Map(), maxDate: null });
    const s = out.get(id)!;
    s.byDate.set(date, (s.byDate.get(date) ?? 0) + views);
    if (!s.maxDate || date > s.maxDate) s.maxDate = date;
  }
  return out;
}

/**
 * Views in the first `days` days after publication — but only when the daily
 * series actually covers that window.
 *
 * A window ending on the last day of the export is not covered: an analytics
 * export's final day is partial, so counting it would understate the window by
 * an unknown amount. The series must extend at least one day past the window.
 */
export function viewsInWindow(
  series: DailySeries | undefined,
  publishedAt: string | null | undefined,
  days: number
): { value: number | null; reason?: string } {
  if (!series || !publishedAt) {
    return { value: null, reason: "no daily series for this video" };
  }
  if (!series.maxDate) return { value: null, reason: "daily series is empty" };

  const needThrough = addDays(publishedAt, days);
  if (series.maxDate < needThrough) {
    return {
      value: null,
      reason:
        `daily series ends ${series.maxDate}; a complete ${days * 24}h window for a video ` +
        `published ${publishedAt} needs data through ${needThrough}`,
    };
  }

  let total = 0;
  for (let i = 0; i < days; i++) {
    total += series.byDate.get(addDays(publishedAt, i)) ?? 0;
  }
  return { value: total };
}

function readYouTube(
  tableFile: string,
  daily: Map<string, DailySeries>,
  measuredAt: string,
  wanted: Set<string>
): { observations: Observation[]; nulls: Array<{ field: string; reason: string }> } {
  const { rows, decimal } = readTable(tableFile);
  const observations: Observation[] = [];
  const nulls: Array<{ field: string; reason: string }> = [];

  for (const row of rows) {
    if (isTotalRow(row)) continue;
    const externalId = pick(row, "İçerik", "Icerik", "Content", "Video ID");
    if (!externalId || !wanted.has(externalId)) continue;

    const durationSec =
      duration(pick(row, "Süre", "Sure", "Duration", "Length")) ?? null;
    const views = numWithLocale(pick(row, "Görüntüleme", "Goruntuleme", "Views"), decimal) ?? null;
    const watchHours =
      numWithLocale(
        pick(row, "İzlenme süresi (saat)", "Izlenme suresi (saat)", "Watch time (hours)"),
        decimal
      ) ?? null;
    const subscribers =
      numWithLocale(pick(row, "Aboneler", "Subscribers"), decimal) ?? null;
    const publishedAt =
      isoDate(pick(row, "Videonun yayınlanma tarihi", "Video publish time", "Yayınlanma tarihi")) ??
      null;

    const notes: string[] = [];

    /* avg watch seconds = watch hours -> seconds, divided by views. */
    let avgWatchSec: number | null = null;
    if (watchHours !== null && views !== null && views > 0) {
      avgWatchSec = (watchHours * 3600) / views;
    } else {
      notes.push("avgWatchSec null: watch time or views missing from the export");
    }

    let avgPctViewed: number | null = null;
    if (avgWatchSec !== null && durationSec !== null && durationSec > 0) {
      avgPctViewed = avgWatchSec / durationSec;
    } else if (avgWatchSec !== null) {
      notes.push("avgPctViewed null: video duration missing from the export");
    }

    const w24 = viewsInWindow(daily.get(externalId), publishedAt, 1);
    const w48 = viewsInWindow(daily.get(externalId), publishedAt, 2);
    const w7 = viewsInWindow(daily.get(externalId), publishedAt, 7);
    for (const [field, w] of [
      ["viewsAt24h", w24],
      ["viewsAt48h", w48],
      ["viewsAt7d", w7],
    ] as const) {
      if (w.value === null && w.reason) {
        notes.push(`${field} null: ${w.reason}`);
        nulls.push({ field: `${externalId}.${field}`, reason: w.reason });
      }
    }

    notes.push(
      "thumbnail impressions and CTR deliberately not recorded: on Shorts they " +
        "cover a small share of views, the rest arriving from the feed"
    );

    observations.push({
      platform: "youtube",
      externalId,
      variantId: NOT_IN_LIBRARY,
      title: pick(row, "Video başlığı", "Video basligi", "Video title"),
      publishedAt,
      measuredAt,
      dataThrough: daily.get(externalId)?.maxDate ?? null,
      durationSec,
      views,
      watchTimeHours: watchHours,
      avgWatchSec: avgWatchSec === null ? null : Number(avgWatchSec.toFixed(2)),
      avgPctViewed: avgPctViewed === null ? null : Number(avgPctViewed.toFixed(4)),
      subscribers,
      viewsAt24h: w24.value,
      viewsAt48h: w48.value,
      viewsAt7d: w7.value,
      source: "csv",
      notes,
    });
  }

  return { observations, nulls };
}

/* -------------------------------------------------------------- tiktok */

/** TikTok exposes the numeric id inside the share URL. */
function tiktokId(link: string | undefined): string | undefined {
  if (!link) return undefined;
  return /\/video\/(\d+)/.exec(link)?.[1] ?? undefined;
}

function readTikTok(file: string, measuredAt: string): Observation[] {
  const { rows, decimal } = readTable(file);
  const out: Observation[] = [];
  /* This export writes dates as "3 Eylül" with no year. The year is taken from
     the measurement date and the inference is recorded on the row, because a
     date the data did not contain must never look like one it did. */
  const contextYear = Number(measuredAt.slice(0, 4));

  for (const row of rows) {
    const link = pick(row, "Video link", "Video URL", "Link");
    const externalId = tiktokId(link) ?? pick(row, "Video ID", "id");
    if (!externalId) continue;

    const published = parseDate(pick(row, "Post time", "Publish time"), contextYear);
    const read = parseDate(pick(row, "Time"), contextYear);

    const notes: string[] = [
      "avgWatchSec and avgPctViewed null: this export carries no retention or " +
        "watch-time column",
      "viewsAt24h/48h/7d null: this export has no daily series",
    ];
    if (published?.yearInferred || read?.yearInferred) {
      notes.push(
        `date year inferred as ${contextYear}: this export writes dates without a ` +
          `year (e.g. "${pick(row, "Post time", "Publish time") ?? ""}")`
      );
    }

    out.push({
      platform: "tiktok",
      externalId,
      variantId: NOT_IN_LIBRARY,
      title: pick(row, "Video title", "Title"),
      publishedAt: published?.iso ?? null,
      measuredAt: read?.iso ?? measuredAt,
      dataThrough: null,
      durationSec: null,
      views: numWithLocale(pick(row, "Total views", "Video views", "Views"), decimal) ?? null,
      watchTimeHours: null,
      avgWatchSec: null,
      avgPctViewed: null,
      likes: numWithLocale(pick(row, "Total likes", "Likes"), decimal) ?? null,
      comments: numWithLocale(pick(row, "Total comments", "Comments"), decimal) ?? null,
      shares: numWithLocale(pick(row, "Total shares", "Shares"), decimal) ?? null,
      viewsAt24h: null,
      viewsAt48h: null,
      viewsAt7d: null,
      source: "csv",
      notes,
    });
  }
  return out;
}

/* -------------------------------------------------------------- manual */

interface ManualEntry {
  platform: string;
  externalId?: string;
  matchTitle?: string;
  contentAxis?: string;
  publishedAt?: string;
  measuredAt: string;
  durationSec?: number;
  views?: number;
  avgWatchSec?: number;
  note?: string;
}

function readManual(csvObservations: Observation[]): {
  observations: Observation[];
  axisOf: Map<string, string>;
} {
  const axisOf = new Map<string, string>();
  if (!fs.existsSync(MANUAL_FILE)) return { observations: [], axisOf };
  const parsed = (YAML.parse(fs.readFileSync(MANUAL_FILE, "utf8")) ?? {}) as {
    observations?: ManualEntry[];
  };

  const observations = (parsed.observations ?? []).map((m) => {
    /* Resolve the external id against the exports when only a title is given,
       so a hand-entered reading can be matched without knowing the id. */
    let externalId = m.externalId;
    if (!externalId && m.matchTitle) {
      const needle = m.matchTitle.toLowerCase();
      const hit = csvObservations.find(
        (o) => o.platform === m.platform && (o.title ?? "").toLowerCase().includes(needle)
      );
      externalId = hit?.externalId;
    }

    const notes: string[] = ["source is manual: entered by hand, not read from an export"];
    if (m.note) notes.push(m.note);
    if (!externalId) {
      notes.push(
        `externalId unresolved: no ${m.platform} row in the exports matched ` +
          `"${m.matchTitle ?? ""}" — this reading is recorded but cannot be paired`
      );
    }
    /* Record the axis against the id we actually resolved, so a title-matched
       row lands on the right axis without the id being transcribed by hand. */
    const resolved = externalId ?? `unresolved:${m.matchTitle ?? "?"}`;
    if (m.contentAxis) axisOf.set(resolved, m.contentAxis);

    let avgPctViewed: number | null = null;
    if (m.avgWatchSec !== undefined && m.durationSec) {
      avgPctViewed = Number((m.avgWatchSec / m.durationSec).toFixed(4));
    }

    return {
      platform: m.platform,
      externalId: externalId ?? `unresolved:${m.matchTitle ?? "?"}`,
      variantId: NOT_IN_LIBRARY,
      publishedAt: m.publishedAt ?? null,
      measuredAt: m.measuredAt,
      dataThrough: null,
      durationSec: m.durationSec ?? null,
      views: m.views ?? null,
      watchTimeHours: null,
      avgWatchSec: m.avgWatchSec ?? null,
      avgPctViewed,
      viewsAt24h: null,
      viewsAt48h: null,
      viewsAt7d: null,
      source: "manual" as EvidenceSource,
      notes,
    };
  });

  return { observations, axisOf };
}

/* ----------------------------------------------------------- conflicts */

/**
 * Find disagreements between readings. Nothing is resolved here — a conflict is
 * a fact about the data, and hiding it would be the one unrecoverable mistake.
 */
export function findConflicts(observations: Observation[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const key = (o: Observation) => `${o.platform}:${o.externalId}`;
  const groups = new Map<string, Observation[]>();
  for (const o of observations) {
    if (!groups.has(key(o))) groups.set(key(o), []);
    groups.get(key(o))!.push(o);
  }

  for (const [subject, group] of groups) {
    if (group.length < 2) continue;

    const views = group.filter((o) => o.views !== null && o.views !== undefined);
    if (new Set(views.map((o) => o.views)).size > 1) {
      conflicts.push({
        subject,
        field: "views",
        readings: views.map((o) => ({
          value: String(o.views),
          source: o.source,
          measuredAt: o.measuredAt,
          from: o.source === "csv" ? "platform export" : "hand-entered",
        })),
        resolution:
          "both kept as separate observations. A view count is a moving number; " +
          "two readings at different moments can both be correct.",
      });
    }

    const published = group.filter((o) => o.publishedAt);
    if (new Set(published.map((o) => o.publishedAt)).size > 1) {
      const csvOne = published.find((o) => o.source === "csv");
      conflicts.push({
        subject,
        field: "publishedAt",
        readings: published.map((o) => ({
          value: String(o.publishedAt),
          source: o.source,
          measuredAt: o.measuredAt,
          from: o.source === "csv" ? "platform export" : "hand-entered",
        })),
        resolution: csvOne
          ? `the platform's own record (${csvOne.publishedAt}) is used; the ` +
            `hand-entered date is recorded here and not discarded.`
          : "no platform record available; both retained.",
      });
    }
  }

  /* A duration that differs across platforms is not a conflict to reconcile —
     it means two different videos, and their percentages must never be divided
     into one another. Recorded so the reader cannot miss it. */
  const byPlatformDuration = new Map<string, Set<number>>();
  for (const o of observations) {
    if (o.durationSec === null || o.durationSec === undefined) continue;
    if (!byPlatformDuration.has(o.platform)) byPlatformDuration.set(o.platform, new Set());
    byPlatformDuration.get(o.platform)!.add(o.durationSec);
  }
  if (byPlatformDuration.size > 1) {
    const readings = [...byPlatformDuration].map(([platform, durations]) => ({
      value: `${[...durations].join(", ")} s`,
      source: "csv" as EvidenceSource,
      from: platform,
    }));
    conflicts.push({
      subject: "cross-platform video length",
      field: "durationSec",
      readings,
      resolution:
        "not a conflict: these are different cuts, so different videos. " +
        "durationSec is kept per platform and the two percentages are shown " +
        "side by side, never divided into one another.",
    });
  }

  return conflicts;
}

/* ---------------------------------------------------------------- build */

export interface SeedOutcome {
  results: ContentAxisResults;
  observations: Observation[];
  missing: string[];
}

export function buildSeed(measuredAt = new Date().toISOString().slice(0, 10)): SeedOutcome {
  const axes = loadContentAxes();
  const axisById = new Map(axes.map((a) => [a.id, a]));
  const mapping = readMapping();

  /* mapping.csv decides which videos are in scope and which axis each carries. */
  const axisFor = new Map(mapping.map((m) => [m.externalId, m.contentAxis]));
  const wanted = new Set(mapping.map((m) => m.externalId));

  const missing: string[] = [];
  const ytTableFile = findFile(FILES.ytTable);
  const ytDailyFile = findFile(FILES.ytDaily);
  const tiktokFile = findFile(FILES.tiktok);
  if (!ytTableFile) missing.push(`data/seed/raw/${FILES.ytTable[0]}`);
  if (!ytDailyFile) missing.push(`data/seed/raw/${FILES.ytDaily[0]}`);
  if (!tiktokFile) missing.push(`data/seed/raw/${FILES.tiktok[0]}`);

  const nulls: Array<{ field: string; reason: string }> = [];
  const observations: Observation[] = [];

  const daily = readYouTubeDaily(ytDailyFile);
  if (ytTableFile) {
    const yt = readYouTube(ytTableFile, daily, measuredAt, wanted);
    observations.push(...yt.observations);
    nulls.push(...yt.nulls);
  }
  if (tiktokFile) observations.push(...readTikTok(tiktokFile, measuredAt));

  /* Manual rows may name an axis directly when they are not in mapping.csv. */
  const manual = readManual(observations);
  observations.push(...manual.observations);
  const manualAxis = manual.axisOf;

  const conflicts = findConflicts(observations);

  /* Group into axes. An observation with no axis is left out of the board and
     reported, never silently pooled. */
  const byAxis = new Map<string, Observation[]>();
  for (const o of observations) {
    const axis = axisFor.get(o.externalId) ?? manualAxis.get(o.externalId);
    if (!axis || !axisById.has(axis)) continue;
    if (!byAxis.has(axis)) byAxis.set(axis, []);
    byAxis.get(axis)!.push(o);
  }

  const rollups: AxisRollup[] = [];
  for (const [axis, rows] of byAxis) {
    const platforms = [...new Set(rows.map((r) => r.platform))].sort();
    const byPlatform: PlatformSummary[] = platforms.map((platform) => {
      const pr = rows.filter((r) => r.platform === platform);
      const pctValues = pr
        .map((r) => r.avgPctViewed)
        .filter((v): v is number => v !== null && v !== undefined);
      /* Views are summed over distinct videos, not over readings, so a video
         read twice is not counted twice. The latest reading per video wins. */
      const latestPerVideo = new Map<string, Observation>();
      for (const r of pr) {
        const prev = latestPerVideo.get(r.externalId);
        if (!prev || (r.measuredAt ?? "") > (prev.measuredAt ?? "")) {
          latestPerVideo.set(r.externalId, r);
        }
      }
      const viewValues = [...latestPerVideo.values()]
        .map((r) => r.views)
        .filter((v): v is number => v !== null && v !== undefined);
      return {
        platform,
        videos: latestPerVideo.size,
        observations: pr.length,
        views: viewValues.length ? viewValues.reduce((a, b) => a + b, 0) : null,
        avgPctViewed: pctValues.length ? Number((mean(pctValues) ?? 0).toFixed(4)) : null,
        sources: [...new Set(pr.map((r) => r.source))].sort(),
      };
    });

    const distinctVideos = new Set(rows.map((r) => `${r.platform}:${r.externalId}`)).size;
    const notes: string[] = [];

    /* A single axis-level percentage is only honest when one platform carries
       the axis. Across platforms it would average two different videos. */
    let avgViewedPct: number | null = null;
    if (byPlatform.length === 1) {
      avgViewedPct = byPlatform[0].avgPctViewed;
    } else {
      notes.push(
        "avgViewedPct null at axis level: this axis spans " +
          `${byPlatform.map((p) => p.platform).join(" and ")}, whose cuts are different ` +
          "videos with different durations. See byPlatform for the figures side by side."
      );
    }

    rollups.push({
      axis,
      name: axisById.get(axis)?.name ?? axis,
      n: distinctVideos,
      observations: rows.length,
      hook3s: null,
      avgViewedPct,
      viewsPerHour: null,
      vsAxisBaselinePct: null,
      carriedBy: [NOT_IN_LIBRARY],
      byPlatform,
      rows,
      notes,
    });
  }

  /* Baseline within one platform only, and only when more than one axis has a
     figure there. Anything else would compare across video lengths. */
  const platformCounts = new Map<string, number[]>();
  for (const r of rollups) {
    for (const p of r.byPlatform ?? []) {
      if (p.avgPctViewed === null) continue;
      if (!platformCounts.has(p.platform)) platformCounts.set(p.platform, []);
      platformCounts.get(p.platform)!.push(p.avgPctViewed);
    }
  }
  let baseline: ContentAxisResults["baseline"] = {
    avgViewedPct: null,
    source: "not enough data",
  };
  let best: [string, number[]] | null = null;
  for (const entry of platformCounts) {
    if (entry[1].length > 1 && (!best || entry[1].length > best[1].length)) best = entry;
  }
  if (best) {
    baseline = {
      avgViewedPct: Number((mean(best[1]) ?? 0).toFixed(4)),
      source: `mean of ${best[1].length} axes on ${best[0]} only`,
    };
    for (const r of rollups) {
      const p = (r.byPlatform ?? []).find((x) => x.platform === best![0]);
      if (p?.avgPctViewed != null && baseline.avgViewedPct != null) {
        r.vsAxisBaselinePct = Number(((p.avgPctViewed - baseline.avgViewedPct) * 100).toFixed(2));
      }
    }
  }

  rollups.sort((a, b) => a.axis.localeCompare(b.axis));

  const dedupedNulls = [...new Map(nulls.map((n) => [`${n.field}|${n.reason}`, n])).values()];
  if (observations.length) {
    dedupedNulls.push({
      field: "hook3s (every axis)",
      reason:
        "no retention export exists for any of these videos: the YouTube table export " +
        "carries no retention curve, and the TikTok export has no retention section",
    });
  }

  return {
    results: {
      updated: measuredAt,
      baseline,
      axes: rollups,
      conflicts,
      nulls: dedupedNulls,
    },
    observations,
    missing,
  };
}
