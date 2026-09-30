import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { ARCHIVE } from "../archive-config.mjs";
import { verifyArchive } from "../verify.mjs";
import { promoteAudioVolume } from "./audio-volume.mjs";

if (!process.env.GH_TOKEN) throw new Error("GH_TOKEN is required.");
await verifyArchive();
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn("gh", args, { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", error = "";
  child.stdout.on("data", (part) => output += part);
  child.stderr.on("data", (part) => error += part);
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`gh failed (${code}): ${error.trim()}`)));
});
const manifest = JSON.parse(await readFile(new URL("../audio-volumes.json", import.meta.url)));
for (const volume of manifest.volumes)
  console.log(`${await promoteAudioVolume(volume, { repo: ARCHIVE.repository, run })}: ${volume.releaseTag}`);
