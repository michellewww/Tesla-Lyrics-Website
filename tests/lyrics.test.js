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
  assert.equal(fetchFn.calls.length, 4); // get, 2 searches, title-only
});

test('results are cached in memory and storage; misses for a day', async () => {
  const storage = memoryStorage();
  const fetchFn = fakeFetch(() => jsonResponse(200, { id: 1, syncedLyrics: '[00:01.00]hi' }));
  const p = createLyricsProvider({ fetchFn, storage });
  await p.get(TRACK);
  await p.get(TRACK);
  assert.equal(fetchFn.calls.length, 1);

  const p2 = createLyricsProvider({ fetchFn, storage }); // new session, same storage
  assert.equal((await p2.get(TRACK)).lines[0].text, 'hi');
  assert.equal(fetchFn.calls.length, 1);

  // Misses are remembered for a day, then searched again.
  const t = 1_000_000;
  const missStorage = memoryStorage();
  const missFetch = fakeFetch((url) => (url.includes('/api/get') ? jsonResponse(404, {}) : jsonResponse(200, [])));
  const p3 = createLyricsProvider({ fetchFn: missFetch, storage: missStorage, now: () => t });
  assert.equal((await p3.get(TRACK)).status, 'none');
  const firstCalls = missFetch.calls.length;
  const p4 = createLyricsProvider({ fetchFn: missFetch, storage: missStorage, now: () => t + 60_000 });
  assert.equal((await p4.get(TRACK)).status, 'none');
  assert.equal(missFetch.calls.length, firstCalls); // reload within a day: no new requests
  const p5 = createLyricsProvider({ fetchFn: missFetch, storage: missStorage, now: () => t + 25 * 60 * 60 * 1000 });
  await p5.get(TRACK);
  assert.ok(missFetch.calls.length > firstCalls); // a day later: searched again
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

test('title-only search accepts the artist under its English name, and never another artist', async () => {
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
  const english = async () => ({ name: '对等关系 (feat. 张惠妹)', artists: ['Ronghao Li', 'A-Mei Chang'], album: 'Free Soul' });
  const r = await p.get(CN_TRACK, { alternates: english });
  assert.equal(r.status, 'synced');
  assert.equal(r.lines[0].text, 'right');
  // Without the English name there is nothing to confirm the artist with: no match.
  const blind = createLyricsProvider({ fetchFn, storage: memoryStorage() });
  assert.equal((await blind.get(CN_TRACK)).status, 'none');
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

test('a Latin-script song with no other names is searched by its own names and by title alone', async () => {
  const fetchFn = fakeFetch((url) => (new URL(url).pathname === '/api/get' ? jsonResponse(404, {}) : jsonResponse(200, [])));
  let asked = 0;
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage() });
  await p.get(TRACK, { alternates: async () => (asked++, null) });
  assert.equal(asked, 1); // asked once, up front, whether it is a Chinese song
  const queries = fetchFn.calls.map((c) => new URL(c.url).searchParams.get('q')).filter(Boolean);
  assert.deepEqual(queries, ['Song Band', 'Song']);
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

test('a same-artist, same-album, same-length record under another title is not taken for the song', async () => {
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
  assert.equal((await p.get(track)).status, 'none');
});

test('title-only search needs the same song name, and for Latin-script songs the same artist', async () => {
  const track = { id: 'h', name: 'Home', artists: ['Band'], album: 'Album', durationMs: 210_000 };
  const fetchFn = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return jsonResponse(404, {});
    if (u.searchParams.get('q') === 'Home') {
      return jsonResponse(200, [
        { id: 1, trackName: 'Coming Home', artistName: 'Band', duration: 211, syncedLyrics: '[00:01.00]contains' },
        { id: 2, trackName: 'Home', artistName: 'Someone Else', duration: 210, syncedLyrics: '[00:01.00]other artist' },
      ]);
    }
    return jsonResponse(200, []);
  });
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage() });
  assert.equal((await p.get(track)).status, 'none');

  const ok = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return jsonResponse(404, {});
    if (u.searchParams.get('q') === 'Home') {
      return jsonResponse(200, [{ id: 3, trackName: 'Home (2019 Remaster)', artistName: 'Band & Friend', duration: 211, syncedLyrics: '[00:01.00]right' }]);
    }
    return jsonResponse(200, []);
  });
  const p2 = createLyricsProvider({ fetchFn: ok, storage: memoryStorage() });
  assert.equal((await p2.get(track)).lines[0].text, 'right');
});

test('artist + album search rejects another artist on a same-named album', async () => {
  const track = { id: 'g', name: 'Track Nine', artists: ['Band'], album: 'Greatest Hits', durationMs: 200_000 };
  const fetchFn = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return jsonResponse(404, {});
    if (u.searchParams.get('q') === 'Band Greatest Hits') {
      return jsonResponse(200, [{ id: 1, trackName: 'Other', artistName: 'Different Band', albumName: 'Greatest Hits', duration: 200, syncedLyrics: '[00:01.00]x' }]);
    }
    return jsonResponse(200, []);
  });
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage() });
  assert.equal((await p.get(track)).status, 'none');
});

test('fallback searches skip instrumental/backing-track records and keep looking', async () => {
  const fetchFn = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return jsonResponse(404, {});
    const q = u.searchParams.get('q');
    if (q === '对等关系') return jsonResponse(200, [{ id: 1, trackName: '对等关系 (伴奏)', artistName: 'x', duration: 327, instrumental: true }]);
    if (q === '對等關係') return jsonResponse(200, [{ id: 2, trackName: '對等關係', artistName: '李榮浩', duration: 327, syncedLyrics: '[00:01.00]vocal' }]);
    return jsonResponse(200, []);
  });
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage() });
  const r = await p.get(CN_TRACK);
  assert.equal(r.status, 'synced');
  assert.equal(r.lines[0].text, 'vocal');
});

test('a rate limit mid-search keeps lyrics already found and pauses further requests', async () => {
  let t = 0;
  const fetchFn = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return jsonResponse(200, { id: 1, plainLyrics: 'plain words' });
    if (u.searchParams.get('q') === 'Song') return jsonResponse(429, {}, { 'Retry-After': '20' });
    return jsonResponse(200, []);
  });
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage(), now: () => t });
  const r = await p.get(TRACK);
  assert.equal(r.status, 'plain'); // not thrown away by the 429
  const calls = fetchFn.calls.length;
  // While paused, the next lookup fails fast without hitting LRCLIB...
  await assert.rejects(p.get({ ...TRACK, id: 'other' }), /rate limit/);
  assert.equal(fetchFn.calls.length, calls);
  // ...and works again once Retry-After has passed.
  t = 21_000;
  await p.get({ ...TRACK, id: 'third' });
  assert.ok(fetchFn.calls.length > calls);
});

test('an interrupted search shows what it found but tries again later', async () => {
  let t = 0;
  let down = true;
  const store = memoryStorage();
  const fetchFn = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return jsonResponse(200, { id: 1, plainLyrics: 'plain words' });
    if (down) return jsonResponse(503, {});
    return jsonResponse(200, [{ id: 2, trackName: 'Song', artistName: 'Band', duration: 201, syncedLyrics: '[00:01.00]synced' }]);
  });
  const p = createLyricsProvider({ fetchFn, storage: store, now: () => t });
  assert.equal((await p.get(TRACK)).status, 'plain'); // still shown despite the 503
  down = false;
  // A reload shortly after reuses it briefly...
  const p2 = createLyricsProvider({ fetchFn, storage: store, now: () => t + 60_000 });
  assert.equal((await p2.get(TRACK)).status, 'plain');
  // ...but it isn't kept for good: later, the full search runs again and finds the synced lyrics.
  t = 11 * 60 * 1000;
  const p3 = createLyricsProvider({ fetchFn, storage: store, now: () => t });
  assert.equal((await p3.get(TRACK)).status, 'synced');
  // The same goes for a tab that stays open.
  assert.equal((await p.get(TRACK)).status, 'synced');
});

test('a remembered miss expires in an open tab too', async () => {
  let t = 0;
  let available = false;
  const fetchFn = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return available ? jsonResponse(200, { id: 1, syncedLyrics: '[00:01.00]new' }) : jsonResponse(404, {});
    return jsonResponse(200, []);
  });
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage(), now: () => t });
  assert.equal((await p.get(TRACK)).status, 'none');
  const calls = fetchFn.calls.length;
  t = 60 * 60 * 1000;
  assert.equal((await p.get(TRACK)).status, 'none');
  assert.equal(fetchFn.calls.length, calls); // within a day: remembered
  available = true;
  t = 25 * 60 * 60 * 1000;
  assert.equal((await p.get(TRACK)).status, 'synced'); // after a day: searched again
});

test('a same-length version is preferred over a synced one a few seconds longer found first', async () => {
  const fetchFn = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return jsonResponse(404, {});
    if (u.searchParams.get('track_name')) {
      // Step 2 finds a version 5 s longer (different intro: its lyrics would be off).
      return jsonResponse(200, [{ id: 1, trackName: 'Song', artistName: 'Band', duration: 206, syncedLyrics: '[00:05.00]longer version' }]);
    }
    if (u.searchParams.get('q') === 'Song') {
      return jsonResponse(200, [{ id: 2, trackName: 'Song', artistName: 'Band', duration: 201, syncedLyrics: '[00:01.00]same length' }]);
    }
    return jsonResponse(200, []);
  });
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage() });
  const r = await p.get(TRACK);
  assert.equal(r.lines[0].text, 'same length');
  assert.ok(!r.approximate);
});

test('a different-length version is used only when nothing closer exists, flagged and re-checked daily', async () => {
  let t = 0;
  const store = memoryStorage();
  const fetchFn = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return jsonResponse(404, {});
    if (u.searchParams.get('track_name')) {
      return jsonResponse(200, [{ id: 1, trackName: 'Song', artistName: 'Band', duration: 206, syncedLyrics: '[00:05.00]longer version' }]);
    }
    return jsonResponse(200, []);
  });
  const p = createLyricsProvider({ fetchFn, storage: store, now: () => t });
  const r = await p.get(TRACK);
  assert.equal(r.status, 'synced');
  assert.equal(r.approximate, true);
  const calls = fetchFn.calls.length;
  await p.get(TRACK); // remembered for now...
  assert.equal(fetchFn.calls.length, calls);
  t = 25 * 60 * 60 * 1000; // ...but searched again a day later
  await p.get(TRACK);
  assert.ok(fetchFn.calls.length > calls);
});

test('a stalled LRCLIB request times out so the UI can offer a retry', async () => {
  const p = createLyricsProvider({ fetchFn: () => new Promise(() => {}), storage: memoryStorage(), timeoutMs: 30 });
  await assert.rejects(p.get(TRACK), /timed out/);
});

test('a stalled English-names lookup does not block the remaining searches', async () => {
  const fetchFn = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return jsonResponse(404, {});
    if (u.searchParams.get('q') === '對等關係') {
      return jsonResponse(200, [{ id: 3, trackName: '對等關係', artistName: '李榮浩', duration: 327, syncedLyrics: '[00:01.00]found' }]);
    }
    return jsonResponse(200, []);
  });
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage(), timeoutMs: 40 });
  const r = await p.get(CN_TRACK, { alternates: () => new Promise(() => {}) });
  assert.equal(r.status, 'synced');
});

test('switching away and back shares one lookup, so an older one cannot overwrite a newer result', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const fetchFn = fakeFetch(async () => {
    await gate;
    return jsonResponse(200, { id: 1, syncedLyrics: '[00:01.00]hi' });
  });
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage() });
  const first = p.get(TRACK);
  const second = p.get(TRACK);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 'synced');
  assert.equal(a, b);
  assert.equal(fetchFn.calls.length, 1);
});

// Regression: "Still Moving Under Gunfire" has only plain lyrics on LRCLIB; the artist +
// album search then picked another song from the album that happened to be the same length.
test('known plain lyrics are not replaced by another song of the same length from the album', async () => {
  const track = { id: 'g1', name: 'Gunfire Song', artists: ['林俊傑'], album: '100天', durationMs: 244_000 };
  const plain = { id: 1, trackName: 'Gunfire Song', artistName: '林俊傑', albumName: '100天', duration: 244, plainLyrics: 'line one\nline two\nline three' };
  const other = { id: 2, trackName: '另一首', artistName: '林俊傑', albumName: '100天', duration: 244, syncedLyrics: '[00:01.00]說感覺\n[00:05.00]還有味覺' };
  const fetchFn = fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return jsonResponse(200, plain);
    if (u.searchParams.get('q')?.includes('100天')) return jsonResponse(200, [other]);
    return jsonResponse(200, [plain]);
  });
  const p = createLyricsProvider({ fetchFn, storage: memoryStorage() });
  const r = await p.get(track);
  assert.equal(r.status, 'plain');
  assert.equal(r.lines[0].text, 'line one');
});

// ---------- the same song under different names ----------
// Spotify may show a Chinese song in English ("JJ Lin"), Traditional (林俊傑) or
// Simplified (林俊杰); LRCLIB may file it under any of them.
const SONG_LRC = '[00:01.00]right';
const filedAs = (artistName, trackName = '修炼爱情') => [{ id: 1, trackName, artistName, albumName: '因你而在', duration: 287, syncedLyrics: SONG_LRC }];
function lrclibWith(records) {
  return fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/api/get') return jsonResponse(404, {});
    return jsonResponse(200, records);
  });
}
const zhNames = async () => ({ name: '修煉愛情', artists: ['林俊傑'], album: '因你而在' });
const enNames = async () => ({ name: '修煉愛情', artists: ['JJ Lin'], album: '因你而在' });
const shown = (name, artist) => ({ id: `${name}-${artist}`, name, artists: [artist], album: '因你而在', durationMs: 287_000 });

test('Traditional on Spotify, Simplified on LRCLIB (and the reverse) match', async () => {
  const a = createLyricsProvider({ fetchFn: lrclibWith(filedAs('林俊杰', '修炼爱情')), storage: memoryStorage() });
  assert.equal((await a.get(shown('修煉愛情', '林俊傑'))).lines[0].text, 'right');
  const b = createLyricsProvider({ fetchFn: lrclibWith(filedAs('林俊傑', '修煉愛情')), storage: memoryStorage() });
  assert.equal((await b.get(shown('修炼爱情', '林俊杰'))).lines[0].text, 'right');
});

test('English artist name on Spotify, Chinese on LRCLIB: matched through the Chinese names', async () => {
  const p = createLyricsProvider({ fetchFn: lrclibWith(filedAs('林俊杰')), storage: memoryStorage() });
  assert.equal((await p.get(shown('修煉愛情', 'JJ Lin'), { alternates: zhNames })).lines[0].text, 'right');
  // Without them the artist can't be confirmed, so nothing is shown rather than a guess.
  const blind = createLyricsProvider({ fetchFn: lrclibWith(filedAs('林俊杰')), storage: memoryStorage() });
  assert.equal((await blind.get(shown('修煉愛情', 'JJ Lin'))).status, 'none');
});

test('Chinese artist name on Spotify, English on LRCLIB: matched through the English names', async () => {
  const p = createLyricsProvider({ fetchFn: lrclibWith(filedAs('JJ Lin')), storage: memoryStorage() });
  assert.equal((await p.get(shown('修炼爱情', '林俊杰'), { alternates: enNames })).lines[0].text, 'right');
});

test('everything in English on Spotify: the Chinese names decide it is a Chinese song and find it', async () => {
  let askedWith = null;
  const p = createLyricsProvider({
    fetchFn: lrclibWith([]),
    storage: memoryStorage(),
    backupFirst: 'cjk',
    backup: async (track, { en }) => ((askedWith = en), { syncedLyrics: '[00:01.00]from netease', source: 'netease' }),
  });
  const r = await p.get({ id: 'latin', name: 'Practice Love', artists: ['JJ Lin'], album: 'Stories Untold', durationMs: 287_000 }, { alternates: zhNames });
  assert.equal(r.lines[0].text, 'from netease');
  assert.equal(askedWith.artists[0], '林俊傑');
});

test('a different artist with the same title and length is never accepted, whatever the script', async () => {
  for (const other of ['張學友', '张学友', 'Jacky Cheung']) {
    const p = createLyricsProvider({ fetchFn: lrclibWith(filedAs(other)), storage: memoryStorage() });
    assert.equal((await p.get(shown('修煉愛情', '林俊傑'), { alternates: enNames })).status, 'none', other);
  }
});
