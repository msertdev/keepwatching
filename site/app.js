/* keepwatching gallery.
   Renders gallery.json. No framework, no build step — the page is part of the
   repo, and a static page anyone can read is easier to trust than a bundle.

   The one structural rule this file enforces: a format number and a content-axis
   number are never placed in the same row, the same total, or the same colour.
   They come from different branches of gallery.json and are rendered by
   different functions, so there is no code path that can average them. */

const $ = (sel, root = document) => root.querySelector(sel);
const grid = $("#grid");
const state = { cards: [], axisNames: {}, family: "all", sort: "retention", motion: true };

const pct = (v) => (v === null || v === undefined ? null : `${(v * 100).toFixed(0)}%`);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/* Autoplaying twenty-four videos on a phone is rude. Only what is on screen plays. */
const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const v = e.target.querySelector("video");
      if (!v) continue;
      if (e.isIntersecting && state.motion) v.play().catch(() => {});
      else v.pause();
    }
  },
  { rootMargin: "120px 0px", threshold: 0.2 }
);

function sparkline(retention, durationSec) {
  if (!retention || retention.length < 2) return "";
  const w = 240;
  const h = 44;
  const maxT = retention[retention.length - 1].t || durationSec || 1;
  const pts = retention.map((p) => {
    const x = (p.t / maxT) * w;
    const y = h - 4 - Math.max(0, Math.min(1, p.p)) * (h - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return `
    <svg class="curve" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
         aria-label="Format retention curve over ${maxT.toFixed(0)} seconds">
      <polyline points="0,${h} ${pts.join(" ")} ${w},${h}" fill="rgba(34,197,94,0.12)" stroke="none" />
      <polyline points="${pts.join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2"
                stroke-linejoin="round" stroke-linecap="round" />
    </svg>`;
}

function metric(key, value) {
  const shown = value ?? "—";
  return `<div><div class="k">${key}</div><div class="v${value ? "" : " none"}">${shown}</div></div>`;
}

/**
 * The format board's metrics. Green. Orders the gallery.
 *
 * With no measurement there is nothing to put in three boxes, and three empty
 * boxes on twenty-four cards is ninety-six dashes — a page that looks broken
 * rather than honest. One line says the same thing and reads as a statement.
 * The boxes come back the moment there is something to put in them.
 */
function formatMetrics(f) {
  const measured = f.status === "measured" && f.n > 0;
  if (!measured) {
    return `<div class="notmeasured"><span>Not measured yet</span><span class="nz">n = ${f.n}</span></div>`;
  }
  const delta =
    f.vsBaselinePct === null || f.vsBaselinePct === undefined
      ? null
      : `${f.vsBaselinePct > 0 ? "+" : ""}${f.vsBaselinePct.toFixed(1)}pp`;
  return `<div class="metrics">
      ${metric("viewed", pct(f.avgViewedPct))}
      ${metric("hook 3s", pct(f.hook3s))}
      ${metric("vs base", delta)}
    </div>`;
}

/** The content-axis board's strip. Violet. Never sorted on, never totalled with the above. */
function axisStrip(ca, axisNames) {
  const measured = ca.status === "measured" && ca.n > 0;
  if (!measured) {
    /* Same reasoning as formatMetrics: a sentence, not another dash. */
    return `<div class="axis-strip none"><span>No content axis attributed</span>` +
      `<span class="nz">n = ${ca.n}</span></div>`;
  }
  const rows = ca.axes
    .map(
      (a) =>
        `<div class="r"><span>${esc(axisNames[a.axis] ?? a.axis)} <span class="an">n=${a.n}</span></span>` +
        `<span>${pct(a.avgViewedPct) ?? "—"}</span></div>`
    )
    .join("");
  return `<div class="axis-strip">
      <div class="head"><span>content axis</span><span class="n">n = ${ca.n}</span></div>
      ${rows}
    </div>`;
}

function cardHtml(c, rank, axisNames) {
  const f = c.format;
  const measured = f.status === "measured" && f.n > 0;
  const media = c.media || {};
  const poster = media.poster ? ` poster="${media.poster}"` : "";

  const preview =
    media.webm || media.mp4
      ? `<video muted loop playsinline preload="none"${poster} aria-label="${esc(c.name)} preview">
         ${media.webm ? `<source src="${media.webm}" type="video/webm">` : ""}
         ${media.mp4 ? `<source src="${media.mp4}" type="video/mp4">` : ""}
       </video>`
      : media.poster
        ? `<img src="${media.poster}" alt="${esc(c.name)} preview" loading="lazy">`
        : `<div class="frame-empty"></div>`;

  const sourced = c.sampleContent === "sourced";
  /* The non-sourced cards no longer carry filler: their copy is about the format
     or the viewer, which is why it needs no citation. Saying "placeholder" here
     would describe the schema field rather than what is on screen. */
  const prov = sourced
    ? `<p class="prov sourced"><b>Sourced example.</b> ${c.sources
        .map((s) => `<a href="${esc(s.url)}" rel="noopener">${esc(s.title)}</a>`)
        .join("; ")}</p>`
    : `<p class="prov selfref"><b>Self-referential example.</b> The copy describes the format itself, so it asserts no fact to source.</p>`;

  return `
  <article class="card${measured && rank === 0 ? " top" : ""}" data-family="${esc(c.family)}">
    <div class="frame">
      ${preview}
      ${measured ? `<span class="rank">#${rank + 1}</span>` : ""}
      <span class="nbadge ${measured ? "measured" : "untested"}">n = ${f.n}</span>
      <span class="dur">${c.durationSec}s</span>
    </div>
    <div class="body">
      <div>
        <div class="family">${esc(c.family)}</div>
        <h3 class="name">${esc(c.name)}</h3>
      </div>
      ${formatMetrics(f)}
      ${sparkline(f.retention, c.durationSec)}
      ${axisStrip(c.contentAxis, axisNames)}
      <p class="hyp"><b>Hypothesis.</b> ${esc(c.hypothesis)}</p>
      ${prov}
      <details>
        <summary>Details</summary>
        <div class="detail">
          <span><b>Use when.</b> ${esc(c.useWhen)}</span>
          ${c.avoidWhen ? `<span><b>Avoid when.</b> ${esc(c.avoidWhen)}</span>` : ""}
          ${f.notes ? `<span><b>Notes.</b> ${esc(f.notes)}</span>` : ""}
          <span><b>Format status.</b> ${
            measured
              ? `measured across ${f.n} published video${f.n === 1 ? "" : "s"}${
                  f.platforms.length ? ` on ${f.platforms.join(", ")}` : ""
                }${f.updated ? `, updated ${f.updated}` : ""}`
              : "untested — no published videos have been attributed to it yet"
          }</span>
          <span><b>Content-axis status.</b> ${
            c.contentAxis.n > 0
              ? `${c.contentAxis.n} sample${c.contentAxis.n === 1 ? "" : "s"} across ` +
                `${c.contentAxis.axes.length} axis/axes. Measured separately from the format ` +
                `numbers above and never averaged into them.`
              : "untested — no published video carrying this format has been labelled with an axis."
          }</span>
          ${
            sourced
              ? c.sources
                  .map((s) => `<span><b>Source.</b> ${esc(s.claim)} — <a href="${esc(s.url)}" rel="noopener">${esc(s.title)}</a></span>`)
                  .join("")
              : ""
          }
          <span class="vid">${esc(c.variantId)}</span>
        </div>
      </details>
    </div>
  </article>`;
}

function render() {
  const axisNames = state.axisNames;
  const list = state.cards
    .filter((c) => state.family === "all" || c.family === state.family)
    .sort((a, b) => {
      const am = a.format.status === "measured" && a.format.n > 0;
      const bm = b.format.status === "measured" && b.format.n > 0;
      if (state.sort === "name") return a.name.localeCompare(b.name);
      if (state.sort === "samples") return b.format.n - a.format.n || a.name.localeCompare(b.name);
      /* Measured formats always outrank untested ones — an unknown is not a zero.
         Note this only ever reads `.format`; the axis block is not sortable. */
      if (am !== bm) return am ? -1 : 1;
      const key = state.sort === "hook" ? "hook3s" : "avgViewedPct";
      return (b.format[key] ?? -1) - (a.format[key] ?? -1) || a.name.localeCompare(b.name);
    });

  let measuredRank = 0;
  grid.innerHTML = list
    .map((c) => {
      const isMeasured = c.format.status === "measured" && c.format.n > 0;
      return cardHtml(c, isMeasured ? measuredRank++ : -1, axisNames);
    })
    .join("");

  $("#empty").hidden = list.length > 0;
  grid.querySelectorAll(".card").forEach((el) => observer.observe(el));
}

function buildFilters(cards) {
  const families = ["all", ...[...new Set(cards.map((c) => c.family))].sort()];
  $("#families").innerHTML = families
    .map(
      (f) =>
        `<button class="chip" type="button" data-family="${esc(f)}" aria-pressed="${
          f === "all"
        }">${f === "all" ? `all (${cards.length})` : esc(f)}</button>`
    )
    .join("");
  $("#families").addEventListener("click", (e) => {
    const btn = e.target.closest(".chip");
    if (!btn) return;
    state.family = btn.dataset.family;
    $("#families")
      .querySelectorAll(".chip")
      .forEach((c) => c.setAttribute("aria-pressed", String(c === btn)));
    render();
  });
}

const NOT_IN_LIBRARY = "not-in-library";

function renderAxisBoard(ca) {
  const el = $("#axisRows");
  if (!ca.rows.length) {
    el.className = "axis-empty";
    el.textContent =
      `${ca.declared.length} axes are declared in data/content-axes.yml and none is measured yet. ` +
      `Add a content_axis column to measure/mapping.csv to start one.`;
    return;
  }
  el.className = "axis-rows";

  /* "Carried by" is the honesty column. An axis carried by one entry is that
     entry's videos under a second label, and `not-in-library` marks samples from
     a format that is not in this repo — visible, never folded into the format
     board. */
  el.innerHTML =
    ca.rows
      .map((r) => {
        const carried = (r.formats || [])
          .map((f) =>
            f === NOT_IN_LIBRARY
              ? `<span class="outside">${esc(f)}</span>`
              : `<span>${esc(f)}</span>`
          )
          .join(", ");
        const lone = (r.formats || []).length === 1;
        return (
          `<div class="axis-row">` +
          `<span>${esc(r.name)} <span class="an">n=${r.n}</span>` +
          `<span class="carried">carried by ${carried || "—"}` +
          `${lone ? ' <span class="warn-lone">· not isolated</span>' : ""}</span></span>` +
          `<span class="av">${pct(r.avgViewedPct) ?? "—"}</span></div>`
        );
      })
      .join("") +
    (ca.rows.some((r) => (r.formats || []).includes(NOT_IN_LIBRARY))
      ? `<p class="axis-note"><span class="outside">${NOT_IN_LIBRARY}</span> means those samples ` +
        `came from a format that is not part of this library. They count toward the axis ` +
        `numbers above and appear nowhere on the format board.</p>`
      : "");
}

/**
 * Load order: the generated gallery.js if it is present (works everywhere,
 * including file://), otherwise fetch gallery.json. `fetch` cannot read the
 * file: scheme, so a page opened by double-clicking would otherwise show
 * nothing — and blaming a missing file for that was itself a misdiagnosis.
 */
function loadGallery() {
  if (window.__GALLERY__) return Promise.resolve(window.__GALLERY__);
  return fetch("gallery.json").then((r) => {
    if (!r.ok) throw new Error(`gallery.json responded ${r.status}`);
    return r.json();
  });
}

function showLoadFailure(err) {
  const offline = location.protocol === "file:";
  grid.innerHTML =
    `<div class="empty">` +
    `<p><b>The gallery data did not load.</b></p>` +
    (offline
      ? `<p>This page was opened straight from disk, and the browser blocks reading ` +
        `<code>gallery.json</code> over <code>file://</code>. The build also writes ` +
        `<code>gallery.js</code>, which does work offline — if it is missing, the ` +
        `gallery has not been built yet.</p>`
      : `<p><code>${esc(err && err.message)}</code></p>`) +
    `<p>Build it and serve it with one command, from the repo root:</p>` +
    `<p><code class="cmd">npx kw gallery</code></p>` +
    `</div>`;
}

loadGallery()
  .then((g) => {
    state.cards = g.cards;
    state.axisNames = Object.fromEntries(g.contentAxes.declared.map((a) => [a.id, a.name]));

    /* Zero is a number and reads as one. A dash here would look like missing
       data on a page whose entire argument is that the numbers are shown. */
    const stats = {
      formats: g.totals.formats ?? 0,
      measured: g.totals.measured ?? 0,
      untested: g.totals.untested ?? 0,
      samples: g.totals.samples ?? 0,
      axesDeclared: g.contentAxes.declared.length,
      axesMeasured: g.contentAxes.measured ?? 0,
      axesSamples: g.contentAxes.samples ?? 0,
    };
    for (const [key, value] of Object.entries(stats)) {
      const el = document.querySelector(`[data-stat="${key}"]`);
      if (el) el.textContent = String(value);
    }

    renderAxisBoard(g.contentAxes);
    $("#built").textContent = `Gallery built ${new Date(g.generatedAt)
      .toISOString()
      .slice(0, 10)} from ${g.totals.formats} format specs.`;
    buildFilters(g.cards);
    render();
  })
  .catch(showLoadFailure);

$("#sort").addEventListener("change", (e) => {
  state.sort = e.target.value;
  render();
});

const motionBtn = $("#motion");
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) state.motion = false;
motionBtn.setAttribute("aria-pressed", String(state.motion));
motionBtn.textContent = `Previews: ${state.motion ? "on" : "off"}`;
motionBtn.addEventListener("click", () => {
  state.motion = !state.motion;
  motionBtn.setAttribute("aria-pressed", String(state.motion));
  motionBtn.textContent = `Previews: ${state.motion ? "on" : "off"}`;
  grid.querySelectorAll("video").forEach((v) => (state.motion ? v.play().catch(() => {}) : v.pause()));
});
