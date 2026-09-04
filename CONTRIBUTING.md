# Contributing

Two kinds of contribution matter here, and the first one matters more.

---

## 1. Send your measurements

**This is the contribution the project needs.** The format library is only worth
its sample sizes, and right now most of them are zero.

You do not need to have used this repo's renderer for the format to count — but
you do need to be able to attribute a published video to a specific variant.

### The flow

```bash
# 1. Publish something rendered from this repo, and record its variant id
npx kw variant ranking-suspense
# ranking-suspense@1.0.0+7101b32c10da

# 2. One line in measure/mapping.csv, written at upload time
#    platform,external_id,variant_id,published_at,content_axis

# 3. Wait 72 hours. Early numbers are platform push, not format quality.

# 4. Export analytics CSVs into measure/inbox/ (see references/measuring.md)
npx kw measure
npx kw measure apply

# 5. Open a PR
git checkout -b measure/<your-handle>
git add formats/*/data.yml measure/mapping.csv
git commit -m "measure: 6 samples across ranking-*"
```

### The one-click route

If you would rather not clone anything:
**[Submit a measurement →](https://github.com/msertdev/keepwatching/issues/new?template=measurement.yml)**

The form asks for exactly the fields below, and refuses to submit without the
ones that make a number checkable.

### Required fields, and why each one

| Field | Why it is required |
|---|---|
| `variant_id` | Without it the number is attached to nothing. `not-in-library` is a valid answer for a format that is not in this repo — it will count toward a content axis and never toward a format. |
| `platform` + `external_id` | So the row can be audited against the export it came from. |
| `published_at` | Age drives everything early. A day-one number and a week-one number are different measurements. |
| **`measured_at`** | **Views and retention both move.** A figure with no reading date cannot be compared with anything, and it is the field people skip. Two readings of the same video days apart are two observations, not a contradiction — both are kept. |
| `n` | Videos, not views. A retention figure without a sample size is a vibe. |
| `source` | `csv` or `manual`. Hand-entered numbers are kept and rendered distinctly; neither is better, the difference just has to be visible. |
| confounds | Follower band, posting time, whether topics differed. Every number here is confounded by something. |

Anything your export does not contain is left **blank**. Never estimated, never
interpolated, never rounded to something tidier. A null is more useful than a
guess.

### What each platform actually gives you

| Platform | Export | Retention curve? |
|---|---|---|
| YouTube Studio | Analytics → Content → **Advanced mode** → Export → CSV | Yes, per video: Engagement → Audience retention → Export |
| TikTok | Analytics → Content → Download data | Not in the export in most regions — read it by hand and mark `manual` |
| Instagram | No usable export — read the reel dashboard by hand | No |

**Instagram has no ingest path.** `kw measure` reads YouTube and TikTok exports
only. A reel measurement is welcome, but it is entered by hand into
`measure/manual.yml` and marked `source: manual`.

A YouTube *table* export carries no retention column, so `hook_3s` comes from
the separate audience-retention export or stays blank. Save that one as
`measure/inbox/retention/<video_id>.csv` — the filename is how it gets matched.

Delimiter and decimal separator are sniffed per file, so a semicolon-delimited
export with comma decimals reads correctly with no configuration. A genuinely
ambiguous number (`1,234` — is that 1234 or 1.234?) returns null rather than a
guess.

### What a measurement PR must include

- **The `data.yml` diffs**, written by `kw measure apply` — not by hand.
- **The `mapping.csv` rows**, so the join is auditable.
- **Which board the result belongs to.** A `format` result is a claim about scene
  structure; a `content_axis` result is a claim about subject matter. They live in
  separate blocks and are never averaged. If your videos carried a `content_axis`
  label, say whether each axis ran across more than one format — an axis carried
  by a single format is that format's result wearing a second label.
- **A note in the PR describing the confound**: your follower count band, the
  platform, roughly when you posted, and whether the topics differed between
  variants. Every number here is confounded by something; saying which one is
  the difference between data and decoration.

### What gets rejected

- **Numbers with no `n`.** A retention figure without a sample size is a vibe.
- **Hand-edited `data.yml`.** If `kw measure apply` did not write it, it does not
  go in. This is not about trusting you; it is about a reader six months from now
  being able to tell which numbers came from a CSV.
- **Aggregates with no `mapping.csv`.** "My ranking videos average 62%" is not
  attributable to a variant.
- **Samples under 3** submitted as a result. Send them anyway — they will be
  merged and shown as `n: 2`, which is honest — just do not describe them as
  a finding.
- **A blended format/axis number.** "My personal-body countdowns hit 68%" is one
  number for two claims. Report the two separately, or report it as a single
  confounded observation and say so.

Small n is welcome. Overclaiming is not.

---

## 2. Add a format

The bar is deliberately high, because a library of near-duplicates cannot be
ranked meaningfully.

A new format must:

1. **Have a hypothesis you could lose.** "This looks nice" is not one. Good
   hypotheses name a *mechanism* and a *cost* — a format that is better at
   everything is usually a format nobody measured properly.
2. **Not be a re-skin.** A different accent colour is a theme. If two formats
   would produce the same retention curve, they are one format.
3. **Generalise past one video.** If it only works for your topic, it is a `data`
   block, not a format.

```bash
npx kw new my-format --from=cold-open-line
npx kw preview my-format
npx kw render my-format --check-determinism
npx kw check
```

Your `meta.yml` must declare `sampleContent: placeholder` (obvious filler — the
default and usually the right call) or `sampleContent: sourced` with a `sources:`
list giving a URL and the exact claim each source backs. `kw check` fails without
it, and CI runs `kw check`. A library about honest measurement does not ship
unattributed numbers in its own demo copy.

Full guidance: [`references/authoring.md`](skills/keepwatching/references/authoring.md).

`data.yml` ships as `n: 0 · untested`. That is correct and the gallery shows it
as such. Do not pre-fill it.

---

## 3. Work on the engine

The one rule: **determinism**. The composition must paint a frame as a pure
function of its number. Never introduce into `engine/composition/`:

- `Date.now()`, `performance.now()`, `Math.random()`
- `requestAnimationFrame`, `setTimeout`, `setInterval`
- CSS `transition` or `animation`
- anything that measures layout inside `seek()` — measure once in `init()`

Before opening a PR:

```bash
npx kw check                                    # every format validates
npx kw render stat-counter-rise --check-determinism
npx tsc --noEmit
npm test                                        # the measurement reader
```

If you touched anything under `measure/src/` that reads a date or a number,
run the tests under a non-UTC timezone too:

```bash
TZ=Europe/Istanbul npm test
```

CI does this across four zones. It is not ceremony: the one bug this project
has actually shipped was a date that came out right in UTC and a day early
everywhere else, and a UTC-only test run went green on it.

If you add an element type, it needs: a type in `engine/shared/spec.ts`, a
`build()` branch and a `paint()` branch in `comp.ts`, validation in
`format.ts`, and an entry in `references/spec.md`. The `paint()` branch must
write unconditionally, even when the element is invisible — skipping the write
would leave the DOM holding a previous frame's state, which makes the output a
function of seek history rather than of time.

---

## Code of conduct

Be straightforward and assume good faith. Disagreements about what the numbers
mean are the entire point of the project; disagreements about people are not.

## Licence

By contributing you agree your work is released under the MIT licence.
