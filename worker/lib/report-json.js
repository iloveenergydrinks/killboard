"use strict";

// Older scanners reflected ItemId's signed 64-bit authority halves as JSON numbers, which JS
// rounds. Quote their exact digits before parsing; ulong sequences are already strings.
const IDENTITY_NUMBER =
  /([{,]\s*"(?:authorityHigh|authorityLow|sequence)"\s*:\s*)(-?\d{16,})(?=\s*[,}])/g;
// ItemId, JobId and InventoryId share one authority format and differ only in their kind letter.
const CANONICAL_IDENTITY = /^[ijv][0-9a-f]{48}$/;
const INTEGER_TEXT = /^-?\d+$/;

/** Reads a report for analysis; unsafe identity halves become their exact decimal strings. */
function parseReport(text) {
  const source = typeof text === "string" ? text : text.toString("utf8");
  return JSON.parse(
    source.replace(IDENTITY_NUMBER, (match, prefix, digits) =>
      Number.isSafeInteger(Number(digits)) ? match : `${prefix}"${digits}"`,
    ),
  );
}

/** Reads a report that will be written back: every integer keeps its recorded digits. */
function parseReportExact(text) {
  return JSON.parse(String(text), (_key, value, context) =>
    typeof value === "number" &&
    !Number.isSafeInteger(value) &&
    INTEGER_TEXT.test(context.source)
      ? JSON.rawJSON(context.source)
      : value,
  );
}

// Before 2026-10, the dashboard re-saved reports through JSON.parse/stringify, which rounded
// these halves on disk. A rounded value is exactly a double; a recorded random int64 almost never is.
function roundedOnDisk(field) {
  if (typeof field === "number") return !Number.isSafeInteger(field);
  const text = String(field);
  return INTEGER_TEXT.test(text) && !Number.isSafeInteger(Number(text)) && String(Number(text)) === text;
}

function isIdentityObject(value) {
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "authorityHigh" in value &&
    "authorityLow" in value &&
    "sequence" in value
  );
}

/**
 * The canonical `<kind><high><low><sequence>` text ItemId/JobId/InventoryId.ToString() writes,
 * or, for halves already rounded on disk, a `~<kind><sequence>:<high>:<low>` key that
 * `identityResolver` can map back.
 */
function itemIdentity(value, kind = "i") {
  if (value == null || value === "" || value === 0) return "";
  if (typeof value !== "object")
    return typeof value === "number" && !Number.isSafeInteger(value) ? "" : String(value);
  if (!isIdentityObject(value)) return "";
  const fields = [value.authorityHigh, value.authorityLow, value.sequence];
  try {
    const [high, low, sequence] = fields.map((field) => BigInt(field));
    if (!sequence || (!high && !low)) return "";
    if (fields.some(roundedOnDisk))
      return `~${kind}${BigInt.asUintN(64, sequence)}:${Number(high)}:${Number(low)}`;
    return (
      kind +
      [high, low, sequence]
        .map((field) => BigInt.asUintN(64, field).toString(16).padStart(16, "0"))
        .join("")
    );
  } catch {
    return "";
  }
}

/** The rounded key an exact canonical identity would have produced. */
function roundedIdentity(itemId) {
  if (!CANONICAL_IDENTITY.test(itemId)) return null;
  const [high, low, sequence] = [1, 17, 33].map((at) => BigInt(`0x${itemId.slice(at, at + 16)}`));
  return `~${itemId[0]}${sequence}:${Number(BigInt.asIntN(64, high))}:${Number(BigInt.asIntN(64, low))}`;
}

/**
 * Maps rounded keys to the exact identity observed elsewhere with the same sequence and the same
 * rounded halves. Ambiguous keys stay unresolved.
 */
function identityResolver(exactIds) {
  const matches = new Map();
  for (const itemId of exactIds) {
    const key = roundedIdentity(itemId);
    if (!key) continue;
    const known = matches.get(key);
    matches.set(key, known === undefined || known === itemId ? itemId : null);
  }
  return (itemId) => (itemId.startsWith("~") ? (matches.get(itemId) ?? itemId) : itemId);
}

/** A resolver over every exact identity a report's text records anywhere. */
function reportIdentityResolver(text) {
  return identityResolver(
    new Set(String(text).match(/(?<=")[ijv][0-9a-f]{48}(?=")/g) ?? []),
  );
}

// Reflected identities carry no kind; their field names do.
function identityKind(key) {
  if (/jobids?$/i.test(key)) return "j";
  if (/inventoryids?$/i.test(key)) return "v";
  return "i";
}

/** Replaces each reflected identity value with its identity text, so SQL can join on it. */
function canonicalIdentities(value, resolve = (itemId) => itemId, key = "") {
  if (Array.isArray(value)) return value.map((field) => canonicalIdentities(field, resolve, key));
  if (value == null || typeof value !== "object") return value;
  if (isIdentityObject(value)) return resolve(itemIdentity(value, identityKind(key)));
  return Object.fromEntries(
    Object.entries(value).map(([name, field]) => [name, canonicalIdentities(field, resolve, name)]),
  );
}

module.exports = {
  parseReport,
  parseReportExact,
  itemIdentity,
  roundedIdentity,
  identityResolver,
  reportIdentityResolver,
  canonicalIdentities,
};
