export const STYLE_GROUPS = Object.freeze([
  Object.freeze({ id: "synth", label: "Synth" }),
  Object.freeze({ id: "metal", label: "Metal" }),
  Object.freeze({ id: "chiptune", label: "Chiptune & 8-bit" }),
  Object.freeze({ id: "rock", label: "Rock" }),
  Object.freeze({ id: "electronic", label: "Electronic" }),
  Object.freeze({ id: "ambient", label: "Ambient" }),
  Object.freeze({ id: "fusion", label: "Fusion" }),
  Object.freeze({ id: "other", label: "Other" }),
  Object.freeze({ id: "ukrainian", label: "Ukrainian · UA" }),
  Object.freeze({ id: "fpv", label: "ФПВ" }),
]);

const match = (tags, expression) => tags.some((tag) => expression.test(tag));

export function canonicalStyles(tags = []) {
  const normalized = tags
    .map((tag) => String(tag).trim().toLocaleLowerCase())
    .filter(Boolean);
  const styles = [];
  const add = (id, condition) => {
    if (condition) styles.push(id);
  };

  // These are broad player-facing families. More specific source tags remain
  // searchable metadata and do not expand the primary selector indefinitely.
  add(
    "synth",
    match(
      normalized,
      /(?:^|[-\s])(synth(?:wave|pop|90s)?|retrowave|outrun|dreamwave)(?:$|[-\s])/,
    ),
  );
  add("metal", match(normalized, /(?:^|[-\s])metal(?:$|[-\s])/));
  add(
    "electronic",
    match(
      normalized,
      /(?:^|[-\s])(electronic|electro|edm|techno|house|trance|dance|breakbeat)(?:$|[-\s])/,
    ),
  );
  add(
    "chiptune",
    match(
      normalized,
      /(?:^|[-\s])(chiptune|8-bit|fakebit|tracker|fm)(?:$|[-\s])/,
    ),
  );
  add("rock", match(normalized, /(?:^|[-\s])(rock|punk)(?:$|[-\s])/));
  add(
    "ambient",
    match(
      normalized,
      /(?:^|[-\s])(ambient|atmospheric|atmosphere|chill|chillout)(?:$|[-\s])/,
    ),
  );
  add(
    "ukrainian",
    normalized.some((tag) => tag === "ua" || /ukrain/.test(tag)),
  );
  // Latin “FPV” is intentionally not an alias. Only recordings explicitly
  // curated with the Ukrainian Cyrillic tag belong to this style.
  add("fpv", normalized.includes("фпв"));

  const musicalFamilies = styles.filter(
    (id) => !["ukrainian", "fpv"].includes(id),
  );
  add("fusion", normalized.includes("fusion") || musicalFamilies.length > 1);
  if (!styles.length) styles.push("other");
  return [...new Set(styles)];
}

export function styleForTag(tag) {
  return canonicalStyles([tag]).find((style) => style !== "other") ?? null;
}
