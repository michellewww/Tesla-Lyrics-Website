import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, AuthRequiredError, RateLimitError, createSpotify, normalizePlayback } from '../public/js/spotify.js';
import { fakeFetch, jsonResponse } from './helpers.js';

const TRACK_RESPONSE = {
  is_playing: true,
  progress_ms: 61_000,
  currently_playing_type: 'track',
  item: {
    type: 'track',
    id: 't1',
    name: 'Song',
    duration_ms: 200_000,
    artists: [{ name: 'Artist A' }, { name: 'Artist B' }],
    album: {
      name: 'Album',
      images: [
        { url: 'https://i.scdn.co/640', width: 640 },
        { url: 'https://i.scdn.co/300', width: 300 },
        { url: 'https://i.scdn.co/64', width: 64 },
      ],
    },
  },
};

function fakeAuth({ token = 'AT', refreshed = 'AT2' } = {}) {
  let current = token;
  return {
    refreshCalls: 0,
    async getAccessToken() {
      return current;
    },
    async refresh() {
      this.refreshCalls++;
      current = refreshed;
      return refreshed;
    },
  };
}

test('normalizePlayback maps a track response', () => {
  const pb = normalizePlayback(TRACK_RESPONSE, 42);
  assert.equal(pb.isPlaying, true);
  assert.equal(pb.progressMs, 61_000);
  assert.equal(pb.sampledAt, 42);
  assert.deepEqual(pb.track.artists, ['Artist A', 'Artist B']);
  assert.equal(pb.track.image, 'https://i.scdn.co/640');
  assert.equal(pb.track.imageMedium, 'https://i.scdn.co/300');
  assert.equal(pb.track.imageSmall, 'https://i.scdn.co/64');
});

test('normalizePlayback handles nothing playing, ads and podcasts', () => {
  assert.equal(normalizePlayback(null, 0).active, false);
  const ad = normalizePlayback({ is_playing: true, currently_playing_type: 'ad', item: null }, 0);
  assert.equal(ad.type, 'ad');
  assert.equal(ad.track, null);
  const ep = normalizePlayback(
    { is_playing: true, progress_ms: 1, currently_playing_type: 'episode', item: { type: 'episode', id: 'e', name: 'Ep', duration_ms: 5, show: { name: 'Show' }, images: [] } },
    0,
  );
  assert.equal(ep.track.isEpisode, true);
  assert.deepEqual(ep.track.artists, ['Show']);
});

test('nowPlaying sends the bearer token and estimates the sample time', async () => {
  const fetchFn = fakeFetch(() => jsonResponse(200, TRACK_RESPONSE));
  let t = 1000;
  const sp = createSpotify({ auth: fakeAuth(), fetchFn, now: () => (t += 100) });
  const pb = await sp.nowPlaying();
  assert.equal(fetchFn.calls[0].init.headers.Authorization, 'Bearer AT');
  assert.match(fetchFn.calls[0].url, /\/me\/player\/currently-playing\?additional_types=episode$/);
  assert.equal(pb.sampledAt, 1150); // midpoint of 1100 and 1200
});

test('204 No Content means nothing is playing', async () => {
  const sp = createSpotify({ auth: fakeAuth(), fetchFn: fakeFetch(() => jsonResponse(204)) });
  const pb = await sp.nowPlaying();
  assert.equal(pb.active, false);
});

test('401 triggers one refresh and a retry', async () => {
  const auth = fakeAuth();
  const fetchFn = fakeFetch((url, init, i) => (i === 0 ? jsonResponse(401, { error: { status: 401 } }) : jsonResponse(200, TRACK_RESPONSE)));
  const sp = createSpotify({ auth, fetchFn });
  const pb = await sp.nowPlaying();
  assert.equal(pb.track.id, 't1');
  assert.equal(auth.refreshCalls, 1);
  assert.equal(fetchFn.calls[1].init.headers.Authorization, 'Bearer AT2');
});

test('repeated 401 or no token requires login', async () => {
  const sp = createSpotify({ auth: fakeAuth(), fetchFn: fakeFetch(() => jsonResponse(401, {})) });
  await assert.rejects(sp.nowPlaying(), AuthRequiredError);
  const sp2 = createSpotify({ auth: fakeAuth({ token: null }), fetchFn: fakeFetch(() => jsonResponse(200, {})) });
  await assert.rejects(sp2.nowPlaying(), AuthRequiredError);
});

test('429 surfaces Retry-After', async () => {
  const sp = createSpotify({ auth: fakeAuth(), fetchFn: fakeFetch(() => jsonResponse(429, {}, { 'Retry-After': '7' })) });
  await assert.rejects(sp.nowPlaying(), (e) => e instanceof RateLimitError && e.retryAfterSec === 7);
});

test('player commands use the right method/path and report Premium errors', async () => {
  const fetchFn = fakeFetch((url) =>
    url.includes('/pause') ? jsonResponse(403, { error: { status: 403, message: 'Premium required', reason: 'PREMIUM_REQUIRED' } }) : jsonResponse(204),
  );
  const sp = createSpotify({ auth: fakeAuth(), fetchFn });
  await sp.seek(12_345.6);
  await sp.next();
  await sp.previous();
  await sp.play();
  await assert.rejects(sp.pause(), (e) => e instanceof ApiError && e.status === 403 && e.reason === 'PREMIUM_REQUIRED');
  assert.deepEqual(
    fetchFn.calls.map((c) => `${c.init.method} ${c.url.replace('https://api.spotify.com/v1', '')}`),
    ['PUT /me/player/seek?position_ms=12346', 'POST /me/player/next', 'POST /me/player/previous', 'PUT /me/player/play', 'PUT /me/player/pause'],
  );
});

test('englishNames asks Spotify in English and ignores a track that changed meanwhile', async () => {
  const fetchFn = fakeFetch(() => jsonResponse(200, TRACK_RESPONSE));
  const sp = createSpotify({ auth: fakeAuth(), fetchFn });
  const names = await sp.englishNames('t1');
  assert.equal(fetchFn.calls[0].init.headers['Accept-Language'], 'en');
  assert.equal(fetchFn.calls[0].init.headers.Authorization, 'Bearer AT');
  assert.deepEqual(names, { name: 'Song', artists: ['Artist A', 'Artist B'], album: 'Album' });
  assert.equal(await sp.englishNames('other-track'), null);
});

test('profile and connectionInfo report the account, devices and what is playing', async () => {
  const fetchFn = fakeFetch((url) => {
    const path = new URL(url).pathname;
    if (path === '/v1/me') return jsonResponse(200, { id: 'u1', display_name: 'Michelle' });
    if (path === '/v1/me/player') return jsonResponse(200, { ...TRACK_RESPONSE, device: { name: 'MacBook', type: 'Computer' } });
    if (path === '/v1/me/player/devices') {
      return jsonResponse(200, { devices: [
        { name: 'MacBook', type: 'Computer', is_active: true, is_restricted: false, is_private_session: false },
        { name: 'Model Y', type: 'Automobile', is_active: false, is_restricted: true, is_private_session: true },
      ] });
    }
    return jsonResponse(404, {});
  });
  const sp = createSpotify({ auth: fakeAuth(), fetchFn });
  assert.equal(await sp.profile(), 'Michelle');
  const info = await sp.connectionInfo();
  assert.equal(info.account, 'Michelle');
  assert.equal(info.nowPlaying, 'Song – Artist A, Artist B');
  assert.equal(info.playingOn, 'MacBook');
  assert.deepEqual(info.devices[1], { name: 'Model Y', type: 'Automobile', active: false, restricted: true, privateSession: true });
  assert.equal(info.error, null);
});

test('connectionInfo copes with nothing playing and partial failures', async () => {
  const fetchFn = fakeFetch((url) => {
    const path = new URL(url).pathname;
    if (path === '/v1/me') return jsonResponse(200, { id: 'u1', display_name: 'Michelle' });
    if (path === '/v1/me/player') return jsonResponse(204);
    return jsonResponse(500, { error: { status: 500, message: 'boom' } });
  });
  const info = await createSpotify({ auth: fakeAuth(), fetchFn }).connectionInfo();
  assert.equal(info.account, 'Michelle');
  assert.equal(info.nowPlaying, null);
  assert.deepEqual(info.devices, []);
  assert.ok(info.error);
});

test('sample time is the midpoint of the request itself, not counting a token refresh', async () => {
  let t = 0;
  const roundTrips = [1800, 200]; // a cold first request, then a normal one
  const fetchFn = async () => {
    t += roundTrips.shift();
    return jsonResponse(200, TRACK_RESPONSE);
  };
  const auth = {
    async getAccessToken() {
      t += 700; // a token refresh before the request must not count
      return 'AT';
    },
    async refresh() {
      return 'AT';
    },
  };
  const sp = createSpotify({ auth, fetchFn, now: () => t });
  const first = await sp.nowPlaying(); // sent at 700 (after the refresh), received at 2500
  assert.equal(first.sampledAt, 1600);
  const second = await sp.nowPlaying(); // sent at 3200, received at 3400
  assert.equal(second.sampledAt, 3300);
});
