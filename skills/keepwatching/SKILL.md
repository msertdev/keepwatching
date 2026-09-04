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

## Setup — do this first, every session

This skill drives a real renderer that lives in the keepwatching repo. The
instructions alone cannot render anything, so **step one is always locating or
installing the repo.**

```bash
# 1. Find it. First match wins; ask the user if none of these exist.
KW="${KEEPWATCHING_HOME:-}"
[ -z "$KW" ] && [ -d ./keepwatching ] && KW="$PWD/keepwatching"
[ -z "$KW" ] && [ -d "$HOME/keepwatching" ] && KW="$HOME/keepwatching"
[ -z "$KW" ] && { git clone https://github.com/msertdev/keepwatching "$HOME/keepwatching" && KW="$HOME/keepwatching"; }
cd "$KW"

# 2. One-time install. Safe to re-run; it no-ops when already done.
npm install && npm run setup

# 3. Confirm the library is intact before doing anything else.
npx kw check
```

The 24 gallery previews are committed, so `npx kw gallery` shows the page in
seconds without rendering anything. `npm run setup` is only needed to render
video. If you change a format's `scene`, its committed preview becomes stale —
re-render and commit it with `npx kw gallery --no-serve && git add site/previews`,
or CI's `kw previews check` will fail.

`kw check` printing `no problems` means you are ready. If it reports missing
fonts, run `npm run setup` again — the composition refuses to render with a
fallback font, because a substituted font would silently change every frame the
repo has ever measured.

**Two practical notes.**

- **Shell variables do not persist between tool calls** in most agent harnesses.
  Either recompute `KW` in every command, or start each one with an explicit
  `cd /absolute/path/to/keepwatching &&`. Do not assume `$KW` survives.
- **`npm run setup` can take minutes on a cold machine.** It downloads Inter
  (≈30 MB) and a headless Chromium (≈150 MB). On a machine that already has both
  cached it finishes in seconds. Tell the user which one is happening rather than
  appearing to hang.

**Every command in this file assumes the repo root is the working directory.**
If the user is working in a different project, render inside the repo and copy
the MP4 back; `kw` does not run from outside it.

There is also `npm run check`, which is `kw check` **plus** `tsc --noEmit`. Use
that one if you have edited anything under `engine/`.

## The four things you will be asked to do

### 1. Pick a format for a topic

```bash
npx kw list          # every format, with its sample size and measured retention
```

Read `formats/<slug>/meta.yml` for the `hypothesis`, `useWhen` and `avoidWhen`.
Match the *shape of the content* to the format family, not the topic.

> **Every format in the table below is currently `n = 0`.** These are starting
> points chosen from a stated hypothesis, not winners chosen from evidence. Say
> that when you recommend one. The table tells you which format *claims* to suit
> a shape of content; it does not tell you which one performs.

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
npx kw render my-clip           # -> out/my-clip/master.mp4

# Optional: scrub it in a browser first, without encoding anything.
# Blocks until you stop it, so skip it when running unattended.
npx kw preview my-clip
```

Only edit `data` unless the layout genuinely needs to change. The `scene` array
is the format; changing it makes the clip a different format, and its
measurements no longer transfer. If you do change the scene, bump `version` in
`format.json` — the variant id derives from it.

**Changing the length — read this, it is the most common request.**

Library formats run **8–30 seconds** (21 of 24 between 8 and 14). The three
30-second ones — `cold-open-question`, `countdown-clock`, `stat-counter-rise`
— are the levels of a running experiment, not the house length. Any length a
format does not already have *requires* editing the scene, so "only edit `data`"
does not apply. Use this rule:

> Multiply `canvas.durationSec` **and every timing in the scene** by
> `newDuration / oldDuration`. Then look at the tail: scaling stretches the
> final hold by the same factor, so the bigger the factor the worse the ending
> gets.

Worked example — `stat-counter-rise` from 10s to 30s, factor 3.0. These are the
numbers that actually shipped, not an illustration:

| field | 10s | ×3 | shipped |
|---|---|---|---|
| `canvas.durationSec` | 10 | 30 | **30** |
| counter `endSec` | 6.4 | 19.2 | **21.0** |
| bar `endSec` | 6.4 | 19.2 | **21.0** |
| `unit` `at` | 6.4 | 19.2 | **21.0** |
| `context` `at` / `in.at` | 6.5 | 19.5 | **21.6** |
| `source` `at` | — | — | **25.5** — a beat that did not exist |
| `posterSec` | 8.4 | 25.2 | **27.5** |

Scaling alone left the last beat at 19.5s in a 30-second clip: **10.5 seconds of
a frozen card.** Pushing it to 21.6 was not enough either. Past a factor of
about two, arithmetic stops being the answer — the clip needs a beat it did not
have. Here that is a citation line at 25.5s, which the format had been claiming
in its `sources` all along and had never put on screen. Final hold: 4 seconds.

**A final card held longer than about 3 seconds is dead air**, and dead air at
the end is what kills a completion rate. `kw frame0` fails outright at 5 seconds
of a motionless screen: 3 is the craft advice, 5 is the hard floor. It found
three formats that had already shipped with a 6-second frozen ending.

Constraints and checks:

- `durationSec × fps` must be a whole number of frames.
- Bump `version` in `format.json` whenever you change the scene — retiming
  counts. A fresh scaffold at `0.1.0` that you then retime becomes `0.2.0`. The
  variant id derives from `version` plus a hash of the spec, so this keeps a
  future measurement attributable.
- `npx kw check` catches timings past the end of the clip, and `npx kw frame0`
  catches a first frame that paints nothing plus any motionless run over 5
  seconds. Neither can tell you a clip is *dull* — for that, open
  `out/<slug>/contact.png` after rendering. It samples six frames evenly across
  the clip, so near-identical tiles are visible at a glance.

**Sourcing.** `kw new --from=<slug>` deliberately resets the scaffold to
`sampleContent: placeholder` and drops the parent's `sources` — the parent's
citations backed the parent's numbers, not yours. If you put a real number on
screen, set `sampleContent: sourced` and add a `sources:` entry with a URL and
the exact claim it backs.

**A sourced number is only sourced once it lands.** If you animate a counter to
a cited figure, mark it `claim: "final"` and keep the unit and any word like
"exactly" off screen until `endSec` — show "counting…" until then. Every other
element visible during the count needs `neutralWhileCounting: true`. `kw check`
refuses the format otherwise. Counters whose intermediate values are honestly
true ("frames so far") are marked `claim: "running"` and are exempt.

What counts as a source: something a reader can open and check the number
against — a primary paper or its permanent record (DOI, PubMed), a standards
body, a statistical agency, an official report. Not a listicle, not a blog
summarising one, and not your own recollection. State any rounding you did for
the screen in the `claim` field. `kw check` verifies a URL and a claim are
*present*; it cannot verify they are *true*, so that part is on you. If you
cannot find a source, use filler copy instead — an invented statistic is the
same failure as an invented retention figure.

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
npx kw gallery                  # re-render + rebuild the gallery
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

## Two measurements that must never be mixed

`data.yml` has two blocks, and they answer different questions:

| Block | Question | Ranks the library? |
|---|---|---|
| `format` | How does this **scene structure** perform? | Yes |
| `content_axis` | How does this **subject matter** perform? | No |

A single published video carries both labels — it is *a countdown* and it is
*about the body*. Averaging the two produces a number that answers neither
question, so they are stored separately, reported separately, and shown in
different colours in the gallery.

When you report a result, say which one it is:

- "`countdown-clock` retained 62% (n=6)" — a format claim.
- "personal/body subjects retained 68% (n=9)" — an axis claim.
- "personal/body countdowns retained 68%" — **neither**, unless you also say how
  many videos, in which formats, and that the two are confounded.

`measure/report.md` prints a **carried by** column for every axis. If an axis was
only ever carried by one format, that axis result and that format result are the
same videos wearing two labels; say so rather than presenting them as two
independent findings.

Content axes are declared in `data/content-axes.yml` and attached to a video by
the optional `content_axis` column in `measure/mapping.csv`. They are the user's
own axes, not the library's — add whatever distinction they actually test.

**`variant_id: not-in-library`** marks a published video whose format is not in
this repo. It is a content-axis sample only: it never reaches the format board or
any `data.yml`, and `carried by` names it so the gap is visible. Repo-level axis
results live in `data/content-axis-results.yml`, which is why an axis can be
measured while every format is still `n = 0`. Do not speculate about what such a
format is — the label deliberately says nothing about it.

## Honesty rules

These are not style preferences. The repo is worthless if they slip.

1. **`n: 0` means untested.** Never round it up to "promising" or "likely".
2. **Under n=5 is a direction, not a result.** Say which one you are giving.
3. **Losing formats stay listed with their numbers.** Do not quietly drop them.
4. **Never hand-write `data.yml`.** Only `kw measure apply` writes it. Numbers
   typed from memory are indistinguishable from numbers that were invented.
5. **Never merge a format number with an axis number.** See the table above.
6. **Every number on screen needs a source.** A clip you generate carries either
   `sampleContent: sourced` with a URL, or `placeholder` with obvious filler.
   Inventing a plausible statistic for a demo is the same failure as inventing a
   retention figure.
7. **Seed data is one creator's channel.** It is a starting point, not a law of
   the platform. Say whose sample it is when the distinction matters.

## Reference files

- `references/spec.md` — the `format.json` element and animation reference
- `references/formats.md` — the format library, by family, with hypotheses
- `references/measuring.md` — CSV export, mapping, and the report loop
- `references/authoring.md` — writing a new format that is worth measuring
