import {
  STYLE_GROUPS,
  buildPlaybackQueue,
  matchesStyles,
  stylesOf,
} from './playback-policy.mjs';
import { styleForTag } from './style-taxonomy.mjs';
import { parseFilterURL, serializeFilterURL } from './filter-url.mjs';
import { REVIEW_ACCESS_KEY, tracksForView } from './review-policy.mjs';
import {
  mediaEventBelongsToPlayback,
  shouldAdvanceAfterMediaFailure,
} from './playback-recovery.mjs';

const audio = document.querySelector("#audio");
const now = document.querySelector("#now-playing");
const nowSource = document.querySelector("#now-source");
const status = document.querySelector("#playback-status");
const search = document.querySelector("#search");
const stylesHost = document.querySelector("#styles");
const stylesAll = document.querySelector("#styles-all");
const stylesNone = document.querySelector("#styles-none");
const collection = document.querySelector("#collection");
const order = document.querySelector("#order");
const repeat = document.querySelector("#repeat");
const pause = document.querySelector("#pause");
const nextButton = document.querySelector("#next");
const playResults = document.querySelector("#play-results");
const playFoundation = document.querySelector("#play-foundation");
const browseFoundation = document.querySelector("#browse-foundation");
const foundationCount = document.querySelector("#foundation-count");
const featuredCollection = document.querySelector("#featured-collection");
const reviewNotice = document.querySelector("#review-notice");
const tracksHost = document.querySelector("#tracks");
const count = document.querySelector("#count");
const shareList = document.querySelector("#share-list");
const shareFallback = document.querySelector("#share-fallback");
const empty = document.querySelector("#empty");
const summary = document.querySelector("#catalogue-summary");
const FOUNDATION_COLLECTION = "ФПВ";
const requestedReview = new URL(location.href).searchParams.get("review") ?? "";
const reviewMode = requestedReview === REVIEW_ACCESS_KEY;

let catalogue;
let rows = [];
let current = null;
let selectedTrackId = "";
let queue = [];
let generation = 0;
let activeArtist = "";
let restoringURL = false;
let activePlayback = null;
let consecutiveMediaFailures = 0;
let pendingAdvance = null;
const failedRows = new Set();
const styleChecks = new Map();

const text = (node, value) => {
  node.textContent = value ?? "";
  return node;
};
const element = (name, className, value) => {
  const node = document.createElement(name);
  if (className) node.className = className;
  if (value !== undefined) text(node, value);
  return node;
};
const formatDuration = (seconds) => {
  if (!Number.isFinite(seconds)) return null;
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
};
const formatBytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const searchable = (track) =>
  [
    track.title,
    track.artist,
    ...(track.collections ?? [track.collection]),
    track.license,
    ...track.tags,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
const visible = () => rows.filter((row) => !row.hidden);
const selectedStyles = () =>
  [...styleChecks].filter(([, input]) => input.checked).map(([style]) => style);

const filterState = () => {
  const styles = selectedStyles();
  return {
    q: search.value,
    artist: activeArtist,
    collection: collection.value,
    styles: styles.length === styleChecks.size ? null : styles,
    order: order.value,
    repeat: repeat.value,
    track: current?.track.id ?? selectedTrackId,
    review: reviewMode ? REVIEW_ACCESS_KEY : "",
  };
};

function syncURL(mode = "replace") {
  if (restoringURL) return;
  const url = serializeFilterURL(location.href, filterState(), [...styleChecks.keys()]);
  history[mode === "push" ? "pushState" : "replaceState"](null, "", url);
}

function showOnlyStyle(style) {
  activeArtist = "";
  search.value = "";
  collection.value = "";
  for (const [name, input] of styleChecks) input.checked = name === style;
  refresh();
  syncURL("push");
}

function showOnlyCollection(value) {
  activeArtist = "";
  search.value = "";
  collection.value = value;
  for (const input of styleChecks.values()) input.checked = true;
  refresh();
  syncURL("push");
}

function searchFor(value) {
  activeArtist = value;
  collection.value = "";
  for (const input of styleChecks.values()) input.checked = true;
  search.value = "";
  refresh();
  syncURL("push");
  search.focus({ preventScroll: true });
}

function facet(label, filter, value, className = "") {
  const control = element("button", `filter-chip ${className}`.trim(), label);
  control.type = "button";
  control.setAttribute("aria-label", `Filter recordings by ${label}`);
  control.addEventListener("click", () => filter(value));
  return control;
}

function tagStyle(tag) {
  return styleForTag(tag);
}

function refresh() {
  const term = search.value.trim().toLocaleLowerCase();
  for (const row of rows) {
    row.hidden =
      !row.dataset.search.includes(term) ||
      (activeArtist && row.track.artist !== activeArtist) ||
      !matchesStyles(row.trackStyles, selectedStyles()) ||
      (collection.value && !row.trackCollections.includes(collection.value));
  }
  const found = visible().length;
  count.textContent = `${found} recording${found === 1 ? "" : "s"}`;
  empty.hidden = found > 0;
  playResults.disabled = found === 0;
  queue = [];
}

function refill({ after = current } = {}) {
  queue = buildPlaybackQueue(visible().filter((row) => !failedRows.has(row)), {
    order: order.value === "sequential" ? "ordered" : order.value,
    current: after,
    wrap: repeat.value === 'all',
  });
}

function updateMediaSession(track) {
  if (!("mediaSession" in navigator) || !("MediaMetadata" in globalThis))
    return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: track.title,
    artist: track.artist,
    album: `RevealLine · ${(track.collections ?? [track.collection]).join(' · ')}`,
  });
}

function disposePlayback() {
  activePlayback = null;
  generation += 1;
  audio.pause();
  audio.removeAttribute("src");
  audio.removeAttribute("crossorigin");
  audio.load();
}

function cancelPendingAdvance() {
  if (pendingAdvance !== null) clearTimeout(pendingAdvance);
  pendingAdvance = null;
}

async function play(row, { historyMode = "push" } = {}) {
  cancelPendingAdvance();
  const request = ++generation;
  if (current) current.removeAttribute("data-active");
  current = row;
  selectedTrackId = row.track.id;
  const track = row.track;
  row.dataset.active = "true";
  pause.disabled = false;
  nextButton.disabled = false;
  queue = queue.filter((candidate) => candidate !== row);
  audio.pause();
  if (track.audio?.delivery?.type === "external-url") audio.crossOrigin = "anonymous";
  else audio.removeAttribute("crossorigin");
  const playbackURL = new URL(track.audio.path, catalogue.archive.baseURL).href;
  audio.src = playbackURL;
  activePlayback = { request, row, url: playbackURL };
  audio.load();
  now.textContent = `${track.title} · ${track.artist}`;
  nowSource.replaceChildren();
  const source = element(
    "a",
    "",
    `Source: ${(track.collections ?? [track.collection])[0]}`,
  );
  source.href = track.source;
  source.rel = "noopener noreferrer";
  nowSource.append(source);
  status.textContent = "Loading selected recording…";
  updateMediaSession(track);
  syncURL(historyMode);
  try {
    await audio.play();
  } catch {
    if (request === generation)
      status.textContent =
        "Press Play in the audio controls to start. Your browser may require a gesture.";
  }
}

function next({ natural = false } = {}) {
  if (natural && repeat.value === 'one' && current) return void play(current);
  if (!queue.length && repeat.value === 'all') refill();
  const row = queue.shift();
  if (row) void play(row, { historyMode: "replace" });
  else
    status.textContent = visible().length
      ? 'The selected queue has finished.'
      : 'No recordings match the current filters.';
}

function renderTrack(track, index) {
  const row = element("article", "track");
  row.id = `track-${index}`;
  row.track = track;
  row.dataset.search = searchable(track);
  row.trackStyles = stylesOf(track);
  row.dataset.genres = row.trackStyles.join(" ");
  row.trackCollections = track.collections ?? [track.collection];

  const playButton = element("button", "play-track", "▶");
  playButton.type = "button";
  playButton.setAttribute(
    "aria-label",
    `Play ${track.title} by ${track.artist}`,
  );
  playButton.addEventListener("click", () => {
    consecutiveMediaFailures = 0;
    failedRows.delete(row);
    queue = [];
    void play(row);
    refill({ after: row });
    queue = queue.filter((candidate) => candidate !== row);
  });

  const main = element("div", "track-main");
  main.append(element("h2", "", track.title));
  const artist = element("p", "artist facets");
  artist.append(facet(track.artist, searchFor, track.artist, "artist-chip"));
  main.append(artist);
  const metadata = element("div", "track-facets");
  for (const name of row.trackCollections)
    metadata.append(facet(name, showOnlyCollection, name, "collection-chip"));
  for (const tag of track.tags) {
    const style = tagStyle(tag);
    metadata.append(
      facet(tag, style ? showOnlyStyle : searchFor, style ?? tag, "tag-chip"),
    );
  }
  main.append(metadata);
  const labels = [];
  const duration = formatDuration(track.durationSeconds);
  if (duration) labels.push(duration);
  labels.push(
    track.gameCatalogueAdmission ? "Game playlist" : "Published audition",
  );
  main.append(element("p", "tags", labels.join(" · ")));
  const details = element("details");
  details.append(element("summary", "", "Credits & file details"));
  details.append(
    element("p", "", track.credit),
    ...(track.rights?.derivativeChangeNotice
      ? [element("p", "", `Changes: ${track.rights.derivativeChangeNotice}`)]
      : []),
    element("p", "", `Collections: ${row.trackCollections.join(' · ')}`),
    element(
      "p",
      "",
      `File: ${track.fileName} · ${formatBytes(track.audio.bytes)}`,
    ),
    element("p", "", `SHA-256: ${track.audio.sha256}`),
  );
  main.append(details);

  const links = element("div", "links");
  const download = element("a", "", "MP3 ↓");
  download.href = new URL(track.audio.path, catalogue.archive.baseURL).href;
  download.download = track.fileName;
  // Keep the exact recording URL wired for a future rights-reviewed download control.
  // Public standalone MP3 downloads are intentionally hidden from the player for now.
  download.hidden = true;
  const creator = element("a", "creator-link", "Creator source ↗");
  creator.href = track.source;
  creator.rel = "noopener noreferrer";
  links.append(download, creator);
  if (track.licenseURL) {
    const license = element("a", "", track.license ?? "Licence");
    license.href = track.licenseURL;
    license.rel = "license";
    links.append(license);
  }
  row.append(playButton, main, links);
  return row;
}

async function loadCatalogue() {
  try {
    const response = await fetch("catalogue.json", { cache: "no-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    catalogue = await response.json();
    if (catalogue.format !== "revealline-public-soundtrack-catalogue.v1")
      throw new Error("Unsupported catalogue");
    const displayedTracks = tracksForView(catalogue.tracks, requestedReview);
    featuredCollection.hidden = reviewMode;
    reviewNotice.hidden = !reviewMode;
    if (reviewMode) document.title = "RevealLine FPV · Musical review";
    const fragment = document.createDocumentFragment();
    rows = displayedTracks.map((track, index) => {
      const row = renderTrack(track, index);
      fragment.append(row);
      return row;
    });
    tracksHost.replaceChildren(fragment);
    tracksHost.setAttribute("aria-busy", "false");
    const sourceCounts = new Map();
    for (const track of displayedTracks)
      for (const name of track.collections ?? [track.collection])
        sourceCounts.set(name, (sourceCounts.get(name) ?? 0) + 1);
    for (const [name, total] of [...sourceCounts].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const option = element(
        "option",
        "",
        `${name} (${total})`,
      );
      option.value = name;
      collection.append(option);
    }
    for (const [style, label] of STYLE_GROUPS) {
      const choice = element('label', 'style-choice');
      const input = element('input');
      input.type = 'checkbox';
      input.value = style;
      input.checked = true;
      input.addEventListener('change', () => {
        refresh();
        syncURL("push");
      });
      styleChecks.set(style, input);
      choice.append(input, document.createTextNode(label));
      stylesHost.append(choice);
    }
    const collectionCount = new Set(displayedTracks.flatMap((track) => track.collections ?? [track.collection])).size;
    summary.textContent = reviewMode
      ? `${displayedTracks.length} review-only recordings across ${collectionCount} collections. These tracks are excluded from the public catalogue and default playlists.`
      : `${displayedTracks.length} public recordings across ${collectionCount} collections. Search, filter and keep them playing in one endless queue.`;
    const foundationTracks = displayedTracks.filter((track) =>
      (track.collections ?? [track.collection]).includes(FOUNDATION_COLLECTION),
    );
    foundationCount.textContent = String(foundationTracks.length);
    playFoundation.disabled = foundationTracks.length === 0;
    browseFoundation.disabled = foundationTracks.length === 0;
    restoringURL = true;
    const restored = parseFilterURL(location.href, [...styleChecks.keys()]);
    search.value = restored.q;
    activeArtist = restored.artist;
    collection.value = [...collection.options].some((option) => option.value === restored.collection) ? restored.collection : "";
    order.value = restored.order;
    repeat.value = restored.repeat;
    if (restored.styles !== null)
      for (const [style, input] of styleChecks) input.checked = restored.styles.includes(style);
    refresh();
    restoringURL = false;
    const requested = restored.track;
    const requestedRow = rows.find((row) => row.track.id === requested);
    selectedTrackId = requestedRow?.track.id ?? "";
    syncURL("replace");
    if (requestedRow) {
      requestedRow.scrollIntoView({ block: "center" });
      requestedRow.querySelector("button").focus({ preventScroll: true });
      status.textContent = `Ready to play ${requestedRow.track.title}.`;
    }
  } catch (error) {
    tracksHost.setAttribute("aria-busy", "false");
    summary.textContent = "The public catalogue could not be loaded.";
    status.textContent = `Catalogue unavailable: ${error.message}`;
    playResults.disabled = true;
  }
}

search.addEventListener("input", () => {
  activeArtist = "";
  refresh();
  syncURL("replace");
});
collection.addEventListener("change", () => {
  activeArtist = "";
  refresh();
  syncURL("push");
});
order.addEventListener("change", () => {
  queue = [];
  syncURL("push");
});
repeat.addEventListener("change", () => {
  queue = [];
  syncURL("push");
});
stylesAll.addEventListener('click', () => {
  for (const input of styleChecks.values()) input.checked = true;
  refresh();
  syncURL("push");
});
stylesNone.addEventListener('click', () => {
  for (const input of styleChecks.values()) input.checked = false;
  refresh();
  syncURL("push");
});
playResults.addEventListener("click", () => {
  consecutiveMediaFailures = 0;
  failedRows.clear();
  queue = buildPlaybackQueue(visible(), { order: order.value === "sequential" ? "ordered" : order.value, current: null });
  next();
});
playFoundation.addEventListener("click", () => {
  consecutiveMediaFailures = 0;
  showOnlyCollection(FOUNDATION_COLLECTION);
  failedRows.clear();
  queue = buildPlaybackQueue(visible(), { order: order.value === "sequential" ? "ordered" : order.value, current: null });
  next();
});
browseFoundation.addEventListener("click", () => {
  showOnlyCollection(FOUNDATION_COLLECTION);
  document.querySelector("#recordings").scrollIntoView({ block: "start" });
  collection.focus({ preventScroll: true });
});
nextButton.addEventListener("click", next);
pause.addEventListener("click", () => {
  if (!audio.paused) audio.pause();
  else
    void audio.play().catch(() => {
      status.textContent = "Playback could not resume. Choose the song again.";
    });
});
audio.addEventListener("play", () => {
  consecutiveMediaFailures = 0;
  pause.textContent = "Pause";
  status.textContent = "";
});
audio.addEventListener("pause", () => {
  pause.textContent = "Resume";
});
audio.addEventListener("ended", () => {
  if (
    mediaEventBelongsToPlayback({
      active: activePlayback,
      row: current,
      currentSrc: audio.currentSrc,
      src: audio.src,
    })
  )
    next({ natural: true });
});
audio.addEventListener("error", () => {
  if (
    !mediaEventBelongsToPlayback({
      active: activePlayback,
      row: current,
      currentSrc: audio.currentSrc,
      src: audio.src,
    })
  )
    return;
  const failed = current;
  consecutiveMediaFailures += 1;
  failedRows.add(failed);
  disposePlayback();
  current = null;
  if (!queue.length) refill({ after: failed });
  if (
    shouldAdvanceAfterMediaFailure({
      consecutiveFailures: consecutiveMediaFailures,
      remaining: queue.length,
    })
  ) {
    status.textContent = `Could not load ${failed.track.title}. Trying another available recording…`;
    pendingAdvance = setTimeout(() => {
      pendingAdvance = null;
      next();
    }, 600);
  } else {
    status.textContent = `Could not load ${failed.track.title}. Automatic skipping stopped so the player remains usable. Choose another song or press Next.`;
  }
});
shareList.addEventListener("click", async () => {
  const url = serializeFilterURL(location.href, filterState(), [...styleChecks.keys()]).href;
  try {
    if (navigator.share) await navigator.share({ title: "RevealLine soundtracks", url });
    else if (navigator.clipboard) {
      await navigator.clipboard.writeText(url);
      status.textContent = "Shareable soundtrack list link copied.";
    } else throw new Error("clipboard unavailable");
  } catch (error) {
    if (error?.name === "AbortError") return;
    shareFallback.textContent = url;
    shareFallback.hidden = false;
    shareFallback.focus();
  }
});
window.addEventListener("popstate", () => {
  if (!catalogue) return;
  const restored = parseFilterURL(location.href, [...styleChecks.keys()]);
  restoringURL = true;
  search.value = restored.q;
  activeArtist = restored.artist;
  collection.value = restored.collection;
  order.value = restored.order;
  repeat.value = restored.repeat;
  for (const [style, input] of styleChecks) input.checked = restored.styles === null || restored.styles.includes(style);
  const restoredRow = rows.find((row) => row.track.id === restored.track);
  selectedTrackId = restoredRow?.track.id ?? "";
  refresh();
  restoringURL = false;
});
if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => void audio.play());
  navigator.mediaSession.setActionHandler("pause", () => audio.pause());
  navigator.mediaSession.setActionHandler("nexttrack", next);
}

void loadCatalogue();
