/**
 * Fetch Inter (SIL Open Font License 1.1) into engine/assets/fonts so the
 * composition never depends on a system font or a CDN — a missing font would
 * silently change every measurement in the repo.
 *
 *   kw setup
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import { FONT_DIR } from "./paths.js";

const VERSION = "4.1";
const ZIP_URL = `https://github.com/rsms/inter/releases/download/v${VERSION}/Inter-${VERSION}.zip`;

export const REQUIRED_FONTS = [
  "Inter-Regular.woff2",
  "Inter-SemiBold.woff2",
  "Inter-Bold.woff2",
  "Inter-ExtraBold.woff2",
];

export function missingFonts(): string[] {
  return REQUIRED_FONTS.filter((f) => !fs.existsSync(path.join(FONT_DIR, f)));
}

export function assertFonts(): void {
  const missing = missingFonts();
  if (missing.length) {
    throw new Error(
      `Missing fonts in engine/assets/fonts: ${missing.join(", ")}\n` +
        `Run:  npm run setup   (downloads Inter 4.1, SIL OFL 1.1)`
    );
  }
}

/* ------------------------------------------------------------------- zip */

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  offset: number;
}

/**
 * Minimal ZIP reader — central directory only, store and deflate.
 * Avoids shelling out to PowerShell/unzip, which is the difference between
 * "works on my machine" and "works in CI on three operating systems".
 */
function readZip(buf: Buffer): ZipEntry[] {
  /* End of central directory record: signature 0x06054b50, scanned backwards. */
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory record)");

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressedSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extract(buf: Buffer, entry: ZipEntry): Buffer {
  const p = entry.offset;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`bad local header for ${entry.name}`);
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`);
}

/* ------------------------------------------------------------------ main */

export async function installFonts(): Promise<void> {
  fs.mkdirSync(FONT_DIR, { recursive: true });

  if (missingFonts().length === 0) {
    console.log(`  fonts already present (${REQUIRED_FONTS.join(", ")})`);
    return;
  }

  console.log(`  downloading Inter ${VERSION} …`);
  const res = await fetch(ZIP_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`font download failed: HTTP ${res.status} ${ZIP_URL}`);
  const buf = Buffer.from(await res.arrayBuffer());

  const entries = readZip(buf);
  const byBase = new Map<string, ZipEntry>();
  for (const e of entries) {
    const base = e.name.split("/").pop() ?? "";
    /* Prefer the web/ build; only fill from elsewhere if web/ has no copy. */
    if (!byBase.has(base) || e.name.includes("/web/")) byBase.set(base, e);
  }

  for (const want of REQUIRED_FONTS) {
    const e = byBase.get(want);
    if (!e) throw new Error(`Inter ${VERSION} release does not contain ${want}`);
    fs.writeFileSync(path.join(FONT_DIR, want), extract(buf, e));
    console.log(`    ${want}`);
  }

  const lic = byBase.get("LICENSE.txt") ?? byBase.get("OFL.txt");
  if (lic) fs.writeFileSync(path.join(FONT_DIR, "OFL.txt"), extract(buf, lic));

  console.log(`  Inter installed to engine/assets/fonts (SIL OFL 1.1)`);
}
