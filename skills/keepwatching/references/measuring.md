# The measurement loop

This is the part that makes the repo a database instead of a template pack.

No API, no OAuth, no tokens. Analytics exports are CSVs; CSVs are enough. The
loop has to be cheap enough that you actually run it, because a measurement loop
that takes twenty minutes is a measurement loop that gets skipped.

## The loop

```
render  ──>  publish  ──>  export CSV  ──>  ingest  ──>  report  ──>  apply
   │                            │                                       │
   └── variantId ───────────────┴─── mapping.csv ────────────────────────┘
```

### 1. Render, and keep the variant id

Every render writes `out/<slug>/variant.json`:

```json
{ "variantId": "stat-counter-rise@1.0.0+c91af1b2e218", "specHash": "c91af1b2e218", … }
```

The variant id is `slug@version+hash-of-the-spec`. Change one pixel-affecting
field and the hash changes, so a measurement can never be silently attributed to
a spec that has since been edited. It is also written into the MP4's metadata:

```bash
ffprobe -show_entries format_tags=comment out/my-clip/master.mp4
```

### 2. Publish, and write one line

`measure/mapping.csv` — the join table, and the only file you maintain by hand:

```csv
platform,external_id,variant_id,published_at
youtube,dQw4w9WgXcQ,stat-counter-rise@1.0.0+c91af1b2e218,2026-03-02T09:00:00Z
tiktok,7341234567890123456,cold-open-line@1.0.0+385dab9ddcbe,2026-03-02T09:05:00Z
```

- `external_id` — the YouTube video id, or the numeric id from a TikTok URL.
- `published_at` — ISO 8601. Used for the views-per-hour figure; leave it blank
  and that column stays empty rather than guessing.

Write the row at upload time. Reconstructing it a month later from titles is how
measurement loops die.

### 3. Export the CSVs

**YouTube Studio**
- Analytics → Content → **Advanced mode** → Export → Comma-separated values.
  Save `Table data.csv` into `measure/inbox/`.
- For a retention curve: open one video → Analytics → Engagement → Audience
  retention → Export. Save it as `measure/inbox/retention/<video_id>.csv`.
  The filename *is* how the curve gets matched to the video.

**TikTok**
- Analytics → Content → Download data (or Creator Center → Analytics → Export).
  Save the video-level CSV into `measure/inbox/`.
- TikTok's per-video retention curve is export-only in some regions; where it is
  available, save it the same way under `retention/<video_id>.csv`.

Column names are matched case- and punctuation-insensitively, with a prefix
fallback, so `Watch time (hours)`, `watch_time_hours` and `Watch time` all work.
The ingester does not care which columns are missing — it records what it finds.

### 4. Ingest and report

```bash
npx kw measure          # ingest + report
```

- `measure/normalized/samples.json` — one normalised record per published video.
  New exports merge into it, so a partial export never wipes history.
- `measure/report.md` — the "which format won" table, plus two lists you should
  actually read: **published but unmapped** (videos with no `mapping.csv` row,
  excluded from every number) and **variant ids with no matching format**.

Retention curves are resampled onto a shared 0.5s grid before averaging, so
clips of different lengths can be compared honestly.

### 5. Apply

```bash
npx kw measure apply    # writes formats/*/data.yml
npx kw site build       # reorders the gallery
```

`data.yml` is machine-written. **Never edit it by hand.** A number typed from
memory is indistinguishable from a number that was invented, and the whole repo
rests on that distinction.

## What the numbers mean

| Field | Definition |
|---|---|
| `n` | Published videos attributed to this format. Not views. |
| `hook3s` | Fraction still watching at 3 seconds. From the retention curve. |
| `avgViewedPct` | Mean fraction of the clip watched. From the platform, or the area under the retention curve. |
| `viewsPerHour` | Median views per hour over the first 24h. A velocity proxy, heavily confounded by follower count and posting time. |
| `vsBaselinePct` | Percentage points against the mean of all measured formats in this repo. |

## What these numbers cannot tell you

Be blunt about this when reporting results:

- **Topic and format are confounded.** A format that only ever ran on good topics
  will look like a good format. Run the same content through two formats to
  separate them.
- **Posting time, follower count and platform push dominate `viewsPerHour`.**
  Treat retention as the signal and velocity as a hint.
- **Small n is small n.** Under 5 samples is a direction. Under 3 is an anecdote.
  The report prints `n` in every row for exactly this reason.
- **The baseline moves.** It is the mean of whatever is currently measured, so
  `vsBaselinePct` changes as the library grows. It is a within-repo comparison,
  not an industry benchmark.

## Running your own A/B

The seed data is one creator's channel. Yours will differ, and that is the point.

1. Pick two formats that differ on one dimension (`ranking-reveal` vs
   `ranking-suspense` differ only in reveal order).
2. Put **identical copy** in both `data` blocks.
3. Publish within an hour of each other, same day of week, same account.
4. Wait 72 hours before exporting — early numbers are mostly push, not quality.
5. Repeat at least three times before believing the direction.
