// Whose TikTok? — local scraper service.
//
//   GET  /health                 -> { ok, browser: "ready"|"cold" }
//   POST /scrape                 -> { ok, handle, mode, videos, cached } | { ok:false, error }
//   POST /scrape?fresh=1         -> bypass the disk cache
//
// Runs on http://localhost:8787. One scrape at a time (see QUEUE).

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrape, browserState, warmup, closeBrowser, ERRORS } from './tiktok.mjs';
import { readCache, writeCache, sweepCache } from './cache.mjs';

const PORT = Number(process.env.PORT || 8787);

// The host screen is served from this same process, so the host needs ONE thing
// running and no second static server. It also makes the host page same-origin with
// the scraper, so its /scrape call involves no CORS and no Private Network Access
// preflight at all. Players still load the site from GitHub Pages; that path is what
// the CORS allowlist below is for.
const DOCS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');

// ---------------------------------------------------------------------------
// CORS — allowlist only. NEVER '*'.
// ---------------------------------------------------------------------------
//
// The deployed host UI lives on GitHub Pages, so ONE public HTTPS origin has to be able
// to reach this loopback server. Exactly one — never a pattern.
//
// This used to fall back to /^https:\/\/[a-z0-9-]+\.github\.io$/ when GH_PAGES_ORIGIN was
// unset, which is not an allowlist in any useful sense: github.io hands a subdomain to
// anybody, so ANY page on ANY github.io site could POST /scrape while the helper was
// running and read an arbitrary TikTok account's likes through the host's logged-in
// browser profile. The launcher has always set GH_PAGES_ORIGIN, so the hole only opened
// when the server was started by hand — which is exactly how it gets started while
// developing, with the same cookie jar.
//
// The default is now the deployment this repo actually ships with, matching the hardcoded
// PUBLIC_PLAY_URL in docs/js/host.js. Forks override it with the env var (see README) or
// edit this constant; either way it is a single origin, so there is no permissive mode to
// fall into by forgetting something.
const DEFAULT_PAGES_ORIGIN = 'https://vlad94568.github.io';
const GH_PAGES_ORIGIN = process.env.GH_PAGES_ORIGIN || DEFAULT_PAGES_ORIGIN;

// Local dev origins. The host screen is served by this process, so in the normal setup
// these are the only ones used at all.
const LOCAL_ORIGIN_PATTERNS = [
  /^http:\/\/localhost(:\d+)?$/, // http://localhost:*
  /^http:\/\/127\.0\.0\.1(:\d+)?$/, // loopback by ip, same thing
];

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (origin === GH_PAGES_ORIGIN) return true;
  return LOCAL_ORIGIN_PATTERNS.some((re) => re.test(origin));
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  if (req.method === 'OPTIONS') {
    // MUST be present on every preflight. Chrome's Private Network Access blocks a
    // public HTTPS origin (github.io) from reaching loopback without it, and the
    // failure surfaces in the browser as an opaque network error with no useful
    // console message — so it is set unconditionally, even for origins we reject,
    // to keep that from being the thing anyone has to debug.
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    return res.sendStatus(isAllowedOrigin(origin) ? 204 : 403);
  }
  next();
});

// ---------------------------------------------------------------------------
// QUEUE — one scrape at a time.
// Concurrent Playwright profile loads are the fastest way to get rate-limited, and
// the throttle in tiktok.mjs assumes serial access. Requests chain onto a single
// promise; each waits its turn rather than being rejected.
// ---------------------------------------------------------------------------
let queueTail = Promise.resolve();
let queueDepth = 0;

function enqueue(job) {
  queueDepth++;
  const run = queueTail.then(job, job);
  queueTail = run.then(
    () => {},
    () => {}
  );
  return run.finally(() => {
    queueDepth--;
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({ ok: true, browser: browserState() });
});

const VALID_MODES = new Set(['likes', 'reposts', 'both']);
const HANDLE_RE = /^[A-Za-z0-9._]{1,24}$/;

app.post('/scrape', async (req, res) => {
  const rawHandle = String(req.body?.handle ?? '').trim().replace(/^@/, '');
  const mode = String(req.body?.mode ?? '').trim();
  const fresh = req.query.fresh === '1';

  // Bad input is still a structured 200 — the host UI has exactly one rendering path
  // for failures and a 400 with a different shape would fall through it.
  if (!HANDLE_RE.test(rawHandle)) {
    return res.json({ ok: false, error: ERRORS.PROFILE_NOT_FOUND });
  }
  if (!VALID_MODES.has(mode)) {
    return res.json({ ok: false, error: ERRORS.NO_VIDEOS });
  }

  const handle = rawHandle.toLowerCase();

  if (!fresh) {
    const hit = await readCache(handle, mode);
    if (hit) {
      console.log(`[scrape] ${handle}:${mode} -> CACHE HIT (${hit.videos.length} videos)`);
      return res.json({ ok: true, handle, mode, videos: hit.videos, sources: hit.sources || null, cached: true });
    }
  }

  try {
    const started = Date.now();
    const result = await enqueue(() => scrape({ handle, mode }));
    const secs = ((Date.now() - started) / 1000).toFixed(1);

    if (!result.ok) {
      console.log(`[scrape] ${handle}:${mode} -> ${result.error} (${secs}s)`);
      return res.json({ ok: false, error: result.error });
    }

    await writeCache(handle, mode, result.videos, result.sources);
    const breakdown = result.sources
      ? ' [' + Object.entries(result.sources).map(([k, v]) => `${k}=${v}`).join(' ') + ']'
      : '';
    console.log(`[scrape] ${handle}:${mode} -> ${result.videos.length} videos${breakdown} (${secs}s)`);
    return res.json({ ok: true, handle, mode, videos: result.videos, sources: result.sources, cached: false });
  } catch (err) {
    // Last line of defence: a structured code, never a 500 and never a stack trace.
    console.error('[scrape] queue failure:', String(err?.message || err));
    return res.json({ ok: false, error: ERRORS.BLOCKED });
  }
});

// Static site, mounted AFTER the API routes so it can never shadow them. Serves exact
// paths only — no clean-URL rewriting — which is what GitHub Pages does, so the local
// host screen and the deployed player screen behave identically.
app.use(express.static(DOCS_DIR, { extensions: false, redirect: false }));

// Any unhandled error anywhere still comes back as a code.
app.use((err, req, res, _next) => {
  console.error('[server] unhandled:', String(err?.message || err));
  res.json({ ok: false, error: ERRORS.BLOCKED });
});

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`[server] whose-tiktok listening on http://localhost:${PORT}`);
  console.log(`[server] host screen: http://localhost:${PORT}/host.html`);
  console.log(`[server] cors: localhost:* + ${GH_PAGES_ORIGIN}`);
  // Bin any scrape results that can no longer be served. They hold player handles and
  // video ids, so there is no reason to keep them sitting on disk between games.
  sweepCache()
    .then((n) => n && console.log(`[server] cache: removed ${n} stale entr${n === 1 ? 'y' : 'ies'}`))
    .catch(() => {});
  // Cold-start the browser once, in the background, so the first real scrape is not
  // paying for the launch. /health reports "cold" until this resolves.
  warmup()
    .then(() => console.log('[server] browser ready'))
    .catch((e) => console.error('[server] browser warmup failed:', String(e?.message || e)));
});

async function shutdown() {
  console.log('\n[server] shutting down');
  server.close();
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
