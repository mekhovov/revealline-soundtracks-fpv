import { STYLE_GROUPS as STYLE_DEFINITIONS, canonicalStyles } from './style-taxonomy.mjs';

export const STYLE_GROUPS = Object.freeze(
  STYLE_DEFINITIONS.map(({ id, label }) => Object.freeze([id, label])),
);

export function stylesOf(track) {
  return canonicalStyles(track?.tags);
}

export function matchesStyles(trackStyles, selectedStyles) {
  const selected = new Set(selectedStyles);
  return selected.size > 0 && trackStyles.some((style) => selected.has(style));
}

export function buildPlaybackQueue(
  candidates,
  { order = 'shuffle', current = null, wrap = true, random = Math.random } = {},
) {
  if (!['ordered', 'shuffle'].includes(order)) throw new Error('Unsupported playback order.');
  const queue = [...candidates];
  if (order === 'shuffle') {
    for (let index = queue.length - 1; index > 0; index--) {
      const swap = Math.floor(random() * (index + 1));
      [queue[index], queue[swap]] = [queue[swap], queue[index]];
    }
    if (queue.length > 1 && queue[0] === current)
      [queue[0], queue[1]] = [queue[1], queue[0]];
    return queue;
  }
  if (!current || !queue.includes(current)) return queue;
  const offset = queue.indexOf(current) + 1;
  return wrap ? [...queue.slice(offset), ...queue.slice(0, offset)] : queue.slice(offset);
}
