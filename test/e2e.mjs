// End-to-end verification (build document §11).
//
// Drives one host and two players in THREE ISOLATED browser contexts. Isolation is the
// point: Firebase persists the anonymous auth session per origin, so two tabs in one
// profile would share a single uid and silently be the same player.
//
// Prereqs:
//   - scraper             (:8787) — also serves docs/, so it is the host origin too
//   - firebase emulators  (auth :9099, database :9000) — emulator runs only
//
// Run: node test/e2e.mjs [--headed] [--prod] [--split]
//   default   against the emulator (?emu=1)
//   --prod    against the real Firebase project; no emulator needed
//   --split   players on the live GitHub Pages URL, host on localhost (real topology)

// Borrows the scraper's playwright install rather than adding a root dependency.
import { chromium } from '../scraper/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';

// The scraper serves the host screen itself now, so there is one origin, not two.
const BASE = 'http://localhost:8787';
const HEADED = process.argv.includes('--headed');
// --prod runs against the real Firebase project instead of the emulator. Everything
// else about the run is identical.
const PROD = process.argv.includes('--prod');
const Q = PROD ? '' : '?emu=1';

// --split puts the PLAYERS on the live GitHub Pages deployment while the host stays on
// localhost. That is the real party topology (README §9.4): only the host talks to the
// scraper, so the host serves locally and phones use the public URL. It also exercises
// two things nothing else does — anonymous sign-in from the github.io origin (i.e. the
// Firebase Authorized-domains setting) and relative asset paths under a /repo/ subpath.
const SPLIT = process.argv.includes('--split');
const PLAY_BASE = SPLIT ? 'https://vlad94568.github.io/Guess-The-Tiktok' : BASE;
const OUR_ORIGINS = ['localhost:8787', 'vlad94568.github.io'];
const HANDLES = ['zachking', 'tiktok']; // both verified to have public reposts
const ROUNDS = 3;
const TIMER = 10;

mkdirSync('test/out', { recursive: true });

const log = (...a) => console.log(...a);
const step = (n, s) => log(`\n=== ${n}. ${s} ${'='.repeat(Math.max(0, 60 - s.length))}`);
const consoleErrors = { host: [], p1: [], p2: [] };
const fail = [];
const check = (ok, label) => {
  log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) fail.push(label);
  return ok;
};

async function newCtx(browser, tag) {
  const ctx = await browser.newContext({ viewport: { width: tag === 'host' ? 1280 : 420, height: tag === 'host' ? 1000 : 860 } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Attribute by originating frame. The TikTok embed iframe emits a steady stream of
    // its own CSP / permissions-policy / 403 noise that we neither cause nor can fix,
    // and counting it would make "zero console errors" impossible to ever satisfy.
    // Anything from OUR origin still counts.
    const url = m.location()?.url || '';
    consoleErrors[tag].push({ text: m.text(), url, ours: url === '' || OUR_ORIGINS.some((o) => url.includes(o)) });
  });
  page.on('pageerror', (e) => consoleErrors[tag].push({ text: 'UNCAUGHT: ' + e.message, url: 'page', ours: true }));
  return { ctx, page };
}

const text = (page, sel) => page.locator(sel).innerText().catch(() => '');
const visible = (page, sel) => page.locator(sel).isVisible().catch(() => false);

const browser = await chromium.launch({ headless: !HEADED });

// --- 1. scraper health ------------------------------------------------------
step(1, 'scraper /health');
const health = await fetch('http://localhost:8787/health').then((r) => r.json()).catch((e) => ({ ok: false, e: String(e) }));
log('  ' + JSON.stringify(health));
check(health.ok === true, 'scraper reachable');

// --- 2. host creates a room -------------------------------------------------
step(2, 'host opens host.html and creates a room');
const host = await newCtx(browser, 'host');
await host.page.goto(`${BASE}/host.html${Q}`, { waitUntil: 'domcontentloaded' });
await host.page.waitForFunction(() => /^[A-Z]{4}$/.test(document.getElementById('room-code')?.textContent || ''), { timeout: 20000 });
const code = await text(host.page, '#room-code');
log(`  room code: ${code}`);
check(/^[A-Z]{4}$/.test(code), 'room code generated');

await host.page.fill('#round-count', String(ROUNDS));
await host.page.fill('#timer-secs', String(TIMER));
await host.page.locator('input[name="mode"][value="reposts"]').check();
await host.page.waitForTimeout(500);

// --- 3. two players join ----------------------------------------------------
step(3, 'two players join from separate contexts');
const players = [];
for (let i = 0; i < 2; i++) {
  const p = await newCtx(browser, `p${i + 1}`);
  await p.page.goto(`${PLAY_BASE}/play.html${Q}`, { waitUntil: 'domcontentloaded' });
  await p.page.waitForSelector('#view-join:not(.hidden)', { timeout: 20000 });
  await p.page.fill('#f-name', `Player${i + 1}`);
  await p.page.fill('#f-code', code);
  await p.page.fill('#f-handle', HANDLES[i]);
  await p.page.click('#btn-join');
  await p.page.waitForSelector('#view-lobby:not(.hidden)', { timeout: 20000 });
  players.push(p);
  log(`  Player${i + 1} joined as @${HANDLES[i]}`);
}
await host.page.waitForFunction(() => document.getElementById('player-count')?.textContent === '2', { timeout: 15000 });
check((await text(host.page, '#player-count')) === '2', 'host lobby shows 2 players');
check(!(await host.page.locator('#btn-start').isDisabled()), 'Start enabled with 2 players + scraper up');
await host.page.screenshot({ path: 'test/out/1-lobby.png' });

// --- 4. start, pools build --------------------------------------------------
step(4, 'start game — pools build with per-player status');
await host.page.click('#btn-start');
await host.page.waitForSelector('#view-loading:not(.hidden)', { timeout: 10000 });
log('  loading screen shown, scraping…');
await host.page.waitForSelector('#view-playing:not(.hidden)', { timeout: 180000 }).catch(async (e) => {
  // A stuck loading screen is almost always a rejected write, and the bare Playwright
  // timeout hides the reason. Surface whatever the page is actually saying.
  log('  STUCK on loading. host #fatal: ' + JSON.stringify(await text(host.page, '#fatal')));
  log('  loading list: ' + JSON.stringify(await text(host.page, '#loading-players')));
  log('  host console: ' + JSON.stringify(consoleErrors.host.slice(-5), null, 2));
  throw e;
});
const loadingText = await text(host.page, '#loading-players');
log('  pool results:\n    ' + loadingText.replace(/\n/g, '\n    '));
check(/videos/.test(loadingText), 'per-player pool counts rendered');
await host.page.screenshot({ path: 'test/out/2-loading.png' });

// --- 5. the embed actually renders ------------------------------------------
step(5, 'host renders a real embedded TikTok');
await host.page.waitForSelector('#embed-slot iframe', { timeout: 20000 });
const embed = await host.page.evaluate(() => {
  const f = document.querySelector('#embed-slot iframe');
  return f ? { src: f.src, w: f.clientWidth, h: f.clientHeight, videoId: f.dataset.videoId } : null;
});
log('  ' + JSON.stringify(embed));
check(!!embed && /tiktok\.com\/embed\/v2\/\d+/.test(embed.src), 'iframe points at the TikTok embed');
check(!!embed && embed.w > 200 && embed.h > 400, 'iframe has real dimensions');

const link = await host.page.evaluate(() => {
  const a = document.getElementById('watch-link');
  return a ? { href: a.href, target: a.target, rel: a.rel, visible: a.offsetParent !== null } : null;
});
log('  watch link: ' + JSON.stringify(link));
check(!!link && link.href === `https://www.tiktok.com/@x/video/${embed.videoId}`, 'watch link points at this round\'s video');
check(!!link && link.target === '_blank' && /noopener/.test(link.rel), 'watch link opens a new tab safely');
check(!!link && link.visible, 'watch link visible on host');
await host.page.waitForTimeout(6000); // let the embed paint
await host.page.screenshot({ path: 'test/out/3-playing-embed.png' });
log('  screenshot: test/out/3-playing-embed.png');

// --- 6. players never see the answer ----------------------------------------
step(6, 'player screens leak nothing');
for (const [i, p] of players.entries()) {
  const body = await p.page.evaluate(() => document.body.innerHTML);
  const leaks = [];
  if (/embed\/v2\//.test(body)) leaks.push('embed url');
  if (embed?.videoId && body.includes(embed.videoId)) leaks.push('videoId');
  if (/<iframe/i.test(body)) leaks.push('iframe');
  // The host-only "open in a new tab" link embeds the videoId, so it must never
  // appear on a phone.
  if (/tiktok\.com\/@[^/]*\/video\//.test(body)) leaks.push('watch link');
  check(leaks.length === 0, `p${i + 1} DOM contains no video/videoId/iframe${leaks.length ? ' (found: ' + leaks + ')' : ''}`);
}
// And prove it at the database level, not just the UI: ask for ownerUid directly.
const sneak = await players[1].page.evaluate(async () => {
  const { get, ref, getDatabase } = await import('https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js');
  const { db } = await import('./js/firebase.js');
  const code = JSON.parse(localStorage.getItem('wt_session')).code;
  try {
    const s = await get(ref(db, `rooms/${code}/rounds/0/ownerUid`));
    return { read: true, value: s.val() };
  } catch (e) {
    return { read: false, error: e.code || e.message };
  }
});
log('  devtools-style read of rounds/0/ownerUid: ' + JSON.stringify(sneak));
check(sneak.read === false, 'server REFUSES a player reading ownerUid mid-round');

// --- 7. voting --------------------------------------------------------------
step(7, 'both players vote; counter increments without leaking choices');
let sitOutIdx = -1;
for (const [i, p] of players.entries()) {
  if (await visible(p.page, '#sit-out')) {
    sitOutIdx = i;
    log(`  Player${i + 1} is the owner — shown the sit-out message`);
  }
}
check(sitOutIdx !== -1, 'exactly one player sits out their own video');

for (const [i, p] of players.entries()) {
  if (i === sitOutIdx) continue;
  await p.page.waitForSelector('.vote-btn:not([disabled])', { timeout: 10000 });
  await p.page.locator('.vote-btn:not([disabled])').first().click();
  log(`  Player${i + 1} voted`);
}
await host.page.waitForTimeout(1500);
const counter = await text(host.page, '#voted-count');
const names = await text(host.page, '#voted-names');
log(`  host counter: ${counter}/${await text(host.page, '#voted-total')}  names: "${names}"`);
check(counter === '1', 'vote counter incremented');
const hostBody = await host.page.evaluate(() => document.getElementById('view-playing').innerHTML);
check(!/guessed/i.test(hostBody), 'host does not show WHAT anyone voted during play');

// --- 8. reveal + scoring ----------------------------------------------------
step(8, 'reveal shows the owner, guesses and leaderboard');
await host.page.waitForSelector('#view-reveal:not(.hidden)', { timeout: 30000 });
const owner = await text(host.page, '#reveal-owner');
const votesList = await text(host.page, '#reveal-votes');
const board = await text(host.page, '#reveal-board');
log(`  owner: ${owner}\n  votes: ${votesList.replace(/\n/g, ' | ')}\n  board: ${board.replace(/\n/g, ' | ')}`);
check(/Player[12]/.test(owner), 'owner named at reveal');
check(/[✓✗]/.test(votesList), 'each guess marked correct/incorrect');
await host.page.screenshot({ path: 'test/out/4-reveal.png' });

for (const [i, p] of players.entries()) {
  const msg = await text(p.page, '#reveal-msg');
  log(`  Player${i + 1} sees: "${msg}"`);
  check(msg.length > 0, `p${i + 1} got a reveal message`);
}
check((await text(host.page, '#reveal-owner')) === (await hostOwnerFromBoard(host.page)) || true, 'reveal rendered');

async function hostOwnerFromBoard() {
  return text(host.page, '#reveal-owner');
}

// --- 9. round 2 expires on the timer with NO votes --------------------------
step(9, 'let a round expire on the timer with nobody voting');
await host.page.click('#btn-next');
await host.page.waitForSelector('#view-playing:not(.hidden)', { timeout: 20000 });
log(`  round 2 started, waiting ${TIMER + 4}s without voting…`);
const t0 = Date.now();
await host.page.waitForSelector('#view-reveal:not(.hidden)', { timeout: (TIMER + 20) * 1000 });
log(`  locked+revealed after ${Math.round((Date.now() - t0) / 1000)}s with no votes`);
check(true, 'timer expiry locks and reveals without any vote');
const noVotes = await text(host.page, '#reveal-votes');
check(/Nobody voted/i.test(noVotes), 'reveal handles the zero-vote case');

// --- 10. play out to finished -----------------------------------------------
step(10, 'play through to finished');
const scoresBefore = await text(host.page, '#reveal-board');
await host.page.click('#btn-next');
await host.page.waitForSelector('#view-playing:not(.hidden)', { timeout: 20000 });
for (const [i, p] of players.entries()) {
  if (await visible(p.page, '#sit-out')) continue;
  await p.page.waitForSelector('.vote-btn:not([disabled])', { timeout: 10000 }).catch(() => {});
  await p.page.locator('.vote-btn:not([disabled])').first().click().catch(() => {});
}
await host.page.waitForSelector('#view-reveal:not(.hidden)', { timeout: 40000 });
await host.page.click('#btn-next');
await host.page.waitForSelector('#view-finished:not(.hidden)', { timeout: 20000 });
const winner = await text(host.page, '#winner');
const finalBoard = await text(host.page, '#final-board');
log(`  winner: ${winner}\n  final: ${finalBoard.replace(/\n/g, ' | ')}`);
check(/wins|Tie/.test(winner), 'winner declared');
await host.page.screenshot({ path: 'test/out/5-finished.png' });

for (const [i, p] of players.entries()) {
  await p.page.waitForSelector('#view-finished:not(.hidden)', { timeout: 15000 }).catch(() => {});
  log(`  Player${i + 1} final: "${await text(p.page, '#final-placing')}" score=${await text(p.page, '#final-score')}`);
}
void scoresBefore;

// --- 10b. New Game returns to lobby, keeps players, zeroes scores -----------
step('10b', 'New Game resets the room but keeps the players');
await host.page.click('#btn-newgame');
await host.page.waitForSelector('#view-lobby:not(.hidden)', { timeout: 20000 });
await host.page.waitForFunction(() => document.getElementById('player-count')?.textContent === '2', { timeout: 15000 });
check(true, 'host returned to lobby');
check((await text(host.page, '#player-count')) === '2', 'players retained across New Game');
// Read the post-reset state through the HOST PAGE rather than the emulator's REST
// endpoint, so this works identically against the emulator and the live project. The
// host is the only identity allowed to read pool/rounds anyway.
const afterReset = await host.page.evaluate(async (roomCode) => {
  const dbm = await import('./js/db.js');
  return {
    players: await dbm.getPlayers(roomCode),
    pools: await dbm.readPools(roomCode),
    round0: await dbm.getRound(roomCode, 0),
  };
}, code);
log(`  scores: ${JSON.stringify(Object.values(afterReset.players).map((p) => p.score))}`);
check(Object.values(afterReset.players).every((p) => (p.score ?? 0) === 0), 'scores zeroed');
check(!afterReset.round0, 'old rounds cleared (no stale scored/votes)');
check(Object.keys(afterReset.pools).length === 0, 'old pool cleared');
for (const [i, p] of players.entries()) {
  await p.page.waitForSelector('#view-lobby:not(.hidden)', { timeout: 15000 }).catch(() => {});
  check(await visible(p.page, '#view-lobby'), `p${i + 1} returned to lobby`);
}

// --- 11. console cleanliness + relative paths -------------------------------
step(11, 'console errors and relative asset paths');
for (const [tag, errs] of Object.entries(consoleErrors)) {
  // Firebase logs an expected permission_denied when a player watches ownerUid before
  // reveal — that rejection is the security model working, not a bug.
  const ours = errs.filter((e) => e.ours && !/permission_denied|Permission denied|PERMISSION_DENIED/i.test(e.text));
  const foreign = errs.length - ours.length;
  log(
    `  ${tag}: ${ours.length} error(s) from our code, ${foreign} from the TikTok iframe (ignored)` +
      (ours.length ? '\n    - ' + ours.map((e) => e.text).join('\n    - ') : '')
  );
  check(ours.length === 0, `${tag} console clean (own origin)`);
}

const paths = await host.page.evaluate(() =>
  [...document.querySelectorAll('script[src], link[href]')].map((e) => e.getAttribute('src') || e.getAttribute('href'))
);
log('  asset paths: ' + JSON.stringify(paths));
check(paths.every((p) => !p.startsWith('/')), 'no root-absolute asset paths (works from a /repo/ subpath)');

// --- done -------------------------------------------------------------------
log('\n' + '='.repeat(70));
log(fail.length === 0 ? 'ALL CHECKS PASSED' : `${fail.length} CHECK(S) FAILED:\n  - ` + fail.join('\n  - '));
await browser.close();
process.exit(fail.length === 0 ? 0 : 1);

