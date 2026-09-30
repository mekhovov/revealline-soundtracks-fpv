import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createIntake,
  readBoundedPackageHandle,
  withPackagedIntake,
} from "./intake/add-music.mjs";
import {
  bindPackageInvalidation,
  createPackageGeneration,
  createIntakePackage,
  readIntakePackage,
  validateIntakeMetadata,
} from "./intake/package.mjs";

const mp3 = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]);
const selected = (name, bytes = mp3, relativePath = name) => ({
  name,
  webkitRelativePath: relativePath,
  size: bytes.length,
  arrayBuffer: async () => Uint8Array.from(bytes).buffer,
});
const metadata = {
  artist: "Test Artist",
  source: "https://creator.example/album",
  license: "cc-by-4.0",
  styles: ["synthwave", "gameplay"],
  rightsEvidence: "https://creator.example/album#licence",
  confirmRights: true,
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const id3Frame = (id, text) => {
  const body = Buffer.concat([Buffer.from([3]), Buffer.from(text)]);
  const header = Buffer.alloc(10);
  header.write(id, 0, "ascii");
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
};
const taggedMP3 = (title, artist) => {
  const body = Buffer.concat([
    id3Frame("TIT2", title),
    id3Frame("TPE1", artist),
  ]);
  const header = Buffer.alloc(10);
  header.write("ID3", 0, "ascii");
  header[3] = 3;
  header[9] = body.length;
  return Buffer.concat([header, body, mp3]);
};

test("browser intake files are pinned in the public deployment manifest", async () => {
  const manifest = JSON.parse(
    await readFile("deployment-manifest.json", "utf8"),
  );
  for (const name of [
    "UPLOAD_GUIDE.md",
    "index.html",
    "intake-browser.mjs",
    "intake/package.mjs",
    "style.css",
    "upload-guide/index.html",
  ]) {
    const bytes = await readFile(name);
    const entry = manifest.files.find((candidate) => candidate.path === name);
    assert.deepEqual(entry, {
      path: name,
      bytes: bytes.length,
      sha256: digest(bytes),
    });
  }
  assert.match(await readFile("style.css", "utf8"), /\.button-link\[hidden\]/);
});

test("editing either browser input event invalidates a prepared package", () => {
  const form = new EventTarget();
  let discarded = 0;
  const unbind = bindPackageInvalidation(form, () => discarded++);
  form.dispatchEvent(new Event("input"));
  form.dispatchEvent(new Event("change"));
  assert.equal(discarded, 2);
  unbind();
  form.dispatchEvent(new Event("input"));
  assert.equal(discarded, 2);
});

test("editing during an asynchronous probe prevents stale package publication", async () => {
  const generation = createPackageGeneration();
  const token = generation.begin();
  let finishProbe;
  const probe = new Promise((resolve) => {
    finishProbe = resolve;
  });
  const preparing = createIntakePackage(
    [selected("Before edit.mp3")],
    metadata,
    {
      probe: async () => probe,
      isCurrent: () => generation.isCurrent(token),
    },
  );
  await new Promise((resolve) => setImmediate(resolve));
  generation.invalidate();
  finishProbe(90);
  await assert.rejects(preparing, /Inputs changed while the package/);
});

test("generated multi-track titles remain valid at the creator length limit", async () => {
  const prepared = await createIntakePackage(
    [selected("One.mp3"), selected("Two.mp3")],
    { ...metadata, artist: "A".repeat(160) },
    { probe: async () => 90 },
  );
  assert.equal(prepared.manifest.metadata.batchTitle.length, 160);
  assert.match(prepared.manifest.metadata.batchTitle, / — 2 tracks$/);
});

test("browser package preserves exact bytes, rights and a stable generated identity", async () => {
  const prepared = await createIntakePackage(
    [selected("Night Drive.mp3")],
    metadata,
    { probe: async () => 183.25 },
  );
  assert.match(prepared.manifest.metadata.batchId, /^night-drive-[a-f0-9]{8}$/);
  assert.equal(prepared.manifest.metadata.batchTitle, "Night Drive");
  const unpacked = await readIntakePackage(prepared.blob);
  assert.deepEqual(unpacked.tracks[0].audio, mp3);
  assert.equal(unpacked.tracks[0].durationSeconds, 183.25);
  assert.equal(
    unpacked.manifest.metadata.rightsEvidence,
    metadata.rightsEvidence,
  );
});

test("reader rejects changed audio and undeclared trailing bytes", async () => {
  const prepared = await createIntakePackage(
    [selected("Song.mp3")],
    { ...metadata, batchId: "tamper-check" },
    { probe: async () => 90 },
  );
  const changed = new Uint8Array(await prepared.blob.arrayBuffer());
  changed[changed.length - 1] ^= 1;
  await assert.rejects(readIntakePackage(new Blob([changed])), /hash differs/);
  const trailing = new Blob([prepared.blob, Uint8Array.of(1)]);
  await assert.rejects(readIntakePackage(trailing), /trailing bytes/);
});

test("browser intake enforces rights, ShareAlike disclosure and bounded safe MP3 names", async () => {
  assert.throws(
    () => validateIntakeMetadata({ ...metadata, confirmRights: false }),
    /Confirm the exact public redistribution/,
  );
  const unknown = validateIntakeMetadata({
    ...metadata,
    license: "unknown",
    collections: ["TRENCH ORDERLY", "ФПВ"],
  });
  assert.equal(unknown.license, "unknown");
  assert.deepEqual(unknown.collections, ["TRENCH ORDERLY", "ФПВ"]);
  assert.throws(
    () => validateIntakeMetadata({ ...metadata, license: "cc-by-sa-4.0" }),
    /derivative notice/,
  );
  assert.throws(
    () =>
      validateIntakeMetadata({ ...metadata, attribution: "x".repeat(1001) }),
    /exceeds 1000/,
  );
  await assert.rejects(
    createIntakePackage([selected("../unsafe.mp3")], metadata, {
      probe: async () => 1,
    }),
    /filename is unsafe/,
  );
  await assert.rejects(
    createIntakePackage(
      Array.from({ length: 21 }, (_, index) => selected(`${index}.mp3`)),
      metadata,
      { probe: async () => 1 },
    ),
    /limited to 20/,
  );
});

test("package admission materializes verified bytes and reuses embedded metadata", async (t) => {
  const prepared = await createIntakePackage(
    [selected("One.mp3", mp3, "album/One.mp3")],
    {
      ...metadata,
      rightsEvidence: "",
      batchId: "browser-package",
      batchTitle: "Browser package",
    },
    { probe: async () => 75 },
  );
  const packagePath = path.join(
    os.tmpdir(),
    `browser-package-${process.pid}.rlintake`,
  );
  t.after(() => rm(packagePath, { force: true }));
  const bytes = new Uint8Array(await prepared.blob.arrayBuffer());
  await writeFile(packagePath, bytes);
  let temporary;
  const result = await withPackagedIntake(
    packagePath,
    { styles: [], openPR: true },
    async (directory, options) => {
      temporary = directory;
      const stored = await readFile(path.join(directory, "0000", "One.mp3"));
      assert.deepEqual(stored, Buffer.from(mp3));
      assert.equal(options.batchId, "browser-package");
      assert.equal(options.license, "cc-by-4.0");
      assert.equal(options.rightsEvidence, metadata.source);
      assert.equal(options.artist, undefined);
      assert.equal(options.artistFallback, metadata.artist);
      assert.equal(options.openPR, true);
      const batch = await createIntake(directory, options, {
        probe: async () => 75,
      });
      assert.equal(batch.tracks[0].rights.rightsEvidenceURL, metadata.source);
      return "accepted";
    },
    {
      statFilesystem: async () => ({ bavail: 4 * 1024 ** 3, bsize: 1 }),
      temporaryRoot: os.tmpdir(),
    },
  );
  assert.equal(result, "accepted");
  await assert.rejects(readFile(temporary), /ENOENT/);
  await assert.rejects(
    withPackagedIntake(
      packagePath,
      { styles: ["metal"], source: "https://override.example" },
      async () => {},
    ),
    /already contains metadata/,
  );
});

test("package admission preserves distinct ID3 artists and uses the form creator only as fallback", async (t) => {
  const prepared = await createIntakePackage(
    [
      selected("One.mp3", taggedMP3("One", "Artist One")),
      selected("Two.mp3", taggedMP3("Two", "Artist Two")),
      selected("No Tag.mp3", mp3),
    ],
    { ...metadata, batchId: "mixed-artists" },
    { probe: async () => 75 },
  );
  const packagePath = path.join(
    os.tmpdir(),
    `mixed-artists-${process.pid}.rlintake`,
  );
  t.after(() => rm(packagePath, { force: true }));
  await writeFile(
    packagePath,
    new Uint8Array(await prepared.blob.arrayBuffer()),
  );
  await withPackagedIntake(
    packagePath,
    { styles: [] },
    async (directory, options) => {
      const batch = await createIntake(directory, options, {
        probe: async () => 75,
      });
      assert.deepEqual(
        batch.tracks.map((track) => track.artist),
        [metadata.artist, "Artist One", "Artist Two"],
      );
    },
    {
      statFilesystem: async () => ({ bavail: 4 * 1024 ** 3, bsize: 1 }),
      temporaryRoot: os.tmpdir(),
    },
  );
});

test("package admission rejects symbolic and oversized inputs before reading them", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "archive02-package-bounds-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const target = path.join(directory, "target.rlintake");
  await writeFile(target, "not-a-package");
  const link = path.join(directory, "link.rlintake");
  await symlink(target, link);
  await assert.rejects(
    withPackagedIntake(link, { styles: [] }, async () => {}),
    /ordinary bounded file/,
  );
  const oversized = path.join(directory, "oversized.rlintake");
  const handle = await open(oversized, "w");
  await handle.truncate(66 * 1024 * 1024);
  await handle.close();
  await assert.rejects(
    withPackagedIntake(oversized, { styles: [] }, async () => {}),
    /ordinary bounded file/,
  );
});

test("bounded package reads reject bytes appended after the checked size", async () => {
  const bytes = Buffer.from("checked-extra");
  const handle = {
    async read(target, targetOffset, length, position) {
      const available = Math.min(length, bytes.length - position);
      if (available <= 0) return { bytesRead: 0 };
      bytes.copy(target, targetOffset, position, position + available);
      return { bytesRead: available };
    },
  };
  await assert.rejects(
    readBoundedPackageHandle(handle, "checked".length),
    /changed during its bounded read/,
  );
});
