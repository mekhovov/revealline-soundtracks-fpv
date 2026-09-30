import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CONSECUTIVE_MEDIA_FAILURES,
  mediaEventBelongsToPlayback,
  shouldAdvanceAfterMediaFailure,
} from "./playback-recovery.mjs";

test("stale media errors cannot fail the replacement recording", () => {
  const first = { id: "first" };
  const second = { id: "second" };
  const active = { row: second, url: "https://example.test/second.mp3" };

  assert.equal(
    mediaEventBelongsToPlayback({
      active,
      row: first,
      currentSrc: "https://example.test/first.mp3",
      src: "https://example.test/second.mp3",
    }),
    false,
  );
  assert.equal(
    mediaEventBelongsToPlayback({
      active,
      row: second,
      currentSrc: "https://example.test/first.mp3",
      src: "https://example.test/second.mp3",
    }),
    false,
  );
  assert.equal(
    mediaEventBelongsToPlayback({
      active,
      row: second,
      currentSrc: "https://example.test/second.mp3",
      src: "https://example.test/second.mp3",
    }),
    true,
  );
});

test("automatic recovery stops after a bounded run of media failures", () => {
  assert.equal(
    shouldAdvanceAfterMediaFailure({ consecutiveFailures: 1, remaining: 4 }),
    true,
  );
  assert.equal(
    shouldAdvanceAfterMediaFailure({
      consecutiveFailures: MAX_CONSECUTIVE_MEDIA_FAILURES,
      remaining: 4,
    }),
    false,
  );
  assert.equal(
    shouldAdvanceAfterMediaFailure({ consecutiveFailures: 1, remaining: 0 }),
    false,
  );
});
