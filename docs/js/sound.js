// Host-screen sound effects.
//
// Synthesised with WebAudio rather than loaded from a file: the host screen is served
// from the local machine and must work with no network at all, and an <audio> tag would
// mean shipping a binary asset into a repo that otherwise has none (same reason qr.js
// encodes its own QR instead of calling a CDN).
//
// Browsers refuse to start an AudioContext without a user gesture, and a context created
// before one exists is stuck in 'suspended' forever. unlockAudio() is therefore called
// from the host's own button clicks — by the time a round can end, "Start game" has
// already been pressed.

let ctx = null;

/** Create/resume the context. Safe to call repeatedly; only does anything from a gesture. */
export function unlockAudio() {
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    if (!ctx) ctx = new Ctor();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch {
    // No audio available. Everything else on this screen still works.
  }
}

/**
 * Short two-note rise. Played when a round fills up on its own.
 *
 * @returns {boolean} whether a sound was actually started.
 */
export function ping() {
  try {
    unlockAudio();
    if (!ctx || ctx.state !== 'running') return false;

    const t0 = ctx.currentTime;
    // A5 then E6 — a rising fifth reads as "done" rather than as an error tone.
    for (const [freq, at] of [[880, 0], [1318.5, 0.11]]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle'; // softer than square/sawtooth on TV speakers
      osc.frequency.value = freq;

      // Ramped, never switched: a gain that jumps to or from zero clicks audibly.
      // exponentialRamp cannot touch 0, hence the near-silent floor.
      const start = t0 + at;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);

      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.3); // frees the node; oscillators are single-use
    }
    return true;
  } catch {
    return false;
  }
}
