/* keepwatching gallery.
   Renders gallery.json. No framework, no build step — the page is part of the
   repo, and a static page that anyone can read is easier to trust than a bundle. */

const $ = (sel, root = document) => root.querySelector(sel);
const grid = $("#grid");
const state = { cards: [], family: "all", sort: "retention", motion: true };

const pct = (v) => (v === null || v === undefined ? null : `${(v * 100).toFixed(0)}%`);

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
         aria-label="Retention curve over ${maxT.toFixed(0)} seconds">
      <polyline points="${pts.join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2"
                stroke-linejoin="round" stroke-linecap="round" />
      <polyline points="0,${h} ${pts.join(" ")} ${w},${h}" fill="rgba(34,197,94,0.12)" stroke="none" />
    </svg>`;
}

function metric(key, value) {
  const shown = value ?? "—";
  return `<div><div class="k">${key}</div><div class="v${value ? "" : " none"}">${shown}</div></div>`;
}

function cardHtml(c, rank) {
  const measured = c.status === "measured" && c.n > 0;
  const media = c.media || {};
  const poster = media.poster ? ` poster="${media.poster}"` : "";

  const preview = media.webm || media.mp4
    ? `<video muted loop playsinline preload="none"${poster} aria-label="${c.name} preview">
         ${media.webm ? `<source src="${media.webm}" type="video/webm">` : ""}
         ${media.mp4 ? `<source src="${media.mp4}" type="video/mp4">` : ""}
       </video>`
    : media.poster
      ? `<img src="${media.poster}" alt="${c.name} preview" loading="lazy">`
      : `<div class="frame-empty"></div>`;

  const delta =
    c.vsBaselinePct === null || c.vsBaselinePct === undefined
      ? null
      : `${c.vsBaselinePct > 0 ? "+" : ""}${c.vsBaselinePct.toFixed(1)}pp`;

  return `
  <article class="card${measured && rank === 0 ? " top" : ""}" data-family="${c.family}">
    <div class="frame">
      ${preview}
      ${measured ? `<span class="rank">#${rank + 1}</span>` : ""}
      <span class="nbadge ${measured ? "measured" : "untested"}">n = ${c.n}</span>
      <span class="dur">${c.durationSec}s</span>
    </div>
    <div class="body">
      <div>
        <div class="family">${c.family}</div>
        <h2 class="name">${c.name}</h2>
      </div>
      <div class="metrics">
        ${metric("viewed", pct(c.avgViewedPct))}
        ${metric("hook 3s", pct(c.hook3s))}
        ${metric("vs base", delta)}
      </div>
      ${sparkline(c.retention, c.durationSec)}
      <p class="hyp"><b>Hypothesis.</b> ${c.hypothesis}</p>
      <details>
        <summary>Details</summary>
        <div class="detail">
          <span><b>Use when.</b> ${c.useWhen}</span>
          ${c.avoidWhen ? `<span><b>Avoid when.</b> ${c.avoidWhen}</span>` : ""}
          ${c.notes ? `<span><b>Notes.</b> ${c.notes}</span>` : ""}
          <span><b>Status.</b> ${
            measured
              ? `measured across ${c.n} published video${c.n === 1 ? "" : "s"}${
                  c.platforms.length ? ` on ${c.platforms.join(", ")}` : ""
                }${c.updated ? `, updated ${c.updated}` : ""}`
              : "untested — no published videos have been attributed to it yet"
          }</span>
          <span class="vid">${c.variantId}</span>
        </div>
      </details>
    </div>
  </article>`;
}

function render() {
  const list = state.cards
    .filter((c) => state.family === "all" || c.family === state.family)
    .sort((a, b) => {
      const am = a.status === "measured" && a.n > 0;
      const bm = b.status === "measured" && b.n > 0;
      if (state.sort === "name") return a.name.localeCompare(b.name);
      if (state.sort === "samples") return b.n - a.n || a.name.localeCompare(b.name);
      /* Measured formats always outrank untested ones — an unknown is not a zero. */
      if (am !== bm) return am ? -1 : 1;
      const key = state.sort === "hook" ? "hook3s" : "avgViewedPct";
      return (b[key] ?? -1) - (a[key] ?? -1) || a.name.localeCompare(b.name);
    });

  let measuredRank = 0;
  grid.innerHTML = list
    .map((c) => {
      const isMeasured = c.status === "measured" && c.n > 0;
      return cardHtml(c, isMeasured ? measuredRank++ : -1);
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
        `<button class="chip" type="button" data-family="${f}" aria-pressed="${
          f === "all"
        }">${f === "all" ? `all (${cards.length})` : f}</button>`
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

fetch("gallery.json")
  .then((r) => r.json())
  .then((g) => {
    state.cards = g.cards;
    for (const [key, value] of Object.entries(g.totals)) {
      const el = document.querySelector(`[data-stat="${key}"]`);
      if (el) el.textContent = String(value);
    }
    $("#built").textContent = `Gallery built ${new Date(g.generatedAt)
      .toISOString()
      .slice(0, 10)} from ${g.totals.formats} format specs.`;
    buildFilters(g.cards);
    render();
  })
  .catch(() => {
    grid.innerHTML =
      `<p class="empty">gallery.json is missing. Run <code>npm run site</code> to build it.</p>`;
  });

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
