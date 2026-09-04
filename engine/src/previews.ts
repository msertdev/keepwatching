/**
 * Committed gallery previews, and the drift check that keeps them honest.
 *
 * The previews are the product's visible surface, so they live in the repo
 * rather than being rebuilt on every deploy. That trade has one cost: a
 * committed file can fall out of step with the spec that produced it, and a
 * stale preview shipping quietly would undo the point of the whole repo.
 *
 * The guard is the variant id — `slug@version+hash-of-the-spec`, the same
 * identity used to attribute a measurement. `manifest.json` records which
 * variant produced each committed preview. If the spec changes, the hash
 * changes, the manifest no longer matches, and CI fails.
 *
 * File hashes are recorded too, but for a different purpose: they detect a
 * committed file that was corrupted or edited by hand. They are never used to
 * decide whether a re-render is needed, because an encoder is not guaranteed
 * to produce identical bytes across platforms — only identical frames.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { OUT_DIR, SITE_DIR } from "./paths.js";
import type { LoadedFormat } from "./format.js";

export const PREVIEW_DIR = path.join(SITE_DIR, "previews");
export const MANIFEST_FILE = path.join(PREVIEW_DIR, "manifest.json");

/** The three files a card needs: two codecs and a poster. */
export const previewFiles = (slug: string): string[] => [
  `${slug}.mp4`,
  `${slug}.webm`,
  `${slug}.jpg`,
];

/** Where `kw render` leaves them, and what each becomes in site/previews. */
const OUT_SOURCES = (slug: string): Array<[string, string]> => [
  [path.join(OUT_DIR, slug, "preview.mp4"), `${slug}.mp4`],
  [path.join(OUT_DIR, slug, "preview.webm"), `${slug}.webm`],
  [path.join(OUT_DIR, slug, "poster.jpg"), `${slug}.jpg`],
];

export interface PreviewEntry {
  variantId: string;
  renderedAt: string;
  files: Record<string, { bytes: number; sha256: string }>;
}

export interface Manifest {
  generatedAt: string;
  note: string;
  previews: Record<string, PreviewEntry>;
}

const sha256 = (file: string): string =>
  crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export function readManifest(): Manifest {
  if (!fs.existsSync(MANIFEST_FILE)) {
    return { generatedAt: "", note: "", previews: {} };
  }
  return JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8")) as Manifest;
}

export function writeManifest(m: Manifest): void {
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  const ordered: Manifest = {
    generatedAt: m.generatedAt,
    note:
      "Which variant produced each committed preview. `kw previews check` fails when a " +
      "format's spec no longer hashes to the variant recorded here, because that means the " +
      "committed preview is stale. Written by `kw gallery`, never by hand.",
    previews: Object.fromEntries(
      Object.keys(m.previews)
        .sort()
        .map((k) => [k, m.previews[k]])
    ),
  };
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(ordered, null, 2) + "\n", "utf8");
}

export type PreviewState =
  /** Committed preview matches the current spec. Nothing to do. */
  | "ok"
  /** A fresh render for this exact variant is sitting in out/; just copy it. */
  | "syncable"
  /** No preview committed for this format at all. */
  | "missing"
  /** Committed, but the spec has changed since it was rendered. */
  | "stale";

export interface PreviewStatus {
  slug: string;
  state: PreviewState;
  /** The variant recorded in the manifest, when there is one. */
  recorded?: string;
  current: string;
}

export function previewStatus(fmt: LoadedFormat, manifest = readManifest()): PreviewStatus {
  const entry = manifest.previews[fmt.slug];
  const filesPresent = previewFiles(fmt.slug).every((f) =>
    fs.existsSync(path.join(PREVIEW_DIR, f))
  );

  if (filesPresent && entry?.variantId === fmt.variantId) {
    return { slug: fmt.slug, state: "ok", recorded: entry.variantId, current: fmt.variantId };
  }

  /* A render for this exact variant may already exist in out/ — from
     `kw render --all`, or from the run that produced the stale commit. Copying
     is seconds; re-rendering is half a minute. */
  const sidecar = path.join(OUT_DIR, fmt.slug, "variant.json");
  if (fs.existsSync(sidecar)) {
    try {
      const v = JSON.parse(fs.readFileSync(sidecar, "utf8")) as { variantId?: string };
      const outFilesPresent = OUT_SOURCES(fmt.slug).every(([from]) => fs.existsSync(from));
      if (v.variantId === fmt.variantId && outFilesPresent) {
        return {
          slug: fmt.slug,
          state: "syncable",
          recorded: entry?.variantId,
          current: fmt.variantId,
        };
      }
    } catch {
      /* A malformed sidecar just means we cannot shortcut; fall through. */
    }
  }

  return {
    slug: fmt.slug,
    state: filesPresent ? "stale" : "missing",
    recorded: entry?.variantId,
    current: fmt.variantId,
  };
}

/** Copy a rendered format out of out/ into the committed preview set. */
export function syncPreview(fmt: LoadedFormat, manifest: Manifest): void {
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  const files: PreviewEntry["files"] = {};

  for (const [from, to] of OUT_SOURCES(fmt.slug)) {
    if (!fs.existsSync(from)) continue;
    const dest = path.join(PREVIEW_DIR, to);
    fs.copyFileSync(from, dest);
    files[to] = { bytes: fs.statSync(dest).size, sha256: sha256(dest) };
  }

  manifest.previews[fmt.slug] = {
    variantId: fmt.variantId,
    renderedAt: new Date().toISOString().slice(0, 10),
    files,
  };
}

/* ------------------------------------------------------------------ check */

export interface PreviewProblem {
  slug: string;
  kind: "missing" | "stale" | "corrupt" | "orphan";
  detail: string;
}

/**
 * The CI guard. Every committed preview must belong to the spec that is
 * currently in the tree.
 */
export function checkPreviews(formats: LoadedFormat[]): PreviewProblem[] {
  const manifest = readManifest();
  const problems: PreviewProblem[] = [];
  const known = new Set<string>();

  for (const fmt of formats) {
    known.add(fmt.slug);
    const entry = manifest.previews[fmt.slug];

    if (!entry) {
      problems.push({
        slug: fmt.slug,
        kind: "missing",
        detail: "no manifest entry — the preview was never committed",
      });
      continue;
    }

    if (entry.variantId !== fmt.variantId) {
      problems.push({
        slug: fmt.slug,
        kind: "stale",
        detail:
          `spec now hashes to ${fmt.variantId}, but the committed preview was rendered ` +
          `from ${entry.variantId}`,
      });
      continue;
    }

    for (const name of previewFiles(fmt.slug)) {
      const file = path.join(PREVIEW_DIR, name);
      if (!fs.existsSync(file)) {
        problems.push({ slug: fmt.slug, kind: "missing", detail: `${name} is not committed` });
        continue;
      }
      const recorded = entry.files[name];
      if (!recorded) continue;
      if (sha256(file) !== recorded.sha256) {
        problems.push({
          slug: fmt.slug,
          kind: "corrupt",
          detail: `${name} does not match the hash recorded when it was rendered`,
        });
      }
    }
  }

  /* A preview for a format that no longer exists is dead weight in the repo
     and, worse, still visible to anyone browsing the directory. */
  for (const slug of Object.keys(manifest.previews)) {
    if (!known.has(slug)) {
      problems.push({
        slug,
        kind: "orphan",
        detail: "manifest lists a preview for a format that is no longer in formats/",
      });
    }
  }

  return problems;
}

export function reportPreviewCheck(problems: PreviewProblem[], total: number): boolean {
  console.log(`\n▸ previews`);
  console.log(`  ${total} formats, checked against site/previews/manifest.json\n`);

  if (problems.length === 0) {
    console.log(`  every committed preview matches the spec that produced it\n`);
    return true;
  }

  for (const p of problems) {
    console.log(`  \x1b[31m${p.kind.padEnd(7)}\x1b[0m ${p.slug}`);
    console.log(`          ${p.detail}`);
  }
  console.log(
    `\n  \x1b[31m${problems.length} problem(s).\x1b[0m A committed preview no longer matches its ` +
      `spec, so the gallery would publish a clip that is not what the format now renders.\n`
  );
  console.log(`  Re-render and commit the result:\n`);
  console.log(`      npx kw gallery --no-serve && git add site/previews\n`);
  return false;
}
