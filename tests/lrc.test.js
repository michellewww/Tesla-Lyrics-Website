import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findActiveIndex, parseLrc, parseLyricsfile, parsePlain, withIntro } from '../public/js/lrc.js';

test('parses basic LRC lines and fractional seconds', () => {
  const lines = parseLrc('[ar:Someone]\n[00:01.5]one\n[00:02.05]two\n[01:03.250]three');
  assert.deepEqual(lines, [
    { time: 1500, text: 'one' },
    { time: 2050, text: 'two' },
    { time: 63250, text: 'three' },
  ]);
});

test('expands lines with several timestamps and sorts them', () => {
  const lines = parseLrc('[00:10.00][00:30.00]chorus\n[00:20.00]verse');
  assert.deepEqual(lines.map((l) => [l.time, l.text]), [
    [10000, 'chorus'],
    [20000, 'verse'],
    [30000, 'chorus'],
  ]);
});

test('applies the [offset] tag (positive = earlier)', () => {
  const lines = parseLrc('[offset:+500]\n[00:02.00]a\n[00:00.20]b');
  assert.deepEqual(lines.map((l) => l.time), [0, 1500]);
});

test('keeps empty lines as instrumental breaks but collapses repeats', () => {
  const lines = parseLrc('[00:01.00]a\n[00:02.00]\n[00:03.00]\n[00:04.00]b');
  assert.deepEqual(lines.map((l) => l.text), ['a', '', 'b']);
});

test('parses enhanced LRC word timestamps', () => {
  const [line] = parseLrc('[00:12.00]<00:12.00>Hello <00:12.50>big <00:13.10>world<00:14.00>');
  assert.equal(line.text, 'Hello big world');
  assert.equal(line.end, 14000);
  assert.deepEqual(line.words, [
    { text: 'Hello ', time: 12000 },
    { text: 'big ', time: 12500 },
    { text: 'world', time: 13100 },
  ]);
});

test('enhanced LRC: whitespace between stamps still separates words', () => {
  const [line] = parseLrc('[00:01.00]<00:01.00>a<00:01.50> <00:02.00>b');
  assert.equal(line.text, 'a b');
  assert.deepEqual(line.words.map((w) => w.text), ['a ', 'b']);
});

test('merges same-timestamp lines into a translation', () => {
  const lines = parseLrc('[00:03.00]夜色铺满了高速公路\n[00:03.00]Night spreads across the highway\n[00:07.00]下一句');
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, '夜色铺满了高速公路');
  assert.equal(lines[0].translation, 'Night spreads across the highway');
});

test('findActiveIndex uses binary search semantics', () => {
  const lines = [{ time: 1000 }, { time: 2000 }, { time: 3000 }];
  assert.equal(findActiveIndex(lines, 0), -1);
  assert.equal(findActiveIndex(lines, 1000), 0);
  assert.equal(findActiveIndex(lines, 2999), 1);
  assert.equal(findActiveIndex(lines, 99999), 2);
  assert.equal(findActiveIndex([], 5), -1);
});

test('withIntro adds a leading break only for late starts', () => {
  assert.equal(withIntro([{ time: 500, text: 'a' }]).length, 1);
  const out = withIntro([{ time: 8000, text: 'a' }]);
  assert.deepEqual(out[0], { time: 0, text: '' });
});

test('parsePlain keeps blank lines as spacers', () => {
  assert.deepEqual(parsePlain('a\n\nb').map((l) => l.text), ['a', '', 'b']);
});

const LYRICSFILE = `version: '1.0'
metadata:
  title: Placeholder Song
  artist: Nobody
  duration_ms: 200000
  instrumental: false
  language: en
lines:
- text: Alpha beta
  start_ms: 1000
  end_ms: 2600
  words:
  - text: 'Alpha '
    start_ms: 1000
  - text: beta
    start_ms: 1800
- text: "It's \\"quoted\\""
  start_ms: 9000
  end_ms: 9800
  words:
  - text: "It's "
    start_ms: 9000
  - text: '"quoted"'
    start_ms: 9400
- text: 夜色铺满了高速公路
  start_ms: 10000
  end_ms: 13000
  words:
  - text: 夜色铺满了高速公路
    start_ms: 10000
- text: ''
  start_ms: 14000
  words: []
plain: |-
  Alpha beta
  It's "quoted"
`;

test('parses an LRCLIB Lyricsfile with word timings', () => {
  const lines = parseLyricsfile(LYRICSFILE);
  assert.equal(lines[0].text, 'Alpha beta');
  assert.equal(lines[0].end, 2600);
  assert.deepEqual(lines[0].words, [
    { text: 'Alpha ', time: 1000 },
    { text: 'beta', time: 1800 },
  ]);
  // A long silence after a line with an explicit end becomes a break.
  assert.deepEqual(lines[1], { time: 2600, text: '' });
  assert.equal(lines[2].text, 'It\'s "quoted"');
  assert.deepEqual(lines[2].words.map((w) => w.text), ["It's ", '"quoted"']);
  assert.equal(lines[3].text, '夜色铺满了高速公路');
  assert.equal(lines[4].text, '');
});

test('parseLyricsfile throws on documents without lines', () => {
  assert.throws(() => parseLyricsfile('version: 1'));
});
