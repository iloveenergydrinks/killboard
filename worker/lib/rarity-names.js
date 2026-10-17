"use strict";

// The Advanced rarity was renamed Augmented. Replays scanned before the rename, or with a
// historical runtime, still name it Advanced, so rarities read from reports and stored facts
// resolve through here.
const RARITY_RENAMES = Object.freeze({ Advanced: "Augmented" });

function rarityName(value, fallback = "") {
  const name = String(value ?? fallback);
  return RARITY_RENAMES[name] ?? name;
}

/** Every name a stored fact may use for this rarity: its current name and any it replaced. */
function storedRarityNames(name) {
  return [name, ...Object.keys(RARITY_RENAMES).filter((old) => RARITY_RENAMES[old] === name)];
}

// JSON.parse walks nested stored facts; translate rarity fields without renaming item labels.
function rarityReviver(key, value) {
  if ((key === "rarity" || key === "Rarity") && typeof value === "string")
    return rarityName(value);
  if (key !== "spendByRarity") return value;
  const spending = {};
  for (const [name, amount] of Object.entries(value)) {
    const current = rarityName(name);
    spending[current] = (spending[current] ?? 0) + amount;
  }
  return spending;
}

module.exports = { rarityName, storedRarityNames, rarityReviver };
