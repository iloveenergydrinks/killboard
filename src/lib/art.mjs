// The killboard's game art. A kill names the image of every hull and item it shows as a full URL,
// picked by the game data API the way the game picks it, so nothing here resolves art from ids. What
// the API has no image for (an older build's item, a card recorded before ids were kept) gets a
// named placeholder tile where a card names it, else null. The hull roster and the ship class marks
// come from the API's lists.
//
// `data` is a GameData (./game-data.ts).

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

export function createArt(data) {
  // The game's class order, from the API; a hull with no role is grouped under its class.
  const classOrder = data.shipClasses.map((entry) => entry.name);

  return {
    /** A ship as a card names it ({ name, art }): its render, else a named tile. */
    ship(ship) {
      if (!ship) return null;
      return largeImage(ship.art) ?? (ship.name ? placeholder(ship.name) : null);
    },
    /** A hull image the API served, for rows that carry no card; null when it has none. */
    hull(url) {
      return largeImage(url) ?? null;
    },
    /**
     * Every hull a pilot can fly, grouped by role as the game groups them (its class when it has
     * none), then any other hull the board names (`named`, such as one this build no longer has)
     * under "Other". Each hull carries its render.
     */
    hullGroups(named = []) {
      const order = (group) => {
        const role = data.shipRoles.indexOf(group);
        return role >= 0 ? role : data.shipRoles.length + Math.max(classOrder.indexOf(group), 0);
      };
      const groups = new Map();
      // The roster lists a ship once by name, though the data may name it twice.
      const seen = new Set();
      for (const hull of data.hulls.values()) {
        if (seen.has(hull.name)) continue;
        seen.add(hull.name);
        const group = hull.role ?? hull.shipClass;
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push({ name: hull.name, image: largeImage(hull.art?.base ?? null) });
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
          hulls: other.map((hull) => ({ name: hull.name, image: placeholder(hull.name) })),
        });
      return result;
    },
    /** A grid item's or port cipher's image as the API served it, else a tile with its name. */
    item(url, name) {
      return url ?? (name ? placeholder(name) : null);
    },
    /** The mark of a ship class; the unknown contact for a class the site has no mark for. */
    shipClass(shipClass) {
      const mark = data.shipClasses.find((entry) => entry.name === shipClass)?.art ?? data.unknownClassArt;
      return mark?.base ?? null;
    },
  };
}
