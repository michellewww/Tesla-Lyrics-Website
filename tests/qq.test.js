import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanQQLrc, createQQLyrics } from '../public/js/qq.js';
import { createLyricsProvider } from '../public/js/lyrics.js';
import worker from '../relay/qq-lyrics-worker.js';
import { fakeFetch, jsonResponse, memoryStorage } from './helpers.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const song = (over = {}) => ({ mid: '0011Wex93wPqXU', title: 'Gunfire Song', singer: [{ name: '林俊杰' }], album: { name: '100天' }, interval: 246, ...over });
const searchReply = (list) => ({ code: 0, req: { code: 0, data: { body: { song: { list } } } } });
const LRC = [
  '[ti:Gunfire Song]',
  '[ar:林俊杰]',
  '[offset:0]',
  '[00:00.00]Gunfire Song - 林俊杰',
  '[00:03.09]Lyrics by：林俊杰',
  '[00:06.18]词：林俊杰',
  '[00:15.45]Still moving',
  '[00:19.48]No one&apos;s beside',
].join('\n');

function relay({ list = [song()], lyric = LRC, trans = '' } = {}) {
  return fakeFetch((url) => {
    const u = new URL(url);
    if (u.pathname === '/search') return jsonResponse(200, searchReply(list));
    if (u.pathname === '/lyric') return jsonResponse(200, { retcode: 0, lyric: b64(lyric), trans: trans && b64(trans) });
    return jsonResponse(404, {});
  });
}
const TRACK = { id: 't', name: 'Gunfire Song', artists: ['林俊傑'], album: '100天', durationMs: 244_000 };
const t2s = (s) => s.replace(/傑/g, '杰');

test('QQ lyrics lose their title line, credits and tags, and keep the words', () => {
  assert.equal(cleanQQLrc(LRC), "[00:15.45]Still moving\n[00:19.48]No one's beside");
  assert.equal(cleanQQLrc('[ti:x]\n[00:00.00]Song - Artist\n[00:02.00]作曲：someone'), '');
});

test('a matching QQ song is found and returned as timed lyrics', async () => {
  const fetchFn = relay();
  const qq = createQQLyrics({ relay: 'https://relay.test/', fetchFn });
  const r = await qq.find(TRACK, { fold: t2s });
  assert.equal(r.syncedLyrics, "[00:15.45]Still moving\n[00:19.48]No one's beside");
  assert.equal(r.duration, 246);
  assert.equal(new URL(fetchFn.calls[0].url).searchParams.get('q'), 'Gunfire Song 林俊杰'); // asked in Simplified
});

test('an English artist name is accepted only when the album confirms the song', async () => {
  const track = { ...TRACK, artists: ['JJ Lin'] };
  const qq = createQQLyrics({ relay: 'https://relay.test', fetchFn: relay() });
  assert.ok((await qq.find(track))?.syncedLyrics);
  const elsewhere = createQQLyrics({ relay: 'https://relay.test', fetchFn: relay({ list: [song({ album: { name: '别的专辑' } })] }) });
  assert.equal(await elsewhere.find(track), null);
});

test('other artists, other lengths, other titles and backing tracks are not accepted', async () => {
  const list = [
    song({ mid: 'aaaaaaa1', singer: [{ name: '别人' }] }),
    song({ mid: 'aaaaaaa2', interval: 252 }),
    song({ mid: 'aaaaaaa3', title: 'Gunfire Song Two' }),
    song({ mid: 'aaaaaaa4', title: 'Gunfire Song (伴奏)' }),
  ];
  const fetchFn = relay({ list });
  const qq = createQQLyrics({ relay: 'https://relay.test', fetchFn });
  assert.equal(await qq.find(TRACK, { fold: t2s }), null);
  assert.ok(fetchFn.calls.every((c) => !c.url.includes('/lyric')));
});

test('a translation is paired with the original lines', async () => {
  const trans = '[00:00.00]//\n[00:15.45]仍在前行\n[00:19.48]无人在旁';
  const qq = createQQLyrics({ relay: 'https://relay.test', fetchFn: relay({ trans }) });
  const p = createLyricsProvider({ fetchFn: fakeFetch(() => jsonResponse(404, {})), storage: memoryStorage(), backup: (t, o) => qq.find(t, o) });
  const r = await p.get(TRACK);
  assert.equal(r.status, 'synced');
  assert.equal(r.lines.find((l) => l.text === 'Still moving').translation, '仍在前行');
});

test('"no lyrics" placeholders and an unset relay give nothing', async () => {
  const qq = createQQLyrics({ relay: 'https://relay.test', fetchFn: relay({ lyric: '[00:00.00]此歌曲为没有填词的纯音乐，请您欣赏' }) });
  assert.equal(await qq.find(TRACK, { fold: t2s }), null);
  const off = createQQLyrics({ relay: '', fetchFn: () => assert.fail('must not fetch') });
  assert.equal(await off.find(TRACK), null);
});

test('the backup is asked only when LRCLIB has no timed lyrics, and beats plain ones', async () => {
  let asked = 0;
  const backup = async () => (asked++, { syncedLyrics: '[00:01.00]from backup', duration: 244, source: 'qq' });
  const timed = createLyricsProvider({ fetchFn: fakeFetch(() => jsonResponse(200, { id: 1, syncedLyrics: '[00:01.00]from lrclib' })), storage: memoryStorage(), backup });
  assert.equal((await timed.get(TRACK)).lines[0].text, 'from lrclib');
  assert.equal(asked, 0);

  const plain = { id: 1, trackName: 'Gunfire Song', artistName: '林俊傑', albumName: '100天', duration: 244, plainLyrics: 'plain words' };
  const plainOnly = createLyricsProvider({
    fetchFn: fakeFetch((url) => (new URL(url).pathname === '/api/get' ? jsonResponse(200, plain) : jsonResponse(200, [plain]))),
    storage: memoryStorage(),
    backup,
  });
  assert.equal((await plainOnly.get(TRACK)).lines[0].text, 'from backup');
  assert.equal(asked, 1);
});

test('a failing backup leaves the LRCLIB result, to be re-checked soon', async () => {
  const plain = { id: 1, trackName: 'Gunfire Song', artistName: '林俊傑', albumName: '100天', duration: 244, plainLyrics: 'plain words' };
  const p = createLyricsProvider({
    fetchFn: fakeFetch((url) => (new URL(url).pathname === '/api/get' ? jsonResponse(200, plain) : jsonResponse(200, [plain]))),
    storage: memoryStorage(),
    backup: async () => {
      throw new Error('relay down');
    },
  });
  const r = await p.get(TRACK);
  assert.equal(r.status, 'plain');
  assert.equal(r.incomplete, true);
});

test('the relay only passes on well-formed requests and allows the page to read replies', async () => {
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => (seen.push({ url: String(url), init }), new Response('{"ok":1}', { status: 200 }));
  try {
    const get = (path, init) => worker.fetch(new Request(`https://relay.test${path}`, init));
    assert.equal((await get('/lyric?mid=../../etc')).status, 400);
    assert.equal((await get('/search')).status, 400);
    assert.equal((await get('/anything')).status, 404);
    assert.equal((await get('/search?q=x', { method: 'POST' })).status, 405);
    assert.equal(seen.length, 0);
    const ok = await get('/lyric?mid=0011Wex93wPqXU', { headers: { Origin: 'https://someone.github.io' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('Access-Control-Allow-Origin'), '*');
    assert.ok(seen[0].url.startsWith('https://c.y.qq.com/'));
    await get('/search?q=hello');
    assert.ok(seen[1].url.startsWith('https://u.y.qq.com/'));
    assert.equal(JSON.parse(seen[1].init.body).req.param.query, 'hello');
  } finally {
    globalThis.fetch = real;
  }
});
