import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHIVE } from "./archive-config.mjs";
import { downloadExactGitHubAudio } from "./intake/github-audio.mjs";
import { isEligibleForArchive } from "./licensing-policy.mjs";
import { verifyExternalDeliveryMetadata } from "./intake/external-url.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const HASH = /^[a-f0-9]{64}$/;
const OBJECT = /^objects\/([a-f0-9]{64})\.mp3$/;
const PUBLIC_FILES = [".nojekyll", "README.md", "UPLOAD_GUIDE.md", "CREDITS.md",
  "catalogue.json", "batches.json", "audio-volumes.json", "external-deliveries.json",
  "migration-inventory.json", "index.html", "upload-guide/index.html", "style.css",
  "archive-config.mjs", "licensing-policy.mjs", "review-policy.mjs", "player.mjs",
  "playback-policy.mjs", "playback-recovery.mjs", "style-taxonomy.mjs", "filter-url.mjs",
  "intake-browser.mjs", "intake/package.mjs", "intake/external-url.mjs"];
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const demand = (ok, message) => { if (!ok) throw new Error(message); };
const readJSON = async (base, name) => JSON.parse(await readFile(path.join(base, name), "utf8"));
const safeHTTPS = (input) => { try { const u = new URL(input); return u.protocol === "https:" && !u.username && !u.password; } catch { return false; } };

export function assertAudioBytes(bytes, expected) {
  demand(bytes.length === expected.bytes && digest(bytes) === expected.sha256,
    `Audio byte count or SHA-256 differs: ${expected.sha256}`);
}

export function verifyMigration(inventory, snapshot, catalogue) {
  demand(inventory?.format === "revealline-fpv-migration.v1" &&
    inventory.sourceRepository === ARCHIVE.sourceRepository &&
    inventory.destinationRepository === ARCHIVE.repository &&
    inventory.sourceRevision === ARCHIVE.sourceRevision &&
    inventory.releaseTag === ARCHIVE.migrationTag &&
    inventory.sourceCatalogueSha256 === snapshot.sourceCatalogueSha256 &&
    snapshot.sourceRevision === ARCHIVE.sourceRevision &&
    snapshot.tracks.length === 73 && inventory.recordings.length === 73,
    "FPV migration identity or count differs.");
  const ids = new Set(), hashes = new Set();
  let bytes = 0;
  for (const member of inventory.recordings) {
    const original = snapshot.tracks.find((track) => track.id === member.id);
    const selected = catalogue.tracks.filter((track) => track.id === member.id);
    demand(original && selected.length === 1 && !ids.has(member.id) && !hashes.has(member.sha256) &&
      member.sha256 === original.audio.sha256 && member.bytes === original.audio.bytes &&
      member.destinationPath === `objects/${member.sha256}.mp3` &&
      /^audio-[a-z0-9-]+$/.test(member.sourceReleaseTag) &&
      member.sourceURL === `https://github.com/${ARCHIVE.sourceRepository}/releases/download/${member.sourceReleaseTag}/${member.sha256}.mp3`,
      `FPV migration recording differs: ${member.id}`);
    demand(JSON.stringify(selected[0]) === JSON.stringify(original),
      `Original recording metadata changed: ${member.id}`);
    demand(original.rights.licenseId === "UNKNOWN" && original.licenseURL === null,
      `Migration must preserve unknown licence labels: ${member.id}`);
    ids.add(member.id); hashes.add(member.sha256); bytes += member.bytes;
  }
  demand(bytes === 207941311, "FPV migration byte total differs.");
}

export async function buildManifest(base = root) {
  const files = new Map();
  for (const name of PUBLIC_FILES) {
    const file = path.join(base, name), stat = await lstat(file);
    demand(stat.isFile() && !stat.isSymbolicLink(), `Public file must be ordinary: ${name}`);
    const bytes = await readFile(file);
    files.set(name, { path: name, bytes: bytes.length, sha256: digest(bytes) });
  }
  const catalogue = await readJSON(base, "catalogue.json");
  for (const track of catalogue.tracks) {
    if (!OBJECT.test(track.audio.path)) continue;
    const entry = { path: track.audio.path, bytes: track.audio.bytes, sha256: track.audio.sha256 };
    files.set(entry.path, entry);
  }
  return { format: "revealline-soundtrack-catalogue-deployment.v2", archiveId: ARCHIVE.id,
    files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}

export async function verifyArchive(base = root, { publicStage = false } = {}) {
  const raw = await readFile(path.join(base, "catalogue.json"));
  demand(raw.length <= 1024 * 1024, "Catalogue exceeds 1 MiB.");
  const catalogue = JSON.parse(raw);
  demand(catalogue.format === "revealline-public-soundtrack-catalogue.v1" &&
    catalogue.archive.id === ARCHIVE.id && catalogue.archive.baseURL === ARCHIVE.baseURL &&
    Array.isArray(catalogue.tracks) && catalogue.tracks.length >= 73 && catalogue.tracks.length <= 512,
    "FPV archive identity or count differs.");
  const volumes = await readJSON(base, "audio-volumes.json"), assets = new Map();
  demand(volumes.format === "revealline-soundtrack-audio-volumes.v1", "Audio volumes differ.");
  for (const volume of volumes.volumes) {
    demand(/^audio-[a-z0-9-]+$/.test(volume.releaseTag) && Array.isArray(volume.assets), "Audio volume is invalid.");
    for (const asset of volume.assets) {
      demand(!assets.has(asset.sha256) && HASH.test(asset.sha256) && Number.isSafeInteger(asset.bytes) && asset.bytes > 0, "Duplicate or invalid volume asset.");
      assets.set(asset.sha256, { ...asset, releaseTag: volume.releaseTag });
    }
  }
  const external = await readJSON(base, "external-deliveries.json");
  demand(external.format === "revealline-external-audio-deliveries.v1", "External inventory differs.");
  const externalMap = new Map(external.recordings.map((entry) => [entry.id, entry]));
  demand(externalMap.size === external.recordings.length, "Duplicate external recording.");
  const ids = new Set(), hashes = new Set(); let audioBytes = 0;
  for (const track of catalogue.tracks) {
    demand(typeof track.id === "string" && track.id && !ids.has(track.id), "Duplicate/invalid recording ID.");
    demand(typeof track.title === "string" && track.title.trim() && typeof track.artist === "string" && track.artist.trim(), `Missing title/artist: ${track.id}`);
    demand(isEligibleForArchive(track) && safeHTTPS(track.source) && safeHTTPS(track.rights.rightsEvidenceURL) &&
      track.credit === track.rights.attribution, `Missing or inconsistent rights metadata: ${track.id}`);
    demand(track.default !== true && track.gameCatalogueAdmission === false && track.recordingModeEligible === false,
      `FPV recordings must not become game defaults or Recording-mode eligible: ${track.id}`);
    demand(Array.isArray(track.tags) && track.tags.length > 0 && track.tags.length <= 32 &&
      Array.isArray(track.collections) && track.collections.length > 0 && track.collections.length <= 16,
      `Style/collection metadata differs: ${track.id}`);
    demand(HASH.test(track.audio.sha256) && !hashes.has(track.audio.sha256) && Number.isSafeInteger(track.audio.bytes) && track.audio.bytes > 0,
      `Audio identity differs: ${track.id}`);
    if (track.audio.delivery?.type === "external-url") {
      const url = verifyExternalDeliveryMetadata(track.audio), entry = externalMap.get(track.id);
      demand(entry && entry.url === url.href && entry.bytes === track.audio.bytes && entry.sha256 === track.audio.sha256 &&
        entry.host === url.host && entry.verifiedAt === track.audio.delivery.verifiedAt && !assets.has(track.audio.sha256),
        `External recording evidence differs: ${track.id}`);
    } else demand(track.audio.path === `objects/${track.audio.sha256}.mp3` && assets.get(track.audio.sha256)?.bytes === track.audio.bytes,
      `Volume recording evidence differs: ${track.id}`);
    ids.add(track.id); hashes.add(track.audio.sha256); audioBytes += track.audio.bytes;
  }
  demand(hashes.size === assets.size + externalMap.size, "Catalogue/audio inventories differ.");
  demand(catalogue.counts.declaredTracks === ids.size && catalogue.counts.uniqueRecordings === ids.size &&
    catalogue.counts.audioBytes === audioBytes, "Catalogue counts differ.");
  if (!publicStage) {
    const snapshotBytes = await readFile(path.join(base, "source-recordings.json"));
    demand(digest(snapshotBytes) === ARCHIVE.sourceSnapshotSha256, "Pinned source snapshot changed.");
    verifyMigration(await readJSON(base, "migration-inventory.json"), JSON.parse(snapshotBytes), catalogue);
  }
  const expected = await buildManifest(base), manifest = await readJSON(base, "deployment-manifest.json");
  demand(JSON.stringify(expected) === JSON.stringify(manifest), "Deployment manifest is stale.");
  const publicBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
  demand(publicBytes < 950 * 1024 ** 2, "Pages exceeds its 950 MiB budget.");
  for (const entry of manifest.files) {
    try {
      const file = path.join(base, entry.path), stat = await lstat(file);
      demand(stat.isFile() && !stat.isSymbolicLink(), `Non-ordinary public file: ${entry.path}`);
      assertAudioBytes(await readFile(file), entry);
    } catch (error) {
      if (error.code !== "ENOENT" || publicStage || !OBJECT.test(entry.path)) throw error;
    }
  }
  return { tracks: ids.size, audioBytes, publicBytes, manifest };
}

export async function stageArchive(destination, base = root, { request = fetch } = {}) {
  const verified = await verifyArchive(base), target = path.resolve(destination);
  demand(target !== path.resolve(base), "Stage must differ from the repository.");
  const disk = await statfs(path.dirname(target));
  demand(disk.bavail * disk.bsize >= 1024 ** 3 + verified.publicBytes, "Staging must leave at least 1 GiB free.");
  await rm(target, { recursive: true, force: true }); await mkdir(target, { recursive: true });
  const volumes = await readJSON(base, "audio-volumes.json");
  const tags = new Map(volumes.volumes.flatMap((volume) => volume.assets.map((asset) => [asset.sha256, volume.releaseTag])));
  for (const entry of verified.manifest.files) {
    const targetFile = path.join(target, entry.path); await mkdir(path.dirname(targetFile), { recursive: true });
    try { await copyFile(path.join(base, entry.path), targetFile, constants.COPYFILE_EXCL); }
    catch (error) {
      if (error.code !== "ENOENT" || !OBJECT.test(entry.path)) throw error;
      const bytes = await downloadExactGitHubAudio(`https://github.com/${ARCHIVE.repository}/releases/download/${tags.get(entry.sha256)}/${entry.sha256}.mp3`, entry, { request });
      await writeFile(targetFile, bytes, { flag: "wx" });
    }
  }
  await copyFile(path.join(base, "deployment-manifest.json"), path.join(target, "deployment-manifest.json"));
  return verifyArchive(target, { publicStage: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--write-manifest" && args.length === 1) await writeFile(path.join(root, "deployment-manifest.json"), `${JSON.stringify(await buildManifest(), null, 2)}\n`);
  else if (args[0] === "--stage" && args.length === 2) console.log(JSON.stringify(await stageArchive(args[1])));
  else if (args.length === 0) { const result = await verifyArchive(); delete result.manifest; console.log(JSON.stringify(result)); }
  else throw new Error("Usage: node verify.mjs [--write-manifest|--stage DIRECTORY]");
}
