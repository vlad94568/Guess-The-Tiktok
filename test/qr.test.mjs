// Verifies docs/js/qr.js by DECODING what it produces with a real, independent decoder
// (jsqr). A QR encoder that is subtly wrong still renders a plausible-looking square, so
// eyeballing it proves nothing — this round-trips the data instead.
//
// Run: node --test "test/qr.test.mjs"

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { encodeQR } from '../docs/js/qr.js';

const require = createRequire(import.meta.url);
const jsQR = require('../scraper/node_modules/jsqr').default ?? require('../scraper/node_modules/jsqr');

/**
 * Render the module matrix into an RGBA bitmap with a quiet zone, scaled up — jsqr
 * needs a few pixels per module and a margin to lock on, exactly like a real camera.
 */
function toImageData(text, scale = 6, quiet = 4) {
  const { size, modules, version } = encodeQR(text);
  const total = (size + quiet * 2) * scale;
  const data = new Uint8ClampedArray(total * total * 4).fill(255);

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!modules[r][c]) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = (c + quiet) * scale + dx;
          const y = (r + quiet) * scale + dy;
          const i = (y * total + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: total, height: total, version, size };
}

const roundTrip = (text) => {
  const img = toImageData(text);
  const res = jsQR(img.data, img.width, img.height);
  return { decoded: res?.data ?? null, version: img.version, size: img.size };
};

test('round-trips the real player join URL', () => {
  const url = 'https://vlad94568.github.io/Guess-The-Tiktok/play.html';
  const { decoded, version } = roundTrip(url);
  assert.equal(decoded, url, `decoded "${decoded}" (version ${version})`);
});

test('round-trips a short string (version 1 path)', () => {
  const { decoded } = roundTrip('ABCD');
  assert.equal(decoded, 'ABCD');
});

test('round-trips a URL carrying a room code', () => {
  const url = 'https://vlad94568.github.io/Guess-The-Tiktok/play.html?room=WXYZ';
  assert.equal(roundTrip(url).decoded, url);
});

test('round-trips across a range of lengths, crossing version boundaries', () => {
  for (const len of [1, 10, 25, 40, 60, 90, 120, 160, 200]) {
    const text = 'x'.repeat(len);
    const { decoded, version } = roundTrip(text);
    assert.equal(decoded, text, `length ${len} failed at version ${version}`);
  }
});

test('round-trips non-ASCII (UTF-8 byte mode)', () => {
  const text = 'café — naïve 🎉';
  assert.equal(roundTrip(text).decoded, text);
});

test('picks the smallest version that fits', () => {
  assert.equal(encodeQR('hi').version, 1);
  const big = encodeQR('x'.repeat(200)).version;
  assert.ok(big >= 9 && big <= 10, `expected version 9-10 for 200 chars, got ${big}`);
});

test('matrix is square, sized 17 + 4*version', () => {
  for (const text of ['a', 'x'.repeat(100)]) {
    const { size, version, modules } = encodeQR(text);
    assert.equal(size, 17 + 4 * version);
    assert.equal(modules.length, size);
    for (const row of modules) assert.equal(row.length, size);
  }
});

test('throws rather than silently truncating an oversized payload', () => {
  assert.throws(() => encodeQR('y'.repeat(400)), /too long/i);
});
