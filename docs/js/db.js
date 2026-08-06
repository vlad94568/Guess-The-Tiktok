// The ONLY module that knows Realtime Database path strings.
//
// Every read and write in the game goes through a named function here. host.js and
// play.js must never import anything from firebase-database.js directly — if you find
// yourself needing a new path, add a function here instead.
//
// Subscription functions return an unsubscribe callback.

import {
  ref,
  get,
  set,
  update,
  onValue,
  onDisconnect,
  runTransaction,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-database.js';
import { db } from './firebase.js';

// --- paths (nothing outside this block builds a path string) ---------------
const P = {
  room: (c) => `rooms/${c}`,
  meta: (c) => `rooms/${c}/meta`,
  metaStatus: (c) => `rooms/${c}/meta/status`,
  metaHostOnline: (c) => `rooms/${c}/meta/hostOnline`,
  players: (c) => `rooms/${c}/players`,
  player: (c, uid) => `rooms/${c}/players/${uid}`,
  playerScore: (c, uid) => `rooms/${c}/players/${uid}/score`,
  pool: (c) => `rooms/${c}/pool`,
  poolUser: (c, uid) => `rooms/${c}/pool/${uid}`,
  currentRound: (c) => `rooms/${c}/currentRound`,
  round: (c, i) => `rooms/${c}/rounds/${i}`,
  roundPhase: (c, i) => `rooms/${c}/rounds/${i}/phase`,
  roundVideoId: (c, i) => `rooms/${c}/rounds/${i}/videoId`,
  roundOwner: (c, i) => `rooms/${c}/rounds/${i}/ownerUid`,
  roundScored: (c, i) => `rooms/${c}/rounds/${i}/scored`,
  roundSitOutMe: (c, i, uid) => `rooms/${c}/rounds/${i}/sitOut/${uid}`,
  roundVotes: (c, i) => `rooms/${c}/rounds/${i}/votes`,
  roundVote: (c, i, uid) => `rooms/${c}/rounds/${i}/votes/${uid}`,
};

const sub = (path, cb, onErr) =>
  onValue(ref(db, path), (snap) => cb(snap.val()), (err) => {
    // A permission_denied here is usually correct behaviour (e.g. a player watching
    // ownerUid before reveal), so callers pass onErr only when they care.
    if (onErr) onErr(err);
  });

// ===========================================================================
// CLOCK
// ===========================================================================

/**
 * Firebase's estimate of (server clock - this device's clock) in ms.
 *
 * The countdown that used to need this is gone, but it stays for ordering and
 * diagnostics: anything time-based must be derived from server time, since a phone
 * whose clock is a minute out would otherwise disagree with the rest of the room.
 */
export function watchServerOffset(cb) {
  return onValue(ref(db, '.info/serverTimeOffset'), (s) => cb(s.val() || 0));
}

/** True once this client has an open connection — drives reconnect handling. */
export function watchConnected(cb) {
  return onValue(ref(db, '.info/connected'), (s) => cb(s.val() === true));
}

// ===========================================================================
// ROOM LIFECYCLE
// ===========================================================================

export async function createRoom(code, hostUid, { mode, roundCount }) {
  await set(ref(db, P.meta(code)), {
    code,
    hostUid,
    mode,
    roundCount,
    status: 'lobby',
    createdAt: serverTimestamp(),
  });
}

export const watchMeta = (code, cb) => sub(P.meta(code), cb);
export const getMeta = async (code) => (await get(ref(db, P.meta(code)))).val();

export const setStatus = (code, status) => set(ref(db, P.metaStatus(code)), status);

/**
 * Host-only presence flag.
 *
 * Without this a room outlives its host: closing the host tab leaves the room sitting at
 * status 'lobby' forever, and every phone's saved session rejoins that corpse on refresh
 * with no way out short of clearing site data. Firebase runs the onDisconnect write
 * server-side, so it fires even if the tab is closed, the laptop sleeps, or the network
 * drops — which is exactly the case a beforeunload handler misses.
 *
 * Must be re-armed on every reconnect: an onDisconnect registration is consumed when it
 * fires, so a single drop would otherwise leave the room permanently unguarded.
 */
export async function claimHostPresence(code) {
  const r = ref(db, P.metaHostOnline(code));
  await onDisconnect(r).set(false);
  await set(r, true);
}

export const watchHostOnline = (code, cb) => sub(P.metaHostOnline(code), cb);

/** Host-only: mark the room closed deliberately (e.g. the host clicked away). */
export const releaseHostPresence = (code) => set(ref(db, P.metaHostOnline(code)), false);

/** Host-side reset for "New Game": clears rounds+pool, keeps players, zeroes scores. */
export async function resetRoom(code, playerUids) {
  const patch = { rounds: null, pool: null, currentRound: null };
  await update(ref(db, P.room(code)), patch);
  await Promise.all(playerUids.map((uid) => set(ref(db, P.playerScore(code, uid)), 0)));
  await setStatus(code, 'lobby');
}

// ===========================================================================
// PLAYERS
// ===========================================================================

/**
 * Player self-join. Writes only the fields a player is allowed to write.
 *
 * MUST stay an update(), never a set(). The rules grant .write per FIELD under
 * players/$uid (name, handle, joinedAt) and deliberately not on the node itself —
 * `score` and the pool fields are host-only. update() is evaluated per child path and
 * passes; set() replaces the whole node, needs permission one level up, and is refused.
 */
export async function joinRoom(code, uid, name, handle) {
  await update(ref(db, P.player(code, uid)), {
    name,
    handle,
    joinedAt: serverTimestamp(),
  });
}

export const watchPlayers = (code, cb) => sub(P.players(code), (v) => cb(v || {}));
export const getPlayers = async (code) => (await get(ref(db, P.players(code)))).val() || {};

/** Host-only: per-player scrape outcome, rendered on the loading screen. */
export const setPlayerPoolStatus = (code, uid, { poolStatus, poolError = null, poolCount = 0 }) =>
  update(ref(db, P.player(code, uid)), { poolStatus, poolError, poolCount });

export const setScore = (code, uid, score) => set(ref(db, P.playerScore(code, uid)), score);

/** Host-only: +1 atomically, so a re-render or reconnect cannot double-count. */
export const incrementScore = (code, uid) =>
  runTransaction(ref(db, P.playerScore(code, uid)), (cur) => (cur || 0) + 1);

// ===========================================================================
// POOL
// ===========================================================================

/**
 * Host-only. Writes the scraped video ids for one player.
 *
 * DEBUG SEAM (per spec §12): there is no paste-a-video UI, but you can inject a pool by
 * hand from the host page's console to test without the scraper:
 *
 *   const db = await import('./js/db.js');
 *   await db.writePool('ABCD', '<uid>', ['7301234567890123456', '...']);
 *   await db.setPlayerPoolStatus('ABCD', '<uid>', { poolStatus: 'ok', poolCount: 2 });
 */
export async function writePool(code, uid, videoIds) {
  const obj = {};
  for (const id of videoIds) obj[id] = true;
  await set(ref(db, P.poolUser(code, uid)), obj);
}

/** Host-only. Returns { [uid]: [videoId, ...] } for game.js to build rounds from. */
export async function readPools(code) {
  const raw = (await get(ref(db, P.pool(code)))).val() || {};
  const out = {};
  for (const [uid, ids] of Object.entries(raw)) out[uid] = Object.keys(ids || {});
  return out;
}

// ===========================================================================
// ROUNDS — host writes, players read only the leaves the rules allow
// ===========================================================================

/**
 * Host-only. Persists the entire generated round plan up front.
 *
 * Rounds are written WITHOUT a `phase`, which matters: the rules only expose
 * `ownerUid` when that round's phase is exactly 'reveal', so an unstarted round's
 * answer is unreadable even though it is already in the database. Persisting the plan
 * (rather than keeping it in a host-page variable) is what lets a host that reloads or
 * reconnects mid-game pick up exactly where it left off.
 */
export async function writePlan(code, rounds) {
  const obj = {};
  rounds.forEach((r, i) => {
    obj[i] = { videoId: r.videoId, ownerUid: r.ownerUid };
  });
  await set(ref(db, `rooms/${code}/rounds`), obj);
}

export const getRound = async (code, i) => (await get(ref(db, P.round(code, i)))).val();

/**
 * Host-only. Flips a planned round live.
 *
 * `sitOut` carries a single key — the owner's uid — so that player's phone can learn
 * "this one is yours" WITHOUT anyone being able to enumerate the node and thereby learn
 * the answer (rules restrict sitOut/$uid reads to $uid itself).
 */
export const startRound = (code, i, { ownerUid }) =>
  update(ref(db, P.round(code, i)), {
    phase: 'playing',
    startedAt: serverTimestamp(),
    [`sitOut/${ownerUid}`]: true,
  });

export const setRoundPhase = (code, i, phase) => set(ref(db, P.roundPhase(code, i)), phase);
export const setCurrentRound = (code, i) => set(ref(db, P.currentRound(code)), i);
export const watchCurrentRound = (code, cb) => sub(P.currentRound(code), cb);

// Leaf-level subscriptions: these are the only round fields a player may read.
export const watchRoundPhase = (code, i, cb) => sub(P.roundPhase(code, i), cb);
export const watchAmISittingOut = (code, i, uid, cb) => sub(P.roundSitOutMe(code, i, uid), (v) => cb(v === true));

/** Readable by players only once phase === 'reveal' (enforced in rules). */
export const watchRoundOwner = (code, i, cb) => sub(P.roundOwner(code, i), cb);

/** Host reads live (for the "voted 3/5" counter); players only at reveal. */
export const watchVotes = (code, i, cb) => sub(P.roundVotes(code, i), (v) => cb(v || {}));
export const getVotes = async (code, i) => (await get(ref(db, P.roundVotes(code, i)))).val() || {};

/** A player may read back only their own vote, at any phase. */
export const watchMyVote = (code, i, uid, cb) => sub(P.roundVote(code, i, uid), cb);

/** Player action. Rules reject: a second vote, a vote outside 'playing', a self-vote,
 *  a vote by the round owner, and a vote written into someone else's slot. */
export const castVote = (code, i, uid, guessUid) => set(ref(db, P.roundVote(code, i, uid)), guessUid);

// --- double-scoring guard --------------------------------------------------
/**
 * Host-only. Claims the right to score round `i`, atomically. Returns true exactly once
 * across every host tab/reconnect; subsequent calls return false. Scoring must be gated
 * on this so a host page re-render or a dropped connection cannot award points twice.
 */
export async function claimScoring(code, i) {
  const res = await runTransaction(ref(db, P.roundScored(code, i)), (cur) => (cur ? undefined : true));
  return res.committed && res.snapshot.val() === true;
}
export const wasScored = async (code, i) => (await get(ref(db, P.roundScored(code, i)))).val() === true;
