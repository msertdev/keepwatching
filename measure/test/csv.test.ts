/**
 * Tests for the reader that turns an analytics export into numbers.
 *
 * This module is the one place in the repo where a real bug has shipped: a
 * YouTube export's `"Sep 3, 2026"` went through `new Date(...).toISOString()`
 * and came back a day early, which made an open 48-hour window look complete.
 * Nothing crashed and nothing warned. It was caught by hand, and until this
 * file existed nothing would have caught it twice.
 *
 * Two things follow from that, and they are the whole design of these tests:
 *
 *   1. Every branch that produces a date is asserted, not just the happy one.
 *   2. CI runs this file under four TZ values (see .github/workflows/ci.yml).
 *      Of those four, UTC is the only one in which the broken code returned the
 *      right day — put the bug back and the suite is 35/35 green under TZ=UTC
 *      and three-down under the other three. A date suite that only ever runs
 *      in UTC cannot fail the way this bug failed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  duration,
  inferDecimalSeparator,
  isoDate,
  mean,
  median,
  num,
  numWithLocale,
  parseCsv,
  parseDate,
  pick,
  sniffDelimiter,
} from "../src/csv.js";

describe("parseDate", () => {
  /* The regression. In UTC+3 the old implementation returned 2026-09-02. */
  test("an English month-name date keeps its own day, in any timezone", () => {
    assert.equal(parseDate("Sep 3, 2026")?.iso, "2026-09-03");
    assert.equal(parseDate("September 3 2026")?.iso, "2026-09-03");
    assert.equal(parseDate("Jan 1, 2026")?.iso, "2026-01-01");
    assert.equal(parseDate("Dec 31, 2026")?.iso, "2026-12-31");
  });

  test("a Turkish month-name date keeps its own day", () => {
    assert.equal(parseDate("3 Eylül 2026")?.iso, "2026-09-03");
    assert.equal(parseDate("1 Ocak 2026")?.iso, "2026-01-01");
    assert.equal(parseDate("31 Aralık 2026")?.iso, "2026-12-31");
  });

  test("a dotted date is day-first, which is what the exports that use it mean", () => {
    assert.equal(parseDate("03.09.2026")?.iso, "2026-09-03");
    assert.equal(parseDate("3/9/2026")?.iso, "2026-09-03");
  });

  test("an ISO date passes through unchanged", () => {
    assert.equal(parseDate("2026-09-03")?.iso, "2026-09-03");
    assert.equal(parseDate("2026-9-3")?.iso, "2026-09-03");
    assert.equal(parseDate("2026-09-03T09:00:00Z")?.iso, "2026-09-03");
  });

  test("a date with no year is refused unless a context year is supplied", () => {
    assert.equal(parseDate("3 Eylül"), undefined);
    assert.equal(parseDate("Sep 3"), undefined);

    const tr = parseDate("3 Eylül", 2026);
    assert.equal(tr?.iso, "2026-09-03");
    assert.equal(
      tr?.yearInferred,
      true,
      "the caller must be able to see the year was not in the data"
    );

    const en = parseDate("Sep 3", 2026);
    assert.equal(en?.iso, "2026-09-03");
    assert.equal(en?.yearInferred, true);
  });

  test("a year that came from the data is never marked inferred", () => {
    assert.equal(parseDate("Sep 3, 2026", 2020)?.yearInferred, undefined);
    assert.equal(parseDate("Sep 3, 2026", 2020)?.iso, "2026-09-03");
  });

  test("what it cannot read, it refuses", () => {
    for (const v of [undefined, "", "   ", "not a date", "Smarch 3, 2026", "3 Zzz 2026"]) {
      assert.equal(parseDate(v), undefined, `expected ${JSON.stringify(v)} to be refused`);
    }
  });

  test("isoDate is parseDate without the provenance flag", () => {
    assert.equal(isoDate("Sep 3, 2026"), "2026-09-03");
    assert.equal(isoDate("nonsense"), undefined);
  });
});

describe("num", () => {
  test("reads both locales when the value says which it is", () => {
    assert.equal(num("1,234.56"), 1234.56);
    assert.equal(num("1.234,56"), 1234.56);
    assert.equal(num("12,5"), 12.5);
    assert.equal(num("45.2"), 45.2);
    assert.equal(num("1234"), 1234);
    assert.equal(num("1 234,5"), 1234.5);
  });

  test("refuses the genuinely ambiguous thousands case rather than guessing", () => {
    /* "1,234" is 1234 in en and 1.234 in tr, and nothing in the value says
       which. A silently mis-parsed number is worse than a missing one. */
    assert.equal(num("1,234"), undefined);
    assert.equal(num("1.234"), undefined);
  });

  test("strips a percent sign and keeps the number", () => {
    assert.equal(num("12%"), 12);
    assert.equal(num("23,1%"), 23.1);
  });

  test("reads a clock value as seconds", () => {
    assert.equal(num("0:01:23"), 83);
    assert.equal(num("0:35"), 35);
  });

  test("negatives keep their sign", () => {
    assert.equal(num("-12,5"), -12.5);
    assert.equal(num("-1,234.56"), -1234.56);
  });

  test("an empty or placeholder cell is missing, not zero", () => {
    for (const v of [undefined, "", "   ", "-", "—", "n/a", "N/A"]) {
      assert.equal(num(v), undefined, `expected ${JSON.stringify(v)} to be missing`);
    }
  });

  test("text is refused", () => {
    assert.equal(num("abc"), undefined);
    assert.equal(num("12abc"), undefined);
  });
});

describe("numWithLocale", () => {
  test("resolves the ambiguous case with the file-level hint and nothing else", () => {
    assert.equal(numWithLocale("1,234", ","), 1.234);
    assert.equal(numWithLocale("1,234", "."), 1234);
    assert.equal(numWithLocale("1,234", undefined), undefined);
  });

  test("an unambiguous value ignores the hint", () => {
    assert.equal(numWithLocale("12,5", "."), 12.5);
    assert.equal(numWithLocale("45.2", ","), 45.2);
  });
});

describe("inferDecimalSeparator", () => {
  test("reads the separator off the values that are not ambiguous", () => {
    assert.equal(inferDecimalSeparator([{ a: "12,5" }, { a: "3,4" }]), ",");
    assert.equal(inferDecimalSeparator([{ a: "12.5" }, { a: "3.4" }]), ".");
    assert.equal(inferDecimalSeparator([{ a: "1.234,56" }]), ",");
    assert.equal(inferDecimalSeparator([{ a: "1,234.56" }]), ".");
  });

  test("says nothing when the file gives it nothing to go on", () => {
    assert.equal(inferDecimalSeparator([]), undefined);
    assert.equal(inferDecimalSeparator([{ a: "1234" }, { a: "abc" }]), undefined);
    assert.equal(inferDecimalSeparator([{ a: "12,5" }, { b: "12.5" }]), undefined);
  });
});

describe("sniffDelimiter", () => {
  test("picks the separator that gives a consistent table", () => {
    assert.equal(sniffDelimiter("a,b,c\n1,2,3"), ",");
    assert.equal(sniffDelimiter("a;b\n1,5;2,5"), ";");
    assert.equal(sniffDelimiter("a\tb\n1\t2"), "\t");
  });

  test("a comma inside a quoted field does not make it the delimiter", () => {
    assert.equal(sniffDelimiter('name;views\n"Smith, John";5'), ";");
  });

  test("falls back to a comma rather than throwing on an empty file", () => {
    assert.equal(sniffDelimiter(""), ",");
  });
});

describe("parseCsv", () => {
  test("reads a plain file", () => {
    assert.deepEqual(parseCsv("a,b\n1,2\n3,4"), [
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  test("survives what a real export actually contains", () => {
    /* BOM, CRLF, a quoted delimiter, an escaped quote, a blank line, and a
       header with padding — all four exports in data/seed/raw have at least
       one of these. */
    const text = '﻿name ,note\r\n"Smith, John","He said ""hi"""\r\n\r\n';
    assert.deepEqual(parseCsv(text), [{ name: "Smith, John", note: 'He said "hi"' }]);
  });

  test("a short row is missing cells, not shifted ones", () => {
    assert.deepEqual(parseCsv("a,b,c\n1,2"), [{ a: "1", b: "2", c: "" }]);
  });

  test("a file with only a header has no rows", () => {
    assert.deepEqual(parseCsv("a,b"), []);
    assert.deepEqual(parseCsv(""), []);
  });
});

describe("pick", () => {
  const row = {
    "Görüntüleme": "6487",
    "İçerik": "abc123",
    "İzlenme süresi (saat)": "12,5",
    Empty: "",
  };

  test("finds a column whatever its case, accents or dotted i", () => {
    assert.equal(pick(row, "goruntuleme"), "6487");
    assert.equal(pick(row, "Goruntuleme"), "6487");
    assert.equal(pick(row, "icerik"), "abc123");
  });

  test("matches a header the export has appended a unit to", () => {
    assert.equal(pick(row, "İzlenme süresi"), "12,5");
  });

  test("tries the next name when a column is present but empty", () => {
    assert.equal(pick(row, "Empty", "Görüntüleme"), "6487");
  });

  test("returns undefined rather than an empty string when nothing matches", () => {
    assert.equal(pick(row, "Nope"), undefined);
    assert.equal(pick(row, "Empty"), undefined);
  });
});

describe("duration", () => {
  test("reads clock values and bare seconds", () => {
    assert.equal(duration("0:23"), 23);
    assert.equal(duration("1:02:03"), 3723);
    assert.equal(duration("35"), 35);
  });

  test("refuses what it cannot read", () => {
    assert.equal(duration(undefined), undefined);
    assert.equal(duration(""), undefined);
    assert.equal(duration("1:ab"), undefined);
  });
});

describe("median and mean", () => {
  test("an empty set has no average, rather than an average of zero", () => {
    assert.equal(median([]), null);
    assert.equal(mean([]), null);
    assert.equal(median([NaN, NaN]), null);
    assert.equal(mean([NaN]), null);
  });

  test("computes over the finite values only", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(mean([1, 2, 3]), 2);
    assert.equal(mean([1, NaN, 3]), 2);
  });

  test("does not mutate its input", () => {
    const xs = [3, 1, 2];
    median(xs);
    assert.deepEqual(xs, [3, 1, 2]);
  });
});
