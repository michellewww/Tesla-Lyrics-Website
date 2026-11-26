// End-to-end timing check: the real Spotify client and sync code over a simulated car
// connection where replies are often slow. Spotify itself is exact here, so the lyrics
// must not settle late. (Regression: assuming replies were instant made them ~0.6–1.3 s
// late for whole songs, and carried that into the next song.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpotify } from '../public/js/spotify.js';
import { PlaybackSync } from '../public/js/sync.js';

function simulate(slowestReplyMs) {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  let t = 0;
  const songs = [
    { id: 'a', start: 0, duration: 120_000 },
    { id: 'b', start: 120_000, duration: 300_000 }, // long enough for the slowest replies
  ];
  const songAt = (ms) => songs.find((s) => ms >= s.start && ms < s.start + s.duration);
  const fetchFn = async () => {
    t += 60 + rand() * 60 + 40 + rand() * 60; // request travels + Spotify works
    const song = songAt(t);
    const body = {
      is_playing: true,
      progress_ms: Math.round(t - song.start), // exact at the moment Spotify measures
      currently_playing_type: 'track',
      item: { type: 'track', id: song.id, name: song.id, duration_ms: song.duration, artists: [], album: { images: [] } },
    };
    t += rand() < 0.1 ? 30 + rand() * 30 : 300 + rand() * (slowestReplyMs - 300); // reply travels back
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  };
  const auth = { getAccessToken: async () => 'AT', refresh: async () => 'AT' };
  const spotify = createSpotify({ auth, fetchFn, now: () => t });
  const sync = new PlaybackSync({ now: () => t });
  return { spotify, sync, songAt, get t() { return t; }, set t(v) { t = v; } };
}

for (const slowest of [1200, 2500]) {
  test(`lyrics don't settle late when replies take up to ${slowest / 1000} s`, async () => {
    const sim = simulate(slowest);
    const errors = [];
    for (let poll = 0; poll < 235; poll++) {
      sim.t = Math.max(sim.t, poll * 1000);
      const pb = await sim.spotify.nowPlaying();
      sim.sync.report({ trackId: pb.track.id, progressMs: pb.progressMs, sampledAt: pb.sampledAt, uncertaintyMs: pb.uncertaintyMs, isPlaying: true, durationMs: pb.track.durationMs });
      const song = sim.songAt(sim.t);
      if (song.id === pb.track.id && sim.t - song.start > 10_000) errors.push(sim.sync.position(sim.t) - (sim.t - song.start));
    }
    const average = errors.reduce((a, b) => a + b, 0) / errors.length;
    // A one-sided network (fast out, slow back) is the worst case for any estimate;
    // the old one settled 0.6 s / 1.25 s late here.
    assert.ok(average > -(slowest === 1200 ? 300 : 700), `average ${Math.round(average)} ms`);
  });
}
