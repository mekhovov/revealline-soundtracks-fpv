export const MAX_CONSECUTIVE_MEDIA_FAILURES = 3;

export function mediaEventBelongsToPlayback({ active, row, currentSrc, src }) {
  if (!active || active.row !== row) return false;
  const observed = currentSrc || src || "";
  return !observed || observed === active.url;
}

export function shouldAdvanceAfterMediaFailure({ consecutiveFailures, remaining }) {
  return remaining > 0 && consecutiveFailures < MAX_CONSECUTIVE_MEDIA_FAILURES;
}
