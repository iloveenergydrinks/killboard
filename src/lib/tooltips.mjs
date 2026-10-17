// A kill card module's tooltip, in the game's item tooltip shape (CurrentItemTooltip's
// TooltipState: Header and Rows), from what the kill recorded about it. Each modifier comes from
// the game data API already worded the way the game words it (ItemModifierText.Row: label, signed
// text and tone); the rows only a kill has (destroyed or dropped, quantity, ports) are the site's.

/** DisplayNumberText.FormatNumber: whole numbers from 100 up, one decimal below. */
export function formatNumber(value) {
  const rounded =
    Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return Math.abs(value) >= 100
    ? rounded.toLocaleString("en-US")
    : String(rounded);
}

export function createTooltips() {
  /**
   * A modifier's row as the API words it, badged with its tier and accented when fractured. A row
   * with no value (a name-only stat, or one the live build does not know) shows its label alone.
   */
  function modifierRow(modifier) {
    return {
      Label: modifier.label ?? String(modifier.stat),
      ...(modifier.text != null ? { Value: modifier.text } : {}),
      Tone: modifier.tone ?? "Neutral",
      ...(modifier.tier > 0 ? { Badge: `T${modifier.tier}` } : {}),
      ...(modifier.isFractured ? { Accent: "Harmonic" } : {}),
    };
  }

  /** The tooltip of one grid item of a kill card. */
  function item(source) {
    const facts = source.facts ?? null;
    const rarity = source.rarity ?? "Normal";
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
