// Helpers for matching a Spotify track to an LRCLIB record.

/** Lowercase, strip accents and punctuation, collapse spaces. */
export function normalize(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const VERSION_WORDS =
  'remaster(?:ed)?|version|live|edit|mix|remix|mono|stereo|demo|acoustic|radio|single|deluxe|bonus|recorded|anniversary|session|take';

/**
 * Remove decorations Spotify adds to titles that LRCLIB usually doesn't have:
 * "Song - Remastered 2011", "Song (feat. X)", "Song [Live]".
 */
export function cleanTitle(title) {
  return String(title || '')
    .replace(/\s*[([](?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, '')
    .replace(new RegExp(`\\s+-\\s+[^-]*\\b(?:${VERSION_WORDS})\\b.*$`, 'i'), '')
    .replace(new RegExp(`\\s*[([][^)\\]]*\\b(?:${VERSION_WORDS})\\b[^)\\]]*[)\\]]`, 'gi'), '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looselyEqual(a, b) {
  const x = normalize(a);
  const y = normalize(b);
  return Boolean(x && y && (x.includes(y) || y.includes(x)));
}

/**
 * Choose the best LRCLIB search result.
 * Prefers synced lyrics with a duration close to Spotify's; falls back to plain lyrics.
 * @param {object[]} results LRCLIB records
 * @param {{durationSec?:number, artist?:string, title?:string}} want
 */
export function pickBest(results, { durationSec, artist, title } = {}) {
  if (!Array.isArray(results)) return null;
  const diff = (r) => (durationSec && r.duration ? Math.abs(r.duration - durationSec) : 0);
  const plausible = results.filter(
    (r) =>
      r &&
      (r.syncedLyrics || r.plainLyrics || r.instrumental) &&
      (!artist || looselyEqual(r.artistName, artist)) &&
      (!title || looselyEqual(cleanTitle(r.trackName), cleanTitle(title))),
  );
  // Closest duration wins; word-synced records get a small head start.
  const score = (r) => diff(r) - (r.hasWordSync ? 1.5 : 0);
  const byDiff = (a, b) => score(a) - score(b);

  const synced = plausible.filter((r) => r.syncedLyrics && diff(r) <= 8).sort(byDiff);
  if (synced.length) return synced[0];
  const other = plausible.filter((r) => diff(r) <= 15).sort(byDiff);
  return other[0] || null;
}
