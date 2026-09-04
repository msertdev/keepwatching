/**
 * Ingest: analytics CSV exports -> one normalised sample file.
 *
 * Deliberately no API, no OAuth, no tokens. You export a CSV from YouTube Studio
 * or TikTok, drop it in measure/inbox/, and run one command. Friction is the
 * reason measurement loops die, so there is none here.
 *
 *   measure/inbox/*.csv              table exports (one row per video)
 *   measure/inbox/retention/<id>.csv audience-retention export for video <id>
 */
import fs from "node:fs";
import path from "node:path";

import { MEASURE_DIR } from "../../engine/src/paths.js";
import { parseCsv, pick, num, duration, type Row } from "./csv.js";

export const INBOX = path.join(MEASURE_DIR, "inbox");
export const RETENTION_INBOX = path.join(INBOX, "retention");
export const SAMPLES_FILE = path.join(MEASURE_DIR, "normalized", "samples.json");

export interface Sample {
  platform: string;
  externalId: string;
  title?: string;
  publishedAt?: string;
  views?: number;
  watchTimeHours?: number;
  avgViewDurationSec?: number;
  videoDurationSec?: number;
  /** Mean fraction of the clip watched, 0..1. */
  avgViewedPct?: number | null;
  /** Fraction of viewers still watching at 3 s, 0..1. */
  hook3s?: number | null;
  /** Normalised curve: t is seconds from start, p is fraction still watching. */
  retention?: Array<{ t: number; p: number }>;
  source: string;
}

/* ------------------------------------------------------------- detection */

type Platform = "youtube" | "tiktok" | "unknown";

function detectPlatform(file: string, rows: Row[]): Platform {
  const base = path.basename(file).toLowerCase();
  if (base.includes("tiktok")) return "tiktok";
  if (base.includes("youtube") || base.includes("studio")) return "youtube";
  const keys = Object.keys(rows[0] ?? {})
    .join("|")
    .toLowerCase();
  if (keys.includes("video link") || keys.includes("total time watched")) return "tiktok";
  if (keys.includes("impressions click-through rate") || keys.includes("watch time (hours)")) {
    return "youtube";
  }
  if (keys.includes("content") && keys.includes("views")) return "youtube";
  return "unknown";
}

/** YouTube rows use the video id in "Content"; TikTok exposes it in a share URL. */
function externalIdOf(row: Row, platform: Platform): string | undefined {
  const direct = pick(row, "video id", "content", "videoid");
  if (direct && /^[\w-]{6,}$/.test(direct) && direct.toLowerCase() !== "total") return direct;
  const link = pick(row, "video link", "video url", "url", "link");
  if (link) {
    const m =
      /\/video\/(\d+)/.exec(link) ??
      /[?&]v=([\w-]{6,})/.exec(link) ??
      /shorts\/([\w-]{6,})/.exec(link) ??
      /youtu\.be\/([\w-]{6,})/.exec(link);
    if (m) return m[1];
  }
  return undefined;
}

/* ---------------------------------------------------------------- tables */

function readTable(file: string): Sample[] {
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  if (rows.length === 0) return [];
  const platform = detectPlatform(file, rows);
  const out: Sample[] = [];

  for (const row of rows) {
    const externalId = externalIdOf(row, platform);
    if (!externalId) continue;

    const views = num(pick(row, "views", "video views"));
    const watchHours = num(pick(row, "watch time (hours)", "watch time"));
    const avgView =
      duration(pick(row, "average view duration", "average time watched")) ??
      num(pick(row, "average view duration (seconds)", "average time watched"));
    const totalWatched = duration(pick(row, "total time watched"));
    const videoDuration = duration(pick(row, "duration", "video duration", "length"));

    let avgViewedPct: number | null = null;
    const pctColumn = num(pick(row, "average percentage viewed (%)", "average percentage viewed"));
    if (pctColumn !== undefined) avgViewedPct = pctColumn > 1 ? pctColumn / 100 : pctColumn;
    else if (avgView !== undefined && videoDuration) avgViewedPct = avgView / videoDuration;

    out.push({
      platform: platform === "unknown" ? "unknown" : platform,
      externalId,
      title: pick(row, "video title", "title", "video"),
      publishedAt: pick(row, "video publish time", "post time", "published", "date"),
      views,
      watchTimeHours:
        watchHours ?? (totalWatched !== undefined ? totalWatched / 3600 : undefined),
      avgViewDurationSec: avgView,
      videoDurationSec: videoDuration,
      avgViewedPct,
      retention: [],
      source: path.basename(file),
    });
  }
  return out;
}

/* -------------------------------------------------------------- retention
   A retention export is one curve for one video. Both platforms give position
   as a percentage of the clip; we keep it as a fraction and convert to seconds
   once the clip length is known. */

function readRetention(file: string): { externalId: string; curve: Array<{ f: number; p: number }> } | null {
  const externalId = path.basename(file).replace(/\.csv$/i, "");
  const rows = parseCsv(fs.readFileSync(file, "utf8"));
  if (rows.length === 0) return null;

  const curve: Array<{ f: number; p: number }> = [];
  for (const row of rows) {
    const posRaw = num(pick(row, "video position (%)", "video position", "position", "time"));
    const pRaw = num(
      pick(
        row,
        "absolute audience retention (%)",
        "absolute audience retention",
        "audience retention",
        "retention",
        "viewers"
      )
    );
    if (posRaw === undefined || pRaw === undefined) continue;
    curve.push({ f: posRaw > 1 ? posRaw / 100 : posRaw, p: pRaw > 1 ? pRaw / 100 : pRaw });
  }
  if (curve.length === 0) return null;
  curve.sort((a, b) => a.f - b.f);
  return { externalId, curve };
}

/** Linear interpolation of a 0..1-positioned curve. */
function at(curve: Array<{ f: number; p: number }>, f: number): number | null {
  if (curve.length === 0) return null;
  if (f <= curve[0].f) return curve[0].p;
  if (f >= curve[curve.length - 1].f) return curve[curve.length - 1].p;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i];
    const b = curve[i + 1];
    if (f >= a.f && f <= b.f) {
      const u = b.f === a.f ? 0 : (f - a.f) / (b.f - a.f);
      return a.p + (b.p - a.p) * u;
    }
  }
  return null;
}

/* ------------------------------------------------------------------- run */

export function ingest(): Sample[] {
  fs.mkdirSync(INBOX, { recursive: true });
  fs.mkdirSync(RETENTION_INBOX, { recursive: true });
  fs.mkdirSync(path.dirname(SAMPLES_FILE), { recursive: true });

  const tableFiles = fs
    .readdirSync(INBOX)
    .filter((f) => f.toLowerCase().endsWith(".csv"))
    .map((f) => path.join(INBOX, f));

  const samples = new Map<string, Sample>();

  /* Keep anything already normalised so a partial export does not wipe history. */
  if (fs.existsSync(SAMPLES_FILE)) {
    for (const s of JSON.parse(fs.readFileSync(SAMPLES_FILE, "utf8")) as Sample[]) {
      samples.set(`${s.platform}:${s.externalId}`, s);
    }
  }

  for (const file of tableFiles) {
    for (const s of readTable(file)) {
      const key = `${s.platform}:${s.externalId}`;
      samples.set(key, { ...samples.get(key), ...s });
    }
  }

  const retentionFiles = fs.existsSync(RETENTION_INBOX)
    ? fs.readdirSync(RETENTION_INBOX).filter((f) => f.toLowerCase().endsWith(".csv"))
    : [];

  let curvesAttached = 0;
  for (const f of retentionFiles) {
    const parsed = readRetention(path.join(RETENTION_INBOX, f));
    if (!parsed) continue;
    const match = [...samples.values()].find((s) => s.externalId === parsed.externalId);
    if (!match) {
      console.warn(`  ! retention/${f}: no table row for id "${parsed.externalId}" — skipped`);
      continue;
    }
    const dur = match.videoDurationSec ?? null;
    match.retention = parsed.curve.map((c) => ({
      t: dur ? Number((c.f * dur).toFixed(2)) : Number(c.f.toFixed(4)),
      p: Number(c.p.toFixed(4)),
    }));
    if (dur) {
      const v = at(parsed.curve, 3 / dur);
      match.hook3s = v === null ? null : Number(v.toFixed(4));
    }
    if (match.avgViewedPct == null) {
      /* Area under the retention curve is the mean fraction watched. */
      let area = 0;
      for (let i = 0; i < parsed.curve.length - 1; i++) {
        const a = parsed.curve[i];
        const b = parsed.curve[i + 1];
        area += ((a.p + b.p) / 2) * (b.f - a.f);
      }
      match.avgViewedPct = Number(area.toFixed(4));
    }
    curvesAttached++;
  }

  const list = [...samples.values()].sort((a, b) =>
    `${a.platform}${a.externalId}`.localeCompare(`${b.platform}${b.externalId}`)
  );
  fs.writeFileSync(SAMPLES_FILE, JSON.stringify(list, null, 2) + "\n", "utf8");

  console.log(`\n▸ ingest`);
  console.log(`  ${tableFiles.length} table CSV(s), ${retentionFiles.length} retention CSV(s)`);
  console.log(`  ${list.length} samples normalised, ${curvesAttached} with a retention curve`);
  console.log(`  -> measure/normalized/samples.json`);
  if (list.length === 0) {
    console.log(`\n  Nothing found. Export a CSV from YouTube Studio or TikTok analytics`);
    console.log(`  into measure/inbox/ and run this again. See measure/README.md.`);
  }
  console.log("");
  return list;
}
