"use strict";

const { definitionId } = require("./definitions");
const { rarityName, rarityReviver } = require("../rarity-names");

// A kill becomes public this long after it happened, so the board never shows a fight in progress.
const PUBLICATION_DELAY_MILLISECONDS = 5 * 60 * 1000;
// Quantum's simulation rate, for kills whose time comes only from their tick.
const TICKS_PER_SECOND = 60;

/**
 * The killboard rows for one player death: the scanner's manifest (identity, attackers'
 * accounts) and, from builds that keep them, its kill card facts (display names, place, value,
 * grids). Without card facts the names come from prototype paths and the value is unknown.
 *
 * source: { replayId, buildSha, startedAt (ISO), session ('breach' | 'hub'), origin ('live' | 'report') }
 * Returns { kill, attackers } or null for an NPC victim.
 */
function killRows(source, { manifest, card = null, tick = null }) {
  const m = camelKeys(manifest);
  if (m.victimIsNpc) return null;
  const replayId = Number(source.replayId);
  const occurredAt = occurredAtMilliseconds(source, m, card, tick);

  const attackers = (m.attackers ?? []).map((attacker, ordinal) => {
    const shown = card?.attackers?.[ordinal];
    const isPlayer = Boolean(attacker.isPlayer);
    return {
      ordinal,
      isPlayer,
      userId: isPlayer ? attacker.userId ?? "" : "",
      name:
        (isPlayer ? attacker.playerNickname : null) || shown?.name || prototypeName(attacker.shipPrototype?.name) || "Unknown",
      hullName: shown?.ship?.name ?? hullNameOf(attacker.shipItem?.def?.name ?? attacker.shipPrototype?.name),
      hullDef: shipDefinition(attacker),
      hullClass: shown?.ship?.shipClass ?? "",
      buildRating: Number(attacker.shipBuildRating ?? 0),
      damage: fixedValue(attacker.totalDamage),
      shieldDamage: fixedValue(attacker.shieldDamage),
      isFinalBlow: Boolean(attacker.isFinalBlow),
    };
  });
  const finalBlow = attackers.find((attacker) => attacker.isFinalBlow) ?? null;
  const playerAttackers = attackers.filter((attacker) => attacker.isPlayer && attacker.userId !== m.victimUserId);
  const value = card?.value ?? null;

  const kill = {
    id: `${replayId}:${Number(m.sequence)}`,
    replayId,
    sequence: Number(m.sequence),
    buildSha: source.buildSha,
    sessionKind: source.session,
    occurredAt: new Date(occurredAt).toISOString(),
    publicAt: new Date(occurredAt + PUBLICATION_DELAY_MILLISECONDS).toISOString(),
    deathCause: m.deathCause || "Unspecified",
    // The game records the region only on a reconnect loss; any other death is in the session's.
    regionId: m.locationRegionId || source.regionId || "",
    regionName: card?.location?.regionName ?? "",
    tier: Number(card?.location?.tierIndex ?? m.locationTierIndex ?? 0),
    isTravelLane: Boolean(card?.location?.isTravelLane),
    victimUserId: m.victimUserId,
    victimName: m.victimNickname || card?.victim?.name || "Unknown pilot",
    shipItemId: m.shipItemId ?? "",
    hullName: card?.victim?.ship?.name ?? hullNameOf(m.shipItem?.def?.name ?? m.shipPrototype?.name),
    hullDef: definitionId(m.shipItem?.def) ?? definitionId(m.shipPrototype),
    hullClass: card?.victim?.ship?.shipClass ?? "",
    hullRarity: rarity(card?.victim?.ship?.rarity ?? m.shipItem?.rarity),
    victimBr: Number(m.shipBuildRating ?? card?.victim?.ship?.buildRating ?? 0),
    valueHull: value ? value.hull : null,
    valueFitting: value ? value.fitting : null,
    valueCargo: value ? value.cargo : null,
    valueTotal: value ? value.hull + value.fitting + value.cargo : null,
    totalDamage: card?.totalDamage ?? fixedValue(m.totalDamage),
    attackerCount: attackers.length,
    playerAttackerCount: playerAttackers.length,
    isPvp: playerAttackers.length > 0,
    isSolo: attackers.length === 1,
    finalBlowName: finalBlow?.name ?? null,
    finalBlowUserId: finalBlow?.isPlayer ? finalBlow.userId : null,
    finalBlowHull: finalBlow?.hullName ?? null,
    finalBlowHullDef: finalBlow?.hullDef ?? null,
    // Stored under the rarities' current names: older recordings call Augmented "Advanced".
    card: currentRarities(withItemFacts(card, m)),
    source: source.origin,
  };
  return { kill, attackers };
}

/**
 * The kill card with what the manifest recorded and the card leaves out: each grid item's roll from
 * the container snapshots (quality, build rating, charges, rolled modifiers, harmonized or
 * mirrored), shown in each module's tooltip, each attacker's main weapon, and the game's
 * definition id (`def`, a decimal GUID) of every ship, weapon, module, cipher and artifact the card
 * names, which is how the site finds their data and art in the game data API. The card keeps its
 * own fields; a definition the manifest does not name is left off.
 */
const rarity = (value) => (value == null ? null : rarityName(value));

/** The card with every rarity field under its current name. */
function currentRarities(card) {
  return card == null ? null : JSON.parse(JSON.stringify(card), rarityReviver);
}

function withItemFacts(card, manifest) {
  if (!card) return null;
  const snapshots = new Map();
  for (const container of [manifest.fitting, manifest.cargo])
    for (const item of container?.items ?? []) if (item?.itemId) snapshots.set(item.itemId, item);
  const facts = (item) => {
    const roll = snapshots.get(item.itemId);
    if (!roll) return null;
    return {
      quality: roll.quality ?? null,
      pointRating: Number(roll.rolledPointRating ?? 0),
      charges: Number(roll.charges ?? 0),
      isHarmonized: Boolean(roll.isHarmonized),
      isMirrored: Boolean(roll.isMirrored),
      modifiers: (roll.rolledModifiers ?? []).map((modifier) => ({
        stat: modifier.statType,
        operation: modifier.operation,
        tier: Number(modifier.modifierTier ?? 0),
        value: fixedValue(modifier.value),
        isFractured: Boolean(modifier.isFractured),
      })),
    };
  };
  // A port's cipher, by its position in the item the manifest recorded.
  const ports = (item, roll) =>
    (item.ports ?? []).map((port, index) => {
      const def = definitionId(roll?.ports?.[index]?.cipherPrototype);
      return port.cipher && def ? { ...port, cipher: { ...port.cipher, def } } : port;
    });
  const grid = (source) =>
    source && {
      ...source,
      items: source.items.map((item) => {
        const roll = snapshots.get(item.itemId);
        const def = definitionId(roll?.def);
        const artifact = definitionId(roll?.artifact?.def ?? roll?.artifact);
        return {
          ...item,
          ...(def ? { def } : {}),
          ...(artifact ? { artifactDef: artifact } : {}),
          facts: facts(item),
          ports: ports(item, roll),
        };
      }),
    };
  // The weapon that dealt each attacker's most damage, which the card leaves out.
  const ship = (source, def) => (source && def ? { ...source, def } : source);
  const attackers = (card.attackers ?? []).map((attacker, ordinal) => {
    const recorded = manifest.attackers?.[ordinal];
    const weapon = recorded?.topActionPrototype?.name ?? null;
    const weaponDef = definitionId(recorded?.topActionPrototype);
    return {
      ...attacker,
      ship: ship(attacker.ship, recorded && shipDefinition(recorded)),
      weapon: weapon ? { prototype: weapon, ...(weaponDef ? { def: weaponDef } : {}) } : null,
    };
  });
  return {
    ...card,
    victim: card.victim && {
      ...card.victim,
      ship: ship(card.victim.ship, definitionId(manifest.shipItem?.def) ?? definitionId(manifest.shipPrototype)),
    },
    attackers,
    fitting: grid(card.fitting),
    cargo: grid(card.cargo),
  };
}

/** The definition a ship was flown or spawned from: a player's hull item, else an NPC's ship prototype. */
function shipDefinition(attacker) {
  return definitionId(attacker.shipItem?.def) ?? definitionId(attacker.shipPrototype);
}

/** When the death happened: the card's clock, else the manifest's, else the recording's start plus its tick. */
// Older hub builds had no authority epoch, so their kill cards' UTC seconds count from the session's
// start instead; anything before this is such an offset, not a date.
const EARLIEST_UTC_SECONDS = 1_000_000_000;

function occurredAtMilliseconds(source, manifest, card, tick) {
  const seconds = [card?.killedAtUtcSeconds, manifest.occurredAtUtcSeconds]
    .map(Number)
    .find((each) => each >= EARLIEST_UTC_SECONDS);
  if (seconds) return seconds * 1000;
  const deathTick = Number(manifest.deathTickEstimate ?? tick ?? 0);
  return Date.parse(source.startedAt) + Math.round((deathTick / TICKS_PER_SECOND) * 1000);
}

/** An FP value the scanner writes as { raw, value }, or a plain number. */
function fixedValue(value) {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return Number(value.value ?? 0);
}

/** "…/Ships/Seraph HullEntityPrototype" → "SERAPH", the way the game shows hull names. */
function hullNameOf(prototypePath) {
  const name = prototypeName(prototypePath);
  return name ? name.replace(/\s+Hull$/i, "").toUpperCase() : "UNKNOWN";
}

function prototypeName(prototypePath) {
  if (!prototypePath) return null;
  const leaf = String(prototypePath).split("/").pop();
  return leaf.replace(/EntityPrototype$/, "").replace(/Prototype$/, "").trim() || null;
}

/** Older scanners wrote attacker and item fields in PascalCase; read both alike. */
function camelKeys(value) {
  if (Array.isArray(value)) return value.map(camelKeys);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, inner] of Object.entries(value)) result[key[0].toLowerCase() + key.slice(1)] = camelKeys(inner);
  return result;
}

module.exports = { killRows, hullNameOf, PUBLICATION_DELAY_MILLISECONDS };
