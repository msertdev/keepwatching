<div align="center">

# keepwatching

### A measured retention database for short-form video formats. That renders.

**[Browse the gallery →](https://msertdev.github.io/keepwatching/)**

</div>

---

Not a video generator. A **database of named formats**, where every row carries a
rendered 9:16 preview, an explicit hypothesis, and whatever the measurements
actually say — including "nothing yet".

|  |  |
|---|---|
| **24** | named formats, 10 families |
| **24** | render deterministically today |
| **0** | formats measured — `n = 0`, and it says so on every card |
| **0** | content axes measured — a **separate** board, never averaged with the above |
| **3** | formats whose demo copy uses real, cited numbers; the other 21 are marked filler |
| **~20s** | to render a 12-second 1080×1920 clip |

Those two zeroes are the point. This repo ships with its evidence columns empty,
because the alternative is publishing numbers nobody can check. Every format is
marked `n: 0 · untested` until a CSV says otherwise.

```bash
git clone https://github.com/msertdev/keepwatching && cd keepwatching
npm install && npm run setup   # seconds if cached, ~2-3 min cold
npx kw gallery                 # renders all 24, builds and serves the gallery
```

`npx kw gallery` is the one command. It renders any preview that is missing
(~25s each, printing `7/24 rendered` as it goes), builds `gallery.json`, and
serves the page at `http://localhost:8080`. To render a single clip instead:
`npx kw render stat-counter-rise` → `out/stat-counter-rise/master.mp4`.

---

## Why this exists

Everyone shares short-form advice. Almost nobody shares the retention curve
behind it, or the number of videos it came from. "Hook them in the first three
seconds" is not a claim you can be wrong about.

So: name the formats, render them so they are comparable, publish the numbers
with their sample sizes, and let anyone add theirs.

A format here is three files:

```
formats/ranking-suspense/
├── format.json   the render spec — deterministic, JSON, no code
├── meta.yml      the claim — an explicit, losable hypothesis, and where its
│                 example numbers came from
└── data.yml      the evidence — in two blocks that never merge
```

The `meta.yml` for that one says:

> Withholding rank 1 until the final second converts the whole clip into a single
> unanswered question, trading early drop-off for a higher completion rate among
> those who stay.
>
> **Avoid when:** the audience already knows the likely #1 — the withholding will
> read as padding.

That is a claim you can measure and lose. `data.yml` says whether it did.

## Two measurements, deliberately kept apart

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

So the separation is enforced in four places at once: they are different types
in `engine/src/format.ts`, different blocks in `data.yml`, two tables with two
baselines in `measure/report.md`, and two colours on the gallery — green for
format, violet for axis, each with its own visible `n`.

The report also prints a **carried by** column: if an axis was only ever carried
by one format, it says so, because those are the same videos wearing two labels
and neither result is isolated.

Axes are yours, not the library's. Declare whatever distinction you actually test
in [`data/content-axes.yml`](data/content-axes.yml) and tag videos with the
optional `content_axis` column in `measure/mapping.csv`.

**Videos whose format is not in this library** get `variant_id: not-in-library`.
Those rows are content-axis samples and nothing else: no format board, no
`data.yml`, no ranking — `kw check` and CI both fail if one leaks. The `carried
by` column names the label so the gap is visible rather than hidden, which is
why an axis can be measured while every format is still `n = 0`.

## Where the demo numbers come from

A library about honest measurement cannot ship invented facts in its own screenshots.

Every `meta.yml` must declare `sampleContent: sourced` or `placeholder`, and
`npx kw check` **fails** if it does not — or if a `sourced` format lacks a URL
and the specific claim that URL backs.

- **3 formats are `sourced`** — `stat-counter-rise` (the speed of light, exact by
  SI definition), `ranking-suspense` (the five highest mountains) and
  `split-compare` (highest vs tallest). Each cites its source on the card.
- **21 formats are `placeholder`** — "Option A", "12,400 units", "Stage 3". Filler
  no reader could mistake for a finding, and the gallery labels it as such.

## The engine

**Node + Playwright + ffmpeg. No React, no Remotion.** Chromium paints each frame
through CDP, ffmpeg encodes the sequence, and the whole thing is a pure function
of the frame number.

The same `format.json` produces the same frames on any machine, forever — which
is the only reason a retention curve can be attributed to a *format* rather than
to one lucky render. `--check-determinism` re-seeks frames out of order and fails
if a single pixel moved.

```bash
npx kw render ranking-suspense --check-determinism
```
```
▸ ranking-suspense  13s @ 30fps = 390 frames
  variant ranking-suspense@1.0.0+7101b32c10da
  determinism ok (4 frames re-seeked out of order)
  verified  1080x1920 · 390 frames · 30fps
```

**The first frame is tested, in every format.** It is the hook and it is the
cover image the platform shows before playback, and it broke twice for unrelated
reasons — both times because the contract was eyeballed on one format. `kw
frame0` now asserts across all 24 that frame 0 paints its promised elements
(DOM) *and* contains real ink (pixels), independently, so a CSS or clip-path
mistake cannot pass by satisfying the DOM alone. It runs in CI, and reinstating
either historical bug fails all 24.

```bash
npx kw frame0
```
```
▸ frame 0
  24 formats checked — DOM, ink coverage, and element content
  ok  bar-race               3 element(s), ink 1.11%
  ...
  every first frame paints its promised content
```

Formats are **data, not code**. Eight element types — `text`, `counter`, `bar`,
`iconGrid`, `list`, `split`, `card`, `image` — plus keyframe tracks and wipes.
There is no per-format code anywhere in the engine. Full reference:
[`skills/keepwatching/references/spec.md`](skills/keepwatching/references/spec.md).

## The measurement loop

The part that makes this a database instead of a template pack. **No API, no
OAuth, no tokens** — friction is why measurement loops die.

```
render  ──>  publish  ──>  export CSV  ──>  ingest  ──>  report  ──>  apply
   │                            │                                       │
   └── variantId ───────────────┴─── mapping.csv ────────────────────────┘
```

1. Every render stamps a **variant id** — `slug@version+hash-of-the-spec` — into
   `out/<slug>/variant.json` and into the MP4's metadata. Edit one pixel-affecting
   field and the hash changes, so a measurement can never be silently attributed
   to a spec that has since moved.
2. You write one line in `measure/mapping.csv` at upload time.
3. Export CSVs from YouTube Studio or TikTok analytics into `measure/inbox/`.

```bash
npx kw measure           # -> measure/report.md, "which format won"
npx kw measure apply     # writes formats/*/data.yml
npx kw gallery           # re-render + rebuild the gallery
```

`data.yml` is machine-written and **never edited by hand**. A number typed from
memory is indistinguishable from a number that was invented, and the whole repo
rests on that distinction.

Full instructions, including which export button to press:
[`references/measuring.md`](skills/keepwatching/references/measuring.md).

## Install as an agent skill

Works in Claude Code, Codex, Cursor, Windsurf, and anything else that reads a
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
repo, so the instruction file alone renders nothing. `KEEPWATCHING_HOME` is how
the agent finds it from another project.

**Measured onboarding.** An independent agent, given only `SKILL.md` and an
empty directory, went from nothing to a verified 15-second MP4 without help.
Timed with `date +%s` on a machine that already had npm and Chromium cached:

| step | time |
|---|---|
| `npm install` | 6s |
| `npm run setup` | 4s (cache hit on Chromium) |
| first render, 15s clip | 37s |

The 4s is not representative of a cold machine: `npm run setup` fetches Inter
(≈30 MB) and a headless Chromium (≈150 MB), so budget **2–3 minutes** on a fresh
box with a normal connection. Either way, comfortably under five minutes to a
first rendered clip.

The skill teaches an agent to pick a format for a topic, fill in a `data` block,
render, and read the numbers back — and, more importantly, **never to invent a
number**, whether that is a retention figure or a statistic on screen. Every
performance claim has to come from a `data.yml` with an `n` attached, and every
number in a rendered clip has to come from a cited source.

## Honesty rules

Not style preferences. The repo is worthless if they slip.

1. **`n: 0` means untested.** Never rounded up to "promising".
2. **Under n=5 is a direction, not a result.** Say which one you are giving.
3. **Losing formats stay listed, with their numbers.** A format that measured
   badly is the most useful row in the table.
4. **Only `kw measure apply` writes `data.yml`.**
5. **A format number and an axis number are never averaged.** Enforced by the
   types, the schema, the report and the gallery — see above.
6. **Every number on screen carries a source, or is labelled filler.** `kw check`
   fails otherwise.
7. **Seed data is one creator's channel** — a starting point, not a law of the
   platform. Your audience is not that audience, which is why you can run your
   own A/B and send it back.

## Contributing your measurements

The library is only as good as its `n`. If you publish with a format from this
repo, sending the numbers back costs one command and one CSV:

```bash
npx kw measure && npx kw measure apply
git checkout -b measure/my-channel && git commit -am "measure: 6 samples, ranking-*"
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for what a measurement PR needs — and what
gets rejected (chiefly: numbers with no `n`, and formats that are re-skins).

New formats are welcome too. The bar: a hypothesis you could lose, not a re-skin,
and it generalises past one video.
[`references/authoring.md`](skills/keepwatching/references/authoring.md).

## Commands

```
kw setup                     install Inter + a headless Chromium (run once)
kw list                      every format, with its sample size
kw check                     validate every format.json
kw render <slug> | --all     render to out/<slug>/
    --stills                 poster + contact sheet only, no encode
    --check-determinism      re-seek frames out of order and compare hashes
kw preview <slug>            scrub a format in a browser
kw new <slug> --from=<slug>  scaffold a new format
kw variant <slug>            print the variant id for the current spec
kw gallery                   render what is missing, build and serve the gallery
kw site build --allow-missing  rebuild gallery.json without every preview
kw measure [ingest|report|apply]
```

## Licence

MIT. Inter is bundled at setup time under the SIL Open Font License 1.1.
No music beds ship with this repo — point `audio.bed` at a file you have the
rights to.
