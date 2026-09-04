/**
 * Tests for the two decisions the seed pipeline makes that a reader cannot
 * check by eye: whether an age window is actually covered by the data, and
 * what counts as two readings disagreeing.
 *
 * These are the downstream half of the date bug in the README. `parseDate`
 * returning a day early was harmless on its own; it became a wrong published
 * number because `viewsInWindow` then judged an open window complete. So the
 * parse is tested in csv.test.ts and the consequence is tested here, and CI
 * runs both under several TZ values.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { addDays, findConflicts, viewsInWindow, type DailySeries } from "../src/seed.js";
import type { Observation } from "../../engine/src/format.js";

const series = (entries: Array<[string, number]>): DailySeries => {
  const byDate = new Map(entries);
  let maxDate: string | null = null;
  for (const [d] of entries) if (!maxDate || d > maxDate) maxDate = d;
  return { byDate, maxDate };
};

describe("addDays", () => {
  test("adds days without going through local midnight", () => {
    assert.equal(addDays("2026-09-03", 0), "2026-09-03");
    assert.equal(addDays("2026-09-03", 1), "2026-09-04");
    assert.equal(addDays("2026-09-03", 7), "2026-09-10");
  });

  test("crosses month, year and leap-day boundaries", () => {
    assert.equal(addDays("2026-09-30", 1), "2026-10-01");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2028-02-28", 1), "2028-02-29");
    assert.equal(addDays("2027-02-28", 1), "2027-03-01");
  });

  test("survives a DST transition, which is why it is not local-time arithmetic", () => {
    /* Europe/Istanbul has no DST any more, but the CI matrix includes zones
       that do, and these two dates straddle their spring and autumn changes. */
    assert.equal(addDays("2026-03-28", 1), "2026-03-29");
    assert.equal(addDays("2026-10-24", 1), "2026-10-25");
  });
});

describe("viewsInWindow", () => {
  const s = series([
    ["2026-09-03", 100],
    ["2026-09-04", 50],
    ["2026-09-05", 25],
  ]);

  test("sums only the days inside the window", () => {
    assert.deepEqual(viewsInWindow(s, "2026-09-03", 1), { value: 100 });
    assert.deepEqual(viewsInWindow(s, "2026-09-03", 2), { value: 150 });
  });

  test("refuses a window the export does not extend past", () => {
    /* The final day of an export is partial by definition. A 72h window ending
       on 2026-09-05 would be counted from data that is still arriving, which is
       exactly how a number gets published too small and never questioned. */
    const r = viewsInWindow(s, "2026-09-03", 3);
    assert.equal(r.value, null);
    assert.match(r.reason ?? "", /needs data through 2026-09-06/);
  });

  test("a window is not covered merely because the series is long", () => {
    /* A video published near the end of a long export still has no window. */
    const r = viewsInWindow(s, "2026-09-05", 1);
    assert.equal(r.value, null);
    assert.match(r.reason ?? "", /series ends 2026-09-05/);
  });

  test("a missing day inside a covered window counts as zero, not as missing", () => {
    const gap = series([
      ["2026-09-03", 100],
      ["2026-09-05", 25],
    ]);
    assert.deepEqual(viewsInWindow(gap, "2026-09-03", 2), { value: 100 });
  });

  test("says why, rather than returning null on its own", () => {
    for (const r of [
      viewsInWindow(undefined, "2026-09-03", 1),
      viewsInWindow(s, null, 1),
      viewsInWindow(series([]), "2026-09-03", 1),
    ]) {
      assert.equal(r.value, null);
      assert.ok(r.reason && r.reason.length > 0, "a null must carry its reason");
    }
  });
});

describe("findConflicts", () => {
  const obs = (o: Partial<Observation>): Observation =>
    ({
      platform: "youtube",
      externalId: "abc123",
      source: "csv",
      measuredAt: "2026-09-04",
      publishedAt: "2026-09-02",
      views: 1000,
      ...o,
    }) as Observation;

  test("two readings of the same video that agree are not a conflict", () => {
    assert.deepEqual(findConflicts([obs({}), obs({ measuredAt: "2026-09-05" })]), []);
  });

  test("one reading is never a conflict", () => {
    assert.deepEqual(findConflicts([obs({})]), []);
  });

  test("readings of different videos are never compared", () => {
    assert.deepEqual(findConflicts([obs({}), obs({ externalId: "xyz789", views: 9999 })]), []);
  });

  test("the same id on two platforms is two subjects, not a disagreement", () => {
    assert.deepEqual(findConflicts([obs({}), obs({ platform: "tiktok", views: 9999 })]), []);
  });

  test("disagreeing view counts are recorded and both readings kept", () => {
    const [c] = findConflicts([
      obs({ views: 1000, source: "csv" }),
      obs({ views: 1200, source: "manual", measuredAt: "2026-09-05" }),
    ]);
    assert.equal(c.field, "views");
    assert.equal(c.subject, "youtube:abc123");
    assert.deepEqual(
      c.readings.map((r) => r.value),
      ["1000", "1200"]
    );
    assert.deepEqual(
      c.readings.map((r) => r.from),
      ["platform export", "hand-entered"]
    );
    /* Every reading must carry when it was taken, or the conflict cannot be
       read as "the number moved" rather than "someone is wrong". */
    for (const r of c.readings) assert.ok(r.measuredAt);
  });

  test("a disagreeing publish date names which record was used and keeps the other", () => {
    const conflicts = findConflicts([
      obs({ publishedAt: "2026-09-02", source: "csv" }),
      obs({ publishedAt: "2026-09-01", source: "manual" }),
    ]);
    const c = conflicts.find((x) => x.field === "publishedAt");
    assert.ok(c, "a publish-date disagreement must be reported");
    assert.match(c.resolution, /2026-09-02/);
    assert.match(c.resolution, /not discarded/);
    assert.equal(c.readings.length, 2);
  });

  test("nothing is resolved silently — every conflict states what was done", () => {
    const conflicts = findConflicts([
      obs({ views: 1000, publishedAt: "2026-09-02", source: "csv" }),
      obs({ views: 1200, publishedAt: "2026-09-01", source: "manual" }),
    ]);
    assert.equal(conflicts.length, 2);
    for (const c of conflicts) {
      assert.ok(c.resolution && c.resolution.length > 0);
    }
  });
});
