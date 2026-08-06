// Minimal QR encoder — byte mode, EC level M, versions 1..10.
//
// Self-contained on purpose: the host screen must work with no CDN and no network, and
// shipping a whole QR library for one short URL is overkill. Scope is exactly what this
// game needs (a URL of a few dozen characters) and it throws rather than truncating if
// the payload will not fit.
//
// Correctness is verified by test/qr.test.mjs, which renders a code and decodes it back
// with a real decoder (jsqr) — do not "fix" anything here without re-running that.

// --- GF(256) arithmetic for Reed-Solomon ------------------------------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // QR's primitive polynomial
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Generator polynomial for `degree` EC codewords. */
function rsPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    // Multiply poly by (x + a^i). Index 0 is the HIGHEST-degree coefficient, so the
    // "* x" term keeps its index and the "* a^i" term moves down one. Swapping these
    // two lines still produces a correct-looking polynomial at degree 1 and diverges
    // from degree 2 onward — which is why this needs the published test vector.
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= mul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(data, ecLen) {
  const gen = rsPoly(ecLen);
  const res = new Array(ecLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    for (let i = 0; i < ecLen; i++) res[i] ^= mul(gen[i + 1], factor);
  }
  return res;
}

// --- version tables (EC level M only) ---------------------------------------
// [ecCodewordsPerBlock, group1Blocks, group1DataCodewords, group2Blocks, group2DataCodewords]
const EC_M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
};

const ALIGN = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

const dataCapacity = (v) => {
  const [, g1, d1, g2, d2] = EC_M[v];
  return g1 * d1 + g2 * d2;
};

// --- bit stream --------------------------------------------------------------
class Bits {
  constructor() {
    this.bits = [];
  }
  push(value, len) {
    for (let i = len - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
  get length() {
    return this.bits.length;
  }
}

function encodeData(text, version) {
  const bytes = new TextEncoder().encode(text);
  const capacityBits = dataCapacity(version) * 8;
  const countBits = version <= 9 ? 8 : 16;

  const bs = new Bits();
  bs.push(0b0100, 4); // byte mode
  bs.push(bytes.length, countBits);
  for (const b of bytes) bs.push(b, 8);

  if (bs.length > capacityBits) return null; // caller tries a bigger version

  bs.push(0, Math.min(4, capacityBits - bs.length)); // terminator
  while (bs.length % 8 !== 0) bs.bits.push(0);

  const codewords = [];
  for (let i = 0; i < bs.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bs.bits[i + j];
    codewords.push(byte);
  }
  const pad = [0xec, 0x11];
  let k = 0;
  while (codewords.length < dataCapacity(version)) codewords.push(pad[k++ % 2]);
  return codewords;
}

/** Split into blocks, RS-encode each, then interleave as the spec requires. */
function buildCodewords(data, version) {
  const [ecLen, g1, d1, g2, d2] = EC_M[version];
  const blocks = [];
  let pos = 0;
  for (let i = 0; i < g1; i++) {
    const d = data.slice(pos, pos + d1);
    pos += d1;
    blocks.push({ data: d, ec: rsEncode(d, ecLen) });
  }
  for (let i = 0; i < g2; i++) {
    const d = data.slice(pos, pos + d2);
    pos += d2;
    blocks.push({ data: d, ec: rsEncode(d, ecLen) });
  }

  const out = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++)
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

// --- matrix ------------------------------------------------------------------
function makeMatrix(version) {
  const size = 17 + 4 * version;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

  const setF = (r, c, v) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      m[r][c] = v;
      reserved[r][c] = true;
    }
  };

  // finder patterns + separators
  for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setF(br + r, bc + c, inside ? (ring || core ? 1 : 0) : 0);
      }
  }

  // timing patterns
  for (let i = 8; i < size - 8; i++) {
    setF(6, i, i % 2 === 0 ? 1 : 0);
    setF(i, 6, i % 2 === 0 ? 1 : 0);
  }

  // alignment patterns
  const centers = ALIGN[version];
  for (const r of centers)
    for (const c of centers) {
      // skip the three that would collide with finder patterns
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++)
        for (let dc = -2; dc <= 2; dc++) {
          const edge = Math.abs(dr) === 2 || Math.abs(dc) === 2;
          setF(r + dr, c + dc, edge || (dr === 0 && dc === 0) ? 1 : 0);
        }
    }

  setF(size - 8, 8, 1); // dark module

  // reserve format areas (values written later)
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) setF(8, i, 0);
    if (m[i][8] === null) setF(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][size - 1 - i] === null) setF(8, size - 1 - i, 0);
    if (m[size - 1 - i][8] === null) setF(size - 1 - i, 8, 0);
  }
  // reserve version info
  if (version >= 7) {
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 3; j++) {
        setF(size - 11 + j, i, 0);
        setF(i, size - 11 + j, 0);
      }
  }

  return { m, reserved, size };
}

function placeData(m, reserved, size, codewords) {
  let bitIndex = 0;
  const nextBit = () => {
    const byte = codewords[bitIndex >> 3];
    const bit = byte === undefined ? 0 : (byte >> (7 - (bitIndex & 7))) & 1;
    bitIndex++;
    return bit;
  };

  let upward = true;
  for (let right = size - 1; right > 0; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is skipped entirely
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const col of [right, right - 1]) {
        if (reserved[row][col]) continue;
        m[row][col] = nextBit();
      }
    }
    upward = !upward;
  }
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** Standard penalty scoring, used to pick the mask that scans most reliably. */
function penalty(m, size) {
  let score = 0;

  // rule 1: runs of 5+ same-colour modules
  for (let i = 0; i < size; i++) {
    for (const line of [m[i], m.map((row) => row[i])]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        if (line[j] === line[j - 1]) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  }

  // rule 2: 2x2 blocks of one colour
  for (let r = 0; r < size - 1; r++)
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }

  // rule 3: finder-like 1:1:3:1:1 patterns
  const PAT1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const PAT2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const match = (line, start, pat) => pat.every((v, k) => line[start + k] === v);
  for (let i = 0; i < size; i++) {
    const row = m[i];
    const col = m.map((r) => r[i]);
    for (let j = 0; j + 11 <= size; j++) {
      if (match(row, j, PAT1) || match(row, j, PAT2)) score += 40;
      if (match(col, j, PAT1) || match(col, j, PAT2)) score += 40;
    }
  }

  // rule 4: overall dark/light balance
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c]) dark++;
  const pct = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;

  return score;
}

/** BCH(15,5) format info for EC level M, XORed with the spec's mask. */
function formatBits(maskIndex) {
  const ecBits = 0b00; // level M
  let data = (ecBits << 3) | maskIndex;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) * 0x537);
  return (((data << 10) | rem) ^ 0b101010000010010) & 0x7fff;
}

/** Golay(18,6) version info, versions 7+. */
function versionBits(version) {
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >> 11) * 0x1f25);
  return (version << 12) | rem;
}

function applyFormat(m, size, maskIndex) {
  const bits = formatBits(maskIndex);
  // MSB first: bit 0 of the placement order is the HIGH bit of the 15-bit string.
  // Reading it LSB-first is a subtle failure — the format string is nearly a
  // palindrome, so only 4 of 15 bits land wrong and the code still looks plausible.
  const get = (i) => (bits >> (14 - i)) & 1;
  for (let i = 0; i <= 5; i++) m[8][i] = get(i);
  m[8][7] = get(6);
  m[8][8] = get(7);
  m[7][8] = get(8);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = get(i);

  // Second copy. The vertical run is bits 0..6 ONLY — (size-8, 8) is the dark module,
  // not a format module. Running it to bit 7 overwrites that bit with the dark module
  // and silently corrupts the whole format block, which makes every code undecodable.
  for (let i = 0; i <= 6; i++) m[size - 1 - i][8] = get(i);
  for (let i = 7; i <= 14; i++) m[8][size - 15 + i] = get(i);
  m[size - 8][8] = 1; // dark module
}

function applyVersion(m, size, version) {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = (bits >> i) & 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    m[size - 11 + c][r] = bit;
    m[r][size - 11 + c] = bit;
  }
}

/**
 * @param {string} text
 * @returns {{size:number, modules:boolean[][], version:number}}
 */
export function encodeQR(text, forceMask = null) {
  let version = 0;
  let data = null;
  for (let v = 1; v <= 10; v++) {
    const d = encodeData(text, v);
    if (d) {
      version = v;
      data = d;
      break;
    }
  }
  if (!data) throw new Error(`QR payload too long for version 10: ${text.length} chars`);

  const codewords = buildCodewords(data, version);
  const { m, reserved, size } = makeMatrix(version);
  placeData(m, reserved, size, codewords);

  // Try every mask, keep the lowest-penalty one.
  let best = null;
  for (let mi = 0; mi < 8; mi++) {
    if (forceMask !== null && mi !== forceMask) continue; // test hook
    const cand = m.map((row) => row.slice());
    for (let r = 0; r < size; r++)
      for (let c = 0; c < size; c++) if (!reserved[r][c] && MASKS[mi](r, c)) cand[r][c] ^= 1;
    applyFormat(cand, size, mi);
    applyVersion(cand, size, version);
    const score = penalty(cand, size);
    if (!best || score < best.score) best = { score, matrix: cand, mask: mi };
  }

  return { size, version, mask: best.mask, modules: best.matrix.map((row) => row.map(Boolean)) };
}

/** Draw into a <canvas>, sized to fit `cssSize` px with a 4-module quiet zone. */
export function renderQR(canvas, text, cssSize = 320) {
  const { size, modules } = encodeQR(text);
  const quiet = 4;
  const total = size + quiet * 2;
  const scale = Math.max(1, Math.floor(cssSize / total));
  const px = total * scale;

  canvas.width = px;
  canvas.height = px;
  canvas.style.width = px + 'px';
  canvas.style.height = px + 'px';

  const ctx = canvas.getContext('2d');
  // Always light background + dark modules: scanners need the contrast regardless of
  // the page's dark theme.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = '#000';
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      if (modules[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);

  return { size, scale, px };
}
