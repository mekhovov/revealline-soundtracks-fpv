import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHIVE } from "../archive-config.mjs";
import { downloadExactGitHubAudio } from "./github-audio.mjs";
import { verifyArchive } from "../verify.mjs";
import { assertReleaseVolume, RELEASE_VOLUME_FIELDS } from "./audio-volume.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const demand = (ok, message) => { if (!ok) throw new Error(message); };
export async function downloadExactSource(member, options) {
  demand(member.sourceURL === `https://github.com/${ARCHIVE.sourceRepository}/releases/download/${member.sourceReleaseTag}/${member.sha256}.mp3` && /^audio-[a-z0-9-]+$/.test(member.sourceReleaseTag), "Source URL differs.");
  return downloadExactGitHubAudio(member.sourceURL, member, options);
}

export async function copyMigration(inventory, { run, request = fetch, temporaryRoot = os.tmpdir(), promote = false } = {}) {
  demand(inventory.destinationRepository === ARCHIVE.repository && inventory.releaseTag === ARCHIVE.migrationTag,
    "Destination release differs.");
  const volume = { releaseTag: inventory.releaseTag, assets: inventory.recordings.map(({ sha256, bytes }) => ({ sha256, bytes })) };
  assertReleaseVolume({ tagName: volume.releaseTag, isDraft: true, isPrerelease: false, assets: [] }, volume, { allowMissing: true });
  const gh = (args) => run([...args, "--repo", ARCHIVE.repository]);
  const read = async () => JSON.parse(await gh(["release", "view", volume.releaseTag, "--json", RELEASE_VOLUME_FIELDS]));
  const releases = JSON.parse(await gh(["release", "list", "--limit", "1000", "--json", "tagName"]));
  demand(Array.isArray(releases), "Release listing failed.");
  if (!releases.some(({ tagName }) => tagName === volume.releaseTag))
    await gh(["release", "create", volume.releaseTag, "--draft", "--target", "main", "--title", "FPV migration · exact audio",
      "--notes", "Existing recording bytes copied with pinned SHA-256 identities. Unknown licence labels remain unknown; no open licence or game-default approval is claimed."]);
  let release = await read();
  const { missingAssets } = assertReleaseVolume(release, volume, { allowMissing: true });
  for (const asset of missingAssets) {
    const member = inventory.recordings.find((entry) => entry.sha256 === asset.sha256);
    const bytes = await downloadExactSource(member, { request });
    const directory = await mkdtemp(path.join(temporaryRoot, "fpv-migration-"));
    try {
      const file = path.join(directory, `${asset.sha256}.mp3`);
      await writeFile(file, bytes, { flag: "wx" });
      await gh(["release", "upload", volume.releaseTag, file]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  release = await read(); assertReleaseVolume(release, volume);
  if (release.isDraft || (promote && release.isPrerelease)) {
    await gh(["release", "edit", volume.releaseTag, "--draft=false", `--prerelease=${promote ? "false" : "true"}`, "--latest=false"]);
    release = await read(); assertReleaseVolume(release, volume);
    demand(!release.isDraft && (!promote || !release.isPrerelease), "Release publication was not confirmed.");
  }
  return { recordings: volume.assets.length, bytes: volume.assets.reduce((sum, asset) => sum + asset.bytes, 0), releaseTag: volume.releaseTag };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  demand(process.env.GH_TOKEN, "GH_TOKEN is required for the hosted copy.");
  demand(process.env.GITHUB_REPOSITORY === ARCHIVE.repository &&
    process.env.GITHUB_ACTOR === "mekhovov" && process.env.GITHUB_EVENT_NAME === "push" &&
    ["refs/heads/main", "refs/heads/codex/fpv-archive-migration-20261001"].includes(process.env.GITHUB_REF),
    "Audio migration runs only on an owner push to the reviewed repository branch.");
  await verifyArchive(root);
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn("gh", args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", (part) => output += part);
    child.stderr.on("data", (part) => error += part);
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`gh failed (${code}): ${error.trim()}`)));
  });
  const inventory = JSON.parse(await readFile(path.join(root, "migration-inventory.json")));
  console.log(JSON.stringify(await copyMigration(inventory, { run, promote: process.env.GITHUB_REF === "refs/heads/main" })));
}
