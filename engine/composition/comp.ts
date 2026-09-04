/**
 * keepwatching — composition runtime.
 *
 * Contract: `window.seek(frame)` synchronously paints the exact visual state for
 * that frame and nothing else. No Date.now, no Math.random, no requestAnimationFrame,
 * no CSS transitions or keyframes. seek(n) called twice produces identical pixels,
 * and the pixels never depend on which frames were seeked before.
 *
 * All measurement happens once, in init(), and is baked into the state. seek()
 * only writes styles and text.
 */

import {
  DEFAULT_CANVAS,
  DEFAULT_SAFE,
  DEFAULT_THEME,
  clamp01,
  easeFn,
  formatClock,
  formatNumber,
  interpolate,
  lerp,
  sampleTrack,
  wrapWords,
  type BarElement,
  type CardElement,
  type CounterElement,
  type Element,
  type FormatSpec,
  type IconGridElement,
  type ImageElement,
  type ListElement,
  type SplitElement,
  type TextElement,
  type Transition,
} from "../shared/spec.js";
import { iconSvg } from "./icons.js";

/* ---------------------------------------------------------------- helpers */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`composition: missing #${id}`);
  return el as T;
};

const THEME_TOKENS = new Set(["bg", "fg", "muted", "accent", "accent2"]);
const color = (c: string | undefined, fallback = "fg"): string => {
  const v = c ?? fallback;
  return THEME_TOKENS.has(v) ? `var(--${v})` : v;
};

const DEFAULT_IN_DUR = 0.4;
const DEFAULT_OUT_DUR = 0.35;

function applyCase(text: string, mode: string | undefined): string {
  if (mode === "upper") return text.toUpperCase();
  if (mode === "lower") return text.toLowerCase();
  return text;
}

/** Widest rendered line inside a block, in px. */
function widestLine(el: HTMLElement): number {
  let w = 0;
  el.querySelectorAll<HTMLElement>(".ln > span").forEach((s) => {
    w = Math.max(w, s.getBoundingClientRect().width);
  });
  if (w === 0) w = el.getBoundingClientRect().width;
  return w;
}

/**
 * Shrink-to-fit. Sets the base size, measures the real glyph width, then scales
 * the font down (never up) until the widest line fits. Runs once at init so the
 * result is baked in and seek() never triggers a font-size-dependent reflow.
 */
function fitFont(el: HTMLElement, base: number, maxWidth: number, minSize = 18): number {
  el.style.fontSize = `${base}px`;
  const w = widestLine(el);
  if (w <= maxWidth || w === 0) return base;
  const size = Math.max(minSize, Math.floor((base * maxWidth) / w));
  el.style.fontSize = `${size}px`;
  return size;
}

function setLines(el: HTMLElement, text: string, wrapAt: number): HTMLElement[] {
  el.textContent = "";
  const out: HTMLElement[] = [];
  for (const line of wrapWords(text, wrapAt)) {
    const div = document.createElement("div");
    div.className = "ln";
    const span = document.createElement("span");
    span.textContent = line;
    div.appendChild(span);
    el.appendChild(div);
    out.push(div);
  }
  return out;
}

function styleFont(el: HTMLElement, f: TextElement["font"], defaults: { size: number; weight: number }) {
  el.style.fontSize = `${f?.size ?? defaults.size}px`;
  el.style.fontWeight = String(f?.weight ?? defaults.weight);
  el.style.color = color(f?.color, "fg");
  el.style.letterSpacing = `${f?.tracking ?? -0.01}em`;
  el.style.lineHeight = String(f?.lineHeight ?? 1.14);
}

/* ------------------------------------------------------------------ state */

interface Node {
  el: Element;
  root: HTMLElement;
  /** Visible window, in seconds. */
  at: number;
  until: number;
  inT: Required<Pick<Transition, "at" | "dur">> & Transition;
  outT: (Required<Pick<Transition, "at" | "dur">> & Transition) | null;
  /** Transform origin x, used so scale pivots on the element's own centre. */
  originX: number;
  /** Per-type scratch. */
  lines?: HTMLElement[];
  span?: HTMLElement;
  fill?: HTMLElement;
  cells?: HTMLElement[];
  rows?: HTMLElement[];
  rowBars?: HTMLElement[];
  rightPanel?: HTMLElement;
}

interface State {
  spec: FormatSpec;
  total: number;
  fps: number;
  duration: number;
  nodes: Node[];
}

let S: State | null = null;

/* ------------------------------------------------------------------- init */

function init(rawSpec: FormatSpec): void {
  const spec = rawSpec;
  const canvas = { ...DEFAULT_CANVAS, ...(spec.canvas ?? {}) };
  const safe = { ...DEFAULT_SAFE, ...(spec.safe ?? {}) };
  const theme = { ...DEFAULT_THEME, ...(spec.theme ?? {}) };
  const data = spec.data ?? {};

  const stage = $("stage");
  const root = document.documentElement;
  root.style.setProperty("--stage-w", `${canvas.w}px`);
  root.style.setProperty("--stage-h", `${canvas.h}px`);
  root.style.setProperty("--safe-top", `${safe.top}px`);
  root.style.setProperty("--safe-bottom", `${safe.bottom}px`);
  root.style.setProperty("--safe-side", `${safe.side}px`);
  root.style.setProperty("--bg", theme.bg);
  root.style.setProperty("--fg", theme.fg);
  root.style.setProperty("--muted", theme.muted);
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--accent2", theme.accent2);

  const glow = $("glow");
  if (theme.glow > 0) {
    glow.style.opacity = String(theme.glow);
    glow.style.top = `${theme.glowY - 700}px`;
  } else {
    glow.style.display = "none";
  }

  const safeX = safe.side;
  const safeW = canvas.w - safe.side * 2;

  const layer = $("scene");
  layer.textContent = "";

  const nodes: Node[] = [];
  const ordered = [...spec.scene].sort((a, b) => (a.z ?? 0) - (b.z ?? 0));

  for (const el of ordered) {
    const x = el.box.x ?? safeX;
    const w = el.box.w ?? safeW;
    const rootEl = document.createElement("div");
    rootEl.className = `el el-${el.type}`;
    rootEl.dataset.id = el.id;
    rootEl.style.left = `${x}px`;
    rootEl.style.width = `${w}px`;
    rootEl.style.textAlign = el.align ?? "center";
    rootEl.style.transformOrigin = `${w / 2}px 0px`;

    if (el.panel) {
      const padX = el.panel.padX ?? 32;
      const padY = el.panel.padY ?? 24;
      rootEl.style.left = `${x - padX}px`;
      rootEl.style.width = `${w + padX * 2}px`;
      rootEl.style.padding = `${padY}px ${padX}px`;
      rootEl.style.background = color(el.panel.fill, "rgba(255,255,255,0.05)");
      rootEl.style.borderRadius = `${el.panel.radius ?? 28}px`;
      if (el.panel.stroke) rootEl.style.border = `3px solid ${color(el.panel.stroke)}`;
      rootEl.style.transformOrigin = `${(w + padX * 2) / 2}px 0px`;
    }

    layer.appendChild(rootEl);

    /* Anything present at t=0 is painted fully on frame 0. A short-form clip
       that fades up from black spends its most valuable second showing nothing;
       elements that arrive later still get the default move-in. A format can
       override either way by giving an explicit `in`. */
    const opensCold = el.in === undefined && (el.at ?? 0) <= 0;

    const node: Node = {
      el,
      root: rootEl,
      at: el.at ?? 0,
      until: el.until ?? canvas.durationSec,
      inT: {
        at: el.in?.at ?? el.at ?? 0,
        dur: el.in?.dur ?? (opensCold ? 0 : DEFAULT_IN_DUR),
        move: el.in?.move ?? (opensCold ? [0, 0] : [0, 36]),
        scale: el.in?.scale,
        ease: el.in?.ease,
      },
      outT: null,
      originX: w / 2,
    };
    if (el.out) {
      node.outT = { at: el.out.at, dur: el.out.dur ?? DEFAULT_OUT_DUR, move: el.out.move, ease: el.out.ease };
    } else if (el.until !== undefined && el.until < canvas.durationSec) {
      node.outT = { at: el.until - DEFAULT_OUT_DUR, dur: DEFAULT_OUT_DUR };
    }

    build(node, { w, safeW, data, canvas });
    nodes.push(node);
  }

  S = {
    spec: { ...spec, canvas, safe, theme },
    total: Math.round(canvas.durationSec * canvas.fps),
    fps: canvas.fps,
    duration: canvas.durationSec,
    nodes,
  };

  stage.style.background = "var(--bg)";
  seek(0);
}

interface BuildCtx {
  w: number;
  safeW: number;
  data: Record<string, string | number>;
  canvas: { w: number; h: number; fps: number; durationSec: number };
}

function build(node: Node, ctx: BuildCtx): void {
  const { el, root } = node;
  const { w, data } = ctx;

  switch (el.type) {
    case "text": {
      const t = el as TextElement;
      const text = applyCase(interpolate(t.text, data), t.font?.case);
      styleFont(root, t.font, { size: 64, weight: 700 });
      node.lines = setLines(root, text, t.wrapAt ?? 5);
      if (t.font?.fit !== false) fitFont(root, t.font?.size ?? 64, w, t.font?.minSize ?? 20);
      break;
    }

    case "counter": {
      const c = el as CounterElement;
      styleFont(root, c.font, { size: 180, weight: 800 });
      root.classList.add("tnum");
      const span = document.createElement("span");
      span.className = "cnum";
      root.appendChild(span);
      node.span = span;
      /* Fit against the widest value the counter ever shows, so the digits
         never resize mid-flight. */
      const widest =
        counterText(c, Math.abs(c.to) >= Math.abs(c.from) ? c.to : c.from).replace(/\d/g, "0");
      span.textContent = widest;
      const base = c.font?.size ?? 180;
      root.style.fontSize = `${base}px`;
      const measured = span.offsetWidth || 1;
      if (c.font?.fit !== false && measured > w) {
        root.style.fontSize = `${Math.max(c.font?.minSize ?? 24, Math.floor((base * w) / measured))}px`;
      }
      break;
    }

    case "bar": {
      const b = el as BarElement;
      const h = b.height ?? 26;
      const radius = b.radius ?? h / 2;
      const track = document.createElement("div");
      track.className = "bar-track";
      track.style.height = `${h}px`;
      track.style.borderRadius = `${radius}px`;
      track.style.background = color(b.trackColor, "rgba(255,255,255,0.12)");
      const fill = document.createElement("div");
      fill.className = "bar-fill";
      fill.style.borderRadius = `${radius}px`;
      fill.style.background = color(b.fill, "accent");
      track.appendChild(fill);
      for (const frac of b.ticks ?? []) {
        const tick = document.createElement("div");
        tick.className = "bar-tick";
        tick.style.left = `${clamp01(frac) * 100}%`;
        track.appendChild(tick);
      }
      root.appendChild(track);
      node.fill = fill;
      break;
    }

    case "iconGrid": {
      const g = el as IconGridElement;
      const cols = g.columns ?? 10;
      const size = g.size ?? 60;
      const grid = document.createElement("div");
      grid.className = "icon-grid";
      grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      grid.style.gap = `${g.gap ?? 14}px`;
      const cells: HTMLElement[] = [];
      for (let i = 0; i < g.count; i++) {
        const cell = document.createElement("div");
        cell.className = "icon-cell";
        cell.style.width = `${size}px`;
        cell.style.height = `${size}px`;
        cell.style.color = color(g.color, "accent");
        cell.innerHTML = iconSvg(g.icon);
        grid.appendChild(cell);
        cells.push(cell);
      }
      root.appendChild(grid);
      node.cells = cells;
      break;
    }

    case "list": {
      const l = el as ListElement;
      const rowH = l.rowHeight ?? 108;
      const gap = l.gap ?? 16;
      const wrap = document.createElement("div");
      wrap.className = "list";
      wrap.style.gap = `${gap}px`;
      const rows: HTMLElement[] = [];
      const bars: HTMLElement[] = [];
      l.rows.forEach((r, i) => {
        const row = document.createElement("div");
        row.className = "list-row";
        row.style.height = `${rowH}px`;

        if (l.bars) {
          const bar = document.createElement("div");
          bar.className = "list-bar";
          bar.style.background = color(r.color, "accent");
          bar.style.width = `${clamp01(r.weight ?? 1) * 100}%`;
          row.appendChild(bar);
          bars.push(bar);
        }

        const inner = document.createElement("div");
        inner.className = "list-inner";
        if (l.rank) {
          const rank = document.createElement("div");
          rank.className = "list-rank";
          rank.textContent = String(i + 1);
          rank.style.color = color(r.color, "accent");
          inner.appendChild(rank);
        }
        const label = document.createElement("div");
        label.className = "list-label";
        label.textContent = applyCase(interpolate(r.label, data), l.font?.case);
        inner.appendChild(label);
        if (r.value !== undefined) {
          const value = document.createElement("div");
          value.className = "list-value";
          value.textContent = interpolate(r.value, data);
          value.style.color = color(r.color, "accent");
          inner.appendChild(value);
        }
        if (r.badge) {
          const badge = document.createElement("div");
          badge.className = "list-badge";
          badge.textContent = interpolate(r.badge, data);
          inner.appendChild(badge);
        }
        row.appendChild(inner);
        wrap.appendChild(row);
        rows.push(row);
      });
      root.appendChild(wrap);
      root.style.fontSize = `${l.font?.size ?? 46}px`;
      root.style.fontWeight = String(l.font?.weight ?? 700);
      root.style.color = color(l.font?.color, "fg");
      node.rows = rows;
      node.rowBars = bars;
      /* Shrink the whole list uniformly if any label overflows its column. */
      let over = 1;
      wrap.querySelectorAll<HTMLElement>(".list-label").forEach((lab) => {
        const avail = lab.parentElement!.getBoundingClientRect().width;
        const need = lab.scrollWidth;
        if (need > avail && avail > 0) over = Math.min(over, avail / need);
      });
      if (over < 1) root.style.fontSize = `${Math.floor((l.font?.size ?? 46) * over)}px`;
      break;
    }

    case "split": {
      const s = el as SplitElement;
      const gap = s.gap ?? 28;
      const wrap = document.createElement("div");
      wrap.className = "split";
      wrap.style.gap = `${gap}px`;
      const mk = (side: SplitElement["left"], cls: string): HTMLElement => {
        const p = document.createElement("div");
        p.className = `split-panel ${cls}`;
        if (s.height) p.style.height = `${s.height}px`;
        p.style.borderColor = color(side.color, "accent");
        const title = document.createElement("div");
        title.className = "split-title";
        title.textContent = applyCase(interpolate(side.title, data), s.font?.case);
        title.style.color = color(side.color, "accent");
        p.appendChild(title);
        if (side.value !== undefined) {
          const v = document.createElement("div");
          v.className = "split-value";
          v.textContent = interpolate(side.value, data);
          p.appendChild(v);
        }
        if (side.body) {
          const b = document.createElement("div");
          b.className = "split-body";
          b.textContent = interpolate(side.body, data);
          p.appendChild(b);
        }
        return p;
      };
      const left = mk(s.left, "split-left");
      const right = mk(s.right, "split-right");
      wrap.appendChild(left);
      if (s.divider) {
        const d = document.createElement("div");
        d.className = "split-divider";
        d.textContent = s.divider;
        wrap.appendChild(d);
      }
      wrap.appendChild(right);
      root.appendChild(wrap);
      root.style.fontSize = `${s.font?.size ?? 40}px`;
      node.rightPanel = right;
      break;
    }

    case "card": {
      const c = el as CardElement;
      root.style.height = `${c.h}px`;
      root.style.background = color(c.fill, "rgba(255,255,255,0.05)");
      root.style.borderRadius = `${c.radius ?? 32}px`;
      if (c.stroke) root.style.border = `3px solid ${color(c.stroke)}`;
      break;
    }

    case "image": {
      const im = el as ImageElement;
      const img = document.createElement("img");
      img.src = im.src;
      img.style.width = "100%";
      if (im.h) img.style.height = `${im.h}px`;
      img.style.objectFit = im.fit ?? "cover";
      img.style.borderRadius = `${im.radius ?? 24}px`;
      img.style.display = "block";
      root.appendChild(img);
      break;
    }
  }
}

/* ---------------------------------------------------------------- counter */

function counterText(c: CounterElement, value: number): string {
  if (c.clock) return `${c.prefix ?? ""}${formatClock(value)}${c.suffix ?? ""}`;
  const n = formatNumber(value, { decimals: c.decimals, group: c.group, pad: c.pad });
  return `${c.prefix ?? ""}${n}${c.suffix ?? ""}`;
}

/* ------------------------------------------------------------------- seek */

function seek(frame: number): void {
  if (!S) throw new Error("composition: init(spec) must run before seek()");
  const last = S.total - 1;
  const f = Math.max(0, Math.min(last, Math.round(frame)));
  /* The final frame lands exactly on durationSec so end-state values match the
     promise the copy makes. */
  const t = f === last ? S.duration : f / S.fps;

  for (const node of S.nodes) paint(node, t);
}

function paint(node: Node, t: number): void {
  const { el, root } = node;

  /* --- visibility & transitions --- */
  const pIn = easeFn(node.inT.ease, (t - node.inT.at) / Math.max(node.inT.dur, 1e-6));
  const pOut = node.outT
    ? 1 - easeFn(node.outT.ease, (t - node.outT.at) / Math.max(node.outT.dur, 1e-6))
    : 1;
  let opacity = Math.min(pIn, pOut);

  let dx = (node.inT.move?.[0] ?? 0) * (1 - pIn);
  let dy = (node.inT.move?.[1] ?? 0) * (1 - pIn);
  if (node.outT?.move) {
    dx += node.outT.move[0] * (1 - pOut);
    dy += node.outT.move[1] * (1 - pOut);
  }
  let scale = node.inT.scale !== undefined ? lerp(node.inT.scale, 1, pIn) : 1;
  let rotate = 0;
  let reveal = 1;
  let clip = 0;

  /* --- keyframe tracks override / add on top --- */
  for (const track of el.tracks ?? []) {
    const v = sampleTrack(track, t);
    switch (track.prop) {
      case "x":
        dx += v;
        break;
      case "y":
        dy += v;
        break;
      case "scale":
        scale *= v;
        break;
      case "opacity":
        opacity *= v;
        break;
      case "rotate":
        rotate += v;
        break;
      case "reveal":
        reveal = clamp01(v);
        break;
      case "clip":
        clip = clamp01(v);
        break;
    }
  }

  const y = el.box.y + dy;
  root.style.transform =
    `translate(${dx.toFixed(2)}px, ${y.toFixed(2)}px)` +
    ` scale(${scale.toFixed(4)})` +
    (rotate ? ` rotate(${rotate.toFixed(3)}deg)` : "");
  root.style.opacity = clamp01(opacity).toFixed(4);
  root.style.clipPath =
    reveal >= 1 && clip <= 0
      ? "none"
      : `inset(0 ${((1 - reveal) * 100).toFixed(3)}% 0 ${(clip * 100).toFixed(3)}%)`;

  /* --- per-type content ---
     Every branch writes unconditionally, even when the element is invisible.
     Skipping the write would leave the DOM holding a previous frame's state,
     which would make the output a function of seek history rather than of t. */
  switch (el.type) {
    case "text": {
      const tx = el as TextElement;
      const stagger = tx.stagger ?? 0;
      if (node.lines) {
        for (let i = 0; i < node.lines.length; i++) {
          const p = stagger > 0 ? easeFn("smooth", (t - node.at - i * stagger) / 0.28) : 1;
          node.lines[i].style.opacity = clamp01(p).toFixed(4);
          node.lines[i].style.transform = `translateY(${(18 * (1 - p)).toFixed(2)}px)`;
        }
      }
      break;
    }

    case "counter": {
      const c = el as CounterElement;
      const s0 = c.startSec ?? node.at;
      const s1 = c.endSec ?? node.until;
      const u = s1 <= s0 ? 1 : clamp01((t - s0) / (s1 - s0));
      const value = lerp(c.from, c.to, easeFn(c.ease ?? "linear", u));
      node.span!.textContent = counterText(c, value);
      break;
    }

    case "bar": {
      const b = el as BarElement;
      const s0 = b.startSec ?? node.at;
      const s1 = b.endSec ?? node.until;
      const u = s1 <= s0 ? 1 : clamp01((t - s0) / (s1 - s0));
      const v = lerp(b.from ?? 0, b.to ?? 1, easeFn(b.ease ?? "linear", u));
      node.fill!.style.width = `${(clamp01(v) * 100).toFixed(3)}%`;
      break;
    }

    case "iconGrid": {
      const g = el as IconGridElement;
      const every = g.everySec && g.everySec > 0 ? g.everySec : 0;
      const lit = every === 0 ? g.count : Math.max(0, Math.floor((t - node.at) / every));
      const dim = color(g.dimColor, "rgba(255,255,255,0.10)");
      const on = color(g.color, "accent");
      for (let i = 0; i < node.cells!.length; i++) {
        node.cells![i].style.color = i < lit ? on : dim;
      }
      break;
    }

    case "list": {
      const l = el as ListElement;
      const stagger = l.stagger ?? 0.5;
      const n = node.rows!.length;
      for (let i = 0; i < n; i++) {
        const order = l.reverse ? n - 1 - i : i;
        const p = clamp01(easeFn("smooth", (t - node.at - order * stagger) / 0.36));
        const row = node.rows![i];
        row.style.opacity = p.toFixed(4);
        row.style.transform = `translateX(${((l.reverse ? -1 : 1) * 44 * (1 - p)).toFixed(2)}px)`;
        const hot =
          l.highlight === i && l.highlightAt !== undefined && t >= l.highlightAt ? "1" : "0";
        row.dataset.hot = hot;
      }
      if (l.bars) {
        for (let i = 0; i < node.rowBars!.length; i++) {
          const order = l.reverse ? n - 1 - i : i;
          const p = clamp01(easeFn("out", (t - node.at - order * stagger) / 0.55));
          const target = clamp01(l.rows[i].weight ?? 1);
          node.rowBars![i].style.width = `${(target * p * 100).toFixed(3)}%`;
        }
      }
      break;
    }

    case "split": {
      const s = el as SplitElement;
      const delay = s.rightDelay ?? 0;
      if (node.rightPanel) {
        const p = clamp01(easeFn("smooth", (t - node.at - delay) / 0.4));
        node.rightPanel.style.opacity = p.toFixed(4);
        node.rightPanel.style.transform = `translateY(${(28 * (1 - p)).toFixed(2)}px)`;
      }
      break;
    }

    case "card":
    case "image":
      break;
  }
}

/* -------------------------------------------------------------- exposure */

declare global {
  interface Window {
    init: (spec: FormatSpec) => void;
    seek: (frame: number) => void;
    compReady: boolean;
    kwInkBoxes?: () => unknown;
  }
}

window.init = init;
window.seek = seek;
window.compReady = true;

/* ------------------------------------------------------ preview bootstrap */
/* Only runs when opened through `kw preview`. The renderer never takes this
   path, so no timer ever touches a rendered frame. */
if (typeof location !== "undefined" && location.search.includes("preview=1")) {
  void (async () => {
    await document.fonts.ready;
    const spec: FormatSpec = await (await fetch("format.json")).json();
    document.body.classList.add("preview");
    init(spec);

    const total = Math.round(spec.canvas.durationSec * spec.canvas.fps);
    const range = $("previewRange") as HTMLInputElement;
    const label = $("previewLabel");
    const play = $("previewPlay") as HTMLButtonElement;
    range.max = String(total - 1);

    const show = (fr: number) => {
      seek(fr);
      label.textContent = `${fr} / ${total - 1} · ${(fr / spec.canvas.fps).toFixed(2)} s`;
    };
    range.addEventListener("input", () => show(Number(range.value)));

    let timer: number | null = null;
    play.addEventListener("click", () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
        play.textContent = "Play";
        return;
      }
      play.textContent = "Pause";
      timer = window.setInterval(() => {
        const next = (Number(range.value) + 1) % total;
        range.value = String(next);
        show(next);
      }, 1000 / spec.canvas.fps);
    });

    show(0);
  })();
}

export {};
