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

function looselyEqual(a, b, fold) {
  const x = normalize(fold ? fold(String(a || '')) : a);
  const y = normalize(fold ? fold(String(b || '')) : b);
  return Boolean(x && y && (x.includes(y) || y.includes(x)));
}

/**
 * Choose the best LRCLIB search result.
 * Prefers synced lyrics with a duration close to Spotify's; falls back to plain lyrics.
 * @param {object[]} results LRCLIB records
 * @param {{durationSec?:number, artist?:string, title?:string, album?:string, fold?:(s:string)=>string, maxDiff?:number}} want
 *   fold: applied to both sides before comparing names (e.g. Traditional → Simplified)
 *   maxDiff: tighter duration tolerance in seconds (default 8 for synced, 15 otherwise)
 */
export function pickBest(results, { durationSec, artist, title, album, fold, maxDiff } = {}) {
  if (!Array.isArray(results)) return null;
  const diff = (r) => (durationSec && r.duration ? Math.abs(r.duration - durationSec) : 0);
  const plausible = results.filter(
    (r) =>
      r &&
      (r.syncedLyrics || r.plainLyrics || r.instrumental) &&
      (!artist || looselyEqual(r.artistName, artist, fold)) &&
      (!title || looselyEqual(cleanTitle(r.trackName), cleanTitle(title), fold)) &&
      (!album || looselyEqual(r.albumName, album, fold)),
  );
  // Closest duration wins; word-synced records get a small head start.
  const score = (r) => diff(r) - (r.hasWordSync ? 1.5 : 0);
  const byDiff = (a, b) => score(a) - score(b);

  const synced = plausible.filter((r) => r.syncedLyrics && diff(r) <= (maxDiff ?? 8)).sort(byDiff);
  if (synced.length) return synced[0];
  const other = plausible.filter((r) => diff(r) <= (maxDiff ?? 15)).sort(byDiff);
  return other[0] || null;
}
