// TikTok embed iframe: mount / unmount / reset.
//
// Hard requirement from the spec: the video must render as an embedded, PLAYING TikTok
// on the host screen — never a bare link.
//
// We use the v2 embed URL directly rather than TikTok's embed.js blockquote widget. The
// widget needs a network round-trip to rewrite a <blockquote> into an iframe and is
// flaky when the same slot is reused every round; the iframe is deterministic.
//
// Verified 2026-08-01.
const EMBED_URL = (videoId) => `https://www.tiktok.com/embed/v2/${videoId}`;

// TikTok's embed refuses to size itself below these; anything smaller crops the video.
const EMBED_WIDTH = 340;
const EMBED_HEIGHT = 720;

let current = null;

/**
 * Replace whatever is in `slot` with a fresh iframe for `videoId`.
 *
 * Always tears the old iframe down first. Reusing one iframe and only changing .src
 * leaves the previous video's audio playing in some builds, which is very obvious in a
 * room full of people.
 */
export function mountEmbed(slot, videoId) {
  unmountEmbed(slot);

  const iframe = document.createElement('iframe');
  iframe.src = EMBED_URL(videoId);
  iframe.width = String(EMBED_WIDTH);
  iframe.height = String(EMBED_HEIGHT);
  iframe.allow = 'autoplay; encrypted-media; fullscreen';
  iframe.referrerPolicy = 'strict-origin-when-cross-origin';
  iframe.title = 'TikTok video';
  // Keying the element by video id makes "did the round actually change?" visible in
  // devtools and lets us no-op a redundant mount.
  iframe.dataset.videoId = videoId;

  slot.appendChild(iframe);
  current = videoId;
  return iframe;
}

/** Remove the iframe and stop its audio. */
export function unmountEmbed(slot) {
  slot.replaceChildren();
  current = null;
}

/** The videoId currently mounted, or null. Lets the controller skip redundant remounts. */
export function currentEmbed() {
  return current;
}
