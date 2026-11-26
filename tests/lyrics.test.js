import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLyricsProvider, toResult } from '../public/js/lyrics.js';
import { fakeFetch, jsonResponse, memoryStorage } from './helpers.js';

const TRACK = { id: 'sp1', name: 'Song - Remastered 2011', artists: ['Band'], album: 'Album', durationMs: 201_400 };

test('toResult picks the richest format available', () => {
  assert.equal(toResult(null).status, 'none');
  assert.equal(toResult({ instrumental: true }).status, 'instrumental');
  assert.equal(toResult({ plainLyrics: 'a\nb' }).status, 'plain');
  const lrc = toResult({ syncedLyrics: '[00:01.00]a\n[00:02.00]b', plainLyrics: 'a\nb' });
  assert.equal(lrc.status, 'synced');
  assert.equal(lrc.wordSynced, false);
  const lf = toResult({
    hasWordSync: true,
    syncedLyrics: '[00:01.00]a b',
    lyricsfile: "lines:\n- text: a b\n  start_ms: 1000\n  end_ms: 2000\n  words:\n  - text: 'a '\n    start_ms: 1000\n  - text: b\n    start_ms: 1500\n",
  });
  assert.equal(lf.status, 'synced');
  assert.equal(lf.wordSynced, true);
  assert.equal(lf.lines[0].words.length, 2);
});

test('toResult falls back to LRC when the Lyricsfile is broken', () => {
  const r = toResult({ hasWordSync: true, lyricsfile: 'lines:\n  - : : bad\n not yaml', syncedLyrics: '[00:01.00]ok' });
  assert.equal(r.status, 'synced');
  assert.equal(r.lines[0].text, 'ok');
});

test('exact match is used and sends the identifying header', async () => {
  const fetchFn = fakeFetch(() => jsonResponse(200, { id: 1, syncedLyrics: '[00:01.00]hi' }));
  const p = createLyricsProvider({ base: 'https://lrclib.net', client: 'test-client', fetchFn, storage: memoryStorage() });
  const r = await p.get(TRACK);
  assert.equal(r.status, 'synced');
  const url = new URL(fetchFn.calls[0].url);
  assert.equal(url.pathname, '/api/get');
  assert.equal(url.searchParams.get('track_name'), 'Song - Remastered 2011');
  assert.equal(url.searchParams.get('artist_name'), 'Band');
  assert.equal(url.searchParams.get('album_name'), 'Album');
  assert.equal(url.searchParams.get('duration'), '201');
  assert.equal(fetchFn.calls[0].init.headers['Lrclib-Client'], 'test-client');
});

test('falls back to search with a cleaned title when there is no exact match', async () => {
  const fetchFn = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return jsonResponse(404, { code: 404 });
    if (u.searchParams.get('track_name') === 'Song') {
      return jsonResponse(200, [{ id: 9, trackName: 'Song', artistName: 'Band', duration: 202, syncedLyrics: '[00:01.00]x' }]);
    }
    return jsonResponse(200, []);
  });
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage() });
  const r = await p.get(TRACK);
  assert.equal(r.status, 'synced');
  assert.equal(fetchFn.calls.length, 2);
});

test('keeps a plain-only exact match if no synced version exists anywhere', async () => {
  const fetchFn = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return jsonResponse(200, { id: 1, plainLyrics: 'words' });
    return jsonResponse(200, []);
  });
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage() });
  assert.equal((await p.get(TRACK)).status, 'plain');
  assert.equal(fetchFn.calls.length, 5); // get, 2 searches, title-only, artist+album
});

test('results are cached in memory and storage; misses are not persisted', async () => {
  const storage = memoryStorage();
  const fetchFn = fakeFetch(() => jsonResponse(200, { id: 1, syncedLyrics: '[00:01.00]hi' }));
  const p = createLyricsProvider({ fetchFn, storage });
  await p.get(TRACK);
  await p.get(TRACK);
  assert.equal(fetchFn.calls.length, 1);

  const p2 = createLyricsProvider({ fetchFn, storage }); // new session, same storage
  assert.equal((await p2.get(TRACK)).lines[0].text, 'hi');
  assert.equal(fetchFn.calls.length, 1);

  const missStorage = memoryStorage();
  const missFetch = fakeFetch((url) => (url.includes('/api/get') ? jsonResponse(404, {}) : jsonResponse(200, [])));
  const p3 = createLyricsProvider({ fetchFn: missFetch, storage: missStorage });
  assert.equal((await p3.get(TRACK)).status, 'none');
  assert.equal(missStorage.size, 0);
});

test('server errors propagate so the UI can offer a retry', async () => {
  const p = createLyricsProvider({ fetchFn: fakeFetch(() => jsonResponse(500, {})), storage: memoryStorage() });
  await assert.rejects(p.get(TRACK), /LRCLIB error 500/);
});

// Spotify localises names by browser language (李荣浩 vs "Ronghao Li"); LRCLIB often only
// has one spelling, or the Traditional title.
const CN_TRACK = { id: 'cn1', name: '对等关系 (feat. 张惠妹)', artists: ['李荣浩', '张惠妹'], album: 'Free Soul', durationMs: 327_000 };

test('a Chinese-name miss retries with Spotify\'s English names', async () => {
  const fetchFn = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get' && u.searchParams.get('artist_name') === 'Ronghao Li') {
      return jsonResponse(200, { id: 7, trackName: '对等关系', artistName: 'Ronghao Li', duration: 328, syncedLyrics: '[00:01.00]x' });
    }
    return u.pathname === '/api/get' ? jsonResponse(404, {}) : jsonResponse(200, []);
  });
  let asked = 0;
  const alternates = async () => {
    asked++;
    return { name: '对等关系 (feat. 张惠妹)', artists: ['Ronghao Li', 'A-Mei Chang'], album: 'Free Soul' };
  };
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage() });
  const r = await p.get(CN_TRACK, { alternates });
  assert.equal(r.status, 'synced');
  assert.equal(asked, 1);
});

test('title-only fallback accepts a close-length match by another artist spelling, not a different song', async () => {
  const fetchFn = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return jsonResponse(404, {});
    if (u.searchParams.get('q') === '对等关系') {
      return jsonResponse(200, [
        { id: 1, trackName: '对等关系', artistName: 'Hush', duration: 344, syncedLyrics: '[00:01.00]other song' },
        { id: 2, trackName: '对等关系 - Equivalence Relation (feat. aMEI)', artistName: 'Ronghao Li', duration: 328, syncedLyrics: '[00:01.00]right' },
      ]);
    }
    return jsonResponse(200, []);
  });
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage() });
  const r = await p.get(CN_TRACK); // no alternates available (e.g. demo player)
  assert.equal(r.status, 'synced');
  assert.equal(r.lines[0].text, 'right');
});

test('title-only fallback rejects matches more than 3 s off', async () => {
  const fetchFn = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return jsonResponse(404, {});
    if (u.searchParams.get('q') === '对等关系') {
      return jsonResponse(200, [{ id: 1, trackName: '对等关系', artistName: 'Someone', duration: 334, syncedLyrics: '[00:01.00]x' }]);
    }
    return jsonResponse(200, []);
  });
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage() });
  assert.equal((await p.get(CN_TRACK)).status, 'none');
});

test('Latin-script misses skip the English-names retry but still try title-only and artist+album', async () => {
  const fetchFn = fakeFetch((url) => (new URL(url).pathname === '/api/get' ? jsonResponse(404, {}) : jsonResponse(200, [])));
  let asked = 0;
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage() });
  await p.get(TRACK, { alternates: async () => (asked++, null) });
  assert.equal(asked, 0);
  const queries = fetchFn.calls.map((c) => new URL(c.url).searchParams.get('q')).filter(Boolean);
  assert.deepEqual(queries, ['Song Band', 'Song', 'Band Album']);
});

test('a Chinese song filed only under Traditional spellings is found via a Traditional title search', async () => {
  const fetchFn = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return jsonResponse(404, {});
    if (u.searchParams.get('q') === '對等關係') {
      return jsonResponse(200, [{ id: 3, trackName: '對等關係 (feat. 張惠妹)', artistName: '李榮浩', duration: 327, syncedLyrics: '[00:01.00]trad' }]);
    }
    return jsonResponse(200, []);
  });
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage() });
  const r = await p.get(CN_TRACK);
  assert.equal(r.status, 'synced');
  assert.equal(r.lines[0].text, 'trad');
});

test('a song LRCLIB titles in another language is found by artist + album and exact length', async () => {
  const track = { id: 'x', name: '对等关系', artists: ['李荣浩'], album: '纵横四海', durationMs: 327_000 };
  const fetchFn = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return jsonResponse(404, {});
    if (u.searchParams.get('q') === '李荣浩 纵横四海') {
      return jsonResponse(200, [
        { id: 4, trackName: 'Other Song', artistName: '李荣浩', albumName: '纵横四海', duration: 250, syncedLyrics: '[00:01.00]wrong' },
        { id: 5, trackName: 'Equivalence Relation', artistName: '李荣浩', albumName: '纵横四海', duration: 328, syncedLyrics: '[00:01.00]right' },
      ]);
    }
    return jsonResponse(200, []);
  });
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage() });
  const r = await p.get(track);
  assert.equal(r.lines[0].text, 'right');
});
