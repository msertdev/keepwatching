/**
 * Gallery layout test.
 *
 * The videos had two guards and the page had none, so a filter chip could slide
 * under the sort controls and hide a whole format family — including the one
 * sourced card — without anything going red. A rendered frame is checked by
 * pixels; a web page has to be checked by opening it.
 *
 * For each viewport width this asserts, for every control and every card row:
 *   - it has a non-zero box
 *   - it sits inside the viewport horizontally
 *   - a click at its centre would actually reach it (elementFromPoint), so an
 *     element covered by a sticky bar or a neighbour fails even though it is
 *     technically "visible"
 * and that the page never grows a horizontal scrollbar.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";

import { SITE_DIR } from "./paths.js";

/** Phone, tablet, desktop. The three places a reader actually opens this. */
export const WIDTHS = [390, 768, 1440];

/** What must be reachable. Each entry is checked at every width. */
const TARGETS: Array<{ selector: string; label: string; requireAll: boolean }> = [
  { selector: ".chip", label: "filter chip", requireAll: true },
  { selector: "#sort", label: "sort dropdown", requireAll: true },
  { selector: "#motion", label: "previews toggle", requireAll: true },
  { selector: ".card .name", label: "card title", requireAll: true },
  { selector: ".card .nbadge", label: "sample-size badge", requireAll: true },
  { selector: ".card .notmeasured, .card .metrics", label: "card metrics row", requireAll: true },
  { selector: ".card .axis-strip", label: "content-axis strip", requireAll: true },
  { selector: ".board .stats dd", label: "hero stat", requireAll: true },
];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

function serve(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      if (p === "/") p = "/index.html";
      const file = path.join(SITE_DIR, p);
      if (!file.startsWith(SITE_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://localhost:${port}`, close: () => server.close() });
    });
  });
}

export interface LayoutProblem {
  width: number;
  label: string;
  detail: string;
}

export interface LayoutResult {
  width: number;
  checked: number;
  problems: LayoutProblem[];
}

export async function checkLayout(): Promise<LayoutResult[]> {
  if (!fs.existsSync(path.join(SITE_DIR, "gallery.json"))) {
    throw new Error("site/gallery.json is missing — run `npx kw gallery --no-serve` first");
  }

  const { url, close } = await serve();
  const browser = await chromium.launch();
  const results: LayoutResult[] = [];

  try {
    for (const width of WIDTHS) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(url, { waitUntil: "networkidle" });

      /* Smooth scrolling would make scrollIntoView asynchronous and the
         measurements race it. Autoplay is irrelevant to layout and only adds
         noise. */
      await page.addStyleTag({
        content: "html{scroll-behavior:auto !important}*{transition:none !important}",
      });
      await page.waitForSelector(".card", { timeout: 10_000 });
      await page.waitForTimeout(250);

      const problems = await page.evaluate((targets) => {
        const found: Array<{ label: string; detail: string }> = [];
        const vw = window.innerWidth;
        let checked = 0;

        /* A horizontal scrollbar means something is wider than the page. */
        const scrollW = document.documentElement.scrollWidth;
        if (scrollW > vw + 1) {
          found.push({
            label: "page",
            detail: `horizontal scrollbar: content is ${scrollW}px wide in a ${vw}px viewport`,
          });
        }

        /* Nothing may be parked outside a horizontally-scrolling strip. A
           reader does not know to swipe a filter bar sideways, and a chip that
           only exists after a sideways swipe is a chip they will never press.
           Written inline rather than as a named helper: tsx compiles this file
           with keepNames, whose __name shim does not exist inside the page. */
        const seenContainers: HTMLElement[] = [];

        for (const t of targets) {
          const nodes = Array.from(document.querySelectorAll<HTMLElement>(t.selector));
          if (t.requireAll && nodes.length === 0) {
            found.push({ label: t.label, detail: `no element matches "${t.selector}"` });
            continue;
          }

          for (const node of nodes) {
            checked++;
            const name = (node.textContent ?? "").trim().slice(0, 28) || t.selector;

            let anc: HTMLElement | null = node.parentElement;
            while (anc && anc !== document.body) {
              if (seenContainers.indexOf(anc) === -1) {
                const style = getComputedStyle(anc);
                if (
                  /auto|scroll/.test(style.overflowX) &&
                  anc.scrollWidth > anc.clientWidth + 1
                ) {
                  seenContainers.push(anc);
                  found.push({
                    label: t.label,
                    detail:
                      `container .${String(anc.className).split(" ")[0]} hides content behind a ` +
                      `horizontal scroll (${anc.scrollWidth}px of content in ` +
                      `${anc.clientWidth}px) — let it wrap instead`,
                  });
                }
              }
              anc = anc.parentElement;
            }

            /* Scroll the WINDOW only. `scrollIntoView` would also scroll any
               horizontally-scrollable ancestor, which is precisely the thing
               that hides a chip: it would slide the strip sideways and then
               report the chip as reachable, when a reader looking at the page
               cannot see it. */
            const abs = node.getBoundingClientRect().top + window.scrollY;
            window.scrollTo(0, Math.max(0, abs - window.innerHeight / 2));
            const r = node.getBoundingClientRect();

            if (r.width < 1 || r.height < 1) {
              found.push({ label: t.label, detail: `"${name}" has a zero-sized box` });
              continue;
            }
            if (r.left < -1 || r.right > vw + 1) {
              found.push({
                label: t.label,
                detail:
                  `"${name}" sits outside the viewport horizontally ` +
                  `(${Math.round(r.left)}..${Math.round(r.right)} in ${vw}px)`,
              });
              continue;
            }

            /* Would a click land on it? An element under a sticky bar or a
               neighbour is visible to the eye and unreachable to the pointer. */
            const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2));
            const cy = Math.min(window.innerHeight - 1, Math.max(0, r.top + r.height / 2));
            const hit = document.elementFromPoint(cx, cy);
            /* Deliberately NOT accepting an ancestor as a hit. A parent that
               paints over its own child — an ::after overlay, a positioned
               sibling wrapper — swallows the click, and elementFromPoint reports
               the parent because pseudo-elements are not hit-test targets.
               Treating that as reachable is how a covered chip passes. */
            const reachable = hit === node || node.contains(hit);
            if (!reachable) {
              const blocker = hit
                ? `${hit.tagName.toLowerCase()}.${String(hit.className).split(" ")[0]}`
                : "nothing";
              found.push({
                label: t.label,
                detail: `"${name}" is covered by ${blocker} — a click would not reach it`,
              });
            }
          }
        }
        return { found, checked };
      }, TARGETS);

      results.push({
        width,
        checked: problems.checked,
        problems: problems.found.map((p) => ({ width, ...p })),
      });
      await page.close();
    }
  } finally {
    await browser.close();
    close();
  }

  return results;
}

export function reportLayout(results: LayoutResult[]): boolean {
  console.log(`\n▸ layout`);
  console.log(`  gallery opened at ${results.map((r) => `${r.width}px`).join(", ")}\n`);

  let bad = 0;
  for (const r of results) {
    const ok = r.problems.length === 0;
    console.log(
      `  ${ok ? "\x1b[32mok  \x1b[0m" : "\x1b[31mFAIL\x1b[0m"} ${String(r.width).padStart(4)}px  ` +
        `${r.checked} elements checked` +
        (ok ? "" : `, ${r.problems.length} unreachable`)
    );
    for (const p of r.problems) {
      console.log(`         \x1b[31m·\x1b[0m ${p.label}: ${p.detail}`);
      bad++;
    }
  }

  console.log(
    bad
      ? `\n  \x1b[31m${bad} layout problem(s).\x1b[0m An element a reader cannot click is an ` +
          `element that is not there.\n`
      : `\n  every control and card row is visible and clickable at all widths\n`
  );
  return bad === 0;
}
