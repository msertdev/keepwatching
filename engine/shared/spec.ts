/**
 * keepwatching — format spec.
 *
 * A format is data, not code. `format.json` describes a 9:16 scene as a list of
 * elements whose visual state is a pure function of the frame number. The same
 * types are used by the Node renderer and by the in-page composition, so there
 * is exactly one definition of what a format is.
 *
 * Determinism contract: nothing in this file, or anything driven by it, may read
 * a clock, a random source, or the network at seek time.
 */

/* ------------------------------------------------------------------ scene */

export type ElementType =
  | "text"
  | "counter"
  | "bar"
  | "iconGrid"
  | "list"
  | "split"
  | "card"
  | "image";

/** A colour is a theme token name or any CSS colour string. */
export type Color = string;

export type EaseName = "linear" | "smooth" | "in" | "out" | "spring";

/**
 * Animatable element properties, in stage pixels or unitless.
 *
 * `reveal` uncovers the element from the left edge rightwards (0 = hidden).
 * `clip` does the opposite: it hides the element from the left edge rightwards
 * (0 = fully visible), so a pair of elements can be wiped one into the other.
 */
export type AnimProp = "x" | "y" | "scale" | "opacity" | "rotate" | "reveal" | "clip";

export interface Track {
  prop: AnimProp;
  /** `[timeSec, value]` pairs, ascending in time. Held flat outside the range. */
  keys: Array<[number, number]>;
  ease?: EaseName;
}

/** Enter / exit transition. `move` is a [dx, dy] offset the element travels from. */
export interface Transition {
  at: number;
  dur?: number;
  move?: [number, number];
  scale?: number;
  ease?: EaseName;
}

export interface Box {
  /** Left edge in stage px. Defaults to the safe-zone left edge. */
  x?: number;
  /** Top edge in stage px. Required. */
  y: number;
  /** Width in stage px. Defaults to the safe-zone width. */
  w?: number;
}

export interface FontSpec {
  size?: number;
  weight?: 400 | 500 | 600 | 700 | 800 | 900;
  color?: Color;
  /** Letter spacing in em. */
  tracking?: number;
  lineHeight?: number;
  case?: "none" | "upper" | "lower";
  /** Shrink-to-fit the widest line into the box width. Default true. */
  fit?: boolean;
  /** Lower bound for shrink-to-fit. */
  minSize?: number;
}

export interface ElementBase {
  id: string;
  type: ElementType;
  box: Box;
  /**
   * Asserts that this element's wording stays true while a `claim: "final"`
   * counter is still counting — because it is neutral ("counting…"), or frames
   * the subject without stating the value.
   *
   * A sourced format refuses to build unless every element on screen during the
   * count carries this. The default is the safe one: an unmarked element beside
   * an unfinished sourced number is an error, not a warning.
   */
  neutralWhileCounting?: boolean;
  align?: "left" | "center" | "right";
  /** Visible window in seconds. Defaults to the whole clip. */
  at?: number;
  until?: number;
  in?: Transition;
  out?: Transition;
  tracks?: Track[];
  /** Rendered behind lower-z elements. Default 0. */
  z?: number;
  /** Optional rounded panel painted behind the element. */
  panel?: {
    fill?: Color;
    stroke?: Color;
    radius?: number;
    padX?: number;
    padY?: number;
  };
}

export interface TextElement extends ElementBase {
  type: "text";
  /** Supports `{{field}}` interpolation against `data`. */
  text: string;
  font?: FontSpec;
  /** Max words per rendered line before wrapping. Default 5. */
  wrapAt?: number;
  /** Reveal one line every `stagger` seconds after the element enters. */
  stagger?: number;
}

/**
 * When a counter's displayed value is a claim.
 *
 *   "final"   — only the number it settles on is the claim. Every intermediate
 *               value is wrong, so nothing on screen may assert the final value
 *               until it lands.
 *   "running" — every intermediate value is true as a running total ("frames so
 *               far", "icons shown"). Labels may state the unit throughout.
 */
export type CounterClaim = "final" | "running";

export interface CounterElement extends ElementBase {
  type: "counter";
  from: number;
  to: number;
  /** Required when the format's sample content is `sourced`. */
  claim?: CounterClaim;
  /** Counting window in seconds. Defaults to the element's visible window. */
  startSec?: number;
  endSec?: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  /** Thousands separators. Default true. */
  group?: boolean;
  /** Zero-pad the integer part to this many digits (for clock-style counts). */
  pad?: number;
  /** Render as mm:ss. Overrides prefix/suffix formatting of the number itself. */
  clock?: boolean;
  ease?: EaseName;
  font?: FontSpec;
}

export interface BarElement extends ElementBase {
  type: "bar";
  from?: number;
  to?: number;
  startSec?: number;
  endSec?: number;
  height?: number;
  radius?: number;
  fill?: Color;
  trackColor?: Color;
  ease?: EaseName;
  /** Tick marks at these fractions of the bar (0..1). */
  ticks?: number[];
}

export interface IconGridElement extends ElementBase {
  type: "iconGrid";
  icon: string;
  count: number;
  columns?: number;
  size?: number;
  gap?: number;
  color?: Color;
  dimColor?: Color;
  /** One icon lights up every `everySec` seconds after the element enters. */
  everySec?: number;
}

export interface ListRow {
  label: string;
  value?: string;
  /** 0..1 — drives the row's bar width when `bars` is on. */
  weight?: number;
  color?: Color;
  badge?: string;
}

export interface ListElement extends ElementBase {
  type: "list";
  rows: ListRow[];
  /** Seconds between row reveals. Default 0.5. */
  stagger?: number;
  rowHeight?: number;
  gap?: number;
  font?: FontSpec;
  /** Show a weight bar behind each row. */
  bars?: boolean;
  /** Prefix each row with its 1-based rank. */
  rank?: boolean;
  /** Reveal from the bottom of the list upwards. */
  reverse?: boolean;
  /** Highlight this 0-based row from `highlightAt` seconds onward. */
  highlight?: number;
  highlightAt?: number;
}

export interface SplitElement extends ElementBase {
  type: "split";
  left: { title: string; body?: string; value?: string; color?: Color };
  right: { title: string; body?: string; value?: string; color?: Color };
  height?: number;
  gap?: number;
  /** Seconds after entry before the right side appears. Default 0. */
  rightDelay?: number;
  font?: FontSpec;
  /** Draw a divider glyph between the panels, e.g. "VS". */
  divider?: string;
}

export interface CardElement extends ElementBase {
  type: "card";
  h: number;
  fill?: Color;
  stroke?: Color;
  radius?: number;
}

export interface ImageElement extends ElementBase {
  type: "image";
  /** Path relative to the format directory. */
  src: string;
  h?: number;
  fit?: "cover" | "contain";
  radius?: number;
}

export type Element =
  | TextElement
  | CounterElement
  | BarElement
  | IconGridElement
  | ListElement
  | SplitElement
  | CardElement
  | ImageElement;

/* ----------------------------------------------------------------- format */

export interface Theme {
  bg?: Color;
  fg?: Color;
  muted?: Color;
  accent?: Color;
  accent2?: Color;
  /** Soft radial accent wash behind the scene. 0 disables it. */
  glow?: number;
  glowY?: number;
}

export interface Safe {
  top: number;
  bottom: number;
  side: number;
}

export interface Canvas {
  w: number;
  h: number;
  fps: number;
  durationSec: number;
}

export interface FormatSpec {
  /** Slug. Must match the containing directory name. */
  id: string;
  /** Bumped whenever the visual output changes — part of the variant id. */
  version: string;
  canvas: Canvas;
  theme?: Theme;
  safe?: Safe;
  /**
   * Second to grab the poster frame from — the still a gallery card shows when
   * it is not playing, and the cover a platform shows before playback. Pick the
   * moment the scene is fullest, usually just after the last element lands.
   * Defaults to 35% of the clip, which is often too early to look finished.
   */
  posterSec?: number;
  /** Values interpolated into `{{field}}` placeholders across the scene. */
  data?: Record<string, string | number>;
  scene: Element[];
}

/* ---------------------------------------------------------------- defaults */

export const DEFAULT_CANVAS: Canvas = { w: 1080, h: 1920, fps: 30, durationSec: 12 };
export const DEFAULT_SAFE: Safe = { top: 130, bottom: 320, side: 60 };
export const DEFAULT_THEME: Required<Omit<Theme, "glow" | "glowY">> & {
  glow: number;
  glowY: number;
} = {
  bg: "#0b0f14",
  fg: "#ffffff",
  muted: "rgba(255,255,255,0.62)",
  accent: "#22c55e",
  accent2: "#38bdf8",
  glow: 0.16,
  glowY: 760,
};

/* ------------------------------------------------------------ pure helpers */

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function easeFn(name: EaseName | undefined, t: number): number {
  const c = clamp01(t);
  switch (name) {
    case "linear":
      return c;
    case "in":
      return c * c;
    case "out":
      return 1 - (1 - c) * (1 - c);
    case "spring":
      /* Critically damped overshoot, evaluated in closed form — no simulation,
         so it stays a pure function of t. */
      return 1 - Math.exp(-6 * c) * Math.cos(6.2 * c);
    case "smooth":
    default:
      return c * c * (3 - 2 * c);
  }
}

/** Sample a keyframe track at time `t`, holding the end values flat. */
export function sampleTrack(track: Track, t: number): number {
  const k = track.keys;
  if (k.length === 0) return 0;
  if (t <= k[0][0]) return k[0][1];
  if (t >= k[k.length - 1][0]) return k[k.length - 1][1];
  for (let i = 0; i < k.length - 1; i++) {
    const [t0, v0] = k[i];
    const [t1, v1] = k[i + 1];
    if (t >= t0 && t <= t1) {
      const u = t1 === t0 ? 1 : (t - t0) / (t1 - t0);
      return lerp(v0, v1, easeFn(track.ease, u));
    }
  }
  return k[k.length - 1][1];
}

/**
 * Balanced word wrap. Seven words at max three become 3+2+2, never 3+3+1 — a
 * short orphan line reads as a mistake and drags the eye off the sentence.
 */
export function wrapWords(text: string, maxWords = 5): string[] {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [""];
  const lineCount = Math.max(1, Math.ceil(words.length / maxWords));
  const base = Math.floor(words.length / lineCount);
  const extra = words.length % lineCount;

  const lines: string[] = [];
  let i = 0;
  for (let l = 0; l < lineCount; l++) {
    const take = base + (l < extra ? 1 : 0);
    lines.push(words.slice(i, i + take).join(" "));
    i += take;
  }
  return lines;
}

/** Replace `{{field}}` with values from `data`. Unknown fields are left as-is. */
export function interpolate(text: string, data: Record<string, string | number> = {}): string {
  return String(text).replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, key: string) =>
    key in data ? String(data[key]) : m
  );
}

export function formatNumber(
  value: number,
  opts: { decimals?: number; group?: boolean; pad?: number } = {}
): string {
  const decimals = opts.decimals ?? 0;
  const factor = Math.pow(10, decimals);
  /* Floor, not round: a counter must never briefly show a value it has not
     reached yet, and the final frame must land exactly on `to`. */
  const v = Math.floor(value * factor + 1e-6) / factor;
  const neg = v < 0;
  const abs = Math.abs(v);
  const fixed = abs.toFixed(decimals);
  let [int, frac] = fixed.split(".");
  if (opts.pad) int = int.padStart(opts.pad, "0");
  if (opts.group !== false) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${int}${frac ? "." + frac : ""}`;
}

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds + 1e-6));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export const totalFrames = (spec: FormatSpec): number =>
  Math.round(spec.canvas.durationSec * spec.canvas.fps);
