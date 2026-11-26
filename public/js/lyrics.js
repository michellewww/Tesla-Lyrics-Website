// Lyrics lookup via LRCLIB (https://lrclib.net) — free, no API key, CORS-enabled.
// Prefers word-level timing (Lyricsfile) > line-synced LRC > plain text.
import { parseLrc, parseLyricsfile, parsePlain } from './lrc.js';
import { cleanTitle, pickBest } from './match.js';

const CACHE_PREFIX = 'lyrics:v2:';
const CACHE_INDEX = 'lyrics:v2:index';
const CACHE_MAX = 80;
const MISS_TTL_MS = 24 * 60 * 60 * 1000; // a miss is re-checked after a day (LRCLIB grows)
const INCOMPLETE_TTL_MS = 10 * 60 * 1000; // a search cut short by an error is retried after 10 min
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const HAN = /\p{Script=Han}/u;
const KANA_HANGUL = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Traditional → Simplified, for comparing Chinese names. Loaded only when needed. */
async function loadFold() {
  try {
    return (await import('./t2s.js')).toSimplified;
  } catch {
    return undefined;
  }
}

/** Simplified → Traditional converters, for searching. ~1 MB, so loaded only after a miss. */
async function loadTraditional() {
  try {
    return (await import('./s2t.js')).traditionalConverters;
  } catch {
    return [];
  }
}

const unique = (list) => [...new Set(list.filter(Boolean))];
const timed = (results) => (Array.isArray(results) ? results.filter((r) => r?.duration) : []);

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
  now = () => Date.now(),
} = {}) {
  const memory = new Map();
  let pausedUntil = 0; // after a 429, LRCLIB asks clients to wait (Retry-After)

  async function request(path, params) {
    if (now() < pausedUntil) throw new Error('LRCLIB rate limit: waiting before retrying');
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await fetchFn(url.toString(), { headers: client ? { 'Lrclib-Client': client } : {} });
    if (res.status === 404) return null;
    if (res.status === 429) {
      const retryAfter = Number(res.headers?.get?.('Retry-After'));
      pausedUntil = now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30) * 1000;
      throw new Error('LRCLIB rate limit');
    }
    if (!res.ok) throw new Error(`LRCLIB error ${res.status}`);
    return res.json();
  }

  const good = (r) => Boolean(r && (r.syncedLyrics || r.instrumental));

  /** Steps 1–3 for one set of names. Returns a synced/instrumental hit, or the best other match. */
  async function searchByNames({ name, artists, album }, durationSec, fold, req) {
    const artist = artists?.[0] || '';
    const title = cleanTitle(name) || name;

    // 1) Exact signature match — the fastest and most accurate path.
    const exact = await req('/api/get', {
      track_name: name,
      artist_name: artist,
      album_name: album,
      duration: durationSec,
    });
    if (good(exact)) return { found: exact };
    let fallback = exact; // plain-only match; keep looking for a synced one

    // 2) Structured search with the cleaned-up title.
    const structured = await req('/api/search', { track_name: title, artist_name: artist });
    let best = pickBest(structured, { durationSec });
    if (good(best)) return { found: best };
    fallback ||= best;

    // 3) Free-text search, verified against artist and title.
    const free = await req('/api/search', { q: `${title} ${artist}`.trim() });
    best = pickBest(free, { durationSec, artist, title, fold });
    if (good(best)) return { found: best };
    return { fallback: fallback || best || null };
  }

  async function lookup(track, alternates) {
    const durationSec = track.durationMs ? Math.round(track.durationMs / 1000) : undefined;
    const names = [track.name, ...(track.artists || []), track.album || ''].join(' ');
    // Chinese/Japanese/Korean names are where LRCLIB's spelling most often differs from
    // Spotify's: Simplified vs Traditional, or English artist names.
    const localized = CJK.test(names);
    const chinese = HAN.test(names) && !KANA_HANGUL.test(names);
    const fold = localized ? await loadFold() : undefined;

    // A failed request (network, server, rate limit) ends the search but keeps whatever
    // was already found; only if nothing was found is the error reported.
    let failure = null;
    const req = async (path, params) => {
      if (failure) return null;
      try {
        return await request(path, params);
      } catch (e) {
        failure = e;
        return null;
      }
    };
    // Returns { record, incomplete }: incomplete when an error cut the search short, so
    // a better match may still exist and the result shouldn't be kept for long.
    const finish = (fallback) => {
      if (fallback) return { record: fallback, incomplete: Boolean(failure) };
      if (failure) throw failure;
      return { record: null, incomplete: false };
    };
    const hit = (record) => ({ record, incomplete: false });

    const first = await searchByNames(track, durationSec, fold, req);
    if (first.found) return hit(first.found);
    let fallback = first.fallback;

    // 4) Spotify shows names in the browser's language (李荣浩 in a Chinese browser,
    //    "Ronghao Li" in an English one), and LRCLIB often has the English ones.
    let en = null;
    if (localized && alternates && !failure) {
      en = await Promise.resolve().then(alternates).catch(() => null);
      if (en?.name && (en.name !== track.name || en.artists?.[0] !== track.artists?.[0])) {
        const second = await searchByNames(en, durationSec, fold, req);
        if (second.found) return hit(second.found);
        fallback ||= second.fallback;
      }
    }

    // The remaining searches are looser, so they need the song's length to confirm a match.
    if (!durationSec || failure) return finish(fallback);

    // Spellings to try: as given, and for Chinese also in Simplified and Traditional
    // (Taiwan and Hong Kong forms), since LRCLIB's search treats them as different text.
    // Each "speller" rewrites a string into one script, so related strings stay consistent.
    const spellers = [(x) => x, fold, ...(chinese ? await loadTraditional() : [])].filter(Boolean);
    const spellings = (text) => spellers.map((f) => f(text));
    const artistNames = unique([track.artists?.[0], en?.artists?.[0]].flatMap((a) => (a ? spellings(a) : [])));
    // Instrumental/karaoke records have no lyrics to show; in these looser searches they are
    // much more likely to be a backing track of the song than the song itself.
    const candidates = (results) => timed(results).filter((r) => !r.instrumental);

    // 5) Title only — accepted when the length is within 3 s and the song name is the
    //    same (not merely contained: "Home" ≠ "Coming Home"). Latin-script artists are
    //    spelled consistently, so those must match too; for CJK songs the artist is often
    //    spelled differently on LRCLIB, which is why this step exists.
    const titles = unique([track.name, en?.name].filter(Boolean).flatMap((t) => spellings(cleanTitle(t) || t))).slice(0, 4);
    for (const q of titles) {
      const results = candidates(await req('/api/search', { q }));
      const best = pickBest(results, {
        durationSec,
        title: q,
        artist: localized ? undefined : artistNames,
        fold,
        maxDiff: 3,
        exact: true,
      });
      if (good(best)) return hit(best);
      fallback ||= best;
    }

    // 6) Artist + album, for songs LRCLIB titles differently (another language, an added
    //    subtitle) — accepted only when the artist and album match and the length is
    //    within 2 s. Each artist is searched with the album name from the same source
    //    (native with native, English with English), in one script at a time.
    const pairs = [
      [track.artists?.[0], track.album],
      [en?.artists?.[0], en?.album],
    ].filter(([a, b]) => a && b);
    const albums = unique(pairs.map(([, b]) => b));
    const queries = unique(pairs.flatMap(([a, b]) => spellers.map((f) => `${f(a)} ${f(b)}`))).slice(0, 4);
    for (const q of queries) {
      const best = pickBest(candidates(await req('/api/search', { q })), {
        durationSec,
        artist: artistNames,
        album: albums,
        fold,
        maxDiff: 2,
        exact: true,
      });
      if (good(best)) return hit(best);
      fallback ||= best;
    }
    return finish(fallback);
  }

  /** Misses and cut-short results expire; complete hits don't. */
  function expired(entry) {
    const ttl = entry.incomplete ? INCOMPLETE_TTL_MS : entry.status === 'none' ? MISS_TTL_MS : Infinity;
    return Number.isFinite(ttl) && !(now() - (entry.checkedAt || 0) < ttl);
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
      // The same expiry applies to the in-memory and the saved copy, so a tab left open
      // re-checks too.
      const inMemory = memory.get(track.id);
      if (inMemory && !expired(inMemory)) return inMemory;
      const cached = readCache(track.id);
      if (cached?.status && !expired(cached)) {
        memory.set(track.id, cached);
        return cached;
      }
      const { record, incomplete } = await lookup(track, alternates);
      const result = toResult(record);
      // Misses are re-checked after a day (LRCLIB may add the song later), and results of a
      // search an error cut short after 10 minutes; full hits are kept. The Retry button
      // calls forget() to search again right away.
      const entry =
        incomplete || result.status === 'none' ? { ...result, checkedAt: now(), ...(incomplete ? { incomplete: true } : {}) } : result;
      memory.set(track.id, entry);
      writeCache(track.id, entry);
      return entry;
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
