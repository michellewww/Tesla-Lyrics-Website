// Lyrics lookup via LRCLIB (https://lrclib.net) — free, no API key, CORS-enabled.
// Prefers word-level timing (Lyricsfile) > line-synced LRC > plain text.
import { parseLrc, parseLyricsfile, parsePlain } from './lrc.js';
import { cleanTitle, pickBest } from './match.js';

const CACHE_PREFIX = 'lyrics:v2:';
const CACHE_INDEX = 'lyrics:v2:index';
const CACHE_MAX = 80;

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

  async function lookup(track) {
    const artist = track.artists?.[0] || '';
    const durationSec = track.durationMs ? Math.round(track.durationMs / 1000) : undefined;
    const title = cleanTitle(track.name) || track.name;
    const good = (r) => r && (r.syncedLyrics || r.instrumental);

    // 1) Exact signature match — the fastest and most accurate path.
    const exact = await request('/api/get', {
      track_name: track.name,
      artist_name: artist,
      album_name: track.album,
      duration: durationSec,
    });
    if (good(exact)) return exact;
    let fallback = exact; // plain-only match; keep looking for a synced one

    // 2) Structured search with the cleaned-up title.
    const structured = await request('/api/search', { track_name: title, artist_name: artist });
    let best = pickBest(structured, { durationSec });
    if (good(best)) return best;
    fallback ||= best;

    // 3) Free-text search, verified against artist and title.
    const free = await request('/api/search', { q: `${title} ${artist}`.trim() });
    best = pickBest(free, { durationSec, artist, title });
    if (good(best)) return best;
    return fallback || best || null;
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
    /** @param {{id:string,name:string,artists:string[],album:string,durationMs:number}} track */
    async get(track) {
      if (memory.has(track.id)) return memory.get(track.id);
      const cached = readCache(track.id);
      if (cached?.status) {
        memory.set(track.id, cached);
        return cached;
      }
      const result = toResult(await lookup(track));
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
