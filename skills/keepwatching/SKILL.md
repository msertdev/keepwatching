---
name: keepwatching
description: >-
  Use when producing, planning, or critiquing short-form vertical video (TikTok,
  Reels, Shorts) — choosing a format for a topic, rendering a 9:16 MP4 from a
  JSON spec, running an A/B test between two formats, or reading retention
  numbers back into a decision. Provides a library of named formats with measured
  retention and sample sizes, a deterministic Node + Playwright + ffmpeg renderer,
  and a CSV-based measurement loop. Trigger on "short-form", "vertical video",
  "9:16", "TikTok/Reels/Shorts format", "hook", "retention", "which format
  should I use", "render a video from data".
license: MIT
---

# keepwatching

A database of named short-form video formats that renders. Each format is three
files: a render spec, a stated hypothesis, and whatever the measurements say —
including "nothing yet".

**The rule that makes this skill useful: never invent a retention number.** Every
claim about how a format performs comes from `formats/<slug>/data.yml`, and every
one of those carries an `n`. If `n: 0`, the honest answer is "untested" — say so.

## Setup

```bash
git clone https://github.com/keepwatching/keepwatching
cd keepwatching
npm install && npm run setup    # Inter + a headless Chromium, ~2 min
```

`npm run setup` is required once. It downloads the fonts locally, because a
missing font would silently change every frame the repo has ever measured.

## The four things you will be asked to do

### 1. Pick a format for a topic

```bash
npx kw list          # every format, with its sample size and measured retention
```

Read `formats/<slug>/meta.yml` for the `hypothesis`, `useWhen` and `avoidWhen`.
Match the *shape of the content* to the format family, not the topic:

| The content is… | Family | Start with |
|---|---|---|
| one big number | `stat-counter` | `stat-counter-rise` |
| a payoff worth waiting for | `countdown` | `countdown-clock` |
| an ordered set of items | `ranking` | `ranking-suspense` (completion) or `ranking-reveal` (shares) |
| two options that differ on one number | `comparison` | `split-compare` |
| the same subject in two states | `reveal` | `before-after` |
| a widespread false belief | `myth-fact` | `myth-vs-fact` |
| one strong sentence | `cold-open` | `cold-open-line` |
| a process with real stages | `progress` | `progress-bar` |
| values that genuinely escalate | `escalation` | `escalation-ladder` |
| something circular | `reverse` | `loop-seam` |

When you recommend one, quote its `n`. "`ranking-suspense`, though it is untested
in this repo (n=0)" is a good recommendation. "`ranking-suspense` gets 68%
retention" is a fabrication unless `data.yml` says so.

### 2. Render a video

Copy a format, fill in the `data` block, render:

```bash
npx kw new my-clip --from=stat-counter-rise
# edit formats/my-clip/format.json -> "data": { ... }
npx kw preview my-clip          # scrub it in a browser first
npx kw render my-clip           # -> out/my-clip/master.mp4
```

Only edit `data` unless the layout genuinely needs to change. The `scene` array
is the format; changing it makes the clip a different format, and its
measurements no longer transfer. If you do change the scene, bump `version` in
`format.json` — the variant id derives from it.

See `references/spec.md` for the full `format.json` reference.

### 3. Run an A/B test

Two formats, same content, same day:

```bash
npx kw new test-a --from=cold-open-line
npx kw new test-b --from=redacted-reveal
# put identical copy in both data blocks
npx kw render test-a && npx kw render test-b
npx kw variant test-a           # record this string against the upload
```

The `variantId` in `out/<slug>/variant.json` is what makes the result
attributable. Record it against the published video *at upload time* — it is
also written into the MP4's metadata comment if you lose your notes.

### 4. Read measurements back in

```bash
# export CSVs from YouTube Studio / TikTok analytics into measure/inbox/
npx kw measure                  # ingest + report -> measure/report.md
npx kw measure apply            # write results into formats/*/data.yml
npx kw site build               # reorder the gallery
```

No API, no OAuth. See `references/measuring.md` for the exact export steps and
the `mapping.csv` format.

## Determinism is the contract

The same `format.json` produces the same frames, on any machine, forever. That is
what lets a retention curve be attributed to a format rather than to a render.
When editing the engine, never introduce `Date.now()`, `Math.random()`,
`requestAnimationFrame`, CSS transitions, or CSS animations into the composition.
`npx kw render <slug> --check-determinism` re-seeks frames out of order and fails
if any pixel moved.

## Honesty rules

These are not style preferences. The repo is worthless if they slip.

1. **`n: 0` means untested.** Never round it up to "promising" or "likely".
2. **Under n=5 is a direction, not a result.** Say which one you are giving.
3. **Losing formats stay listed with their numbers.** Do not quietly drop them.
4. **Never hand-write `data.yml`.** Only `kw measure apply` writes it. Numbers
   typed from memory are indistinguishable from numbers that were invented.
5. **Seed data is one creator's channel.** It is a starting point, not a law of
   the platform. Say whose sample it is when the distinction matters.

## Reference files

- `references/spec.md` — the `format.json` element and animation reference
- `references/formats.md` — the format library, by family, with hypotheses
- `references/measuring.md` — CSV export, mapping, and the report loop
- `references/authoring.md` — writing a new format that is worth measuring
