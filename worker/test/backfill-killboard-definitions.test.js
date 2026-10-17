"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { PGlite } = require("@electric-sql/pglite");
const { killRows } = require("../lib/killboard/rows");
const { definitionId } = require("../lib/killboard/definitions");
const { KillboardStore } = require("../lib/killboard/store");
const { readDefinitionIndex, backfillCard } = require("../lib/killboard/backfill-definitions");
const { backfillDefinitions } = require("../backfill-killboard-definitions");

const FIXTURE = require(path.join(__dirname, "fixtures/killboard-live-manifests.json"));
const BUILD = "c9c47558755aa7ded1a8892e272e02f42c080d0f";
const SOURCE = { replayId: FIXTURE.replay.replay_id, buildSha: BUILD, startedAt: FIXTURE.replay.started_at, session: "breach", origin: "live" };
const DEATH = FIXTURE.events.find((event) => !event.manifest.victimIsNpc);

const SERAPH_HULL = "Content/SessionDestinations/Shared/Quantum/Modules/ShipItem/Seraph HullEntityPrototype";
const FLAK = "Content/SessionDestinations/Shared/Quantum/Modules/Turrets/Flak Cannon Variants/Flak CannonEntityPrototype";

/** The card as a worker that did not keep definition ids stored it. */
function withoutDefinitions(value) {
  if (Array.isArray(value)) return value.map(withoutDefinitions);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "def" && key !== "artifactDef")
      .map(([key, inner]) => [key, withoutDefinitions(inner)]),
  );
}

/** A db.json holding exactly these assets, in the shape the game's export writes. */
function dbJson(assets) {
  return JSON.stringify(
    assets.map(([type, assetPath, guid]) => ({ $type: type, Identifier: { Path: assetPath, Guid: { Value: "@" + guid } } })),
  ).replace(/"@(\d+)"/g, "$1");
}

test("the manifest's hex GUIDs become the decimal ids the game data API uses", () => {
  assert.equal(definitionId({ guid: "[13B920561A65891E]", name: "x" }), BigInt("0x13B920561A65891E").toString());
  assert.equal(definitionId({ guid: "[0000000000000000]" }), null);
  assert.equal(definitionId({ guid: "nonsense" }), null);
  assert.equal(definitionId(null), null);
});

test("a kill row keeps the card's fields and adds the definition of every ship, weapon and module", () => {
  const { kill, attackers } = killRows(SOURCE, DEATH);
  const seraph = definitionId(DEATH.manifest.shipItem.def);
  assert.equal(kill.hullDef, seraph);
  assert.equal(kill.card.victim.ship.def, seraph);
  assert.equal(kill.card.victim.ship.icon.prototype, SERAPH_HULL);
  // An NPC attacker is named by the ship prototype it spawned from; its card fields stay.
  assert.equal(attackers[0].hullDef, definitionId(DEATH.manifest.attackers[0].shipPrototype));
  assert.equal(kill.finalBlowHullDef, attackers.find((attacker) => attacker.isFinalBlow).hullDef);
  assert.match(kill.finalBlowHullDef, /^\d+$/);
  assert.equal(kill.card.attackers[0].ship.icon.npcHull, "C EYE");
  assert.equal(kill.card.attackers[3].weapon.def, definitionId(DEATH.manifest.attackers[3].topActionPrototype));
  const flak = kill.card.fitting.items.find((item) => item.icon.prototype === FLAK);
  assert.equal(flak.def, definitionId(DEATH.manifest.fitting.items.find((item) => item.def.name === FLAK).def));
  assert.ok(kill.card.fitting.items.every((item) => /^\d+$/.test(item.def)));
  // Every field the card had is still there.
  assert.deepEqual(withoutDefinitions(kill.card).victim, withoutDefinitions(killRows(SOURCE, { ...DEATH, manifest: { ...DEATH.manifest, shipItem: null, shipPrototype: null } }).kill.card).victim);
});

test("a manifest without GUIDs adds none", () => {
  const strip = (value) => JSON.parse(JSON.stringify(value, (key, inner) => (key === "guid" ? undefined : inner)));
  const { kill, attackers } = killRows(SOURCE, { ...DEATH, manifest: strip(DEATH.manifest) });
  assert.equal(kill.hullDef, null);
  assert.equal(attackers[0].hullDef, null);
  assert.equal(JSON.stringify(kill.card).includes('"def"'), false);
});

test("the asset index reads exact GUIDs and only prototypes and artifacts", () => {
  const index = readDefinitionIndex(
    dbJson([
      ["Quantum.EntityPrototype, Quantum.Engine", SERAPH_HULL, "1421202711594240286"],
      ["Quantum.ArtifactItemDefinition, Quantum.Simulation", "Config/Quantum/Definitions/Artifacts/OATH", "275107089619583858"],
      ["Quantum.FactionPatrolPathSet, Quantum.Simulation", "Canyon_PatrolPathSet", "311363935806601606"],
    ]),
  );
  assert.equal(index.prototypes.get(SERAPH_HULL), "1421202711594240286");
  assert.equal(index.artifacts.get("Config/Quantum/Definitions/Artifacts/OATH"), "275107089619583858");
  assert.equal(index.prototypes.has("Canyon_PatrolPathSet"), false);
});

test("a card gains ids only for paths the build holds, and keeps ids it has", () => {
  const index = {
    prototypes: new Map([[SERAPH_HULL, "11"], [FLAK, "22"]]),
    artifacts: new Map([["Config/Quantum/Definitions/Artifacts/OATH", "33"]]),
  };
  const card = {
    victim: { ship: { name: "SERAPH", icon: { prototype: SERAPH_HULL } } },
    attackers: [
      { ship: { name: "C EYE", icon: { npcHull: "C EYE", prototype: null } }, weapon: { prototype: FLAK } },
      { ship: { name: "OLD", icon: { prototype: "Content/Gone/GoneEntityPrototype" } }, weapon: { prototype: FLAK, def: "99" } },
    ],
    fitting: {
      items: [
        { name: "FLAK CANNON", icon: { prototype: FLAK, artifact: "Config/Quantum/Definitions/Artifacts/OATH" }, ports: [{ cipher: { prototype: FLAK } }, { cipher: null }] },
      ],
    },
    cargo: null,
  };
  const { card: filled, filled: count } = backfillCard(card, index);
  assert.equal(count, 5);
  assert.equal(filled.victim.ship.def, "11");
  assert.equal(filled.attackers[0].ship.def, undefined);
  assert.equal(filled.attackers[0].weapon.def, "22");
  assert.equal(filled.attackers[1].ship.def, undefined);
  assert.equal(filled.attackers[1].weapon.def, "99");
  assert.equal(filled.fitting.items[0].def, "22");
  assert.equal(filled.fitting.items[0].artifactDef, "33");
  assert.equal(filled.fitting.items[0].ports[0].cipher.def, "22");
  assert.equal(filled.fitting.items[0].ports[1].cipher, null);
  assert.equal(backfillCard(filled, index).filled, 0);
});

test("the backfill is a dry run until applied, uses each row's own build bundle, and skips builds it lacks", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-runtime-"));
  try {
    const stored = killRows(SOURCE, DEATH);
    const old = {
      kill: { ...stored.kill, hullDef: null, card: withoutDefinitions(stored.kill.card) },
      attackers: stored.attackers.map((attacker) => ({ ...attacker, hullDef: null })),
    };
    old.kill.finalBlowHullDef = null;
    const other = killRows({ ...SOURCE, buildSha: "b".repeat(40) }, { ...DEATH, manifest: { ...DEATH.manifest, sequence: 99 } });
    const gone = { kill: { ...other.kill, hullDef: null, card: withoutDefinitions(other.kill.card) }, attackers: other.attackers.map((a) => ({ ...a, hullDef: null })) };

    // Only the first build's bundle is here; its database holds the hull and the flak cannon.
    fs.mkdirSync(path.join(root, BUILD));
    fs.writeFileSync(
      path.join(root, BUILD, "db.json"),
      dbJson([
        ["Quantum.EntityPrototype, Quantum.Engine", SERAPH_HULL, definitionId(DEATH.manifest.shipItem.def)],
        ["Quantum.EntityPrototype, Quantum.Engine", FLAK, definitionId(DEATH.manifest.fitting.items.find((item) => item.def.name === FLAK).def)],
      ]),
    );

    const db = new PGlite();
    const store = new KillboardStore(db);
    await store.migrate();
    await store.saveKill(old);
    await store.saveKill(gone);
    const before = (await db.query("SELECT id, card, hull_def FROM kb_kills ORDER BY id")).rows;
    const quiet = { log() {} };

    const dry = await backfillDefinitions(db, { runtimeRoot: root, log: quiet });
    assert.deepEqual((await db.query("SELECT id, card, hull_def FROM kb_kills ORDER BY id")).rows, before);
    assert.equal(dry.killsUpdated, 1);
    assert.equal(dry.withoutBundle, 1);

    await backfillDefinitions(db, { runtimeRoot: root, apply: true, log: quiet });
    const rows = Object.fromEntries((await db.query("SELECT id, card, hull_def FROM kb_kills")).rows.map((row) => [row.id, row]));
    const done = rows[old.kill.id];
    assert.equal(done.hull_def, stored.kill.hullDef);
    assert.equal(done.card.victim.ship.def, stored.kill.hullDef);
    const flak = done.card.fitting.items.find((item) => item.icon.prototype === FLAK);
    assert.equal(flak.def, stored.kill.card.fitting.items.find((item) => item.icon.prototype === FLAK).def);
    // Paths the bundle does not hold, and NPC ships the card names only by name, stay without ids.
    assert.equal(done.card.attackers[0].ship.def, undefined);
    assert.equal(done.card.fitting.items.some((item) => item.icon.prototype !== FLAK && item.def), false);
    // The row of the build with no bundle is as it was.
    assert.deepEqual(rows[gone.kill.id], before.find((row) => row.id === gone.kill.id));
    assert.equal(
      (await db.query("SELECT hull_def FROM kb_attackers WHERE kill_id = $1 AND hull_def IS NOT NULL", [old.kill.id])).rows.length,
      0,
    );
    // A second run finds nothing to do.
    assert.equal((await backfillDefinitions(db, { runtimeRoot: root, apply: true, log: quiet })).killsUpdated, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a batch is applied in one transaction, and a card the worker rewrote meanwhile is left alone", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kb-runtime-"));
  try {
    fs.mkdirSync(path.join(root, BUILD));
    fs.writeFileSync(
      path.join(root, BUILD, "db.json"),
      dbJson([["Quantum.EntityPrototype, Quantum.Engine", SERAPH_HULL, definitionId(DEATH.manifest.shipItem.def)]]),
    );
    const stored = killRows(SOURCE, DEATH);
    const old = (sequence) => {
      const rows = killRows(SOURCE, { ...DEATH, manifest: { ...DEATH.manifest, sequence } });
      return { kill: { ...rows.kill, hullDef: null, finalBlowHullDef: null, card: withoutDefinitions(rows.kill.card) }, attackers: rows.attackers.map((a) => ({ ...a, hullDef: null })) };
    };
    const [first, second] = [old(11), old(12)];
    const db = new PGlite();
    const store = new KillboardStore(db);
    await store.migrate();
    await store.migrate();
    await store.saveKill(first);
    await store.saveKill(second);

    // After the backfill has read its batch, the worker rescans the first kill.
    let rescanned = false;
    const client = {
      async query(text, params) {
        const result = await db.query(text, params);
        if (!rescanned && /FROM kb_attackers/.test(text)) {
          rescanned = true;
          await store.saveKill({ ...first, kill: { ...first.kill, card: { ...first.kill.card, rescanned: true } } });
        }
        return result;
      },
    };
    const quiet = { log() {} };
    const totals = await backfillDefinitions(client, { runtimeRoot: root, apply: true, log: quiet });
    assert.equal(totals.changedMeanwhile, 1);
    const rows = Object.fromEntries((await db.query("SELECT id, card, hull_def FROM kb_kills")).rows.map((row) => [row.id, row]));
    assert.equal(rows[first.kill.id].card.rescanned, true, "the newer card stays");
    assert.equal(rows[first.kill.id].card.victim.ship.def, undefined);
    assert.equal(rows[first.kill.id].hull_def, null);
    assert.equal(rows[second.kill.id].hull_def, stored.kill.hullDef);

    // A batch that fails before commit rolls back whole.
    const failing = {
      async query(text, params) {
        if (/COMMIT/.test(text)) throw new Error("boom");
        return db.query(text, params);
      },
    };
    await store.saveKill(old(13));
    await assert.rejects(backfillDefinitions(failing, { runtimeRoot: root, apply: true, log: quiet }), /boom/);
    const left = (await db.query("SELECT hull_def FROM kb_kills WHERE id = $1", [old(13).kill.id])).rows[0];
    assert.equal(left.hull_def, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rescan that kept no definition ids does not erase the ones already filled", async () => {
  const db = new PGlite();
  const store = new KillboardStore(db);
  await store.migrate();
  const rows = killRows(SOURCE, DEATH);
  await store.saveKill(rows);
  const bare = { kill: { ...rows.kill, hullDef: null, finalBlowHullDef: null }, attackers: rows.attackers.map((a) => ({ ...a, hullDef: null })) };
  await store.saveKill(bare);
  const kill = (await db.query("SELECT hull_def, final_blow_hull_def FROM kb_kills WHERE id = $1", [rows.kill.id])).rows[0];
  assert.equal(kill.hull_def, rows.kill.hullDef);
  assert.equal(kill.final_blow_hull_def, rows.kill.finalBlowHullDef);
  const attackers = (await db.query("SELECT hull_def FROM kb_attackers WHERE kill_id = $1 ORDER BY ordinal", [rows.kill.id])).rows;
  assert.deepEqual(attackers.map((row) => row.hull_def), rows.attackers.map((a) => a.hullDef));
});
