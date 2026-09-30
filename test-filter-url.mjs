import assert from "node:assert/strict";
import test from "node:test";
import { parseFilterURL, serializeFilterURL } from "./filter-url.mjs";

const styles = ["fpv", "ua", "metal", "synth"];

test("Unicode artist, collection and style filters round trip", () => {
  const url = serializeFilterURL("https://mekhovov.github.io/revealline-soundtracks/", {
    q: "ніч",
    artist: "TRENCH ORDERLY",
    collection: "ФПВ",
    styles: ["fpv", "ua"],
    order: "sequential",
    repeat: "off",
    track: "trench-orderly.song",
  }, styles);
  assert.deepEqual(parseFilterURL(url, styles), {
    q: "ніч", artist: "TRENCH ORDERLY", collection: "ФПВ", styles: ["fpv", "ua"],
    order: "sequential", repeat: "off", track: "trench-orderly.song",
    review: "",
  });
  assert.equal(url.hash, "#recordings");
});

test("defaults are omitted and an intentionally empty style set uses styles=none", () => {
  const defaults = serializeFilterURL("https://example.test/?old=1", { styles: null, order: "shuffle", repeat: "all" }, styles);
  assert.equal(defaults.search, "");
  const none = serializeFilterURL(defaults, { styles: [], order: "shuffle", repeat: "all" }, styles);
  assert.equal(none.searchParams.get("styles"), "none");
  assert.deepEqual(parseFilterURL(none, styles).styles, []);
});

test("existing track-only links remain valid", () => {
  const state = parseFilterURL("https://example.test/?track=artist.song", styles);
  assert.equal(state.track, "artist.song");
  assert.equal(state.styles, null);
  assert.equal(state.review, "");
});

test("unlisted review access survives share-link serialization", () => {
  const url = serializeFilterURL("https://example.test/", {
    styles: null,
    order: "shuffle",
    repeat: "all",
    review: "base-game-holdback-20260927",
  }, styles);
  assert.equal(url.searchParams.get("review"), "base-game-holdback-20260927");
  assert.equal(parseFilterURL(url, styles).review, "base-game-holdback-20260927");
});
