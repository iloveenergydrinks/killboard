"use strict";

// The game's definition ids as the killboard stores them: the decimal string of the asset GUID,
// the form the game data API uses for `def` and NPC `id` (https://api.thecitadel.com/v1/items).

/**
 * The decimal id of a manifest asset reference ({ guid: "[13B920561A65891E]", name }), or null for
 * a missing, empty or malformed one. The scanner writes a Quantum AssetGuid as 16 hex digits in
 * brackets.
 */
// Quantum clears the top bit of an asset GUID, so a definition id is never negative (db.json holds
// none either); a negative or malformed value is read as no id.
function definitionId(reference) {
  const hex = String(reference?.guid ?? "").match(/^\[?([0-9a-f]{1,16})\]?$/i)?.[1];
  if (!hex) return null;
  const value = BigInt(`0x${hex}`);
  return value === 0n ? null : value.toString();
}

module.exports = { definitionId };
