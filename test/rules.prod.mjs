// Security-rules verification against the LIVE Firebase project.
//
// test/rules.test.mjs proves the rules against the emulator, but the emulator and
// production RTDB do not enforce identically in every corner, so the attacks that
// matter are re-proven here against the real database.
//
// Difference from the emulator suite: there is no admin credential in production, so
// the fixture is built entirely out of LEGITIMATE client operations — a real host
// creating a real room, real players joining. That is a stricter test of the rules
// (it proves the host path actually works) but it means two emulator-only cases are
// skipped: back-dating `createdAt` to test the 12-hour cutoff, and forcing a phase
// the host would never write. Those stay covered by the emulator suite.
//
// Run: node --test "test/rules.prod.mjs"
//
// Leaves one inert room behind. The rules deliberately forbid deleting `meta` (a
// delete would have to write a null hostUid), so the room cannot be removed by a
// client; it stops accepting writes after 12 hours by design.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Read the config out of docs/js/firebase.js rather than restating it, so the key and
// database URL live in exactly ONE file. (They are public by design — a Firebase web
// key identifies the project and authorises nothing — but duplicating them means two
// places to update and two hits for GitHub's secret scanner.)
const CONFIG_FILE = new URL('../docs/js/firebase.js', import.meta.url);
const configSrc = readFileSync(CONFIG_FILE, 'utf8');
const field = (name) => {
  const m = configSrc.match(new RegExp(`${name}:\\s*'([^']+)'`));
  if (!m) throw new Error(`could not read ${name} from docs/js/firebase.js`);
  return m[1];
};
const KEY = field('apiKey');
const DB = field('databaseURL').replace(/\/$/, '');

// Letters only: the rules constrain room keys to /^[A-Z]{4}$/, and base-36 would
// sometimes yield digits and fail intermittently.
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const rnd = () => LETTERS[Math.floor(Math.random() * LETTERS.length)];
const CODE = 'P' + rnd() + rnd() + rnd();

let HOST, P1, P2; // uids
const token = {};

async function signUp() {
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  if (!r.ok) throw new Error(`anonymous sign-in failed: ${r.status} ${await r.text()}`);
  const j = await r.json();
  token[j.localId] = j.idToken;
  return j.localId;
}

const call = async (path, as, method = 'GET', body) => {
  const res = await fetch(`${DB}/${path}.json?auth=${encodeURIComponent(token[as])}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
};
const read = (p, as) => call(p, as);
const write = (p, as, body) => call(p, as, 'PUT', body);
/**
 * PATCH == the SDK's update(): RTDB evaluates each child path separately.
 *
 * This matters for the player node. `players/$uid` grants .write per FIELD (name,
 * handle, joinedAt...) and not at the node itself, so a PUT — which replaces the whole
 * node and therefore needs permission one level up — is correctly refused. db.joinRoom
 * uses update() for exactly this reason.
 */
const patch = (p, as, body) => call(p, as, 'PATCH', body);

const DENIED = (r) => r.status === 401 || /Permission denied/.test(r.text);
const OK = (r) => r.status === 200;
const SV = { '.sv': 'timestamp' };

// Sign in up front so the whole suite can skip cleanly rather than fail confusingly.
// Restricting the browser API key to HTTP referrers (recommended for a public repo)
// deliberately blocks Node, which sends no Referer — that is the restriction working,
// not a regression, and the emulator suite covers the same attacks either way.
let SKIP = false;
try {
  [HOST, P1, P2] = await Promise.all([signUp(), signUp(), signUp()]);
} catch (err) {
  SKIP =
    `cannot sign in to the live project: ${String(err.message).slice(0, 140)} | ` +
    `If you restricted the API key to HTTP referrers this is EXPECTED (Node sends no Referer). ` +
    `Run the emulator suite instead: node --test "test/rules.test.mjs"`;
  console.log(`\n  SKIPPING live-rules suite: ${SKIP}\n`);
}
const t = (name, fn) => test(name, SKIP ? { skip: SKIP } : {}, fn);

before(async () => {
  if (SKIP) return;

  // --- build the fixture the way the real app does -------------------------
  let r = await write(`rooms/${CODE}/meta`, HOST, {
    code: CODE,
    hostUid: HOST,
    mode: 'reposts',
    roundCount: 3,
    timerSecs: 20,
    status: 'lobby',
    createdAt: SV,
  });
  assert.ok(OK(r), `host could not create the room: ${r.status} ${r.text}`);

  for (const [uid, name] of [[P1, 'One'], [P2, 'Two']]) {
    const j = await patch(`rooms/${CODE}/players/${uid}`, uid, {
      name,
      handle: name.toLowerCase(),
      joinedAt: SV,
    });
    assert.ok(OK(j), `player could not join: ${j.status} ${j.text}`);
  }

  // host scores are host-written, so seed them separately
  for (const uid of [P1, P2]) await write(`rooms/${CODE}/players/${uid}/score`, HOST, 0);

  // host writes the pool and the whole round plan, then starts round 0 (owner = P1)
  assert.ok(OK(await write(`rooms/${CODE}/pool/${P1}`, HOST, { 7301234567890123456: true })));
  assert.ok(OK(await write(`rooms/${CODE}/rounds`, HOST, { 0: { videoId: '7301234567890123456', ownerUid: P1 } })));
  assert.ok(OK(await write(`rooms/${CODE}/meta/status`, HOST, 'playing')));
  assert.ok(OK(await write(`rooms/${CODE}/currentRound`, HOST, 0)));
  assert.ok(OK(await write(`rooms/${CODE}/rounds/0/phase`, HOST, 'playing')));
  assert.ok(OK(await write(`rooms/${CODE}/rounds/0/endsAt`, HOST, Date.now() + 60000)));
  assert.ok(OK(await write(`rooms/${CODE}/rounds/0/sitOut/${P1}`, HOST, true)));
  console.log(`  fixture ready in live project, room ${CODE}`);
});

after(async () => {
  if (SKIP) return;
  // Remove what we can. meta cannot be deleted by design (see header).
  await call(`rooms/${CODE}/rounds`, HOST, 'DELETE');
  await call(`rooms/${CODE}/pool`, HOST, 'DELETE');
  await write(`rooms/${CODE}/meta/status`, HOST, 'finished');
});

// ===========================================================================

t('PROD ATTACK 1: a non-host player cannot read ownerUid mid-round', async () => {
  assert.ok(DENIED(await read(`rooms/${CODE}/rounds/0/ownerUid`, P2)), 'ownerUid leaked');
  for (const p of [`rooms/${CODE}/rounds/0`, `rooms/${CODE}/rounds`, `rooms/${CODE}`, '']) {
    assert.ok(DENIED(await read(p, P2)), `leaked via "${p}"`);
  }
});

t('PROD ATTACK 2: a player cannot write another player\'s vote', async () => {
  assert.ok(DENIED(await write(`rooms/${CODE}/rounds/0/votes/${P1}`, P2, P2)));
});

t('PROD: the pool is unreadable by players, readable by the host', async () => {
  assert.ok(DENIED(await read(`rooms/${CODE}/pool`, P2)));
  assert.ok(DENIED(await read(`rooms/${CODE}/pool/${P1}`, P2)));
  assert.ok(OK(await read(`rooms/${CODE}/pool`, HOST)));
});

t('PROD: videoId is unreadable by players', async () => {
  assert.ok(DENIED(await read(`rooms/${CODE}/rounds/0/videoId`, P2)));
});

t('PROD: sitOut cannot be enumerated to find the owner', async () => {
  assert.ok(OK(await read(`rooms/${CODE}/rounds/0/sitOut/${P1}`, P1)), 'owner cannot see their own flag');
  assert.ok(DENIED(await read(`rooms/${CODE}/rounds/0/sitOut/${P1}`, P2)), 'sitOut leaked the owner');
  assert.ok(DENIED(await read(`rooms/${CODE}/rounds/0/sitOut`, P2)), 'sitOut was enumerable');
});

t('PROD: a player cannot award themselves points', async () => {
  assert.ok(DENIED(await write(`rooms/${CODE}/players/${P2}/score`, P2, 99)));
});

t('PROD: a player cannot rename themselves mid-game', async () => {
  assert.ok(DENIED(await write(`rooms/${CODE}/players/${P2}/name`, P2, 'Sneaky')));
});

t('PROD: a non-host cannot drive the game', async () => {
  assert.ok(DENIED(await write(`rooms/${CODE}/meta/status`, P2, 'finished')));
  assert.ok(DENIED(await write(`rooms/${CODE}/meta/hostUid`, P2, P2)), 'room takeover');
  assert.ok(DENIED(await write(`rooms/${CODE}/rounds/0/phase`, P2, 'reveal')), 'forced reveal');
  assert.ok(DENIED(await write(`rooms/${CODE}/currentRound`, P2, 2)));
  assert.ok(DENIED(await write(`rooms/${CODE}/rounds/0/scored`, P2, true)));
});

t('PROD: voting rules — own vote allowed, everything else refused', async () => {
  assert.ok(DENIED(await write(`rooms/${CODE}/rounds/0/votes/${P2}`, P2, P2)), 'self-vote');
  assert.ok(DENIED(await write(`rooms/${CODE}/rounds/0/votes/${P2}`, P2, 'uid_nobody')), 'vote for a ghost');
  assert.ok(DENIED(await write(`rooms/${CODE}/rounds/0/votes/${P1}`, P1, P2)), 'owner voted');

  assert.ok(OK(await write(`rooms/${CODE}/rounds/0/votes/${P2}`, P2, P1)), 'legitimate vote refused');
  assert.ok(DENIED(await write(`rooms/${CODE}/rounds/0/votes/${P2}`, P2, P1)), 'vote changed');

  // own vote readable, everyone's votes not
  assert.ok(OK(await read(`rooms/${CODE}/rounds/0/votes/${P2}`, P2)));
  assert.ok(DENIED(await read(`rooms/${CODE}/rounds/0/votes`, P2)), 'votes leaked before reveal');
});

t('PROD: ownerUid and votes open up exactly at reveal', async () => {
  assert.ok(DENIED(await read(`rooms/${CODE}/rounds/0/ownerUid`, P2)), 'leaked while playing');
  assert.ok(OK(await write(`rooms/${CODE}/rounds/0/phase`, HOST, 'locked')));
  assert.ok(DENIED(await read(`rooms/${CODE}/rounds/0/ownerUid`, P2)), 'leaked while locked');

  assert.ok(OK(await write(`rooms/${CODE}/rounds/0/phase`, HOST, 'reveal')));
  const o = await read(`rooms/${CODE}/rounds/0/ownerUid`, P2);
  assert.ok(OK(o) && JSON.parse(o.text) === P1, 'owner not readable at reveal');
  assert.ok(OK(await read(`rooms/${CODE}/rounds/0/votes`, P2)), 'votes not readable at reveal');

  // and voting is closed once revealed
  assert.ok(DENIED(await write(`rooms/${CODE}/rounds/0/votes/${P1}`, P1, P2)));
});

t('PROD: unauthenticated access is refused outright', async () => {
  const r = await fetch(`${DB}/rooms/${CODE}/meta.json`);
  assert.equal(r.status, 401);
});
