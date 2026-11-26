import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlow, parseYaml } from '../public/js/yaml.js';

test('parses nested mappings and sequences of mappings', () => {
  const doc = parseYaml(`a: 1
b:
  c: true
  d: ~
list:
- x: 1
  y: two
- x: 2
  nested:
  - 3
  - '4'
`);
  assert.deepEqual(doc, {
    a: 1,
    b: { c: true, d: null },
    list: [
      { x: 1, y: 'two' },
      { x: 2, nested: [3, '4'] },
    ],
  });
});

test('handles quoting styles', () => {
  const doc = parseYaml(`s1: 'it''s '
s2: "tab\\tnew\\nline \\u4e2d"
s3: plain words: not a key
s4: '1.0'
s5: "#not a comment"
s6: value # a comment
`);
  assert.equal(doc.s1, "it's ");
  assert.equal(doc.s2, 'tab\tnew\nline 中');
  assert.equal(doc.s3, 'plain words: not a key');
  assert.equal(doc.s4, '1.0');
  assert.equal(doc.s5, '#not a comment');
  assert.equal(doc.s6, 'value');
});

test('folds multi-line quoted and plain scalars', () => {
  const doc = parseYaml(`a: 'one
  two'
b: three
  four
c: next
`);
  assert.equal(doc.a, 'one two');
  assert.equal(doc.b, 'three four');
  assert.equal(doc.c, 'next');
});

test('block scalars with chomping', () => {
  const doc = parseYaml(`lit: |-
  line 1
  line 2

after: |
  kept
fold: >
  a
  b
`);
  assert.equal(doc.lit, 'line 1\nline 2');
  assert.equal(doc.after, 'kept\n');
  assert.equal(doc.fold, 'a b\n');
});

test('flow collections', () => {
  assert.deepEqual(parseFlow('[]'), []);
  assert.deepEqual(parseFlow("{text: 'a, b', start_ms: 5}"), { text: 'a, b', start_ms: 5 });
  assert.deepEqual(parseYaml('words: [1, "x", {k: v}]'), { words: [1, 'x', { k: 'v' }] });
});

test('throws on malformed mappings', () => {
  assert.throws(() => parseYaml('a: 1\nnot a mapping line\n'));
});
