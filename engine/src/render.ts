/**
 * Frame-accurate renderer: format.json -> 9:16 MP4 + gallery previews.
 *
 * Chromium paints each frame through CDP, ffmpeg encodes the sequence. Nothing
 * is captured from a running clock, so two renders of the same spec produce the
 * same bytes-per-frame. That is what makes a measurement attributable to a
 * format rather than to a lucky render.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

import { COMP_HTML, OUT_DIR, ROOT, rel } from "./paths.js";
import { assertFonts } from "./fonts.js";
import { ensureBundle } from "./bundle.js";
import type { LoadedFormat } from "./format.js";
import { totalFrames, type FormatSpec } from "../shared/spec.js";

const FFMPEG = ffmpegPath as unknown as string;
const FFPROBE = (ffprobeStatic as unknown as { path: string }).path;

export interface RenderOptions {
  outDir?: string;
  keepFrames?: boolean;
  /** Skip the video encode; write poster + contact sheet only. Fast iteration. */
  stillsOnly?: boolean;
  /** Skip the gallery-sized webm/mp4 previews. */
  noPreviews?: boolean;
  /** Re-seek a sample of frames and compare hashes. Slower, catches drift. */
  checkDeterminism?: boolean;
  quiet?: boolean;
}

export interface RenderResult {
  slug: string;
  variantId: string;
  outDir: string;
  master?: string;
  poster: string;
  contact: string;
  sidecar: string;
  durationSec: number;
  frames: number;
}

const pad6 = (n: number) => String(n).padStart(6, "0");
const sha256 = (file: string) =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function ff(args: string[], label: string): void {
  try {
    execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      stdio: ["ignore", "inherit", "inherit"],
    });
  } catch (err) {
    throw new Error(`ffmpeg failed (${label}): ${(err as Error).message}`);
  }
}

function probe(file: string, args: string[]): string {
  return execFileSync(FFPROBE, ["-v", "error", ...args, file]).toString().trim();
}

/* ------------------------------------------------------------ page setup */

async function openComposition(spec: FormatSpec) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--force-color-profile=srgb", "--disable-lcd-text", "--font-render-hinting=none"],
  });
  const context = await browser.newContext({
    viewport: { width: spec.canvas.w, height: spec.canvas.h },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(pathToFileURL(COMP_HTML).href, { waitUntil: "load" });
  await page.waitForFunction(() => (window as unknown as { compReady: boolean }).compReady === true);

  /* Force the faces to load before anything is measured: shrink-to-fit bakes
     font sizes from real metrics, so measuring against a fallback would mis-size
     every text block in the scene. */
  const fontOk = await page.evaluate(async () => {
    const d = document as Document & { fonts: FontFaceSet };
    await Promise.all([
      d.fonts.load('400 100px "KWSans"'),
      d.fonts.load('600 100px "KWSans"'),
      d.fonts.load('700 100px "KWSans"'),
      d.fonts.load('800 100px "KWSans"'),
    ]);
    await d.fonts.ready;
    return d.fonts.check('700 100px "KWSans"') && d.fonts.check('800 100px "KWSans"');
  });
  if (!fontOk) {
    await browser.close();
    throw new Error(
      "Inter did not load from engine/assets/fonts — refusing to render with a fallback font.\nRun: npm run setup"
    );
  }

  await page.evaluate(
    (s) => (window as unknown as { init: (x: unknown) => void }).init(s),
    spec as unknown as Record<string, unknown>
  );
  if (errors.length) {
    await browser.close();
    throw new Error(`composition error: ${errors[0]}`);
  }

  return { page, errors, close: async () => void (await browser.close()) };
}

async function shoot(cdp: any, page: Page, frame: number): Promise<Buffer> {
  await page.evaluate((f) => (window as unknown as { seek: (n: number) => void }).seek(f), frame);
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
    optimizeForSpeed: true,
  });
  return Buffer.from(data, "base64");
}

/* --------------------------------------------------------- contact sheet */

function buildContactSheet(files: string[], out: string, bg: string): void {
  const cellW = 216;
  const cellH = 384;
  const n = files.length;
  const cols = Math.min(6, n);
  const rows = Math.ceil(n / cols);
  const pad = rows * cols - n;

  const inputs = files.flatMap((f) => ["-i", f]);
  if (pad > 0) inputs.push("-f", "lavfi", "-i", `color=c=${bg}:s=${cellW}x${cellH}:d=1`);

  const parts = files.map(
    (_, i) => `[${i}:v]scale=${cellW}:${cellH},pad=${cellW + 4}:${cellH + 4}:2:2:${bg}[s${i}]`
  );
  if (pad > 0) {
    const outs = Array.from({ length: pad }, (_, i) => `[p${i}]`).join("");
    parts.push(
      `[${n}:v]scale=${cellW}:${cellH},pad=${cellW + 4}:${cellH + 4}:2:2:${bg},split=${pad}${outs}`
    );
  }

  const cellLabel = (i: number) => (i < n ? `[s${i}]` : `[p${i - n}]`);
  const rowLabels: string[] = [];
  for (let r = 0; r < rows; r++) {
    const chain = Array.from({ length: cols }, (_, c) => cellLabel(r * cols + c)).join("");
    if (cols === 1) rowLabels.push(chain);
    else {
      parts.push(`${chain}hstack=inputs=${cols}[r${r}]`);
      rowLabels.push(`[r${r}]`);
    }
  }
  let final = rowLabels[0];
  if (rows > 1) {
    parts.push(`${rowLabels.join("")}vstack=inputs=${rows}[grid]`);
    final = "[grid]";
  }

  ff([...inputs, "-filter_complex", parts.join(";"), "-map", final, "-frames:v", "1", out], "contact sheet");
}

/* --------------------------------------------------------------- verify */

function verifyOutput(master: string, spec: FormatSpec): string[] {
  const s = JSON.parse(
    probe(master, [
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate,nb_read_packets",
      "-count_packets",
      "-of",
      "json",
    ])
  ).streams[0];
  const duration = Number(probe(master, ["-show_entries", "format=duration", "-of", "default=nw=1:nk=1"]));
  const [num, den] = String(s.r_frame_rate).split("/").map(Number);
  const fps = num / den;
  const frames = Number(s.nb_read_packets);
  const want = totalFrames(spec);

  const problems: string[] = [];
  if (Math.abs(duration - spec.canvas.durationSec) > 0.05) {
    problems.push(`duration ${duration.toFixed(3)}s (want ${spec.canvas.durationSec})`);
  }
  if (frames !== want) problems.push(`frames ${frames} (want ${want})`);
  if (s.width !== spec.canvas.w || s.height !== spec.canvas.h) {
    problems.push(`resolution ${s.width}x${s.height} (want ${spec.canvas.w}x${spec.canvas.h})`);
  }
  if (Math.abs(fps - spec.canvas.fps) > 0.001) problems.push(`fps ${fps} (want ${spec.canvas.fps})`);
  return problems;
}

/* ------------------------------------------------------------------ main */

export async function renderFormat(fmt: LoadedFormat, opts: RenderOptions = {}): Promise<RenderResult> {
  const { spec, slug } = fmt;
  const log = (m: string) => {
    if (!opts.quiet) console.log(m);
  };

  assertFonts();
  ensureBundle();

  const outDir = opts.outDir ?? path.join(OUT_DIR, slug);
  const framesDir = path.join(outDir, "frames");
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });

  const total = totalFrames(spec);
  const fps = spec.canvas.fps;
  const bg = (spec.theme?.bg ?? "#0b0f14").replace("#", "0x");

  log(`\n▸ ${slug}  ${spec.canvas.durationSec}s @ ${fps}fps = ${total} frames`);
  log(`  variant ${fmt.variantId}`);

  const { page, close } = await openComposition(spec);
  const cdp = await page.context().newCDPSession(page);

  /* Poster and contact-sheet sample points, spread across the clip. */
  const sheetTimes = Array.from({ length: 6 }, (_, i) =>
    Number(((i / 5) * (spec.canvas.durationSec - 1 / fps)).toFixed(3))
  );
  const sheetFrames = sheetTimes.map((s) => Math.min(total - 1, Math.round(s * fps)));
  /* The poster is the card's resting state and the platform's cover image, so
     the format chooses it. 35% is only a fallback for a spec that has not. */
  const posterFrame = Math.min(
    total - 1,
    Math.round((spec.posterSec ?? spec.canvas.durationSec * 0.35) * fps)
  );

  let determinismNote = "not checked";

  try {
    if (opts.stillsOnly) {
      for (const f of [...new Set([...sheetFrames, posterFrame])].sort((a, b) => a - b)) {
        fs.writeFileSync(path.join(framesDir, `${pad6(f)}.png`), await shoot(cdp, page, f));
      }
    } else {
      const t0 = Date.now();
      for (let f = 0; f < total; f++) {
        fs.writeFileSync(path.join(framesDir, `${pad6(f)}.png`), await shoot(cdp, page, f));
        if (!opts.quiet && (f % 60 === 0 || f === total - 1)) {
          const el = (Date.now() - t0) / 1000;
          process.stdout.write(
            `\r  frames ${String(f + 1).padStart(4)}/${total}  ${el.toFixed(1)}s  ` +
              `(${((f + 1) / Math.max(el, 0.001)).toFixed(1)} fps)   `
          );
        }
      }
      if (!opts.quiet) process.stdout.write("\n");
    }

    if (opts.checkDeterminism) {
      /* Seek out of order, then back: if any frame depends on seek history the
         hashes diverge. This is the single most valuable test in the engine. */
      const probes = [0, Math.floor(total * 0.37), Math.floor(total * 0.73), total - 1];
      const first = new Map<number, string>();
      for (const f of probes) {
        first.set(f, crypto.createHash("sha1").update(await shoot(cdp, page, f)).digest("hex"));
      }
      const bad: number[] = [];
      for (const f of [...probes].reverse()) {
        const h = crypto.createHash("sha1").update(await shoot(cdp, page, f)).digest("hex");
        if (h !== first.get(f)) bad.push(f);
      }
      if (bad.length) throw new Error(`non-deterministic frames: ${bad.join(", ")}`);
      determinismNote = `ok (${probes.length} frames re-seeked out of order)`;
      log(`  determinism ${determinismNote}`);
    }
  } finally {
    await close();
  }

  /* --- stills --- */
  const poster = path.join(outDir, "poster.jpg");
  ff(["-i", path.join(framesDir, `${pad6(posterFrame)}.png`), "-q:v", "3", poster], "poster");
  const contact = path.join(outDir, "contact.png");
  buildContactSheet(
    sheetFrames.map((f) => path.join(framesDir, `${pad6(f)}.png`)),
    contact,
    bg
  );
  log(`  poster.jpg + contact.png`);

  let master: string | undefined;
  if (!opts.stillsOnly) {
    master = path.join(outDir, "master.mp4");
    ff(
      [
        "-framerate",
        String(fps),
        "-start_number",
        "0",
        "-i",
        path.join(framesDir, "%06d.png"),
        "-map",
        "0:v",
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-r",
        String(fps),
        "-movflags",
        "+faststart",
        "-metadata",
        `comment=keepwatching variant=${fmt.variantId}`,
        "-metadata",
        `title=${slug}`,
        master,
      ],
      "encode master"
    );
    log(`  master.mp4`);

    const problems = verifyOutput(master, spec);
    if (problems.length) throw new Error(`output verification failed: ${problems.join("; ")}`);
    log(`  verified  ${spec.canvas.w}x${spec.canvas.h} · ${total} frames · ${fps}fps`);

    if (!opts.noPreviews) {
      /* Gallery previews: half resolution, silent, small enough to autoplay on
         a phone over mobile data. */
      const scale = "scale=540:-2";
      ff(
        ["-i", master, "-an", "-vf", scale, "-c:v", "libx264", "-preset", "slow", "-crf", "30",
          "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(outDir, "preview.mp4")],
        "preview mp4"
      );
      ff(
        ["-i", master, "-an", "-vf", scale, "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "38",
          "-row-mt", "1", "-deadline", "good", "-cpu-used", "4", path.join(outDir, "preview.webm")],
        "preview webm"
      );
      log(`  preview.mp4 + preview.webm`);
    }

  }

  if (!opts.keepFrames) fs.rmSync(framesDir, { recursive: true, force: true });

  /* --- sidecar: the variant's birth certificate --- */
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const f of ["master.mp4", "preview.mp4", "preview.webm", "poster.jpg", "contact.png"]) {
    const p = path.join(outDir, f);
    if (fs.existsSync(p)) files[f] = { bytes: fs.statSync(p).size, sha256: sha256(p) };
  }

  const sidecar = path.join(outDir, "variant.json");
  fs.writeFileSync(
    sidecar,
    JSON.stringify(
      {
        variantId: fmt.variantId,
        format: slug,
        formatVersion: spec.version,
        specHash: fmt.specHash,
        renderedAt: new Date().toISOString(),
        canvas: spec.canvas,
        determinism: determinismNote,
        data: spec.data ?? {},
        files,
        note:
          "Publish with this variantId recorded against the upload. `kw measure` needs it " +
          "to attribute a retention curve to a format.",
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  log(`✓ ${rel(outDir)}\n`);

  return {
    slug,
    variantId: fmt.variantId,
    outDir,
    master,
    poster,
    contact,
    sidecar,
    durationSec: spec.canvas.durationSec,
    frames: total,
  };
}
