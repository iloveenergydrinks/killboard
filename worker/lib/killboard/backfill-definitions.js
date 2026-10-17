"use strict";

// Fills the game's definition ids (decimal asset GUIDs, see definitions.js) on killboard rows
// recorded before the worker kept them. Each stored prototype path is looked up, exactly, in the
// asset database (db.json) of the runtime bundle of the row's own build: the game's own
// path-to-GUID table. Nothing is matched by display name, and a path the build's database does
// not hold, or a row whose build bundle is not here, is left without ids.

const fs = require("node:fs");
const path = require("node:path");

const PROTOTYPE = "Quantum.EntityPrototype, Quantum.Engine";
const ARTIFACT = "Quantum.ArtifactItemDefinition, Quantum.Simulation";
// GUID values are non-negative (Quantum clears the top bit), so \d+ is every one. One asset of db.json: its type, then its Identifier. Scanned as text because the GUIDs exceed
// the exact range of a JSON number in JavaScript.
const ASSET = /\{"\$type":"([^"]+)","Identifier":\{"Path":"((?:[^"\\]|\\.)*)","Guid":\{"Value":(\d+)\}\}/g;

/** The asset path to decimal GUID tables of a build's db.json text: entity prototypes and artifacts. */
function readDefinitionIndex(text) {
  const prototypes = new Map();
  const artifacts = new Map();
  for (const [, type, assetPath, guid] of text.matchAll(ASSET)) {
    const table = type === PROTOTYPE ? prototypes : type === ARTIFACT ? artifacts : null;
    if (table && guid !== "0") table.set(JSON.parse(`"${assetPath}"`), guid);
  }
  return { prototypes, artifacts };
}

/**
 * The card with a `def` on every ship, weapon, module and cipher whose prototype path the index
 * holds, and an `artifactDef` on every item whose artifact path it holds. Existing ids stay.
 * Returns { card, filled }; `card` is the input itself when nothing was filled.
 */
function backfillCard(card, index) {
  if (!card) return { card, filled: 0 };
  let filled = 0;
  // A copy of `value` with its `def`, when it has none and the path at `key` has one in `table`.
  const fill = (value, table, key) => {
    const id = value && !value.def ? table.get(key.split(".").reduce((inner, name) => inner?.[name], value)) : null;
    if (!id) return value;
    filled += 1;
    return { ...value, def: id };
  };
  const ship = (source) => fill(source, index.prototypes, "icon.prototype");
  const module = (item) => {
    let next = fill(item, index.prototypes, "icon.prototype");
    const artifact = item.icon?.artifact;
    if (!item.artifactDef && artifact && index.artifacts.has(artifact)) {
      next = { ...next, artifactDef: index.artifacts.get(artifact) };
      filled += 1;
    }
    return {
      ...next,
      ports: (item.ports ?? []).map((port) => ({ ...port, cipher: fill(port.cipher, index.prototypes, "prototype") })),
    };
  };
  const grid = (source) => source && { ...source, items: source.items.map(module) };
  const next = {
    ...card,
    victim: card.victim && { ...card.victim, ship: ship(card.victim.ship) },
    attackers: (card.attackers ?? []).map((attacker) => ({
      ...attacker,
      ship: ship(attacker.ship),
      weapon: fill(attacker.weapon, index.prototypes, "prototype"),
    })),
    fitting: grid(card.fitting),
    cargo: grid(card.cargo),
  };
  return filled ? { card: next, filled } : { card, filled: 0 };
}

const bundleFile = (runtimeRoot, buildSha) => path.join(runtimeRoot, buildSha, "db.json");

/**
 * Plans the backfill for kb_kills rows ({ id, build_sha, card, hull_def, final_blow_hull_def }) and their kb_attackers
 * rows ({ kill_id, ordinal, hull_def, is_final_blow }). `loadIndex(buildSha)` returns a build's index or null when
 * its bundle is not available. Returns the updates to apply and a count of what could not be done.
 */
function planBackfill(kills, attackers, loadIndex) {
  const byKill = new Map();
  for (const attacker of attackers) {
    if (!byKill.has(attacker.kill_id)) byKill.set(attacker.kill_id, []);
    byKill.get(attacker.kill_id).push(attacker);
  }
  const indexes = new Map();
  const plan = { kills: [], attackers: [], filled: 0, withoutBundle: 0, builds: new Set(), missingBuilds: new Set() };
  for (const kill of kills) {
    if (!indexes.has(kill.build_sha)) indexes.set(kill.build_sha, loadIndex(kill.build_sha));
    const index = indexes.get(kill.build_sha);
    if (!index) {
      plan.withoutBundle += 1;
      plan.missingBuilds.add(kill.build_sha);
      continue;
    }
    plan.builds.add(kill.build_sha);
    const { card, filled } = backfillCard(kill.card, index);
    const hullDef = kill.hull_def ? null : card?.victim?.ship?.def ?? null;
    let finalBlowHullDef = null;
    for (const attacker of byKill.get(kill.id) ?? []) {
      const def = attacker.hull_def ?? card?.attackers?.[attacker.ordinal]?.ship?.def ?? null;
      if (!attacker.hull_def && def) plan.attackers.push({ killId: kill.id, ordinal: attacker.ordinal, hullDef: def });
      if (attacker.is_final_blow && !kill.final_blow_hull_def) finalBlowHullDef = def;
    }
    if (filled || hullDef || finalBlowHullDef)
      plan.kills.push({ id: kill.id, card: filled ? card : null, hullDef, finalBlowHullDef });
    plan.filled += filled;
  }
  return plan;
}

/** A build's index from <runtimeRoot>/<sha>/db.json, or null when the bundle is not on this machine. */
function bundleIndexLoader(runtimeRoot) {
  return (buildSha) => {
    if (!/^[0-9a-f]{40}$/i.test(String(buildSha))) return null;
    const file = bundleFile(runtimeRoot, buildSha.toLowerCase());
    return fs.existsSync(file) ? readDefinitionIndex(fs.readFileSync(file, "utf8")) : null;
  };
}

module.exports = { readDefinitionIndex, backfillCard, planBackfill, bundleIndexLoader };
