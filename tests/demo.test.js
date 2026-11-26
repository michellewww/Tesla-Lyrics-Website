import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDemo } from '../public/js/demo.js';

test('demo with reportLagMs reports changes late, like a car, while upNext is current', async () => {
  const { player } = createDemo({ latencyMs: 0, reportLagMs: 60 });
  const first = await player.nowPlaying();
  await player.next();
  assert.equal((await player.nowPlaying()).track.id, first.track.id); // not reported yet
  assert.notEqual((await player.upNext()).currentId, first.track.id); // the queue knows
  await new Promise((r) => setTimeout(r, 90));
  assert.notEqual((await player.nowPlaying()).track.id, first.track.id); // reported now
});

test('like a car, the late report also puts the position behind by the delay', async () => {
  let t = 0;
  const { player } = createDemo({ latencyMs: 0, reportLagMs: 50, now: () => t });
  await player.seek(10_000);
  await new Promise((r) => setTimeout(r, 80)); // the report lands at t = 0 (fake clock)
  t = 3000;
  const r = await player.nowPlaying();
  assert.equal(r.progressMs, 13_000); // counted from when Spotify heard, not from the seek
});
