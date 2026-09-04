# measure/

The loop that turns published videos back into rows in the format library.

```
inbox/              you drop analytics CSV exports here (gitignored — yours)
inbox/retention/    per-video retention exports, named <external_id>.csv
mapping.csv         the join table: published video -> variant id  (committed)
normalized/         machine-written normalised samples             (gitignored)
report.md           "which format won"                             (gitignored)
src/                ingest, report, apply
```

## Run it

```bash
npx kw measure          # ingest CSVs, then build the report
npx kw measure apply    # write results into formats/*/data.yml
npx kw site build       # reorder the gallery
```

## The one file you maintain by hand

`mapping.csv` — write the row at upload time, not a month later:

```csv
platform,external_id,variant_id,published_at
youtube,dQw4w9WgXcQ,stat-counter-rise@1.0.0+c91af1b2e218,2026-03-02T09:00:00Z
tiktok,7341234567890123456,cold-open-line@1.0.0+385dab9ddcbe,2026-03-02T09:05:00Z
```

Get the variant id from `out/<slug>/variant.json`, or from the MP4 itself:

```bash
ffprobe -show_entries format_tags=comment out/my-clip/master.mp4
```

A published video with no mapping row is listed in `report.md` under
**"published but unmapped"** and excluded from every number. It is never quietly
averaged in.

## Which export button

**YouTube Studio** — Analytics → Content → *Advanced mode* → Export →
Comma-separated values. Drop `Table data.csv` into `inbox/`.
For a curve: one video → Analytics → Engagement → Audience retention → Export,
saved as `inbox/retention/<video_id>.csv`.

**TikTok** — Analytics → Content → Download data. Drop the video-level CSV into
`inbox/`. Where per-video retention export exists, save it the same way.

Column names are matched case- and punctuation-insensitively with a prefix
fallback, so `Watch time (hours)`, `watch_time_hours` and `Watch time` all
resolve. Missing columns are simply not recorded — nothing is inferred.

Full detail, including what these numbers cannot tell you:
[`../skills/keepwatching/references/measuring.md`](../skills/keepwatching/references/measuring.md).
