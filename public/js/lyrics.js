// Lyrics lookup via LRCLIB (https://lrclib.net) — free, no API key, CORS-enabled.
// Prefers word-level timing (Lyricsfile) > line-synced LRC > plain text.
import { parseLrc, parseLyricsfile, parsePlain } from './lrc.js';
import { cleanTitle, normalize, pickBest } from './match.js';
import { withDeadline } from './net.js';

// Bumped whenever matching changes in a way that makes saved results untrustworthy.
const CACHE_VERSION = 'lyrics:v3:';
const OLD_CACHES = ['lyrics:v2:'];
const CACHE_MAX = 80;
const MISS_TTL_MS = 24 * 60 * 60 * 1000; // a miss is re-checked after a day (LRCLIB grows)
const INCOMPLETE_TTL_MS = 10 * 60 * 1000; // a search cut short by an error is retried after 10 min
// Synced lyrics are only trusted as-is when the record is this close in length to Spotify's
// track (LRCLIB's own exact match uses ±2 s). A version a few seconds longer or shorter
// usually has a different intro, so every line is off by about that much for the whole song.
const SAME_LENGTH_SEC = 2;
// How long word-by-word lyrics from LRCLIB are waited for once another source has answered.
const WORD_TIMING_WAIT_MS = 4000;
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

/** Of two records, the one whose length is closer to `durationSec`. */
function closer(a, b, durationSec) {
  if (!a || !b) return a || b || null;
  return Math.abs(b.duration - durationSec) < Math.abs(a.duration - durationSec) ? b : a;
}

/** A record's lyrics as one run of comparable characters: no timestamps, spaces or punctuation. */
function lyricText(record, fold) {
  const text = String(record?.plainLyrics || record?.syncedLyrics || '').replace(/[[<]\d+:\d+(?:[.:]\d+)?[\]>]/g, '');
  return normalize(fold ? fold(text) : text).replace(/\s+/g, '');
}

const GRAM = 5;
function grams(text) {
  const set = new Set();
  for (let i = 0; i + GRAM <= text.length; i++) set.add(text.slice(i, i + GRAM));
  return set;
}

/**
 * Whether two records hold the words of the same song: at least half of the shorter one's
 * 5-character runs appear in the other. Line breaks, punctuation and added translations
 * don't matter, so differently laid-out copies of the same lyrics still match.
 */
export function sameLyrics(a, b, fold) {
  const x = grams(lyricText(a, fold));
  const y = grams(lyricText(b, fold));
  if (!x.size || !y.size) return false;
  const [small, large] = x.size <= y.size ? [x, y] : [y, x];
  let shared = 0;
  for (const g of small) if (large.has(g)) shared++;
  return shared / small.size >= 0.5;
}
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
  timeoutMs = 10_000,
  // Optional second source (QQ Music, see qq.js): async (track, { en, fold }) → record | null.
  // Asked only when LRCLIB has no timed lyrics for the song.
  backup = null,
  // true: ask `backup` first and use LRCLIB only when it has no timed lyrics.
  // 'cjk': do that only for songs with Chinese/Japanese/Korean names.
  backupFirst = false,
  // Names the set of sources in use, so results saved under another set are looked up again.
  cacheTag = backup ? 'b' : '',
} = {}) {
  // Results saved without the backup source are not reused once there is one (and the
  // other way round), so songs that only had plain lyrics get looked up again.
  const CACHE_PREFIX = cacheTag ? `${CACHE_VERSION}${cacheTag}:` : CACHE_VERSION;
  const CACHE_INDEX = `${CACHE_PREFIX}index`;
  const memory = new Map();
  // Results saved by an older version of the matching (some were the wrong song).
  for (const old of OLD_CACHES) {
    try {
      for (const id of JSON.parse(storage?.getItem(`${old}index`) || '[]')) storage.removeItem(old + id);
      storage?.removeItem(`${old}index`);
    } catch {
      /* nothing saved, or storage unavailable */
    }
  }
  const inflight = new Map(); // track id → lookup in progress (shared by repeat callers)
  const generation = new Map(); // track id → bumped by forget(), so older lookups don't save
  let pausedUntil = 0; // after a 429, LRCLIB asks clients to wait (Retry-After)

  async function request(path, params) {
    if (now() < pausedUntil) throw new Error('LRCLIB rate limit: waiting before retrying');
    const url = new URL(path, base);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    // The deadline covers the response and its body.
    return withDeadline(timeoutMs, async (signal) => {
      const res = await fetchFn(url.toString(), { headers: client ? { 'Lrclib-Client': client } : {}, signal });
      if (res.status === 404) return null;
      if (res.status === 429) {
        const retryAfter = Number(res.headers?.get?.('Retry-After'));
        pausedUntil = now() + (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 30) * 1000;
        throw new Error('LRCLIB rate limit');
      }
      if (!res.ok) throw new Error(`LRCLIB error ${res.status}`);
      return res.json();
    });
  }

  const good = (r) => Boolean(r && (r.syncedLyrics || r.instrumental));

  /**
   * Steps 1–3 for one set of names. Returns { found } for a synced/instrumental record of the
   * same length, otherwise { far, fallback }: a synced record of a different-length version
   * (timing likely off) and/or a plain-lyrics match.
   */
  async function searchByNames({ name, artists, album }, durationSec, fold, req) {
    const sameLength = (r) => !durationSec || !r?.duration || Math.abs(r.duration - durationSec) <= SAME_LENGTH_SEC;
    let far = null;
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
    if (good(best) && sameLength(best)) return { found: best };
    if (good(best)) far = best;
    else fallback ||= best;

    // 3) Free-text search, verified against artist and title.
    const free = await req('/api/search', { q: `${title} ${artist}`.trim() });
    best = pickBest(free, { durationSec, artist, title, fold });
    if (good(best) && sameLength(best)) return { found: best };
    if (good(best)) far = closer(far, best, durationSec);
    else fallback ||= best;
    return { far, fallback: fallback || null };
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
    const hit = (record) => ({ record, incomplete: false });

    // The other source (QQ Music), asked once per set of names. Its errors never fail the lookup.
    let en = null;
    let asked = null;
    let askedWithEn = false;
    let backupFailed = false;
    const askBackup = () => {
      if (asked) return asked;
      askedWithEn = Boolean(en);
      asked = !backup
        ? Promise.resolve(null)
        : Promise.resolve()
            .then(() => backup(track, { en, fold }))
            .catch((e) => {
              console.warn('Backup lyrics lookup failed', e);
              backupFailed = true;
              return null;
            });
      return asked;
    };

    const viaLrclib = async () => {
      const first = await searchByNames(track, durationSec, fold, req);
      if (first.found) return hit(first.found);
      let fallback = first.fallback;
      let far = first.far;

      // 4) Spotify shows names in the browser's language (李荣浩 in a Chinese browser,
      //    "Ronghao Li" in an English one), and LRCLIB often has the English ones.
      if (localized && alternates && !failure) {
        // Optional extra: never let it hold up the remaining searches.
        en = await withDeadline(Math.min(timeoutMs, 5000), () => Promise.resolve().then(alternates)).catch(() => null);
        if (en?.name && (en.name !== track.name || en.artists?.[0] !== track.artists?.[0])) {
          const second = await searchByNames(en, durationSec, fold, req);
          if (second.found) return hit(second.found);
          fallback ||= second.fallback;
          far = closer(far, second.far, durationSec);
          // It was asked before the English names were known and found nothing: ask again.
          if (asked && !askedWithEn && !backupFailed && !(await asked)) asked = null;
        }
      }

      // Returns { record, incomplete }: incomplete when an error cut the search short, so
      // a better match may still exist and the result shouldn't be kept for long.
      // Timed lyrics from the backup come first; then a different-length version's timed
      // lyrics from LRCLIB (`far`), which beat plain lyrics.
      const finish = async () => {
        const other = await askBackup();
        if (good(other)) return hit(other);
        const record = far || fallback || other;
        const incomplete = Boolean(failure) || backupFailed;
        if (record) return { record, incomplete };
        if (failure) throw failure;
        return { record: null, incomplete };
      };

      // The remaining searches are looser, so they need the song's length to confirm a match.
      if (!durationSec || failure) return finish();

      // Spellings to try: as given, and for Chinese also in Simplified and Traditional
      // (Taiwan and Hong Kong forms), since LRCLIB's search treats them as different text.
      // Each "speller" rewrites a string into one script, so related strings stay consistent.
      const spellers = [(x) => x, fold, ...(chinese ? await loadTraditional() : [])].filter(Boolean);
      const spellings = (text) => spellers.map((f) => f(text));
      const artistNames = unique([track.artists?.[0], en?.artists?.[0]].flatMap((a) => (a ? spellings(a) : [])));
      // Instrumental/karaoke records have no lyrics to show; in these looser searches they are
      // much more likely to be a backing track of the song than the song itself.
      const candidates = (results) => timed(results).filter((r) => !r.instrumental);

      // 5) Title only — accepted when the length is within 2 s and the song name is the
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
          maxDiff: SAME_LENGTH_SEC,
          exact: true,
        });
        if (good(best)) return hit(best);
        fallback ||= best;
      }

      // 6) Artist + album, for songs LRCLIB titles differently (another language, an added
      //    subtitle) — accepted only when the artist and album match and the length is
      //    within 2 s. Each artist is searched with the album name from the same source
      //    (native with native, English with English), in one script at a time.
      //    This is the loosest search, so the backup source is asked first.
      const other = await askBackup();
      if (good(other)) return hit(other);
      const pairs = [
        [track.artists?.[0], track.album],
        [en?.artists?.[0], en?.album],
      ].filter(([a, b]) => a && b);
      const albums = unique(pairs.map(([, b]) => b));
      const queries = unique(pairs.flatMap(([a, b]) => spellers.map((f) => `${f(a)} ${f(b)}`))).slice(0, 4);
      // Another song on the same album can easily be the same length. When this song's words
      // are already known (plain lyrics, or a different-length version), a record found here
      // must have the same words — it is then only wanted for its timing.
      const known = fallback || far;
      const sameSong = (r) => !known || sameLyrics(known, r, fold);
      for (const q of queries) {
        const best = pickBest(candidates(await req('/api/search', { q })).filter(sameSong), {
          durationSec,
          artist: artistNames,
          album: albums,
          fold,
          maxDiff: SAME_LENGTH_SEC,
          exact: true,
        });
        if (good(best)) return hit(best);
        fallback ||= best;
      }
      return finish();
    };

    // With `backupFirst`, the other source's timed lyrics win. LRCLIB is searched at the
    // same time, so a slow or failing other source costs no extra wait.
    if (backup && backupFirst && (backupFirst !== 'cjk' || localized)) {
      const rest = viaLrclib();
      rest.catch(() => {}); // only reported if it ends up being the answer
      const other = await askBackup();
      if (!good(other)) return rest;
      const sameLength = (r) => Boolean(r?.duration && durationSec && Math.abs(r.duration - durationSec) <= SAME_LENGTH_SEC);
      // Matched on the title alone (it may be another recording of the song): LRCLIB's
      // timed lyrics for a track of this exact length are the safer choice when it has them.
      if (other.unsure) {
        const found = await rest.catch(() => null);
        if (found?.record !== other && good(found?.record) && sameLength(found.record)) return found;
        return hit(other);
      }
      // LRCLIB's copy is preferred when it times every word — but only if it is the same
      // length and has the same words as the other source's, which is the one trusted to
      // be the right song. It gets a few seconds to turn up.
      const fromLrclib = await Promise.race([rest.catch(() => null), new Promise((r) => setTimeout(r, WORD_TIMING_WAIT_MS, null))]);
      const record = fromLrclib?.record;
      if (record && record !== other && sameLength(record) && toResult(record).wordSynced && sameLyrics(other, record, fold)) return fromLrclib;
      return hit(other);
    }
    return viaLrclib();
  }

  /** Misses and cut-short results expire; complete hits don't. */
  function expired(entry) {
    // A different-length version is re-checked daily too, in case the right one is added.
    const ttl = entry.incomplete ? INCOMPLETE_TTL_MS : entry.status === 'none' || entry.approximate ? MISS_TTL_MS : Infinity;
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
      // One lookup per track at a time: switching away and back shares it, so an older
      // lookup can't finish later and overwrite a newer result.
      if (inflight.has(track.id)) return inflight.get(track.id);
      const running = this.search(track, alternates).finally(() => {
        if (inflight.get(track.id) === running) inflight.delete(track.id);
      });
      inflight.set(track.id, running);
      return running;
    },

    /** The uncached lookup behind get(). */
    async search(track, alternates) {
      const startedAs = generation.get(track.id) || 0;
      const { record, incomplete } = await lookup(track, alternates);
      const result = toResult(record);
      const durationSec = track.durationMs ? Math.round(track.durationMs / 1000) : 0;
      // Synced lyrics from a version of a different length: timing is probably off.
      if (result.status === 'synced' && durationSec && record?.duration && Math.abs(record.duration - durationSec) > SAME_LENGTH_SEC) {
        result.approximate = true;
      }
      // Misses are re-checked after a day (LRCLIB may add the song later), and results of a
      // search an error cut short after 10 minutes; full hits are kept. The Retry button
      // calls forget() to search again right away.
      const entry =
        incomplete || result.status === 'none' || result.approximate
          ? { ...result, checkedAt: now(), ...(incomplete ? { incomplete: true } : {}) }
          : result;
      // forget() (the Retry button) during the lookup makes this result out of date.
      if ((generation.get(track.id) || 0) === startedAs) {
        memory.set(track.id, entry);
        writeCache(track.id, entry);
      }
      return entry;
    },

    forget(trackId) {
      memory.delete(trackId);
      inflight.delete(trackId);
      generation.set(trackId, (generation.get(trackId) || 0) + 1);
      try {
        storage?.removeItem(CACHE_PREFIX + trackId);
      } catch {
        /* ignore */
      }
    },
  };
}
