// host.html controller. The host client is the ONLY writer of room state.
//
// Holds no game logic — round generation, scoring and leaderboard maths all live in
// game.js. This file is wiring: DOM, the scraper HTTP calls, and driving the round
// state machine.

import { authReady } from './firebase.js';
import * as db from './db.js';
import { generateRounds, scoreRound, voteProgress, leaderboard } from './game.js';
import { watchUrl } from './video-link.js';
import { renderQR } from './qr.js';

const SCRAPER = 'http://localhost:8787';

/**
 * Where players actually join.
 *
 * When the host runs locally the browser URL is http://localhost:8787/host.html, which
 * is useless to a phone — localhost on a phone is the phone. So when this page is served
 * from loopback we advertise the public deployment instead. If the host page is itself
 * on a public origin, same-origin play.html is correct and is used.
 *
 * Change this if you fork the repo to your own GitHub Pages address.
 */
const PUBLIC_PLAY_URL = 'https://vlad94568.github.io/Guess-The-Tiktok/play.html';
const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname);
const playerJoinUrl = () =>
  isLoopback ? PUBLIC_PLAY_URL : location.href.replace(/host\.html.*$/, 'play.html');
const $ = (id) => document.getElementById(id);
const views = ['lobby', 'loading', 'playing', 'reveal', 'finished'];

const S = {
  uid: null,
  code: null,
  meta: null,
  players: {},
  offset: 0, // server clock - local clock, ms
  round: null, // index
  roundPlan: null, // { videoId, ownerUid } for the current round
  votes: {},
  phase: null,
  advancing: false, // re-entrancy guard around the lock/score/reveal transition
  unsubRound: [],
};

// ===========================================================================
// view switching
// ===========================================================================
function show(name) {
  for (const v of views) $(`view-${v}`).classList.toggle('hidden', v !== name);
}
function fatal(msg) {
  const el = $('fatal');
  el.textContent = msg;
  el.classList.remove('hidden');
}

// Last-resort net. Without this, anything thrown outside a try/catch just leaves the
// screen blank and the host has nothing to report but "it didn't load".
window.addEventListener('error', (e) => fatal(`Something broke: ${e.message}`));
window.addEventListener('unhandledrejection', (e) =>
  fatal(`Something broke: ${e.reason?.message || e.reason}`)
);

// ===========================================================================
// scraper client
// ===========================================================================

/** Human sentences for the structured codes the scraper returns. */
const ERROR_TEXT = {
  likes_private: ['Liked videos are private', 'They can switch mode to Reposts, or make Liked videos public in TikTok settings.'],
  no_videos: ['No usable videos', 'This account has no reposts. They can still vote.'],
  profile_not_found: ['Account not found or private', 'Check the spelling of their @handle.'],
  reposts_unsupported: ['Reposts could not be read', 'TikTok may have changed. Try Likes mode.'],
  blocked: ['TikTok blocked the request', 'Wait a minute and try again — too many requests too fast.'],
  timeout: ['Timed out', 'Check the internet connection and try again.'],
  scrape_failed: ['Lookup failed', 'Try starting the game again.'],
  unreachable: ['Helper not reachable', 'Re-run START HERE - Host a game.cmd.'],
};
const errorText = (code) => (ERROR_TEXT[code] || [`Error: ${code}`, ''])[0];
const errorHint = (code) => (ERROR_TEXT[code] || ['', ''])[1];

async function scraperHealth() {
  try {
    const r = await fetch(`${SCRAPER}/health`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { ok: false };
    return await r.json();
  } catch {
    return { ok: false };
  }
}

async function scrape(handle, mode) {
  try {
    const r = await fetch(`${SCRAPER}/scrape`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, mode }),
      signal: AbortSignal.timeout(120000),
    });
    if (!r.ok) return { ok: false, error: 'scrape_failed' };
    return await r.json();
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

let healthOk = false;
async function pollHealth() {
  const h = await scraperHealth();
  healthOk = !!h.ok;
  const el = $('scraper-health');
  el.innerHTML = healthOk
    ? `<span class="ok">✓ Ready</span> <span class="muted">${
        h.browser === 'ready' ? '' : '— warming up, you can still start'
      }</span>`
    : `<span class="bad">✕ Local helper not running.</span> ` +
      `<span class="muted">Close this tab and double-click “START HERE - Host a game.cmd”. ` +
      `If you opened this page in Safari, use Chrome or Edge instead.</span>`;
  refreshStartButton();
}

// ===========================================================================
// lobby
// ===========================================================================

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I/O, they look like 1/0
const randomCode = () =>
  Array.from({ length: 4 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');

async function createRoom() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const roundCount = Number($('round-count').value);

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    if (await db.getMeta(code)) continue; // collision, try again
    await db.createRoom(code, S.uid, { mode, roundCount });
    return code;
  }
  throw new Error('Could not allocate a free room code.');
}

/** Mode/round-count edits in the lobby rewrite meta, so the players see them too. */
async function pushSettings() {
  if (!S.code || S.meta?.status !== 'lobby') return;
  await db.createRoom(S.code, S.uid, {
    mode: document.querySelector('input[name="mode"]:checked').value,
    roundCount: Number($('round-count').value),
  });
}

function renderLobby() {
  const entries = Object.entries(S.players);
  $('player-count').textContent = entries.length;
  $('lobby-players').innerHTML =
    entries
      .map(([, p]) => `<li><span>${esc(p.name)}</span><span class="muted">@${esc(p.handle)}</span></li>`)
      .join('') || '<li class="muted">Waiting for people to join…</li>';
  refreshStartButton();
}

function refreshStartButton() {
  const n = Object.keys(S.players).length;
  const ready = n >= 2 && healthOk;
  const btn = $('btn-start');
  if (!btn) return;
  btn.disabled = !ready;
  $('start-hint').textContent = !healthOk
    ? 'Waiting for the local helper.'
    : n < 2
    ? `Need at least 2 players — ${n} so far.`
    : `Ready with ${n} players.`;
}

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ===========================================================================
// pool building
// ===========================================================================

async function buildPools() {
  await db.setStatus(S.code, 'loading');
  const entries = Object.entries(S.players);

  // Mark everyone pending so the loading screen has rows immediately.
  for (const [uid] of entries) await db.setPlayerPoolStatus(S.code, uid, { poolStatus: 'pending' });

  // Sequential on purpose — never in parallel, rate limiting matters.
  for (const [uid, p] of entries) {
    const res = await scrape(p.handle, S.meta.mode);
    if (res.ok && res.videos?.length) {
      await db.writePool(S.code, uid, res.videos);
      await db.setPlayerPoolStatus(S.code, uid, { poolStatus: 'ok', poolCount: res.videos.length });
    } else {
      await db.setPlayerPoolStatus(S.code, uid, {
        poolStatus: 'error',
        poolError: res.error || 'no_videos',
        poolCount: 0,
      });
    }
  }

  const pools = await db.readPools(S.code);
  const plan = generateRounds({ pools, roundCount: S.meta.roundCount });

  if (plan.available === 0) {
    fatal('No usable videos for anybody — cannot start. Check the per-player errors above.');
    await db.setStatus(S.code, 'lobby');
    return;
  }
  if (plan.clamped)
    $('loading-note').innerHTML =
      `<div class="notice notice-warn host-big">${esc(plan.message)}</div>`;

  await db.writePlan(S.code, plan.rounds);
  await db.setCurrentRound(S.code, 0);
  await db.setStatus(S.code, 'playing');
  await beginRound(0);
}

function renderLoading() {
  $('loading-players').innerHTML = Object.entries(S.players)
    .map(([, p]) => {
      const s = p.poolStatus || 'pending';
      const who = `<span>${esc(p.name)} <span class="muted">@${esc(p.handle)}</span></span>`;
      if (s === 'ok') return `<li>${who}<span class="ok">✓ ${p.poolCount} videos</span></li>`;
      if (s === 'error')
        return (
          `<li><span>${esc(p.name)} <span class="muted">@${esc(p.handle)}</span>` +
          `<br><span class="muted small">${esc(errorHint(p.poolError))}</span></span>` +
          `<span class="bad">${esc(errorText(p.poolError))}</span></li>`
        );
      return `<li>${who}<span class="muted">looking…</span></li>`;
    })
    .join('');
}

// ===========================================================================
// round state machine
// ===========================================================================

async function beginRound(i) {
  S.advancing = false;
  const plan = await db.getRound(S.code, i);
  if (!plan) return fatal(`Round ${i} is missing from the plan.`);
  S.round = i;
  S.roundPlan = plan;
  await db.startRound(S.code, i, { ownerUid: plan.ownerUid });
}

/** Attach watchers for round i. Called whenever currentRound changes. */
function watchRound(i) {
  for (const u of S.unsubRound) u();
  S.unsubRound = [
    db.watchRoundPhase(S.code, i, (phase) => {
      S.phase = phase;
      render();
    }),
    db.watchVotes(S.code, i, (v) => {
      S.votes = v;
      render();
      maybeLock();
    }),
  ];
}

/** Lock as soon as every eligible player has voted. */
function maybeLock() {
  if (S.phase !== 'playing' || !S.roundPlan) return;
  const prog = voteProgress(Object.keys(S.players), S.roundPlan.ownerUid, S.votes);
  // eligible can be empty if the owner is somehow the only player left; game.js reports
  // that as allVoted, which would instantly skip the round. Let the timer handle it.
  if (prog.eligible.length > 0 && prog.allVoted) lockAndReveal();
}

async function lockAndReveal() {
  if (S.advancing) return; // guard against the votes watcher firing twice
  S.advancing = true;
  await db.setRoundPhase(S.code, S.round, 'locked');

  // claimScoring is an atomic transaction that succeeds exactly once per round across
  // every host tab and reconnect, so points cannot be awarded twice.
  if (await db.claimScoring(S.code, S.round)) {
    const votes = await db.getVotes(S.code, S.round);
    const { correct } = scoreRound(votes, S.roundPlan.ownerUid);
    for (const uid of correct) await db.incrementScore(S.code, uid);
  }
  await db.setRoundPhase(S.code, S.round, 'reveal');
}

async function nextRound() {
  const next = S.round + 1;
  if (next >= S.meta.roundCount || !(await db.getRound(S.code, next))) {
    await db.setStatus(S.code, 'finished');
    return;
  }
  await db.setCurrentRound(S.code, next);
  await beginRound(next);
}

// ===========================================================================
// rendering
// ===========================================================================

function render() {
  if (!S.meta) return;
  const st = S.meta.status;

  if (st === 'lobby') {
    show('lobby');
    renderLobby();
    return;
  }
  if (st === 'loading') {
    show('loading');
    renderLoading();
    return;
  }
  if (st === 'finished') {
    show('finished');
    renderFinished();
    return;
  }

  // playing
  if (S.phase === 'reveal') {
    show('reveal');
    renderReveal();
  } else {
    show('playing');
    renderPlaying();
  }
}

function renderPlaying() {
  $('round-num').textContent = S.round + 1;
  $('round-total').textContent = S.meta.roundCount;
  // Host screen only — this URL carries the videoId.
  if (S.roundPlan) $('watch-link').href = watchUrl(S.roundPlan.videoId);

  const prog = voteProgress(Object.keys(S.players), S.roundPlan?.ownerUid, S.votes);
  $('voted-count').textContent = prog.voted.length;
  $('voted-total').textContent = prog.eligible.length;
  // Shows WHO has voted, never WHAT they voted.
  $('voted-names').textContent = prog.voted.length
    ? 'Voted: ' + prog.voted.map((u) => S.players[u]?.name).filter(Boolean).join(', ')
    : '';
  // With no countdown, the host needs to see exactly who the round is waiting on.
  $('pending-names').innerHTML =
    prog.pending.map((u) => `<li>${esc(S.players[u]?.name)}</li>`).join('') ||
    '<li class="ok">Everyone has voted</li>';
}

function renderReveal() {
  const ownerUid = S.roundPlan?.ownerUid;
  $('reveal-round-num').textContent = S.round + 1;
  $('reveal-round-total').textContent = S.meta.roundCount;
  $('reveal-owner').textContent = S.players[ownerUid]?.name ?? '???';
  if (S.roundPlan) $('reveal-watch-link').href = watchUrl(S.roundPlan.videoId);

  $('reveal-votes').innerHTML =
    Object.entries(S.votes)
      .map(([voter, guess]) => {
        const ok = guess === ownerUid;
        return (
          `<li><span>${esc(S.players[voter]?.name)} said <strong>${esc(S.players[guess]?.name)}</strong></span>` +
          (ok ? '<span class="ok">✓ +1</span>' : '<span class="bad">✗</span>') +
          `</li>`
        );
      })
      .join('') || '<li class="muted">Nobody voted.</li>';

  $('reveal-board').innerHTML = boardHtml();
}

const boardHtml = () =>
  leaderboard(S.players)
    .map(
      (r) =>
        `<li><span><span class="rank">${r.rank}</span>${esc(r.name)}</span>` +
        `<span class="score-pill">${r.score}</span></li>`
    )
    .join('');

function renderFinished() {
  const board = leaderboard(S.players);
  const winners = board.filter((r) => r.rank === 1);
  $('winner').textContent = winners.length > 1
    ? `Tie: ${winners.map((w) => w.name).join(' & ')}`
    : `${winners[0]?.name ?? '—'} wins`;
  $('final-board').innerHTML = boardHtml();
}

// There is deliberately no countdown. A round ends when every eligible player has
// voted, or when the host presses "Reveal now" — which is the only thing preventing one
// asleep phone from stalling the game forever.

// ===========================================================================
// boot
// ===========================================================================
(async function main() {
  // Every view starts hidden, so ANY unhandled throw in here leaves a completely blank
  // page with no clue what went wrong. Show the lobby shell first and route all errors
  // to the on-screen banner.
  show('lobby');

  try {
    S.uid = await authReady();
  } catch (e) {
    return fatal(e.message);
  }

  db.watchServerOffset((o) => (S.offset = o));

  try {
    S.code = await createRoom();
  } catch (e) {
    const denied = /PERMISSION_DENIED/i.test(e.message || '');
    return fatal(
      denied
        ? 'The database rejected the new room (permission denied). The security rules in ' +
          'Firebase are out of date for this version of the game — open the Firebase console, ' +
          'go to Realtime Database → Rules, paste in database.rules.json from the project ' +
          'folder, and press Publish.'
        : `Could not create a room: ${e.message}`
    );
  }
  $('room-code').textContent = S.code;

  const joinUrl = playerJoinUrl();
  $('join-url').textContent = joinUrl.replace(/^https?:\/\//, '');
  try {
    renderQR($('join-qr'), joinUrl, 300);
  } catch (e) {
    // A missing QR is cosmetic; the URL and code above it still work.
    console.warn('QR render failed:', e.message);
    $('join-qr').closest('.qr-box')?.classList.add('hidden');
  }

  db.watchMeta(S.code, (m) => {
    if (!m) return;
    const first = !S.meta;
    S.meta = m;
    if (first) show('lobby');
    render();
  });

  db.watchPlayers(S.code, (p) => {
    S.players = p;
    render();
  });

  db.watchCurrentRound(S.code, async (i) => {
    if (i === null || i === undefined) return;
    if (S.round !== i || !S.roundPlan) {
      S.round = i;
      S.roundPlan = await db.getRound(S.code, i);
    }
    watchRound(i);
    render();
  });

  for (const el of document.querySelectorAll('input[name="mode"], #round-count'))
    el.addEventListener('change', pushSettings);

  $('btn-start').addEventListener('click', async () => {
    $('btn-start').disabled = true;
    try {
      await buildPools();
    } catch (e) {
      fatal(`Could not build pools: ${e.message}`);
    }
  });

  $('btn-next').addEventListener('click', () => nextRound());
  $('btn-reveal').addEventListener('click', () => lockAndReveal());

  $('btn-newgame').addEventListener('click', async () => {
    // Drop the previous game's round watchers first. They point at paths that
    // resetRoom is about to delete; left attached they fire with null, clobber S.phase,
    // and stack up another set on every replay.
    for (const u of S.unsubRound) u();
    S.unsubRound = [];
    S.round = null;
    S.roundPlan = null;
    S.phase = null;
    S.votes = {};
    S.advancing = false;
    await db.resetRoom(S.code, Object.keys(S.players));
  });

  pollHealth();
  setInterval(pollHealth, 5000);
})();
