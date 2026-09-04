# Writing a format worth measuring

A format is a claim about attention, written so it can be proved wrong.

## The bar

Before adding one, it must pass three tests:

1. **It has a hypothesis you could lose.** "This looks nice" is not a hypothesis.
   "Withholding rank 1 until the final second trades early drop-off for higher
   completion" is — you can measure both halves and be wrong about either.
2. **It is not a re-skin.** A different accent colour is a theme, not a format.
   If two formats would produce the same retention curve, they are one format.
3. **It generalises past one video.** If it only works for your specific topic,
   it belongs in your own repo as a `data` block, not in the library.

## Scaffold

```bash
npx kw new my-format --from=cold-open-line   # or omit --from for a blank one
npx kw preview my-format                     # scrub before you render anything
```

Three files result:

```
formats/my-format/
├── format.json   the render spec        (see references/spec.md)
├── meta.yml      the claim
└── data.yml      the evidence — starts at n: 0, and that is fine
```

## Writing `meta.yml`

```yaml
name: "Ranking — bottom up"
family: ranking
hypothesis: >-
  Withholding rank 1 until the final second converts the whole clip into a single
  unanswered question, trading early drop-off for a higher completion rate among
  those who stay.
useWhen: >-
  Completion and replays matter more than immediate shares.
avoidWhen: >-
  The audience already knows the likely #1 — the withholding will read as padding.
tags: ["list", "ranking", "suspense"]
inputs:
  - key: title
    description: What is being ranked.
```

- **`hypothesis`** names a mechanism and a cost. Good hypotheses predict a
  *tradeoff*, because a format that is better at everything is usually a format
  nobody measured properly.
- **`avoidWhen`** is not optional politeness. A format with no failure mode has
  not been thought about.
- **`family`** is one of: `stat-counter`, `countdown`, `ranking`, `comparison`,
  `reveal`, `myth-fact`, `cold-open`, `progress`, `escalation`, `reverse`.

## Declaring where the example copy came from

Every `meta.yml` must carry one of these, and `kw check` fails without it:

```yaml
sampleContent: placeholder    # the data block is obvious filler
```

```yaml
sampleContent: sourced
sources:
  - title: "BIPM — The International System of Units (SI), 9th edition, 2019"
    url: https://www.bipm.org/en/publications/si-brochure
    claim: "The speed of light in vacuum is exactly 299,792,458 m/s."
```

**Write the example copy about the format itself, or about the viewer.** That
is how a card can look finished without asserting anything that needs a
citation:

> "The reason you are still watching is that this loop never finishes."
> "You read this before deciding to scroll."
> "You waited four seconds to find that out."

The word "placeholder" must never appear in a rendered frame. A gallery is
screenshotted, and copy that announces itself as filler makes the whole library
look unfinished rather than honest. `sampleContent: placeholder` is still the
right declaration for these — the field records whether the *claim* is sourced,
not whether the *writing* is good.

Reach for `sourced` only when the format's whole point is a factual claim
(`myth-fact`, a real ranking). Then cite a primary source and state the exact
claim it backs, including any rounding you did for the screen.

## Layout rules

The stage is 1080x1920. The safe zone is `y` 130–1600.

- **Nothing meaningful below y=1600.** Platform UI covers it.
- **The first thing the viewer reads is the whole hook.** Give it the largest
  type in the scene and put it in the upper half.
- **One idea per beat.** If two elements enter within 0.2s of each other, they
  are one beat — make sure they read as one.
- **Frame 0 is not blank.** Anything at `t=0` with no explicit `in` paints
  instantly. Do not add a fade unless the fade is the point.
- **Set `posterSec`.** It is the still the card rests on and the cover the
  platform shows. Aim for the moment the scene is fullest — after the last
  element lands, before the closing hold. `kw frame0` fails a poster that is too
  sparse or whose content hugs one band of the frame.
- **Let `fit` do the sizing.** Set the size you want and let shrink-to-fit
  protect you from a long input string. Do not hand-tune font sizes to your
  placeholder copy — someone else's copy will be longer.

## Timing rules

- Under 15 seconds. Beyond that the retention curve is measuring patience, not
  format.
- The last frame lands exactly on `durationSec`, so end-state values match what
  the copy promised.
- Leave 1.5–2s on the final state. A payoff that appears and immediately cuts is
  a payoff nobody read.

## Determinism

The renderer paints a frame as a pure function of its number. In the composition,
never use `Date.now()`, `Math.random()`, `requestAnimationFrame`, CSS
`transition`, or CSS `animation`. Verify before opening a PR:

```bash
npx kw render my-format --check-determinism
```

It re-seeks frames out of order and fails if any pixel moved.

## `data.yml` stays empty

A new format ships as:

```yaml
format:
  n: 0
  status: untested
content_axis:
  n: 0
  status: untested
  axes: []
```

Both blocks start empty and they stay separate: `format` is how the scene
structure performed, `content_axis` is how the subject matter performed. They are
never averaged together, so never move a number from one into the other.

That is the correct, honest state, and the gallery shows it as such rather than
hiding it. Filling it in by hand — even with numbers you believe — makes every
other number in the repo untrustworthy, because a reader can no longer tell which
ones came from a CSV.
