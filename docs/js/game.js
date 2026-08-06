// Pure game logic for "Whose TikTok?".
//
// HARD RULE: this file has no imports, no Firebase, no DOM. Every export is a pure
// function of its arguments. Randomness is always the LAST parameter and defaults to
// Math.random, so unit tests can pass a seeded PRNG and get deterministic output.
//
// Loaded directly by the browser as an ES module (no build step) and by `node --test`.

// ===========================================================================
// internal helpers
// ===========================================================================

/** Fisher-Yates. Returns a new array; never mutates the input. */
function shuffle(items, rng) {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    // Defensive: a badly behaved rng must not produce an out-of-range index.
    let j = Math.floor(rng() * (i + 1));
    if (!Number.isFinite(j) || j < 0) j = 0;
    if (j > i) j = i;
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** Coerce whatever came back from the DB into a clean array of unique, non-empty ids. */
function uniqueIds(maybeList) {
  if (!Array.isArray(maybeList)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of maybeList) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function pluralise(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ===========================================================================
// ROUND GENERATION
// ===========================================================================

/**
 * Build the ordered round list for a game.
 *
 * @param {Object} opts
 * @param {Record<string,string[]>} opts.pools  - { uid: [videoId, ...] }, only players whose scrape succeeded
 * @param {number} opts.roundCount              - requested number of rounds
 * @param {() => number} [rng]                  - injectable RNG, defaults to Math.random
 * @returns {{
 *   rounds: Array<{videoId: string, ownerUid: string}>,
 *   requested: number,
 *   available: number,
 *   clamped: boolean,
 *   eligibleOwners: string[],
 *   droppedAmbiguous: string[],
 *   message: string|null
 * }}
 */
export function generateRounds({ pools, roundCount } = {}, rng = Math.random) {
  const safePools = pools && typeof pools === 'object' ? pools : {};

  const requested =
    Number.isFinite(roundCount) && roundCount > 0 ? Math.floor(roundCount) : 0;

  // --- 1. de-dupe each pool, then find videos that belong to two or more players.
  // Those have no unique correct answer, so they are excluded entirely.
  const cleaned = new Map(); // uid -> string[]
  const owners = new Map(); // videoId -> count of distinct pools it appears in
  for (const uid of Object.keys(safePools)) {
    const ids = uniqueIds(safePools[uid]);
    cleaned.set(uid, ids);
    for (const id of ids) owners.set(id, (owners.get(id) || 0) + 1);
  }

  const ambiguous = new Set();
  for (const [id, count] of owners) if (count > 1) ambiguous.add(id);
  const droppedAmbiguous = [...ambiguous].sort();

  // --- 2. usable pools + eligible owners (>= 1 usable video).
  const usable = new Map();
  for (const [uid, ids] of cleaned) {
    const keep = ids.filter((id) => !ambiguous.has(id));
    if (keep.length > 0) usable.set(uid, keep);
  }

  // Shuffle the owner order so the round-robin doesn't always start with the same
  // player, and shuffle inside each pool so the same account doesn't serve up the
  // same videos game after game.
  const eligibleOwners = shuffle([...usable.keys()], rng);
  const deck = new Map(); // uid -> shuffled videoIds
  for (const uid of eligibleOwners) deck.set(uid, shuffle(usable.get(uid), rng));

  const totalUsable = eligibleOwners.reduce((n, uid) => n + deck.get(uid).length, 0);
  const available = Math.min(requested, totalUsable);

  // --- 3. decide HOW MANY rounds each owner gets: round-robin over the shuffled
  // owners, one at a time, skipping anyone who has run out. This is what makes the
  // distribution as even as the pool sizes allow.
  const quota = new Map(eligibleOwners.map((uid) => [uid, 0]));
  let assigned = 0;
  while (assigned < available) {
    let progressed = false;
    for (const uid of eligibleOwners) {
      if (assigned >= available) break;
      if (quota.get(uid) >= deck.get(uid).length) continue;
      quota.set(uid, quota.get(uid) + 1);
      assigned++;
      progressed = true;
    }
    if (!progressed) break; // everyone exhausted; can't happen while assigned < available
  }

  // --- 4. decide the ORDER: shuffle the multiset of owner slots.
  //
  // The quotas from step 3 already guarantee balance, so the order only has to be
  // unpredictable. An earlier version picked "whoever is owed the most, but never twice
  // in a row", which is perfectly balanced and perfectly GUESSABLE: with two players it
  // produces A,B,A,B,A,B and everyone works out the pattern by round three. Randomising
  // instead means the same owner can occasionally come up twice running — that is the
  // point, not a defect.
  const order = shuffle(
    [...quota.entries()].flatMap(([uid, n]) => Array.from({ length: n }, () => uid)),
    rng
  );

  // --- 5. deal the actual videos off the top of each shuffled pool.
  const cursor = new Map(eligibleOwners.map((uid) => [uid, 0]));
  const rounds = [];
  for (const uid of order) {
    const i = cursor.get(uid);
    const videoId = deck.get(uid)[i];
    if (videoId === undefined) continue; // belt and braces: never emit a broken round
    cursor.set(uid, i + 1);
    rounds.push({ videoId, ownerUid: uid });
  }

  const actual = rounds.length;
  const clamped = actual < requested;

  return {
    rounds,
    requested,
    available: actual,
    clamped,
    eligibleOwners,
    droppedAmbiguous,
    message: clamped
      ? `Only ${pluralise(actual, 'round')} available — ${pluralise(
          eligibleOwners.length,
          'player'
        )} had usable videos`
      : null,
  };
}

// ===========================================================================
// SCORING
// ===========================================================================

/**
 * +1 per voter whose guess equals the owner. The owner never scores this round,
 * so if their uid somehow appears in `votes` it is ignored.
 *
 * @param {Record<string,string>} votes - { voterUid: guessedUid }
 * @param {string} ownerUid
 * @returns {{ correct: string[], incorrect: string[] }}
 */
export function scoreRound(votes, ownerUid) {
  const correct = [];
  const incorrect = [];
  const safeVotes = votes && typeof votes === 'object' ? votes : {};
  for (const voterUid of Object.keys(safeVotes)) {
    if (voterUid === ownerUid) continue;
    if (safeVotes[voterUid] === ownerUid) correct.push(voterUid);
    else incorrect.push(voterUid);
  }
  return { correct, incorrect };
}

/**
 * Who still needs to vote this round. The owner never votes and is excluded from
 * the all-voted check. Players whose scrape failed are still eligible voters —
 * pass every player in the room.
 *
 * @param {string[]} playerUids
 * @param {string} ownerUid
 * @param {Record<string,string>} votes
 * @returns {{ eligible: string[], voted: string[], pending: string[], allVoted: boolean }}
 */
export function voteProgress(playerUids, ownerUid, votes) {
  const safeVotes = votes && typeof votes === 'object' ? votes : {};
  const seen = new Set();
  const eligible = [];
  for (const uid of Array.isArray(playerUids) ? playerUids : []) {
    if (typeof uid !== 'string' || !uid) continue;
    if (uid === ownerUid || seen.has(uid)) continue;
    seen.add(uid);
    eligible.push(uid);
  }

  const voted = [];
  const pending = [];
  for (const uid of eligible) {
    const v = safeVotes[uid];
    if (typeof v === 'string' && v) voted.push(uid);
    else pending.push(uid);
  }

  return { eligible, voted, pending, allVoted: pending.length === 0 };
}

// ===========================================================================
// LEADERBOARD
// ===========================================================================

/**
 * Sorted high to low. Tied players share a rank and the next rank skips
 * accordingly (1, 2, 2, 4). Ties are ordered by name then uid so the board never
 * jitters between renders.
 *
 * @param {Record<string, {name?:string, score?:number}>} players
 * @returns {Array<{uid:string, name:string, score:number, rank:number}>}
 */
export function leaderboard(players) {
  const safePlayers = players && typeof players === 'object' ? players : {};

  const rows = Object.keys(safePlayers).map((uid) => {
    const p = safePlayers[uid] || {};
    return {
      uid,
      name: typeof p.name === 'string' ? p.name : '',
      score: Number.isFinite(p.score) ? p.score : 0,
    };
  });

  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
  });

  let rank = 0;
  let lastScore = null;
  return rows.map((row, i) => {
    if (lastScore === null || row.score !== lastScore) {
      rank = i + 1;
      lastScore = row.score;
    }
    return { ...row, rank };
  });
}
