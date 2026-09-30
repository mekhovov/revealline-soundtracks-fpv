const SHA256 = /^[a-f0-9]{64}$/;
const RELEASE_TAG = /^audio-[a-z0-9-]+$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export const RELEASE_VOLUME_FIELDS = "isDraft,isPrerelease,assets,tagName";

const demand = (condition, message) => {
  if (!condition) throw new Error(message);
};

function expectedAssets(volume) {
  demand(
    RELEASE_TAG.test(volume?.releaseTag ?? "") &&
      Array.isArray(volume.assets) &&
      volume.assets.length > 0 &&
      volume.assets.length <= 1000,
    "Audio volume manifest is invalid.",
  );
  const assets = new Map();
  for (const asset of volume.assets) {
    demand(
      SHA256.test(asset?.sha256 ?? "") &&
        Number.isSafeInteger(asset.bytes) &&
        asset.bytes > 0 &&
        !assets.has(`${asset.sha256}.mp3`),
      `Audio volume asset identity is invalid: ${volume.releaseTag}`,
    );
    assets.set(`${asset.sha256}.mp3`, asset);
  }
  return assets;
}

// A draft may contain an exact subset while an interrupted upload is resumed.
// Published volumes must always match completely; no asset is replaced or removed.
export function assertReleaseVolume(
  release,
  volume,
  { allowMissing = false } = {},
) {
  const expected = expectedAssets(volume);
  demand(
    release?.tagName === volume.releaseTag &&
      typeof release.isDraft === "boolean" &&
      typeof release.isPrerelease === "boolean" &&
      Array.isArray(release.assets) &&
      release.assets.length <= expected.size,
    `Release identity or asset count differs: ${volume.releaseTag}`,
  );
  const seen = new Set();
  for (const asset of release.assets) {
    const wanted = expected.get(asset?.name);
    demand(
      wanted &&
        !seen.has(asset.name) &&
        asset.size === wanted.bytes &&
        asset.state === "uploaded" &&
        asset.digest === `sha256:${wanted.sha256}`,
      `Release asset identity differs: ${volume.releaseTag}/${asset?.name ?? "unknown"}; exact size, uploaded state and SHA-256 digest are required.`,
    );
    seen.add(asset.name);
  }
  const missingAssets = [...expected.entries()]
    .filter(([name]) => !seen.has(name))
    .map(([, asset]) => ({ sha256: asset.sha256, bytes: asset.bytes }));
  demand(
    missingAssets.length === 0 || (allowMissing === true && release.isDraft),
    `Release assets are incomplete: ${volume.releaseTag}`,
  );
  return { missingAssets };
}

// Used only by the trusted main publisher. The caller supplies the gh runner so
// tests can prove the operation changes release metadata, never asset bytes.
export async function promoteAudioVolume(volume, { repo, run }) {
  expectedAssets(volume);
  demand(REPOSITORY.test(repo ?? ""), "Audio volume repository is invalid.");
  demand(typeof run === "function", "Audio volume GitHub runner is required.");
  const read = async () =>
    JSON.parse(
      await run([
        "release",
        "view",
        volume.releaseTag,
        "--repo",
        repo,
        "--json",
        RELEASE_VOLUME_FIELDS,
      ]),
    );
  const release = await read();
  assertReleaseVolume(release, volume);
  if (!release.isDraft && !release.isPrerelease) return "verified";
  await run([
    "release",
    "edit",
    volume.releaseTag,
    "--repo",
    repo,
    "--draft=false",
    "--prerelease=false",
    "--latest=false",
  ]);
  const promoted = await read();
  assertReleaseVolume(promoted, volume);
  demand(
    promoted.isDraft === false && promoted.isPrerelease === false,
    `Audio volume promotion was not confirmed: ${volume.releaseTag}`,
  );
  return release.isDraft ? "published" : "promoted";
}
