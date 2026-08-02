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
  endsAt: 0,
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
      S.sittingOut = false;
      return render();
    }
    if (S.round !== i) {
      S.round = i;
      S.phase = null;
      S.myVote = null;
      S.ownerUid = null;
      S.sittingOut = false;
      watchRound(i);
    }
    render();
  });
}

function watchRound(i) {
  for (const u of S.unsubRound) u();
  S.unsubRound = [
    db.watchRoundPhase(S.code, i, (p) => {
      S.phase = p;
      render();
    }),
    db.watchRoundEndsAt(S.code, i, (e) => {
      S.endsAt = e || 0;
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
    // Denied by the rules until phase === 'reveal'; the error is expected and ignored.
    db.watchRoundOwner(S.code, i, (o) => {
      S.ownerUid = o;
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
    return;
  }
  if (st === 'finished') {
    show('finished');
    const board = leaderboard(S.players);
    const mine = board.find((r) => r.uid === S.uid);
    $('final-placing').textContent = mine ? `You came ${ordinal(mine.rank)} of ${board.length}.` : '—';
    $('final-score').textContent = mine?.score ?? 0;
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
  if (S.sittingOut) {
    $('reveal-msg').textContent = 'That was yours.';
    return;
  }
  if (!S.myVote) {
    $('reveal-msg').textContent = "You didn't vote in time.";
    return;
  }
  // ownerUid becomes readable exactly when the host flips the phase to reveal.
  const ownerName = S.players[S.ownerUid]?.name;
  if (!ownerName) {
    $('reveal-msg').textContent = '…';
    return;
  }
  $('reveal-msg').textContent = S.myVote === S.ownerUid ? 'Correct! +1' : `Nope — it was ${ownerName}`;
}

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// countdown, derived from the authoritative endsAt (never a local tick count)
setInterval(() => {
  if (S.meta?.status !== 'playing' || S.phase !== 'playing') return;
  $('countdown').textContent = Math.max(0, Math.ceil((S.endsAt - (Date.now() + S.offset)) / 1000));
}, 250);

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
