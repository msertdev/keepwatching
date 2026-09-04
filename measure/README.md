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

Two paths, depending on where the numbers come from.

**Seed / raw platform exports** — drop the untouched exports into
`data/seed/raw/` (see the README there) and run:

```bash
npx kw measure seed     # -> data/content-axis-results.yml + report.md
npx kw site build
```

Delimiter and decimal separator are sniffed per file, so a semicolon-delimited
Turkish export with comma decimals reads correctly with no configuration. A
number that is genuinely ambiguous (`1,234` — 1234 or 1.234?) is left null
rather than guessed.

**Contributor format measurements** — for videos published with a format from
this library:

```bash
npx kw measure          # ingest CSVs, then build the report
npx kw measure apply    # write results into formats/*/data.yml
npx kw site build       # reorder the gallery
```

Hand-entered readings go in `measure/manual.yml` and are written with
`source: manual`, rendered distinctly from exported numbers everywhere they
appear. They sit alongside the export rather than replacing it: where the two
disagree, both are kept with their own `measuredAt` and the disagreement is
recorded as a conflict.

## The one file you maintain by hand

`mapping.csv` — write the row at upload time, not a month later:

```csv
platform,external_id,variant_id,published_at,content_axis
youtube,dQw4w9WgXcQ,stat-counter-rise@1.0.0+c91af1b2e218,2026-03-02T09:00:00Z,personal-body
tiktok,7341234567890123456,cold-open-line@1.0.0+385dab9ddcbe,2026-03-02T09:05:00Z,corporate-money
```

`content_axis` is optional and names an axis declared in
[`../data/content-axes.yml`](../data/content-axes.yml). It produces a **second,
separate** leaderboard — how the subject performed, as opposed to how the scene
structure performed. The two are never averaged; see section 2 of `report.md`.
An unrecognised axis id is listed as unknown and ignored, never silently pooled.

### Videos whose format is not in this library

Some published videos use a format that is not part of this repo. Put the literal
label in the `variant_id` column:

```csv
platform,external_id,variant_id,published_at,content_axis
youtube,dQw4w9WgXcQ,not-in-library,2026-03-02T09:00:00Z,personal-body
```

Such a row is a **content-axis sample and nothing else**. There is no spec here
to attribute it to, so it can never reach the format board, a format's
`data.yml`, or the gallery ranking — `kw check` and CI both fail if one does.
It counts toward the axis result, and the `carried by` column names
`not-in-library` explicitly so a reader can see that part of an axis came from
outside the library.

The label says only that: the format is not here. It carries no information
about what the format is.

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
