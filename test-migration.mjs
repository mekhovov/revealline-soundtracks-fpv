import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import test from "node:test";
import { ARCHIVE } from "./archive-config.mjs";
import { verifyArchive, verifyMigration, buildManifest, assertAudioBytes } from "./verify.mjs";
import { hasPublishedLicense, isEligibleForArchive } from "./licensing-policy.mjs";
import { tracksForView } from "./review-policy.mjs";
import { copyMigration, downloadExactSource } from "./intake/migration-copy.mjs";
const readJSON = async (name) => JSON.parse(await readFile(name, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("migration preserves all 73 exact recordings with honest UNKNOWN labels and no defaults", async () => {
  const catalogue = await readJSON("catalogue.json"), snapshot = await readJSON("source-recordings.json"), inventory = await readJSON("migration-inventory.json");
  verifyMigration(inventory, snapshot, catalogue);
  assert.equal(hash(await readFile("source-recordings.json")), ARCHIVE.sourceSnapshotSha256);
  assert.deepEqual(catalogue.tracks.slice(0, 73), snapshot.tracks);
  assert.equal(snapshot.tracks.reduce((sum, track) => sum + track.audio.bytes, 0), 207941311);
  assert.equal(catalogue.archive.id, "revealline-soundtracks-fpv");
  assert.equal(catalogue.archive.baseURL, "https://mekhovov.github.io/revealline-soundtracks-fpv/");
  for (const track of snapshot.tracks) {
    assert.equal(hasPublishedLicense(track), false);
    assert.equal(isEligibleForArchive(track), true);
    assert.equal(track.rights.licenseId, "UNKNOWN");
    assert.equal(track.licenseURL, null);
    assert.equal(track.gameCatalogueAdmission, false);
    assert.equal(track.default, false);
    assert.equal(track.recordingModeEligible, false);
  }
  assert.equal(tracksForView(catalogue.tracks).length, catalogue.tracks.length);
});

test("source substitutions, licence relabeling, source URL drift and duplicate members fail closed", async () => {
  const catalogue = await readJSON("catalogue.json"), snapshot = await readJSON("source-recordings.json"), inventory = await readJSON("migration-inventory.json");
  for (const mutation of [
    (value) => value.recordings.pop(),
    (value) => value.recordings[0].bytes++,
    (value) => value.recordings[0].sha256 = "a".repeat(64),
    (value) => value.recordings[0].destinationPath = "../bad.mp3",
    (value) => value.recordings[0].sourceURL = "https://example.com/bad.mp3",
    (value) => value.recordings[0] = value.recordings[1],
  ]) {
    const changed = structuredClone(inventory); mutation(changed);
    assert.throws(() => verifyMigration(changed, snapshot, catalogue), /migration/i);
  }
  for (const field of ["id", "title", "artist", "credit", "license", "source"])
    { const changed = structuredClone(catalogue); changed.tracks[0][field] = "altered";
      assert.throws(() => verifyMigration(inventory, snapshot, changed), /recording/i); }
  const bytes = Buffer.from("exact");
  assert.throws(() => assertAudioBytes(bytes, { bytes: bytes.length + 1, sha256: hash(bytes) }), /byte count/);
  assert.throws(() => assertAudioBytes(bytes, { bytes: bytes.length, sha256: "a".repeat(64) }), /SHA-256/);
});

test("own Pages payload includes every migrated hash without any main archive audio dependency", async () => {
  const verified = await verifyArchive();
  assert.ok(verified.tracks >= 73);
  assert.ok(verified.audioBytes >= 207941311);
  assert.ok(verified.publicBytes < 950 * 1024 * 1024);
  assert.deepEqual(verified.manifest, await buildManifest());
  const objects = verified.manifest.files.filter((entry) => entry.path.startsWith("objects/"));
  const inventory = await readJSON("migration-inventory.json");
  assert.ok(objects.length >= 73);
  for (const member of inventory.recordings)
    assert.deepEqual(objects.find(({ sha256 }) => sha256 === member.sha256),
      { path: member.destinationPath, bytes: member.bytes, sha256: member.sha256 });
  assert.ok(!verified.manifest.files.some(({ path }) => path.startsWith("legacy/") || path === "source-recordings.json"));
});

const bytes = Buffer.from("ID3-exact-audio-fixture-with-bounded-bytes");
const member = { id: "test.track", sha256: hash(bytes), bytes: bytes.length, sourceReleaseTag: "audio-source" };
member.sourceURL = `https://github.com/${ARCHIVE.sourceRepository}/releases/download/${member.sourceReleaseTag}/${member.sha256}.mp3`;
function audioRequest({ drift = false, truncated = false, range = true, redirect = null, oversized = false } = {}) {
  return async (url, init) => {
    assert.equal(init.redirect, "manual");
    assert.equal(init.headers?.Authorization, undefined);
    if (redirect) return new Response(null, { status: 302, headers: { Location: redirect } });
    if (init.headers?.Range) return new Response(bytes.subarray(0, 16), { status: range ? 206 : 200, headers: { "Content-Range": `bytes 0-15/${bytes.length}` } });
    return new Response(oversized ? Buffer.concat([bytes, bytes]) : truncated ? bytes.subarray(1) : drift ? Buffer.alloc(bytes.length) : bytes);
  };
}

test("hosted source downloader enforces complete bytes, ranges, HTTPS redirect bounds and no credentials", async () => {
  assert.deepEqual(await downloadExactSource(member, { request: audioRequest() }), bytes);
  for (const options of [{ drift: true }, { truncated: true }, { range: false }, { oversized: true },
    { redirect: "http://github.com/audio" }, { redirect: "https://127.0.0.1/audio" },
    { redirect: member.sourceURL }])
    await assert.rejects(downloadExactSource(member, { request: audioRequest(options) }));
  let fetched = false;
  await assert.rejects(downloadExactSource({ ...member, sourceURL: "https://example.com/audio" }, { request: async () => { fetched = true; } }), /Source URL/);
  assert.equal(fetched, false);
});

function github(initial = null) {
  let release = initial && structuredClone(initial);
  const calls = [];
  const run = async (args) => {
    assert.deepEqual(args.slice(-2), ["--repo", ARCHIVE.repository]);
    assert.ok(!args.includes("--clobber")); calls.push(args[1]);
    switch (args[1]) {
      case "list": return JSON.stringify(release ? [{ tagName: release.tagName }] : []);
      case "create": assert.ok(args.includes("--draft")); release = { tagName: ARCHIVE.migrationTag, isDraft: true, isPrerelease: false, assets: [] }; break;
      case "view": return JSON.stringify(release);
      case "upload": {
        assert.equal(release.isDraft, true);
        const bytes = await readFile(args[3]);
        release.assets.push({ name: `${hash(bytes)}.mp3`, size: bytes.length, state: "uploaded", digest: `sha256:${hash(bytes)}` }); break;
      }
      case "edit": release.isDraft = false; release.isPrerelease = args.includes("--prerelease=true"); break;
      default: throw new Error("Unexpected GitHub operation");
    }
    return "";
  };
  return { run, calls, release: () => release };
}
const fixture = { destinationRepository: ARCHIVE.repository, releaseTag: ARCHIVE.migrationTag, recordings: [member] };

test("hosted copy publishes only an exact complete volume and is idempotent without replacement", async () => {
  const gh = github();
  assert.deepEqual(await copyMigration(fixture, { run: gh.run, request: audioRequest() }),
    { recordings: 1, bytes: bytes.length, releaseTag: ARCHIVE.migrationTag });
  assert.equal(gh.release().isDraft, false); assert.equal(gh.release().isPrerelease, true);
  const again = github(gh.release());
  await copyMigration(fixture, { run: again.run, request: () => { throw new Error("Unexpected audio download"); } });
  assert.ok(!again.calls.includes("upload")); assert.ok(!again.calls.includes("edit"));
  const promote = github(gh.release());
  await copyMigration(fixture, { run: promote.run, promote: true });
  assert.equal(promote.release().isPrerelease, false); assert.ok(!promote.calls.includes("upload"));
  const corrupted = gh.release(); corrupted.assets[0].digest = `sha256:${"f".repeat(64)}`;
  const bad = github(corrupted);
  await assert.rejects(copyMigration(fixture, { run: bad.run }), /identity differs/);
  assert.deepEqual(bad.calls, ["list", "view"]);
});

test("public PRs are read-only; only repository pushes copy audio and only main deploys", async () => {
  const workflow = await readFile(".github/workflows/pages.yml", "utf8");
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(workflow, /github.event_name == 'push'.*github.repository == 'mekhovov\/revealline-soundtracks-fpv'/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  const verification = workflow.split("  verify:")[1].split("  deploy:")[0];
  assert.doesNotMatch(verification, /contents: write|GH_TOKEN/);
  assert.match(workflow.split("  deploy:")[1], /github.ref == 'refs\/heads\/main'/);
});
