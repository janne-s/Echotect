import test from 'node:test';
import assert from 'node:assert/strict';
import { zipStore } from '../src/zip.js';

test('ZIP store writes local, central, and end records', () => {
  const zip = zipStore([{ name: 'a.txt', data: new TextEncoder().encode('hello') }]);
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(zip.length - 14, true), 1);
});
