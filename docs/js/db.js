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
  banned: (c) => `rooms/${c}/banned`,
  bannedUser: (c, uid) => `rooms/${c}/banned/${uid}`,
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

/**
 * Lobby-only edit of the two settings the host can change after the room exists.
 *
 * MUST be an update(), never createRoom() again. createRoom() is a set() of the whole meta
 * node, so re-running it to change `mode` also DELETED `hostOnline` — leaving every phone
 * unable to tell that the host had gone — and rewrote `createdAt` to now, sliding the 12h
 * window every rule is bounded by. The meta `.validate` requires hasChildren([...]), which
 * an update() satisfies because the rule sees the merged node, not just the patch.
 */
export const updateSettings = (code, { mode, roundCount }) =>
  update(ref(db, P.meta(code)), { mode, roundCount });

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

/**
 * Host-only: wipe the whole room — meta, players, pool, rounds, votes, the lot.
 *
 * The rules permit a write at rooms/$code ONLY when it removes the node (see the
 * `!newData.exists()` clause), so this is the single operation that can clear everything
 * atomically. Every other write still has to satisfy the per-child rules.
 */
export const deleteRoom = (code) => set(ref(db, P.room(code)), null);

/**
 * Ask the SERVER to delete the room if this host disappears.
 *
 * Armed only while the room is disposable (see DISPOSABLE in host.js). Arming it during a
 * game would mean a thirty-second wifi drop deletes everybody's scores — a transient
 * disconnect is what the hostOnline flag is for. Firebase runs this server-side, which is
 * why it survives cases a beforeunload handler never sees.
 *
 * The hostOnline onDisconnect from claimHostPresence is deliberately LEFT IN PLACE
 * alongside this one. Cancelling it would be tidier if the delete always succeeded, but
 * an onDisconnect is authorised when it FIRES, not when it is registered — so if the
 * delete-only rule is not deployed yet, cancelling would leave a room with hostOnline
 * stuck at true and no way for a player's phone to tell the host had gone. Keeping both
 * is safe in either order: if the delete lands first, the hostOnline write is refused
 * (the meta write rule reads hostUid, which no longer exists), so it cannot resurrect a
 * stray node; if hostOnline lands first, the delete removes it a moment later.
 */
export const armRoomDeleteOnDisconnect = (code) => onDisconnect(ref(db, P.room(code))).remove();

/** Undo the above — used when "Play again" brings a finished room back to life. */
export const cancelRoomDeleteOnDisconnect = (code) => onDisconnect(ref(db, P.room(code))).cancel();

/** Host-side reset for "New Game": clears rounds+pool, keeps players, zeroes scores. */
export async function resetRoom(code, playerUids) {
  // meta/plannedRounds describes the plan that is being deleted, so it goes with it —
  // otherwise a host who reloads between the reset and the next Start reads a length for
  // rounds that no longer exist.
  const patch = { rounds: null, pool: null, currentRound: null, 'meta/plannedRounds': null };
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

/**
 * Host-only: remove a player from the room and stop them coming back.
 *
 * The ban is written FIRST and deliberately so. Between removing the player node and
 * writing the ban there is a window in which the kicked phone — which is still on the
 * lobby screen with the code in front of it — could re-join, and the join rules are the
 * only thing that can refuse it. Ban first, remove second, and that window never exists.
 *
 * The ban entry outlives the player node on purpose: it is the record of "not welcome",
 * so it must survive the thing it is about. It costs one boolean and dies with the room.
 *
 * `players/$uid` is a delete-only write for the host (same `!newData.exists()` shape as
 * the room delete), so this cannot be turned into a way to edit somebody's fields.
 */
export async function kickPlayer(code, uid) {
  await set(ref(db, P.bannedUser(code, uid)), true);
  await set(ref(db, P.player(code, uid)), null);
  await set(ref(db, P.poolUser(code, uid)), null); // their scraped ids are no use now
}

export const watchBanned = (code, cb) => sub(P.banned(code), (v) => cb(v || {}));

/** Has this uid been kicked out of this room? Used for a clear message on re-join. */
export const isBanned = async (code, uid) =>
  (await get(ref(db, P.bannedUser(code, uid)))).val() === true;

/**
 * Host-only: add points atomically, so a re-render or reconnect cannot double-count.
 *
 * Takes an amount rather than always adding 1: placement scoring pays by how quickly a
 * correct answer came in, so a round can award 5 to one player and 2 to another.
 */
export const addScore = (code, uid, points) =>
  runTransaction(ref(db, P.playerScore(code, uid)), (cur) => (cur || 0) + points);

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
 *
 * `meta/plannedRounds` is written alongside it and is the ONLY cheap way to learn how long
 * the game is. meta.roundCount is what was REQUESTED, and game.js rounds that to a multiple
 * of the player count in either direction, so it cannot be trusted for "Round 3 of N". The
 * length went in meta rather than being counted because a reloading host otherwise has to
 * probe rounds/0, rounds/1, ... one sequential get() at a time until one comes back empty.
 *
 * Written AFTER the rounds themselves: a reader that sees plannedRounds must find the plan
 * already there, never the other way round.
 *
 * The meta write is deliberately NON-FATAL. `meta/$other: false` means rules that predate
 * this field reject it outright, so a site deployed before the rules are published would
 * fail here and take the whole game start down with it. Losing the field only costs a
 * reloading host one round-probing loop (see resolveTotalRounds in host.js), which is a
 * fallback that has to exist anyway for rooms created before the field did.
 */
export async function writePlan(code, rounds) {
  const obj = {};
  rounds.forEach((r, i) => {
    obj[i] = { videoId: r.videoId, ownerUid: r.ownerUid };
  });
  await set(ref(db, `rooms/${code}/rounds`), obj);
  await update(ref(db, P.meta(code)), { plannedRounds: rounds.length }).catch((e) =>
    console.warn('could not record plannedRounds (old rules deployed?):', e.message)
  );
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

/**
 * Player action. Rules reject: a second vote, a vote outside 'playing', a self-vote,
 * a vote by the round owner, and a vote written into someone else's slot.
 *
 * `at` is what placement scoring ranks on, and it MUST be the server's clock. A phone's
 * clock can be wrong by minutes, and a player editing the payload could simply claim to
 * have answered first. The rules pin it with `newData.val() === now`, the same clause that
 * protects `joinedAt` and `createdAt`, so the value cannot be anything but the moment the
 * write was evaluated on the server.
 *
 * One write, not two. Splitting the guess and the timestamp would let a phone land the
 * guess and drop the timestamp — and leave the round half-voted if it died in between.
 */
export const castVote = (code, i, uid, guessUid) =>
  set(ref(db, P.roundVote(code, i, uid)), { guess: guessUid, at: serverTimestamp() });

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
