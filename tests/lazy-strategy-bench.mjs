/**
 * Lazy-load termination: DOM heuristic vs Jev semantic decision.
 *
 * Both strategies share the SAME scroll action, SAME round cap and SAME post-action wait.
 * The only difference is how they decide "is there more content?".
 *
 * The DOM strategy is deliberately given its BEST reasonable form (not a strawman): it
 * watches body scrollHeight, the largest inner scrollable container, and total text length,
 * and only stops once none of them has changed for N consecutive rounds. It never clicks,
 * which is precisely the capability under test.
 *
 * Ground truth is published by each fixture as window.__f = {created, ended}, where `ended`
 * means every piece of content the fixture can ever produce is present. A strategy is
 * correct on a fixture iff it reaches ended === true within the round cap, or (for fixtures
 * that are already complete) stops without wasting the full budget.
 *
 * Env:
 *   BENCH_TRIALS=3           trials per fixture
 *   BENCH_ONLY=a,b           run only these fixtures (full sweep is slow)
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const piRequire = createRequire(
  "/home/wangyu/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/index.js",
);
const { createJiti } = piRequire("jiti");
const jiti = createJiti(import.meta.url);
const { createJevClient } = await jiti.import("../extensions/shared/jev/client.ts");

const KEY = JSON.parse(readFileSync("/home/wangyu/.pi/agent/auth.json", "utf8"))["typesafe-jev"].key;
const jev = createJevClient({ apiKey: KEY });
let jevCalls = 0; // global totals (display only)
let jevMs = 0;
const jevCallsByStrategy = {};
// Runners receive a stats object, because strategies execute concurrently and a shared
// "current strategy" variable would attribute every call to whichever finished last.
function makeStats(name) { return { name, calls: 0, ms: 0 }; }
function noteJev(stats, dtMs) {
  jevCalls++; jevMs += dtMs;
  stats.calls++; stats.ms += dtMs;
  jevCallsByStrategy[stats.name] = (jevCallsByStrategy[stats.name] || 0) + 1;
}

const MAX_ROUNDS = 8;
// Hard per-cell time budget: slow fixtures (4s loads) must not stretch a cell to minutes.
const CELL_BUDGET_MS = parseInt(process.env.BENCH_CELL_MS || "45000", 10);
const POST_ACTION_WAIT_MS = parseInt(process.env.BENCH_WAIT || "1500", 10); // shared evidence window
// Adaptive polling bounds: poll fast while content is arriving, back off when idle.
const POLL_FAST_MS = parseInt(process.env.BENCH_FAST || "250", 10);
const POLL_MAX_MS = parseInt(process.env.BENCH_MAXWAIT || "2500", 10);
// "Patient" wait: long enough that a genuinely slow loader has time to deliver.
const PATIENT_MS = parseInt(process.env.BENCH_PATIENT || "2000", 10);
const TRIALS = parseInt(process.env.BENCH_TRIALS || "3", 10);
const ONLY = (process.env.BENCH_ONLY || "").split(",").map((x) => x.trim()).filter(Boolean);

// ── shared browser-side helpers ─────────────────────────────────────────────
// Scroll the body AND every inner scrollable container: SPAs commonly scroll a div.
// Clickable elements with geometry, mirroring the production enumerator: Jev picks by index.
const CLICK_INDEX = (i) => {
  const els = [...document.querySelectorAll("button,a,[role=button],input[type=button],input[type=submit]")]
    .filter((e) => {
      const r = e.getBoundingClientRect();
      return e.offsetParent !== null && r.width >= 4 && r.height >= 4 && !(r.width > 900 && r.height > 300);
    });
  const el = els[i];
  if (!el) return false;
  el.click();
  return true;
};

const SCROLL = () => {
  window.scrollTo(0, document.body.scrollHeight);
  for (const el of document.querySelectorAll("*")) {
    if (el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 100) el.scrollTop = el.scrollHeight;
  }
};

// A view of the page rich enough for a fair DOM heuristic and for Jev.
const PROBE = () => {
  let maxInner = 0;
  let innerAtBottom = true;
  let innerScrollable = false;
  for (const el of document.querySelectorAll("*")) {
    if (el.clientHeight > 100 && el.scrollHeight > el.clientHeight + 40) {
      innerScrollable = true;
      maxInner = Math.max(maxInner, el.scrollHeight);
      if (el.scrollTop + el.clientHeight < el.scrollHeight - 40) innerAtBottom = false;
    }
  }
  const bodyScrollable = document.body.scrollHeight > innerHeight + 40;
  const text = document.body ? document.body.innerText || "" : "";
  return {
    bodyScrollH: document.body.scrollHeight,
    maxInnerScrollH: maxInner,
    viewportH: innerHeight,
    scrollY: Math.round(scrollY),
    bodyScrollable,
    atBottom: bodyScrollable ? scrollY + innerHeight >= document.body.scrollHeight - 40 : true,
    innerScrollable,
    innerAtBottom,
    // Inlined (not a helper) because page.evaluate serialises this function alone.
    elements: (() => {
      const out = [];
      for (const e of document.querySelectorAll("button,a,[role=button],input[type=button],input[type=submit]")) {
        const r = e.getBoundingClientRect();
        if (e.offsetParent === null || r.width < 4 || r.height < 4) continue;
        if (r.width > 900 && r.height > 300) continue;
        const text = (e.innerText || "").trim();
        const aria = (e.getAttribute("aria-label") || "").trim();
        const title = (e.getAttribute("title") || "").trim();
        // An icon-only control has text like "▼"; the aria-label is the real meaning, so
        // prefer it whenever the visible text is not informative.
        const informative = text.length >= 2 && !/^[\W_]+$/.test(text);
        const label = (informative ? text : (aria || title || text)) || (e.value || "").trim();
        const ariaNote = aria && aria !== label ? ` (aria-label="${aria}")` : "";
        out.push({ i: out.length, tag: e.tagName.toLowerCase(), label: (label + ariaNote).slice(0, 90),
                   x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      }
      return out;
    })(),
    textLen: text.length,
    endedMarker: /没有更多|no more results|已经到底|end of (list|results)|到底了/i.test(text),
    candidateButtons: [...document.querySelectorAll("button,a,[role=button]")]
      .map((e) => {
        const t = (e.innerText || "").trim();
        const a = (e.getAttribute("aria-label") || e.getAttribute("title") || "").trim();
        return (t || (a ? `(no text; aria-label="${a}")` : "")).slice(0, 60);
      })
      .filter(Boolean)
      .slice(0, 8),
    tail: text.slice(-220).replace(/\s+/g, " "),
  };
};

// ── fixtures ────────────────────────────────────────────────────────────────
const FIXTURES = [
  {
    key: "fast-infinite",
    desc: "appends 3 on scroll, done at 18",
    html: `<!doctype html><title>fast</title>
<style>body{margin:0}#list>div{height:300px;border-bottom:1px solid #ccc}</style>
<div id=list></div><script>
window.__f={created:0,ended:false};
const T=18,L=document.getElementById('list');
function add(){for(let i=0;i<3&&window.__f.created<T;i++){window.__f.created++;const d=document.createElement('div');d.textContent='ITEM '+window.__f.created;L.appendChild(d);}if(window.__f.created>=T)window.__f.ended=true;}
add();addEventListener('scroll',()=>{if(innerHeight+scrollY>=document.body.scrollHeight-80)add();});
</script>`,
  },
  {
    key: "inner-scroll",
    desc: "loads in an INNER scroller; body.scrollHeight frozen",
    html: `<!doctype html><title>inner</title>
<style>body{margin:0;height:100vh;overflow:hidden}#s{height:600px;overflow-y:auto;border:2px solid #900}
#s>div{height:300px;border-bottom:1px solid #ccc}</style>
<div id=s></div><script>
window.__f={created:0,ended:false};
const T=10,S=document.getElementById('s');
// Seed past the container height so it is scrollable from the start.
for(let i=0;i<4;i++){window.__f.created++;const d=document.createElement('div');d.textContent='ITEM '+window.__f.created;S.appendChild(d);}
function add(){
  if(window.__f.created>=T){window.__f.ended=true;return;}
  for(let k=0;k<2&&window.__f.created<T;k++){window.__f.created++;const d=document.createElement('div');d.textContent='ITEM '+window.__f.created;S.appendChild(d);}
  if(window.__f.created>=T)window.__f.ended=true;
}
S.addEventListener('scroll',()=>{if(S.scrollTop+S.clientHeight>=S.scrollHeight-60)add();});
</script>`,
  },
  {
    key: "loadmore-button",
    desc: "scroll does nothing; a button must be clicked",
    html: `<!doctype html><title>button</title>
<style>body{margin:0}#list>div{height:300px;border-bottom:1px solid #ccc}</style>
<div id=list></div><button id=b style="height:60px">加载更多 Load more</button><div style="height:900px"></div>
<script>
window.__f={created:0,ended:false};
const T=9,L=document.getElementById('list');
function add(){for(let i=0;i<3&&window.__f.created<T;i++){window.__f.created++;const d=document.createElement('div');d.textContent='ITEM '+window.__f.created;L.appendChild(d);}if(window.__f.created>=T){window.__f.ended=true;document.getElementById('b').style.display='none';}}
add();document.getElementById('b').onclick=()=>add();
</script>`,
  },
  {
    key: "slow-4s",
    desc: "appends every 4s after reaching the bottom",
    html: `<!doctype html><title>slow</title>
<style>body{margin:0}#list>div{height:300px;border-bottom:1px solid #ccc}</style>
<div id=list></div><script>
window.__f={created:0,ended:false};
const T=9,L=document.getElementById('list');let busy=false;
function add(){for(let i=0;i<3&&window.__f.created<T;i++){window.__f.created++;const d=document.createElement('div');d.textContent='SLOW '+window.__f.created;L.appendChild(d);}if(window.__f.created>=T)window.__f.ended=true;}
add();
addEventListener('scroll',()=>{if(busy)return;if(innerHeight+scrollY>=document.body.scrollHeight-80){busy=true;setTimeout(()=>{add();busy=false;},4000);}});
</script>`,
  },
  {
    key: "end-marker",
    desc: "appends then shows an explicit 没有更多了 marker",
    html: `<!doctype html><title>endmarker</title>
<style>body{margin:0}#list>div{height:300px;border-bottom:1px solid #ccc}#end{padding:20px;color:#900}</style>
<div id=list></div><div id=end></div><script>
window.__f={created:0,ended:false};
const T=9,L=document.getElementById('list');
function add(){for(let i=0;i<3&&window.__f.created<T;i++){window.__f.created++;const d=document.createElement('div');d.textContent='ITEM '+window.__f.created;L.appendChild(d);}if(window.__f.created>=T){window.__f.ended=true;document.getElementById('end').textContent='—— 没有更多了 · No more results ——';}}
add();addEventListener('scroll',()=>{if(innerHeight+scrollY>=document.body.scrollHeight-80)add();});
</script>`,
  },
  {
    key: "icon-expander",
    desc: "expander has NO visible text (aria-label only) -> regex blind",
    html: `<!doctype html><title>icon</title>
<style>body{margin:0}#list>div{height:300px;border-bottom:1px solid #ccc}</style>
<div id=list></div>
<button id=b aria-label="Show more comments" style="height:60px;width:200px">&#9660;</button>
<div style="height:900px"></div>
<script>
window.__f={created:0,ended:false};
const T=9,L=document.getElementById('list');
function add(){for(let i=0;i<3&&window.__f.created<T;i++){window.__f.created++;const d=document.createElement('div');d.textContent='ITEM '+window.__f.created;L.appendChild(d);}if(window.__f.created>=T){window.__f.ended=true;document.getElementById('b').style.display='none';}}
add();document.getElementById('b').onclick=()=>add();
</script>`,
  },
  {
    key: "pager-is-expander",
    desc: "button says 下一页 but appends IN PLACE (regex would skip it)",
    html: `<!doctype html><title>trap</title>
<style>body{margin:0}#list>div{height:300px;border-bottom:1px solid #ccc}</style>
<div id=list></div>
<button id=b style="height:60px">下一页</button><div style="height:900px"></div>
<script>
window.__f={created:0,ended:false};
const T=9,L=document.getElementById('list');
function add(){for(let i=0;i<3&&window.__f.created<T;i++){window.__f.created++;const d=document.createElement('div');d.textContent='ITEM '+window.__f.created;L.appendChild(d);}if(window.__f.created>=T){window.__f.ended=true;document.getElementById('b').style.display='none';}}
add();document.getElementById('b').onclick=()=>add();
</script>`,
  },
  {
    key: "very-slow-8s",
    desc: "appends 8s after bottom: defeats a 3x1.5s stability window",
    html: `<!doctype html><title>veryslow</title>
<style>body{margin:0}#list>div{height:300px;border-bottom:1px solid #ccc}</style>
<div id=list></div><script>
window.__f={created:0,ended:false};
const T=9,L=document.getElementById('list');let busy=false;
function add(){for(let i=0;i<3&&window.__f.created<T;i++){window.__f.created++;const d=document.createElement('div');d.textContent='VSLOW '+window.__f.created;L.appendChild(d);}if(window.__f.created>=T)window.__f.ended=true;}
add();
addEventListener('scroll',()=>{if(busy)return;if(innerHeight+scrollY>=document.body.scrollHeight-80){busy=true;setTimeout(()=>{add();busy=false;},8000);}});
</script>`,
  },
  {
    key: "static",
    desc: "8 items, nothing more ever (must stop fast)",
    html: `<!doctype html><title>static</title>
<style>body{margin:0}#list>div{height:300px;border-bottom:1px solid #ccc}</style>
<div id=list></div><script>
window.__f={created:8,ended:true};
const L=document.getElementById('list');
for(let i=1;i<=8;i++){const d=document.createElement('div');d.textContent='STATIC '+i;L.appendChild(d);}
</script>`,
  },
  {
    key: "explicit-paged",
    desc: "page 1 of N with a next link (pagination: do NOT follow)",
    html: `<!doctype html><title>paged</title>
<style>body{margin:0}#list>div{height:300px;border-bottom:1px solid #ccc}</style>
<div id=list></div><nav class=pagination><a rel=next href="#page2" onclick="return false">下一页 Next</a></nav>
<script>
window.__f={created:8,ended:true};
const L=document.getElementById('list');
for(let i=1;i<=8;i++){const d=document.createElement('div');d.textContent='PAGE1 '+i;L.appendChild(d);}
</script>`,
  },
];

// ── strategies ──────────────────────────────────────────────────────────────
// DOM: stop after 3 consecutive rounds in which NOTHING observable changed
// (body height, inner-container height, or text length). Never clicks.
async function runDom(page, stats) {
  const deadline = Date.now() + CELL_BUDGET_MS;
  let prev = await page.evaluate(PROBE);
  let stable = 0;
  let rounds = 0;
  for (let i = 1; i <= MAX_ROUNDS; i++) {
    if (Date.now() > deadline) break;
    rounds = i;
    await page.evaluate(SCROLL);
    await page.waitForTimeout(POST_ACTION_WAIT_MS);
    const p = await page.evaluate(PROBE);
    const changed =
      Math.abs(p.bodyScrollH - prev.bodyScrollH) > 10 ||
      Math.abs(p.maxInnerScrollH - prev.maxInnerScrollH) > 10 ||
      Math.abs(p.textLen - prev.textLen) > 5;
    stable = changed ? 0 : stable + 1;
    prev = p;
    if (stable >= 3) break;
  }
  return { rounds };
}

// DOM+ : the DOM heuristic PLUS the same regex-based expander click the Jev branch uses.
// This is the fair baseline: clicking never required a model, only the *decision* might.
const EXPANDER_RE = /load more|show more|see more|更多|展开/i;
const PAGER_RE = /下一页|next page|^next$|»/i;
async function tryRegexClick(page) {
  return page.evaluate(
    ([expand, pager]) => {
      const re = new RegExp(expand, "i"), pre = new RegExp(pager, "i");
      const el = [...document.querySelectorAll("button,a,[role=button]")].find(
        (e) => re.test(e.innerText || "") && !pre.test((e.innerText || "").trim()) && e.offsetParent !== null,
      );
      if (el) { el.click(); return true; }
      return false;
    },
    [EXPANDER_RE.source, PAGER_RE.source],
  );
}

async function runDomPlus(page, stats) {
  const deadline = Date.now() + CELL_BUDGET_MS;
  let prev = await page.evaluate(PROBE);
  let stable = 0, rounds = 0;
  for (let i = 1; i <= MAX_ROUNDS; i++) {
    if (Date.now() > deadline) break;
    rounds = i;
    await page.evaluate(SCROLL);
    await page.waitForTimeout(POST_ACTION_WAIT_MS);
    const p = await page.evaluate(PROBE);
    const changed =
      Math.abs(p.bodyScrollH - prev.bodyScrollH) > 10 ||
      Math.abs(p.maxInnerScrollH - prev.maxInnerScrollH) > 10 ||
      Math.abs(p.textLen - prev.textLen) > 5;
    stable = changed ? 0 : stable + 1;
    prev = p;
    // Same escalation the Jev branch gets: if scrolling produced nothing, try an expander.
    if (stable >= 2) { if (!(await tryRegexClick(page))) { if (stable >= 3) break; } else { stable = 0; } }
  }
  return { rounds };
}

// Jev: each round it sees the live DOM summary and chooses scroll / click / end.
async function runJev(page, stats) {
  const deadline = Date.now() + CELL_BUDGET_MS;
  let prev = await page.evaluate(PROBE);
  let rounds = 0;
  let last = "?";
  for (let i = 1; i <= MAX_ROUNDS; i++) {
    if (Date.now() > deadline) break;
    rounds = i;
    const p = await page.evaluate(PROBE);
    const first = i === 1;
    const state = {
      bodyScrollHeight: p.bodyScrollH,
      bodyIsScrollable: p.bodyScrollable,
      bodyIsAtBottom: p.atBottom,
      innerScrollableContainerPresent: p.innerScrollable,
      largestInnerScrollHeight: p.maxInnerScrollH,
      innerContainerIsAtBottom: p.innerAtBottom,
      viewportHeight: p.viewportH,
      textLength: p.textLen,
      // Absent on the first round: there is no previous observation to compare against,
      // and reporting 0 would read as "nothing is happening".
      textLengthChangeSinceLastRound: first ? null : p.textLen - prev.textLen,
      scrollHeightChangeSinceLastRound: first ? null : p.bodyScrollH - prev.bodyScrollH,
      explicitEndMarkerVisible: p.endedMarker,
      candidateButtonsOrLinks: p.candidateButtons,
      lastVisibleText: p.tail,
    };
    let choice = "scroll";
    try {
      const t = Date.now();
      /* counted after the call */
      const res = await jev.evaluate(
        {
          state,
          questions: {
            next: {
              type: "choice",
              instructions:
                "A tool is reading this page and wants all content belonging to THIS page. It fetches the page once and must not navigate to a different page. Decide the next action. " +
                "Note: the page may scroll as a whole (bodyIsScrollable) or inside an inner container " +
                "(innerScrollableContainerPresent + innerContainerIsAtBottom); content can still load in a container even " +
                "when the body does not scroll. A null *_ChangeSinceLastRound field means this is the first observation. " +
                "'scroll' = more of this page's content likely appears by scrolling down. " +
                "'click' = more of THIS page's content needs an in-place expander (a 'load more' / 'show more' / '展开' control that appends content without leaving the page). " +
                "'end' = everything this page offers is already present. " +
                "Classic pagination (a '下一页' / 'next page' / page-number link that opens a DIFFERENT page) is NOT to be clicked: treat it as 'end' for this page. " +
                "Also choose 'end' when content has clearly stopped growing and nothing remains to reveal.",
              criteria: {
                scroll: "More of this page's content likely appears by scrolling further down.",
                click: "An in-place expander (load more / show more / 展开) can append more of this page's content.",
                end: "This page is fully loaded, or only a link to a different page remains.",
              },
            },
          },
        },
        { timeoutMs: 6000 },
      );
      noteJev(stats, Date.now() - t);
      const a = res.answers?.next;
      if (a?.type === "choice") choice = a.choice;
    } catch {
      choice = "scroll"; // an API failure must never cause a false "done"
    }
    const em = /^e(\d+)$/.exec(choice);
    last = choice;
    if (choice === "end") break;

    if (em) {
      const clicked = await page.evaluate(CLICK_INDEX, parseInt(em[1], 10));
      if (!clicked) await page.evaluate(SCROLL);
    } else if (choice === "click") {
      const clicked = await tryRegexClick(page);
      if (!clicked) await page.evaluate(SCROLL);
    } else {
      await page.evaluate(SCROLL);
    }
    prev = p;
    await page.waitForTimeout(POST_ACTION_WAIT_MS);
  }
  return { rounds, last };
}

// Jev-adaptive: the point of this variant is POLLING POLICY, not just decisions.
//   * while content is visibly still arriving, scrolling again is obviously correct, so
//     skip the Jev call entirely and poll fast (saves both latency and API calls);
//   * once growth stalls, ask Jev whether that means "click an expander" or "we are done".
async function runJevAdaptive(page, stats) {
  const deadline = Date.now() + CELL_BUDGET_MS;
  let prev = await page.evaluate(PROBE);
  let rounds = 0, jevHere = 0, last = "?", wait = POLL_FAST_MS, stalling = 0;

  for (let i = 1; i <= MAX_ROUNDS; i++) {
    if (Date.now() > deadline) break;
    rounds = i;
    const grew =
      Math.abs(prev.bodyScrollH - (await page.evaluate(PROBE)).bodyScrollH) > 10 ||
      Math.abs(prev.textLen - (await page.evaluate(PROBE)).textLen) > 5;

    await page.evaluate(SCROLL);
    await page.waitForTimeout(wait);
    const p = await page.evaluate(PROBE);
    const changed =
      Math.abs(p.bodyScrollH - prev.bodyScrollH) > 10 ||
      Math.abs(p.maxInnerScrollH - prev.maxInnerScrollH) > 10 ||
      Math.abs(p.textLen - prev.textLen) > 5;

    if (changed) {
      // Content is arriving: keep scrolling, no model call, poll fast.
      wait = POLL_FAST_MS;
      stalling = 0;
      prev = p;
      last = "scroll(fast)";
      continue;
    }

    // Growth stalled. A single fast sample is weak evidence (a slow loader can be mid-flight),
    // so back off and only consult Jev once waiting has become patient. This is what lets a
    // 4s-per-append page prove itself while still exiting quickly on a truly static page.
    stalling++;
    if (wait < PATIENT_MS) {
      wait = Math.min(PATIENT_MS, Math.round(wait * 2.2));
      prev = p;
      last = `wait(${wait})`;
      continue;
    }

    // Patient wait produced nothing -> a semantic decision is now worth making.
    jevHere++;
    let choice = "scroll";
    try {
      const t = Date.now();
      /* counted after the call */
      const res = await jev.evaluate(
        {
          state: {
            bodyScrollHeight: p.bodyScrollH,
            bodyIsScrollable: p.bodyScrollable,
            bodyIsAtBottom: p.atBottom,
            innerScrollableContainerPresent: p.innerScrollable,
            largestInnerScrollHeight: p.maxInnerScrollH,
            innerContainerIsAtBottom: p.innerAtBottom,
            viewportHeight: p.viewportH,
            textLength: p.textLen,
            textLengthChangeSinceLastRound: p.textLen - prev.textLen,
            explicitEndMarkerVisible: p.endedMarker,
            candidateButtonsOrLinks: p.candidateButtons,
            lastVisibleText: p.tail,
          },
          questions: {
            next: {
              type: "choice",
              instructions:
                "A tool is reading this page and wants all content belonging to THIS page. It must not navigate to a different page. " +
                "Content has STOPPED growing after scrolling to the bottom. Decide: " +
                "'click' if an in-place expander ('load more' / 'show more' / '展开') would append more of this page's content; " +
                "'scroll' if more content is merely slow to arrive; " +
                "'end' if everything this page offers is already present. " +
                "Classic pagination ('下一页' / 'next page' / page numbers, opening a DIFFERENT page) must be treated as 'end'.",
              criteria: {
                click: "An in-place expander can append more of this page's content.",
                scroll: "More content is likely just slow to arrive; keep polling.",
                end: "This page is fully loaded, or only a link to a different page remains.",
              },
            },
          },
        },
        { timeoutMs: 6000 },
      );
      noteJev(stats, Date.now() - t);
      const a = res.answers?.next;
      if (a?.type === "choice") choice = a.choice;
    } catch {
      choice = "scroll"; // never let an API failure look like "done"
    }
    last = choice;
    if (choice === "end") break;

    if (choice === "click") {
      const clicked = await tryRegexClick(page);
      if (!clicked) await page.evaluate(SCROLL);
      wait = POLL_FAST_MS; // appended content should show up promptly
    } else {
      // Stalled but Jev says keep waiting: back off instead of hammering the page.
      wait = Math.min(POLL_MAX_MS, Math.round(wait * 1.5));
    }
    prev = p;
  }
  return { rounds, note: `jev calls ${jevHere}` };
}

// ── harness ─────────────────────────────────────────────────────────────────
const browser = await chromium.launch({
  headless: false,
  args: ["--disable-blink-features=AutomationControlled", "--no-first-run", "--no-default-browser-check"],
});

const list = ONLY.length ? FIXTURES.filter((f) => ONLY.includes(f.key)) : FIXTURES;
if (!list.length) {
  console.error(`No fixture matched BENCH_ONLY=${JSON.stringify(ONLY)}. Known keys: ${FIXTURES.map((f) => f.key).join(", ")}`);
  await browser.close();
  process.exit(2);
}

async function runOnce(fn, fx, stats) {
  const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  const page = await ctx.newPage();
  const t0 = Date.now();
  try {
    await page.setContent(fx.html);
    await page.waitForTimeout(400);
    const pre = await page.evaluate(PROBE);
    if (pre.bodyScrollH <= pre.viewportH + 20 && pre.maxInnerScrollH <= pre.viewportH + 20) {
      return { ok: false, rounds: 0, ms: Date.now() - t0, note: "fixture not scrollable" };
    }
    const { rounds } = await fn(page, stats);
    const f = await page.evaluate(() => ({ created: window.__f?.created ?? -1, ended: !!window.__f?.ended }));
    return { ok: f.ended, rounds, ms: Date.now() - t0, created: f.created };
  } catch (e) {
    return { ok: false, rounds: 0, ms: Date.now() - t0, note: e.message.split("\n")[0].slice(0, 70) };
  } finally {
    await ctx.close();
  }
}

// Cells are independent (own context/page), so run them concurrently instead of
// serialising 42 page loads. Keeps wall-clock near the slowest single cell.
const CONCURRENCY = parseInt(process.env.BENCH_CONCURRENCY || "6", 10);

const resultsByName = {};
async function trials(name, fn) {
  const stats = makeStats(name);
  const cells = [];
  for (let t = 0; t < TRIALS; t++) for (const fx of list) cells.push(fx);
  const results = new Array(cells.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, cells.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= cells.length) return;
        results[i] = { fx: cells[i], r: await runOnce(fn, cells[i], stats) };
      }
    }),
  );
  const acc = new Map();
  for (const { fx, r } of results) {
    if (!acc.has(fx.key)) acc.set(fx.key, { pass: 0, n: 0, rounds: [], ms: [], notes: new Set() });
    const a = acc.get(fx.key);
    a.n++;
    if (r.ok) a.pass++;
    a.rounds.push(r.rounds);
    a.ms.push(r.ms);
    if (r.note) a.notes.add(r.note);
  }
  resultsByName[name] = stats;
  return acc;
}

const which = process.argv[2] || "all";
const results = {};
const STRATEGIES = {
  dom: runDom,
  domplus: runDomPlus,
  jev: runJev,
  jevadaptive: runJevAdaptive,
};
const selected =
  which === "all" || which === "both" ? Object.keys(STRATEGIES) : which.split(",").map((x) => x.trim()).filter(Boolean);
const unknown = selected.filter((k) => !STRATEGIES[k]);
if (unknown.length) {
  console.error(`Unknown strategy ${JSON.stringify(unknown)}. Available: ${Object.keys(STRATEGIES).join(", ")}, all`);
  process.exit(2);
}
const jobs = [];
for (const k of selected) jobs.push(trials(k, STRATEGIES[k]).then((a) => (results[k] = a)));
await Promise.all(jobs);
await browser.close();

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
console.log(`\n=== per-fixture (${TRIALS} trials, cap ${MAX_ROUNDS} rounds) ===`);
const stratNames = Object.keys(results);
const COLS = ["dom", "domplus", "jev", "jevadaptive"]; // stable display order
const label = { dom: "DOM", domplus: "DOM+", jev: "JEV", jevadaptive: "JEV-ADAPT" };
const active = COLS.filter((c) => results[c]);
console.log("fixture".padEnd(17), active.map((c) => `${label[c]} pass/n  avgR  avgMs`.padEnd(24)).join(""), "desc");
for (const fx of list) {
  const cells = active.map((c) => {
    const a = results[c]?.get(fx.key);
    return (a ? `${a.pass}/${a.n}  ${avg(a.rounds).toFixed(1)}r  ${Math.round(avg(a.ms))}ms`.padEnd(24) : "-".padEnd(24));
  });
  console.log(fx.key.padEnd(17), cells.join(""), fx.desc);
  for (const c of active) {
    const a = results[c]?.get(fx.key);
    if (a?.notes?.size) console.log(" ".repeat(17), "  ! " + [...a.notes].join("; "));
  }
}

console.log("\n=== totals ===");
for (const [name, acc] of Object.entries(results)) {
  let pass = 0, n = 0;
  const perFixture = [];
  for (const a of acc.values()) { pass += a.pass; n += a.n; perFixture.push(avg(a.rounds)); }
  console.log(`${name}: ${pass}/${n} (${((pass / n) * 100).toFixed(0)}%) | avg rounds/fixture ${avg(perFixture).toFixed(1)}`);
}
console.log(`\nJev cost: ${jevCalls} calls, ${(jevMs / 1000).toFixed(1)}s API time (${jevCalls ? Math.round(jevMs / jevCalls) : 0}ms/call)`);
for (const [k, v] of Object.entries(jevCallsByStrategy)) {
  const st = resultsByName[k];
  console.log(`  ${k}: ${v} calls, ${((st?.ms || 0) / 1000).toFixed(1)}s in API (${v ? Math.round((st?.ms || 0) / v) : 0}ms/call)`);
}
