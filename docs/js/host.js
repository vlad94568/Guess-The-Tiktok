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
import { ping, unlockAudio } from './sound.js';

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
  // How many rounds were ACTUALLY planned. Not the same as meta.roundCount: game.js
  // rounds the request to a multiple of the player count so everybody owns the same
  // number of rounds, so the plan is the only honest total.
  totalRounds: null,
  roundPlan: null, // { videoId, ownerUid } for the current round
  votes: {},
  phase: null,
  // Which round S.phase describes. The phase of the round we have just left is not the
  // phase of the round we are entering, and rendering one as the other is how the reveal
  // screen used to flash the NEXT round's owner. null until the new round's watcher fires.
  phaseRound: null,
  pingedRound: null, // last round whose "everyone voted" chime has played
  advancing: false, // re-entrancy guard around the lock/score/reveal transition
  deleteArmed: false, // is the room set to delete itself when this host disconnects?
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
  // The kick button carries the uid in a data attribute rather than a closure, because
  // this list is re-rendered from scratch on every players event — per-row listeners
  // would be rebound (and leak) each time. One delegated listener handles the lot.
  $('lobby-players').innerHTML =
    entries
      .map(
        ([uid, p]) =>
          `<li><span>${esc(p.name)}</span>` +
          `<span class="lobby-right"><span class="muted">@${esc(p.handle)}</span>` +
          `<button class="btn-kick" data-uid="${esc(uid)}" data-name="${esc(p.name)}" ` +
          `title="Remove ${esc(p.name)} from the room">Kick</button></span></li>`
      )
      .join('') || '<li class="muted">Waiting for people to join…</li>';
  refreshStartButton();
}

/**
 * Remove a player and stop them re-joining.
 *
 * Lobby only. Once the plan is written, every round has an ownerUid baked into it, so
 * kicking mid-game would leave rounds owned by somebody who no longer exists — the reveal
 * would read "???" and the equal-share fairness the plan is built on would be gone. The
 * button is not rendered outside the lobby, and this re-checks rather than trusting that.
 */
async function kickPlayer(uid, name) {
  if (S.meta?.status !== 'lobby') return;
  if (!confirm(`Remove ${name} from the room? They will not be able to re-join this game.`)) return;
  try {
    await db.kickPlayer(S.code, uid);
  } catch (e) {
    fatal(`Could not remove ${name}: ${e.message}`);
  }
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

/** uid -> { reposts, likes } from the scraper. Host screen only. */
const poolBreakdown = {};

async function buildPools() {
  await db.setStatus(S.code, 'loading');
  $('loading-note').innerHTML = ''; // a previous game's notice must not leak into this one
  const entries = Object.entries(S.players);

  // Mark everyone pending so the loading screen has rows immediately.
  for (const [uid] of entries) await db.setPlayerPoolStatus(S.code, uid, { poolStatus: 'pending' });

  // Sequential on purpose — never in parallel, rate limiting matters.
  for (const [uid, p] of entries) {
    const res = await scrape(p.handle, S.meta.mode);
    if (res.ok && res.videos?.length) {
      await db.writePool(S.code, uid, res.videos);
      // Keep the per-source split locally for the loading screen. It is not written to
      // the database: it is host-only diagnostics and players must not see pool details.
      poolBreakdown[uid] = res.sources || null;
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
  // Shown whenever the plan differs from the request in EITHER direction — it can now be
  // longer than asked for (more players than rounds) as well as shorter.
  if (plan.message)
    $('loading-note').innerHTML =
      `<div class="notice notice-warn host-big">${esc(plan.message)}</div>`;

  S.totalRounds = plan.rounds.length;
  await db.writePlan(S.code, plan.rounds);
  await db.setCurrentRound(S.code, 0);
  await db.setStatus(S.code, 'playing');
  await beginRound(0);
}

function renderLoading() {
  $('loading-players').innerHTML = Object.entries(S.players)
    .map(([uid, p]) => {
      const s = p.poolStatus || 'pending';
      const who = `<span>${esc(p.name)} <span class="muted">@${esc(p.handle)}</span></span>`;
      if (s === 'ok') {
        const src = poolBreakdown[uid];
        // Show the split so "both" visibly means both — and so a private-likes account
        // silently contributing only reposts is obvious rather than invisible.
        const detail = src
          ? Object.entries(src)
              .map(([k, v]) => (typeof v === 'number' ? `${v} ${k}` : `${k}: ${errorText(v).toLowerCase()}`))
              .join(' · ')
          : '';
        return (
          `<li><span>${esc(p.name)} <span class="muted">@${esc(p.handle)}</span>` +
          (detail ? `<br><span class="muted small">${esc(detail)}</span>` : '') +
          `</span><span class="ok">✓ ${p.poolCount} videos</span></li>`
        );
      }
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

/**
 * Drop everything that belonged to the round we are leaving.
 *
 * Must happen BEFORE S.roundPlan is repointed at round i. The reveal screen reads the
 * owner out of S.roundPlan and is shown whenever S.phase is 'reveal'; leaving a stale
 * 'reveal' in place while the plan moves on prints the next round's owner on the big
 * screen for a frame, which is the whole answer.
 */
function resetRoundState(i) {
  S.round = i;
  S.roundPlan = null;
  S.phase = null;
  S.phaseRound = null;
  S.pingedRound = null;
  S.votes = {};
  S.advancing = false;
}

async function beginRound(i) {
  if (S.round !== i || S.phaseRound !== i) resetRoundState(i);
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
      S.phaseRound = i;
      render();
    }),
    db.watchVotes(S.code, i, (v) => {
      // A late event from a torn-down round must not repopulate the new round's tally.
      if (S.round !== i) return;
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
  if (prog.eligible.length === 0 || !prog.allVoted) return;

  // Chime once per round, and only for a round that filled up on its own — "Reveal now"
  // needs no announcing, the host just pressed it. Keyed on the round rather than on a
  // flag so a reload cannot replay it, and set BEFORE lockAndReveal so the votes watcher
  // firing again cannot double it.
  if (S.pingedRound !== S.round) {
    S.pingedRound = S.round;
    ping();
  }
  lockAndReveal();
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

/**
 * How many rounds the stored plan actually holds.
 *
 * A host that reloads mid-game has no S.totalRounds, and meta.roundCount is the REQUESTED
 * count, which the equal-share rounding may have moved either way. The plan itself is the
 * only truth, so probe it. Bounded, and only ever runs once per page load.
 */
async function countPlannedRounds() {
  // The plan can be LONGER than meta.roundCount — with more players than requested rounds
  // everyone still gets one each — so the player count has to bound this too, or the
  // probe stops short and the header reads "Round 9 of 6".
  const cap =
    Math.max(
      Number(S.meta?.roundCount) || 0,
      Object.keys(S.players).length,
      (S.round ?? 0) + 1
    ) *
      2 +
    8;
  let n = 0;
  while (n < cap && (await db.getRound(S.code, n))) n++;
  return n;
}

async function nextRound() {
  const next = S.round + 1;
  // The plan, not meta.roundCount, decides when the game is over.
  if (!(await db.getRound(S.code, next))) {
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

  // Whether this room should self-destruct depends only on its status, so re-evaluate it
  // on every event rather than at the handful of places status happens to change.
  syncRoomTeardown();

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

  // playing. The phase only counts if it belongs to the round now on screen — otherwise
  // the moment "Next round" is pressed, the previous round's 'reveal' would be painted
  // over the new round's plan and name its owner.
  if (S.phase === 'reveal' && S.phaseRound === S.round) {
    show('reveal');
    renderReveal();
  } else {
    show('playing');
    renderPlaying();
  }
}

function renderPlaying() {
  $('round-num').textContent = S.round + 1;
  $('round-total').textContent = S.totalRounds ?? S.meta.roundCount;
  // Host screen only — this URL carries the videoId. Blanked while the next round's plan
  // is still loading, so the button cannot open the round that just ended.
  $('watch-link').href = S.roundPlan ? watchUrl(S.roundPlan.videoId) : '#';

  const prog = voteProgress(Object.keys(S.players), S.roundPlan?.ownerUid, S.votes);
  $('voted-count').textContent = prog.voted.length;
  $('voted-total').textContent = prog.eligible.length;
  // Counts, never names — see the comment on this block in host.html. The owner is not
  // eligible to vote, so a named "waiting on" list eventually contains everyone EXCEPT
  // the owner, which is the answer printed on the big screen.
  const left = prog.pending.length;
  $('pending-count').textContent = left
    ? `${left} ${left === 1 ? 'player' : 'players'} still to vote`
    : 'Everyone has voted';
  $('pending-count').classList.toggle('ok', left === 0);
}

function renderReveal() {
  const ownerUid = S.roundPlan?.ownerUid;
  $('reveal-round-num').textContent = S.round + 1;
  $('reveal-round-total').textContent = S.totalRounds ?? S.meta.roundCount;
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

// ===========================================================================
// room teardown
// ===========================================================================

/**
 * Statuses in which the room is disposable — losing the host should take it with them.
 *
 * 'lobby' matters more than it looks: this page mints a room the moment it LOADS, before
 * anyone has joined, so opening the host screen and closing it again is by far the most
 * common way a room gets orphaned.
 *
 * 'loading' and 'playing' are deliberately absent. onDisconnect has no grace period — it
 * fires as soon as Firebase notices the socket is gone and cannot tell a closed tab from
 * a twenty-second wifi drop — so arming it during a game would let a blip delete a live
 * game, scores and all. Those rooms are cleaned up by sweepMyOldRooms() instead.
 */
const DISPOSABLE = new Set(['lobby', 'finished']);

let teardownBusy = false;

/**
 * Point the room's onDisconnect registration at whatever its current status calls for.
 *
 * Called from render(), so it runs on every database event and must be cheap and
 * re-entrant. `S.deleteArmed = null` means "unknown", which forces a re-registration —
 * that is what a reconnect needs, since reconnecting drops every onDisconnect this
 * client had registered.
 */
async function syncRoomTeardown() {
  if (!S.code || teardownBusy) return;
  const want = DISPOSABLE.has(S.meta?.status);
  if (want === S.deleteArmed) return;

  teardownBusy = true;
  try {
    if (want) {
      await db.armRoomDeleteOnDisconnect(S.code);
    } else {
      await db.cancelRoomDeleteOnDisconnect(S.code);
      // NOT optional. cancel() clears queued onDisconnect writes at that location AND
      // everything beneath it, so cancelling at rooms/<code> also drops the
      // meta/hostOnline registration sitting under it. Without this re-claim, a host who
      // dropped mid-game would leave hostOnline stuck at true and no phone would ever
      // learn the host had gone.
      await db.claimHostPresence(S.code);
    }
    S.deleteArmed = want;
  } catch (e) {
    // Housekeeping must never break the game. Worst case the room outlives it, which is
    // the behaviour this whole mechanism replaced.
    console.warn('could not update room cleanup:', e.message);
  } finally {
    teardownBusy = false;
  }
}

// --- rooms this browser created, so it can clean up after itself -----------
const LS_ROOMS = 'wt_host_rooms';

function readMyRooms() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_ROOMS) || '[]');
    return Array.isArray(v) ? v.filter((c) => typeof c === 'string' && /^[A-Z]{4}$/.test(c)) : [];
  } catch {
    return [];
  }
}

function writeMyRooms(codes) {
  // Capped: this list exists only to find rooms to delete, and an unbounded one would
  // mean an unbounded number of reads every time the host page loads.
  try {
    localStorage.setItem(LS_ROOMS, JSON.stringify(codes.slice(-20)));
  } catch {
    // Private browsing / storage disabled. Cleanup degrades, nothing breaks.
  }
}

const rememberMyRoom = (code) => writeMyRooms([...readMyRooms().filter((c) => c !== code), code]);
const forgetMyRooms = (codes) => {
  const drop = new Set(codes);
  writeMyRooms(readMyRooms().filter((c) => !drop.has(c)));
};

/**
 * Delete rooms this browser created and then abandoned mid-game.
 *
 * A room in 'loading' or 'playing' is never armed to self-destruct (see DISPOSABLE), so a
 * host who closes the tab mid-game leaves it behind. Anonymous auth is persistent, so the
 * next time this same browser opens the host page it is still the same uid — and the
 * delete-only rule lets a host remove their own rooms at any age. That makes this the
 * cheapest possible sweeper: no rules relaxation, and it can only ever touch rooms this
 * browser made.
 *
 * Must be started BEFORE the new room is created, so the list it snapshots cannot contain
 * the room this session is about to use.
 */
async function sweepMyOldRooms() {
  const codes = readMyRooms();
  if (!codes.length) return;

  const done = [];
  for (const code of codes) {
    try {
      const meta = await db.getMeta(code);
      if (meta && meta.hostUid !== S.uid) continue; // somebody else's now — leave it alone
      if (meta) await db.deleteRoom(code);
      done.push(code); // deleted, or already gone
    } catch (e) {
      console.warn(`could not clean up room ${code}:`, e.message);
    }
  }
  forgetMyRooms(done);
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

  // Re-arm host presence on every (re)connect. Firebase consumes an onDisconnect
  // registration when it fires, so without this a single dropped connection would leave
  // the room looking alive forever after the host had gone.
  db.watchConnected(async (connected) => {
    if (!connected || !S.code) return;
    try {
      // A reconnect drops every onDisconnect this client had registered. Claim presence
      // again, then let syncRoomTeardown re-register the deletion if this room's status
      // still calls for one. `null` is "unknown", which forces it to act.
      await db.claimHostPresence(S.code);
      S.deleteArmed = null;
      await syncRoomTeardown();
    } catch (e) {
      console.warn('could not claim host presence:', e.message);
    }
  });

  // Started before createRoom so the list it reads cannot contain this session's room.
  // Fire and forget: a slow sweep must not hold up the join code appearing on screen.
  sweepMyOldRooms().catch((e) => console.warn('room cleanup:', e.message));

  try {
    S.code = await createRoom();
    rememberMyRoom(S.code);
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
  await db.claimHostPresence(S.code).catch((e) => console.warn('host presence:', e.message));

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
      // Clear first, repaint, then fetch. Anything that renders during the await must see
      // "new round, nothing known yet" rather than the old phase against the new plan.
      if (S.round !== i) {
        resetRoundState(i); // also sets S.round
        render();
      }
      S.round = i;
      S.roundPlan = await db.getRound(S.code, i);
    }
    // Reload recovery: this page did not build the plan, so it has to measure it.
    if (S.totalRounds === null) S.totalRounds = await countPlannedRounds();
    watchRound(i);
    render();
  });

  for (const el of document.querySelectorAll('input[name="mode"], #round-count'))
    el.addEventListener('change', pushSettings);

  // Delegated: the lobby list is rebuilt on every players event.
  $('lobby-players').addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-kick');
    if (btn) kickPlayer(btn.dataset.uid, btn.dataset.name);
  });

  // Audio can only be started from a real click, and the chime fires later from a
  // database event. Every host button re-arms it, so a tab that was reloaded mid-game
  // is not left silent for the rest of the night.
  for (const id of ['btn-start', 'btn-next', 'btn-reveal'])
    $(id).addEventListener('click', unlockAudio);

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

  $('btn-close-room').addEventListener('click', async () => {
    if (!confirm('Delete this room and everyone\'s data from the database? The game cannot be resumed afterwards.'))
      return;
    $('btn-close-room').disabled = true;
    $('btn-newgame').disabled = true;
    try {
      const code = S.code;
      await db.deleteRoom(code);
      S.code = null; // stop every watcher from trying to re-create anything
      forgetMyRooms([code]); // nothing left for the next visit to sweep
      $('close-room-note').textContent = 'Room deleted. You can close this tab.';
    } catch (e) {
      $('btn-close-room').disabled = false;
      $('btn-newgame').disabled = false;
      $('close-room-note').textContent = `Could not delete the room: ${e.message}`;
    }
  });

  $('btn-newgame').addEventListener('click', async () => {
    // No teardown bookkeeping here: finished and lobby are both disposable, so
    // syncRoomTeardown leaves the registration exactly as it is across the reset.
    // Drop the previous game's round watchers first. They point at paths that
    // resetRoom is about to delete; left attached they fire with null, clobber S.phase,
    // and stack up another set on every replay.
    for (const u of S.unsubRound) u();
    S.unsubRound = [];
    S.round = null;
    S.totalRounds = null;
    S.roundPlan = null;
    S.phase = null;
    S.phaseRound = null;
    S.pingedRound = null;
    S.votes = {};
    S.advancing = false;
    await db.resetRoom(S.code, Object.keys(S.players));
  });

  pollHealth();
  setInterval(pollHealth, 5000);
})();
