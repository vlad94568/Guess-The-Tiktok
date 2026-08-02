// TikTok extraction. Everything TikTok-specific lives in this file, and every
// selector / URL / JSON path lives in the SELECTORS + ROUTES blocks at the top.
// When TikTok changes (it will), this is the only place to edit.
//
// ---------------------------------------------------------------------------
// HOW THIS ACTUALLY WORKS  (empirically verified 2026-08-01 against live TikTok)
// ---------------------------------------------------------------------------
// The original build spec said "prefer the hydration JSON blob over DOM scraping"
// for the video list. That is WRONG and was disproven in the spike: the blob's
// `userInfo.itemList` is always `[]` and no other part of the blob carries video
// ids. `SIGI_STATE` no longer exists at all. What is actually true:
//
//   1. Video ids come from XHR JSON endpoints (ROUTES below), not the DOM and not
//      the blob. Both return { itemList: [{id, ...}], cursor, hasMore, statusCode }.
//   2. The blob is still REQUIRED, but for metadata only: secUid (a mandatory query
//      param for both endpoints) and openFavorite (the only reliable "are likes
//      public" signal).
//   3. Those endpoints need ~42 device/app params (aid, msToken, X-Bogus, ...).
//      Synthesising them is a dead end. Instead we let TikTok fire its own request
//      on profile load, capture that query string, and reuse it as a template with
//      secUid/count/cursor overridden. Calls are then issued from *inside* the page
//      via fetch(credentials:'include') so they carry the real cookies.
//   4. Cursor semantics DIFFER between endpoints (reposts = integer offset, likes =
//      millisecond timestamp), so we always echo back the server's `cursor` and
//      never compute the next one ourselves.
//
// DOM scraping is kept only as a last-resort fallback and is genuinely bad: the
// Videos grid returned 0 anchors on every account tested even after 15s of
// scrolling — it never hydrates headless. The repost grid does render, so the
// fallback can rescue reposts mode and nothing else.
//
// The spec's "scroll to lazy-load, cap ~60 videos or 15s" requirement is superseded
// by cursor pagination, which is strictly faster and does not depend on grid markup
// rendering at all. The cap and the time budget are preserved — they are applied to
// the pagination loop instead of to a scroll loop (see LIMITS).

import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ===========================================================================
// TIKTOK CONTRACT — LAST VERIFIED: 2026-08-01
// Everything below this line is what breaks when TikTok ships a change.
// ===========================================================================

export const ROUTES = {
  // Origin every API call is issued against.
  ORIGIN: 'https://www.tiktok.com',

  // Profile page. Loading this is what makes TikTok fire the template request.
  profile: (handle) => `https://www.tiktok.com/@${handle}`,

  // VERIFIED 2026-08-01: the only two live item-list endpoints for this use case.
  REPOSTS: '/api/repost/item_list/',
  LIKES: '/api/favorite/item_list/',

  // VERIFIED 2026-08-01: these plausible-looking likes routes are all DEAD —
  // they return {"status_msg":"url doesn't match"}. Kept here so nobody re-tries them.
  DEAD_LIKES_ROUTES: ['/api/user/liked/', '/api/user/favorite/', '/api/liked/item_list/'],

  // Which self-fired requests we are willing to harvest device params from.
  // Preference order matters: repost fires on plain profile load for public accounts.
  // /api/post/item_list/ is an acceptable donor because the device/app params are
  // identical across item_list endpoints — only secUid/count/cursor differ.
  TEMPLATE_DONORS: [/\/api\/repost\/item_list\//, /\/api\/post\/item_list\//, /\/api\/favorite\/item_list\//],
};

export const SELECTORS = {
  // VERIFIED 2026-08-01: hydration blob. SIGI_STATE is gone; this is the replacement.
  HYDRATION_SCRIPT_ID: '__UNIVERSAL_DATA_FOR_REHYDRATION__',
  HYDRATION_SCOPE: '__DEFAULT_SCOPE__',
  HYDRATION_USER_DETAIL_KEY: 'webapp.user-detail',
  // Path within the blob, applied as: blob[SCOPE][USER_DETAIL_KEY].userInfo
  //   .user.secUid          -> required query param for both endpoints
  //   .user.openFavorite    -> boolean, THE likes-are-public signal
  //   .user.privateAccount  -> boolean
  //   .stats.diggCount / .stats.videoCount

  // Last-resort DOM fallback (reposts only — see file header for why it is bad).
  VIDEO_ANCHOR: 'a[href*="/video/"]',
  VIDEO_ID_FROM_HREF: /\/video\/(\d{6,})/,

  // Interstitials that mean TikTok noticed us.
  // VERIFIED 2026-08-01: TikTok PRE-RENDERS empty captcha mount points on a normal,
  // un-challenged profile load, so mere presence in the DOM means nothing — an
  // earlier version of this check used `[id*="captcha"]` and produced false
  // `blocked` results on profiles that scraped perfectly well. The element must be
  // VISIBLE (non-zero box) to count as a real challenge. See isCaptchaVisible().
  CAPTCHA: '#captcha-verify-image, .captcha_verify_container, .captcha-disable-scroll',
};

export const RESPONSE_FIELDS = {
  ITEM_LIST: 'itemList',
  CURSOR: 'cursor',
  HAS_MORE: 'hasMore',
  STATUS_CODE: 'statusCode',
  ITEM_ID: 'id',
  // VERIFIED 2026-08-01: body returned by a dead/renamed route.
  DEAD_ROUTE_MSG: 'url doesn\'t match',
};

// ===========================================================================
// END TIKTOK CONTRACT
// ===========================================================================

const LIMITS = {
  MAX_VIDEOS: 60, // spec cap (~60 videos)
  PAGINATION_BUDGET_MS: 15_000, // spec cap (15s) — applied to pagination, not scrolling
  PAGE_SIZE: 30, // what TikTok's own client asks for
  MAX_PAGES: 10, // belt-and-braces against a hasMore that never goes false
  INTER_PAGE_DELAY_MS: 400,
  PROFILE_GOTO_TIMEOUT_MS: 40_000,
  HYDRATION_SETTLE_MS: 5_000, // blob + template request both land well inside this
  TEMPLATE_WAIT_MS: 8_000,
  // 1.5-3s randomised gap between profile loads, per spec.
  MIN_GAP_MS: 1_500,
  MAX_GAP_MS: 3_000,
};

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Persistent profile lives inside .cache/ so it is covered by the single .gitignore entry.
const USER_DATA_DIR = path.join(HERE, '.cache', 'browser-profile');

/** Structured error codes. Never leak a stack trace to the client. */
export const ERRORS = {
  LIKES_PRIVATE: 'likes_private',
  NO_VIDEOS: 'no_videos',
  PROFILE_NOT_FOUND: 'profile_not_found',
  REPOSTS_UNSUPPORTED: 'reposts_unsupported',
  BLOCKED: 'blocked',
  TIMEOUT: 'timeout',
};

/**
 * `code` is what goes over the wire. `reason` is a human note about WHICH branch
 * produced it — logged locally only, never serialised into a response. Several
 * different situations collapse to `blocked`, and without this you cannot tell a
 * captcha from a navigation failure from a 429 when debugging.
 */
class ScrapeError extends Error {
  constructor(code, reason) {
    super(reason ? `${code} (${reason})` : code);
    this.code = code;
    this.reason = reason || code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomGap = () => LIMITS.MIN_GAP_MS + Math.random() * (LIMITS.MAX_GAP_MS - LIMITS.MIN_GAP_MS);

// ---------------------------------------------------------------------------
// Browser lifecycle — ONE persistent context, cold-started once, reused forever.
// Cookies and the warm profile survive across requests, which measurably reduces
// how often TikTok challenges us.
// ---------------------------------------------------------------------------

let contextPromise = null;
let contextReady = false;

export function browserState() {
  return contextReady ? 'ready' : 'cold';
}

export async function getContext() {
  if (!contextPromise) {
    contextPromise = chromium
      .launchPersistentContext(USER_DATA_DIR, {
        headless: true,
        userAgent: USER_AGENT,
        viewport: { width: 1280, height: 900 },
        locale: 'en-US',
        args: ['--disable-blink-features=AutomationControlled'],
      })
      .then((ctx) => {
        contextReady = true;
        ctx.on('close', () => {
          contextReady = false;
          contextPromise = null;
        });
        return ctx;
      })
      .catch((err) => {
        contextPromise = null;
        throw err;
      });
  }
  return contextPromise;
}

export async function warmup() {
  await getContext();
}

export async function closeBrowser() {
  if (!contextPromise) return;
  const ctx = await contextPromise.catch(() => null);
  contextReady = false;
  contextPromise = null;
  if (ctx) await ctx.close().catch(() => {});
}

// Enforced 1.5-3s randomised delay between profile loads (process-wide).
let lastProfileLoadAt = 0;
async function throttleProfileLoad() {
  const wait = lastProfileLoadAt + randomGap() - Date.now();
  if (wait > 0) await sleep(wait);
  lastProfileLoadAt = Date.now();
}

// ---------------------------------------------------------------------------
// Step 1 — load the profile, read the hydration blob, harvest a param template.
// ---------------------------------------------------------------------------

/**
 * True challenge detection. Returns a describing string when a captcha is actually
 * being shown, or null otherwise.
 *
 * Presence in the DOM is NOT sufficient — TikTok ships empty captcha containers on
 * ordinary loads. Only a rendered element with a non-zero box is a real block.
 */
async function isCaptchaVisible(page) {
  return page
    .evaluate((sel) => {
      for (const el of document.querySelectorAll(sel)) {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        if (r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none') {
          return `${el.tagName.toLowerCase()}#${el.id || ''}.${el.className || ''}`.slice(0, 80);
        }
      }
      return null;
    }, SELECTORS.CAPTCHA)
    .catch(() => null);
}

async function openProfile(ctx, handle) {
  const page = await ctx.newPage();

  // Harvest the query string of TikTok's OWN item_list request. This is the only
  // practical way to get the ~42 device/app params (msToken, X-Bogus, device_id...).
  const donors = new Map();
  page.on('request', (req) => {
    const url = req.url();
    for (const re of ROUTES.TEMPLATE_DONORS) {
      if (re.test(url) && !donors.has(re.source)) {
        const qs = url.split('?')[1];
        if (qs) donors.set(re.source, Object.fromEntries(new URLSearchParams(qs).entries()));
      }
    }
  });

  await throttleProfileLoad();

  let httpStatus = null;
  try {
    const resp = await page.goto(ROUTES.profile(handle), {
      waitUntil: 'domcontentloaded',
      timeout: LIMITS.PROFILE_GOTO_TIMEOUT_MS,
    });
    httpStatus = resp?.status() ?? null;
  } catch (err) {
    await page.close().catch(() => {});
    if (/timeout/i.test(err?.message || '')) throw new ScrapeError(ERRORS.TIMEOUT, 'goto timed out');
    throw new ScrapeError(ERRORS.BLOCKED, `goto failed: ${String(err?.message || err).slice(0, 120)}`);
  }

  if (httpStatus === 404) {
    await page.close().catch(() => {});
    throw new ScrapeError(ERRORS.PROFILE_NOT_FOUND, 'http 404');
  }
  if (httpStatus === 403 || httpStatus === 429) {
    await page.close().catch(() => {});
    throw new ScrapeError(ERRORS.BLOCKED, `http ${httpStatus}`);
  }

  await page.waitForTimeout(LIMITS.HYDRATION_SETTLE_MS);

  const captcha = await isCaptchaVisible(page);
  if (captcha) {
    await page.close().catch(() => {});
    throw new ScrapeError(ERRORS.BLOCKED, `captcha visible: ${captcha}`);
  }

  const info = await page
    .evaluate(
      ({ scriptId, scope, key }) => {
        const el = document.getElementById(scriptId);
        if (!el) return { blob: false };
        let data;
        try {
          data = JSON.parse(el.textContent);
        } catch {
          return { blob: false };
        }
        const ui = data?.[scope]?.[key]?.userInfo;
        if (!ui?.user) return { blob: true, userDetail: false };
        return {
          blob: true,
          userDetail: true,
          secUid: ui.user.secUid,
          openFavorite: ui.user.openFavorite,
          privateAccount: ui.user.privateAccount,
          diggCount: ui.stats?.diggCount,
          videoCount: ui.stats?.videoCount,
        };
      },
      {
        scriptId: SELECTORS.HYDRATION_SCRIPT_ID,
        scope: SELECTORS.HYDRATION_SCOPE,
        key: SELECTORS.HYDRATION_USER_DETAIL_KEY,
      }
    )
    .catch(() => ({ blob: false }));

  // No blob, or a blob with no user-detail scope => the handle does not resolve.
  if (!info.blob || !info.userDetail || !info.secUid) {
    await page.close().catch(() => {});
    throw new ScrapeError(
      ERRORS.PROFILE_NOT_FOUND,
      `hydration blob=${info.blob} userDetail=${info.userDetail} secUid=${Boolean(info.secUid)}`
    );
  }

  // VERIFIED 2026-08-01: a private account exposes nothing at all — only
  // /api/user/list/ fires and no item list is reachable. Documented mapping:
  // privateAccount === true -> profile_not_found (the profile exists but is, for
  // this game's purposes, indistinguishable from absent).
  if (info.privateAccount === true) {
    await page.close().catch(() => {});
    throw new ScrapeError(ERRORS.PROFILE_NOT_FOUND, 'privateAccount=true');
  }

  // Give the donor request a moment longer if it has not fired yet.
  const deadline = Date.now() + LIMITS.TEMPLATE_WAIT_MS;
  while (donors.size === 0 && Date.now() < deadline) await page.waitForTimeout(250);

  let template = null;
  for (const re of ROUTES.TEMPLATE_DONORS) {
    if (donors.has(re.source)) {
      template = donors.get(re.source);
      break;
    }
  }

  return { page, info, template };
}

// ---------------------------------------------------------------------------
// Step 2 — paginate an item_list endpoint from inside the page.
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{ids: string[], deadRoute: boolean, pages: object[]}>}
 */
async function paginate(page, route, template, secUid) {
  return page.evaluate(
    async ({ origin, route, template, secUid, limits, fields }) => {
      const ids = [];
      const pages = [];
      let cursor = '0';
      let deadRoute = false;
      const started = Date.now();

      for (let i = 0; i < limits.MAX_PAGES; i++) {
        if (Date.now() - started > limits.PAGINATION_BUDGET_MS) break;

        const qs = new URLSearchParams({
          ...(template || {}),
          secUid,
          count: String(limits.PAGE_SIZE),
          cursor: String(cursor),
        });

        let body = null;
        let raw = '';
        try {
          const res = await fetch(`${origin}${route}?${qs}`, { credentials: 'include' });
          raw = await res.text();
          body = JSON.parse(raw);
        } catch {
          // Unparseable body: either the route was renamed or we got an HTML block page.
          if (raw.includes(fields.DEAD_ROUTE_MSG)) deadRoute = true;
          break;
        }

        // A renamed/removed route answers with {"status_msg":"url doesn't match"}.
        if (body && body.status_msg === fields.DEAD_ROUTE_MSG) {
          deadRoute = true;
          break;
        }

        const items = body?.[fields.ITEM_LIST] || [];
        for (const it of items) {
          const id = it?.[fields.ITEM_ID];
          if (id && !ids.includes(id)) ids.push(id);
        }

        pages.push({
          page: i,
          got: items.length,
          cursor,
          nextCursor: body?.[fields.CURSOR],
          hasMore: body?.[fields.HAS_MORE],
          statusCode: body?.[fields.STATUS_CODE],
        });

        if (ids.length >= limits.MAX_VIDEOS) break;
        if (!body?.[fields.HAS_MORE] || items.length === 0) break;

        // CRITICAL: echo the server's cursor verbatim. reposts = integer offset,
        // likes = millisecond timestamp. Computing it ourselves breaks likes.
        cursor = String(body[fields.CURSOR]);

        await new Promise((r) => setTimeout(r, limits.INTER_PAGE_DELAY_MS));
      }

      return { ids: ids.slice(0, limits.MAX_VIDEOS), deadRoute, pages };
    },
    { origin: ROUTES.ORIGIN, route, template, secUid, limits: LIMITS, fields: RESPONSE_FIELDS }
  );
}

/**
 * Last-resort fallback. Only useful for reposts — the Videos/Liked grids never
 * hydrate in headless Chromium (0 anchors after 15s of scrolling on every account
 * tested). Do not add scrolling here expecting it to help; it does not.
 */
async function domFallback(page) {
  return page
    .evaluate(
      ({ sel, reSrc }) => {
        const re = new RegExp(reSrc);
        const out = [];
        for (const a of document.querySelectorAll(sel)) {
          const m = (a.getAttribute('href') || '').match(re);
          if (m && !out.includes(m[1])) out.push(m[1]);
        }
        return out;
      },
      { sel: SELECTORS.VIDEO_ANCHOR, reSrc: SELECTORS.VIDEO_ID_FROM_HREF.source }
    )
    .catch(() => []);
}

// ---------------------------------------------------------------------------
// Step 3 — mode handlers.
// ---------------------------------------------------------------------------

async function collectReposts(page, info, template) {
  if (!template) {
    // Could not harvest device params; try the one grid that does render.
    const dom = await domFallback(page);
    if (dom.length) return dom.slice(0, LIMITS.MAX_VIDEOS);
    throw new ScrapeError(ERRORS.REPOSTS_UNSUPPORTED);
  }

  const { ids, deadRoute } = await paginate(page, ROUTES.REPOSTS, template, info.secUid);

  // The repost route itself is gone / renamed -> the feature is unsupported, which is
  // a different problem from "this user has no reposts".
  if (deadRoute) throw new ScrapeError(ERRORS.REPOSTS_UNSUPPORTED);

  if (ids.length === 0) {
    const dom = await domFallback(page);
    if (dom.length) return dom.slice(0, LIMITS.MAX_VIDEOS);
  }
  return ids;
}

async function collectLikes(page, info, template) {
  // NON-NEGOTIABLE: check openFavorite BEFORE calling the endpoint.
  // VERIFIED 2026-08-01: with private likes the endpoint returns HTTP 200,
  // statusCode 0, hasMore true and an EMPTY itemList — byte-identical to a user
  // who simply has no likes. There is no error to catch downstream, so this flag
  // is the only way to tell "private" from "empty".
  if (info.openFavorite === false) throw new ScrapeError(ERRORS.LIKES_PRIVATE);

  if (!template) throw new ScrapeError(ERRORS.NO_VIDEOS);

  const { ids } = await paginate(page, ROUTES.LIKES, template, info.secUid);
  return ids;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Resolve a handle + mode into TikTok video ids.
 * Always resolves — never throws — to `{ok:true, videos}` or `{ok:false, error}`.
 *
 * @param {{handle: string, mode: 'likes'|'reposts'|'both'}} opts
 */
export async function scrape({ handle, mode }) {
  let page = null;
  try {
    const ctx = await getContext();
    const opened = await openProfile(ctx, handle);
    page = opened.page;
    const { info, template } = opened;

    let videos;
    if (mode === 'reposts') {
      videos = await collectReposts(page, info, template);
    } else if (mode === 'likes') {
      videos = await collectLikes(page, info, template);
    } else {
      // mode 'both' = union, deduped. A failure in ONE half is tolerated as long as
      // the other half yields something — a player with public reposts and private
      // likes (by far the most common combination) should still get a playable round
      // rather than an error.
      //
      // Run the halves SEQUENTIALLY, not with Promise.all: they share one page and
      // firing both pagination loops at once doubles the instantaneous request rate
      // against TikTok, which is exactly what the delays elsewhere exist to avoid.
      const reposts = await collectReposts(page, info, template).catch((e) => e);
      const likes = await collectLikes(page, info, template).catch((e) => e);
      const results = [reposts, likes];
      const ok = results.filter((r) => Array.isArray(r));
      if (ok.length === 0) {
        // Both halves failed. Surface the more informative of the two codes.
        const codes = results.map((r) => r?.code).filter(Boolean);
        throw new ScrapeError(codes.find((c) => c !== ERRORS.NO_VIDEOS) || codes[0] || ERRORS.NO_VIDEOS);
      }
      videos = [...new Set([...(Array.isArray(reposts) ? reposts : []), ...(Array.isArray(likes) ? likes : [])])].slice(
        0,
        LIMITS.MAX_VIDEOS
      );
    }

    if (!videos || videos.length === 0) throw new ScrapeError(ERRORS.NO_VIDEOS);
    return { ok: true, videos };
  } catch (err) {
    if (err instanceof ScrapeError) {
      // Reason is for the operator's console only; the wire gets just the code.
      if (err.reason !== err.code) console.log(`[scrape]   reason: ${err.reason}`);
      return { ok: false, error: err.code };
    }
    const msg = String(err?.message || err);
    if (/timeout/i.test(msg)) return { ok: false, error: ERRORS.TIMEOUT };
    // Log internally, return a code. Never a stack trace over the wire.
    console.error('[scrape] unexpected failure:', msg);
    return { ok: false, error: ERRORS.BLOCKED };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}
