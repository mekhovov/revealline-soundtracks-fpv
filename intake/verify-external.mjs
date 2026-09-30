import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isEligibleForArchive } from "../licensing-policy.mjs";
import {
  hasMP3Signature,
  isPrivateAddress,
  validateExternalAudioURL,
} from "./external-url.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const MAX_BYTES = 100_000_000;
const ORIGIN = "https://mekhovov.github.io";
const demand = (value, message) => {
  if (!value) throw new Error(message);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function assertPublicHost(url, resolver = lookup) {
  const addresses = await resolver(url.hostname, { all: true, verbatim: true });
  demand(addresses.length > 0, `Hosted MP3 host did not resolve: ${url.hostname}`);
  demand(
    addresses.every(({ address }) => !isPrivateAddress(address)),
    `Hosted MP3 host resolves to a private network: ${url.hostname}`,
  );
}

async function fetchStable(
  start,
  init,
  { fetchImpl = fetch, resolver = lookup, maxRedirects = 5 } = {},
) {
  let url = validateExternalAudioURL(start);
  for (let redirects = 0; ; redirects += 1) {
    demand(redirects <= maxRedirects, "Hosted MP3 exceeded the redirect limit.");
    await assertPublicHost(url, resolver);
    const response = await fetchImpl(url, {
      ...init,
      redirect: "manual",
      headers: { Origin: ORIGIN, ...(init.headers ?? {}) },
    });
    if (![301, 302, 303, 307, 308].includes(response.status))
      return { response, url };
    const location = response.headers.get("location");
    demand(location, "Hosted MP3 redirect omitted its destination.");
    url = validateExternalAudioURL(new URL(location, url).href);
  }
}

function assertCORS(response) {
  const origin = response.headers.get("access-control-allow-origin");
  demand(origin === "*" || origin === ORIGIN, "Hosted MP3 does not permit browser CORS access.");
}

async function completeBytes(response) {
  demand(response.ok, `Hosted MP3 returned HTTP ${response.status}.`);
  const declaredHeader = response.headers.get("content-length");
  const declared = declaredHeader === null ? null : Number(declaredHeader);
  demand(declared === null || (Number.isSafeInteger(declared) && declared <= MAX_BYTES), "Hosted MP3 exceeds 100 MB.");
  const reader = response.body?.getReader?.();
  demand(reader, "Hosted MP3 response cannot be read safely.");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      demand(value instanceof Uint8Array, "Hosted MP3 response is invalid.");
      size += value.byteLength;
      if (size > MAX_BYTES) {
        try {
          await reader.cancel("Hosted MP3 exceeds 100 MB.");
        } catch {}
        throw new Error("Hosted MP3 exceeds 100 MB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  demand(declared === null || declared === size, "Hosted MP3 response is truncated.");
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
  demand(bytes.length > 0 && bytes.length <= MAX_BYTES, "Hosted MP3 byte count is invalid.");
  demand(hasMP3Signature(bytes), "Hosted file is not MP3 audio by content inspection.");
  return bytes;
}

export async function verifyExternalAudio(
  input,
  { fetchImpl = fetch, resolver = lookup, maxRedirects = 5 } = {},
) {
  const start = validateExternalAudioURL(input);
  const dependencies = { fetchImpl, resolver, maxRedirects };
  const head = await fetchStable(start, { method: "HEAD" }, dependencies);
  demand(head.response.ok, `Hosted MP3 HEAD returned HTTP ${head.response.status}.`);
  assertCORS(head.response);
  const ranged = await fetchStable(
    head.url,
    { method: "GET", headers: { Range: "bytes=0-1023" } },
    dependencies,
  );
  demand(ranged.response.status === 206, "Hosted MP3 does not support byte-range requests.");
  demand(/^bytes 0-\d+\/\d+$/.test(ranged.response.headers.get("content-range") ?? ""), "Hosted MP3 range response is invalid.");
  // A successful 206 carrying Access-Control-Allow-Origin proves that this
  // concrete Range request is browser-readable. Access-Control-Allow-Headers
  // belongs to a preflight response and is not required on the GET itself.
  assertCORS(ranged.response);
  const first = await fetchStable(head.url, { method: "GET" }, dependencies);
  assertCORS(first.response);
  const firstBytes = await completeBytes(first.response);
  const second = await fetchStable(first.url, { method: "GET" }, dependencies);
  assertCORS(second.response);
  const secondBytes = await completeBytes(second.response);
  demand(firstBytes.length === secondBytes.length && sha256(firstBytes) === sha256(secondBytes), "Hosted MP3 changed between verification fetches.");
  return {
    url: second.url.href,
    host: second.url.host,
    bytes: firstBytes,
    byteCount: firstBytes.length,
    sha256: sha256(firstBytes),
    verifiedAt: new Date().toISOString(),
    rangeRequests: true,
    cors: true,
  };
}

export async function auditExternalInventory(
  base = root,
  dependencies = {},
) {
  const inventory = JSON.parse(await readFile(path.join(base, "external-deliveries.json"), "utf8"));
  demand(inventory.format === "revealline-external-audio-deliveries.v1", "External delivery inventory format differs.");
  const catalogue = JSON.parse(await readFile(path.join(base, "catalogue.json"), "utf8"));
  const allowed = new Set(catalogue.tracks.filter(isEligibleForArchive).map((track) => track.id));
  const recordings = inventory.recordings.filter((entry) => allowed.has(entry.id));
  for (const entry of recordings) {
    const result = await verifyExternalAudio(entry.url, dependencies);
    demand(result.byteCount === entry.bytes, `External byte count drifted: ${entry.id}`);
    demand(result.sha256 === entry.sha256, `External SHA-256 drifted: ${entry.id}`);
  }
  return { recordings: recordings.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await auditExternalInventory(), null, 2));
