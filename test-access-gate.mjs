import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (name) => readFile(new URL(name, import.meta.url), 'utf8');

test('the human FPV soundtrack pages wait for a remembered unlock', async () => {
  const [index, guide, entry, gate, verify] = await Promise.all([
    read('index.html'),
    read('upload-guide/index.html'),
    read('access-entry.mjs'),
    read('access-gate.mjs'),
    read('verify.mjs'),
  ]);
  for (const source of [index, guide]) {
    assert.match(source, /data-access-state="locked"/);
    assert.match(source, /gAyuiiAcFRyvuK-SSl9CLx1qPCFKsIoDmozGee5jedk/);
  }
  assert.match(entry, /await globalThis\.RevealLineAccess\?\.ready/);
  assert.match(entry, /import\('\.\/player\.mjs/);
  assert.match(gate, /localStorage\?\.setItem/);
  assert.doesNotMatch(gate, /fetch\s*\(|serviceWorker/);
  assert.match(verify, /"catalogue\.json"/);
});
