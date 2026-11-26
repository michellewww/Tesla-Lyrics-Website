import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traditionalVariants } from '../public/js/s2t.js';

test('Simplified → Traditional spellings for searching (Taiwan and Hong Kong forms)', () => {
  assert.deepEqual(traditionalVariants('对等关系'), ['對等關係']);
  assert.deepEqual(traditionalVariants('头发'), ['頭髮']);
  assert.deepEqual(traditionalVariants('你在哪里'), ['你在哪裡', '你在哪裏']);
  assert.deepEqual(traditionalVariants(''), []);
});
