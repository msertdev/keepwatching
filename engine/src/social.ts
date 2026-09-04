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

import crypto from "node:crypto";

import { COMP_HTML, ROOT, SITE_DIR, rel } from "./paths.js";
import { assertFonts } from "./fonts.js";
import { ensureBundle } from "./bundle.js";
import { loadAllFormats, validateSpec } from "./format.js";
import type { FormatSpec } from "../shared/spec.js";

export const CARD_SPEC = path.join(ROOT, "engine", "social", "card.json");
export const CARD_PNG = path.join(SITE_DIR, "social-card.png");
export const CARD_MANIFEST = path.join(ROOT, "engine", "social", "manifest.json");

export interface CardManifest {
  generatedAt: string;
  note: string;
  /** Hash of the card's own layout spec, so editing the card is drift too. */
  cardSpecHash: string;
  /** Which format each thumbnail came from, and the variant that produced it. */
  featured: Array<{ slug: string; variantId: string }>;
}

/** Format slugs the card shows, read from its own image elements. */
export function featuredSlugs(spec: FormatSpec): string[] {
  return spec.scene
    .filter((el) => el.type === "image")
    .map((el) => path.basename((el as unknown as { src: string }).src, ".jpg"));
}

/** Hash of the card spec with the volatile bits excluded — layout and copy only. */
function cardSpecHash(spec: FormatSpec): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(spec))
    .digest("hex")
    .slice(0, 12);
}

export function readCardManifest(): CardManifest | null {
  if (!fs.existsSync(CARD_MANIFEST)) return null;
  return JSON.parse(fs.readFileSync(CARD_MANIFEST, "utf8")) as CardManifest;
}

/**
 * The card is built from committed preview frames, so it drifts exactly the way
 * a committed preview does: change a featured format's spec and the picture
 * still shows the old one. Every other artefact in the repo has a guard; this
 * closes the last gap.
 */
export function checkSocialCard(): string[] {
  const problems: string[] = [];
  if (!fs.existsSync(CARD_PNG)) {
    problems.push("site/social-card.png is missing");
  }

  const manifest = readCardManifest();
  if (!manifest) {
    return [...problems, "engine/social/manifest.json is missing — run `npx kw social`"];
  }

  const spec = JSON.parse(fs.readFileSync(CARD_SPEC, "utf8")) as FormatSpec;
  if (manifest.cardSpecHash !== cardSpecHash(spec)) {
    problems.push(
      "the card's own layout spec changed since the image was rendered " +
        `(${manifest.cardSpecHash} -> ${cardSpecHash(spec)})`
    );
  }

  const byslug = new Map(loadAllFormats().map((f) => [f.slug, f]));
  const featured = featuredSlugs(spec);

  const recorded = new Set(manifest.featured.map((f) => f.slug));
  for (const slug of featured) {
    if (!recorded.has(slug)) {
      problems.push(`the card now features "${slug}", which the manifest does not record`);
    }
  }
  for (const entry of manifest.featured) {
    if (!featured.includes(entry.slug)) {
      problems.push(`the manifest records "${entry.slug}", which the card no longer features`);
      continue;
    }
    const fmt = byslug.get(entry.slug);
    if (!fmt) {
      problems.push(`the card features "${entry.slug}", which is no longer a format`);
      continue;
    }
    if (fmt.variantId !== entry.variantId) {
      problems.push(
        `"${entry.slug}" changed since the card was rendered: ` +
          `${entry.variantId} -> ${fmt.variantId}`
      );
    }
  }

  return problems;
}

export function reportSocialCard(problems: string[]): boolean {
  console.log(`\n▸ social card`);
  if (problems.length === 0) {
    console.log(`  the card matches the formats and layout it was rendered from\n`);
    return true;
  }
  for (const p of problems) console.log(`  \x1b[31m✗\x1b[0m ${p}`);
  console.log(
    `\n  \x1b[31m${problems.length} problem(s).\x1b[0m The shared link would show a picture ` +
      `of something the repo no longer contains.\n`
  );
  console.log(`  Re-render and commit it:\n`);
  console.log(`      npx kw social && git add site/social-card.png engine/social/manifest.json\n`);
  return false;
}

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
    const tmpPng = `${CARD_PNG}.tmp.png`;
    execFileSync(ffmpegPath as unknown as string, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", CARD_PNG, "-vf", "format=rgb24", "-compression_level", "9", tmpPng,
    ]);
    fs.renameSync(tmpPng, CARD_PNG);
  } catch {
    /* Optimisation only; the screenshot is already valid. */
  }

  /* Record what the picture is of, so a change to any featured format shows up
     as drift rather than as a quietly stale image. */
  const byslug = new Map(loadAllFormats().map((f) => [f.slug, f]));
  const manifest: CardManifest = {
    generatedAt: new Date().toISOString().slice(0, 10),
    note:
      "Which formats the social card shows and which variant produced each thumbnail. " +
      "`kw social check` fails when one of them no longer hashes to the variant recorded " +
      "here, because the shared link would then advertise a clip the repo no longer renders.",
    cardSpecHash: cardSpecHash(spec),
    featured: featuredSlugs(spec).map((slug) => ({
      slug,
      variantId: byslug.get(slug)?.variantId ?? "unknown",
    })),
  };
  fs.writeFileSync(CARD_MANIFEST, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const bytes = fs.statSync(CARD_PNG).size;
  console.log(`\n▸ social card`);
  console.log(`  ${spec.canvas.w}x${spec.canvas.h}, ${(bytes / 1024).toFixed(0)} KB`);
  console.log(`  featuring: ${manifest.featured.map((f) => f.slug).join(", ")}`);
  console.log(`  -> ${rel(CARD_PNG)}`);
  console.log(`  -> ${rel(CARD_MANIFEST)}\n`);
  return CARD_PNG;
}
