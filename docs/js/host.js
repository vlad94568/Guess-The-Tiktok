// host.html controller. The host client is the ONLY writer of room state.
//
// Holds no game logic — round generation, scoring and leaderboard maths all live in
// game.js. This file is wiring: DOM, the scraper HTTP calls, and driving the round
// state machine.

import { authReady } from './firebase.js';
import * as db from './db.js';
import { generateRounds, scoreRound, voteProgress, leaderboard } from './game.js';
import { mountEmbed, unmountEmbed, currentEmbed } from './embed.js';

const SCRAPER = 'http://localhost:8787';
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
  endsAt: 0,
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

// ===========================================================================
// scraper client
// ===========================================================================

/** Human sentences for the structured codes the scraper returns. */
const ERROR_TEXT = {
  likes_private: 'their Liked videos are private',
  no_videos: 'no usable videos found',
  profile_not_found: 'profile not found or private',
  reposts_unsupported: 'reposts could not be read',
  blocked: 'TikTok blocked the request',
  timeout: 'timed out',
  scrape_failed: 'scrape failed',
  unreachable: 'scraper not reachable',
};
const errorText = (code) => ERROR_TEXT[code] || `error: ${code}`;

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
    ? `Scraper: <span class="ok">connected (${h.browser === 'ready' ? 'browser warm' : 'browser cold'})</span>`
    : `Scraper: <span class="bad">unreachable — is it running?</span> ` +
      `<span class="muted">Note: hosting requires Chrome or Edge, not Safari.</span>`;
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
  const timerSecs = Number($('timer-secs').value);

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = randomCode();
    if (await db.getMeta(code)) continue; // collision, try again
    await db.createRoom(code, S.uid, { mode, roundCount, timerSecs });
    return code;
  }
  throw new Error('Could not allocate a free room code.');
}

/** Mode/rounds/timer edits in the lobby rewrite meta, so the players see them too. */
async function pushSettings() {
  if (!S.code || S.meta?.status !== 'lobby') return;
  await db.createRoom(S.code, S.uid, {
    mode: document.querySelector('input[name="mode"]:checked').value,
    roundCount: Number($('round-count').value),
    timerSecs: Number($('timer-secs').value),
  });
}

function renderLobby() {
  const entries = Object.entries(S.players);
  $('player-count').textContent = entries.length;
  $('lobby-players').innerHTML =
    entries.map(([, p]) => `<li>${esc(p.name)} <span class="muted">@${esc(p.handle)}</span></li>`).join('') ||
    '<li class="muted">Nobody yet…</li>';
  refreshStartButton();
}

function refreshStartButton() {
  const n = Object.keys(S.players).length;
  const ready = n >= 2 && healthOk;
  const btn = $('btn-start');
  if (!btn) return;
  btn.disabled = !ready;
  $('start-hint').textContent = !healthOk
    ? 'Start the scraper: cd scraper && npm start'
    : n < 2
    ? 'Need at least 2 players.'
    : '';
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
  if (plan.clamped) $('loading-players').insertAdjacentHTML('beforeend', `<li class="bad">${esc(plan.message)}</li>`);

  await db.writePlan(S.code, plan.rounds);
  await db.setCurrentRound(S.code, 0);
  await db.setStatus(S.code, 'playing');
  await beginRound(0);
}

function renderLoading() {
  $('loading-players').innerHTML = Object.entries(S.players)
    .map(([, p]) => {
      const s = p.poolStatus || 'pending';
      if (s === 'ok') return `<li>${esc(p.name)} <span class="ok">${p.poolCount} videos</span></li>`;
      if (s === 'error') return `<li>${esc(p.name)} <span class="bad">${esc(errorText(p.poolError))}</span></li>`;
      return `<li>${esc(p.name)} <span class="muted">scraping…</span></li>`;
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
  const endsAt = Date.now() + S.offset + S.meta.timerSecs * 1000;
  await db.startRound(S.code, i, { ownerUid: plan.ownerUid, endsAt });
}

/** Attach watchers for round i. Called whenever currentRound changes. */
function watchRound(i) {
  for (const u of S.unsubRound) u();
  S.unsubRound = [
    db.watchRoundPhase(S.code, i, (phase) => {
      S.phase = phase;
      render();
    }),
    db.watchRoundEndsAt(S.code, i, (e) => {
      S.endsAt = e || 0;
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
    unmountEmbed($('embed-slot'));
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
    unmountEmbed($('embed-slot'));
    return;
  }

  // playing
  if (S.phase === 'reveal') {
    show('reveal');
    unmountEmbed($('embed-slot'));
    renderReveal();
  } else {
    show('playing');
    renderPlaying();
  }
}

function renderPlaying() {
  $('round-num').textContent = S.round + 1;
  $('round-total').textContent = S.meta.roundCount;
  if (S.roundPlan && currentEmbed() !== S.roundPlan.videoId) mountEmbed($('embed-slot'), S.roundPlan.videoId);

  const prog = voteProgress(Object.keys(S.players), S.roundPlan?.ownerUid, S.votes);
  $('voted-count').textContent = prog.voted.length;
  $('voted-total').textContent = prog.eligible.length;
  // Shows WHO has voted, never WHAT they voted.
  $('voted-names').textContent = prog.voted.map((u) => S.players[u]?.name).filter(Boolean).join(', ');
}

function renderReveal() {
  const ownerUid = S.roundPlan?.ownerUid;
  $('reveal-round-num').textContent = S.round + 1;
  $('reveal-round-total').textContent = S.meta.roundCount;
  $('reveal-owner').textContent = S.players[ownerUid]?.name ?? '???';

  $('reveal-votes').innerHTML =
    Object.entries(S.votes)
      .map(([voter, guess]) => {
        const ok = guess === ownerUid;
        return `<li>${esc(S.players[voter]?.name)} guessed ${esc(S.players[guess]?.name)} ${
          ok ? '<span class="ok">✓</span>' : '<span class="bad">✗</span>'
        }</li>`;
      })
      .join('') || '<li class="muted">Nobody voted.</li>';

  $('reveal-board').innerHTML = boardHtml();
}

const boardHtml = () =>
  leaderboard(S.players)
    .map((r) => `<li>${r.rank}. ${esc(r.name)} — ${r.score}</li>`)
    .join('');

function renderFinished() {
  const board = leaderboard(S.players);
  const winners = board.filter((r) => r.rank === 1);
  $('winner').textContent = winners.length > 1
    ? `Tie: ${winners.map((w) => w.name).join(' & ')}`
    : `${winners[0]?.name ?? '—'} wins`;
  $('final-board').innerHTML = boardHtml();
}

// ===========================================================================
// countdown — derived from the authoritative endsAt, never counted locally
// ===========================================================================
setInterval(() => {
  if (S.meta?.status !== 'playing' || S.phase !== 'playing') return;
  const left = Math.max(0, Math.ceil((S.endsAt - (Date.now() + S.offset)) / 1000));
  $('countdown').textContent = left;
  if (left === 0) lockAndReveal();
}, 250);

// ===========================================================================
// boot
// ===========================================================================
(async function main() {
  try {
    S.uid = await authReady();
  } catch (e) {
    return fatal(e.message);
  }

  db.watchServerOffset((o) => (S.offset = o));

  S.code = await createRoom();
  $('room-code').textContent = S.code;
  const base = location.href.replace(/host\.html.*$/, 'play.html');
  $('join-url').textContent = base.replace(/^https?:\/\//, '');

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

  for (const el of document.querySelectorAll('input[name="mode"], #round-count, #timer-secs'))
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
