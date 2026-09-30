const EXPIRING_QUERY_PARAMETERS = new Set([
  "x-amz-signature",
  "x-amz-expires",
  "x-amz-credential",
  "x-amz-security-token",
  "signature",
  "expires",
  "access_token",
  "download_token",
  "token",
]);

const PRIVATE_IPV4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^22[4-9]\./,
  /^23\d\./,
  /^24\d\./,
  /^25[0-5]\./,
];

export const isPrivateAddress = (address) => {
  const normalized = String(address ?? "").toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized.includes(":"))
    return (
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb") ||
      normalized.startsWith("ff") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.")
    );
  return PRIVATE_IPV4.some((pattern) => pattern.test(normalized));
};

export function validateExternalAudioURL(value) {
  let url;
  try {
    url = new URL(String(value ?? "").trim());
  } catch {
    throw new Error("Hosted MP3 URL is invalid.");
  }
  if (url.protocol !== "https:") throw new Error("Hosted MP3 URLs must use HTTPS.");
  if (url.username || url.password)
    throw new Error("Hosted MP3 URLs cannot contain credentials.");
  if (url.hash) throw new Error("Hosted MP3 URLs cannot contain fragments.");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    isPrivateAddress(host)
  )
    throw new Error("Hosted MP3 URLs cannot use local or private-network destinations.");
  for (const key of url.searchParams.keys())
    if (EXPIRING_QUERY_PARAMETERS.has(key.toLowerCase()))
      throw new Error(`Hosted MP3 URL uses an expiring parameter: ${key}.`);
  return url;
}

export const hasMP3Signature = (bytes) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return (
    (view[0] === 0x49 && view[1] === 0x44 && view[2] === 0x33) ||
    (view[0] === 0xff && (view[1] & 0xe0) === 0xe0)
  );
};

export function verifyExternalDeliveryMetadata(audio) {
  const url = validateExternalAudioURL(audio?.path);
  if (audio?.delivery?.type !== "external-url")
    throw new Error("External recording delivery type differs.");
  if (!Number.isSafeInteger(audio.bytes) || audio.bytes <= 0)
    throw new Error("External recording byte count differs.");
  if (!/^[a-f0-9]{64}$/.test(audio.sha256 ?? ""))
    throw new Error("External recording SHA-256 differs.");
  if (
    audio.delivery.rangeRequests !== true ||
    audio.delivery.cors !== true ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(
      audio.delivery.verifiedAt ?? "",
    )
  )
    throw new Error("External recording verification evidence differs.");
  return url;
}
