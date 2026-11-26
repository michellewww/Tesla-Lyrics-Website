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
