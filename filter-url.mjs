const ORDER = new Set(["sequential", "shuffle"]);
const REPEAT = new Set(["all", "one", "off"]);

export const DEFAULT_FILTER_STATE = Object.freeze({
  q: "",
  artist: "",
  collection: "",
  styles: null,
  order: "shuffle",
  repeat: "all",
  track: "",
  review: "",
});

const unique = (values) => [...new Set(values.filter(Boolean))];

export function parseFilterURL(input, knownStyles = []) {
  const url = input instanceof URL ? input : new URL(input, "https://example.invalid/");
  const params = url.searchParams;
  const allowed = new Set(knownStyles);
  let styles = null;
  if (params.has("styles")) {
    const value = params.get("styles");
    styles = value === "none" ? [] : unique(value.split(",").map((item) => item.trim())).filter((item) => allowed.has(item));
  }
  const order = params.get("order");
  const repeat = params.get("repeat");
  return {
    q: params.get("q")?.trim() ?? "",
    artist: params.get("artist")?.trim() ?? "",
    collection: params.get("collection")?.trim() ?? "",
    styles,
    order: ORDER.has(order) ? order : DEFAULT_FILTER_STATE.order,
    repeat: REPEAT.has(repeat) ? repeat : DEFAULT_FILTER_STATE.repeat,
    track: params.get("track")?.trim() ?? "",
    review: params.get("review")?.trim() ?? "",
  };
}

export function serializeFilterURL(input, state, knownStyles = []) {
  const url = input instanceof URL ? new URL(input.href) : new URL(input, "https://example.invalid/");
  const params = new URLSearchParams();
  if (state.q?.trim()) params.set("q", state.q.trim());
  if (state.artist?.trim()) params.set("artist", state.artist.trim());
  if (state.collection?.trim()) params.set("collection", state.collection.trim());
  if (state.styles !== null && state.styles !== undefined) {
    const allowed = new Set(knownStyles);
    const styles = unique(state.styles).filter((item) => allowed.has(item));
    params.set("styles", styles.length ? styles.join(",") : "none");
  }
  if (state.order && state.order !== DEFAULT_FILTER_STATE.order) params.set("order", state.order);
  if (state.repeat && state.repeat !== DEFAULT_FILTER_STATE.repeat) params.set("repeat", state.repeat);
  if (state.track?.trim()) params.set("track", state.track.trim());
  if (state.review?.trim()) params.set("review", state.review.trim());
  url.search = params.toString();
  url.hash = "recordings";
  return url;
}
