// play.html controller — the phone.
//
// This screen must never render the video, the videoId, or anyone's pool. It cannot:
// the security rules deny a player read access to `pool` and to `rounds/$i/videoId`
// entirely, and to `rounds/$i/ownerUid` until the phase is 'reveal'. This file only has
// to avoid *asking* for things it will not get.
//
// Holds no game logic — leaderboard maths comes from game.js.

import { authReady } from './firebase.js';
import * as db from './db.js';
import { leaderboard } from './game.js';

const $ = (id) => document.getElementById(id);
const views = ['join', 'lobby', 'playing', 'reveal', 'finished'];
const LS_KEY = 'wt_session';

const S = {
  uid: null,
  code: null,
  meta: null,
  players: {},
  offset: 0,
  round: null,
  phase: null,
  sittingOut: false,
  myVote: null,
  ownerUid: null, // only ever populated at reveal
  unsubRound: [],
};

function show(name) {
  for (const v of views) $(`view-${v}`).classList.toggle('hidden', v !== name);
}
function fatal(msg) {
  const el = $('fatal');
  el.textContent = msg;
  el.classList.remove('hidden');
}
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ===========================================================================
// join
// ===========================================================================

async function doJoin(code, name, handle) {
  const meta = await db.getMeta(code);
  if (!meta) throw new Error(`No room "${code}". Check the code on the big screen.`);
  if (meta.status !== 'lobby') throw new Error('That game has already started.');
  await db.joinRoom(code, S.uid, name, handle.replace(/^@/, ''));
  localStorage.setItem(LS_KEY, JSON.stringify({ code, name, handle }));
  S.code = code;
  attachRoom(code);
}

// ===========================================================================
// room subscriptions
// ===========================================================================

function attachRoom(code) {
  db.watchMeta(code, (m) => {
    if (!m) return fatal('The host closed this room.');
    S.meta = m;
    render();
  });
  db.watchPlayers(code, (p) => {
    S.players = p;
    render();
  });
  db.watchCurrentRound(code, (i) => {
    if (i === null || i === undefined) {
      // The host reset the room for a new game. Tear the old round's watchers down —
      // their paths no longer exist and they would otherwise accumulate per game.
      for (const u of S.unsubRound) u();
      S.unsubRound = [];
      S.round = null;
      S.phase = null;
      S.myVote = null;
      S.ownerUid = null;
      detachOwner();
      S.sittingOut = false;
      return render();
    }
    if (S.round !== i) {
      S.round = i;
      S.phase = null;
      S.myVote = null;
      S.ownerUid = null;
      detachOwner();
      S.sittingOut = false;
      watchRound(i);
    }
    render();
  });
}

/** Separate from S.unsubRound: attached later than the rest, see below. */
let unsubOwner = null;

function detachOwner() {
  if (unsubOwner) unsubOwner();
  unsubOwner = null;
}

function watchRound(i) {
  for (const u of S.unsubRound) u();
  detachOwner();
  S.unsubRound = [
    db.watchRoundPhase(S.code, i, (p) => {
      S.phase = p;
      // ownerUid is the answer, and the rules refuse to serve it until phase ===
      // 'reveal'. Firebase rejects such a listener ONCE and never retries it, so
      // attaching it at round start (while the phase is still 'playing') leaves a dead
      // subscription and the player never learns who it was — the reveal screen just
      // shows "…". It must be attached AFTER the phase flips.
      if (p === 'reveal' && !unsubOwner) {
        unsubOwner = db.watchRoundOwner(S.code, i, (o) => {
          S.ownerUid = o;
          render();
        });
      }
      render();
    }),
    // Reads rounds/$i/sitOut/<my uid> only. The parent is unreadable, so this tells me
    // whether *I* am the owner without revealing who the owner is if I am not.
    db.watchAmISittingOut(S.code, i, S.uid, (v) => {
      S.sittingOut = v;
      render();
    }),
    db.watchMyVote(S.code, i, S.uid, (v) => {
      S.myVote = v;
      render();
    }),
  ];
}

async function vote(guessUid) {
  try {
    await db.castVote(S.code, S.round, S.uid, guessUid);
  } catch (e) {
    // Rules reject a late vote, a second vote, or a vote by the owner.
    console.warn('vote rejected:', e.message);
  }
}

// ===========================================================================
// render
// ===========================================================================

function render() {
  if (!S.meta) return;
  const st = S.meta.status;
  const me = S.players[S.uid];

  if (st === 'lobby') {
    show('lobby');
    $('lobby-name').textContent = me?.name ?? '';
    $('lobby-handle').textContent = '@' + (me?.handle ?? '');
    return;
  }
  if (st === 'loading') {
    show('lobby');
    $('lobby-name').textContent = me?.name ?? '';
    $('lobby-handle').textContent = '@' + (me?.handle ?? '');
    $('lobby-note').textContent = 'Fetching everyone’s videos — this takes a few seconds each.';
    return;
  }
  if (st === 'finished') {
    show('finished');
    const board = leaderboard(S.players);
    const mine = board.find((r) => r.uid === S.uid);
    $('final-placing').textContent = mine
      ? mine.rank === 1
        ? board.filter((r) => r.rank === 1).length > 1
          ? 'Joint winner 🏆'
          : 'You won 🏆'
        : `${ordinal(mine.rank)} of ${board.length}`
      : '—';
    $('final-score').textContent = mine?.score ?? 0;
    $('final-board').innerHTML = board
      .map(
        (r) =>
          `<li class="${r.uid === S.uid ? 'me' : ''}"><span class="rank">${r.rank}</span>` +
          `<span class="who">${esc(r.name)}</span><span class="score-pill">${r.score}</span></li>`
      )
      .join('');
    return;
  }

  if (S.phase === 'reveal') {
    show('reveal');
    renderReveal(me);
    return;
  }
  show('playing');
  renderPlaying(me);
}

function renderPlaying(me) {
  $('round-num').textContent = (S.round ?? 0) + 1;
  $('score').textContent = me?.score ?? 0;

  $('sit-out').classList.toggle('hidden', !S.sittingOut);
  $('vote-area').classList.toggle('hidden', S.sittingOut);
  if (S.sittingOut) return;
  $('vote-hint').textContent = S.myVote
    ? 'Locked in. Watch the big screen.'
    : "Tap a name. You can't change it.";

  const others = Object.entries(S.players).filter(([uid]) => uid !== S.uid);
  const box = $('vote-buttons');

  // Rebuild only when the roster changes, so taps aren't lost to a re-render.
  const sig = others.map(([uid]) => uid).join(',') + '|' + (S.myVote ?? '');
  if (box.dataset.sig !== sig) {
    box.dataset.sig = sig;
    box.innerHTML = others
      .map(
        ([uid, p]) =>
          `<button class="vote-btn${S.myVote === uid ? ' chosen' : ''}" data-uid="${esc(uid)}"${
            S.myVote ? ' disabled' : ''
          }>${esc(p.name)}</button>`
      )
      .join('');
    for (const b of box.querySelectorAll('.vote-btn'))
      b.addEventListener('click', () => vote(b.dataset.uid));
  }
}

function renderReveal(me) {
  $('reveal-score').textContent = me?.score ?? 0;
  $('reveal-round-num').textContent = (S.round ?? 0) + 1;

  const box = $('verdict');
  const set = (cls, big, sub) => {
    box.className = `verdict ${cls}`;
    $('reveal-msg').textContent = big;
    $('reveal-sub').textContent = sub;
  };

  // ownerUid only becomes readable when the host flips the phase to reveal, so this
  // can render once before the value has arrived.
  const ownerName = S.players[S.ownerUid]?.name;

  if (S.sittingOut) return set('neutral', 'That one was yours', 'No points either way.');
  if (!ownerName) return set('neutral', 'Revealing…', '');
  if (!S.myVote) return set('wrong', "Too slow", `It was ${ownerName}.`);
  if (S.myVote === S.ownerUid) return set('correct', 'Correct! +1', `It was ${ownerName}.`);
  set('wrong', 'Nope', `It was ${ownerName}, not ${S.players[S.myVote]?.name ?? '???'}.`);
}

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// No countdown: rounds end when everyone has voted, or when the host reveals manually.

// ===========================================================================
// boot
// ===========================================================================
(async function main() {
  try {
    S.uid = await authReady();
  } catch (e) {
    show('join');
    return fatal(e.message);
  }

  db.watchServerOffset((o) => (S.offset = o));

  // Rejoin after a refresh or the phone locking, rather than creating a ghost player.
  // The anonymous uid is stable across reloads, so re-joining lands on the same node.
  const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
  if (saved?.code) {
    const meta = await db.getMeta(saved.code);
    const players = meta ? await db.getPlayers(saved.code) : {};
    if (meta && players[S.uid]) {
      S.code = saved.code;
      attachRoom(saved.code);
      return;
    }
    localStorage.removeItem(LS_KEY);
  }

  show('join');
  if (saved) {
    $('f-name').value = saved.name ?? '';
    $('f-handle').value = saved.handle ?? '';
  }

  $('btn-join').addEventListener('click', async () => {
    const name = $('f-name').value.trim();
    const code = $('f-code').value.trim().toUpperCase();
    const handle = $('f-handle').value.trim();
    const err = $('join-error');
    err.classList.add('hidden');
    if (!name || !code || !handle) {
      err.textContent = 'Fill in all three fields.';
      return err.classList.remove('hidden');
    }
    $('btn-join').disabled = true;
    try {
      await doJoin(code, name, handle);
    } catch (e) {
      err.textContent = e.message;
      err.classList.remove('hidden');
    } finally {
      $('btn-join').disabled = false;
    }
  });

  $('btn-leave').addEventListener('click', () => {
    localStorage.removeItem(LS_KEY);
    location.reload();
  });
})();
