import { createHash } from "node:crypto";
const demand = (ok, message) => { if (!ok) throw new Error(message); };
const assertAudioBytes = (bytes, member) => demand(bytes.length === member.bytes && createHash("sha256").update(bytes).digest("hex") === member.sha256, "Audio byte count or SHA-256 differs.");
const HOSTS = new Set(["github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]);
async function githubFetch(input, init, request) {
  let url = new URL(input);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    demand(url.protocol === "https:" && !url.username && !url.password && HOSTS.has(url.hostname), "Audio redirect left the permitted GitHub HTTPS hosts.");
    const response = await request(url.href, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    demand(location, "Audio redirect omitted Location.");
    await response.body?.cancel();
    url = new URL(location, url);
  }
  throw new Error("Audio redirect limit exceeded.");
}

export async function downloadExactGitHubAudio(url, member, { request = fetch } = {}) {
  demand(/^[a-f0-9]{64}$/.test(member.sha256) && Number.isSafeInteger(member.bytes) && member.bytes > 16 && member.bytes <= 100000000, "Audio bounds differ.");
  const range = await githubFetch(url, { headers: { Range: "bytes=0-15" } }, request);
  demand(range.status === 206 && range.headers.get("content-range") === `bytes 0-15/${member.bytes}`,
    "Source asset does not provide the expected byte range.");
  await range.body?.cancel();
  const response = await githubFetch(url, {}, request);
  demand(response.ok, `Source audio returned HTTP ${response.status}.`);
  const length = response.headers.get("content-length");
  demand(length === null || Number(length) === member.bytes, "Source Content-Length differs.");
  const reader = response.body?.getReader(); demand(reader, "Source audio body is missing.");
  let total = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.length;
      if (total > member.bytes) { await reader.cancel(); throw new Error("Source audio exceeded its pinned byte count."); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, total); assertAudioBytes(bytes, member); return bytes;
}
