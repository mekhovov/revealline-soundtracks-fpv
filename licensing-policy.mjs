const LICENSES = new Map([
  ["https://creativecommons.org/publicdomain/zero/1.0/", ["CC0", "1.0"]],
  ["https://creativecommons.org/licenses/by/3.0/", ["CC-BY", "3.0"]],
  ["https://creativecommons.org/licenses/by/4.0/", ["CC-BY", "4.0"]],
  ["https://creativecommons.org/licenses/by-sa/3.0/", ["CC-BY-SA", "3.0"]],
  ["https://creativecommons.org/licenses/by-sa/4.0/", ["CC-BY-SA", "4.0"]],
]);

// An uploader assertion or an old catalogue label cannot supply a known licence.
export function hasPublishedLicense(track) {
  const identity = LICENSES.get(track?.licenseURL);
  return Boolean(
    identity && typeof track.license === "string" && track.license.trim() &&
    !/unknown|unlicensed|missing/i.test(track.license) &&
    track.rights?.licenseId === identity[0] &&
    track.rights?.licenseVersion === identity[1] &&
    track.rights?.licenseURL === track.licenseURL,
  );
}

// This is the separately selected FPV source, not the main licensed catalogue.
// Preserve the uploader assertion as UNKNOWN; never manufacture an open licence.
export function isEligibleForArchive(track) {
  return hasPublishedLicense(track) || Boolean(
    track?.license === "Unknown — uploader-confirmed rights" &&
    track.licenseURL === null && track.rights?.licenseId === "UNKNOWN" &&
    track.rights.licenseVersion === null && track.rights.licenseURL === null &&
    track.rights.permissionBasis === "uploader-confirmed-public-redistribution-and-web-playback" &&
    track.rights.shareAlike?.required === null && track.recordingModeEligible === false,
  );
}
