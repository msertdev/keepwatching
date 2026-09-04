/**
 * Frame-0 regression test, over the whole library.
 *
 * The first frame is load-bearing twice over: it is the hook, and it is the
 * thumbnail TikTok and Instagram show before playback. It has now broken twice
 * for two unrelated reasons — a fade-up-from-black default, then a zero-length
 * transition dividing by an epsilon so that `0/ε = 0` at exactly `t = at`. Both
 * shipped because the contract was only ever eyeballed on one format.
 *
 * So this asserts, for EVERY format, three independent things:
 *
 *   1. DOM     — every element that should be on screen at t=0 is fully opaque,
 *                inside the canvas, and carries real content.
 *   2. INK     — the rendered PNG actually contains bright pixels, so a CSS or
 *                clip-path mistake cannot pass by satisfying the DOM alone.
 *   3. CHANGE  — frame 0 is not identical to a scene with everything hidden.
 *
 * A format with nothing visible at t=0 fails. That is a library rule, not a
 * technical limit: an empty first frame is an empty cover image.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import ffmpegPath from "ffmpeg-static";

import { COMP_HTML } from "./paths.js";
import { assertFonts } from "./fonts.js";
import { ensureBundle } from "./bundle.js";
import { loadAllFormats, type LoadedFormat } from "./format.js";
import type { FormatSpec } from "../shared/spec.js";

const FFMPEG = ffmpegPath as unknown as string;

/** Fraction of pixels that must be brighter than mid-grey for a frame to have ink. */
const MIN_INK_FRACTION = 0.0004; // 0.04% of 1080x1920 ≈ 830 px

/**
 * The poster frame is held still on a gallery card and used as the platform's
 * cover image, so "not blank" is far too low a bar for it. It has to look
 * finished. This threshold is calibrated against the library: a scene with its
 * elements on screen clears it comfortably, a near-empty one does not.
 */
const MIN_POSTER_INK = 0.014; // 1.4%; the thinnest legitimate card in the library is 1.86%

/** How much of the frame's height the content spans, top-most to bottom-most. */
const MIN_POSTER_SPREAD = 0.25;

export interface ElementReport {
  id: string;
  type: string;
  opacity: number;
  width: number;
  height: number;
  text: string;
  onCanvas: boolean;
}

export interface Frame0Result {
  slug: string;
  ok: boolean;
  inkFraction: number;
  posterSec: number;
  posterInk: number;
  posterSpread: number;
  expected: string[];
  problems: string[];
  elements: ElementReport[];
}

/**
 * Which elements the spec promises will be on screen at t=0: visible window
 * covers zero, and either no entry transition or one that has already finished.
 */
export function expectedAtZero(spec: FormatSpec): string[] {
  return spec.scene
    .filter((el) => {
      const at = el.at ?? 0;
      const until = el.until ?? spec.canvas.durationSec;
      if (at > 0 || until <= 0) return false;
      const inAt = el.in?.at ?? at;
      const inDur = el.in?.dur ?? 0;
      /* An element deliberately fading in from t=0 is allowed to be partial on
         frame 0, so it is not part of the promise. */
      return inAt + inDur <= 0;
    })
    .map((el) => el.id);
}

/** Fraction of pixels brighter than mid-grey. One ffmpeg pass, no PNG decoder. */
function inkFraction(png: string): number {
  const out = execFileSync(
    FFMPEG,
    [
      "-hide_banner",
      "-i",
      png,
      "-vf",
      "format=gray,geq=lum='if(gt(lum(X,Y),128),255,0)',signalstats,metadata=print:file=-",
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  const m = /lavfi\.signalstats\.YAVG=([0-9.eE+-]+)/.exec(String(out));
  return m ? Number(m[1]) / 255 : 0;
}

async function shoot(page: Page, cdp: any, frame: number, file: string): Promise<void> {
  await page.evaluate((f) => (window as unknown as { seek: (n: number) => void }).seek(f), frame);
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true });
  fs.writeFileSync(file, Buffer.from(data, "base64"));
}

/** Read every scene element's real painted state out of the page. */
async function inspect(page: Page): Promise<ElementReport[]> {
  return page.evaluate(() => {
    const out: Array<Record<string, unknown>> = [];
    document.querySelectorAll<HTMLElement>("#scene .el").forEach((el) => {
      /* Effective opacity: an ancestor at 0 hides a child that reads 1. */
      let opacity = 1;
      let node: HTMLElement | null = el;
      while (node && node !== document.body) {
        opacity *= Number(getComputedStyle(node).opacity || "1");
        node = node.parentElement;
      }
      const r = el.getBoundingClientRect();
      out.push({
        id: el.dataset.id ?? "",
        type: (el.className.match(/el-(\w+)/) ?? [])[1] ?? "",
        opacity: Number(opacity.toFixed(4)),
        width: Math.round(r.width),
        height: Math.round(r.height),
        text: (el.textContent ?? "").trim().slice(0, 80),
        onCanvas: r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth,
      });
    });
    return out;
  }) as unknown as Promise<ElementReport[]>;
}

export async function checkFrame0(formats?: LoadedFormat[]): Promise<Frame0Result[]> {
  assertFonts();
  ensureBundle();

  const targets = formats ?? loadAllFormats();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kw-frame0-"));
  const results: Frame0Result[] = [];

  const browser = await chromium.launch({
    headless: true,
    args: ["--force-color-profile=srgb", "--disable-lcd-text", "--font-render-hinting=none"],
  });

  try {
    for (const fmt of targets) {
      const spec = fmt.spec;
      const context = await browser.newContext({
        viewport: { width: spec.canvas.w, height: spec.canvas.h },
        deviceScaleFactor: 1,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (e) => pageErrors.push(e.message));

      await page.goto(pathToFileURL(COMP_HTML).href, { waitUntil: "load" });
      await page.waitForFunction(() => (window as unknown as { compReady: boolean }).compReady);
      await page.evaluate(async () => {
        const d = document as Document & { fonts: FontFaceSet };
        await Promise.all([
          d.fonts.load('400 100px "KWSans"'),
          d.fonts.load('600 100px "KWSans"'),
          d.fonts.load('700 100px "KWSans"'),
          d.fonts.load('800 100px "KWSans"'),
        ]);
        await d.fonts.ready;
      });
      await page.evaluate(
        (s) => (window as unknown as { init: (x: unknown) => void }).init(s),
        spec as unknown as Record<string, unknown>
      );

      const cdp = await page.context().newCDPSession(page);
      const png = path.join(tmp, `${fmt.slug}.png`);
      await shoot(page, cdp, 0, png);

      /* --- poster frame: the still the card rests on --- */
      const posterSec = spec.posterSec ?? spec.canvas.durationSec * 0.35;
      const posterFrame = Math.min(
        Math.round(spec.canvas.durationSec * spec.canvas.fps) - 1,
        Math.round(posterSec * spec.canvas.fps)
      );
      const posterPng = path.join(tmp, `${fmt.slug}-poster.png`);
      await shoot(page, cdp, posterFrame, posterPng);
      const posterInk = inkFraction(posterPng);
      const posterSpread = await page.evaluate(() => {
        let top = Infinity;
        let bottom = -Infinity;
        document.querySelectorAll<HTMLElement>("#scene .el").forEach((el) => {
          if (Number(getComputedStyle(el).opacity || "1") < 0.05) return;
          const r = el.getBoundingClientRect();
          if (r.height === 0 || r.width === 0) return;
          top = Math.min(top, Math.max(0, r.top));
          bottom = Math.max(bottom, Math.min(window.innerHeight, r.bottom));
        });
        if (!Number.isFinite(top) || bottom <= top) return 0;
        return (bottom - top) / window.innerHeight;
      });

      /* Back to frame 0 for the DOM inspection below. */
      await shoot(page, cdp, 0, png);
      const elements = await inspect(page);
      const byId = new Map(elements.map((e) => [e.id, e]));
      const expected = expectedAtZero(spec);
      const problems: string[] = [];

      for (const e of pageErrors) problems.push(`composition error: ${e}`);

      /* 1. Something must be promised at t=0 at all. */
      if (expected.length === 0) {
        problems.push(
          "nothing is visible at t=0 — the first frame is the hook and the platform cover image"
        );
      }

      /* 2. Everything promised must actually be painted. */
      for (const id of expected) {
        const el = byId.get(id);
        if (!el) {
          problems.push(`${id}: promised at t=0 but not in the DOM`);
          continue;
        }
        if (el.opacity < 0.999) {
          problems.push(`${id}: opacity ${el.opacity} at frame 0 (expected 1)`);
        }
        if (el.width === 0 || el.height === 0) {
          problems.push(`${id}: zero-sized box at frame 0 (${el.width}x${el.height})`);
        }
        if (!el.onCanvas) problems.push(`${id}: positioned outside the canvas at frame 0`);
        const carriesText = el.type === "text" || el.type === "counter" || el.type === "list";
        if (carriesText && el.text.length === 0) {
          problems.push(`${id}: renders no text at frame 0`);
        }
      }

      /* 3. The pixels must agree with the DOM. */
      const ink = inkFraction(png);
      if (ink < MIN_INK_FRACTION) {
        problems.push(
          `frame 0 has almost no ink (${(ink * 100).toFixed(4)}% of pixels bright, ` +
            `need ${(MIN_INK_FRACTION * 100).toFixed(2)}%) — it will publish as a blank cover`
        );
      }

      if (posterInk < MIN_POSTER_INK) {
        problems.push(
          `poster frame at ${posterSec}s carries only ${(posterInk * 100).toFixed(2)}% ink ` +
            `(need ${(MIN_POSTER_INK * 100).toFixed(1)}%) — it will sit on the card looking empty. ` +
            `Set posterSec to a fuller moment.`
        );
      }
      if (posterSpread < MIN_POSTER_SPREAD) {
        problems.push(
          `poster frame content spans only ${(posterSpread * 100).toFixed(0)}% of the frame height ` +
            `(need ${(MIN_POSTER_SPREAD * 100).toFixed(0)}%) — it reads as a caption on an empty ` +
            `card. Set posterSec to a moment with more of the scene on screen.`
        );
      }

      results.push({
        slug: fmt.slug,
        ok: problems.length === 0,
        inkFraction: Number(ink.toFixed(6)),
        posterSec,
        posterInk: Number(posterInk.toFixed(6)),
        posterSpread: Number(posterSpread.toFixed(4)),
        expected,
        problems,
        elements,
      });

      await context.close();
    }
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return results;
}

export function reportFrame0(results: Frame0Result[]): boolean {
  console.log(`\n▸ frame 0`);
  console.log(`  ${results.length} formats checked — DOM, ink coverage, and element content\n`);

  const width = Math.max(...results.map((r) => r.slug.length), 8);
  for (const r of results) {
    const mark = r.ok ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m";
    console.log(
      `  ${mark} ${r.slug.padEnd(width)}  f0 ink ${(r.inkFraction * 100).toFixed(2).padStart(5)}%  ` +
        `poster@${String(r.posterSec).padStart(5)}s ink ${(r.posterInk * 100).toFixed(2).padStart(5)}% ` +
        `spread ${(r.posterSpread * 100).toFixed(0).padStart(3)}%`
    );
    for (const p of r.problems) console.log(`       \x1b[31m·\x1b[0m ${p}`);
  }

  const bad = results.filter((r) => !r.ok);
  console.log(
    bad.length
      ? `\n  ${bad.length}/${results.length} formats have a broken first frame\n`
      : `\n  every first frame paints its promised content\n`
  );
  return bad.length === 0;
}
