import { bindPackageInvalidation, createPackageGeneration, createExternalIntakePackage, createIntakePackage } from "./intake/package.mjs";
import { hasMP3Signature, validateExternalAudioURL } from "./intake/external-url.mjs";

const form = document.querySelector("#browser-intake-form");
const files = document.querySelector("#intake-files");
const folder = document.querySelector("#intake-folder");
const fileSource = document.querySelector("#intake-file-source");
const urlSource = document.querySelector("#intake-url-source");
const urlRows = document.querySelector("#intake-url-rows");
const addURL = document.querySelector("#intake-add-url");
const status = document.querySelector("#intake-status");
const download = document.querySelector("#intake-download");
let preparedURL = null;
let activeGeneration = null;
const generation = createPackageGeneration();

const discardPrepared = ({ announce = false } = {}) => {
  if (preparedURL) URL.revokeObjectURL(preparedURL);
  preparedURL = null;
  download.hidden = true;
  download.removeAttribute("href");
  if (announce) status.textContent = "Inputs changed. Verify again to create a package with the current audio and rights.";
};

bindPackageInvalidation(form, () => {
  generation.invalidate();
  discardPrepared({ announce: true });
});

const selectedFiles = () => {
  const picked = [...files.files];
  const nested = [...folder.files];
  if (picked.length && nested.length) throw new Error("Choose MP3 files or a folder, not both.");
  return nested.length ? nested : picked;
};

function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const audio = document.createElement("audio");
    const url = URL.createObjectURL(file);
    const done = (result, error) => {
      audio.removeAttribute("src");
      audio.load();
      URL.revokeObjectURL(url);
      if (error) reject(error);
      else resolve(result);
    };
    audio.preload = "metadata";
    audio.onloadedmetadata = () => done(audio.duration);
    audio.onerror = () => done(null, new Error(`The browser could not decode ${file.name}.`));
    audio.src = url;
  });
}

const hex = (bytes) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");

async function verifyHostedMP3(value, fileName = "hosted.mp3") {
  const requested = validateExternalAudioURL(value);
  const options = { mode: "cors", cache: "no-store", credentials: "omit" };
  const head = await fetch(requested, { ...options, method: "HEAD" });
  if (!head.ok) throw new Error(`Hosted MP3 HEAD returned HTTP ${head.status}.`);
  const stable = validateExternalAudioURL(head.url || requested.href);
  const ranged = await fetch(stable, { ...options, headers: { Range: "bytes=0-1023" } });
  if (ranged.status !== 206) throw new Error("Hosted MP3 must support byte-range requests (HTTP 206).");
  if (validateExternalAudioURL(ranged.url || stable.href).href !== stable.href)
    throw new Error("Hosted MP3 redirects after its stable URL is resolved.");
  const readBounded = async (response) => {
    const reader = response.body?.getReader?.();
    if (!reader) throw new Error("Hosted MP3 response cannot be read safely.");
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.byteLength;
        if (size > 100_000_000) {
          try { await reader.cancel("Hosted MP3 exceeds 100 MB."); } catch {}
          throw new Error("Hosted MP3 exceeds 100 MB.");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  };
  const load = async () => {
    const response = await fetch(stable, options);
    if (!response.ok) throw new Error(`Hosted MP3 returned HTTP ${response.status}.`);
    if (validateExternalAudioURL(response.url || stable.href).href !== stable.href)
      throw new Error("Hosted MP3 redirects after its stable URL is resolved.");
    const bytes = await readBounded(response);
    if (!bytes.length || bytes.length > 100_000_000) throw new Error("Hosted MP3 byte count is invalid.");
    if (!hasMP3Signature(bytes)) throw new Error("Hosted file is not MP3 audio by content inspection.");
    return { bytes, finalURL: stable.href };
  };
  const first = await load();
  const second = await load();
  const firstHash = hex(await crypto.subtle.digest("SHA-256", first.bytes));
  const secondHash = hex(await crypto.subtle.digest("SHA-256", second.bytes));
  if (first.bytes.length !== second.bytes.length || firstHash !== secondHash) throw new Error("Hosted MP3 changed between verification fetches.");
  const durationSeconds = await probeDuration(new File([first.bytes], fileName, { type: "audio/mpeg" }));
  return { url: first.finalURL, bytes: first.bytes.length, sha256: firstHash, durationSeconds, verifiedAt: new Date().toISOString(), rangeRequests: true, cors: true };
}

function addHostedRow(values = {}) {
  const row = document.createElement("div");
  row.className = "hosted-url-row";
  row.innerHTML = `<label>Song title <input data-field="title" maxlength="160" required></label>
    <label>Artist <input data-field="artist" maxlength="160"></label>
    <label>Public MP3 URL <input data-field="audioURL" type="url" maxlength="2048" placeholder="https://bucket.s3.region.amazonaws.com/music/song.mp3" required></label>
    <label>Original filename <input data-field="fileName" maxlength="255" placeholder="song.mp3"></label>
    <button type="button" data-remove>Remove URL</button>`;
  for (const [name, entry] of Object.entries(values)) {
    const input = row.querySelector(`[data-field="${name}"]`);
    if (input) input.value = entry;
  }
  row.querySelector("[data-remove]").addEventListener("click", () => {
    if (urlRows.children.length > 1) row.remove();
  });
  urlRows.append(row);
}

addHostedRow();
addURL.addEventListener("click", () => addHostedRow());

function setSourceMode() {
  const mode = form.elements.namedItem("intakeSource").value;
  fileSource.hidden = mode !== "files";
  urlSource.hidden = mode !== "urls";
  for (const input of fileSource.querySelectorAll("input")) input.disabled = mode !== "files";
  for (const input of urlSource.querySelectorAll("input")) input.disabled = mode !== "urls";
}
for (const input of form.querySelectorAll('[name="intakeSource"]')) input.addEventListener("change", setSourceMode);
setSourceMode();

const value = (name) => form.elements.namedItem(name)?.value ?? "";
const metadata = () => ({
  source: value("source"), license: value("license"), artist: value("artist"),
  styles: value("styles").split(","), collections: value("collections").split(","),
  batchId: value("batchId"), batchTitle: value("batchTitle"), description: value("description"),
  attribution: value("attribution"), rightsEvidence: value("rightsEvidence"),
  derivativeNotice: value("derivativeNotice"), confirmRights: form.elements.namedItem("confirmRights").checked,
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = generation.begin();
  activeGeneration = token;
  discardPrepared();
  status.textContent = "Checking MP3 delivery, duration, rights and SHA-256 hashes…";
  form.querySelector("button[type=submit]").disabled = true;
  try {
    const mode = form.elements.namedItem("intakeSource").value;
    const rows = [...urlRows.children].map((row) => Object.fromEntries([...row.querySelectorAll("[data-field]")].map((input) => [input.dataset.field, input.value])));
    const prepared = mode === "urls"
      ? await createExternalIntakePackage(rows, metadata(), {
          verify: (url) => {
            const row = rows.find((candidate) => validateExternalAudioURL(candidate.audioURL).href === url);
            return verifyHostedMP3(url, row?.fileName || "hosted.mp3");
          },
          isCurrent: () => generation.isCurrent(token),
        })
      : await createIntakePackage(selectedFiles(), metadata(), { probe: probeDuration, isCurrent: () => generation.isCurrent(token) });
    if (!generation.isCurrent(token)) return;
    preparedURL = URL.createObjectURL(prepared.blob);
    download.href = preparedURL;
    download.download = `${prepared.manifest.metadata.batchId || "revealline-soundtrack-intake"}.rlintake`;
    download.hidden = false;
    status.textContent = `${prepared.manifest.tracks.length} recording${prepared.manifest.tracks.length === 1 ? "" : "s"} verified. ${prepared.manifest.metadata.license === "unknown" ? "Separate FPV publication: the unknown licence label is retained and does not grant reuse rights. Keep the original files. " : ""}Download the metadata package and open its archive PR.`;
    download.focus();
  } catch (error) {
    if (generation.isCurrent(token)) status.textContent = error.message;
  } finally {
    if (activeGeneration === token) {
      activeGeneration = null;
      form.querySelector("button[type=submit]").disabled = false;
    }
  }
});

window.addEventListener("pagehide", () => discardPrepared());
