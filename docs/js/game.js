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

/**
 * The uid somebody guessed, from either vote shape.
 *
 * A vote used to be a bare uid string. Placement scoring needs to know WHEN it was cast, so
 * it is now `{ guess, at }` — but the old shape stays readable forever, because a phone can
 * be holding a cached copy of the old play.js and still be writing strings after the rules
 * and the site have moved on. Everything that reads a vote goes through here rather than
 * touching the value directly.
 *
 * DEPLOY ORDER: rules FIRST, then the site. The rules accepting both shapes covers new
 * rules + old site; it cannot cover old rules + new site, because `isString` rejects the
 * object outright and every vote in the room fails. See README.
 *
 * Returns '' for anything unusable, which every caller already treats as "has not voted".
 */
export function guessOf(vote) {
  if (typeof vote === 'string') return vote;
  if (vote && typeof vote === 'object' && typeof vote.guess === 'string') return vote.guess;
  return '';
}

/**
 * When a vote was cast, as a server-clock millisecond stamp, or Infinity if unknown.
 *
 * Infinity — not 0 — because an unknown time must sort LAST. A vote in the old shape has no
 * timestamp, and treating that as "very early" would hand the top of the ladder to whoever
 * voted before the upgrade landed.
 */
function voteTimeOf(vote) {
  const at = vote && typeof vote === 'object' ? vote.at : null;
  return typeof at === 'number' && Number.isFinite(at) ? at : Infinity;
}

/** The two scoring rules a room can be played under. `meta.scoring` holds one of these. */
export const SCORING = { PLACEMENT: 'placement', FLAT: 'flat' };

/**
 * What scoring a room uses, from its meta.
 *
 * An ABSENT field means FLAT, deliberately. Rooms created before this setting existed have
 * no `scoring` key and were played as flat +1, so that is what they must keep scoring as —
 * and if `meta/scoring` is ever rejected (rules not yet published, see README), the room
 * quietly plays the old way instead of silently switching everyone's points mid-game.
 *
 * New rooms always write the field explicitly, so the default only ever applies to rooms
 * that predate it.
 */
export function scoringMode(meta) {
  return meta?.scoring === SCORING.PLACEMENT ? SCORING.PLACEMENT : SCORING.FLAT;
}

/** 1 -> '1st'. Presentation, but pure, and both screens need exactly this. */
export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ===========================================================================
// ROUND GENERATION
// ===========================================================================

/**
 * Build the ordered round list for a game.
 *
 * Every eligible owner gets the SAME number of rounds, so `rounds.length` is always a
 * multiple of `eligibleOwners.length` and may end up above or below `roundCount`.
 *
 * @param {Object} opts
 * @param {Record<string,string[]>} opts.pools  - { uid: [videoId, ...] }, only players whose scrape succeeded
 * @param {number} opts.roundCount              - requested number of rounds
 * @param {() => number} [rng]                  - injectable RNG, defaults to Math.random
 * @returns {{
 *   rounds: Array<{videoId: string, ownerUid: string}>,
 *   requested: number,
 *   available: number,
 *   perOwner: number,
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

  // --- 3. decide HOW MANY rounds each owner gets: EXACTLY THE SAME NUMBER each.
  //
  // Nothing here is "as even as capacity allows" any more, because uneven is unfair.
  // The owner of a round sits it out and cannot score in it, so a player who owns 4
  // rounds out of 10 has three fewer chances to score than a player who owns 3. The
  // total round count is therefore always perOwner * eligibleOwners, and the requested
  // count is rounded to fit rather than honoured exactly.
  //
  // Two things cap perOwner: the requested rounds shared out, and the SMALLEST usable
  // pool — one player with only 3 videos means everybody owns 3 rounds, since going
  // past that would have to give someone else a fourth.
  const ownerCount = eligibleOwners.length;
  const smallestPool = ownerCount
    ? Math.min(...eligibleOwners.map((uid) => deck.get(uid).length))
    : 0;
  // The max(1, ...) matters when there are more players than requested rounds: a plain
  // floor gives 0 each and no game at all, so we overshoot the request instead. Equal
  // and slightly longer beats unequal or empty.
  const perOwner =
    ownerCount === 0 || requested === 0
      ? 0
      : Math.min(Math.max(1, Math.floor(requested / ownerCount)), smallestPool);

  // --- 4. decide the ORDER: shuffle the multiset of owner slots.
  //
  // The quotas from step 3 already guarantee balance, so the order only has to be
  // unpredictable. An earlier version picked "whoever is owed the most, but never twice
  // in a row", which is perfectly balanced and perfectly GUESSABLE: with two players it
  // produces A,B,A,B,A,B and everyone works out the pattern by round three. Randomising
  // instead means the same owner can occasionally come up twice running — that is the
  // point, not a defect.
  const order = shuffle(
    eligibleOwners.flatMap((uid) => Array.from({ length: perOwner }, () => uid)),
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

  // The round count is now allowed to move in BOTH directions, so the message says which
  // way and why. Callers should show it whenever it is non-null, not only when clamped.
  let message = null;
  if (requested > 0 && actual !== requested) {
    if (ownerCount === 0) {
      message = `Only ${pluralise(actual, 'round')} available — ${pluralise(
        ownerCount,
        'player'
      )} had usable videos`;
    } else if (actual > requested) {
      message =
        `Playing ${pluralise(actual, 'round')} instead of ${requested} — one each for ` +
        `${pluralise(ownerCount, 'player')}, so everyone's videos come up the same number of times`;
    } else if (smallestPool < Math.floor(requested / ownerCount)) {
      message =
        `Only ${pluralise(actual, 'round')} available — ${pluralise(perOwner, 'round')} each for ` +
        `${pluralise(ownerCount, 'player')}, capped by the smallest pool (${pluralise(
          smallestPool,
          'video'
        )})`;
    } else {
      message =
        `Rounded down to ${pluralise(actual, 'round')} — ${pluralise(perOwner, 'round')} each for ` +
        `${pluralise(ownerCount, 'player')}, so everyone's videos come up the same number of times`;
    }
  }

  return {
    rounds,
    requested,
    available: actual,
    perOwner,
    clamped,
    eligibleOwners,
    droppedAmbiguous,
    message,
  };
}

// ===========================================================================
// SCORING
// ===========================================================================

/**
 * Score one round. A wrong guess is never worth anything, under either scoring rule.
 *
 *   SCORING.FLAT      — every correct answer is worth 1, as the game originally scored.
 *   SCORING.PLACEMENT — a correct answer is worth more the sooner it came in.
 *
 * `place` is filled in either way, because the ORDER is real regardless of whether the room
 * pays for it; only `points` changes. That keeps the reveal screens free to mention who got
 * there first even in a flat game, and means the two modes differ in exactly one expression.
 *
 * The rest of this comment describes PLACEMENT.
 *
 * Correct voters are ranked against EACH OTHER, not against everyone who voted. Being slow
 * costs nothing if the people ahead of you were wrong, so the reward is for knowing the
 * answer quickly rather than for tapping quickly — which matters, because the video has to
 * be watched before anybody can sensibly answer.
 *
 * The ladder is sized by how many people COULD have voted, not by how many were right:
 *
 *   1st correct -> eligible voters, 2nd -> one less, ... floored at 1.
 *
 * Sizing it by the number of correct voters instead would mean the only person to get a
 * hard round right scored 1 — the minimum — while the first of five on an easy round scored
 * 5. Hard rounds should not pay less. To switch to that behaviour, `ladderTop` below
 * becomes `correctEntries.length`.
 *
 * The owner never scores their own round, so if their uid somehow appears in `votes` it is
 * ignored.
 *
 * @param {Record<string, string | {guess: string, at: number}>} votes - { voterUid: vote }
 * @param {string} ownerUid
 * @param {string[]} [playerUids] - everyone in the room, to size the ladder. Omit and the
 *   ladder falls back to the number of correct voters.
 * @param {'placement'|'flat'} [scoring] - defaults to PLACEMENT. Note this is NOT the same
 *   default as scoringMode(), which answers a different question: what an old ROOM that
 *   never recorded a preference should be played as. Callers pass scoringMode(meta) here.
 * @returns {{
 *   correct: string[],
 *   incorrect: string[],
 *   awards: Array<{uid: string, place: number, points: number}>,
 *   points: Record<string, number>
 * }}
 */
export function scoreRound(votes, ownerUid, playerUids = null, scoring = SCORING.PLACEMENT) {
  const safeVotes = votes && typeof votes === 'object' ? votes : {};
  const correctEntries = [];
  const incorrect = [];

  for (const voterUid of Object.keys(safeVotes)) {
    if (voterUid === ownerUid) continue;
    const vote = safeVotes[voterUid];
    if (guessOf(vote) === ownerUid) correctEntries.push({ uid: voterUid, at: voteTimeOf(vote) });
    else incorrect.push(voterUid);
  }

  // Earliest first. The uid tiebreak is not cosmetic: two votes CAN share a millisecond,
  // and the host screen, every phone and the awarded points all have to agree on who came
  // first. Sorting by time alone leaves that to whatever order the keys arrived in.
  correctEntries.sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
  });

  const eligibleCount = playerUids ? voteProgress(playerUids, ownerUid, safeVotes).eligible.length : 0;
  const ladderTop = Math.max(eligibleCount, correctEntries.length);

  const flat = scoring === SCORING.FLAT;
  const awards = correctEntries.map((entry, i) => ({
    uid: entry.uid,
    place: i + 1,
    // Floored at 1 so a correct answer is never worth nothing, however many people voted.
    points: flat ? 1 : Math.max(1, ladderTop - i),
  }));

  const points = {};
  for (const a of awards) points[a.uid] = a.points;

  return { correct: correctEntries.map((e) => e.uid), incorrect, awards, points };
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
    // guessOf, not a typeof check: a vote is `{guess, at}` now, and reading the raw value
    // would count every placement-scored vote as "has not voted" — the round would never
    // lock and the host would be pressing Reveal every single time.
    if (guessOf(safeVotes[uid])) voted.push(uid);
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
