# Whose TikTok?

A local party game. Everyone is in the same room. One host shares their screen; 2–10 players
join from their phones. Each round plays one TikTok from one player's likes or reposts, and
everyone else votes on whose it is.

- **Host screen** (`host.html`) — big display. Shows the room code, the embedded TikTok, the
  countdown and the leaderboard. The host does not play and does not connect an account.
- **Player screen** (`play.html`) — phone. Voting buttons and your score. Never shows the video.

---

## Read this first: what actually works

The game depends on reading a public TikTok profile's Liked and Reposted videos. That was
probed empirically before any code was written (2026-08-01), against live TikTok:

| Capability | Status |
|---|---|
| Load a public profile headless | Works — no login wall, no captcha |
| **Reposts** | **Works.** `/api/repost/item_list/`, ~120 ids in ~4s |
| **Likes** | **Works only if the player enabled public likes** — see below |
| Detect "likes are private" | Works, via the `openFavorite` flag |

### The likes caveat — read this before choosing a mode

TikTok defaults **Liked videos to private**. In a scan of 31 public accounts, exactly **one**
had them public. So `likes` and `both` modes will report `likes_private` for most players
unless each of them first goes to
**TikTok → Profile → ☰ → Settings and privacy → Privacy → Liked videos → Everyone**.

`reposts` mode needs no setup from anyone and is the reliable default. **Use `reposts` unless
your group has explicitly turned public likes on.**

There is a nasty detail the scraper handles for you: when likes are private the TikTok endpoint
returns HTTP 200 with an empty list and no error — identical to a user with no likes. The only
reliable signal is the `openFavorite` flag on the profile, which is why the scraper reads it
before ever calling the likes endpoint.

### This scrapes undocumented endpoints

The scraper reads endpoints TikTok does not publish or support. **It will break when TikTok
changes their site.** Everything version-fragile is isolated at the top of `scraper/tiktok.mjs`
so it can be fixed in one place. Only run it against accounts whose owners are in the room and
have agreed to it.

---

## Setup

### 1. Install prerequisites

- **Node.js 18+** (built and tested on 24.18.1)
- **Chrome or Edge** on the host machine. **Safari will not work** — see "Browser support".

### 2. Create the Firebase project

Do these in order. Enabling Anonymous auth (3) and adding your Authorized domains (5) are the
two everybody skips, and both fail with unhelpful, generic errors.

Firebase reorganises its console navigation fairly often, so the sidebar paths below may not
match what you see. The **"Search for products"** box at the top of the sidebar is stable — type
the product name and go straight there rather than hunting through categories.

1. Go to <https://console.firebase.google.com> and **Add project**. Analytics is not needed.
   Use a dedicated project; do not bolt this onto an unrelated existing one.
2. **Realtime Database → Create Database.** (Currently under *Databases & Storage → NoSQL*.)
   **Pick Realtime Database, not Firestore** — they sit next to each other in the menu and this
   game will not work on Firestore. Choose a location and start in **locked mode**; the rules in
   this repo replace the defaults anyway. The free **Spark** plan is sufficient.
3. **Authentication → Get started → Sign-in method → Anonymous → Enable.**
   The game signs every player in anonymously; nothing works without this.
4. **Project settings (gear icon) → General → Your apps → Web (`</>`)**. Register the app, then
   copy the `firebaseConfig` object and paste it over the `REPLACE_ME` placeholder in
   [`docs/js/firebase.js`](docs/js/firebase.js).
5. **Authentication → Settings → Authorized domains → Add domain.** Add `<your-user>.github.io`
   (and `localhost` if it is not already listed). **Anonymous sign-in fails from an unlisted
   domain and the error message does not tell you that.**
6. In [Google Cloud console → Credentials](https://console.cloud.google.com/apis/credentials),
   restrict the browser API key to those same domains (HTTP referrers). Optional but recommended.

### 3. Deploy the security rules

```bash
npx firebase-tools deploy --only database
```

The rules are the only thing protecting the data — see "Why the Firebase config is in the repo".

### 4. Run the scraper (host machine only)

```bash
cd scraper && npm install && npm start
```

Serves `http://localhost:8787`. The host page shows a green/red indicator for it.

Before letting phones hit the Pages deployment, pin the CORS allowlist to your own origin
instead of the default any-`*.github.io` pattern:

```bash
cd scraper && GH_PAGES_ORIGIN=https://vlad94568.github.io npm start
```

On Windows PowerShell that is `$env:GH_PAGES_ORIGIN='https://vlad94568.github.io'; npm start`.

### 5. Serve the site

```bash
npx serve docs
```

Then open `http://localhost:3000/host.html`.

---

## Running a game

1. Host opens `host.html`, picks a mode, round count and timer, and creates a room.
2. Players open `play.html` on their phones, enter the room code, their name and their TikTok
   `@handle`.
3. Host clicks **Start Game**. Pools are scraped one player at a time; per-player progress and
   failure reasons appear on the host screen.
4. Each round: the video plays on the host screen, players vote on their phones, host clicks
   **Next Round**.

## Hosting topology

Only the **host** page ever talks to the scraper; phones talk exclusively to Firebase.

**Recommended (reliable):** the host runs the scraper *and* serves the site locally, opening
`http://localhost:3000/host.html`. Players open
`https://<user>.github.io/<repo>/play.html`. The host's call to the scraper is then a plain
same-origin localhost request — no mixed content, no Private Network Access preflight. Both
sides reach the same Firebase room, so the split origin is invisible to the game.

**Convenient (fragile):** everyone including the host uses the GitHub Pages URL. This depends on
the browser allowing an HTTPS page to reach `http://localhost:8787`. Chrome and Edge permit it
provided the scraper answers the CORS preflight with `Access-Control-Allow-Private-Network: true`
(it does). Safari blocks it outright.

### Browser support

`http://localhost` is treated as a trustworthy origin by Chrome and Edge, so the scraper call is
not blocked as mixed content. **Safari blocks HTTPS → localhost entirely, so the host must use
Chrome or Edge.** If `/health` is unreachable the host screen says so explicitly rather than
leaving a dead button.

## Deploying to GitHub Pages

No build step and no Actions workflow. Push to the default branch, then
**Settings → Pages → Build and deployment → Deploy from a branch → `main` / `/docs`**.

The site lives in `docs/` because GitHub Pages can only serve from the repo root or `/docs` —
never `public/`. `docs/.nojekyll` stops Jekyll from mangling the site. **Every asset path is
relative** (`js/host.js`, not `/js/host.js`) so the site works from the
`https://<user>.github.io/<repo>/` subpath.

`firebase.json` is kept so Firebase Hosting stays available as a fallback, but Pages is the
target. Firebase is used for database and auth only.

## Local development with the emulator

You do not need a real Firebase project to develop or test:

```bash
npx firebase-tools emulators:start --project whose-tiktok-dev
```

Then append `?emu=1` to the URL — `http://localhost:3000/host.html?emu=1`. The flag is stored in
`sessionStorage` for the tab, so navigating to `play.html` stays on the emulator.

Emulator mode is opt-in by query param rather than inferred from the hostname on purpose: the
recommended topology puts the host on `localhost` and the players on `github.io`, and a hostname
check would silently split them across two different databases.

---

## Why the Firebase config is in the repo

The Firebase web config is committed and that is fine — it is public by design and identifies
the project, it does not grant access. There is no workaround to "hide" it and you should not
add one.

**It does mean `database.rules.json` is the only thing protecting the data.** Assume a player
opens devtools and reads every byte their client is allowed to fetch. That assumption drives the
rules below.

## Security rules, block by block

Read alongside [`database.rules.json`](database.rules.json).

**Root `.read` / `.write` = false.** Default deny. Nothing is reachable unless a rule below
grants it. Nobody can enumerate `/rooms`.

**`rooms/$code/meta`** — readable by any signed-in user (players need the mode, status, round
count). Writable only by the uid already recorded in `hostUid`, and a creating write must claim
`hostUid === auth.uid`, so a room cannot be created on someone else's behalf or taken over
afterwards. `.validate` pins `mode` and `status` to their legal values, bounds `roundCount` and
`timerSecs`, and forces `code` to equal the key — so a room cannot lie about its own id.
`$other: false` rejects unknown fields anywhere in `meta`.

**The 12-hour clause.** Every write path carries
`meta/createdAt + 43200000 > now`, so abandoned rooms become read-only and die. `createdAt`
itself is validated as `newData.val() === now`, meaning it must be written with the server
timestamp and can never be back-dated to extend a room's life.

**`rooms/$code/players`** — readable by any signed-in user; the phones need everyone's name to
render vote buttons. Writes are split per field, which is the whole point:
- `name` and `handle` — writable by that player **only while `meta.status === 'lobby'`**, so
  nobody can rename themselves mid-round to confuse the vote. Length-bounded.
- `score` — **writable only by `hostUid`.** A player cannot award themselves points.
- `poolStatus` / `poolError` / `poolCount` — host only; these are scrape results.
- `joinedAt` — the player may set it once (`!data.exists()`), never rewrite it.

**`rooms/$code/pool` — readable only by `hostUid`.** This node maps every player to their video
ids, so it trivially reveals every answer for the whole game. It is the single most sensitive
node in the database and no player may read any part of it.

**`rounds` — host-only write at the collection level, as well as per round.** The host writes
the whole generated plan in a single `set()` to `rooms/$code/rounds`, and RTDB grants write
permission only at or above the path being written — a rule on `rounds/$i` alone does not
authorise a write to `rounds`. Players never satisfy this rule, so their vote writes still fall
through to the much tighter per-leaf rule below.

**`rounds/$i` — read denied by default, then re-granted leaf by leaf.** The host gets a blanket
read. Players get nothing at the round level and are then granted exactly four things:
- `phase` and `endsAt` and `startedAt` — needed to drive the UI and the countdown.
- `videoId` — **not granted.** Players never learn the video id, so they cannot look it up.
- `ownerUid` — **granted only when `phase === 'reveal'`.** This is the answer. Before reveal the
  read is rejected by the server, not merely hidden by the UI. A player watching this path in
  devtools gets `permission_denied` until the host flips the phase.

**`rounds/$i/sitOut/$uid` — readable only when `$uid === auth.uid`.** The owner's phone has to
know to show "this one's yours, sit tight", but telling it that is telling it the answer. So the
host writes a single-key node `sitOut: { <ownerUid>: true }`, and each player may read only
their own key. You can check whether *you* are the owner; you cannot enumerate the node to find
out who is. The parent has no read rule, so listing it fails.

**`rounds/$i/votes`** — the node is readable by everyone only at `phase === 'reveal'`; the host
can read it throughout (that is what drives the live "voted: 3/5" counter, which shows *who* has
voted but never *what*). Each player may additionally read `votes/$myUid` at any time so their
own phone can lock in its UI.

Vote writes are the tightest rule in the file. `votes/$voterUid` is writable only when **all** of:
- `auth.uid === $voterUid` — you cannot write into someone else's slot;
- `!data.exists()` — one vote, no changing your mind;
- `phase === 'playing'` — not before, not after the lock;
- `ownerUid !== auth.uid` — the owner of the video cannot vote on it. Note the rule reads
  `ownerUid` to enforce this. Rules evaluate server-side with full read access, so this checks
  the secret without leaking it;
- the room is under 12 hours old.

And `.validate` requires the vote to be a string naming a player who actually exists in the room,
and rejects `newData.val() === auth.uid` — no voting for yourself.

**`currentRound`** — readable by all, writable by host only.

---

## Tests

```bash
node --test "test/game.test.mjs"     # 42 pure-logic tests, no deps, no emulator
node --test "test/rules.test.mjs"    # 22 security-rules tests, needs the emulator
node test/e2e.mjs                    # full game in 3 browser contexts, needs everything
```

Note `node --test test/` (a bare directory) does **not** work on Node 24 — it treats the
argument as a file, not a directory to recurse. Use `node --test` with no argument for
auto-discovery, or quote a glob as above.

`e2e.mjs` needs the emulator, a static server on :3000 and the scraper on :8787 all running. It
drives one host and two players in three **isolated** browser contexts — isolation matters,
because Firebase persists the anonymous session per origin, so two tabs in one profile would
silently be the same player. It writes screenshots to `test/out/`.

### Verifying the rules

The two attacks that matter are proven to fail in `test/rules.test.mjs`, run against the
emulator: a non-host authenticated uid **cannot read `ownerUid` mid-round**, and **cannot write
another player's vote**. `e2e.mjs` re-proves the first one from a real player page, the way a
player with devtools would actually try it.

Two traps in that suite, both of which silently make every negative test pass while proving
nothing — the suite now self-checks against both:

- **The namespace.** The emulator applies `database.rules.json` only to the
  `<project>-default-rtdb` namespace. Any other namespace gets wide-open rules.
- **How the token is sent.** The emulator's REST API treats *any*
  `Authorization: Bearer <token>` — including a genuine user ID token — as an admin
  credential and skips rule evaluation. Passing the same token as the `?auth=` query
  parameter instead makes it evaluate rules as that user.

---

## Project layout

```
docs/                  static site (GitHub Pages serves this folder)
  index.html           landing
  host.html            host screen
  play.html            player screen
  css/style.css
  js/firebase.js       init, anon auth, exported db handle
  js/db.js             ALL RTDB reads/writes — no other file touches a path string
  js/game.js           pure logic: round generation, scoring (no Firebase, unit-tested)
  js/embed.js          TikTok embed iframe mount/unmount
  js/host.js           host controller
  js/play.js           player controller
scraper/               LOCAL node service, host machine only
test/                  node --test suites
database.rules.json
firebase.json
```

`db.js` is the only module that knows RTDB path strings. `game.js` has no Firebase imports and is
tested standalone. Controllers hold no game logic.

### Injecting a pool by hand

There is deliberately no paste-a-video UI, but `db.js` exposes a seam for debugging without the
scraper. From the host page console:

```js
const db = await import('./js/db.js');
await db.writePool('ABCD', '<uid>', ['7301234567890123456', '7659456798717447438']);
await db.setPlayerPoolStatus('ABCD', '<uid>', { poolStatus: 'ok', poolCount: 2 });
```
