# `format.json` reference

A format is data. The renderer holds no per-format code, so anything you can
describe here can be rendered, and anything you cannot describe here needs a new
element type in `engine/composition/comp.ts` — not a special case.

## Top level

```jsonc
{
  "id": "my-format",              // must equal the directory name
  "version": "1.0.0",             // bump on any pixel-affecting change
  "canvas": { "w": 1080, "h": 1920, "fps": 30, "durationSec": 12 },
  "theme":  { "bg": "#0b0f14", "fg": "#ffffff", "muted": "rgba(255,255,255,0.62)",
              "accent": "#22c55e", "accent2": "#38bdf8", "glow": 0.14, "glowY": 760 },
  "safe":   { "top": 130, "bottom": 320, "side": 60 },
  "posterSec": 8.4,               // the still a card rests on; see below
  "data":   { "headline": "…" },  // interpolated into {{headline}} anywhere
  "scene":  [ /* elements */ ]
}
```

- `durationSec x fps` must be a whole number of frames.
- `safe.bottom` defaults to 320px because platform UI (caption, buttons,
  username) covers roughly that much of a 1920px-tall frame. Keep meaning above it.
- `theme.glow` is a soft radial accent wash; `0` turns it off.
- Clips render **silent**. There is no `audio` block: one existed, no format
  used it, and untested code in a repo about verification is a liability. Mux a
  bed after the render if you want one.
- **`posterSec`** is the second the poster frame is grabbed from — the still a
  gallery card shows when it is not playing, and the cover a platform shows
  before playback. Pick the moment the scene is fullest, usually just after the
  last element lands and before the closing hold. It defaults to 35% of the
  clip, which is often too early to look finished. `kw frame0` fails a format
  whose poster carries too little ink or whose content spans too little of the
  frame height.

## Common element fields

Every element accepts these:

| Field | Meaning |
|---|---|
| `id` | Unique within the scene. |
| `type` | One of the eight below. |
| `box` | `{ y, x?, w? }` in stage px. `x`/`w` default to the safe zone. `y` is required. |
| `align` | `left` / `center` / `right`. Default `center`. |
| `at` | Second the element enters. Default 0. |
| `until` | Second it leaves. Default: end of clip. |
| `in` | `{ at, dur, move: [dx,dy], scale, ease }` — entry transition. |
| `out` | Same shape — exit transition. |
| `z` | Paint order. Default 0. |
| `panel` | `{ fill, stroke, radius, padX, padY }` — a rounded panel behind it. |
| `tracks` | Keyframe animation, below. |

**Elements present at `t=0` with no explicit `in` appear instantly on frame 0.**
A short-form clip that fades up from black spends its most valuable second
showing nothing. Give an explicit `in` if you want the fade anyway.

## Elements

### `text`
```jsonc
{ "id": "hook", "type": "text", "box": { "y": 700 }, "text": "{{headline}}",
  "wrapAt": 4,          // max words per line; wrapping is balanced (3+2+2, not 3+3+1)
  "stagger": 0.4,       // reveal one line every 0.4s
  "font": { "size": 96, "weight": 800, "color": "accent", "tracking": -0.02,
            "lineHeight": 1.1, "case": "upper", "fit": true, "minSize": 24 } }
```
`fit` (default true) shrinks the font until the widest line fits `box.w`. It never
grows the font, and it is measured once at init with the real font loaded.

### `counter`
```jsonc
{ "id": "n", "type": "counter", "box": { "y": 640 },
  "from": 0, "to": 1020000, "startSec": 0.2, "endSec": 6.4,
  "ease": "out", "prefix": "$", "suffix": " L", "decimals": 1,
  "group": true, "pad": 2, "clock": false,
  "font": { "size": 230, "weight": 800 } }
```
The font is fitted against the *widest value the counter ever shows*, so digits
never resize mid-count. Values are floored, never rounded — a counter must not
briefly display a number it has not reached. `clock: true` renders `mm:ss`.

**`claim` — required when the format is `sampleContent: sourced`.**

| value | meaning |
|---|---|
| `"final"` | Only the settled number is the claim. Every intermediate value is wrong. |
| `"running"` | Every intermediate value is true as a running total ("frames so far"). |

A counter animating to 299,792,458 shows a false number for six seconds. If a
unit and a word like "exactly" sit under it the whole time, anyone who pauses or
screenshots sees a sourced, precision-marked claim that is untrue — and the
citation lends authority to the wrong figure.

So in a `sourced` format, **every element on screen while a `claim: "final"`
counter is still counting must set `neutralWhileCounting: true`**, asserting its
wording stays true while the number is wrong. `kw check` fails otherwise; the
default is the unsafe case being rejected. Put the unit and any certainty
language at `at: <the counter's endSec>`, and show something neutral
("counting…") until then.

`kw frame0` checks the other half: a `claim: "final"` counter must actually
display the cited number at its settle time, so a citation can never back a
figure the clip never reaches.

### `bar`
```jsonc
{ "id": "b", "type": "bar", "box": { "y": 1090, "x": 180, "w": 720 },
  "from": 0, "to": 1, "startSec": 0, "endSec": 10,
  "height": 22, "radius": 11, "fill": "accent",
  "trackColor": "rgba(255,255,255,0.12)", "ticks": [0.25, 0.5, 0.75] }
```

### `iconGrid`
```jsonc
{ "id": "g", "type": "iconGrid", "box": { "y": 880 },
  "icon": "phone", "count": 60, "columns": 10, "size": 66, "gap": 16,
  "everySec": 0.15, "color": "accent", "dimColor": "rgba(255,255,255,0.10)" }
```
One icon lights every `everySec`. Icons: `dot square check cross person coin
clock bolt heart globe search phone star flag arrowUp arrowDown eye lock fire
brain`. Cap is 200.

### `list`
```jsonc
{ "id": "rows", "type": "list", "box": { "y": 560 }, "at": 0.6,
  "stagger": 0.85, "reverse": false, "rank": true, "bars": true,
  "rowHeight": 132, "gap": 20, "highlight": 0, "highlightAt": 9.6,
  "font": { "size": 48, "weight": 700 },
  "rows": [ { "label": "Short video", "value": "14.2h", "weight": 1.0,
              "color": "#22c55e", "badge": "S" } ] }
```
`reverse` reveals bottom-to-top (the suspense ordering). `weight` (0..1) drives
the bar behind each row. `highlight` outlines one row from `highlightAt` onward.

### `split`
```jsonc
{ "id": "vs", "type": "split", "box": { "y": 620 }, "at": 0.8,
  "rightDelay": 3.2, "height": 520, "gap": 26, "divider": "vs",
  "font": { "size": 44 },
  "left":  { "title": "1 cup of coffee", "value": "34 L", "body": "…", "color": "#38bdf8" },
  "right": { "title": "1 almond",        "value": "12 L", "body": "…", "color": "#f472b6" } }
```
`rightDelay` is the whole trick: it forces the viewer to commit to a guess before
the second panel arrives.

### `card`, `image`
```jsonc
{ "id": "panel", "type": "card", "box": { "y": 620 }, "h": 640,
  "fill": "rgba(255,255,255,0.06)", "stroke": "accent", "radius": 36 }
{ "id": "shot", "type": "image", "box": { "y": 620 }, "src": "photo.jpg",
  "h": 640, "fit": "cover", "radius": 24 }
```
`image.src` is relative to the format directory.

## Animation

### Transitions
`in` / `out` take `{ at, dur, move: [dx, dy], scale, ease }`. `move` is the offset
the element travels *from* on entry, or *to* on exit.

### Keyframe tracks
```jsonc
"tracks": [ { "prop": "y", "keys": [[0, 0], [2, -60]], "ease": "smooth" } ]
```
Props: `x`, `y`, `scale`, `opacity`, `rotate`, `reveal`, `clip`. Values are held
flat outside the first and last key. Tracks compose with transitions rather than
replacing them (`x`/`y`/`rotate` add, `scale`/`opacity` multiply).

`reveal` uncovers the element left-to-right (0 = hidden). `clip` hides it
left-to-right (0 = fully visible). Put a `reveal` on the incoming layer and a
`clip` on the outgoing one to wipe cleanly between them — this is how
`before-after` works.

Eases: `linear`, `smooth` (default), `in`, `out`, `spring`.

## Colours

Any CSS colour, or a theme token: `bg`, `fg`, `muted`, `accent`, `accent2`.
Prefer tokens — a format that only uses tokens can be re-themed for a channel by
editing four lines.

## Validation

`npx kw check` runs on every format and refuses:
- an `id` that does not match the directory
- a non-vertical canvas
- `durationSec x fps` that is not a whole number of frames
- duplicate element ids, unknown types, a missing `box.y`
- `until` past the end of the clip, or keyframes that do not ascend in time
