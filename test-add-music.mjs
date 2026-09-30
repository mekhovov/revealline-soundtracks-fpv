import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  batchFiles,
  createIntake,
  createExternalIntake,
  findMP3Files,
  INTAKE_USAGE,
  parseArguments,
  publicTrack,
} from "./intake/add-music.mjs";

const fakeMP3 = Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]);

async function temporary(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "archive02-intake-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("arguments preserve the explicit rights gate and style selection", () => {
  const parsed = parseArguments([
    "/music",
    "--source",
    "https://creator.example/album",
    "--license",
    "cc-by-4.0",
    "--styles",
    "synthwave, electro,gameplay",
    "--collections",
    "TRENCH ORDERLY, ФПВ",
    "--confirm-rights",
    "--open-pr",
  ]);
  assert.equal(parsed.input, "/music");
  assert.deepEqual(parsed.options.styles, ["synthwave", "electro", "gameplay"]);
  assert.deepEqual(parsed.options.collections, ["TRENCH ORDERLY", "ФПВ"]);
  assert.equal(parsed.options.confirmRights, true);
  assert.equal(parsed.options.openPR, true);
});

test("arguments accept one hosted URL or URL manifest and reject mixed sources", () => {
  const single = parseArguments(["--audio-url", "https://cdn.example/song.mp3", "--title", "Song"]);
  assert.equal(single.input, null);
  assert.equal(single.options.audioURL, "https://cdn.example/song.mp3");
  const batch = parseArguments(["--url-manifest", "/tmp/tracks.json"]);
  assert.equal(batch.options.urlManifest, "/tmp/tracks.json");
  assert.throws(() => parseArguments(["/music", "--audio-url", "https://cdn.example/song.mp3"]), /exactly one/);
});

test("single hosted URL intake binds verified delivery evidence", async () => {
  const bytes = Buffer.from(fakeMP3);
  const result = await createExternalIntake(
    {
      audioURL: "https://cdn.example/song.mp3",
      title: "External Song",
      artist: "External Artist",
      source: "https://creator.example/song",
      license: "cc-by-4.0",
      styles: ["synth"],
      collections: ["Hosted"],
      confirmRights: true,
      batchId: "external-song",
    },
    {
      verify: async (url) => ({
        url,
        bytes,
        byteCount: bytes.length,
        sha256: "a".repeat(64),
        verifiedAt: "2026-09-27T00:00:00.000Z",
        rangeRequests: true,
        cors: true,
      }),
      probe: async () => 130,
    },
  );
  assert.equal(result.external, true);
  assert.equal(result.tracks[0].audioURL, "https://cdn.example/song.mp3");
  assert.equal(result.tracks[0].delivery.type, "external-url");
  assert.equal(result.tracks[0].durationSeconds, 130);
});

test("new local recordings use immutable Pages object URLs", async () => {
  const bytes = Buffer.from(fakeMP3);
  const sha256 = "d".repeat(64);
  const track = publicTrack(
    {
      id: "artist.song",
      title: "Song",
      artist: "Artist",
      durationSeconds: 90,
      tags: ["synth"],
      source: "https://creator.example/song",
      license: "CC0 1.0 Universal",
      licenseURL: "https://creativecommons.org/publicdomain/zero/1.0/",
      credit: "Song by Artist.",
      rights: {},
      fileName: "song.mp3",
      sha256,
      bytes,
    },
    {
      title: "Collection",
      collections: ["Synth"],
      batchId: "collection",
      external: false,
    },
  );

  assert.deepEqual(track.audio, {
    path: `objects/${sha256}.mp3`,
    bytes: bytes.length,
    sha256,
  });
});

test("hosted URL manifest prepares a deterministic multi-recording batch", async (t) => {
  const root = await temporary(t);
  const manifest = path.join(root, "tracks.json");
  await writeFile(manifest, JSON.stringify({ tracks: [
    { audioURL: "https://cdn.example/one.mp3", title: "One", artist: "Artist", fileName: "one.mp3" },
    { audioURL: "https://cdn.example/two.mp3", title: "Two", artist: "Artist", fileName: "two.mp3" },
  ] }));
  const result = await createExternalIntake(
    {
      urlManifest: manifest,
      source: "https://creator.example/album",
      license: "cc0",
      styles: ["electro"],
      collections: ["Hosted"],
      confirmRights: true,
      batchId: "hosted-manifest",
      batchTitle: "Hosted manifest",
    },
    {
      verify: async (url) => ({ url, bytes: Buffer.from(fakeMP3), byteCount: fakeMP3.length, sha256: url.includes("one") ? "b".repeat(64) : "c".repeat(64), verifiedAt: "2026-09-27T00:00:00.000Z", rangeRequests: true, cors: true }),
      probe: async () => 90,
    },
  );
  assert.deepEqual(result.tracks.map(({ title }) => title), ["One", "Two"]);
  assert.equal(result.title, "Hosted manifest");
});

test("help documents the required rights gate and batch limit", () => {
  assert.match(INTAKE_USAGE, /--confirm-rights/);
  assert.match(INTAKE_USAGE, /at most 20 MP3 files/);
  assert.match(INTAKE_USAGE, /not rights evidence by itself/);
  assert.match(INTAKE_USAGE, /package\.rlintake/);
  assert.match(INTAKE_USAGE, /unknown/);
});

test("unknown rights keep the explicit uploader confirmation and collections", async (t) => {
  const root = await temporary(t);
  const file = path.join(root, "song.mp3");
  await writeFile(file, fakeMP3);
  const result = await createIntake(
    file,
    {
      artist: "TRENCH ORDERLY",
      source: "https://www.youtube.com/channel/example",
      license: "unknown",
      styles: ["ФПВ", "UA"],
      collections: ["TRENCH ORDERLY", "ФПВ"],
      confirmRights: true,
      batchId: "unknown-rights-test",
    },
    { probe: async () => 120 },
  );
  assert.equal(result.tracks[0].licenseURL, null);
  assert.equal(result.tracks[0].rights.licenseId, "UNKNOWN");
  assert.equal(
    result.tracks[0].rights.permissionBasis,
    "uploader-confirmed-public-redistribution-and-web-playback",
  );
  assert.deepEqual(result.collections, ["TRENCH ORDERLY", "ФПВ"]);
});

test("folder discovery is deterministic and ignores non-MP3 files", async (t) => {
  const root = await temporary(t);
  await mkdir(path.join(root, "nested"));
  await Promise.all([
    writeFile(path.join(root, "z.mp3"), fakeMP3),
    writeFile(path.join(root, "a.MP3"), fakeMP3),
    writeFile(path.join(root, "notes.txt"), "ignore"),
    writeFile(path.join(root, "nested", "m.mp3"), fakeMP3),
  ]);
  assert.deepEqual(
    (await findMP3Files(root)).map((file) => path.relative(root, file)),
    ["a.MP3", "nested/m.mp3", "z.mp3"],
  );
});

test("Cyrillic folder intake creates a readable collision-resistant batch identity", async (t) => {
  const root = await temporary(t);
  const folder = path.join(root, "Мос");
  await mkdir(folder);
  await writeFile(path.join(folder, "Пісня.mp3"), fakeMP3);
  const result = await createIntake(
    folder,
    {
      artist: "Мос",
      source: "https://www.youtube.com/@Mos_18000",
      license: "unknown",
      styles: ["ФПВ", "UA"],
      collections: ["Мос", "ФПВ"],
      confirmRights: true,
    },
    { probe: async () => 120 },
  );
  assert.match(result.batchId, /^mos-\d{8}-[a-f0-9]{8}$/);
  assert.equal(result.tracks[0].id, "mos.pisnya");
});

test("intake binds exact rights and produces stable unique identities", async (t) => {
  const root = await temporary(t);
  await mkdir(path.join(root, "one"));
  await mkdir(path.join(root, "two"));
  await writeFile(path.join(root, "one", "Night Drive.mp3"), fakeMP3);
  await writeFile(
    path.join(root, "two", "Night Drive.mp3"),
    Buffer.concat([fakeMP3, Buffer.from([1])]),
  );
  const result = await createIntake(
    root,
    {
      artist: "Test Artist",
      source: "https://creator.example/album",
      license: "cc-by-4.0",
      styles: ["synthwave", "gameplay"],
      confirmRights: true,
      batchId: "test-night-drive",
    },
    { probe: async () => 180.5 },
  );
  assert.deepEqual(
    result.tracks.map((track) => track.id),
    ["test-artist.night-drive", "test-artist.night-drive.2"],
  );
  assert.equal(result.tracks[0].rights.licenseId, "CC-BY");
  assert.equal(
    result.tracks[0].rights.rightsEvidenceURL,
    "https://creator.example/album",
  );
  assert.equal(result.tracks[0].durationSeconds, 180.5);
});

test("intake refuses missing rights confirmation and incomplete ShareAlike evidence", async (t) => {
  const root = await temporary(t);
  const file = path.join(root, "song.mp3");
  await writeFile(file, fakeMP3);
  const base = {
    artist: "Artist",
    title: "Song",
    source: "https://creator.example/song",
    styles: ["metal"],
    batchId: "rights-test",
  };
  await assert.rejects(
    createIntake(
      file,
      { ...base, license: "cc-by-4.0" },
      { probe: async () => 1 },
    ),
    /--confirm-rights/,
  );
  await assert.rejects(
    createIntake(
      file,
      { ...base, license: "cc-by-sa-4.0", confirmRights: true },
      { probe: async () => 1 },
    ),
    /--derivative-notice/,
  );
  const shareAlike = await createIntake(
    file,
    {
      ...base,
      license: "cc-by-sa-4.0",
      confirmRights: true,
      rightsEvidence: "https://creator.example/song#license",
      derivativeNotice: "Exact creator MP3 bytes retained.",
    },
    { probe: async () => 1 },
  );
  assert.equal(
    shareAlike.tracks[0].rights.rightsEvidenceURL,
    "https://creator.example/song#license",
  );
  assert.equal(shareAlike.tracks[0].rights.shareAlike.required, true);
});

test("batch pages surface exact attribution and derivative notices", () => {
  const files = batchFiles({
    title: "Licensed audition",
    description: "Full listening review.",
    tracks: [
      {
        title: "Night < Drive",
        artist: "Artist & Company",
        sha256: "a".repeat(64),
        source: "https://creator.example/song?a=1&b=2",
        licenseURL: "https://creativecommons.org/licenses/by/3.0/",
        license: "CC BY 3.0 Unported",
        credit: "MUSIC BY ARTIST https://creator.example/",
        rights: {
          derivativeChangeNotice:
            "Converted from the creator OGG and loudness-normalized.",
        },
      },
    ],
  });
  const page = files.get("index.html");
  assert.match(page, /MUSIC BY ARTIST https:\/\/creator\.example\//);
  assert.match(
    page,
    /Changes: Converted from the creator OGG and loudness-normalized\./,
  );
  assert.match(page, /Night &lt; Drive/);
  assert.match(page, /Artist &amp; Company/);
  assert.match(page, /song\?a=1&amp;b=2/);
  assert.match(
    files.get("CREDITS.md"),
    /Changes: Converted from the creator OGG and loudness-normalized\./,
  );
});
