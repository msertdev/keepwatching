# keepwatching

**A retention database for short-form formats. That renders.**

[Gallery](https://msertdev.github.io/keepwatching) · 24 formats · 0 measured · MIT

**Current status:** the renderer, evidence model and measurement pipeline are
working; the format findings are deliberately not claimed yet. One
pre-registered experiment is running, and every untested format stays visible
until real samples arrive.

## Why this exists

I built this to stop myself publishing numbers I hadn't measured.
Two weeks in, it didn't catch me. That is the point.

A YouTube analytics export gave me `"Sep 3, 2026"`. The parser passed it
through `new Date(...).toISOString()`, which reads the string as local
midnight and re-expresses it in UTC. At UTC+3, every publish date moved
back a day.

Nothing crashed. Nothing warned. A video published on the 2nd looked
published on the 1st, so a 48-hour window that was still open was judged
complete and filled with a number covering about twenty-four hours.
A wrong figure, with a plausible reason attached, sitting in a file whose
entire job is to say how the number was measured.

I found it by checking four computed percentages against the raw rows
by hand.

So the argument here isn't that the tooling is clever — it wasn't clever
enough. It's that every number carries where it came from and when it was
measured, so a person can do that check.

## What's measured right now

Format board: **24 formats, 0 measured.**
Content-axis board: **3 axes, 4 samples**, every one of them carried by a
format that isn't in this library — labelled as such, on the axis board
only, never counted toward a format.

Nothing is hidden to make the ranking look fuller. Anything under n=5 is
a direction, not a result.

An experiment is running. Its hypothesis, sample size and stopping rule were
committed before the first video went out — the git timestamp on
[`experiments/2026-09-counter-vs-hook.md`](experiments/2026-09-counter-vs-hook.md)
is the claim.

## Install

Five seconds from a clean clone to a working gallery, measured:

```bash
git clone https://github.com/msertdev/keepwatching && cd keepwatching
npm install     # 3s
npx kw gallery  # 2s -> http://localhost:8080
```

No font download, no browser download, no rendering. The 24 previews are
committed, so `kw gallery` copies and builds rather than rendering.

Rendering video is a separate step, and the only one that needs the fonts and a
headless Chromium:

```bash
npm run setup                     # seconds if cached, ~2-3 min cold
npx kw render stat-counter-rise   # -> out/stat-counter-rise/master.mp4
```

`kw gallery` re-renders only what is missing or **stale** — a preview whose
format spec changed since it was rendered — printing `7/24 rendered` with an ETA
when it has work to do.

## What a format is

Three files. No per-format code anywhere in the engine.

```
formats/ranking-suspense/
├── format.json   the render spec — deterministic JSON, no code
├── meta.yml      the claim: a hypothesis you could lose, and where the
│                 example numbers came from
└── data.yml      the evidence, in two blocks that never merge
```

`meta.yml` states something you can be wrong about:

> Withholding rank 1 until the final second converts the whole clip into a
> single unanswered question, trading early drop-off for a higher completion
> rate among those who stay.
>
> **Avoid when:** the audience already knows the likely #1 — the withholding
> will read as padding.

### Adding one

```bash
npx kw new my-format --from=cold-open-line
npx kw preview my-format                        # scrub it in a browser
npx kw render my-format --check-determinism
npx kw check
```

The bar: a hypothesis you could lose, not a re-skin of an existing format, and
it generalises past one video. `data.yml` ships as `n: 0 · untested` and stays
that way until a CSV says otherwise.

`kw new --from` deliberately resets the scaffold to `sampleContent: placeholder`
and drops the parent's sources — a parent's citations back the parent's numbers,
not yours. Full guidance in
[`references/authoring.md`](skills/keepwatching/references/authoring.md); the
`format.json` reference is in
[`references/spec.md`](skills/keepwatching/references/spec.md).

## Two measurements, kept apart

The easiest way to fool yourself with this data is to average the wrong things
together, so the repo makes that structurally hard.

```yaml
# formats/<slug>/data.yml
format:            # how the SCENE STRUCTURE performed. Orders the library.
  n: 0
  status: untested
content_axis:      # how the SUBJECT MATTER performed, carried by this format.
  n: 0             # Its own n. Its own baseline. Never merged with the above.
  status: untested
  axes: []
```

One published video carries both labels — it is *a countdown*, and it is *about
the body*. "Countdowns retain 62%" and "body subjects retain 68%" are different
claims, and a single blended number answers neither.

The separation is enforced in four places: different types in
`engine/src/format.ts`, different blocks in `data.yml`, two tables with two
baselines in `measure/report.md`, and two colours in the gallery, each with its
own visible `n`.

A published video whose format is not in this library is tagged
`variant_id: not-in-library`. It counts toward content axes and nothing else —
never the format board, never a `data.yml` — and the **carried by** column names
the label so the gap is visible rather than hidden. That is why an axis can be
measured while every format is still `n = 0`.

## Sending a measurement

The library is only worth its sample sizes, and right now most of them are zero.

```bash
# export analytics CSVs into measure/inbox/, then
npx kw measure          # -> measure/report.md
npx kw measure apply    # writes formats/*/data.yml
```

No API, no OAuth, no tokens — friction is why measurement loops die. Every
render stamps a **variant id** (`slug@version+specHash`) into
`out/<slug>/variant.json` and the MP4's metadata; you write one line in
`measure/mapping.csv` at upload time and that is the whole join.

`data.yml` is machine-written and never edited by hand. A number typed from
memory is indistinguishable from a number that was invented.

**[Submit a measurement →](https://github.com/msertdev/keepwatching/issues/new?template=measurement.yml)**
· [CONTRIBUTING.md](CONTRIBUTING.md) for what a measurement needs and what gets
rejected.

## Install as an agent skill

Works in Claude Code, Codex, Cursor, Windsurf, and anything that reads a
markdown skill file.

```bash
git clone https://github.com/msertdev/keepwatching ~/keepwatching
cd ~/keepwatching && npm install && npm run setup
export KEEPWATCHING_HOME=~/keepwatching     # add to your shell profile

# Claude Code
cp -r skills/keepwatching ~/.claude/skills/

# Cursor / Windsurf / Codex — point your rules file at
# ~/keepwatching/skills/keepwatching/SKILL.md
```

The clone is not optional: the skill drives a real renderer that lives in the
repo, so the instruction file alone renders nothing.

An independent agent, given only `SKILL.md` and an empty directory, went from
nothing to a verified 15-second MP4 without help. The skill's main job is
refusal: it may not invent a retention number, and every performance claim it
makes has to come from a `data.yml` with an `n` attached.

## The engine

**Node + Playwright + ffmpeg. No React, no Remotion.** Chromium paints each
frame through CDP, ffmpeg encodes the sequence, and the whole thing is a pure
function of the frame number.

```bash
npx kw render ranking-suspense --check-determinism
```
```
▸ ranking-suspense  13s @ 30fps = 390 frames
  variant ranking-suspense@1.0.0+7101b32c10da
  determinism ok (4 frames re-seeked out of order)
  verified  1080x1920 · 390 frames · 30fps
```

Formats are **data, not code**. Eight element types — `text`, `counter`, `bar`,
`iconGrid`, `list`, `split`, `card`, `image` — plus keyframe tracks and wipes.
No format in the library uses `image`; the social card does, which is the only
thing keeping it exercised.

### What the hashes do, and what they do not

Two different jobs, often confused:

- **The variant id** (`slug@version+specHash`) guards **correctness**. It hashes
  the spec, not the output. Change one pixel-affecting field and the hash
  changes, so a measurement can never be silently attributed to a spec that has
  since moved, and `kw previews check` fails when a committed preview's spec no
  longer hashes to the variant that produced it.
- **The file hashes** in `site/previews/manifest.json` guard **integrity** only:
  they detect a committed file that was corrupted or edited by hand.

They are never used to decide whether a re-render is needed. Encoders are not
byte-reproducible across platforms — two machines can emit different bytes for
identical frames — so comparing a fresh render's hash against the manifest would
fail on Linux CI for no real reason. The frames are deterministic; the container
bytes are not, and the repo does not pretend otherwise.

## What is tested

| Guard | What it catches |
|---|---|
| `npm test` | 50 unit tests over the CSV/date reader and the age-window rule, run under four timezones — the layer where the bug in "Why this exists" lived |
| `kw check` | invalid specs, unsourced demo numbers, undeclared content axes, a sourced counter asserting certainty before it lands, and a claim in `SKILL.md` that the library no longer satisfies |
| `kw frame0` | a blank or thin first frame, a poster frame that would sit on a card looking empty, and a stretch of dead air — more than 5s where nothing on screen moves — DOM and pixels, independently, across all 24 |
| `kw previews check` | a committed preview whose spec has changed since it was rendered |
| `kw layout` | a control or card row that is off screen or unclickable at 390 / 768 / 1440px |
| `kw social check` | a social preview card that no longer matches the formats or the layout it was rendered from |
| `--check-determinism` | frames that depend on seek history rather than on time |

Every one was negative-tested: broken on purpose, watched to fail, then fixed. A
guard nobody has tried to defeat is a guard nobody knows works.

The timezone matrix is there for the same reason. Putting the date bug back
leaves the suite **35/35 green under `TZ=UTC`** and failing under the other
three zones, so a UTC-only CI would have shipped it with a full green tick.
That is not a hypothetical: it is what happened, and UTC is what GitHub
runners use.

## Honesty rules

Not style preferences. The repo is worthless if they slip.

1. **`n: 0` means untested.** Never rounded up to "promising".
2. **Under n=5 is a direction, not a result.** Say which one you are giving.
3. **Losing formats stay listed, with their numbers.**
4. **Only `kw measure apply` writes `data.yml`.**
5. **A format number and an axis number are never averaged.**
6. **Every number on screen carries a source, or is labelled filler.**
7. **A sourced number is not sourced until the counter lands on it.**

## Commands

```
npm test                     unit tests for the measurement reader
kw setup                     install Inter + a headless Chromium (render only)
kw gallery                   refresh stale previews, build and serve the gallery
    --force                  re-render every preview
    --no-serve               build only
kw list                      every format, with its sample size
kw check                     validate every format
kw frame0 [<slug>]           first-frame, poster-frame and dead-air checks
kw previews check            committed previews match their specs
kw layout [--url=<live>]     gallery is reachable at 3 widths
kw social [check]            render the social preview card, or verify it is current
kw render <slug> | --all     render to out/<slug>/
    --check-determinism      re-seek frames out of order and compare hashes
kw preview <slug>            scrub a format in a browser
kw new <slug> --from=<slug>  scaffold a new format
kw variant <slug>            print the variant id for the current spec
kw measure [ingest|report|apply|seed]
```

## Licence

MIT. Inter is fetched at setup under the SIL Open Font License 1.1.

Clips render silent. There is no audio subsystem: one shipped, no format used
it, and code that nothing exercises is code nobody has tested. If you want a
bed, mux it after the render with ffmpeg.
