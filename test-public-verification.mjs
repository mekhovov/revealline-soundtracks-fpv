import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ARCHIVE } from "./archive-config.mjs";
import { verifyPublicArchive, verifyPublicObject } from "./intake/verify-public.mjs";

const bytes = Buffer.from("ID3 exact bounded public audio fixture");
const entry = { path: "objects/test.mp3", bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex") };
function publicRequest({ body = bytes, cors = "*", rangeCors = "*", status = 200,
  rangeStatus = 206, rangeTotal = bytes.length, rangeBody = bytes.subarray(0, 16), length = null } = {}) {
  return async (url, init) => {
    assert.equal(url, `${ARCHIVE.baseURL}${entry.path}`);
    assert.equal(init.credentials, "omit"); assert.equal(init.redirect, "error");
    assert.equal(init.headers.Authorization, undefined); assert.equal(init.method, "GET");
    assert.equal(init.headers["Accept-Encoding"], "identity");
    assert.ok(init.signal instanceof AbortSignal);
    const range = Boolean(init.headers.Range);
    return new Response(range ? rangeBody : body, { status: range ? rangeStatus : status,
      headers: { ...(range ? { "Content-Range": `bytes 0-15/${rangeTotal}` } : {}),
        ...((range ? rangeCors : cors) ? { "Access-Control-Allow-Origin": range ? rangeCors : cors } : {}),
        ...(length === null ? {} : { "Content-Length": String(length) }) } });
  };
}

test("public acceptance hashes streamed bytes and verifies exact ranged content plus public CORS", async () => {
  assert.deepEqual(await verifyPublicObject(entry, { request: publicRequest(), range: true }),
    { ...entry, cors: true, rangeRequests: true });
});

test("public acceptance rejects drift, truncation, excess bytes, bad size, CORS and missing range", async () => {
  for (const [options, message] of [
    [{ body: Buffer.alloc(bytes.length) }, /SHA-256/],
    [{ body: bytes.subarray(1) }, /truncated/],
    [{ body: Buffer.concat([bytes, bytes]) }, /exceeded/],
    [{ length: bytes.length + 1 }, /Content-Length/],
    [{ cors: null }, /CORS/], [{ rangeCors: null }, /CORS/],
    [{ status: 404 }, /HTTP 404/], [{ rangeStatus: 200 }, /byte-range response/],
    [{ rangeTotal: bytes.length + 1 }, /byte-range response/],
    [{ rangeBody: Buffer.alloc(16) }, /byte-range content/],
  ]) await assert.rejects(verifyPublicObject(entry, { request: publicRequest(options), range: true }), message);
});

test("public acceptance rejects traversal before fetching and surfaces request timeouts", async () => {
  let fetched = false;
  await assert.rejects(verifyPublicObject({ ...entry, path: "../catalogue.json" }, {
    request: () => { fetched = true; },
  }), /identity/);
  assert.equal(fetched, false);
  await assert.rejects(verifyPublicObject(entry, { request: async () => { throw new DOMException("Timed out", "TimeoutError"); } }), /Timed out/);
});

test("public catalogue drift fails before audio and metadata propagation retries stay bounded", async () => {
  let requests = 0; let waits = 0;
  const catalogue = await readFile("catalogue.json");
  await assert.rejects(verifyPublicArchive({ metadataAttempts: 2,
    wait: async (milliseconds) => { assert.equal(milliseconds, 10000); waits += 1; },
    request: async (url) => {
      assert.equal(url, `${ARCHIVE.baseURL}catalogue.json`); requests += 1;
      return new Response(Buffer.alloc(catalogue.length), { headers: { "Access-Control-Allow-Origin": "*" } });
    },
  }), /SHA-256/);
  assert.equal(requests, 2); assert.equal(waits, 1);
});

test("public acceptance runs read-only only after successful main deployment", async () => {
  const workflow = await readFile(".github/workflows/pages.yml", "utf8");
  const acceptance = workflow.split("  public-acceptance:")[1];
  assert.ok(acceptance);
  assert.match(acceptance, /needs: deploy/);
  assert.match(acceptance, /github.ref == 'refs\/heads\/main'/);
  assert.match(acceptance, /contents: read/);
  assert.doesNotMatch(acceptance, /GH_TOKEN|contents: write|pages: write|id-token: write/);
  assert.match(acceptance, /node intake\/verify-public.mjs/);
});
