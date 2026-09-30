import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ARCHIVE } from "../archive-config.mjs";
import { verifyArchive } from "../verify.mjs";

const demand = (ok, message) => { if (!ok) throw new Error(message); };
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const ORIGIN = "https://revealline-public-verification.invalid";
const root = fileURLToPath(new URL("..", import.meta.url));

async function requestPublic(url, { request, range = false }) {
  const target = new URL(url);
  demand(target.href.startsWith(ARCHIVE.baseURL) && target.protocol === "https:" &&
    !target.username && !target.password && !target.search && !target.hash,
    "Public verification URL left the exact FPV Pages base.");
  const response = await request(target.href, {
    method: "GET", credentials: "omit", redirect: "error", cache: "no-store",
    signal: AbortSignal.timeout(30000),
    headers: { Origin: ORIGIN, "Accept-Encoding": "identity", ...(range ? { Range: "bytes=0-15" } : {}) },
  });
  if (response.headers.get("access-control-allow-origin") !== "*") {
    await response.body?.cancel();
    throw new Error(`Public CORS is missing: ${target.pathname}`);
  }
  return response;
}

async function consume(response, expectedBytes) {
  const reader = response.body?.getReader(); demand(reader, "Public response has no body.");
  const hash = createHash("sha256"); let bytes = 0; let prefix = Buffer.alloc(0);
  try {
    const length = response.headers.get("content-length");
    demand(length === null || Number(length) === expectedBytes, "Public Content-Length differs.");
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length;
      demand(bytes <= expectedBytes, "Public response exceeded its pinned size.");
      hash.update(value);
      if (prefix.length < 16) prefix = Buffer.concat([prefix, Buffer.from(value).subarray(0, 16 - prefix.length)]);
    }
    demand(bytes === expectedBytes, "Public response is truncated.");
    return { bytes, sha256: hash.digest("hex"), prefix };
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function verifyPublicObject(entry, { request = fetch, range = false } = {}) {
  demand(typeof entry.path === "string" && /^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/.test(entry.path) &&
    !entry.path.split("/").some((part) => part === "..") && Number.isSafeInteger(entry.bytes) &&
    entry.bytes > 0 && entry.bytes <= 100000000 && /^[a-f0-9]{64}$/.test(entry.sha256),
    "Public object identity is invalid.");
  const url = new URL(entry.path, ARCHIVE.baseURL).href;
  const response = await requestPublic(url, { request });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`Public response returned HTTP ${response.status}: ${entry.path}`);
  }
  const actual = await consume(response, entry.bytes);
  demand(actual.sha256 === entry.sha256, `Public SHA-256 differs: ${entry.path}`);
  if (range) {
    demand(entry.bytes >= 16, "Public audio is too short for range verification.");
    const ranged = await requestPublic(url, { request, range: true });
    if (ranged.status !== 206 || ranged.headers.get("content-range") !== `bytes 0-15/${entry.bytes}`) {
      await ranged.body?.cancel();
      throw new Error(`Public byte-range response differs: ${entry.path}`);
    }
    const rangeBytes = await consume(ranged, 16);
    demand(rangeBytes.prefix.equals(actual.prefix), `Public byte-range content differs: ${entry.path}`);
  }
  return { path: entry.path, bytes: actual.bytes, sha256: actual.sha256, cors: true, rangeRequests: range };
}

export async function verifyPublicArchive({ base = root, request = fetch,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  metadataAttempts = 6 } = {}) {
  demand(Number.isInteger(metadataAttempts) && metadataAttempts >= 1 && metadataAttempts <= 6,
    "Metadata retry bound differs.");
  await verifyArchive(base);
  const metadata = await Promise.all(["catalogue.json", "deployment-manifest.json", "migration-inventory.json"].map(async (name) => {
    const bytes = await readFile(path.join(base, name));
    return { path: name, bytes: bytes.length, sha256: digest(bytes) };
  }));
  let metadataReceipts;
  for (let attempt = 1; attempt <= metadataAttempts; attempt += 1) {
    try {
      metadataReceipts = [];
      for (const entry of metadata) metadataReceipts.push(await verifyPublicObject(entry, { request }));
      break;
    } catch (error) {
      if (attempt === metadataAttempts) throw error;
      await wait(10000);
    }
  }
  const inventory = JSON.parse(await readFile(path.join(base, "migration-inventory.json")));
  const recordings = [];
  for (const member of inventory.recordings) recordings.push({ id: member.id,
    ...await verifyPublicObject({ path: member.destinationPath, bytes: member.bytes, sha256: member.sha256 }, { request, range: true }) });
  return { format: "revealline-fpv-public-verification.v1", verifiedAt: new Date().toISOString(),
    sourceRevision: process.env.GITHUB_SHA ?? null, baseURL: ARCHIVE.baseURL,
    metadata: metadataReceipts, recordings, count: recordings.length,
    bytes: recordings.reduce((sum, entry) => sum + entry.bytes, 0) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await verifyPublicArchive(), null, 2));
