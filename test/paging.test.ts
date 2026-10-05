import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageText, jsonBytes } from '../src/paging.js';

const escaped = (s: string) => jsonBytes(s) - 2;

test('pages never exceed the escaped-byte budget and always make progress', () => {
  const text = 'ab"\\\t\u0001é中😀'.repeat(50) + '\n' + 'short\n';
  for (const budget of [1, 2, 3, 4, 5, 7, 16, 33, 100]) {
    let offset = 0, rebuilt = '';
    while (offset < text.length) {
      const page = pageText(text, offset, budget);
      assert.ok(page.content.length > 0, 'progress');
      const oneCodePoint = [...page.content].length === 1;
      assert.ok(escaped(page.content) <= budget || oneCodePoint, `budget ${budget}: ${escaped(page.content)} bytes`);
      assert.ok(!/[\uD800-\uDBFF]$/.test(page.content), 'no split surrogate pair');
      rebuilt += page.content;
      offset = page.next ?? text.length;
    }
    assert.equal(rebuilt, text);
  }
});

test('whole lines are preferred and maxLines is honored', () => {
  const text = 'one\ntwo\nthree\n';
  assert.deepEqual(pageText(text, 0, 100, 2), { content: 'one\ntwo\n', next: 8 });
  assert.deepEqual(pageText(text, 0, 10), { content: 'one\ntwo\n', next: 8 }, 'escaped newline costs 2 bytes');
  assert.deepEqual(pageText(text, 0, 9), { content: 'one\n', next: 4 });
  assert.deepEqual(pageText(text, 8, 100), { content: 'three\n', next: null });
});
