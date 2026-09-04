/**
 * A small, dependency-free CSV reader.
 *
 * Analytics exports are messy in predictable ways: a UTF-8 BOM, quoted fields
 * containing commas, thousands separators inside numbers, a stray "Total" row at
 * the top, and localised percentage signs. This handles all of that and nothing
 * more clever than that.
 */

export type Row = Record<string, string>;

export function parseCsv(text: string): Row[] {
  const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += ch;
  }
  if (field.length || record.length) {
    record.push(field);
    records.push(record);
  }

  const rows = records.filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length < 2) return [];

  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o: Row = {};
    header.forEach((h, i) => (o[h] = (r[i] ?? "").trim()));
    return o;
  });
}

/** Case- and punctuation-insensitive column lookup: "Video views" ≈ "video_views". */
export function pick(row: Row, ...names: string[]): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const index = new Map(Object.keys(row).map((k) => [norm(k), k]));
  for (const n of names) {
    const hit = index.get(norm(n));
    if (hit !== undefined && row[hit] !== "") return row[hit];
  }
  /* Fall back to a prefix match — exports append units, e.g.
     "Watch time (hours)" or "Average view duration". */
  for (const n of names) {
    const target = norm(n);
    for (const [k, orig] of index) {
      if (k.startsWith(target) && row[orig] !== "") return row[orig];
    }
  }
  return undefined;
}

/** "1,234", "12.5%", "0:01:23" and "" all become sensible numbers or undefined. */
export function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const s = v.trim();
  if (s === "" || s === "-" || s.toLowerCase() === "n/a") return undefined;
  if (/^\d+:\d{1,2}(:\d{1,2})?$/.test(s)) return duration(s);
  const cleaned = s.replace(/[%\s,]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/** "0:23", "1:02:03" -> seconds. */
export function duration(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const parts = v.trim().split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

export const median = (xs: number[]): number | null => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};

export const mean = (xs: number[]): number | null => {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
