/**
 * keepwatching CLI.
 *
 *   kw setup                     install fonts + a headless Chromium
 *   kw list                      every format, with its sample size
 *   kw check                     validate every format.json
 *   kw render <slug|--all>       render to out/<slug>/
 *   kw preview <slug>            scrub a format in a browser
 *   kw new <slug> [--from <s>]   scaffold a new format
 *   kw variant <slug>            print the variant id for the current spec
 *   kw site build|serve          build the gallery
 *   kw measure [ingest|report|apply]
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { FORMATS_DIR, OUT_DIR, ROOT, SITE_DIR, rel } from "./paths.js";
import YAML from "yaml";

import { installFonts, missingFonts } from "./fonts.js";
import { ensureBundle } from "./bundle.js";
import {
  listFormatSlugs,
  loadAllFormats,
  loadContentAxes,
  loadFormat,
  validateAxes,
  validateMeta,
  validateSpec,
  type LoadedFormat,
} from "./format.js";
import { renderFormat } from "./render.js";
import { startPreview } from "./preview.js";
import { buildSite } from "./site.js";
import { checkFrame0, reportFrame0 } from "./frame0.js";
import {
  checkPreviews,
  previewStatus,
  readManifest,
  reportPreviewCheck,
  syncPreview,
  writeManifest,
} from "./previews.js";

const argv = process.argv.slice(2);
const cmd = argv[0] ?? "help";
const positional = argv.slice(1).filter((a) => !a.startsWith("--"));
const has = (flag: string) => argv.includes(`--${flag}`);
const opt = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const HELP = `
keepwatching — a measured retention database for short-form formats, that renders.

  kw setup                        install Inter + a headless Chromium (run once)
  kw list                         list every format with its sample size
  kw check                        validate every format.json
  kw render <slug>                render one format to out/<slug>/
  kw render --all                 render every format
      --stills                    poster + contact sheet only, no encode
      --check-determinism         re-seek frames out of order and compare hashes
      --keep-frames               leave the PNG sequence on disk
      --no-previews               skip the gallery-sized webm/mp4
  kw frame0 [<slug>]              assert every format paints a real first frame
  kw preview <slug> [--port=5173] scrub a format in a browser
  kw new <slug> [--from=<slug>]   scaffold a new format directory
  kw variant <slug>               print the variant id for the current spec
  kw gallery [--port=8080]        refresh stale previews, build and open the gallery
      --no-serve                  build only, do not start the server
      --force                     re-render every preview, not just stale ones
  kw previews check               verify committed previews match their specs
  kw site build [--allow-missing] rebuild site/gallery.json from existing renders
  kw site serve [--port=8080]     serve site/ locally
  kw measure                      ingest CSVs, then report
  kw measure ingest|report|apply
  kw measure seed                 read data/seed/raw/ exports into axis results
`;

/* ------------------------------------------------------------------ utils */

function need(name: string): string {
  const v = positional[0];
  if (!v) {
    console.error(`Missing <${name}>.\n${HELP}`);
    process.exit(1);
  }
  return v;
}

function fail(err: unknown): never {
  console.error(`\n[31m✗ ${(err as Error).message}[0m\n`);
  process.exit(1);
}

const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`;

/* --------------------------------------------------------------- commands */

async function cmdSetup(): Promise<void> {
  console.log("\n▸ setup");
  await installFonts();

  console.log("  installing Chromium for Playwright …");
  try {
    execFileSync(process.execPath, [
      path.join(ROOT, "node_modules", "playwright", "cli.js"),
      "install",
      "chromium",
    ], { stdio: "inherit" });
  } catch {
    console.warn("  ! Chromium install failed — run `npx playwright install chromium` yourself");
  }

  ensureBundle(true);
  console.log("  composition bundle built");
  console.log(`\n✓ ready. Try:  npx kw render ${listFormatSlugs()[0] ?? "<slug>"}\n`);
}

function cmdList(): void {
  const formats = loadAllFormats();
  if (formats.length === 0) {
    console.log("\nNo formats found in formats/.\n");
    return;
  }
  const width = Math.max(...formats.map((f) => f.slug.length));
  console.log(`\n${formats.length} formats\n`);
  console.log("  format measurement (ranks the library)   |   content axis (separate)");
  console.log(
    `  ${"slug".padEnd(width)}  ${"family".padEnd(12)}  ${"n".padStart(3)}  ` +
      `${"avg viewed".padStart(10)}  ${"hook@3s".padStart(8)}  ${"n".padStart(3)}  axes`
  );
  console.log(
    `  ${"-".repeat(width)}  ${"-".repeat(12)}  ---  ----------  --------  ---  ----`
  );
  for (const f of formats) {
    const axes = f.data.contentAxis.axes.map((a) => a.axis).join(",") || "—";
    console.log(
      `  ${f.slug.padEnd(width)}  ${String(f.meta.family).padEnd(12)}  ` +
        `${String(f.data.format.n).padStart(3)}  ${pct(f.data.format.avgViewedPct).padStart(10)}  ` +
        `${pct(f.data.format.hook3s).padStart(8)}  ` +
        `${String(f.data.contentAxis.n).padStart(3)}  ${axes}`
    );
  }
  const measured = formats.filter((f) => f.data.format.status === "measured").length;
  const axisSamples = formats.reduce((s, f) => s + f.data.contentAxis.n, 0);
  console.log(
    `\n  formats:      ${measured} measured, ${formats.length - measured} untested, ` +
      `${formats.reduce((s, f) => s + f.data.format.n, 0)} samples`
  );
  console.log(`  content axes: ${axisSamples} samples — never averaged into the numbers above\n`);
}

function cmdCheck(): void {
  const slugs = listFormatSlugs();
  const axes = loadContentAxes();
  let bad = 0;
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const slug of slugs) {
    try {
      const f = loadFormat(slug);
      validateSpec(f.spec, slug);

      /* Sourcing is an error, not a warning. A library about honest measurement
         cannot ship unattributed numbers in its own demo copy. */
      errors.push(...validateMeta(f.meta, slug));
      errors.push(...validateAxes(f, axes));

      if (!f.meta.hypothesis) warnings.push(`${slug}: meta.yml has no hypothesis`);
      if (!f.meta.useWhen) warnings.push(`${slug}: meta.yml has no useWhen`);
      if (!fs.existsSync(path.join(f.dir, "data.yml"))) {
        warnings.push(`${slug}: no data.yml (treated as untested)`);
      }
    } catch (err) {
      errors.push((err as Error).message);
      bad++;
    }
  }

  console.log(`\n▸ check`);
  console.log(`  ${slugs.length} formats, ${axes.length} declared content axes`);
  for (const e of errors) console.log(`  \x1b[31m✗\x1b[0m ${e}`);
  for (const w of warnings) console.log(`  ! ${w}`);
  if (missingFonts().length) console.log(`  ! fonts missing — run \`npm run setup\``);
  console.log(errors.length ? `\n  ${errors.length} problem(s)\n` : `  no problems\n`);
  if (errors.length || bad > 0) process.exit(1);
}

async function cmdRender(): Promise<void> {
  const opts = {
    stillsOnly: has("stills"),
    keepFrames: has("keep-frames"),
    noPreviews: has("no-previews"),
    checkDeterminism: has("check-determinism"),
  };

  let targets: LoadedFormat[];
  if (has("all")) targets = loadAllFormats();
  else targets = [loadFormat(need("slug"))];

  const t0 = Date.now();
  const done: string[] = [];
  const failed: Array<[string, string]> = [];

  for (const fmt of targets) {
    try {
      await renderFormat(fmt, opts);
      done.push(fmt.slug);
    } catch (err) {
      if (targets.length === 1) throw err;
      console.error(`  [31m✗ ${fmt.slug}: ${(err as Error).message}[0m\n`);
      failed.push([fmt.slug, (err as Error).message]);
    }
  }

  if (targets.length > 1) {
    console.log(
      `\n▸ rendered ${done.length}/${targets.length} in ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
    for (const [slug, msg] of failed) console.log(`  ✗ ${slug}: ${msg}`);
    console.log("");
    if (failed.length) process.exit(1);
  }
}

/**
 * The first frame is the hook and the platform cover image. It has broken twice
 * for unrelated reasons, so it gets its own test over the whole library rather
 * than a spot check on one format.
 */
async function cmdFrame0(): Promise<void> {
  const targets = positional.length ? [loadFormat(positional[0])] : loadAllFormats();
  const ok = reportFrame0(await checkFrame0(targets));
  if (!ok) process.exit(1);
}

function cmdPreview(): void {
  const fmt = loadFormat(need("slug"));
  startPreview(fmt, Number(opt("port") ?? 5173));
}

function cmdVariant(): void {
  const fmt = loadFormat(need("slug"));
  console.log(fmt.variantId);
}

function cmdNew(): void {
  const slug = need("slug");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) fail(new Error("slug must be lowercase-kebab-case"));
  const dir = path.join(FORMATS_DIR, slug);
  if (fs.existsSync(dir)) fail(new Error(`formats/${slug} already exists`));

  const from = opt("from");
  fs.mkdirSync(dir, { recursive: true });

  if (from) {
    const src = loadFormat(from);
    const spec = { ...src.spec, id: slug, version: "0.1.0" };
    fs.writeFileSync(path.join(dir, "format.json"), JSON.stringify(spec, null, 2) + "\n", "utf8");

    /* Copy the claim, never the provenance.
       The parent's `sources` back the parent's numbers. Inheriting them would
       attach a real citation to content that has nothing to do with it, and
       `kw check` would pass — the failure mode is a clip that looks sourced and
       is not. So the scaffold always starts at `placeholder` with no sources,
       and the author has to opt back in deliberately. */
    const parentMeta = YAML.parse(fs.readFileSync(path.join(src.dir, "meta.yml"), "utf8")) as Record<
      string,
      unknown
    >;
    delete parentMeta.sources;
    const scaffolded = {
      ...parentMeta,
      name: `${slug} (from ${src.slug})`,
      sampleContent: "placeholder",
    };
    fs.writeFileSync(
      path.join(dir, "meta.yml"),
      "# Scaffolded from " +
        `${src.slug}. The hypothesis below is inherited — rewrite it if this\n` +
        "# format now claims something different.\n" +
        "#\n" +
        "# sampleContent was reset to `placeholder` and the parent's sources were\n" +
        "# dropped, because they backed the parent's numbers, not yours. If you put a\n" +
        "# real number on screen, set sampleContent: sourced and add a sources: list\n" +
        "# with a url and the exact claim each source backs.\n" +
        YAML.stringify(scaffolded),
      "utf8"
    );
  } else {
    fs.writeFileSync(
      path.join(dir, "format.json"),
      JSON.stringify(
        {
          id: slug,
          version: "0.1.0",
          canvas: { w: 1080, h: 1920, fps: 30, durationSec: 10 },
          theme: { bg: "#0b0f14", fg: "#ffffff", accent: "#22c55e", glow: 0.14, glowY: 820 },
          data: { headline: "Your headline here", detail: "Your supporting line" },
          scene: [
            {
              id: "headline",
              type: "text",
              box: { y: 700 },
              text: "{{headline}}",
              font: { size: 104, weight: 800 },
              at: 0,
            },
            {
              id: "detail",
              type: "text",
              box: { y: 960 },
              text: "{{detail}}",
              font: { size: 54, weight: 600, color: "muted" },
              at: 0.6,
            },
          ],
        },
        null,
        2
      ) + "\n",
      "utf8"
    );
    fs.writeFileSync(
      path.join(dir, "meta.yml"),
      `name: ${slug}\nfamily: cold-open\nhypothesis: >-\n  State what this format is supposed to do, and by when. One sentence, testable.\nuseWhen: >-\n  Describe the situation a creator should reach for this in.\navoidWhen: >-\n  Describe when it is the wrong tool.\ntags: []\ninputs:\n  - key: headline\n    description: The first thing the viewer reads.\n`,
      "utf8"
    );
  }

  fs.writeFileSync(
    path.join(dir, "data.yml"),
    "# No measurements yet. This is an honest state — do not fill it in by hand.\n" +
      "n: 0\nstatus: untested\nhook3s: null\navgViewedPct: null\nviewsPerHour: null\n" +
      "vsBaselinePct: null\nretention: []\n",
    "utf8"
  );

  console.log(`\n✓ created ${rel(dir)}`);
  console.log(`  edit format.json + meta.yml, then:  npx kw render ${slug}\n`);
}

/**
 * The one command a visitor runs. Renders whatever is missing, builds the
 * gallery, and serves it — because the gallery is previews, and a page served
 * without them is not the product.
 */
async function cmdGallery(): Promise<void> {
  const formats = loadAllFormats();
  const manifest = readManifest();
  const force = has("force");

  const statuses = formats.map((f) => previewStatus(f, manifest));
  const needRender = force
    ? formats
    : formats.filter((f) => {
        const st = statuses.find((s) => s.slug === f.slug)!;
        return st.state === "missing" || st.state === "stale";
      });
  const needSync = force
    ? []
    : formats.filter((f) => statuses.find((s) => s.slug === f.slug)!.state === "syncable");

  const stale = statuses.filter((s) => s.state === "stale");
  console.log(`
▸ gallery`);
  if (stale.length) {
    console.log(`  ${stale.length} preview(s) are stale — their spec changed since they were rendered:`);
    for (const s of stale) console.log(`    ${s.slug}  ${s.recorded ?? "?"} -> ${s.current}`);
  }

  if (needSync.length) {
    for (const fmt of needSync) syncPreview(fmt, manifest);
    console.log(`  ${needSync.length} preview(s) copied from an existing render in out/`);
  }

  if (needRender.length) {
    console.log(
      `  ${needRender.length} of ${formats.length} need rendering ` +
        `(~25s each, about ${Math.ceil((needRender.length * 25) / 60)} min)
`
    );
    const t0 = Date.now();
    for (const [i, fmt] of needRender.entries()) {
      await renderFormat(fmt, { quiet: true });
      syncPreview(fmt, manifest);
      const done = i + 1;
      const elapsed = (Date.now() - t0) / 1000;
      const eta = (elapsed / done) * (needRender.length - done);
      process.stdout.write(
        `  ${String(done).padStart(2)}/${needRender.length} rendered  ` +
          `${fmt.slug.padEnd(22)} ${elapsed.toFixed(0)}s elapsed` +
          `${done < needRender.length ? `, ~${eta.toFixed(0)}s left` : ""}      `
      );
    }
    process.stdout.write("\n");
  } else if (!needSync.length) {
    console.log(`  all ${formats.length} previews are current`);
  }

  if (needRender.length || needSync.length) {
    manifest.generatedAt = new Date().toISOString().slice(0, 10);
    writeManifest(manifest);
    console.log(`  site/previews/manifest.json updated — commit site/previews/`);
  }

  buildSite();

  if (has("no-serve")) {
    console.log(`  open site/index.html directly, or serve it with:  npx kw gallery
`);
    return;
  }
  serveSite(Number(opt("port") ?? 8080));
}

/**
 * The drift guard. Committed previews are the gallery's visible surface, so a
 * preview that no longer matches its spec must never ship quietly.
 */
function cmdPreviews(): void {
  const sub = positional[0] ?? "check";
  if (sub !== "check") fail(new Error(`unknown: kw previews ${sub}`));
  const formats = loadAllFormats();
  if (!reportPreviewCheck(checkPreviews(formats), formats.length)) process.exit(1);
}

function cmdSite(): void {
  const sub = positional[0] ?? "build";
  if (sub === "build") {
    buildSite({ allowMissing: has("allow-missing") });
    return;
  }
  if (sub === "serve") {
    serveSite(Number(opt("port") ?? 8080));
    return;
  }
  fail(new Error(`unknown: kw site ${sub}`));
}

function serveSite(port: number): void {
  const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  };
  http
    .createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      if (p === "/") p = "/index.html";
      const file = path.join(SITE_DIR, p);
      if (!file.startsWith(SITE_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    })
    .listen(port, () => {
      console.log(`  gallery ready:  [36mhttp://localhost:${port}[0m`);
      console.log(`  Ctrl+C to stop.
`);
    });
}

async function cmdMeasure(): Promise<void> {
  const sub = positional[0] ?? "all";
  const { ingest } = await import("../../measure/src/ingest.js");
  const { buildReport, applyReport } = await import("../../measure/src/report.js");

  if (sub === "ingest") {
    ingest();
    return;
  }
  if (sub === "report") {
    buildReport();
    return;
  }
  if (sub === "apply") {
    applyReport();
    return;
  }
  if (sub === "seed") {
    const { runSeed } = await import("../../measure/src/seed-run.js");
    runSeed();
    return;
  }
  if (sub === "all") {
    ingest();
    buildReport();
    console.log("  review measure/report.md, then run `kw measure apply` to write data.yml\n");
    return;
  }
  fail(new Error(`unknown: kw measure ${sub}`));
}

/* ------------------------------------------------------------------ main */

async function main(): Promise<void> {
  switch (cmd) {
    case "setup":
      return cmdSetup();
    case "list":
      return cmdList();
    case "check":
      return cmdCheck();
    case "render":
      return cmdRender();
    case "frame0":
      return cmdFrame0();
    case "preview":
      return cmdPreview();
    case "new":
      return cmdNew();
    case "variant":
      return cmdVariant();
    case "gallery":
      return cmdGallery();
    case "previews":
      return cmdPreviews();
    case "site":
      return cmdSite();
    case "measure":
      return cmdMeasure();
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command: ${cmd}\n${HELP}`);
      process.exit(1);
  }
}

main().catch(fail);

/* Referenced so the unused-import check stays honest about what the CLI touches. */
void OUT_DIR;
