// Disk cache for scrape results.
//
// Keyed `handle:mode`, 24h TTL. The point is that re-running a game (or a host
// reloading the page mid-lobby) does not re-scrape TikTok — every avoided scrape
// is ~10s of browser work and one less request TikTok can rate-limit us for.
//
// Only SUCCESSFUL scrapes are cached. Failures (likes_private, no_videos, ...) are
// deliberately not persisted: they are usually a property of the account's current
// settings, and caching them for 24h would mean a user who flips their likes to
// public still gets told "private" for the rest of the day. Failures are cheap to
// re-derive relative to that confusion.

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const CACHE_DIR = path.join(HERE, '.cache');
export const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * BUMP THIS whenever a change alters what a scrape *returns* — pool size, sampling,
 * filtering, mode semantics.
 *
 * Without it, changing the limits does nothing for up to 24h: entries written by the old
 * code stay valid and keep being served, so the game looks unchanged and you conclude the
 * edit did not work. That happened for real when the per-source cap went 60 -> 50/100;
 * every live game kept getting 60 because the caches were only a few hours old.
 *
 *   v1: 60 ids per scrape, newest-first
 *   v2: 50 per source, randomly sampled; 'both' = up to 100; likes prefer last 90 days
 *   v3: fetch pool deepened to 1000 before sampling
 */
export const CACHE_VERSION = 3;

/** Filesystem-safe filename for a `handle:mode` key. Handles are already validated
 *  to [A-Za-z0-9._] upstream, but sanitise anyway so a bad key can never escape the dir. */
function keyToFile(handle, mode) {
  const safe = `${handle}:${mode}`.replace(/[^a-zA-Z0-9._:-]/g, '_').replace(/:/g, '__');
  return path.join(CACHE_DIR, `${safe}.json`);
}

async function ensureDir() {
  if (!existsSync(CACHE_DIR)) await mkdir(CACHE_DIR, { recursive: true });
}

/**
 * @returns {Promise<{videos: string[], savedAt: number} | null>} null when missing/expired/corrupt.
 */
export async function readCache(handle, mode) {
  const file = keyToFile(handle, mode);
  try {
    const raw = await readFile(file, 'utf8');
    const entry = JSON.parse(raw);
    if (!entry || !Array.isArray(entry.videos) || typeof entry.savedAt !== 'number') return null;
    // Written by an older build that returned a different shape/size — discard.
    if (entry.version !== CACHE_VERSION) {
      await rm(file, { force: true }).catch(() => {});
      return null;
    }
    if (Date.now() - entry.savedAt > TTL_MS) {
      await rm(file, { force: true }).catch(() => {});
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

export async function writeCache(handle, mode, videos, sources = null) {
  await ensureDir();
  const entry = { version: CACHE_VERSION, handle, mode, videos, sources, savedAt: Date.now() };
  await writeFile(keyToFile(handle, mode), JSON.stringify(entry, null, 2), 'utf8').catch(() => {});
  return entry;
}
