/**
 * A small, dependency-free CSV reader.
 *
 * Analytics exports are messy in predictable ways: a UTF-8 BOM, quoted fields
 * containing separators, a stray "Total" row, localised headers, and — the one
 * that silently corrupts numbers — locale-dependent separators. A Turkish
 * YouTube Studio export is semicolon-delimited with comma decimals
 * (`1.234,56`); an English one is comma-delimited with dot decimals
 * (`1,234.56`). Guessing wrong turns 1.234,56 into 1.234 without erroring,
 * which is exactly the kind of quiet wrongness this repo exists to avoid.
 *
 * So the delimiter is sniffed per file and the decimal separator is inferred
 * per value, and anything ambiguous returns undefined rather than a guess.
 */

export type Row = Record<string, string>;

/** Pick the delimiter that yields the most consistent column count. */
export function sniffDelimiter(text: string): string {
  const sample = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  if (sample.length === 0) return ",";

  let best = ",";
  let bestScore = -1;
  for (const d of [",", ";", "\t"]) {
    const counts = sample.map((line) => splitLine(line, d).length);
    const first = counts[0];
    if (first < 2) continue;
    /* Reward many columns, punish rows that disagree about how many. */
    const consistent = counts.filter((c) => c === first).length / counts.length;
    const score = consistent * 100 + first;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function splitLine(line: string, delim: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      out.push(field);
      field = "";
    } else field += ch;
  }
  out.push(field);
  return out;
}

export function parseCsv(text: string, delimiter?: string): Row[] {
  const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const delim = delimiter ?? sniffDelimiter(clean);

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
    else if (ch === delim) {
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

/**
 * Case-, accent- and punctuation-insensitive column lookup, so "Görüntüleme",
 * "Goruntuleme" and "goruntuleme" all resolve to the same column.
 */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/İ/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]/g, "");

export function pick(row: Row, ...names: string[]): string | undefined {
  const index = new Map(Object.keys(row).map((k) => [norm(k), k]));
  for (const n of names) {
    const hit = index.get(norm(n));
    if (hit !== undefined && row[hit] !== "") return row[hit];
  }
  /* Prefix fallback — exports append units, e.g. "İzlenme süresi (saat)". */
  for (const n of names) {
    const target = norm(n);
    for (const [k, orig] of index) {
      if (k.startsWith(target) && row[orig] !== "") return row[orig];
    }
  }
  return undefined;
}

/**
 * Parse a number without guessing a locale.
 *
 * Handles "1,234.56", "1.234,56", "1234", "12,5", "45.2", "12%" and "0:01:23".
 * Returns undefined when the value is genuinely ambiguous rather than picking
 * an interpretation — a silently mis-parsed number is worse than a missing one.
 */
export function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  let s = v.trim();
  if (s === "" || s === "-" || s === "—" || s.toLowerCase() === "n/a") return undefined;
  if (/^\d+:\d{1,2}(:\d{1,2})?$/.test(s)) return duration(s);

  s = s.replace(/%/g, "").replace(/\s/g, "").replace(/ /g, "");
  const neg = /^-/.test(s);
  s = s.replace(/^[-+]/, "");
  if (!/^[\d.,]+$/.test(s)) return undefined;

  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;
  let normalised: string;

  if (dots && commas) {
    /* Both present: whichever comes last is the decimal separator. */
    normalised =
      s.lastIndexOf(",") > s.lastIndexOf(".")
        ? s.replace(/\./g, "").replace(",", ".")
        : s.replace(/,/g, "");
  } else if (commas) {
    const [head, ...rest] = s.split(",");
    if (rest.length === 1 && rest[0].length !== 3) normalised = `${head}.${rest[0]}`;
    else if (rest.length === 1 && rest[0].length === 3) {
      /* "1,234" is 1234 in en and 1.234 in tr. Genuinely ambiguous. */
      return undefined;
    } else normalised = s.replace(/,/g, "");
  } else if (dots) {
    const [head, ...rest] = s.split(".");
    if (rest.length === 1 && rest[0].length !== 3) normalised = `${head}.${rest[0]}`;
    else if (rest.length === 1 && rest[0].length === 3) return undefined; // "1.234"
    else normalised = s.replace(/\./g, "");
  } else normalised = s;

  const n = Number(normalised);
  return Number.isFinite(n) ? (neg ? -n : n) : undefined;
}

/** Like num(), but resolves the ambiguous thousands case using a hint. */
export function numWithLocale(
  v: string | undefined,
  decimal: "." | "," | undefined
): number | undefined {
  if (v === undefined) return undefined;
  const direct = num(v);
  if (direct !== undefined) return direct;
  if (!decimal) return undefined;
  const s = v.trim().replace(/%/g, "").replace(/\s/g, "");
  const cleaned =
    decimal === ","
      ? s.replace(/\./g, "").replace(",", ".")
      : s.replace(/,/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Infer a file's decimal separator from values that are unambiguous, so the
 * ambiguous ones ("1,234") can be resolved without guessing per value.
 */
export function inferDecimalSeparator(rows: Row[]): "." | "," | undefined {
  let dot = 0;
  let comma = 0;
  for (const row of rows) {
    for (const raw of Object.values(row)) {
      const s = raw.trim();
      if (!/^[\d.,]+$/.test(s)) continue;
      if (/,\d{1,2}$/.test(s) && !/\.\d/.test(s)) comma++;
      if (/\.\d{1,2}$/.test(s) && !/,\d/.test(s)) dot++;
      if (/\.\d{3},/.test(s)) comma++;
      if (/,\d{3}\./.test(s)) dot++;
    }
  }
  if (comma > dot) return ",";
  if (dot > comma) return ".";
  return undefined;
}

/** "0:23", "1:02:03" -> seconds. */
export function duration(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(":").map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/**
 * Dates arrive as "2026-09-03", "03.09.2026", "Sep 3, 2026" and "3 Eylül".
 *
 * Every branch builds the ISO string from parsed components. Nothing goes
 * through `new Date(...).toISOString()`, because that reads the string as local
 * midnight and re-expresses it in UTC — east of Greenwich this silently shifts
 * every date back a day, which would then propagate into the age windows.
 *
 * A date with no year cannot be resolved without help, so it returns
 * `yearInferred: true` only when a context year is supplied, and the caller is
 * expected to record that the year was not in the data.
 */
const EN_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const TR_MONTHS: Record<string, number> = {
  oca: 1, sub: 2, mar: 3, nis: 4, may: 5, haz: 6,
  tem: 7, agu: 8, eyl: 9, eki: 10, kas: 11, ara: 12,
};

export interface DateParse {
  iso: string;
  /** The source had no year; `contextYear` supplied it. */
  yearInferred?: boolean;
}

const iso = (y: number | string, m: number, d: number | string): string =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Turkish month names collide with English on "mar" and "may" only, and both
 *  agree there, so a single lookup over both tables is safe. */
function monthFromName(name: string): number | undefined {
  const key = norm(name).slice(0, 3);
  return EN_MONTHS[key] ?? TR_MONTHS[key];
}

export function parseDate(v: string | undefined, contextYear?: number): DateParse | undefined {
  if (!v) return undefined;
  const s = v.trim();
  if (!s) return undefined;

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return { iso: iso(m[1], Number(m[2]), m[3]) };

  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})/.exec(s);
  if (m) return { iso: iso(m[3], Number(m[2]), m[1]) };

  /* "Sep 3, 2026" and "September 3 2026" */
  m = /^([A-Za-z]+)\s+(\d{1,2})(?:\s*,)?\s+(\d{4})/.exec(s);
  if (m) {
    const month = monthFromName(m[1]);
    if (month) return { iso: iso(m[3], month, m[2]) };
  }

  /* "3 Eylül 2026" */
  m = /^(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(\d{4})/.exec(s);
  if (m) {
    const month = monthFromName(m[2]);
    if (month) return { iso: iso(m[3], month, m[1]) };
  }

  /* "3 Eylül" / "Sep 3" — no year in the data. */
  m = /^(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)$/.exec(s);
  if (m && contextYear) {
    const month = monthFromName(m[2]);
    if (month) return { iso: iso(contextYear, month, m[1]), yearInferred: true };
  }
  m = /^([A-Za-z]+)\s+(\d{1,2})$/.exec(s);
  if (m && contextYear) {
    const month = monthFromName(m[1]);
    if (month) return { iso: iso(contextYear, month, m[2]), yearInferred: true };
  }

  return undefined;
}

export function isoDate(v: string | undefined, contextYear?: number): string | undefined {
  return parseDate(v, contextYear)?.iso;
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
