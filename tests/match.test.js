import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, normalize, pickBest } from '../public/js/match.js';

test('cleanTitle strips Spotify-style decorations', () => {
  assert.equal(cleanTitle('Song Name - Remastered 2011'), 'Song Name');
  assert.equal(cleanTitle('Song Name (feat. Somebody)'), 'Song Name');
  assert.equal(cleanTitle('Song Name - Live at Wembley'), 'Song Name');
  assert.equal(cleanTitle('Song Name [Radio Edit]'), 'Song Name');
  assert.equal(cleanTitle('Song - Name'), 'Song - Name'); // a dash that isn't a version tag stays
  assert.equal(cleanTitle('晴天'), '晴天');
});

test('normalize folds case, accents and punctuation', () => {
  assert.equal(normalize('Beyoncé & Jay-Z'), 'beyonce and jay z');
  assert.equal(normalize('周杰倫'), '周杰倫');
});

test('pickBest prefers synced lyrics with the closest duration', () => {
  const results = [
    { id: 1, trackName: 'A', artistName: 'X', duration: 200, plainLyrics: 'p' },
    { id: 2, trackName: 'A', artistName: 'X', duration: 230, syncedLyrics: '[00:01.00]a' },
    { id: 3, trackName: 'A', artistName: 'X', duration: 203, syncedLyrics: '[00:01.00]a' },
  ];
  assert.equal(pickBest(results, { durationSec: 201 }).id, 3);
});

test('pickBest falls back to plain lyrics and rejects wrong artists', () => {
  const results = [
    { id: 1, trackName: 'A', artistName: 'Other', duration: 200, syncedLyrics: '[00:01.00]a' },
    { id: 2, trackName: 'A', artistName: 'X', duration: 200, plainLyrics: 'p' },
  ];
  assert.equal(pickBest(results, { durationSec: 200, artist: 'X', title: 'A' }).id, 2);
  assert.equal(pickBest([], {}), null);
  assert.equal(pickBest(null, {}), null);
});

test('pickBest gives word-synced records a small edge', () => {
  const results = [
    { id: 1, trackName: 'A', artistName: 'X', duration: 200, syncedLyrics: 's' },
    { id: 2, trackName: 'A', artistName: 'X', duration: 201, syncedLyrics: 's', hasWordSync: true },
  ];
  assert.equal(pickBest(results, { durationSec: 200 }).id, 2);
});
