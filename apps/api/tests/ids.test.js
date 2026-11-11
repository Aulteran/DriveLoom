import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uuidv7, isUuid } from '../src/ids.js';

test('uuidv7 has version 7 and RFC variant', () => {
  const id = uuidv7();
  assert.ok(isUuid(id));
  assert.equal(id[14], '7');
  assert.match(id[19], /[89ab]/);
});

test('uuidv7 is unique and monotonic within a process', () => {
  const ids = Array.from({ length: 5000 }, () => uuidv7());
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), ids);
});

test('uuidv7 embeds the timestamp', () => {
  const t = Date.UTC(2030, 0, 1);
  const id = uuidv7(t);
  assert.equal(parseInt(id.replaceAll('-', '').slice(0, 12), 16), t);
});

test('isUuid rejects junk', () => {
  for (const v of ['', 'abc', null, 42, '018f3b1e-7c4a-7d2e-9a10-5b6c7d8e9f0']) assert.equal(isUuid(v), false);
});
