/**
 * Cloudflare challenge handling for web_reader.
 *
 * Detection and element selection are BOTH driven by Jev (TypeSafe "System One"),
 * which returns typed answers instead of free text:
 *   - `state`  : challenge | content | error | loading   — what the page is showing
 *   - `action` : "wait" | "e0" | "e1" ...                — which element to click
 *
 * Element enumeration uses CDP `DOM.getDocument { pierce: true }`, which is the only
 * way to see the Turnstile widget: Cloudflare mounts it inside a **closed shadow root**,
 * so `page.$(...)` / `document.querySelector(...)` cannot reach it.
 *
 * Clicking uses a synthetic-but-human mouse path (cubic bezier + tremor + eased
 * velocity + overshoot) rather than a teleporting `mouse.click`.
 *
 * Config:
 *   PI_WEBREADER_CF=off          disable this module entirely
 *   PI_WEBREADER_CF_ROUNDS=N     max click/verify rounds (default 8)
 *   PI_WEBREADER_CF_TIMEOUT_MS=N overall deadline for the challenge branch (default 40000)
 */
import type { JevServiceV1 } from "../shared/jev/types.ts";

// Titles Cloudflare uses for its interstitial. Used only as a cheap pre-gate so that
// ordinary pages don't pay for a Jev round-trip; Jev remains the actual judge.
const CF_TITLE_RE =
  /just a moment|请稍候|checking your browser|正在验证|attention required|安全验证|verify you are human|ddos protection|one more step/i;
const CF_TEXT_RE = /cloudflare|ray id|cf-chl|安全验证|恶意自动程序|verify you are human/i;

const CF_FRAME_RE = /challenges\.cloudflare\.com|cdn-cgi\/challenge-platform/i;

const MAX_CANDIDATES = 40;
const MAX_DESC = 180;

export interface CfMouse {
  move(x: number, y: number, opts?: { steps?: number }): Promise<void>;
  down(): Promise<void>;
  up(): Promise<void>;
}

export interface CfPage {
  url(): string;
  title(): Promise<string>;
  evaluate<T, A = void>(fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
  mouse?: CfMouse;
}

export interface CfCdp {
  send(method: string, params?: unknown): Promise<unknown>;
}

export interface CfContext {
  newCDPSession?(page: unknown): Promise<CfCdp>;
}

export interface CfOutcome {
  /** Jev said this is (or looks like) a Cloudflare challenge page. */
  detected: boolean;
  /** We reached real content after the challenge. */
  solved: boolean;
  /** Click rounds performed. */
  rounds: number;
  /** Last observed Jev state + confidence. */
  state?: string;
  confidence?: number;
  /** Why we stopped, when not solved. */
  reason?: string;
}

interface Candidate {
  nodeId: number;
  tag: string;
  attrs: Record<string, string>;
  rect: { x: number; y: number; w: number; h: number };
  /** The node was reached through a challenges.cloudflare.com frame subtree. */
  insideChallengeFrame?: boolean;
}

interface Snapshot {
  url: string;
  title: string;
  text: string;
  textLength: number;
  /** A Cloudflare challenge/turnstile frame is present anywhere in the DOM. */
  hasChallengeFrame: boolean;
}

function sleep(page: CfPage, ms: number): Promise<void> {
  return page.waitForTimeout(ms).catch(() => {});
}

async function snapshot(page: CfPage): Promise<Snapshot> {
  const s = await page
    .evaluate(() => ({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || "").slice(0, 900).replace(/\s+/g, " "),
      textLength: (document.body?.innerText || "").trim().length,
      // Turnstile mounts inside a (possibly closed) shadow root, so walk shadow roots too.
      hasChallengeFrame: (() => {
        const hit = (src: string) => /challenges\.cloudflare\.com|cdn-cgi\/challenge-platform/.test(src);
        const seen: Array<Document | ShadowRoot> = [document];
        while (seen.length) {
          const root = seen.pop()!;
          for (const el of root.querySelectorAll("iframe")) {
            const src = (el as HTMLIFrameElement).src || "";
            if (hit(src)) return true;
          }
          for (const el of root.querySelectorAll("*")) {
            if (el.shadowRoot) seen.push(el.shadowRoot);
          }
        }
        return false;
      })(),
    }))
    .catch(() => null);
  return s ?? { url: page.url(), title: "", text: "", textLength: 0, hasChallengeFrame: false };
}

/**
 * Cheap structural pre-gate. Conservative on purpose: it only skips the Jev round-trip
 * when the page looks like an ordinary, content-bearing document with no CF markers.
 */
/**
 * Cheap structural pre-gate, run before any Jev call.
 *
 * Deliberately based only on positive Cloudflare signals. An earlier version also treated
 * "body text is empty" as a challenge hint, but at `domcontentloaded` essentially every
 * SPA and docs site has an empty body, so that burned two Jev calls on ordinary pages.
 */
function looksLikeChallenge(snap: Snapshot, headerHint: boolean): boolean {
  // Server told us outright.
  if (headerHint) return true;
  // The interstitial's own title.
  if (CF_TITLE_RE.test(snap.title)) return true;
  // CF markers ("Ray ID", "cf-chl", the Chinese interstitial copy) on a page with no
  // real content yet. The length guard keeps a long article that merely mentions
  // Cloudflare from being mistaken for a challenge.
  if (snap.textLength < 1500 && CF_TEXT_RE.test(`${snap.title} ${snap.text}`)) return true;
  // A Turnstile widget is already in the DOM (cheap to detect).
  //
  // NOTE: this only sees *open* shadow roots. Cloudflare normally mounts the widget in a
  // CLOSED root, which is why element enumeration has to go through CDP `pierce:true`.
  // So this signal is a useful bonus, not a reliable one — detection must not depend on it.
  return snap.hasChallengeFrame;
}
// ---------------------------------------------------------------------------
// CDP element enumeration (pierces closed shadow roots + frames)
// ---------------------------------------------------------------------------
interface CdpNode {
  nodeId?: number;
  nodeName?: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
  contentDocument?: CdpNode;
}

const INTERACTIVE_TAGS = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "IFRAME", "LABEL"]);
const INTERACTIVE_ROLES = new Set(["button", "link", "checkbox", "tab", "menuitem"]);
const INTERESTING_ATTRS = /challenge|turnstile|verify|checkbox|captcha|cf-/i;

async function enumerate(cdp: CfCdp): Promise<Candidate[]> {
  let root: CdpNode | undefined;
  try {
    const doc = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as { root?: CdpNode };
    root = doc?.root;
  } catch {
    return [];
  }
  if (!root) return [];

  const raw: { nodeId: number; tag: string; attrs: Record<string, string>; insideCf: boolean }[] = [];
  // Track whether each node sits under a Cloudflare challenge frame. `pierce` + the
  // contentDocument hop mean a control inside the widget shows up as a descendant, so the
  // flag has to be carried down the walk rather than inferred from the node itself.
  const stack: { node: CdpNode; insideCf: boolean }[] = [{ node: root, insideCf: false }];
  while (stack.length) {
    const { node: n, insideCf } = stack.pop()!;
    const tag = n.nodeName || "";
    let childInsideCf = insideCf;
    if (tag && tag !== "#text" && tag !== "#comment" && tag !== "#document" && tag !== "#document-fragment") {
      const attrs: Record<string, string> = {};
      const a = n.attributes || [];
      for (let i = 0; i + 1 < a.length; i += 2) attrs[a[i]] = a[i + 1];
      const role = attrs.role || "";
      // Entering a CF frame marks everything below it as challenge-widget territory.
      if (tag === "IFRAME" && CF_FRAME_RE.test(attrs.src || "")) childInsideCf = true;
      const hay = `${attrs.id || ""} ${attrs.class || ""} ${attrs.src || ""} ${attrs["aria-label"] || ""}`;
      if (
        INTERACTIVE_TAGS.has(tag) ||
        INTERACTIVE_ROLES.has(role) ||
        INTERESTING_ATTRS.test(hay)
      ) {
        if (typeof n.nodeId === "number") raw.push({ nodeId: n.nodeId, tag, attrs, insideCf });
      }
    }
    if (n.children) for (const c of n.children) stack.push({ node: c, insideCf: childInsideCf });
    if (n.shadowRoots) for (const c of n.shadowRoots) stack.push({ node: c, insideCf: childInsideCf });
    if (n.contentDocument) stack.push({ node: n.contentDocument, insideCf: childInsideCf });
  }

  const out: Candidate[] = [];
  for (const c of raw.slice(0, MAX_CANDIDATES * 3)) {
    if (out.length >= MAX_CANDIDATES) break;
    let box: number[];
    try {
      const bm = (await cdp.send("DOM.getBoxModel", { nodeId: c.nodeId })) as {
        model?: { border?: number[] };
      };
      box = bm?.model?.border ?? [];
    } catch {
      continue; // stale node or not rendered
    }
    if (box.length < 8) continue;
    const x = Math.min(box[0], box[2], box[4], box[6]);
    const y = Math.min(box[1], box[3], box[5], box[7]);
    const w = Math.max(box[0], box[2], box[4], box[6]) - x;
    const h = Math.max(box[1], box[3], box[5], box[7]) - y;
    if (w < 4 || h < 4) continue;
    if (w > 1600 || h > 1000) continue; // whole-page containers
    out.push({
      nodeId: c.nodeId,
      tag: c.tag,
      attrs: c.attrs,
      rect: { x, y, w, h },
      insideChallengeFrame: c.insideCf,
    });
  }
  return out;
}

function describe(c: Candidate, i: number): string {
  const a = c.attrs;
  let s = `${c.tag.toLowerCase()}${a.id ? "#" + a.id : ""}`;
  if (a.role) s += ` role=${a.role}`;
  const label = (a["aria-label"] || a.title || a.alt || a.name || a.placeholder || a.value || "").trim();
  if (label) s += ` label="${label.slice(0, 60)}"`;
  if (a.src) s += ` src="${a.src.slice(0, 70)}"`;
  s += ` at ${Math.round(c.rect.x)},${Math.round(c.rect.y)} size ${Math.round(c.rect.w)}x${Math.round(c.rect.h)}`;
  if (c.tag === "IFRAME") s += " (embedded cross-origin frame)";
  return s.slice(0, MAX_DESC);
}

/**
 * Where inside a candidate a human would click. The Turnstile widget is a wide
 * (≈300x65) iframe whose checkbox sits at the left edge, vertically centred.
 */
function clickPoint(c: Candidate): { x: number; y: number } {
  const { x, y, w, h } = c.rect;
  if (c.tag === "IFRAME" && w >= 180 && h >= 36) return { x: x + 29, y: y + h / 2 };
  return { x: x + w / 2, y: y + h / 2 };
}

/**
 * True when the node is (or came from inside) Cloudflare's challenge frame.
 *
 * The candidate list and the text Jev reasons over are both page-controlled, so a hostile
 * page could dress an arbitrary link up as "Verify you are human". Requiring the CF frame
 * origin stops the clicker from being aimed at the site's own controls.
 */
function isCloudflareWidget(c: Candidate): boolean {
  if (c.tag === "IFRAME") return CF_FRAME_RE.test(c.attrs.src || "");
  return c.insideChallengeFrame === true || CF_FRAME_RE.test(c.attrs.src || "");
}

// ---------------------------------------------------------------------------
// Human-like mouse path: cubic bezier + tremor + eased velocity + overshoot
// ---------------------------------------------------------------------------
function bezier(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const m = 1 - t;
  return m * m * m * p0 + 3 * m * m * t * p1 + 3 * m * t * t * p2 + t * t * t * p3;
}

async function humanClick(page: CfPage, to: { x: number; y: number }, log: (...a: unknown[]) => void) {
  const mouse = page.mouse;
  if (!mouse) throw new Error("page.mouse is unavailable");

  // Start from somewhere plausible rather than the previous exact position.
  const from = { x: Math.max(20, to.x - 90 - Math.random() * 60), y: Math.max(20, to.y - 60 - Math.random() * 40) };

  const cp1 = {
    x: from.x + (to.x - from.x) * 0.3 + (Math.random() - 0.5) * 150,
    y: from.y + (to.y - from.y) * 0.3 + (Math.random() - 0.5) * 110,
  };
  const cp2 = {
    x: from.x + (to.x - from.x) * 0.7 + (Math.random() - 0.5) * 110,
    y: from.y + (to.y - from.y) * 0.7 + (Math.random() - 0.5) * 80,
  };

  const steps = 24 + Math.floor(Math.random() * 14);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // ease-in-out: slow start, fast middle, slow settle
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    // tremor damped as we converge
    const damp = 1 - e * 0.65;
    const jx = (Math.random() - 0.5) * 2.6 * damp;
    const jy = (Math.random() - 0.5) * 2.6 * damp;
    await mouse.move(bezier(from.x, cp1.x, cp2.x, to.x, e) + jx, bezier(from.y, cp1.y, cp2.y, to.y, e) + jy);
    await sleep(page, Math.round(3 + Math.random() * 12 + 8 * Math.abs(Math.sin(Math.PI * e))));
  }

  // Occasional overshoot then correction — very human.
  if (Math.random() < 0.5) {
    await mouse.move(to.x + (Math.random() - 0.5) * 9, to.y + (Math.random() - 0.5) * 7);
    await sleep(page, Math.round(25 + Math.random() * 45));
  }
  await mouse.move(to.x, to.y);
  await sleep(page, Math.round(80 + Math.random() * 150)); // reaction dwell

  await mouse.down();
  await sleep(page, Math.round(45 + Math.random() * 60));
  await mouse.up();
  log("human click at", Math.round(to.x), Math.round(to.y));
}

// ---------------------------------------------------------------------------
// Jev: one call answers BOTH "what state is this" and "what should I click"
// ---------------------------------------------------------------------------
interface Verdict {
  state: string;
  stateConfidence: number;
  action: string;
  actionConfidence: number;
}

async function askJev(
  jev: JevServiceV1,
  snap: Snapshot,
  candidates: Candidate[],
  signal?: AbortSignal,
  timeoutMs = 4000,
): Promise<Verdict> {
  const actionCriteria: Record<string, string> = {
    wait: "No bot-verification control is on screen yet — just wait",
  };
  candidates.forEach((c, i) => {
    actionCriteria[`e${i}`] = describe(c, i);
  });

  const res = await jev.evaluate(
    {
      state: {
        url: snap.url,
        title: snap.title,
        text: snap.text,
        textLength: snap.textLength,
        clickableElements: candidates.map((c, i) => `e${i}: ${describe(c, i)}`).join("\n"),
      },
      questions: {
        state: {
          type: "choice",
          instructions: "What is the current state of this web page?",
          criteria: {
            challenge:
              "A Cloudflare / bot-verification interstitial ('Just a moment', 请稍候, 正在验证, 'checking your browser', 'verify you are human'). No real site content yet.",
            content: "The real website content is displayed and readable.",
            error: "An error, access-denied, or blocked page.",
            loading: "Still loading; no meaningful text yet.",
          },
        },
        action: {
          type: "choice",
          instructions:
            "If this page shows a bot-verification widget (for example a Cloudflare Turnstile checkbox labelled '请验证您是真身' / 'Verify you are human'), choose the element to click in order to pass it. If no such verification element exists yet, choose 'wait'.",
          criteria: actionCriteria,
        },
      },
    },
    { timeoutMs, signal },
  );

  const st = res.answers?.state;
  const ac = res.answers?.action;
  return {
    state: st?.type === "choice" ? st.choice : "unknown",
    stateConfidence: st?.type === "choice" ? st.confidence : 0,
    action: ac?.type === "choice" ? ac.choice : "wait",
    actionConfidence: ac?.type === "choice" ? ac.confidence : 0,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------
export async function handleCloudflareChallenge(opts: {
  page: CfPage;
  context: CfContext;
  url: string;
  jev: JevServiceV1;
  signal?: AbortSignal;
  log: (...a: unknown[]) => void;
  /** Response carried `cf-mitigated: challenge`. */
  headerHint?: boolean;
  maxRounds?: number;
  deadlineMs?: number;
}): Promise<CfOutcome> {
  const { page, context, url, jev, signal, log } = opts;
  if (/^(off|0|false|no)$/i.test(process.env.PI_WEBREADER_CF || "")) {
    return { detected: false, solved: false, rounds: 0, reason: "disabled" };
  }

  const maxRoundsRaw = opts.maxRounds ?? parseInt(process.env.PI_WEBREADER_CF_ROUNDS || "8", 10);
  const deadlineRaw = opts.deadlineMs ?? parseInt(process.env.PI_WEBREADER_CF_TIMEOUT_MS || "40000", 10);
  // A malformed env value would otherwise give NaN: maxRounds=NaN skips the loop entirely,
  // and deadline=NaN makes every deadline comparison false (effectively unbounded).
  const maxRounds = Number.isFinite(maxRoundsRaw) && maxRoundsRaw > 0 ? maxRoundsRaw : 8;
  const deadlineMs = Number.isFinite(deadlineRaw) && deadlineRaw > 0 ? deadlineRaw : 40_000;

  // --- cheap pre-gate: don't spend a Jev call on ordinary pages ---------------
  const first = await snapshot(page);
  if (!looksLikeChallenge(first, !!opts.headerHint)) {
    return { detected: false, solved: false, rounds: 0, reason: "no-challenge-signal" };
  }

  // --- CDP session (needed to pierce the closed shadow root) ------------------
  let cdp: CfCdp | undefined;
  try {
    cdp = await context.newCDPSession?.(page);
    // Enabling the DOM domain is a prerequisite for getDocument/getBoxModel.
    await cdp?.send("DOM.enable");
  } catch (e) {
    log("CDP session unavailable; challenge handling degraded:", (e as Error).message);
    cdp = undefined;
  }

  const deadline = Date.now() + deadlineMs;
  let rounds = 0;
  let last: Verdict | undefined;
  let sawChallenge = false;
  const remaining = () => deadline - Date.now();

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) return { detected: sawChallenge, solved: false, rounds, reason: "aborted" };
    // Check the budget at the top as well: one round costs several seconds (enumerate +
    // Jev + a human-paced click), so checking only at the bottom could overshoot ~2x.
    if (remaining() <= 0) {
      return {
        detected: sawChallenge,
        solved: false,
        rounds,
        state: last?.state,
        confidence: last?.stateConfidence,
        reason: "deadline",
      };
    }

    const snap = await snapshot(page);
    const candidates = cdp ? await enumerate(cdp) : [];

    let verdict: Verdict;
    try {
      // Let Jev use only what is left of our budget, never more than its own limit.
      verdict = await askJev(jev, snap, candidates, signal, Math.max(500, Math.min(4000, remaining())));
    } catch (e) {
      log("Jev evaluation failed during challenge handling:", (e as Error).message);
      return {
        detected: sawChallenge,
        solved: false,
        rounds,
        state: last?.state,
        confidence: last?.stateConfidence,
        reason: "jev-unavailable",
      };
    }
    last = verdict;
    if (verdict.state === "challenge") sawChallenge = true;
    log(
      `challenge round ${round}: state=${verdict.state}(${verdict.stateConfidence.toFixed(2)}) ` +
        `action=${verdict.action}(${verdict.actionConfidence.toFixed(2)}) candidates=${candidates.length}`,
    );

    if (verdict.state === "content") {
      log("challenge passed; real content is available");
      return {
        detected: sawChallenge,
        solved: sawChallenge,
        rounds,
        state: verdict.state,
        confidence: verdict.stateConfidence,
      };
    }
    if (verdict.state === "error") {
      return {
        detected: sawChallenge,
        solved: false,
        rounds,
        state: verdict.state,
        confidence: verdict.stateConfidence,
        reason: "error-page",
      };
    }

    // Bail out cheaply if this never looked like a challenge: the pre-gate can be
    // fooled by a legitimately empty/JS-heavy page, and we must not keep clicking
    // on an ordinary site (a stray click could submit a form or hit a destructive control).
    if (!sawChallenge && round >= 1) {
      log("no challenge observed; leaving the page alone");
      return { detected: false, solved: false, rounds, state: verdict.state, reason: "not-a-challenge" };
    }

    // --- click the element Jev chose ----------------------------------------
    // Gated three ways: state must be "challenge", Jev must have named a candidate, and
    // that candidate must actually belong to Cloudflare's challenge frame. The last check
    // matters because both the candidate list and the text Jev reads are page-controlled.
    const m = verdict.state === "challenge" ? /^e(\d+)$/.exec(verdict.action || "") : null;
    if (m) {
      const target = candidates[parseInt(m[1], 10)];
      if (target && !isCloudflareWidget(target)) {
        log(`refusing to click ${verdict.action}: not a Cloudflare challenge widget`);
      } else if (target && page.mouse) {
        try {
          await humanClick(page, clickPoint(target), log);
          rounds++;
        } catch (e) {
          log("click failed:", (e as Error).message);
        }
      } else if (!target) {
        log(`Jev chose ${verdict.action} but it is not in the current candidate list`);
      }
    }

    if (Date.now() >= deadline) {
      return {
        detected: sawChallenge,
        solved: false,
        rounds,
        state: last.state,
        confidence: last.stateConfidence,
        reason: "deadline",
      };
    }
    await sleep(page, Math.max(0, Math.min(900 + Math.random() * 700, remaining())));
  }

  return {
    detected: sawChallenge,
    solved: false,
    rounds,
    state: last?.state,
    confidence: last?.stateConfidence,
    reason: "max-rounds",
  };
}
