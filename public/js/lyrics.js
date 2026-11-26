// Lyrics lookup via LRCLIB (https://lrclib.net) — free, no API key, CORS-enabled.
// Prefers word-level timing (Lyricsfile) > line-synced LRC > plain text.
import { parseLrc, parseLyricsfile, parsePlain } from './lrc.js';
import { cleanTitle, pickBest } from './match.js';

const CACHE_PREFIX = 'lyrics:v2:';
const CACHE_INDEX = 'lyrics:v2:index';
const CACHE_MAX = 80;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Traditional → Simplified, for comparing Chinese names. Loaded only when needed. */
async function loadFold() {
  try {
    return (await import('./t2s.js')).toSimplified;
  } catch {
    return undefined;
  }
}

/**
 * Turn an LRCLIB record (or null) into what the UI renders:
 * { status: 'synced'|'plain'|'instrumental'|'none', lines, wordSynced?, lang? }
 */
export function toResult(record) {
  if (!record) return { status: 'none', lines: [] };
  if (record.instrumental) return { status: 'instrumental', lines: [] };

  if (record.hasWordSync && record.lyricsfile) {
    try {
      const lines = parseLyricsfile(record.lyricsfile);
      if (lines.some((l) => l.text)) {
        return {
          status: 'synced',
          lines,
          // Only call it word-synced if lines really are split into several words.
          wordSynced: lines.some((l) => (l.words?.length ?? 0) > 1),
        };
      }
    } catch (e) {
      console.warn('Lyricsfile parse failed; falling back to LRC', e);
    }
  }
  if (record.syncedLyrics) {
    const lines = parseLrc(record.syncedLyrics);
    if (lines.some((l) => l.text)) {
      return { status: 'synced', lines, wordSynced: lines.some((l) => (l.words?.length ?? 0) > 1) };
    }
  }
  if (record.plainLyrics) return { status: 'plain', lines: parsePlain(record.plainLyrics) };
  return { status: 'none', lines: [] };
}

export function createLyricsProvider({
  base = 'https://lrclib.net',
  client = '',
  fetchFn = (...a) => globalThis.fetch(...a),
  storage = globalThis.localStorage,
} = {}) {
  const memory = new Map();

  async function request(path, params) {
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await fetchFn(url.toString(), { headers: client ? { 'Lrclib-Client': client } : {} });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`LRCLIB error ${res.status}`);
    return res.json();
  }

  const good = (r) => Boolean(r && (r.syncedLyrics || r.instrumental));

  /** Steps 1–3 for one set of names. Returns a synced/instrumental hit, or the best other match. */
  async function searchByNames({ name, artists, album }, durationSec, fold) {
    const artist = artists?.[0] || '';
    const title = cleanTitle(name) || name;

    // 1) Exact signature match — the fastest and most accurate path.
    const exact = await request('/api/get', {
      track_name: name,
      artist_name: artist,
      album_name: album,
      duration: durationSec,
    });
    if (good(exact)) return { found: exact };
    let fallback = exact; // plain-only match; keep looking for a synced one

    // 2) Structured search with the cleaned-up title.
    const structured = await request('/api/search', { track_name: title, artist_name: artist });
    let best = pickBest(structured, { durationSec });
    if (good(best)) return { found: best };
    fallback ||= best;

    // 3) Free-text search, verified against artist and title.
    const free = await request('/api/search', { q: `${title} ${artist}`.trim() });
    best = pickBest(free, { durationSec, artist, title, fold });
    if (good(best)) return { found: best };
    return { fallback: fallback || best || null };
  }

  async function lookup(track, alternates) {
    const durationSec = track.durationMs ? Math.round(track.durationMs / 1000) : undefined;
    // Chinese/Japanese/Korean names are where LRCLIB's spelling most often differs from
    // Spotify's: Simplified vs Traditional, or English artist names.
    const localized = CJK.test([track.name, ...(track.artists || [])].join(' '));
    const fold = localized ? await loadFold() : undefined;

    const first = await searchByNames(track, durationSec, fold);
    if (first.found) return first.found;
    let fallback = first.fallback;
    if (!localized) return fallback;

    // 4) Spotify shows names in the browser's language (李荣浩 in a Chinese browser,
    //    "Ronghao Li" in an English one), and LRCLIB often has the English ones.
    const en = alternates ? await Promise.resolve().then(alternates).catch(() => null) : null;
    if (en?.name && (en.name !== track.name || en.artists?.[0] !== track.artists?.[0])) {
      const second = await searchByNames(en, durationSec, fold);
      if (second.found) return second.found;
      fallback ||= second.fallback;
    }

    // 5) Title only, accepted only when the length is within 3 s and the title matches
    //    (both compared in Simplified, so Traditional LRCLIB titles count too).
    if (durationSec) {
      const titles = [...new Set([track.name, en?.name].filter(Boolean).map((t) => cleanTitle(t) || t))];
      for (const q of titles) {
        const results = await request('/api/search', { q });
        const timed = Array.isArray(results) ? results.filter((r) => r?.duration) : [];
        const best = pickBest(timed, { durationSec, title: q, fold, maxDiff: 3 });
        if (good(best)) return best;
        fallback ||= best;
      }
    }
    return fallback || null;
  }

  function readCache(id) {
    try {
      const raw = storage?.getItem(CACHE_PREFIX + id);
      return raw ? JSON.parse(raw) : undefined;
    } catch {
      return undefined;
    }
  }

  function writeCache(id, result) {
    if (!storage) return;
    let index;
    try {
      index = JSON.parse(storage.getItem(CACHE_INDEX) || '[]').filter((k) => k !== id);
    } catch {
      index = [];
    }
    index.push(id);
    const value = JSON.stringify(result);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        while (index.length > CACHE_MAX) storage.removeItem(CACHE_PREFIX + index.shift());
        storage.setItem(CACHE_PREFIX + id, value);
        storage.setItem(CACHE_INDEX, JSON.stringify(index));
        return;
      } catch {
        // Storage full: drop the oldest half and retry.
        const drop = index.splice(0, Math.max(1, Math.floor((index.length - 1) / 2)));
        for (const k of drop) storage.removeItem(CACHE_PREFIX + k);
      }
    }
  }

  return {
    /**
     * @param {{id:string,name:string,artists:string[],album:string,durationMs:number}} track
     * @param {{alternates?: () => Promise<{name:string,artists:string[],album:string}|null>}} [opts]
     *   alternates: the same track's names in English, asked for only if the first lookup misses
     */
    async get(track, { alternates } = {}) {
      if (memory.has(track.id)) return memory.get(track.id);
      const cached = readCache(track.id);
      if (cached?.status) {
        memory.set(track.id, cached);
        return cached;
      }
      const result = toResult(await lookup(track, alternates));
      memory.set(track.id, result);
      // Only persist hits; a miss might be filled in on LRCLIB later.
      if (result.status !== 'none') writeCache(track.id, result);
      return result;
    },

    forget(trackId) {
      memory.delete(trackId);
      try {
        storage?.removeItem(CACHE_PREFIX + trackId);
      } catch {
        /* ignore */
      }
    },
  };
}
