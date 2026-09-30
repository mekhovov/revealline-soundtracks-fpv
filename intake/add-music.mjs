import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  statfs,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifest, verifyArchive } from "../verify.mjs";
import { readIntakePackage } from "./package.mjs";
import { validateExternalAudioURL } from "./external-url.mjs";
import { verifyExternalAudio } from "./verify-external.mjs";
import { assertReleaseVolume, RELEASE_VOLUME_FIELDS } from "./audio-volume.mjs";
import { isEligibleForArchive } from "../licensing-policy.mjs";

const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const MAX_TRACK_BYTES = 100_000_000;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;
const MINIMUM_FREE_BYTES = 1024 ** 3;
const LICENSES = new Map([
  [
    "cc0",
    {
      id: "CC0",
      version: "1.0",
      label: "CC0 1.0 Universal",
      url: "https://creativecommons.org/publicdomain/zero/1.0/",
      shareAlike: false,
    },
  ],
  [
    "cc-by-3.0",
    {
      id: "CC-BY",
      version: "3.0",
      label: "CC BY 3.0 Unported",
      url: "https://creativecommons.org/licenses/by/3.0/",
      shareAlike: false,
    },
  ],
  [
    "cc-by-4.0",
    {
      id: "CC-BY",
      version: "4.0",
      label: "CC BY 4.0 International",
      url: "https://creativecommons.org/licenses/by/4.0/",
      shareAlike: false,
    },
  ],
  [
    "cc-by-sa-3.0",
    {
      id: "CC-BY-SA",
      version: "3.0",
      label: "CC BY-SA 3.0 Unported",
      url: "https://creativecommons.org/licenses/by-sa/3.0/",
      shareAlike: true,
    },
  ],
  [
    "cc-by-sa-4.0",
    {
      id: "CC-BY-SA",
      version: "4.0",
      label: "CC BY-SA 4.0 International",
      url: "https://creativecommons.org/licenses/by-sa/4.0/",
      shareAlike: true,
    },
  ],
  [
    "unknown",
    {
      id: "UNKNOWN",
      version: null,
      label: "Unknown — uploader-confirmed rights",
      url: null,
      shareAlike: null,
    },
  ],
]);

export const INTAKE_USAGE = `Usage:
  node intake/add-music.mjs <mp3-or-folder> [options]
  node intake/add-music.mjs <package.rlintake> [--open-pr]
  node intake/add-music.mjs --audio-url <https-url> --title <title> [options]
  node intake/add-music.mjs --url-manifest <manifest.json> [options]

Required options:
  --source <https-url>          Exact creator/source page
  --license <id>                cc0, cc-by-3.0, cc-by-4.0,
                                cc-by-sa-3.0, cc-by-sa-4.0 or unknown
  --styles <comma-separated>    One or more reviewed style tags
  --confirm-rights              Confirm public MP3 redistribution and
                                web-game playback rights were verified

Metadata options:
  --audio-url <https-url>       One stable public hosted MP3
  --url-manifest <json>        Batch of hosted MP3 metadata rows
  --artist <name>               Required when MP3 artist tags are absent
  --title <title>               Override the title for one MP3 only
  --batch-id <id>               Stable lowercase batch identifier
  --batch-title <title>         Public collection title
  --collections <list>         Additional collection names
  --description <text>          Public collection description
  --attribution <text>          Exact required credit
  --rights-evidence <https-url> Exact licence/permission evidence
  --derivative-notice <text>    Required for CC BY-SA intake
  --open-pr                     Publish verified audio, commit/push and open a PR
  -h, --help                    Show this help

One intake accepts at most 20 MP3 files and 64 MiB. A source or video URL is
not rights evidence by itself. This separate FPV archive accepts unknown licence metadata only with explicit
uploader confirmation. Unknown does not mean open-licensed. Run this command only in a clean FPV archive
checkout. A browser-created .rlintake package already contains the required
metadata and either exact MP3 bytes or verified external URL evidence; do not repeat
metadata options. Hosted URLs must support public CORS, HEAD and byte ranges and
must not be presigned or otherwise expiring. With --open-pr, local MP3 assets
with confirmed publication metadata become public in a verified prerelease before catalogue review.
Unknown-licence FPV recordings also become public here; keep your original files.
The public player
and game catalogue change only after the PR is merged and deployed.`;

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const demand = (value, message) => {
  if (!value) throw new Error(message);
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const escapeHTML = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );

const CYRILLIC_SLUGS = new Map(
  Object.entries({
    а: "a", б: "b", в: "v", г: "h", ґ: "g", д: "d", е: "e", є: "ye",
    ж: "zh", з: "z", и: "y", і: "i", ї: "yi", й: "y", к: "k", л: "l",
    м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u",
    ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch", ь: "",
    ю: "yu", я: "ya", ё: "yo", ъ: "", ы: "y", э: "e",
  }),
);

function transliterateForSlug(value) {
  return [...String(value).toLowerCase()]
    .map((character) => CYRILLIC_SLUGS.get(character) ?? character)
    .join("");
}

function slug(value, maximum = 64) {
  return (
    transliterateForSlug(value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maximum)
      .replace(/-+$/g, "") || "soundtrack"
  );
}

function titleFromFile(file) {
  return path
    .basename(file, path.extname(file))
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function synchsafe(bytes, offset) {
  return (
    (bytes[offset] << 21) |
    (bytes[offset + 1] << 14) |
    (bytes[offset + 2] << 7) |
    bytes[offset + 3]
  );
}

function decodeTextFrame(bytes) {
  if (!bytes.length) return "";
  const encoding = bytes[0];
  let body = bytes.subarray(1);
  if (encoding === 0) return body.toString("latin1").replace(/\0/g, "").trim();
  if (encoding === 3) return body.toString("utf8").replace(/\0/g, "").trim();
  if (encoding === 1 && body[0] === 0xfe && body[1] === 0xff) {
    body = Buffer.from(body.subarray(2));
    body.swap16();
  } else if (encoding === 1 && body[0] === 0xff && body[1] === 0xfe)
    body = body.subarray(2);
  else if (encoding === 2) {
    body = Buffer.from(body);
    body.swap16();
  }
  return body.toString("utf16le").replace(/\0/g, "").trim();
}

export async function readID3(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const header = Buffer.alloc(10);
    if (
      (await handle.read(header, 0, 10, 0)).bytesRead !== 10 ||
      header.subarray(0, 3).toString("ascii") !== "ID3"
    )
      return {};
    const version = header[3];
    if (![3, 4].includes(version)) return {};
    const size = Math.min(synchsafe(header, 6), 1024 * 1024);
    const body = Buffer.alloc(size);
    const read = await handle.read(body, 0, size, 10);
    const result = {};
    let offset = 0;
    while (offset + 10 <= read.bytesRead) {
      const id = body.subarray(offset, offset + 4).toString("ascii");
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const frameSize =
        version === 4
          ? synchsafe(body, offset + 4)
          : body.readUInt32BE(offset + 4);
      if (frameSize <= 0 || offset + 10 + frameSize > read.bytesRead) break;
      const frame = body.subarray(offset + 10, offset + 10 + frameSize);
      if (id === "TIT2") result.title = decodeTextFrame(frame);
      if (id === "TPE1") result.artist = decodeTextFrame(frame);
      offset += 10 + frameSize;
    }
    return result;
  } finally {
    await handle.close();
  }
}

export async function findMP3Files(input) {
  const found = [];
  async function visit(candidate, depth) {
    demand(depth <= 8, "Music folder nesting exceeds eight levels.");
    const stat = await lstat(candidate);
    demand(
      !stat.isSymbolicLink(),
      `Symbolic links are not accepted: ${candidate}`,
    );
    if (stat.isFile()) {
      if (path.extname(candidate).toLowerCase() === ".mp3")
        found.push(path.resolve(candidate));
      return;
    }
    demand(
      stat.isDirectory(),
      `Music input must be an MP3 or folder: ${candidate}`,
    );
    for (const entry of (
      await readdir(candidate, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name)))
      await visit(path.join(candidate, entry.name), depth + 1);
  }
  await visit(path.resolve(input), 0);
  demand(found.length >= 1, "No MP3 files were found.");
  demand(found.length <= 20, "One automated batch is limited to 20 MP3 files.");
  return found;
}

async function run(command, args, { cwd = repository, capture = false } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let output = "",
      error = "";
    if (capture) {
      child.stdout.on("data", (chunk) => (output += chunk));
      child.stderr.on("data", (chunk) => (error += chunk));
    }
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(
            new Error(
              `${command} exited with ${code}${error ? `: ${error.trim()}` : ""}`,
            ),
          ),
    );
  });
}

async function probeDuration(file) {
  const output = await run(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      file,
    ],
    { capture: true },
  );
  const duration = Number(output);
  demand(
    Number.isFinite(duration) && duration > 0,
    `Could not decode complete MP3 metadata: ${file}`,
  );
  await run("ffmpeg", ["-v", "error", "-i", file, "-f", "null", "-"]);
  return duration;
}

function safeURL(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function parseArguments(argv) {
  const options = { styles: [], collections: [] },
    positional = [];
  const values = new Map([
    ["--source", "source"],
    ["--license", "license"],
    ["--artist", "artist"],
    ["--styles", "styles"],
    ["--batch-id", "batchId"],
    ["--batch-title", "batchTitle"],
    ["--collections", "collections"],
    ["--description", "description"],
    ["--rights-evidence", "rightsEvidence"],
    ["--attribution", "attribution"],
    ["--title", "title"],
    ["--derivative-notice", "derivativeNotice"],
    ["--audio-url", "audioURL"],
    ["--url-manifest", "urlManifest"],
  ]);
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    demand(
      value !== "--help" && value !== "-h",
      "Use --help by itself to show command usage.",
    );
    if (!value.startsWith("--")) positional.push(value);
    else if (value === "--confirm-rights") options.confirmRights = true;
    else if (value === "--open-pr") options.openPR = true;
    else {
      const key = values.get(value),
        next = argv[++index];
      demand(key && next, `Unknown option or missing value: ${value}`);
      options[key] =
        key === "styles" || key === "collections"
          ? next
              .split(",")
              .map((tag) => tag.trim())
              .filter(Boolean)
          : next;
    }
  }
  const sources = positional.length + Number(Boolean(options.audioURL)) + Number(Boolean(options.urlManifest));
  demand(sources === 1, "Choose exactly one local input, --audio-url or --url-manifest.");
  demand(positional.length <= 1, "Choose exactly one MP3 file or one folder.");
  if (options.audioURL) validateExternalAudioURL(options.audioURL);
  return { input: positional[0] ?? null, options };
}

function rightsFor(license, options, credit) {
  const evidence = options.rightsEvidence?.trim() || options.source;
  demand(safeURL(evidence), "A secure exact rights-evidence URL is required.");
  if (license.shareAlike === true)
    demand(
      options.derivativeNotice?.trim(),
      "CC BY-SA requires --derivative-notice.",
    );
  return {
    licenseId: license.id,
    licenseVersion: license.version,
    licenseURL: license.url,
    rightsEvidenceURL: evidence,
    attribution: credit,
    derivativeChangeNotice:
      options.derivativeNotice?.trim() ||
      "Exact submitted MP3 bytes retained; no archive changes declared.",
    shareAlike: {
      required: license.shareAlike,
      deliveryLicenseId: license.shareAlike ? license.id : null,
      deliveryLicenseVersion: license.shareAlike ? license.version : null,
      deliveryLicenseURL: license.shareAlike ? license.url : null,
    },
    ...(license.id === "UNKNOWN"
      ? {
          permissionBasis:
            "uploader-confirmed-public-redistribution-and-web-playback",
        }
      : {}),
  };
}

export async function createIntake(
  input,
  options,
  { probe = probeDuration } = {},
) {
  demand(
    options.confirmRights === true,
    "Pass --confirm-rights after verifying public redistribution and web-game playback rights.",
  );
  demand(
    safeURL(options.source),
    "A secure exact creator/source URL is required.",
  );
  const license = LICENSES.get(options.license);
  demand(
    license,
    "Use --license cc0, cc-by-3.0, cc-by-4.0, cc-by-sa-3.0, cc-by-sa-4.0 or unknown.",
  );
  const files = await findMP3Files(input);
  demand(
    !options.title || files.length === 1,
    "Use --title only with one MP3 file.",
  );
  const styles = [...new Set(options.styles ?? [])];
  demand(styles.length >= 1, "Choose at least one style with --styles.");
  const collections = [...new Set(options.collections ?? [])];
  demand(collections.length <= 16, "Use at most 16 collections.");
  const ids = new Map(),
    tracks = [];
  for (const file of files) {
    const stat = await lstat(file);
    demand(
      stat.isFile() && stat.size > 0 && stat.size < MAX_TRACK_BYTES,
      `MP3 size is invalid: ${file}`,
    );
    const bytes = await readFile(file);
    demand(
      bytes.subarray(0, 3).toString("ascii") === "ID3" ||
        (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0),
      `File does not begin with an MP3 signature: ${file}`,
    );
    const id3 = await readID3(file);
    const title = options.title?.trim() || id3.title || titleFromFile(file);
    const artist =
      options.artist?.trim() || id3.artist || options.artistFallback?.trim();
    demand(
      artist,
      `Artist is missing for ${file}; pass --artist or use a browser package with a creator fallback.`,
    );
    const baseId = `${slug(artist, 70)}.${slug(title, 70)}`;
    const occurrence = (ids.get(baseId) ?? 0) + 1;
    ids.set(baseId, occurrence);
    const credit =
      options.attribution?.trim() ||
      `${title} by ${artist}. ${
        license.id === "UNKNOWN"
          ? "Rights confirmed by uploader for public redistribution and web-game playback"
          : license.label
      }. Source: ${options.source}`;
    tracks.push({
      id: occurrence === 1 ? baseId : `${baseId}.${occurrence}`,
      title,
      artist,
      file,
      fileName: path.basename(file),
      bytes,
      sha256: hash(bytes),
      durationSeconds: await probe(file),
      source: options.source,
      license: license.label,
      licenseURL: license.url,
      credit,
      rights: rightsFor(license, options, credit),
      tags: styles,
    });
  }
  demand(
    tracks.reduce((sum, track) => sum + track.bytes.length, 0) <=
      MAX_BATCH_BYTES,
    "A public batch may contain at most 64 MiB of audio.",
  );
  const batchLabel =
    options.batchTitle?.trim() ||
    collections[0] ||
    options.artist?.trim() ||
    titleFromFile(input);
  const batchId =
    options.batchId ??
    `${slug(batchLabel, 39)}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${tracks[0].sha256.slice(0, 8)}`;
  demand(
    /^[a-z0-9][a-z0-9-]{0,63}$/.test(batchId),
    "Batch ID must be lowercase letters, digits and hyphens.",
  );
  return {
    batchId,
    title:
      options.batchTitle?.trim() ||
      (tracks.length === 1 ? tracks[0].title : titleFromFile(input)),
    description:
      options.description?.trim() ||
      `Publicly redistributable music prepared from ${tracks.length} reviewed MP3 recording${tracks.length === 1 ? "" : "s"}.`,
    collections,
    tracks,
  };
}

async function probeExternalBytes(bytes, fileName, probe = probeDuration) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "revealline-external-probe-"));
  try {
    const file = path.join(directory, slug(fileName, 80) + ".mp3");
    await writeFile(file, bytes, { flag: "wx" });
    return await probe(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function createExternalIntake(
  options,
  { verify = verifyExternalAudio, probe = probeDuration, packagedTracks = null } = {},
) {
  demand(options.confirmRights === true, "Pass --confirm-rights after verifying public redistribution and web-game playback rights.");
  demand(safeURL(options.source), "A secure exact creator/source URL is required.");
  const license = LICENSES.get(options.license);
  demand(license, "Use --license cc0, cc-by-3.0, cc-by-4.0, cc-by-sa-3.0, cc-by-sa-4.0 or unknown.");
  const styles = [...new Set(options.styles ?? [])];
  demand(styles.length >= 1, "Choose at least one style with --styles.");
  const collections = [...new Set(options.collections ?? [])];
  demand(collections.length <= 16, "Use at most 16 collections.");
  let rows;
  if (packagedTracks) rows = packagedTracks.map((track) => ({
    audioURL: track.audioURL,
    title: track.title,
    artist: track.artist,
    fileName: track.fileName,
    expectedBytes: track.bytes,
    expectedSha256: track.sha256,
  }));
  else if (options.audioURL) rows = [{ audioURL: options.audioURL, title: options.title, artist: options.artist, fileName: options.fileName }];
  else {
    const parsed = JSON.parse(await readFile(path.resolve(options.urlManifest), "utf8"));
    rows = Array.isArray(parsed) ? parsed : parsed.tracks;
  }
  demand(Array.isArray(rows) && rows.length > 0 && rows.length <= 20, "URL manifest must contain 1–20 recordings.");
  const tracks = [];
  const ids = new Map();
  for (const [index, row] of rows.entries()) {
    const title = String(row.title ?? "").trim();
    const artist = String(row.artist ?? options.artist ?? "").trim();
    demand(title, `Hosted recording ${index + 1} needs a title.`);
    demand(artist, `Hosted recording ${index + 1} needs an artist.`);
    const result = await verify(validateExternalAudioURL(row.audioURL ?? row.url).href);
    if (row.expectedBytes) demand(result.byteCount === row.expectedBytes, `Packaged hosted byte count changed: ${title}`);
    if (row.expectedSha256) demand(result.sha256 === row.expectedSha256, `Packaged hosted SHA-256 changed: ${title}`);
    const baseId = `${slug(artist, 70)}.${slug(title, 70)}`;
    const occurrence = (ids.get(baseId) ?? 0) + 1;
    ids.set(baseId, occurrence);
    const credit = options.attribution?.trim() || `${title} by ${artist}. ${license.id === "UNKNOWN" ? "Rights confirmed by uploader for public redistribution and web-game playback" : license.label}. Source: ${options.source}`;
    const fileName = String(row.fileName || `${title}.mp3`).replace(/[\\/\0]/g, "_");
    tracks.push({
      id: occurrence === 1 ? baseId : `${baseId}.${occurrence}`,
      title,
      artist,
      fileName: /\.mp3$/i.test(fileName) ? fileName : `${fileName}.mp3`,
      byteCount: result.byteCount,
      sha256: result.sha256,
      durationSeconds: await probeExternalBytes(result.bytes, fileName, probe),
      source: options.source,
      license: license.label,
      licenseURL: license.url,
      credit,
      rights: rightsFor(license, options, credit),
      tags: styles,
      audioURL: result.url,
      delivery: {
        type: "external-url",
        verifiedAt: result.verifiedAt,
        rangeRequests: true,
        cors: true,
      },
    });
  }
  const total = tracks.reduce((sum, track) => sum + track.byteCount, 0);
  demand(total <= MAX_BATCH_BYTES, "A public batch may reference at most 64 MiB of audio.");
  const batchId = options.batchId ?? `${slug(options.batchTitle || tracks[0].title, 48)}-${tracks[0].sha256.slice(0, 8)}`;
  demand(/^[a-z0-9][a-z0-9-]{0,63}$/.test(batchId), "Batch ID must be lowercase letters, digits and hyphens.");
  return {
    batchId,
    title: options.batchTitle?.trim() || (tracks.length === 1 ? tracks[0].title : `${tracks[0].artist} — ${tracks.length} hosted tracks`),
    description: options.description?.trim() || `Publicly hosted music prepared from ${tracks.length} reviewed MP3 recording${tracks.length === 1 ? "" : "s"}.`,
    collections,
    tracks,
    external: true,
  };
}

export function publicTrack(track, batch) {
  const collections = [...new Set([batch.title, ...batch.collections])];
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    durationSeconds: track.durationSeconds,
    tags: [...new Set([...track.tags, "audition", "listening pending"])],
    source: track.source,
    license: track.license,
    licenseURL: track.licenseURL,
    credit: track.credit,
    rights: track.rights,
    fileName: track.fileName,
    archiveId: batch.batchId,
    collection: batch.title,
    collections,
    status: "licensed-preview",
    listeningApproval: "not-reviewed",
    gameCatalogueAdmission: false,
    contentId: "unknown",
    recordingModeEligible: false,
    default: false,
    audio: batch.external
      ? { path: track.audioURL, bytes: track.byteCount, sha256: track.sha256, delivery: track.delivery }
      : {
          path: `objects/${track.sha256}.mp3`,
          bytes: track.bytes.length,
          sha256: track.sha256,
        },
    aliases: [],
  };
}

export function batchFiles(batch) {
  const credits = batch.tracks
    .map((track) => {
      const changeNotice = track.rights.derivativeChangeNotice
        ? `\n\nChanges: ${track.rights.derivativeChangeNotice}`
        : "";
      return `## ${track.title} — ${track.artist}\n\n${track.credit}${changeNotice}\n\nSource: ${track.source}\n\nLicence: ${track.license}${track.licenseURL ? ` (${track.licenseURL})` : ""}\n`;
    })
    .join("\n");
  const cards = batch.tracks
    .map((track) => {
      const changeNotice = track.rights.derivativeChangeNotice
        ? `<p>Changes: ${escapeHTML(track.rights.derivativeChangeNotice)}</p>`
        : "";
      return `<article><h2>${escapeHTML(track.title)}</h2><p>${escapeHTML(track.artist)}</p><p>${escapeHTML(track.credit)}</p>${changeNotice}<p><a href="${escapeHTML(track.source)}">Creator source</a> · ${track.licenseURL ? `<a href="${escapeHTML(track.licenseURL)}">${escapeHTML(track.license)}</a>` : escapeHTML(track.license)}</p></article>`;
    })
    .join("\n");
  return new Map([
    [
      "README.md",
      `# ${batch.title}\n\n${batch.description}\n\nThese recordings are licensed auditions. Publication is not listening approval or game admission.\n`,
    ],
    ["CREDITS.md", `# Credits — ${batch.title}\n\n${credits}`],
    [
      "index.html",
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHTML(batch.title)}</title><link rel="stylesheet" href="../../style.css"></head><body><main><p><a href="../../">← All soundtracks</a></p><h1>${escapeHTML(batch.title)}</h1><p>${escapeHTML(batch.description)}</p>${cards}</main></body></html>\n`,
    ],
  ]);
}

async function ensureCleanCheckout() {
  demand(
    !(await run("git", ["status", "--porcelain"], { capture: true })),
    "Start from a clean archive checkout.",
  );
}

export async function readBoundedPackageHandle(handle, expectedSize) {
  const bounded = Buffer.alloc(expectedSize + 1);
  let offset = 0;
  while (offset < bounded.length) {
    const { bytesRead } = await handle.read(
      bounded,
      offset,
      bounded.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  demand(
    offset === expectedSize,
    "Intake package changed during its bounded read.",
  );
  return bounded.subarray(0, offset);
}

export async function withPackagedIntake(
  input,
  options,
  callback,
  { statFilesystem = statfs, temporaryRoot = os.tmpdir() } = {},
) {
  if (path.extname(input).toLowerCase() !== ".rlintake")
    return await callback(input, options);
  const repeated = Object.entries(options).filter(
    ([key, value]) =>
      key !== "openPR" &&
      value !== undefined &&
      value !== false &&
      !(Array.isArray(value) && value.length === 0),
  );
  demand(
    repeated.length === 0,
    `The package already contains metadata; remove ${repeated.map(([key]) => `--${key}`).join(", ")}.`,
  );
  const packagePath = path.resolve(input);
  const initialPackageStat = await lstat(packagePath);
  demand(
    initialPackageStat.isFile() &&
      !initialPackageStat.isSymbolicLink() &&
      initialPackageStat.size > 0 &&
      initialPackageStat.size <= MAX_BATCH_BYTES + 1024 * 1024,
    "Intake package is not an ordinary bounded file.",
  );
  const packageHandle = await open(
    packagePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let packageBytes;
  try {
    const packageStat = await packageHandle.stat();
    demand(
      packageStat.isFile() &&
        packageStat.size > 0 &&
        packageStat.size <= MAX_BATCH_BYTES + 1024 * 1024,
      "Intake package is not an ordinary bounded file.",
    );
    packageBytes = await readBoundedPackageHandle(
      packageHandle,
      packageStat.size,
    );
  } finally {
    await packageHandle.close();
  }
  const unpacked = await readIntakePackage(new Blob([packageBytes]));
  const external = unpacked.manifest.format === "revealline-soundtrack-intake-package.v2";
  const disk = await statFilesystem(temporaryRoot);
  demand(
    disk.bavail * disk.bsize >=
      MINIMUM_FREE_BYTES + unpacked.manifest.audioBytes + 8 * 1024 * 1024,
    "Package admission must leave at least 1 GiB free.",
  );
  const temporary = await mkdtemp(
    path.join(temporaryRoot, "revealline-soundtrack-intake-"),
  );
  try {
    const { artist, ...metadata } = unpacked.manifest.metadata;
    if (external)
      return await callback(null, {
        ...metadata,
        artist,
        openPR: options.openPR === true,
      }, { packagedTracks: unpacked.tracks });
    for (const [index, track] of unpacked.tracks.entries()) {
      const directory = path.join(temporary, String(index).padStart(4, "0"));
      await mkdir(directory);
      await writeFile(path.join(directory, track.fileName), track.audio, {
        flag: "wx",
      });
    }
    return await callback(temporary, {
      ...metadata,
      artistFallback: artist,
      openPR: options.openPR === true,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function preparePublicVolume(
  batch,
  { runCommand = run, temporaryRoot = os.tmpdir() } = {},
) {
  const repo = "mekhovov/revealline-soundtracks-fpv";
  const tag = `audio-${batch.batchId}`;
  const publish = batch.tracks.every(isEligibleForArchive);
  const volume = {
    releaseTag: tag,
    assets: batch.tracks.map((track) => {
      demand(hash(track.bytes) === track.sha256, `Local audio hash differs: ${track.sha256}`);
      return { sha256: track.sha256, bytes: track.bytes.length };
    }),
  };
  assertReleaseVolume(
    { tagName: tag, isDraft: true, isPrerelease: false, assets: [] },
    volume,
    { allowMissing: true },
  );
  const gh = (args) => runCommand("gh", [...args, "--repo", repo], { capture: true });
  const view = async () => JSON.parse(await gh([
    "release", "view", tag, "--json", RELEASE_VOLUME_FIELDS,
  ]));
  // A successful list distinguishes absence from authentication/network failures.
  // A concurrent creation still fails safely: uploads never use --clobber.
  const releases = JSON.parse(await gh([
    "release", "list", "--limit", "1000", "--json", "tagName",
  ]));
  demand(Array.isArray(releases), "Could not list audio releases.");
  if (!releases.some((release) => release.tagName === tag))
    await gh([
      "release", "create", tag, "--draft", "--target", "main", "--title",
      `${batch.title} · immutable audio volume`, "--notes",
      publish
        ? "Exact SHA-256-named MP3 assets. Published for read-only PR verification before catalogue admission; listening and game-default approval remain separate."
        : "Quarantined audio: no known published licence. Keep this volume as an unpublished draft. It is excluded from Pages, playback and review links.",
    ]);
  let release = await view();
  demand(publish || release.isDraft, `Quarantined audio volume must stay unpublished: ${tag}`);
  const { missingAssets } = assertReleaseVolume(release, volume, { allowMissing: true });
  if (missingAssets.length) {
    const temporary = await mkdtemp(path.join(temporaryRoot, "revealline-release-assets-"));
    try {
      const tracks = new Map(batch.tracks.map((track) => [track.sha256, track]));
      const assets = [];
      for (const asset of missingAssets) {
        const target = path.join(temporary, `${asset.sha256}.mp3`);
        await writeFile(target, tracks.get(asset.sha256).bytes, { flag: "wx" });
        assets.push(target);
      }
      await gh(["release", "upload", tag, ...assets]);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
    release = await view();
  }
  assertReleaseVolume(release, volume);
  if (publish && release.isDraft) {
    await gh([
      "release", "edit", tag, "--draft=false", "--prerelease=true", "--latest=false",
    ]);
    release = await view();
    assertReleaseVolume(release, volume);
    demand(!release.isDraft && release.isPrerelease, `Audio prerelease was not published: ${tag}`);
  }
  return volume;
}

async function openPullRequest(batch) {
  const quarantined = !batch.tracks.every(isEligibleForArchive);
  let branch = await run("git", ["branch", "--show-current"], {
    capture: true,
  });
  if (branch === "main") {
    branch = `codex/soundtrack-${batch.batchId}`;
    await run("git", ["switch", "-c", branch]);
  }
  demand(
    branch.startsWith("codex/"),
    "Use a dedicated codex/ branch before --open-pr.",
  );
  await run("git", [
    "add",
    "--",
    "audio-volumes.json",
    "batches.json",
    "catalogue.json",
    "CREDITS.md",
    "deployment-manifest.json",
    "external-deliveries.json",
  ]);
  await run("git", ["diff", "--cached", "--check"]);
  await run("git", ["commit", "-m", `Add ${batch.title} to RevealLine Soundtracks`]);
  if (!batch.external) await preparePublicVolume(batch);
  await run("git", ["push", "-u", "origin", branch]);
  const body = path.join(os.tmpdir(), `revealline-soundtracks-${process.pid}.md`);
  try {
    await writeFile(
      body,
      quarantined
        ? `Retains ${batch.tracks.length} recording${batch.tracks.length === 1 ? "" : "s"} in source metadata quarantine because no known published licence is recorded. These entries are excluded from every deployed catalogue, direct/review link and Pages audio object. ${batch.external ? "External URLs are preserved as metadata only." : `Exact uploaded audio stays in unpublished draft audio-${batch.batchId}; merge automation must not publish it.`} Keep local originals. No listening or game admission is granted.\n`
        : `Adds ${batch.tracks.length} exact, rights-bound MP3 recording${batch.tracks.length === 1 ? "" : "s"} through the separate FPV automated intake. ${batch.external ? "The stable hosted URLs, exact hashes, byte counts, CORS and range evidence are reverified by CI; no GitHub audio volume is created." : `Exact audio is publicly available in verified prerelease audio-${batch.batchId} so read-only PR checks can verify its bytes. Merge automation promotes that volume before catalogue deployment; it does not replace assets.`} Files remain listening-pending and game-unadmitted.\n`,
    );
    await run("gh", [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      branch,
      "--title",
      `Add ${batch.title} to RevealLine Soundtracks`,
      "--body-file",
      body,
    ]);
  } finally {
    await rm(body, { force: true });
  }
}

async function performMusicIntake(input, options, dependencies = {}) {
  const batch = options.audioURL || options.urlManifest || dependencies.packagedTracks
    ? await createExternalIntake(options, { ...dependencies, packagedTracks: dependencies.packagedTracks })
    : await createIntake(input, options, dependencies);
  const cataloguePath = path.join(repository, "catalogue.json");
  const batchesPath = path.join(repository, "batches.json");
  const creditsPath = path.join(repository, "CREDITS.md");
  const volumesPath = path.join(repository, "audio-volumes.json");
  const externalPath = path.join(repository, "external-deliveries.json");
  const [catalogueText, batchesText, creditsText, volumesText, externalText] = await Promise.all([
    readFile(cataloguePath, "utf8"),
    readFile(batchesPath, "utf8"),
    readFile(creditsPath, "utf8"),
    readFile(volumesPath, "utf8"),
    readFile(externalPath, "utf8"),
  ]);
  const catalogue = JSON.parse(catalogueText);
  const batches = JSON.parse(batchesText);
  const volumes = JSON.parse(volumesText);
  const externalDeliveries = JSON.parse(externalText);
  const volumeTag = `audio-${batch.batchId}`;
  if (!batch.external) demand(!volumes.volumes.some((volume) => volume.releaseTag === volumeTag), `Batch already exists: ${batch.batchId}`);
  const knownIds = new Set(catalogue.tracks.map((track) => track.id));
  const knownHashes = new Set(catalogue.tracks.map((track) => track.audio.sha256));
  for (const track of batch.tracks) {
    demand(!knownIds.has(track.id), `Recording identity already exists: ${track.id}`);
    demand(!knownHashes.has(track.sha256), `Exact recording already exists: ${track.file ?? track.audioURL}`);
    knownIds.add(track.id);
    knownHashes.add(track.sha256);
  }
  demand(catalogue.tracks.length + batch.tracks.length <= 512, "Catalogue track limit exceeded.");
  const audioBytes = batch.tracks.reduce((sum, track) => sum + (track.byteCount ?? track.bytes.length), 0);
  const disk = await statfs(repository);
  demand(
    disk.bavail * disk.bsize >=
      MINIMUM_FREE_BYTES + (batch.external ? 0 : audioBytes) + 8 * 1024 * 1024,
    "Upload must leave at least 1 GiB free.",
  );
  const backups = new Map([
    ["catalogue.json", catalogueText],
    ["batches.json", batchesText],
    ["CREDITS.md", creditsText],
    ["audio-volumes.json", volumesText],
    ["external-deliveries.json", externalText],
  ]);
  try {
    const rows = batch.tracks.map((track) => publicTrack(track, batch));
    catalogue.tracks.push(...rows);
    catalogue.counts.declaredTracks += rows.length;
    catalogue.counts.uniqueRecordings += rows.length;
    catalogue.counts.audioBytes += audioBytes;
    for (const name of rows[0].collections) {
      const existing = batches.collections.find((entry) => entry.id === name);
      if (existing) existing.tracks += rows.length;
      else batches.collections.push({ id: name, title: name, tracks: rows.length });
    }
    batches.collections.sort((left, right) => left.title.localeCompare(right.title));
    if (batch.external) {
      externalDeliveries.recordings.push(...rows.map((track) => ({
        id: track.id,
        url: track.audio.path,
        host: new URL(track.audio.path).host,
        bytes: track.audio.bytes,
        sha256: track.audio.sha256,
        verifiedAt: track.audio.delivery.verifiedAt,
      })));
      externalDeliveries.recordings.sort((left, right) => left.id.localeCompare(right.id));
    } else volumes.volumes.push({
      id: volumeTag,
      releaseTag: volumeTag,
      recordings: rows.length,
      audioBytes,
      assets: batch.tracks.map((track) => ({ sha256: track.sha256, bytes: track.bytes.length })),
    });
    const rootCredits = `${creditsText.trimEnd()}\n\n## ${batch.title}\n\n${batch.tracks
      .map((track) => `${track.credit}\n\nLicence: ${track.license}${track.licenseURL ? ` (${track.licenseURL})` : ""}`)
      .join("\n\n")}\n`;
    await Promise.all([
      writeFile(cataloguePath, json(catalogue)),
      writeFile(batchesPath, json(batches)),
      writeFile(creditsPath, rootCredits),
      writeFile(volumesPath, json(volumes)),
      writeFile(externalPath, json(externalDeliveries)),
    ]);
    await writeFile(
      path.join(repository, "deployment-manifest.json"),
      json(await buildManifest(repository)),
    );
    await verifyArchive(repository);
  } catch (error) {
    for (const [name, contents] of backups) await writeFile(path.join(repository, name), contents);
    await writeFile(
      path.join(repository, "deployment-manifest.json"),
      json(await buildManifest(repository)),
    );
    throw error;
  }
  if (options.openPR) await openPullRequest(batch);
  return {
    batchId: batch.batchId, tracks: batch.tracks.length, audioBytes,
    quarantined: !batch.tracks.every(isEligibleForArchive),
  };
}

export async function automateMusicIntake(input, options, dependencies = {}) {
  await ensureCleanCheckout();
  const lockPath = path.join(repository, "intake", ".upload.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx");
    await lock.writeFile(
      `${JSON.stringify({ pid: process.pid, input: input ? path.resolve(input) : options.audioURL || options.urlManifest })}\n`,
    );
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        "Another soundtrack upload owns the archive writer lock.",
      );
    if (lock) await lock.close();
    await rm(lockPath, { force: true });
    throw error;
  }
  try {
    return await withPackagedIntake(
      input,
      options,
      (preparedInput, preparedOptions, packaged) =>
        performMusicIntake(preparedInput, preparedOptions, { ...dependencies, ...packaged }),
    );
  } finally {
    try {
      await lock.close();
    } finally {
      await rm(lockPath, { force: true });
    }
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) {
    console.log(INTAKE_USAGE);
  } else {
    try {
      const { input, options } = parseArguments(argv);
      const result = await automateMusicIntake(input, options);
      console.log(
        `Prepared ${result.tracks} recording(s) in ${result.batchId}.${result.quarantined ? " Quarantined: no known published licence. These songs will not appear in the archive, review links or game. Keep your original files." : ""}${options.openPR ? " Pull request opened." : ""}`,
      );
    } catch (error) {
      console.error(`Soundtrack intake failed: ${error.message}`);
      console.error("Run with --help for the complete command syntax.");
      process.exitCode = 1;
    }
  }
}
