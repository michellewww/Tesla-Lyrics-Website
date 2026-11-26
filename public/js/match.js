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
 * The core of a title: cleanTitle() plus no " - subtitle" and no bracketed parts, so
 * "对等关系 - Equivalence Relation (feat. aMEI)" and "對等關係 (伴奏)" both reduce to the song name.
 */
export function mainTitle(title) {
  const clean = cleanTitle(title);
  const core = clean
    .replace(/\s+[-–—]\s+.*$/, '')
    .replace(/\s*[([（【［][^)\]）】］]*[)\]）】］]/g, '')
    .trim();
  return core || clean;
}

/** Same song name (not just one containing the other): "Home" ≠ "Coming Home". */
export function sameTitle(a, b, fold) {
  const key = (s) => normalize(fold ? fold(mainTitle(String(s || ''))) : mainTitle(s));
  const x = key(a);
  return Boolean(x) && x === key(b);
}

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
// Separators between credited artists ("A & B", "A feat. B", "A、B", "A / B", "A x B").
const ARTIST_SPLIT = /\s*(?:&|、|\/|;|\+|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bx\b|\band\b)\s*/i;

/** One artist name as a comparable key: word order and "The" don't matter; CJK ignores spaces. */
function artistKey(name, fold) {
  const n = normalize(fold ? fold(name) : name);
  if (!n) return '';
  if (CJK_RE.test(n)) return n.replace(/\s+/g, '');
  return n
    .split(' ')
    .filter((w) => w !== 'the')
    .sort()
    .join(' ');
}

/** Keys for a credit string: the whole string and each credited artist (with or without "Last, First" commas). */
function artistKeys(credit, fold) {
  const raw = String(credit || '');
  const parts = raw.split(ARTIST_SPLIT);
  const names = [raw, ...parts, ...raw.split(','), ...parts.flatMap((p) => p.split(','))];
  return new Set(names.map((n) => artistKey(n, fold)).filter(Boolean));
}

/**
 * Same artist, allowing extra credits, word order and "Last, First": "Ronghao Li" matches
 * "Li, Ronghao & A-Mei" and "Ronghao Li, A-Mei Chang", but "Band" doesn't match
 * "Different Band" and "Li" doesn't match "Lily".
 */
export function sameArtist(a, b, fold) {
  const keys = artistKeys(a, fold);
  for (const k of artistKeys(b, fold)) if (keys.has(k)) return true;
  return false;
}

/**
 * Choose the best LRCLIB search result.
 * Prefers synced lyrics with a duration close to Spotify's; falls back to plain lyrics.
 * @param {object[]} results LRCLIB records
 * @param {{durationSec?:number, artist?:string|string[], title?:string, album?:string|string[],
 *          fold?:(s:string)=>string, maxDiff?:number, exact?:boolean}} want
 *   artist/album: any of the given spellings may match
 *   fold: applied to both sides before comparing names (e.g. Traditional → Simplified)
 *   maxDiff: tighter duration tolerance in seconds (default 8 for synced, 15 otherwise)
 *   exact: title and album must be the same name, not merely contain each other
 */
export function pickBest(results, { durationSec, artist, title, album, fold, maxDiff, exact = false } = {}) {
  if (!Array.isArray(results)) return null;
  const diff = (r) => (durationSec && r.duration ? Math.abs(r.duration - durationSec) : 0);
  const plausible = results.filter(
    (r) =>
      r &&
      (r.syncedLyrics || r.plainLyrics || r.instrumental) &&
      (!artist || [].concat(artist).some((a) => sameArtist(r.artistName, a, fold))) &&
      (!title || (exact ? sameTitle(r.trackName, title, fold) : looselyEqual(cleanTitle(r.trackName), cleanTitle(title), fold))) &&
      (!album || [].concat(album).some((a) => (exact ? sameTitle(r.albumName, a, fold) : looselyEqual(r.albumName, a, fold)))),
  );
  // Closest duration wins; word-synced records get a small head start.
  const score = (r) => diff(r) - (r.hasWordSync ? 1.5 : 0);
  const byDiff = (a, b) => score(a) - score(b);

  const synced = plausible.filter((r) => r.syncedLyrics && diff(r) <= (maxDiff ?? 8)).sort(byDiff);
  if (synced.length) return synced[0];
  const other = plausible.filter((r) => diff(r) <= (maxDiff ?? 15)).sort(byDiff);
  return other[0] || null;
}
