// Builds the link the host opens to play a round's TikTok in a real tab.
//
// This replaced an in-page embed (iframe -> tiktok.com/embed/v2/<id>). The embed
// technically rendered, but TikTok refuses to embed a meaningful share of videos,
// muted autoplay made it useless in a room, and the player controls fought with the
// game. Opening the real TikTok page is what actually works, so the embed was removed
// rather than left in as a half-working default.
//
// HOST SCREEN ONLY. The URL contains the videoId, which is precisely what players must
// not learn — the rules deny them `rounds/$i/videoId` for that reason.

/**
 * Canonical watch URL for a video id.
 *
 * The pool stores ids only, never author handles — but TikTok routes on the id alone,
 * so a placeholder handle resolves to the right video (verified 2026-08-01: /@x/video/<id>
 * returns the page with the true author embedded in it). The bare /video/<id> form does
 * NOT work; it returns an empty shell.
 */
export const watchUrl = (videoId) => `https://www.tiktok.com/@x/video/${videoId}`;
