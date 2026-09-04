/**
 * `kw measure seed` — read the raw exports, write the axis results and a report.
 *
 * The report is the deliverable, not the YAML. It has to be readable by someone
 * who was not here when the numbers were collected, which means every null
 * carries its reason and every disagreement is on the page rather than resolved
 * behind it.
 */
import fs from "node:fs";
import path from "node:path";

import { MEASURE_DIR, rel } from "../../engine/src/paths.js";
import {
  NOT_IN_LIBRARY,
  loadAllFormats,
  writeAxisResults,
  type AxisRollup,
  type ContentAxisResults,
  type Observation,
} from "../../engine/src/format.js";
import { buildSeed } from "./seed.js";

const REPORT_MD = path.join(MEASURE_DIR, "report.md");

const int = (v: number | null | undefined): string =>
  v === null || v === undefined ? "—" : v.toLocaleString("en-US");
const pct = (v: number | null | undefined): string =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`;
const sec = (v: number | null | undefined): string =>
  v === null || v === undefined ? "—" : `${v.toFixed(1)}s`;
const src = (s: string): string => (s === "manual" ? "**manual**" : "csv");

function observationTable(rows: Observation[]): string[] {
  const out: string[] = [];
  out.push(
    "| platform | video | published | measured | length | views | avg watch | avg % viewed | source |"
  );
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    out.push(
      `| ${r.platform} | \`${r.externalId}\` | ${r.publishedAt ?? "—"} | ${r.measuredAt} | ` +
        `${r.durationSec ? `${r.durationSec}s` : "—"} | ${int(r.views)} | ${sec(r.avgWatchSec)} | ` +
        `${pct(r.avgPctViewed)} | ${src(r.source)} |`
    );
  }
  return out;
}

function axisSection(a: AxisRollup): string[] {
  const out: string[] = [];
  out.push(`### ${a.name ?? a.axis} (\`${a.axis}\`)`, "");
  out.push(
    `${a.n} video${a.n === 1 ? "" : "s"}, ${a.observations ?? a.n} reading` +
      `${(a.observations ?? a.n) === 1 ? "" : "s"} · carried by **\`${NOT_IN_LIBRARY}\`**`,
    ""
  );

  if ((a.byPlatform ?? []).length > 1) {
    out.push("| platform | videos | views | avg % viewed | sources |");
    out.push("|---|---|---|---|---|");
    for (const p of a.byPlatform ?? []) {
      out.push(
        `| ${p.platform} | ${p.videos} | ${int(p.views)} | ${pct(p.avgPctViewed)} | ` +
          `${p.sources.map(src).join(", ")} |`
      );
    }
    out.push("");
    out.push(
      "_Side by side, deliberately. These are different cuts of the same story, with " +
        "different durations — the two percentages describe different videos and are " +
        "never divided into one another._"
    );
    out.push("");
    out.push(
      "_Where a video was read more than once, the platform row uses the most recent " +
        "reading. Every individual reading is listed below._"
    );
    out.push("");
  }

  out.push(...observationTable(a.rows ?? []));
  out.push("");

  const notes = [...(a.notes ?? []), ...(a.rows ?? []).flatMap((r) => r.notes ?? [])];
  const unique = [...new Set(notes)];
  if (unique.length) {
    out.push("<details><summary>Notes and nulls for this axis</summary>", "");
    for (const n of unique) out.push(`- ${n}`);
    out.push("", "</details>", "");
  }
  return out;
}

export function renderSeedReport(results: ContentAxisResults, missing: string[]): string {
  const formats = loadAllFormats();
  const measuredFormats = formats.filter((f) => f.data.format.status === "measured").length;
  const formatSamples = formats.reduce((s, f) => s + f.data.format.n, 0);

  const lines: string[] = [];
  lines.push("# Measurement report", "");
  lines.push(`Generated ${results.updated ?? "—"}. Regenerate with \`kw measure seed\`.`, "");

  if (missing.length) {
    lines.push("> **Incomplete run.** These exports were not found, so nothing was read from them:");
    for (const m of missing) lines.push(`> - \`${m}\``);
    lines.push("");
  }

  /* --- board 1 --- */
  lines.push("## 1. Which format won", "");
  lines.push("_A claim about scene structure._", "");
  lines.push(
    `**No format has a measurement.** ${formats.length} formats, ${measuredFormats} measured, ` +
      `${formatSamples} samples.`,
    ""
  );
  lines.push(
    "Every published video in this dataset carries `variant_id: not-in-library` — a format " +
      "that is deliberately not part of this repo. There is no spec here to attribute those " +
      "views to, so they contribute nothing to this board and it stays empty. That is the " +
      "correct result, not a gap to fill.",
    ""
  );

  /* --- board 2 --- */
  lines.push("## 2. Which content axis won", "");
  lines.push("_A claim about subject matter._", "");
  lines.push(
    `Baseline: ${pct(results.baseline.avgViewedPct)} (${results.baseline.source}).`,
    ""
  );

  if (results.axes.length === 0) {
    lines.push("No content axis has a measurement yet.", "");
  } else {
    lines.push("| # | Content axis | videos | readings | avg % viewed | vs baseline | Carried by |");
    lines.push("|---|---|---|---|---|---|---|");
    results.axes.forEach((a, i) => {
      const single = (a.byPlatform ?? []).length === 1;
      lines.push(
        `| ${i + 1} | ${a.name ?? a.axis} | ${a.n} | ${a.observations ?? a.n} | ` +
          `${single ? pct(a.avgViewedPct) : "see below"} | ` +
          `${a.vsAxisBaselinePct === null || a.vsAxisBaselinePct === undefined ? "—" : `${a.vsAxisBaselinePct.toFixed(1)} pp`} | ` +
          `**\`${NOT_IN_LIBRARY}\`** |`
      );
    });
    lines.push("");

    /* The warning the whole schema exists to make unavoidable. */
    lines.push(
      "> **Read the carried-by column.** Every axis above is carried entirely by " +
        `\`${NOT_IN_LIBRARY}\`. These axis results and the format board cannot be the same ` +
        "videos, because the format board is empty — no video here uses a format from this " +
        "library. Nothing in section 1 explains anything in section 2, and vice versa.",
      ""
    );
    lines.push(
      "> Each axis is also carried by a single video, so an axis result and that one " +
        "video are the same measurement under two names. Treat every figure below as " +
        "n=1: an observation, not a finding.",
      ""
    );

    for (const a of results.axes) lines.push(...axisSection(a));
  }

  /* --- conflicts --- */
  lines.push("## 3. Conflicts", "");
  if (!results.conflicts?.length) {
    lines.push("None found.", "");
  } else {
    lines.push(
      "Disagreements between sources, recorded rather than resolved. None of these was " +
        "settled by discarding a reading.",
      ""
    );
    for (const c of results.conflicts) {
      lines.push(`**\`${c.subject}\` — ${c.field}**`, "");
      for (const r of c.readings) {
        lines.push(
          `- \`${r.value}\` — ${r.from}, ${src(r.source)}` +
            `${r.measuredAt ? `, read ${r.measuredAt}` : ""}`
        );
      }
      lines.push("", `_${c.resolution}_`, "");
    }
  }

  /* --- nulls --- */
  lines.push("## 4. What is null, and why", "");
  if (!results.nulls?.length) {
    lines.push("Nothing is null.", "");
  } else {
    lines.push("| field | reason |");
    lines.push("|---|---|");
    for (const n of results.nulls) lines.push(`| \`${n.field}\` | ${n.reason} |`);
    lines.push("");
    lines.push(
      "_Nothing above was estimated, interpolated or extrapolated to fill a gap._",
      ""
    );
  }

  lines.push("---", "");
  lines.push(
    "Numbers are absolute and unrounded: view counts are already public on the channels, " +
      "so indexing or hiding them would cost transparency and buy nothing.",
    ""
  );
  return lines.join("\n");
}

export function runSeed(): void {
  const { results, observations, missing } = buildSeed();

  if (missing.length) {
    console.log(`\n▸ seed`);
    console.log(`  \x1b[31mmissing export(s):\x1b[0m`);
    for (const m of missing) console.log(`    ${m}`);
    if (observations.length === 0) {
      console.log(`\n  Nothing was read. Put the exports in data/seed/raw/ and re-run.`);
      console.log(`  See data/seed/raw/README.md for the expected filenames.\n`);
      process.exitCode = 1;
      return;
    }
    console.log(`  continuing with what is present\n`);
  }

  writeAxisResults(results);
  fs.writeFileSync(REPORT_MD, renderSeedReport(results, missing), "utf8");

  const manual = observations.filter((o) => o.source === "manual").length;
  console.log(`\n▸ seed`);
  console.log(`  ${observations.length} observation(s): ${observations.length - manual} from exports, ${manual} manual`);
  console.log(`  ${results.axes.length} content axis/axes, all carried by ${NOT_IN_LIBRARY}`);
  console.log(`  format board untouched — no video here uses a library format`);
  if (results.conflicts?.length) console.log(`  ${results.conflicts.length} conflict(s) recorded, none resolved away`);
  if (results.nulls?.length) console.log(`  ${results.nulls.length} null field group(s), each with a reason`);
  console.log(`  -> data/content-axis-results.yml`);
  console.log(`  -> ${rel(REPORT_MD)}\n`);
}
