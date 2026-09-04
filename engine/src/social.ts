/**
 * The social preview card, rendered by the same composition engine as the clips.
 *
 * A link shared without a preview image loses clicks, and hand-making one in a
 * design tool would mean a card that drifts from the library it advertises. This
 * uses the engine's own scene graph and the actual committed preview frames, so
 * the picture is made of the thing it is advertising.
 *
 * It is deliberately not a format: 1280x640 is landscape, and every format in
 * the library must be vertical. `validateSpec` is called with the vertical rule
 * relaxed for this one file and nothing else.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import ffmpegPath from "ffmpeg-static";

import { COMP_HTML, ROOT, SITE_DIR, rel } from "./paths.js";
import { assertFonts } from "./fonts.js";
import { ensureBundle } from "./bundle.js";
import { validateSpec } from "./format.js";
import type { FormatSpec } from "../shared/spec.js";

export const CARD_SPEC = path.join(ROOT, "engine", "social", "card.json");
export const CARD_PNG = path.join(SITE_DIR, "social-card.png");

export async function renderSocialCard(): Promise<string> {
  assertFonts();
  ensureBundle();

  const spec = JSON.parse(fs.readFileSync(CARD_SPEC, "utf8")) as FormatSpec;
  validateSpec(spec, undefined, { requireVertical: false });

  /* Every image the card shows must already be committed, or the card would
     advertise frames that do not exist. */
  for (const el of spec.scene) {
    if (el.type !== "image") continue;
    const src = (el as unknown as { src: string }).src;
    const resolved = path.resolve(path.dirname(COMP_HTML), src);
    if (!fs.existsSync(resolved)) {
      throw new Error(
        `social card references a preview that is not there: ${rel(resolved)}\n` +
          `Run \`npx kw gallery --no-serve\` first.`
      );
    }
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--force-color-profile=srgb", "--disable-lcd-text", "--font-render-hinting=none"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: spec.canvas.w, height: spec.canvas.h },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    });
    await page.goto(pathToFileURL(COMP_HTML).href, { waitUntil: "load" });
    await page.waitForFunction(() => (window as unknown as { compReady: boolean }).compReady);
    await page.evaluate(async () => {
      const d = document as Document & { fonts: FontFaceSet };
      await Promise.all([
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
    await page.evaluate(() => (window as unknown as { seek: (n: number) => void }).seek(0));
    /* The <img> tags load from disk after init; wait for them or the card ships
       with empty rectangles where the previews should be. */
    await page.waitForFunction(() =>
      Array.from(document.images).every((i) => i.complete && i.naturalWidth > 0)
    );

    fs.mkdirSync(SITE_DIR, { recursive: true });
    await page.screenshot({ path: CARD_PNG });
  } finally {
    await browser.close();
  }

  /* Squeeze it: GitHub and the link unfurlers re-encode anyway, and a smaller
     file is one less reason for a card not to appear. */
  try {
    execFileSync(ffmpegPath as unknown as string, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", CARD_PNG, "-vf", "format=rgb24", "-compression_level", "9", CARD_PNG,
    ]);
  } catch {
    /* Optimisation only; the screenshot is already valid. */
  }

  const bytes = fs.statSync(CARD_PNG).size;
  console.log(`\n▸ social card`);
  console.log(`  ${spec.canvas.w}x${spec.canvas.h}, ${(bytes / 1024).toFixed(0)} KB`);
  console.log(`  -> ${rel(CARD_PNG)}\n`);
  return CARD_PNG;
}
