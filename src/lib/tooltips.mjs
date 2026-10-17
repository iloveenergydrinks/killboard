// A kill card module's tooltip, in the game's item tooltip shape (CurrentItemTooltip's
// TooltipState: Header and Rows), from what the kill recorded about it. Modifiers read the way
// the game words them (ItemModifierText.Row), with the stat copy and display rules the game data
// API serves at /v1/stats.

import { rarityName } from "./art.mjs";

/** DisplayNumberText.FormatNumber: whole numbers from 100 up, one decimal below. */
export function formatNumber(value) {
  const rounded =
    Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return Math.abs(value) >= 100
    ? rounded.toLocaleString("en-US")
    : String(rounded);
}

export function formatSignedNumber(value) {
  const text = formatNumber(value);
  return value > 0 ? `+${text}` : text;
}

/**
 * `stats` is the game data API's /v1/stats list: each stat's label, whether it reads as a whole
 * number, whether lower is better, and whether a multiplier shows with its sign inverted (a faster
 * fire rate is a lower cycle duration).
 */
export function createTooltips(stats) {
  const byId = new Map(stats.map((stat) => [stat.id, stat]));
  // A stat newer than the data (or an API that could not be reached) shows its own name.
  const label = (stat) => byId.get(stat)?.label ?? String(stat);
  const inverts = (stat, operation) =>
    operation === "Multiply" && byId.get(stat)?.invertedSign === true;
  const isInteger = (stat) => byId.get(stat)?.integer === true;
  const lowerIsBetter = (stat) => byId.get(stat)?.lowerIsBetter === true;

  /** ItemModifierText.Row: the signed value, percent for a multiplier or a resistance, and its tone. */
  function modifierRow(modifier) {
    const { stat, operation, value } = modifier;
    const magnitude = operation === "Multiply" ? value - 1 : value;
    let shown;
    if (operation === "Multiply")
      shown = (inverts(stat, operation) ? 1 - value : value - 1) * 100;
    else if (operation === "DamageReduction") shown = value * 100;
    else shown = isInteger(stat) ? Math.round(value) : value;
    let text = formatSignedNumber(shown);
    if (operation === "Multiply" || operation === "DamageReduction")
      text += "%";
    const higherIsBetter = !lowerIsBetter(stat);
    const tone =
      magnitude === 0
        ? "Neutral"
        : magnitude > 0 === higherIsBetter
          ? "Positive"
          : "Negative";
    return {
      Label: label(stat),
      Value: text,
      Tone: tone,
      ...(modifier.tier > 0 ? { Badge: `T${modifier.tier}` } : {}),
      ...(modifier.isFractured ? { Accent: "Harmonic" } : {}),
    };
  }

  /** The tooltip of one grid item of a kill card. */
  function item(source) {
    const facts = source.facts ?? null;
    const rarity = rarityName(source.rarity ?? "Normal");
    const type =
      source.slotType && source.slotType !== "None"
        ? source.slotType
        : source.category;
    const header = {
      Name: String(source.name ?? "").toUpperCase(),
      Type: String(type ?? "").toUpperCase(),
      Tier: rarity.toUpperCase(),
      TierAccent: rarity,
      ...(facts?.quality
        ? { Quality: facts.quality.toUpperCase(), QualityAccent: facts.quality }
        : {}),
      ...(facts?.pointRating ? { PointRating: facts.pointRating } : {}),
    };

    const rows = [];
    rows.push(
      source.isDestroyed
        ? { Label: "LOST WITH THE SHIP", Value: "DESTROYED", Tone: "Negative" }
        : { Label: "LEFT IN THE WRECK", Value: "DROPPED", Tone: "Positive" },
    );
    if (source.quantity > 1)
      rows.push({ Label: "QUANTITY", Value: formatNumber(source.quantity) });
    if (facts?.charges > 0)
      rows.push({ Label: "CHARGES", Value: formatNumber(facts.charges) });
    const ports = source.ports ?? [];
    if (ports.length) {
      const filled = ports.filter(
        (port) => port.state && port.state !== "Empty",
      ).length;
      rows.push({ Label: "PORTS", Value: `${filled}/${ports.length}` });
    }
    const modifiers = facts?.modifiers ?? [];
    if (modifiers.length) {
      rows.push({
        Label: `MODIFIERS ${modifiers.length}`,
        Appearance: "Heading",
      });
      for (const modifier of modifiers) rows.push(modifierRow(modifier));
    }
    if (facts?.isHarmonized || source.hasActiveHarmonic)
      rows.push({ Label: "HARMONIZED", Accent: "Harmonic" });
    if (facts?.isMirrored) rows.push({ Label: "MIRRORED" });
    if (source.isConduitConnected) rows.push({ Label: "CONDUIT CONNECTED" });
    if (source.isIdentified === false) rows.push({ Label: "UNIDENTIFIED" });
    return { Header: header, Rows: rows };
  }

  /** The kill card with a tooltip on every grid item. */
  function withTooltips(card) {
    const grid = (source) =>
      source && {
        ...source,
        items: source.items.map((each) => ({ ...each, tooltip: item(each) })),
      };
    return { ...card, fitting: grid(card.fitting), cargo: grid(card.cargo) };
  }

  return { item, modifierRow, withTooltips };
}
