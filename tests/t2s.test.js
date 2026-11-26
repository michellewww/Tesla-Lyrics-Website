import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simplifyLines, toSimplified } from '../public/js/t2s.js';

test('converts Traditional Chinese to Simplified with opencc-js', () => {
  assert.equal(toSimplified('為什麼'), '为什么');
  assert.equal(toSimplified('乾淨的頭髮'), '干净的头发');
  assert.equal(toSimplified('你在哪裡'), '你在哪里');
  // OpenCC's phrase data handles context-dependent characters.
  assert.equal(toSimplified('雨後的公路閃著光'), '雨后的公路闪着光');
  assert.equal(toSimplified('著名的歌手'), '著名的歌手');
  assert.equal(toSimplified('乾隆'), '乾隆');
});

test('leaves Simplified Chinese and other scripts alone', () => {
  assert.equal(toSimplified('已经是简体中文'), '已经是简体中文');
  assert.equal(toSimplified('Hello, world!'), 'Hello, world!');
  assert.equal(toSimplified(''), '');
  // Character conversion only — vocabulary isn't localised (软体, not 软件).
  assert.equal(toSimplified('軟體'), '软体');
});

test('simplifyLines converts text, translations and timed words without moving timings', () => {
  const [line] = simplifyLines([
    {
      time: 1000,
      text: '雨後的公路 閃著光',
      translation: '雨後',
      words: [
        { text: '雨後的公路 ', time: 1000 },
        { text: '閃著光', time: 2500 },
      ],
    },
  ]);
  assert.equal(line.text, '雨后的公路 闪着光');
  assert.equal(line.translation, '雨后');
  assert.deepEqual(line.words, [
    { text: '雨后的公路 ', time: 1000 },
    { text: '闪着光', time: 2500 },
  ]);
  assert.equal(line.time, 1000);
});
