// The game art a kill names, resolved the way the game resolves it (BaseModuleDefPrototype.GetIcon:
// the tiered art a rarity authors, else the base icon) from the game data API's art keys. A kill
// card names what it shows by definition id (`def`, the decimal asset GUID), so a lookup is by id
// and never by name. What the current build does not have (an older build's item, a card recorded
// before ids were kept) gets a named placeholder tile where a card names it, else null.
//
// `data` is a GameData (./game-data.ts); every URL is the API's, absolute.

// The Advanced rarity was renamed Augmented (tools/ship-restore/lib/rarity-names.js).
const RARITY_RENAMES = { Advanced: "Augmented" };
// How the roles and ship classes read in the hull picker; the API lists hulls unordered.
const ROLE_ORDER = [
  "Interceptor",
  "Destroyer",
  "Scout",
  "Sentinel",
  "Artillery",
  "Support",
  "Hauler",
];
const CLASS_ORDER = ["Frigate", "Cruiser", "Dreadnought"];
// The ship class marks are the site's own: the API serves no class art (it should, later). The
// webp files are a one-off conversion of the game's ShipClass sprites (Assets/Art/ShipIndicator:
// Frigate/Cruiser/Dreadnaught Enemy.png, SquareIcon.png), trimmed and resized to 64px.
const CLASS_ICONS = {
  Frigate: "/ship-class/frigate.webp",
  Cruiser: "/ship-class/cruiser.webp",
  Dreadnought: "/ship-class/dreadnought.webp",
};
const UNKNOWN_CLASS_ICON = "/ship-class/unknown.webp";

/** A rarity by its current name, for facts recorded before the rename. */
export function rarityName(rarity) {
  return RARITY_RENAMES[rarity] ?? rarity;
}

/** The 256px twin of an API image URL (the API serves 128px with an @2x file beside it). */
export function largeImage(url) {
  return url ? url.replace(/\.webp$/, "@2x.webp") : url;
}

const escapeXml = (text) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The lines of a name on a tile: words kept whole, at most three lines of twelve characters. */
function nameLines(name) {
  const lines = [];
  for (const word of String(name ?? "").trim().split(/\s+/).filter(Boolean)) {
    const last = lines.at(-1);
    if (last !== undefined && last.length + 1 + word.length <= 12)
      lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  return lines.slice(0, 3).map((line) => (line.length > 12 ? `${line.slice(0, 11)}…` : line));
}

/**
 * A tile that names what it stands for, as a data URL any image slot accepts: for an item the
 * current build no longer has.
 */
export function placeholder(name) {
  const lines = nameLines(name);
  const top = 50 - ((lines.length - 1) * 6.5);
  const text = lines
    .map((line, index) => `<tspan x="50" y="${top + index * 13}">${escapeXml(line.toUpperCase())}</tspan>`)
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<rect x="8" y="8" width="84" height="84" fill="rgba(248,245,236,0.04)" stroke="rgba(248,245,236,0.28)" stroke-width="1.5"/>` +
    `<text text-anchor="middle" dominant-baseline="middle" font-family="monospace" font-size="10" fill="rgba(248,245,236,0.72)">${text}</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** "…/TekCiphers/Uncommon/DruxEntityPrototype" → "Drux": a stored path read as text, for a tile's label only. */
function prototypeName(prototype) {
  const leaf = String(prototype ?? "").split("/").pop() ?? "";
  return leaf.replace(/(?:Entity)?Prototype$/, "").trim() || null;
}

export function createArt(data) {
  /** BaseModuleDefPrototype.GetIcon: tiered art when authored, else the base icon. */
  const variant = (art, rarity) =>
    art ? (art[rarityName(rarity ?? "Normal")] ?? art.base) : null;
  /** A ship by definition id: a hull a pilot can fly, else an NPC ship or boss. */
  const shipEntry = (def) => (def ? (data.hulls.get(def) ?? data.npcs.get(def)) : null);
  const shipImage = (def, rarity) =>
    largeImage(variant(shipEntry(def)?.art, rarity));

  const itemImage = (icon) => {
    if (!icon) return null;
    const artifact = icon.artifactDef ? data.artifacts.get(icon.artifactDef) : null;
    const fromArtifact = variant(artifact?.art, "Artifact");
    if (fromArtifact) return fromArtifact;
    // An artifact without art of its own shows its base item's.
    const base = data.items.get(artifact?.item ?? icon.def) ?? data.ciphers.get(icon.def);
    return variant(base?.art, icon.rarity);
  };
  const entryName = (def) =>
    data.items.get(def)?.name ?? data.npcs.get(def)?.name ?? data.ciphers.get(def)?.name ?? null;

  return {
    /** A ship as a kill card names it ({ name, def, icon: { rarity } }): its render, else a named tile. */
    ship(ship) {
      if (!ship) return null;
      return shipImage(ship.def, ship.icon?.rarity ?? ship.rarity) ?? (ship.name ? placeholder(ship.name) : null);
    },
    /** A hull or NPC ship by definition id, for rows that carry no card; null when unknown. */
    hull(def, rarity = "Normal") {
      return shipImage(def, rarity);
    },
    /**
     * Every hull a pilot can fly, grouped by role as the game groups them (its class when it has
     * none), then any other hull the board names (`named`, such as one this build no longer has)
     * under "Other". Each hull carries its render.
     */
    hullGroups(named = []) {
      const order = (group) => {
        const role = ROLE_ORDER.indexOf(group);
        return role >= 0 ? role : ROLE_ORDER.length + Math.max(CLASS_ORDER.indexOf(group), 0);
      };
      const groups = new Map();
      // The roster lists a ship once by name, though the data may name it twice.
      const seen = new Set();
      for (const hull of data.hulls.values()) {
        if (seen.has(hull.name)) continue;
        seen.add(hull.name);
        const group = hull.role ?? hull.shipClass;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push({ name: hull.name, image: largeImage(variant(hull.art, "Normal")) });
      }
      // A ship the board names belongs to the roster by its definition id; one without an id, or
      // with one this build does not have, goes under Other.
      const known = new Set(data.hulls.keys());
      const result = [...groups]
        .sort(([a], [b]) => order(a) - order(b) || a.localeCompare(b))
        .map(([group, hulls]) => ({
          group,
          hulls: hulls.sort((a, b) => a.name.localeCompare(b.name)),
        }));
      const other = named.filter((hull) => !hull.def || !known.has(hull.def)).sort((a, b) => a.name.localeCompare(b.name));
      if (other.length)
        result.push({
          group: "Other",
          hulls: other.map((hull) => ({ name: hull.name, image: shipImage(hull.def) })),
        });
      return result;
    },
    /** A grid item's or port cipher's icon ({ def, artifactDef, rarity }), else a tile with its name. */
    item(icon, name) {
      return itemImage(icon) ?? (name ? placeholder(name) : null);
    },
    /**
     * A weapon's or module's name: this build's, by definition id, else the name its stored
     * prototype path reads as (for one an older build had).
     */
    name(def, prototype) {
      return entryName(def) ?? prototypeName(prototype);
    },
    /** The mark of a ship class; the unknown contact for a class the site has no mark for. */
    shipClass(shipClass) {
      return CLASS_ICONS[shipClass] ?? UNKNOWN_CLASS_ICON;
    },
    /**
     * The kill card with a URL on every icon it names, as the kill feed's card renderer gives the
     * game's kill manifest panel (lib/kill-feed/card-renderer.js withIcons).
     */
    withIcons(card) {
      const ship = (source) =>
        source && {
          ...source,
          icon: { ...source.icon, url: this.ship(source) },
          classIcon: { url: this.shipClass(source.shipClass) },
        };
      const module = (icon, name, def, artifactDef) =>
        icon && { ...icon, url: this.item({ ...icon, def, artifactDef }, name) };
      const grid = (source) =>
        source && {
          ...source,
          items: source.items.map((item) => ({
            ...item,
            icon: module(item.icon, item.name, item.def, item.artifactDef),
            ports: (item.ports ?? []).map((port) => ({
              ...port,
              cipher: port.cipher && module(port.cipher, entryName(port.cipher.def) ?? prototypeName(port.cipher.prototype), port.cipher.def, null),
            })),
          })),
        };
      return {
        ...card,
        victim: { ...card.victim, ship: ship(card.victim.ship) },
        attackers: card.attackers.map((attacker) => ({
          ...attacker,
          ship: ship(attacker.ship),
        })),
        fitting: grid(card.fitting),
        cargo: grid(card.cargo),
      };
    },
  };
}
