import assert from 'node:assert/strict';
import test from 'node:test';
import { STYLE_GROUPS, stylesOf } from './playback-policy.mjs';

test('player styles are ordered for gameplay while Ukrainian and FPV remain last', () => {
  assert.deepEqual(STYLE_GROUPS.map(([id]) => id), [
    'synth', 'metal', 'chiptune', 'rock', 'electronic', 'ambient',
    'fusion', 'other', 'ukrainian', 'fpv',
  ]);
});

test('UA joins Ukrainian while only the exact Cyrillic tag joins FPV', () => {
  assert.deepEqual(stylesOf({ tags: ['ФПВ', 'UA'] }), ['ukrainian', 'fpv']);
  assert.deepEqual(stylesOf({ tags: ['Ukrainian', 'Metal'] }), ['metal', 'ukrainian']);
  assert.deepEqual(stylesOf({ tags: ['FPV', 'Metal'] }), ['metal']);
});

test('synth, electronic and chiptune remain separate broad families', () => {
  assert.deepEqual(stylesOf({ tags: ['synthwave'] }), ['synth']);
  assert.deepEqual(stylesOf({ tags: ['techno'] }), ['electronic']);
  assert.deepEqual(stylesOf({ tags: ['tracker', '8-bit'] }), ['chiptune']);
  assert.deepEqual(stylesOf({ tags: ['synth-metal'] }), ['synth', 'metal', 'fusion']);
});
