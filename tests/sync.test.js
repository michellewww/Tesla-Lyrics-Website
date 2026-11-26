// Simulates a car's Spotify: the true playback timeline, and what Spotify's servers report
// about it — late, noisy, and counting a new song from when they heard about it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlaybackSync } from '../public/js/sync.js';

function harness() {
  let t = 0;
  const sync = new PlaybackSync({ now: () => t });
  const jumpsBack = [];
  const report = (r) => {
    const before = sync.position(r.sampledAt ?? t);
    sync.report({ sampledAt: t, isPlaying: true, durationMs: 200_000, ...r });
    const after = sync.position(r.sampledAt ?? t);
    if (after < before - 300) jumpsBack.push({ t, before, after });
  };
  return {
    sync,
    report,
    jumpsBack,
    get t() {
      return t;
    },
    set t(v) {
      t = v;
    },
  };
}

// Deterministic "noise" in Spotify's position reports, within ±400 ms.
const noise = (i) => [0, 300, -350, 120, -400, 380, -200, 50, -90, 250][i % 10];

test('noisy reports never pull the lyrics backwards', () => {
  const h = harness();
  for (let i = 0; i < 60; i++) {
    h.t = i * 1000;
    h.report({ trackId: 'a', progressMs: 10_000 + h.t + noise(i) });
  }
  assert.deepEqual(h.jumpsBack, []);
  assert.ok(Math.abs(h.sync.position() - (10_000 + h.t)) < 600);
});

test('a song that follows on is counted from the moment the last one ended, despite a late report', () => {
  const h = harness();
  // Song A (30 s) plays to its end at t = 30 s.
  for (let i = 0; i <= 30; i++) {
    h.t = i * 1000;
    h.report({ trackId: 'a', progressMs: h.t, durationMs: 30_000 });
  }
  // Spotify keeps reporting A (stuck at its end) until it hears about B 5 s late, at t = 35 s,
  // and then counts B from 35 s.
  for (let i = 31; i <= 35; i++) {
    h.t = i * 1000;
    h.report({ trackId: 'a', progressMs: 30_000, durationMs: 30_000 });
  }
  for (let i = 36; i <= 60; i++) {
    h.t = i * 1000;
    h.report({ trackId: 'b', progressMs: h.t - 35_000 + noise(i) });
    const truth = h.t - 30_000;
    assert.ok(Math.abs(h.sync.position() - truth) < 600, `at ${h.t}: ${h.sync.position()} vs ${truth}`);
  }
  // Later Spotify catches up with the truth: still no jump.
  for (let i = 61; i <= 70; i++) {
    h.t = i * 1000;
    h.report({ trackId: 'b', progressMs: h.t - 30_000 });
  }
  assert.ok(Math.abs(h.sync.position() - (h.t - 30_000)) < 600);
  assert.deepEqual(h.jumpsBack.filter((j) => j.t > 36_000), []);
});

test('a skip in the middle of a song is followed as reported (no guessing)', () => {
  const h = harness();
  h.t = 0;
  h.report({ trackId: 'a', progressMs: 50_000 });
  h.t = 5000;
  h.report({ trackId: 'b', progressMs: 1000 });
  assert.equal(h.sync.position(), 1000);
});

test('a rewind or seek in the car is followed at once', () => {
  const h = harness();
  for (let i = 0; i <= 10; i++) {
    h.t = i * 1000;
    h.report({ trackId: 'a', progressMs: 60_000 + h.t });
  }
  h.t = 11_000;
  h.report({ trackId: 'a', progressMs: 40_000 }); // rewound 30 s
  assert.equal(h.sync.position(), 40_000);
  h.t = 12_000;
  h.report({ trackId: 'a', progressMs: 120_000 }); // jumped ahead
  assert.equal(h.sync.position(), 120_000);
});

test('a tapped line is held until Spotify catches up, with no snapping back', () => {
  const h = harness();
  for (let i = 0; i <= 5; i++) {
    h.t = i * 1000;
    h.report({ trackId: 'a', progressMs: 20_000 + h.t });
  }
  h.sync.seek(90_000); // tap at t = 5 s
  // Spotify still reports the old position for 4 s...
  for (let i = 6; i <= 9; i++) {
    h.t = i * 1000;
    h.report({ trackId: 'a', progressMs: 20_000 + h.t });
    assert.equal(Math.round(h.sync.position()), 90_000 + (h.t - 5000));
  }
  // ...then reports the seek.
  h.t = 10_000;
  h.report({ trackId: 'a', progressMs: 95_100 });
  assert.ok(Math.abs(h.sync.position() - 95_000) < 300);
  assert.deepEqual(h.jumpsBack, []);
});

test('a tapped line Spotify never confirms gives way after 20 s', () => {
  const h = harness();
  h.report({ trackId: 'a', progressMs: 0 });
  h.sync.seek(100_000);
  h.t = 21_000;
  h.report({ trackId: 'a', progressMs: 21_000 });
  assert.equal(h.sync.position(), 21_000);
});

test('being ahead is corrected only when Spotify says so repeatedly', () => {
  const h = harness();
  h.report({ trackId: 'a', progressMs: 50_000 });
  h.t = 1000;
  h.report({ trackId: 'a', progressMs: 50_000 }); // one report 1 s behind us: ignored
  assert.equal(h.sync.position(), 51_000);
  h.t = 2000;
  h.report({ trackId: 'a', progressMs: 51_000 });
  assert.equal(h.sync.position(), 52_000); // two: still waiting
  h.t = 3000;
  h.report({ trackId: 'a', progressMs: 52_000 }); // third in a row: really ahead → move back
  assert.equal(h.sync.position(), 52_000);
});

test('being behind is caught up once two reports agree', () => {
  const h = harness();
  h.report({ trackId: 'a', progressMs: 50_000 });
  h.t = 1000;
  h.report({ trackId: 'a', progressMs: 52_000 }); // one report 1 s ahead of us: wait
  assert.equal(h.sync.position(), 51_000);
  h.t = 2000;
  h.report({ trackId: 'a', progressMs: 53_000 }); // two agree → catch up
  assert.ok(Math.abs(h.sync.position() - 53_000) < 10);
});

test('pause and resume follow Spotify', () => {
  const h = harness();
  h.report({ trackId: 'a', progressMs: 10_000 });
  h.t = 2000;
  h.report({ trackId: 'a', progressMs: 12_000, isPlaying: false });
  h.t = 9000;
  assert.equal(h.sync.position(), 12_000);
  h.report({ trackId: 'a', progressMs: 12_000, isPlaying: true });
  h.t = 10_000;
  assert.equal(h.sync.position(), 13_000);
});

test('with 2 s between reports, a late-reported next song is still counted from the real end', () => {
  const h = harness();
  for (let i = 0; i <= 30; i += 2) {
    h.t = i * 1000;
    h.report({ trackId: 'a', progressMs: h.t, durationMs: 30_000 });
  }
  for (let i = 32; i <= 36; i += 2) {
    h.t = i * 1000;
    h.report({ trackId: 'a', progressMs: 30_000, durationMs: 30_000 }); // stuck at the end
  }
  h.t = 38_000;
  h.report({ trackId: 'b', progressMs: 2000 }); // heard about at 36 s, counted from then
  assert.ok(Math.abs(h.sync.position() - 8000) < 300, String(h.sync.position()));
});
