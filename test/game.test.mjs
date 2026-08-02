// node --test test/
//
// No framework, no npm install — the built-in runner and node:assert/strict only.
// Every test that touches randomness passes a seeded PRNG, so nothing here is flaky.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateRounds,
  scoreRound,
  voteProgress,
  leaderboard,
} from '../docs/js/game.js';

// --- seeded PRNG (mulberry32) ---------------------------------------------
function seeded(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pool = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

/** Longest run of the same owner, and count of adjacent repeats. */
function adjacentRepeats(rounds) {
  let n = 0;
  for (let i = 1; i < rounds.length; i++) {
    if (rounds[i].ownerUid === rounds[i - 1].ownerUid) n++;
  }
  return n;
}

function ownerCounts(rounds) {
  const m = new Map();
  for (const r of rounds) m.set(r.ownerUid, (m.get(r.ownerUid) || 0) + 1);
  return m;
}

// ===========================================================================
// 1. ambiguous videos
// ===========================================================================

test('a videoId in two pools is excluded entirely and reported', () => {
  const res = generateRounds(
    {
      pools: {
        alice: ['shared1', 'a1', 'a2'],
        bob: ['shared1', 'b1'],
        cara: ['c1'],
      },
      roundCount: 10,
    },
    seeded(1)
  );

  assert.deepEqual(res.droppedAmbiguous, ['shared1']);
  assert.ok(
    res.rounds.every((r) => r.videoId !== 'shared1'),
    'shared1 must never appear in a round'
  );
  assert.equal(res.rounds.length, 4); // a1 a2 b1 c1
});

test('a video shared by three pools is dropped, and a player left with nothing is not an eligible owner', () => {
  const res = generateRounds(
    {
      pools: {
        alice: ['x', 'a1'],
        bob: ['x', 'b1'],
        cara: ['x'], // cara's only video is ambiguous -> cara can never own
      },
      roundCount: 5,
    },
    seeded(7)
  );

  assert.deepEqual(res.droppedAmbiguous, ['x']);
  assert.deepEqual([...res.eligibleOwners].sort(), ['alice', 'bob']);
  assert.ok(!res.rounds.some((r) => r.ownerUid === 'cara'));
});

test('a duplicate videoId inside one players own pool is not treated as ambiguous', () => {
  const res = generateRounds(
    { pools: { alice: ['a1', 'a1', 'a2'] }, roundCount: 5 },
    seeded(3)
  );

  assert.deepEqual(res.droppedAmbiguous, []);
  assert.equal(res.rounds.length, 2);
  assert.deepEqual([...res.rounds.map((r) => r.videoId)].sort(), ['a1', 'a2']);
});

// ===========================================================================
// 2. no videoId repeats
// ===========================================================================

test('no videoId appears in two rounds', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const res = generateRounds(
      {
        pools: {
          alice: pool('a', 6),
          bob: pool('b', 6),
          cara: pool('c', 6),
          dan: pool('d', 6),
        },
        roundCount: 24,
      },
      seeded(seed)
    );
    const ids = res.rounds.map((r) => r.videoId);
    assert.equal(new Set(ids).size, ids.length, `seed ${seed} produced a duplicate video`);
    assert.equal(ids.length, 24);
  }
});

test('a videoId is always owned by the player whose pool it came from', () => {
  const pools = { alice: pool('a', 4), bob: pool('b', 4), cara: pool('c', 4) };
  const res = generateRounds({ pools, roundCount: 12 }, seeded(99));
  for (const r of res.rounds) {
    assert.ok(
      pools[r.ownerUid].includes(r.videoId),
      `${r.videoId} attributed to ${r.ownerUid} who does not own it`
    );
  }
});

// ===========================================================================
// 3. owner balance
// ===========================================================================

test('with equal pools, owner counts differ by at most 1', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const res = generateRounds(
      {
        pools: {
          alice: pool('a', 5),
          bob: pool('b', 5),
          cara: pool('c', 5),
          dan: pool('d', 5),
        },
        roundCount: 10,
      },
      seeded(seed)
    );

    const counts = [...ownerCounts(res.rounds).values()];
    assert.equal(counts.length, 4, `seed ${seed}: every player should own a round`);
    assert.ok(
      Math.max(...counts) - Math.min(...counts) <= 1,
      `seed ${seed}: unbalanced owners ${counts.join(',')}`
    );
  }
});

test('a player with a small pool does not block the others, and balance is as even as capacity allows', () => {
  // bob only has 1 usable video, so he owns 1 round and the rest split the remainder.
  const res = generateRounds(
    { pools: { alice: pool('a', 10), bob: ['b1'], cara: pool('c', 10) }, roundCount: 9 },
    seeded(11)
  );

  const counts = ownerCounts(res.rounds);
  assert.equal(res.rounds.length, 9);
  assert.equal(counts.get('bob'), 1);
  assert.equal(counts.get('alice'), 4);
  assert.equal(counts.get('cara'), 4);
});

// ===========================================================================
// 4. same owner never twice in a row (when avoidable)
// ===========================================================================

test('same owner never appears twice in a row when more than one eligible owner exists', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const res = generateRounds(
      {
        pools: { alice: pool('a', 5), bob: pool('b', 5), cara: pool('c', 5) },
        roundCount: 12,
      },
      seeded(seed)
    );
    assert.equal(
      adjacentRepeats(res.rounds),
      0,
      `seed ${seed}: back-to-back owner in ${res.rounds.map((r) => r.ownerUid).join(',')}`
    );
  }
});

test('two owners alternate perfectly', () => {
  const res = generateRounds(
    { pools: { alice: pool('a', 4), bob: pool('b', 4) }, roundCount: 8 },
    seeded(5)
  );
  assert.equal(adjacentRepeats(res.rounds), 0);
});

test('when a repeat is mathematically forced, the number of repeats is the theoretical minimum', () => {
  // alice must own 5 of 7 rounds because nobody else has the videos, so at least
  // 2*5 - 7 - 1 = 2 back-to-back pairs are unavoidable.
  for (let seed = 1; seed <= 20; seed++) {
    const res = generateRounds(
      { pools: { alice: pool('a', 5), bob: ['b1'], cara: ['c1'] }, roundCount: 7 },
      seeded(seed)
    );

    const counts = [...ownerCounts(res.rounds).values()];
    const n = res.rounds.length;
    const minPossible = Math.max(0, 2 * Math.max(...counts) - n - 1);
    assert.equal(n, 7);
    assert.equal(
      adjacentRepeats(res.rounds),
      minPossible,
      `seed ${seed}: ${res.rounds.map((r) => r.ownerUid).join(',')}`
    );
  }
});

test('a single eligible owner still produces rounds (repeats unavoidable)', () => {
  const res = generateRounds({ pools: { alice: pool('a', 3) } }, seeded(2));
  // roundCount omitted -> 0 requested
  assert.deepEqual(res.rounds, []);

  const res2 = generateRounds({ pools: { alice: pool('a', 3) }, roundCount: 3 }, seeded(2));
  assert.equal(res2.rounds.length, 3);
  assert.ok(res2.rounds.every((r) => r.ownerUid === 'alice'));
});

// ===========================================================================
// 5. clamping + message
// ===========================================================================

test('requesting 10 rounds when only 6 unique videos exist yields 6 and the spec message', () => {
  const res = generateRounds(
    {
      pools: {
        alice: ['a1', 'a2'],
        bob: ['b1', 'b2'],
        cara: ['c1'],
        dan: ['d1'],
      },
      roundCount: 10,
    },
    seeded(4)
  );

  assert.equal(res.requested, 10);
  assert.equal(res.available, 6);
  assert.equal(res.rounds.length, 6);
  assert.equal(res.clamped, true);
  assert.equal(res.message, 'Only 6 rounds available — 4 players had usable videos');
  assert.ok(res.message.includes('—'), 'must use an em dash');
});

test('not clamped means message is null', () => {
  const res = generateRounds(
    { pools: { alice: pool('a', 5), bob: pool('b', 5) }, roundCount: 6 },
    seeded(8)
  );
  assert.equal(res.clamped, false);
  assert.equal(res.message, null);
  assert.equal(res.available, 6);
  assert.equal(res.requested, 6);
});

test('exactly enough videos is not clamped', () => {
  const res = generateRounds(
    { pools: { alice: ['a1', 'a2'], bob: ['b1', 'b2'] }, roundCount: 4 },
    seeded(8)
  );
  assert.equal(res.clamped, false);
  assert.equal(res.message, null);
});

test('message pluralises correctly for a single round and a single player', () => {
  const res = generateRounds({ pools: { alice: ['a1'] }, roundCount: 5 }, seeded(6));
  assert.equal(res.message, 'Only 1 round available — 1 player had usable videos');
});

test('no usable videos at all reports zero rounds', () => {
  const res = generateRounds(
    { pools: { alice: ['x'], bob: ['x'] }, roundCount: 5 },
    seeded(6)
  );
  assert.deepEqual(res.rounds, []);
  assert.deepEqual(res.eligibleOwners, []);
  assert.deepEqual(res.droppedAmbiguous, ['x']);
  assert.equal(res.clamped, true);
  assert.equal(res.message, 'Only 0 rounds available — 0 players had usable videos');
});

// ===========================================================================
// 6. never a null owner
// ===========================================================================

test('never emits a round with a null/undefined ownerUid or videoId, even with empty pools', () => {
  const cases = [
    { alice: [], bob: [], cara: [] },
    { alice: [], bob: ['b1', 'b2'], cara: [] },
    { alice: ['x'], bob: ['x'], cara: [] },
    { alice: pool('a', 3), bob: [], cara: ['c1'], dan: [] },
    { alice: null, bob: ['b1'], cara: undefined },
  ];

  for (const pools of cases) {
    for (let seed = 1; seed <= 10; seed++) {
      const res = generateRounds({ pools, roundCount: 12 }, seeded(seed));
      for (const r of res.rounds) {
        assert.equal(typeof r.ownerUid, 'string');
        assert.ok(r.ownerUid.length > 0);
        assert.equal(typeof r.videoId, 'string');
        assert.ok(r.videoId.length > 0);
      }
      assert.equal(res.available, res.rounds.length);
      // a player with an empty pool is never an eligible owner
      assert.ok(res.eligibleOwners.every((uid) => res.eligibleOwners.indexOf(uid) >= 0));
      for (const uid of Object.keys(pools)) {
        const usable = Array.isArray(pools[uid]) ? pools[uid].length : 0;
        if (usable === 0) assert.ok(!res.eligibleOwners.includes(uid));
      }
    }
  }
});

// ===========================================================================
// 7 + 8. determinism and real shuffling
// ===========================================================================

test('same seeded rng + same input produces identical output', () => {
  const pools = {
    alice: pool('a', 7),
    bob: pool('b', 7),
    cara: pool('c', 7),
    dan: pool('d', 7),
  };
  const a = generateRounds({ pools, roundCount: 15 }, seeded(1234));
  const b = generateRounds({ pools, roundCount: 15 }, seeded(1234));
  assert.deepEqual(a, b);

  // and it is stable across many seeds, not just one
  for (let seed = 1; seed <= 10; seed++) {
    assert.deepEqual(
      generateRounds({ pools, roundCount: 15 }, seeded(seed)),
      generateRounds({ pools, roundCount: 15 }, seeded(seed))
    );
  }
});

test('different seeds pick different videos out of a players pool (the shuffle really happens)', () => {
  const pools = { alice: pool('a', 12), bob: pool('b', 12) };
  const selections = new Set();
  for (let seed = 1; seed <= 20; seed++) {
    const res = generateRounds({ pools, roundCount: 4 }, seeded(seed));
    const alices = res.rounds
      .filter((r) => r.ownerUid === 'alice')
      .map((r) => r.videoId)
      .sort()
      .join(',');
    selections.add(alices);
  }
  assert.ok(
    selections.size > 1,
    `alice always yielded the same videos across seeds: ${[...selections]}`
  );
});

test('different seeds produce different round orderings', () => {
  const pools = { alice: pool('a', 5), bob: pool('b', 5), cara: pool('c', 5) };
  const orders = new Set();
  for (let seed = 1; seed <= 20; seed++) {
    const res = generateRounds({ pools, roundCount: 9 }, seeded(seed));
    orders.add(res.rounds.map((r) => `${r.ownerUid}:${r.videoId}`).join('|'));
  }
  assert.ok(orders.size > 1, 'round order never changed across seeds');
});

test('generateRounds does not mutate the pools it was given', () => {
  const pools = { alice: pool('a', 4), bob: pool('b', 4) };
  const snapshot = JSON.parse(JSON.stringify(pools));
  generateRounds({ pools, roundCount: 8 }, seeded(77));
  assert.deepEqual(pools, snapshot);
});

test('defaults to Math.random when no rng is passed', () => {
  const res = generateRounds({
    pools: { alice: pool('a', 3), bob: pool('b', 3) },
    roundCount: 4,
  });
  assert.equal(res.rounds.length, 4);
  assert.equal(new Set(res.rounds.map((r) => r.videoId)).size, 4);
});

// ===========================================================================
// 9. scoreRound
// ===========================================================================

test('scoreRound awards exactly the voters who matched ownerUid', () => {
  const votes = { bob: 'alice', cara: 'dan', dan: 'alice', eve: 'bob' };
  const { correct, incorrect } = scoreRound(votes, 'alice');
  assert.deepEqual(correct.sort(), ['bob', 'dan']);
  assert.deepEqual(incorrect.sort(), ['cara', 'eve']);
});

test('scoreRound ignores the owner even if a vote somehow landed in their slot', () => {
  const { correct, incorrect } = scoreRound({ alice: 'alice', bob: 'alice' }, 'alice');
  assert.deepEqual(correct, ['bob']);
  assert.deepEqual(incorrect, []);
});

test('scoreRound handles no votes and missing vote objects', () => {
  assert.deepEqual(scoreRound({}, 'alice'), { correct: [], incorrect: [] });
  assert.deepEqual(scoreRound(null, 'alice'), { correct: [], incorrect: [] });
  assert.deepEqual(scoreRound(undefined, 'alice'), { correct: [], incorrect: [] });
});

test('scoreRound with nobody correct', () => {
  const { correct, incorrect } = scoreRound({ bob: 'cara', cara: 'bob' }, 'alice');
  assert.deepEqual(correct, []);
  assert.deepEqual(incorrect.sort(), ['bob', 'cara']);
});

// ===========================================================================
// 10. voteProgress
// ===========================================================================

test('voteProgress excludes the owner and reports allVoted correctly', () => {
  const players = ['alice', 'bob', 'cara', 'dan'];

  const partial = voteProgress(players, 'alice', { bob: 'cara' });
  assert.deepEqual(partial.eligible, ['bob', 'cara', 'dan']);
  assert.ok(!partial.eligible.includes('alice'));
  assert.deepEqual(partial.voted, ['bob']);
  assert.deepEqual(partial.pending, ['cara', 'dan']);
  assert.equal(partial.allVoted, false);

  const full = voteProgress(players, 'alice', { bob: 'cara', cara: 'alice', dan: 'bob' });
  assert.deepEqual(full.pending, []);
  assert.equal(full.allVoted, true);
  assert.equal(full.voted.length, 3);
});

test('voteProgress ignores a stray vote from the owner when deciding allVoted', () => {
  const res = voteProgress(['alice', 'bob'], 'alice', { alice: 'bob' });
  assert.deepEqual(res.eligible, ['bob']);
  assert.deepEqual(res.pending, ['bob']);
  assert.equal(res.allVoted, false);
});

test('voteProgress counts a player whose scrape failed as an eligible voter', () => {
  // cara had poolStatus !== 'ok' so she can never own a round, but she still votes.
  const res = voteProgress(['alice', 'bob', 'cara'], 'alice', { bob: 'cara' });
  assert.ok(res.eligible.includes('cara'));
  assert.deepEqual(res.pending, ['cara']);
  assert.equal(res.allVoted, false);
});

test('voteProgress with the owner as the only player has nobody left to wait for', () => {
  const res = voteProgress(['alice'], 'alice', {});
  assert.deepEqual(res.eligible, []);
  assert.deepEqual(res.pending, []);
  assert.equal(res.allVoted, true);
});

test('voteProgress tolerates duplicate uids, empty vote values and missing input', () => {
  const dup = voteProgress(['bob', 'bob', 'alice'], 'alice', { bob: '' });
  assert.deepEqual(dup.eligible, ['bob']);
  assert.deepEqual(dup.pending, ['bob'], 'an empty-string vote is not a vote');

  const none = voteProgress(undefined, 'alice', undefined);
  assert.deepEqual(none.eligible, []);
  assert.equal(none.allVoted, true);
});

// ===========================================================================
// 11. leaderboard
// ===========================================================================

test('leaderboard sorts descending and handles ties', () => {
  const board = leaderboard({
    u1: { name: 'Alice', score: 3 },
    u2: { name: 'Bob', score: 5 },
    u3: { name: 'Cara', score: 3 },
    u4: { name: 'Dan', score: 0 },
  });

  assert.deepEqual(
    board.map((r) => [r.name, r.score, r.rank]),
    [
      ['Bob', 5, 1],
      ['Alice', 3, 2],
      ['Cara', 3, 2],
      ['Dan', 0, 4],
    ]
  );
});

test('leaderboard defaults a missing score to 0 and is stable for ties', () => {
  const board = leaderboard({
    u2: { name: 'Bob' },
    u1: { name: 'Alice', score: 0 },
  });
  assert.deepEqual(
    board.map((r) => [r.uid, r.name, r.score, r.rank]),
    [
      ['u1', 'Alice', 0, 1],
      ['u2', 'Bob', 0, 1],
    ]
  );

  // same input, second call -> same order
  assert.deepEqual(
    leaderboard({ u2: { name: 'Bob' }, u1: { name: 'Alice', score: 0 } }),
    board
  );
});

test('leaderboard with everyone tied gives everyone rank 1', () => {
  const board = leaderboard({
    a: { name: 'A', score: 2 },
    b: { name: 'B', score: 2 },
    c: { name: 'C', score: 2 },
  });
  assert.deepEqual(board.map((r) => r.rank), [1, 1, 1]);
});

test('leaderboard handles empty, null and a single player', () => {
  assert.deepEqual(leaderboard({}), []);
  assert.deepEqual(leaderboard(null), []);
  assert.deepEqual(leaderboard(undefined), []);
  assert.deepEqual(leaderboard({ solo: { name: 'Solo', score: 7 } }), [
    { uid: 'solo', name: 'Solo', score: 7, rank: 1 },
  ]);
});

// ===========================================================================
// 12. edge cases
// ===========================================================================

test('empty pools object', () => {
  const res = generateRounds({ pools: {}, roundCount: 5 }, seeded(1));
  assert.deepEqual(res.rounds, []);
  assert.deepEqual(res.eligibleOwners, []);
  assert.deepEqual(res.droppedAmbiguous, []);
  assert.equal(res.requested, 5);
  assert.equal(res.available, 0);
  assert.equal(res.clamped, true);
  assert.equal(res.message, 'Only 0 rounds available — 0 players had usable videos');
});

test('single player', () => {
  const res = generateRounds({ pools: { alice: pool('a', 4) }, roundCount: 3 }, seeded(9));
  assert.equal(res.rounds.length, 3);
  assert.deepEqual(res.eligibleOwners, ['alice']);
  assert.equal(res.clamped, false);
  assert.equal(res.message, null);
  assert.equal(new Set(res.rounds.map((r) => r.videoId)).size, 3);
});

test('roundCount of 0 produces no rounds and is not treated as clamped', () => {
  const res = generateRounds(
    { pools: { alice: pool('a', 4), bob: pool('b', 4) }, roundCount: 0 },
    seeded(1)
  );
  assert.deepEqual(res.rounds, []);
  assert.equal(res.requested, 0);
  assert.equal(res.available, 0);
  assert.equal(res.clamped, false);
  assert.equal(res.message, null);
  assert.deepEqual([...res.eligibleOwners].sort(), ['alice', 'bob']);
});

test('missing / nonsense arguments do not throw', () => {
  assert.deepEqual(generateRounds().rounds, []);
  assert.deepEqual(generateRounds({}).rounds, []);
  assert.deepEqual(generateRounds({ pools: null, roundCount: 4 }, seeded(1)).rounds, []);
  assert.deepEqual(
    generateRounds({ pools: { a: 'not-an-array' }, roundCount: 4 }, seeded(1)).rounds,
    []
  );
  assert.deepEqual(
    generateRounds({ pools: { a: ['x1'] }, roundCount: -3 }, seeded(1)).rounds,
    []
  );
  assert.deepEqual(
    generateRounds({ pools: { a: ['x1'] }, roundCount: NaN }, seeded(1)).rounds,
    []
  );
});

test('non-string and blank videoIds are ignored', () => {
  const res = generateRounds(
    { pools: { alice: ['a1', '', '   ', 42, null, 'a2'] }, roundCount: 5 },
    seeded(1)
  );
  assert.equal(res.rounds.length, 2);
  assert.deepEqual(res.rounds.map((r) => r.videoId).sort(), ['a1', 'a2']);
});

test('a fractional roundCount is floored', () => {
  const res = generateRounds(
    { pools: { alice: pool('a', 5), bob: pool('b', 5) }, roundCount: 4.9 },
    seeded(1)
  );
  assert.equal(res.requested, 4);
  assert.equal(res.rounds.length, 4);
  assert.equal(res.clamped, false);
});

// ===========================================================================
// integration-ish: a full game shape
// ===========================================================================

test('a realistic game: rounds generate, votes score, leaderboard ranks', () => {
  const pools = {
    alice: pool('a', 5),
    bob: pool('b', 5),
    cara: pool('c', 5),
    // dan's scrape failed, so he is absent from pools entirely
  };
  const allPlayers = ['alice', 'bob', 'cara', 'dan'];

  const res = generateRounds({ pools, roundCount: 6 }, seeded(2026));
  assert.equal(res.rounds.length, 6);
  assert.equal(res.clamped, false);
  assert.ok(!res.eligibleOwners.includes('dan'));

  const scores = Object.fromEntries(allPlayers.map((uid) => [uid, 0]));

  for (const round of res.rounds) {
    const { eligible } = voteProgress(allPlayers, round.ownerUid, {});
    assert.equal(eligible.length, 3, 'owner sits out, everyone else votes');
    assert.ok(eligible.includes('dan'), 'a failed-scrape player still votes');

    // everyone guesses correctly except the first eligible voter
    const votes = {};
    eligible.forEach((uid, i) => {
      votes[uid] = i === 0 ? 'nobody' : round.ownerUid;
    });

    const progress = voteProgress(allPlayers, round.ownerUid, votes);
    assert.equal(progress.allVoted, true);

    const { correct, incorrect } = scoreRound(votes, round.ownerUid);
    assert.equal(correct.length, 2);
    assert.equal(incorrect.length, 1);
    for (const uid of correct) scores[uid] += 1;
  }

  const board = leaderboard(
    Object.fromEntries(allPlayers.map((uid) => [uid, { name: uid, score: scores[uid] }]))
  );
  assert.equal(board.length, 4);
  assert.equal(board[0].rank, 1);
  for (let i = 1; i < board.length; i++) {
    assert.ok(board[i - 1].score >= board[i].score, 'board must be descending');
  }
  // 6 rounds x 2 correct voters = 12 points handed out
  assert.equal(board.reduce((n, r) => n + r.score, 0), 12);
});
