import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guessLang, hasCjk, lineSegments, segmentProgress, tokenize } from '../public/js/karaoke.js';

test('tokenize: one token per CJK character (with trailing punctuation), whole Latin words', () => {
  assert.deepEqual(tokenize('你好，世界'), ['你', '好，', '世', '界']);
  assert.deepEqual(tokenize('Hello big world'), ['Hello ', 'big ', 'world']);
  assert.deepEqual(tokenize('我爱 Tesla 车'), ['我', '爱 ', 'Tesla ', '车']);
  assert.equal(tokenize('Hello big world').join(''), 'Hello big world');
});

test('estimated segments cover the line in order and stay before the next line', () => {
  const segs = lineSegments({ time: 1000, text: 'Windows down on an empty road' }, 5000);
  assert.equal(segs.map((s) => s.text).join(''), 'Windows down on an empty road');
  assert.equal(segs[0].start, 1000);
  for (let i = 1; i < segs.length; i++) assert.ok(Math.abs(segs[i].start - segs[i - 1].end) < 1e-6);
  assert.ok(segs[segs.length - 1].end <= 5000);
  // Longer words take longer.
  assert.ok(segs[0].end - segs[0].start > segs[3].end - segs[3].start);
});

test('word timings are used exactly when present', () => {
  const segs = lineSegments(
    { time: 1000, end: 3000, text: 'Hello world', words: [{ text: 'Hello ', time: 1000 }, { text: 'world', time: 2000 }] },
    9000,
  );
  assert.deepEqual(segs, [
    { text: 'Hello ', start: 1000, end: 2000 },
    { text: 'world', start: 2000, end: 3000 },
  ]);
});

test('a whole phrase timed as one word is split per character', () => {
  const segs = lineSegments({ time: 0, end: 4000, text: '一二三四', words: [{ text: '一二三四', time: 0 }] }, 6000);
  assert.deepEqual(segs.map((s) => s.text), ['一', '二', '三', '四']);
  assert.deepEqual(segs.map((s) => Math.round(s.start)), [0, 1000, 2000, 3000]);
  assert.equal(segs[3].end, 4000);
});

test('segmentProgress clamps to 0–1', () => {
  const seg = { start: 100, end: 200 };
  assert.equal(segmentProgress(seg, 50), 0);
  assert.equal(segmentProgress(seg, 150), 0.5);
  assert.equal(segmentProgress(seg, 500), 1);
});

test('language guessing for CJK text', () => {
  assert.equal(guessLang(['夜色铺满了高速公路']), 'zh-CN');
  assert.equal(guessLang(['こんにちは']), 'ja');
  assert.equal(guessLang(['안녕하세요']), 'ko');
  assert.equal(guessLang(['Hello']), '');
  assert.ok(hasCjk('abc 中'));
  assert.ok(!hasCjk('abc'));
});
