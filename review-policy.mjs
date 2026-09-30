import { isEligibleForArchive } from "./licensing-policy.mjs";
export const REVIEW_ACCESS_KEY = "fpv-musical-review";
export const isReviewOnly = (track) => track?.visibility === "review-only";
export function tracksForView(tracks, key = "") {
  return tracks.filter((track) => isEligibleForArchive(track) &&
    (key === REVIEW_ACCESS_KEY ? isReviewOnly(track) : !isReviewOnly(track)));
}
