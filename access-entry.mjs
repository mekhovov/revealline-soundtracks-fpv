await globalThis.RevealLineAccess?.ready;
await Promise.all([
  import('./player.mjs?v=20260927-6'),
  import('./intake-browser.mjs?v=20260927-3'),
]);
