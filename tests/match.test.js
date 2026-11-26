import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, mainTitle, normalize, pickBest, sameArtist, sameTitle } from '../public/js/match.js';

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

test('pickBest can compare names in Simplified (fold) and use a tighter duration window', async () => {
  const { toSimplified } = await import('../public/js/t2s.js');
  const results = [{ id: 1, trackName: '對等關係 (feat. 張惠妹)', artistName: '李榮浩', duration: 327, syncedLyrics: 's' }];
  assert.equal(pickBest(results, { durationSec: 327, title: '对等关系', artist: '李荣浩' }), null);
  assert.equal(pickBest(results, { durationSec: 327, title: '对等关系', artist: '李荣浩', fold: toSimplified }).id, 1);
  assert.equal(pickBest(results, { durationSec: 331, title: '对等关系', fold: toSimplified, maxDiff: 3 }), null);
});

test('mainTitle, sameTitle and sameArtist', () => {
  assert.equal(mainTitle('对等关系 - Equivalence Relation (feat. aMEI)'), '对等关系');
  assert.equal(mainTitle('對等關係（伴奏）'), '對等關係');
  assert.ok(sameTitle('Home (2019 Remaster)', 'home'));
  assert.ok(!sameTitle('Coming Home', 'Home'));
  assert.ok(sameArtist('Li, Ronghao & A‐Mei', 'Ronghao Li'));
  assert.ok(sameArtist('Ronghao Li, A-Mei Chang', 'Ronghao Li'));
  assert.ok(!sameArtist('Lily', 'Li'));
  assert.ok(sameArtist('李荣浩, 张惠妹', '李荣浩'));
});

test('sameArtist compares whole credited names', () => {
  assert.ok(!sameArtist('Different Band', 'Band'));
  assert.ok(sameArtist('Band & Friend', 'Band'));
  assert.ok(sameArtist('The Beatles', 'Beatles'));
  assert.ok(sameArtist('Queen + David Bowie', 'Queen'));
  assert.ok(sameArtist('Simon & Garfunkel', 'Simon and Garfunkel'));
  assert.ok(sameArtist('米津 玄師', '米津玄師'));
});

test('a shared surname is not enough for an artist match', () => {
  assert.ok(!sameArtist('Li, Ronghao', 'Li, Yuchun'));
  assert.ok(!sameArtist('Li, Yuchun', 'Ronghao Li'));
  assert.ok(sameArtist('Li, Ronghao', 'Ronghao Li'));
  assert.ok(sameArtist('Li, Ronghao & A‐Mei', 'Ronghao Li'));
  assert.ok(sameArtist('Adele, Sam Smith', 'Adele'));
  assert.ok(sameArtist('Ronghao Li, A-Mei Chang', 'A-Mei Chang'));
});

test('comma-separated CJK artists are separate people', () => {
  assert.ok(sameArtist('李荣浩, 张惠妹', '张惠妹'));
  assert.ok(!sameArtist('李荣浩, 张惠妹', '李宇春'));
});
