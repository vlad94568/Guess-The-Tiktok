// Security-rules verification (build document §5).
//
// These run against the Realtime Database emulator and exercise database.rules.json as
// deployed — not a re-implementation of it. Start the emulator first:
//
//   npx firebase-tools emulators:start --project whose-tiktok-dev --only auth,database
//   node --test "test/rules.test.mjs"
//
// The two attacks the spec demands be proven impossible are tagged ATTACK 1 and
// ATTACK 2. The rest guard the other ways a player could cheat.
//
// NOTE ON THE NAMESPACE: the emulator applies database.rules.json ONLY to the
// "<project>-default-rtdb" namespace. Point at any other namespace and you get wide-open
// rules and a suite that passes while proving nothing.

import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const BASE = 'http://127.0.0.1:9000';
const AUTH = 'http://127.0.0.1:9099';
const NS = 'whose-tiktok-dev-default-rtdb';
const PROJECT = 'whose-tiktok-dev';

const CODE = 'TEST';

// Real uids and ID tokens, minted by the Auth emulator in before(). These are NOT
// hand-rolled: a self-made unsigned JWT is not recognised as a user credential and the
// database emulator falls back to treating the caller as an admin, which makes every
// negative test pass vacuously. Use tokens the auth emulator actually issued.
let HOST, P1, P2; // P1 owns round 0; P2 is the attacker
const token = {}; // uid -> idToken

async function signUpAnonymous() {
  const res = await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake-api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!res.ok) throw new Error(`auth emulator signUp failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  token[j.localId] = j.idToken;
  return j.localId;
}

const url = (path) => `${BASE}/${path}.json?ns=${NS}`;

/**
 * Admin calls use `Authorization: Bearer owner`; user calls use `?auth=<idToken>`.
 *
 * That asymmetry is essential and easy to get wrong. The emulator's REST API treats ANY
 * `Authorization: Bearer <token>` — including a real user's ID token — as an admin
 * credential and skips rule evaluation entirely. Passing the same token as the `?auth=`
 * query parameter instead makes it evaluate the rules as that user. Send a user token in
 * the header and every negative test below silently passes while proving nothing.
 */
const call = async (path, { as, method = 'GET', body } = {}) => {
  const isAdmin = as === 'admin';
  if (!isAdmin && !token[as]) throw new Error(`no token for ${as}`);
  const target = isAdmin ? url(path) : `${url(path)}&auth=${encodeURIComponent(token[as])}`;
  const res = await fetch(target, {
    method,
    headers: isAdmin ? { Authorization: 'Bearer owner' } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
};

const asAdmin = (path, method, body) => call(path, { as: 'admin', method, body });
const read = (path, uid) => call(path, { as: uid });
const write = (path, uid, body) => call(path, { as: uid, method: 'PUT', body });

const DENIED = (r) => r.status === 401 || /Permission denied/.test(r.text);
const OK = (r) => r.status === 200;

// --- fixture ---------------------------------------------------------------
// A room mid-round: round 0 is 'playing', P1 owns the video, nobody has voted.
async function seed({ phase = 'playing', status = 'playing' } = {}) {
  await asAdmin(`rooms/${CODE}`, 'PUT', {
    meta: {
      code: CODE,
      hostUid: HOST,
      mode: 'reposts',
      roundCount: 3,
      status,
      createdAt: Date.now(),
    },
    players: {
      [P1]: { name: 'One', handle: 'one', score: 0, joinedAt: Date.now() },
      [P2]: { name: 'Two', handle: 'two', score: 0, joinedAt: Date.now() },
    },
    pool: { [P1]: { 7301234567890123456: true }, [P2]: { 7309999999999999999: true } },
    currentRound: 0,
    rounds: {
      0: {
        videoId: '7301234567890123456',
        ownerUid: P1,
        phase,
        startedAt: Date.now(),
        sitOut: { [P1]: true },
      },
    },
  });
}

before(async () => {
  const res = await fetch(`${BASE}/.json?ns=${NS}`, { headers: { Authorization: 'Bearer owner' } }).catch(
    () => null
  );
  if (!res) throw new Error('Emulator not reachable on :9000 — start it first (see header comment).');

  [HOST, P1, P2] = await Promise.all([signUpAnonymous(), signUpAnonymous(), signUpAnonymous()]);

  // Sanity-check the harness itself: if this token were being read as an admin
  // credential, every negative assertion below would pass without proving anything.
  const probe = await call('', { as: P2 });
  assert.ok(
    probe.status === 401 || /Permission denied/.test(probe.text),
    `HARNESS BROKEN: P2 can read the database root (${probe.status}). The token is being treated as admin.`
  );
});

beforeEach(async () => {
  await asAdmin(`rooms/${CODE}`, 'DELETE');
  await seed();
});

// ===========================================================================
// THE TWO ATTACKS THE SPEC REQUIRES
// ===========================================================================

test('ATTACK 1: a non-host player CANNOT read ownerUid mid-round', async () => {
  const r = await read(`rooms/${CODE}/rounds/0/ownerUid`, P2);
  assert.ok(DENIED(r), `expected denial, got ${r.status} ${r.text}`);

  // ...and cannot get at it by reading the round, the rounds list, or the whole room.
  for (const path of [`rooms/${CODE}/rounds/0`, `rooms/${CODE}/rounds`, `rooms/${CODE}`, '']) {
    const g = await read(path, P2);
    assert.ok(DENIED(g), `leak via "${path}": ${g.status} ${g.text}`);
  }
});

test('ATTACK 2: a player CANNOT write another player\'s vote', async () => {
  const r = await write(`rooms/${CODE}/rounds/0/votes/${P1}`, P2, P2);
  assert.ok(DENIED(r), `expected denial, got ${r.status} ${r.text}`);

  // and the votes node did not change
  const votes = await read(`rooms/${CODE}/rounds/0/votes`, 'admin');
  assert.equal((await asAdmin(`rooms/${CODE}/rounds/0/votes`)).text, 'null');
  void votes;
});

// ===========================================================================
// ownerUid becomes readable at reveal, and only then
// ===========================================================================

test('ownerUid IS readable once phase === reveal', async () => {
  await asAdmin(`rooms/${CODE}/rounds/0/phase`, 'PUT', 'reveal');
  const r = await read(`rooms/${CODE}/rounds/0/ownerUid`, P2);
  assert.ok(OK(r), `expected success, got ${r.status} ${r.text}`);
  assert.equal(JSON.parse(r.text), P1);
});

test('ownerUid stays hidden while phase === locked', async () => {
  await asAdmin(`rooms/${CODE}/rounds/0/phase`, 'PUT', 'locked');
  assert.ok(DENIED(await read(`rooms/${CODE}/rounds/0/ownerUid`, P2)));
});

// ===========================================================================
// voting
// ===========================================================================

test('a player CAN cast their own vote while playing', async () => {
  const r = await write(`rooms/${CODE}/rounds/0/votes/${P2}`, P2, P1);
  assert.ok(OK(r), `${r.status} ${r.text}`);
});

test('a player cannot vote twice', async () => {
  assert.ok(OK(await write(`rooms/${CODE}/rounds/0/votes/${P2}`, P2, P1)));
  const second = await write(`rooms/${CODE}/rounds/0/votes/${P2}`, P2, P2);
  assert.ok(DENIED(second), `changing a vote should fail: ${second.status} ${second.text}`);
});

test('a player cannot vote once the round is locked', async () => {
  await asAdmin(`rooms/${CODE}/rounds/0/phase`, 'PUT', 'locked');
  assert.ok(DENIED(await write(`rooms/${CODE}/rounds/0/votes/${P2}`, P2, P1)));
});

test('a player cannot vote after reveal', async () => {
  await asAdmin(`rooms/${CODE}/rounds/0/phase`, 'PUT', 'reveal');
  assert.ok(DENIED(await write(`rooms/${CODE}/rounds/0/votes/${P2}`, P2, P1)));
});

test('the round OWNER cannot vote on their own video', async () => {
  const r = await write(`rooms/${CODE}/rounds/0/votes/${P1}`, P1, P2);
  assert.ok(DENIED(r), `owner vote should fail: ${r.status} ${r.text}`);
});

test('a player cannot vote for themselves', async () => {
  assert.ok(DENIED(await write(`rooms/${CODE}/rounds/0/votes/${P2}`, P2, P2)));
});

test('a vote naming a non-existent player is rejected', async () => {
  assert.ok(DENIED(await write(`rooms/${CODE}/rounds/0/votes/${P2}`, P2, 'uid_nobody')));
});

test('votes are unreadable before reveal and readable after', async () => {
  await write(`rooms/${CODE}/rounds/0/votes/${P2}`, P2, P1);
  assert.ok(DENIED(await read(`rooms/${CODE}/rounds/0/votes`, P2)), 'votes leaked before reveal');

  // but a player may always read back their OWN vote, to lock their UI
  const mine = await read(`rooms/${CODE}/rounds/0/votes/${P2}`, P2);
  assert.ok(OK(mine) && JSON.parse(mine.text) === P1);

  await asAdmin(`rooms/${CODE}/rounds/0/phase`, 'PUT', 'reveal');
  assert.ok(OK(await read(`rooms/${CODE}/rounds/0/votes`, P2)));
});

// ===========================================================================
// the answer leaks through other doors
// ===========================================================================

test('players cannot read the pool — it reveals every answer in the game', async () => {
  assert.ok(DENIED(await read(`rooms/${CODE}/pool`, P2)));
  assert.ok(DENIED(await read(`rooms/${CODE}/pool/${P1}`, P2)));
  assert.ok(OK(await read(`rooms/${CODE}/pool`, HOST)), 'host must still be able to read the pool');
});

test('players cannot read videoId (they could look the video up)', async () => {
  assert.ok(DENIED(await read(`rooms/${CODE}/rounds/0/videoId`, P2)));
});

test('sitOut tells you only about YOURSELF', async () => {
  // the owner learns they are sitting out
  const own = await read(`rooms/${CODE}/rounds/0/sitOut/${P1}`, P1);
  assert.ok(OK(own) && JSON.parse(own.text) === true);

  // a non-owner reading their own key learns nothing (null), which is correct
  const mine = await read(`rooms/${CODE}/rounds/0/sitOut/${P2}`, P2);
  assert.ok(OK(mine) && JSON.parse(mine.text) === null);

  // ...but cannot read anyone else's key, nor enumerate the node — either would be
  // exactly equivalent to reading ownerUid.
  assert.ok(DENIED(await read(`rooms/${CODE}/rounds/0/sitOut/${P1}`, P2)), 'sitOut leaked the owner');
  assert.ok(DENIED(await read(`rooms/${CODE}/rounds/0/sitOut`, P2)), 'sitOut node was enumerable');
});

// ===========================================================================
// scores and identity
// ===========================================================================

test('a player cannot award themselves points', async () => {
  assert.ok(DENIED(await write(`rooms/${CODE}/players/${P2}/score`, P2, 99)));
  assert.ok(OK(await write(`rooms/${CODE}/players/${P2}/score`, HOST, 1)), 'host must be able to score');
});

test('a player cannot rename themselves once the game leaves the lobby', async () => {
  assert.ok(DENIED(await write(`rooms/${CODE}/players/${P2}/name`, P2, 'Sneaky')));

  await asAdmin(`rooms/${CODE}/meta/status`, 'PUT', 'lobby');
  assert.ok(OK(await write(`rooms/${CODE}/players/${P2}/name`, P2, 'Fine In Lobby')));
});

test('a player cannot edit another player', async () => {
  await asAdmin(`rooms/${CODE}/meta/status`, 'PUT', 'lobby');
  assert.ok(DENIED(await write(`rooms/${CODE}/players/${P1}/name`, P2, 'Renamed')));
  assert.ok(DENIED(await write(`rooms/${CODE}/players/${P1}/handle`, P2, 'hacked')));
});

test('a non-host cannot write meta, phase, or currentRound', async () => {
  assert.ok(DENIED(await write(`rooms/${CODE}/meta/status`, P2, 'finished')));
  assert.ok(DENIED(await write(`rooms/${CODE}/meta/hostUid`, P2, P2)), 'room takeover');
  assert.ok(DENIED(await write(`rooms/${CODE}/rounds/0/phase`, P2, 'reveal')), 'forcing reveal');
  assert.ok(DENIED(await write(`rooms/${CODE}/currentRound`, P2, 2)));
  assert.ok(DENIED(await write(`rooms/${CODE}/rounds/0/ownerUid`, P2, P2)));
});

test('a player cannot mark a round scored to block or trigger scoring', async () => {
  assert.ok(DENIED(await write(`rooms/${CODE}/rounds/0/scored`, P2, true)));
});

// ===========================================================================
// room lifetime
// ===========================================================================

test('writes to a room older than 12 hours are rejected', async () => {
  await asAdmin(`rooms/${CODE}/meta/createdAt`, 'PUT', Date.now() - 13 * 60 * 60 * 1000);
  const r = await write(`rooms/${CODE}/rounds/0/votes/${P2}`, P2, P1);
  assert.ok(DENIED(r), `stale room accepted a vote: ${r.status} ${r.text}`);
});

test('meta still accepts a legacy timerSecs field (deploy-order safety)', async () => {
  // The timer was removed from the game, but `$other: false` means an unknown field is
  // rejected outright. If the rule were deleted, whichever of {rules, site} shipped
  // first would break the other: new rules + old site = rejected writes. Keeping the
  // field valid-but-optional makes both deploy orders safe.
  const withLegacy = await write(`rooms/LEGA/meta`, P2, {
    code: 'LEGA',
    hostUid: P2,
    mode: 'reposts',
    roundCount: 3,
    timerSecs: 20,
    status: 'lobby',
    createdAt: { '.sv': 'timestamp' },
  });
  assert.ok(OK(withLegacy), `legacy timerSecs rejected: ${withLegacy.status} ${withLegacy.text}`);
  await asAdmin('rooms/LEGA', 'DELETE');
});

// --- kicking players -------------------------------------------------------
// The host may REMOVE a player node and ban the uid. As with the room delete, the
// permission is delete-only, so it must not become a way to edit anyone's fields.

test('the host can remove a player', async () => {
  const r = await call(`rooms/${CODE}/players/${P2}`, { as: HOST, method: 'DELETE' });
  assert.ok(OK(r), `host could not kick a player: ${r.status} ${r.text}`);
  const left = await asAdmin(`rooms/${CODE}/players/${P2}`);
  assert.equal(left.text.trim(), 'null', `kicked player survived: ${left.text}`);
  const other = await asAdmin(`rooms/${CODE}/players/${P1}/name`);
  assert.ok(other.text.includes('One'), 'kicking one player must not disturb the others');
});

test('a player cannot kick anybody, including themselves', async () => {
  const other = await call(`rooms/${CODE}/players/${P1}`, { as: P2, method: 'DELETE' });
  assert.ok(DENIED(other), `a player kicked someone else: ${other.status} ${other.text}`);
  const self = await call(`rooms/${CODE}/players/${P2}`, { as: P2, method: 'DELETE' });
  assert.ok(DENIED(self), `a player deleted their own node: ${self.status} ${self.text}`);
});

test('the kick permission does not let the host REWRITE a player', async () => {
  // `!newData.exists()` again. Without it the host could replace a player wholesale —
  // including their score — in one PUT, bypassing the per-field rules underneath.
  const forged = await write(`rooms/${CODE}/players/${P2}`, HOST, {
    name: 'Two',
    handle: 'two',
    score: 999,
  });
  assert.ok(DENIED(forged), `host rewrote a whole player node: ${forged.status} ${forged.text}`);
});

test('the host can still write individual player fields after the kick rule', async () => {
  // Regression guard: the new $uid rule must not shadow the per-field write rules the
  // host needs for scores and pool status.
  const score = await write(`rooms/${CODE}/players/${P1}/score`, HOST, 3);
  assert.ok(OK(score), `host lost the ability to set a score: ${score.status} ${score.text}`);
  const status = await write(`rooms/${CODE}/players/${P1}/poolStatus`, HOST, 'ok');
  assert.ok(OK(status), `host lost the ability to set poolStatus: ${status.status} ${status.text}`);
});

test('a banned uid cannot re-join the room', async () => {
  // A real join is db.joinRoom's update(), i.e. a PATCH of name+handle together. A PUT of
  // one field would leave the node without the other and fail hasChildren for an unrelated
  // reason, which would make this test pass while proving nothing about the ban.
  const rejoin = (uid) =>
    call(`rooms/${CODE}/players/${uid}`, {
      as: uid,
      method: 'PATCH',
      body: { name: 'Sneaky', handle: 'sneaky' },
    });

  await asAdmin(`rooms/${CODE}/meta/status`, 'PUT', 'lobby');
  await asAdmin(`rooms/${CODE}/players/${P2}`, 'DELETE');

  // Without the ban, re-joining is allowed — proves this test is testing the ban itself.
  const before = await rejoin(P2);
  assert.ok(OK(before), `baseline re-join was refused for another reason: ${before.text}`);
  await asAdmin(`rooms/${CODE}/players/${P2}`, 'DELETE');

  await asAdmin(`rooms/${CODE}/banned/${P2}`, 'PUT', true);
  const after = await rejoin(P2);
  assert.ok(DENIED(after), `banned player re-joined: ${after.status} ${after.text}`);
  const joined = await write(`rooms/${CODE}/players/${P2}/joinedAt`, P2, Date.now());
  assert.ok(DENIED(joined), `banned player wrote joinedAt: ${joined.status} ${joined.text}`);
});

test('a ban does not lock out the other players', async () => {
  await asAdmin(`rooms/${CODE}/meta/status`, 'PUT', 'lobby');
  await asAdmin(`rooms/${CODE}/banned/${P2}`, 'PUT', true);
  const r = await write(`rooms/${CODE}/players/${P1}/name`, P1, 'Renamed');
  assert.ok(OK(r), `an unrelated player was locked out by someone else's ban: ${r.text}`);
});

test('only the host can write the ban list', async () => {
  const r = await write(`rooms/${CODE}/banned/${P1}`, P2, true);
  assert.ok(DENIED(r), `a player banned somebody: ${r.status} ${r.text}`);
  const self = await write(`rooms/${CODE}/banned/${P2}`, P2, false);
  assert.ok(DENIED(self), `a player un-banned themselves: ${self.status} ${self.text}`);
});

// --- room deletion ---------------------------------------------------------
// The host must be able to bin a finished room (it holds every player's name and
// @handle), but that permission must not become a general write at the room level.

test('the host can delete their own room outright', async () => {
  const r = await call(`rooms/${CODE}`, { as: HOST, method: 'DELETE' });
  assert.ok(OK(r), `host could not delete their room: ${r.status} ${r.text}`);
  const left = await asAdmin(`rooms/${CODE}`);
  assert.equal(left.text.trim(), 'null', `room survived deletion: ${left.text}`);
});

test('the host can still delete a room past the 12-hour write window', async () => {
  // Abandoned rooms are by definition the old ones, and every other write rule refuses
  // a room older than 12h. If the delete rule carried the same clause, the rooms most in
  // need of cleaning up would be the exact ones that could never be cleaned up.
  await asAdmin(`rooms/${CODE}/meta/createdAt`, 'PUT', Date.now() - 30 * 24 * 60 * 60 * 1000);
  const r = await call(`rooms/${CODE}`, { as: HOST, method: 'DELETE' });
  assert.ok(OK(r), `stale room could not be deleted: ${r.status} ${r.text}`);
  const left = await asAdmin(`rooms/${CODE}`);
  assert.equal(left.text.trim(), 'null', `stale room survived: ${left.text}`);
});

test('a hostOnline write cannot resurrect a deleted room', async () => {
  // The host keeps BOTH onDisconnect registrations: hostOnline=false and the room delete.
  // Their firing order is not guaranteed, so if the delete lands first the hostOnline
  // write must be refused — otherwise it would recreate rooms/$code/meta/hostOnline as a
  // stray node and defeat the whole cleanup. The meta write rule reads hostUid, which no
  // longer exists after the delete, so it is refused. Proven here rather than assumed.
  await asAdmin(`rooms/${CODE}`, 'DELETE');
  const r = await write(`rooms/${CODE}/meta/hostOnline`, HOST, false);
  assert.ok(DENIED(r), `hostOnline recreated a deleted room: ${r.status} ${r.text}`);
  const left = await asAdmin(`rooms/${CODE}`);
  assert.equal(left.text.trim(), 'null', `deleted room came back: ${left.text}`);
});

test('a player cannot delete the room', async () => {
  const r = await call(`rooms/${CODE}`, { as: P2, method: 'DELETE' });
  assert.ok(DENIED(r), `a non-host deleted the room: ${r.status} ${r.text}`);
  const left = await asAdmin(`rooms/${CODE}/meta/code`);
  assert.ok(left.text.includes(CODE), 'room was destroyed by a player');
});

test('the delete permission does not let the host WRITE at the room level', async () => {
  // The whole safety of the rule is the `!newData.exists()` clause. Without it, write
  // access at rooms/$code would cascade and let the host forge votes, scores and pools
  // in one PUT, bypassing every per-child rule below it.
  const forged = await write(`rooms/${CODE}`, HOST, {
    meta: {
      code: CODE,
      hostUid: HOST,
      mode: 'reposts',
      roundCount: 3,
      status: 'playing',
      createdAt: Date.now(),
    },
    rounds: { 0: { videoId: '7301234567890123456', ownerUid: HOST, phase: 'playing', votes: { [P2]: HOST } } },
  });
  assert.ok(DENIED(forged), `host wrote a whole room in one go: ${forged.status} ${forged.text}`);
});

test('a host cannot delete somebody ELSE\'s room', async () => {
  await asAdmin('rooms/OTHR', 'PUT', {
    meta: { code: 'OTHR', hostUid: P1, mode: 'reposts', roundCount: 3, status: 'lobby', createdAt: Date.now() },
    players: { [P1]: { name: 'One', handle: 'one' } },
  });
  const r = await call('rooms/OTHR', { as: HOST, method: 'DELETE' });
  assert.ok(DENIED(r), `deleted a room owned by someone else: ${r.status} ${r.text}`);
  await asAdmin('rooms/OTHR', 'DELETE');
});

test('unauthenticated access is refused outright', async () => {
  const r = await fetch(url(`rooms/${CODE}/meta`));
  assert.ok(r.status === 401, `anon read got ${r.status}`);
});

// ===========================================================================
// ABUSE LIMITS — the repo is public, so the web API key is public too. Anyone can
// mint an anonymous uid and start writing. These bound what such a uid can do.
// ===========================================================================

test('ABUSE: room codes are constrained to 4 uppercase letters', async () => {
  const mk = (code, uid) =>
    write(`rooms/${code}/meta`, uid, {
      code,
      hostUid: uid,
      mode: 'reposts',
      roundCount: 3,
      status: 'lobby',
      createdAt: { '.sv': 'timestamp' },
    });

  // Arbitrary keys would let a bot spray unbounded rooms across the namespace.
  for (const bad of ['toolongcode', 'ab', 'lower', 'WITH-DASH', 'A1B2', '../evil', 'x'.repeat(200)]) {
    const r = await mk(bad, P2);
    assert.ok(DENIED(r), `room key "${bad.slice(0, 20)}" was accepted`);
  }
  const good = await mk('ZZZZ', P2);
  assert.ok(OK(good), `a valid code was refused: ${good.status} ${good.text}`);
  await asAdmin('rooms/ZZZZ', 'DELETE');
});

test('ABUSE: pool entries must look like TikTok video ids', async () => {
  // Without this the pool is an unbounded arbitrary-key blob store for the host uid.
  for (const bad of ['not-a-number', 'abc', '12', 'x'.repeat(120)]) {
    const r = await write(`rooms/${CODE}/pool/${P1}/${encodeURIComponent(bad)}`, HOST, true);
    assert.ok(DENIED(r), `pool key "${bad.slice(0, 20)}" was accepted`);
  }
  assert.ok(OK(await write(`rooms/${CODE}/pool/${P1}/7301234567890123456`, HOST, true)));
});

test('ABUSE: a round videoId must look like a TikTok video id', async () => {
  assert.ok(DENIED(await write(`rooms/${CODE}/rounds/0/videoId`, HOST, 'javascript:alert(1)')));
  assert.ok(DENIED(await write(`rooms/${CODE}/rounds/0/videoId`, HOST, 'x'.repeat(200))));
  assert.ok(OK(await write(`rooms/${CODE}/rounds/0/videoId`, HOST, '7301234567890123456')));
});

test('ABUSE: player name and handle stay length-bounded', async () => {
  await asAdmin(`rooms/${CODE}/meta/status`, 'PUT', 'lobby');
  assert.ok(DENIED(await write(`rooms/${CODE}/players/${P2}/name`, P2, 'x'.repeat(500))));
  assert.ok(DENIED(await write(`rooms/${CODE}/players/${P2}/handle`, P2, 'y'.repeat(500))));
  assert.ok(DENIED(await write(`rooms/${CODE}/players/${P2}/name`, P2, '')));
});
