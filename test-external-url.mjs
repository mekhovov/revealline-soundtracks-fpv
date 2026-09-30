import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createExternalIntakePackage, readIntakePackage } from "./intake/package.mjs";
import { validateExternalAudioURL } from "./intake/external-url.mjs";
import { verifyExternalAudio } from "./intake/verify-external.mjs";

const mp3 = Uint8Array.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]);
const hash = createHash("sha256").update(mp3).digest("hex");
const publicResolver = async () => [{ address: "203.0.113.20", family: 4 }];
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "Range" };

test("hosted URL validation rejects unsafe and expiring destinations", () => {
  for (const value of [
    "http://cdn.example/song.mp3",
    "https://user:pass@cdn.example/song.mp3",
    "https://127.0.0.1/song.mp3",
    "https://10.0.0.2/song.mp3",
    "https://cdn.example/song.mp3?X-Amz-Signature=abc",
    "https://cdn.example/song.mp3?token=short",
  ]) assert.throws(() => validateExternalAudioURL(value));
  assert.equal(validateExternalAudioURL("https://bucket.s3.eu-central-1.amazonaws.com/music/song.mp3").protocol, "https:");
});

test("hosted verification requires HEAD, CORS, ranges and two identical complete fetches", async () => {
  const responses = [
    new Response(null, { status: 200, headers: cors }),
    new Response(mp3.slice(0, 4), { status: 206, headers: { ...cors, "content-range": `bytes 0-3/${mp3.length}` } }),
    new Response(mp3, { status: 200, headers: { ...cors, "content-length": String(mp3.length) } }),
    new Response(mp3, { status: 200, headers: { ...cors, "content-length": String(mp3.length) } }),
  ];
  const result = await verifyExternalAudio("https://cdn.example/song.mp3", {
    resolver: publicResolver,
    fetchImpl: async () => responses.shift(),
  });
  assert.equal(result.sha256, hash);
  assert.equal(result.byteCount, mp3.length);
  assert.equal(result.rangeRequests, true);
});

test("hosted verification rejects missing ranges, wrong content and hash drift", async () => {
  await assert.rejects(
    verifyExternalAudio("https://cdn.example/song.mp3", {
      resolver: publicResolver,
      fetchImpl: async (_url, init) => init.method === "HEAD"
        ? new Response(null, { status: 200, headers: cors })
        : new Response(mp3, { status: 200, headers: cors }),
    }),
    /byte-range/,
  );
  const changed = Uint8Array.from([...mp3, 9]);
  const responses = [
    new Response(null, { status: 200, headers: cors }),
    new Response(mp3, { status: 206, headers: { ...cors, "content-range": `bytes 0-7/${mp3.length}` } }),
    new Response(mp3, { status: 200, headers: cors }),
    new Response(changed, { status: 200, headers: cors }),
  ];
  await assert.rejects(
    verifyExternalAudio("https://cdn.example/song.mp3", { resolver: publicResolver, fetchImpl: async () => responses.shift() }),
    /changed between/,
  );
  const wrong = [
    new Response(null, { status: 200, headers: cors }),
    new Response(mp3, { status: 206, headers: { ...cors, "content-range": `bytes 0-7/${mp3.length}` } }),
    new Response(Uint8Array.of(1, 2, 3), { status: 200, headers: cors }),
  ];
  await assert.rejects(
    verifyExternalAudio("https://cdn.example/not-a-song", { resolver: publicResolver, fetchImpl: async () => wrong.shift() }),
    /not MP3/,
  );
});

test("hosted verification bounds HTTPS redirects", async () => {
  await assert.rejects(
    verifyExternalAudio("https://cdn.example/song.mp3", {
      resolver: publicResolver,
      maxRedirects: 2,
      fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://cdn.example/next.mp3" } }),
    }),
    /redirect limit/,
  );
});

test("external intake package contains identity evidence but no MP3 payload", async () => {
  const prepared = await createExternalIntakePackage(
    [{ title: "Нічний політ", artist: "TRENCH ORDERLY", audioURL: "https://cdn.example/song.mp3", fileName: "flight.mp3" }],
    {
      source: "https://creator.example/song",
      license: "unknown",
      artist: "TRENCH ORDERLY",
      styles: ["ФПВ", "UA"],
      collections: ["TRENCH ORDERLY", "ФПВ"],
      confirmRights: true,
    },
    { verify: async (url) => ({ url, bytes: mp3.length, sha256: hash, durationSeconds: 125, verifiedAt: "2026-09-27T00:00:00.000Z", rangeRequests: true, cors: true }) },
  );
  assert.equal(prepared.blob.size < 5000, true);
  const unpacked = await readIntakePackage(prepared.blob);
  assert.equal(unpacked.manifest.audioBytes, 0);
  assert.equal(unpacked.tracks[0].audio, undefined);
  assert.equal(unpacked.tracks[0].audioURL, "https://cdn.example/song.mp3");
});
