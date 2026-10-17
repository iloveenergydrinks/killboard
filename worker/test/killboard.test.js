"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const { PGlite } = require("@electric-sql/pglite");
const { killRows, hullNameOf, PUBLICATION_DELAY_MILLISECONDS } = require("../lib/killboard/rows");
const { groupBattles } = require("../lib/killboard/battles");
const { KillboardStore } = require("../lib/killboard/store");

// Anonymised output of the live scanner for one breach: its player deaths and one NPC death.
const FIXTURE = require(path.join(__dirname, "fixtures/killboard-live-manifests.json"));
const SOURCE = {
  replayId: FIXTURE.replay.replay_id,
  buildSha: "c9c47558755aa7ded1a8892e272e02f42c080d0f",
  startedAt: FIXTURE.replay.started_at,
  session: "breach",
  origin: "live",
};
const PLAYER_DEATH = FIXTURE.events.find((event) => !event.manifest.victimIsNpc);
const NPC_DEATH = FIXTURE.events.find((event) => event.manifest.victimIsNpc);

test("a player death maps to a kill with its card's names, place and value", () => {
  const { kill, attackers } = killRows(SOURCE, PLAYER_DEATH);
  assert.equal(kill.id, `${SOURCE.replayId}:11`);
  assert.equal(kill.victimName, "PILOT1");
  assert.equal(kill.hullName, "SERAPH");
  assert.equal(kill.hullClass, "Cruiser");
  assert.equal(kill.regionName, "CHARTER'S REACH");
  assert.equal(kill.tier, 2);
  assert.deepEqual([kill.valueHull, kill.valueFitting, kill.valueCargo, kill.valueTotal], [468, 296, 644, 1408]);
  assert.equal(kill.occurredAt, new Date(1791578432 * 1000).toISOString());
  assert.equal(Date.parse(kill.publicAt) - Date.parse(kill.occurredAt), PUBLICATION_DELAY_MILLISECONDS);
  assert.equal(kill.attackerCount, attackers.length);
  assert.equal(attackers[0].name, "C EYE");
  assert.equal(attackers[0].isPlayer, false);
  assert.equal(attackers.filter((attacker) => attacker.isFinalBlow).length, 1);
  assert.equal(kill.finalBlowName, attackers.find((attacker) => attacker.isFinalBlow).name);
  assert.equal(kill.isPvp, attackers.some((attacker) => attacker.isPlayer));
  assert.equal(kill.isSolo, false);
});

test("a kill's zone id is the session's region, or the region a reconnect loss recorded", () => {
  assert.equal(killRows({ ...SOURCE, regionId: "cloud_wake" }, PLAYER_DEATH).kill.regionId, "cloud_wake");
  const reconnect = { ...PLAYER_DEATH, manifest: { ...PLAYER_DEATH.manifest, locationRegionId: "orrery" } };
  assert.equal(killRows({ ...SOURCE, regionId: "cloud_wake" }, reconnect).kill.regionId, "orrery");
  assert.equal(killRows({ ...SOURCE, regionId: "" }, PLAYER_DEATH).kill.regionId, "");
});

test("a kill card's seconds counted from session start are not a date: the kill dates from the recording", () => {
  const card = { ...PLAYER_DEATH.card, killedAtUtcSeconds: 1907 };
  const manifest = { ...PLAYER_DEATH.manifest, occurredAtUtcSeconds: 0, deathTickEstimate: 60 * 120 };
  const { kill } = killRows({ ...SOURCE, session: "hub" }, { ...PLAYER_DEATH, card, manifest });
  assert.equal(kill.occurredAt, new Date(Date.parse(SOURCE.startedAt) + 120_000).toISOString());
});

test("a kill stores the rarities under their current names", () => {
  const card = JSON.parse(JSON.stringify(PLAYER_DEATH.card));
  card.victim.ship.rarity = "Advanced";
  for (const item of card.fitting?.items ?? []) item.rarity = "Advanced";
  const { kill } = killRows(SOURCE, { ...PLAYER_DEATH, card });
  assert.equal(kill.hullRarity, "Augmented");
  assert.equal(kill.card.victim.ship.rarity, "Augmented");
  assert.equal(JSON.stringify(kill.card).includes('"Advanced"'), false);
});

test("an NPC death is not a kill", () => {
  assert.equal(killRows(SOURCE, NPC_DEATH), null);
});

test("a death without card facts keeps prototype names and an unknown value", () => {
  const { kill } = killRows({ ...SOURCE, origin: "report" }, { manifest: PLAYER_DEATH.manifest, card: null });
  assert.equal(kill.hullName, "SERAPH");
  assert.equal(kill.valueTotal, null);
  assert.equal(kill.regionName, "");
  // The manifest keeps no clock, so the time comes from the recording's start and the death's tick.
  assert.equal(kill.occurredAt, new Date(Date.parse(SOURCE.startedAt) + Math.round((7587 / 60) * 1000)).toISOString());
});

test("older scanners' PascalCase attackers map like current ones", () => {
  const manifest = {
    ...PLAYER_DEATH.manifest,
    attackers: [
      {
        IsPlayer: true,
        PlayerNickname: "OLDTIMER",
        UserId: "user9999",
        ShipPrototype: { Guid: "[1]", Name: "Content/Ships/ROC/ROCEntityPrototype" },
        ShipItem: { def: { Guid: "[2]", Name: "Content/Ships/ROC/ROC HullEntityPrototype" } },
        ShipBuildRating: 8247,
        TotalDamage: { Raw: 1, Value: 915 },
        ShieldDamage: { Raw: 0, Value: 0 },
        IsFinalBlow: true,
      },
    ],
  };
  const { kill, attackers } = killRows({ ...SOURCE, origin: "report" }, { manifest, card: null });
  assert.deepEqual(
    { name: attackers[0].name, hull: attackers[0].hullName, damage: attackers[0].damage, finalBlow: attackers[0].isFinalBlow },
    { name: "OLDTIMER", hull: "ROC", damage: 915, finalBlow: true }
  );
  assert.equal(kill.isSolo, true);
  assert.equal(kill.isPvp, true);
  assert.equal(kill.finalBlowUserId, "user9999");
});

test("hull names read like the game's", () => {
  assert.equal(hullNameOf("Content/SessionDestinations/Shared/Quantum/Modules/ShipItem/Seraph HullEntityPrototype"), "SERAPH");
  assert.equal(hullNameOf(null), "UNKNOWN");
});

function battleKill(sequence, seconds, extra = {}) {
  return {
    id: `7:${sequence}`,
    replayId: 7,
    sequence,
    occurredAt: seconds * 1000,
    publicAt: seconds * 1000 + PUBLICATION_DELAY_MILLISECONDS,
    regionName: "THE GALLOWS",
    valueTotal: 100,
    victimUserId: `victim${sequence}`,
    attackerUserIds: ["hunter"],
    ...extra,
  };
}

test("kills within two minutes of each other chain into one battle; a lone kill is no battle", () => {
  const { battles, battleOf } = groupBattles([
    battleKill(0, 0),
    battleKill(1, 100),
    battleKill(2, 210),
    battleKill(3, 1000),
  ]);
  assert.equal(battles.length, 1);
  assert.deepEqual(
    { id: battles[0].id, kills: battles[0].killCount, value: battles[0].valueTotal, pilots: battles[0].pilotCount },
    { id: "7:0", kills: 3, value: 300, pilots: 4 }
  );
  assert.equal(battleOf.get("7:2"), "7:0");
  assert.equal(battleOf.has("7:3"), false);
  assert.equal(battles[0].publicAt, 210 * 1000 + PUBLICATION_DELAY_MILLISECONDS);
});

async function freshStore() {
  const store = new KillboardStore(new PGlite());
  await store.migrate();
  await store.migrate(); // idempotent
  return store;
}

test("the store saves a kill once however often its recording is rescanned", async () => {
  const store = await freshStore();
  const rows = killRows(SOURCE, PLAYER_DEATH);
  assert.equal(await store.saveKill(rows), true);
  assert.equal(await store.saveKill(rows), true);
  const kills = await store.client.query("SELECT id, value_total, card->'victim'->>'name' AS card_name FROM kb_kills");
  assert.deepEqual(kills.rows, [{ id: rows.kill.id, value_total: 1408, card_name: "PILOT1" }]);
  const attackers = await store.client.query("SELECT count(*)::int AS n FROM kb_attackers");
  assert.equal(attackers.rows[0].n, rows.attackers.length);
});

test("a reconnect loss of a ship whose breach death is recorded is not a second kill, in either order", async () => {
  const store = await freshStore();
  const breach = killRows(SOURCE, PLAYER_DEATH);
  const reconnect = killRows(
    { ...SOURCE, replayId: 50000, session: "hub" },
    { ...PLAYER_DEATH, manifest: { ...PLAYER_DEATH.manifest, sequence: 0, deathCause: "ReconnectLoss" } }
  );
  assert.equal(await store.saveKill(breach), true);
  assert.equal(await store.saveKill(reconnect), false);

  const other = await freshStore();
  assert.equal(await other.saveKill(reconnect), true);
  assert.equal(await other.saveKill(breach), true);
  const ids = await other.client.query("SELECT id FROM kb_kills");
  assert.deepEqual(ids.rows.map((row) => row.id), [breach.kill.id]);
});

test("rebuilding a recording's battles links its kills and replaces its old battles", async () => {
  const store = await freshStore();
  const base = killRows(SOURCE, PLAYER_DEATH);
  for (const [sequence, offsetSeconds, item] of [
    [11, 0, "a"],
    [12, 60, "b"],
    [13, 3600, "c"],
  ]) {
    const occurredAt = Date.parse(base.kill.occurredAt) + offsetSeconds * 1000;
    await store.saveKill({
      kill: {
        ...base.kill,
        id: `${SOURCE.replayId}:${sequence}`,
        sequence,
        shipItemId: item,
        occurredAt: new Date(occurredAt).toISOString(),
        publicAt: new Date(occurredAt + PUBLICATION_DELAY_MILLISECONDS).toISOString(),
      },
      attackers: base.attackers,
    });
  }
  assert.equal(await store.rebuildBattles(SOURCE.replayId), 1);
  assert.equal(await store.rebuildBattles(SOURCE.replayId), 1);
  const battles = await store.client.query("SELECT id, kill_count, value_total::int AS value FROM kb_battles");
  assert.deepEqual(battles.rows, [{ id: `${SOURCE.replayId}:11`, kill_count: 2, value: 2816 }]);
  const linked = await store.client.query("SELECT id, battle_id FROM kb_kills ORDER BY sequence");
  assert.deepEqual(
    linked.rows.map((row) => row.battle_id),
    [`${SOURCE.replayId}:11`, `${SOURCE.replayId}:11`, null]
  );
});

test("scans and viewer links are recorded", async () => {
  const store = await freshStore();
  const rows = killRows(SOURCE, PLAYER_DEATH);
  await store.saveKill(rows);
  await store.recordScan(SOURCE.replayId, { state: "complete", buildSha: SOURCE.buildSha, killCount: 1 });
  await store.recordScan(99, { state: "failed", error: "boom" });
  assert.deepEqual([...(await store.settledReplayIds())], [SOURCE.replayId]);
  assert.equal(await store.applyViewers([{ id: rows.kill.id, url: "https://example.test/kill-cam/x/y" }]), 1);
  assert.equal(await store.applyViewers([{ id: rows.kill.id, url: "https://example.test/kill-cam/x/y" }]), 0);
  // The clip arrives later than the viewer; a link without one never clears it.
  assert.equal(await store.applyViewers([{ id: rows.kill.id, url: "https://example.test/kill-cam/x/y", clipUrl: "https://example.test/c.mp4" }]), 1);
  assert.equal(await store.applyViewers([{ id: rows.kill.id, url: "https://example.test/kill-cam/x/y", clipUrl: null }]), 0);
  const stored = await store.client.query("SELECT viewer_url, clip_url FROM kb_kills");
  assert.deepEqual(stored.rows, [{ viewer_url: "https://example.test/kill-cam/x/y", clip_url: "https://example.test/c.mp4" }]);
});

/** A copy of the fixture's player death at another sequence and time (minutes from now). */
function killAt(sequence, minutesFromNow) {
  const rows = killRows(SOURCE, PLAYER_DEATH);
  const occurredAt = Date.now() + minutesFromNow * 60 * 1000;
  return {
    kill: {
      ...rows.kill,
      id: `${SOURCE.replayId}:${sequence}`,
      sequence,
      shipItemId: `item${sequence}`,
      occurredAt: new Date(occurredAt).toISOString(),
      publicAt: new Date(occurredAt + PUBLICATION_DELAY_MILLISECONDS).toISOString(),
    },
    attackers: rows.attackers,
  };
}

/** Moves a kill's listing time, which only the schema's trigger writes, as if it had been written long ago. */
async function listAt(client, id, interval) {
  await client.query("ALTER TABLE kb_kills DISABLE TRIGGER kb_kills_listed_at");
  await client.query(`UPDATE kb_kills SET listed_at = now() + interval '${interval}' WHERE id = $1`, [id]);
  await client.query("ALTER TABLE kb_kills ENABLE TRIGGER kb_kills_listed_at");
}

test("a kill lists at its public time, or 30 seconds after a late write, and a rescan never moves it", async () => {
  const store = await freshStore();
  const live = killAt(1, -1);
  const late = killAt(2, -60);
  await store.saveKill(live);
  await store.saveKill(late);
  const listed = async () =>
    Object.fromEntries(
      (await store.client.query("SELECT id, listed_at, public_at, ingested_at FROM kb_kills")).rows.map((row) => [
        row.id,
        { listed: new Date(row.listed_at).getTime(), public: new Date(row.public_at).getTime(), written: new Date(row.ingested_at).getTime() },
      ])
    );
  const first = await listed();
  assert.equal(first[live.kill.id].listed, first[live.kill.id].public);
  assert.equal(first[late.kill.id].listed, first[late.kill.id].written + 30 * 1000);

  await store.saveKill(late);
  await store.client.query("UPDATE kb_kills SET viewer_url = 'https://example.test/v' WHERE id = $1", [late.kill.id]);
  assert.equal((await listed())[late.kill.id].listed, first[late.kill.id].listed);
});

test("readers see listed kills, their attackers and finished battles only through the public views", async () => {
  const store = await freshStore();
  const listed = killAt(1, -30);
  const pending = killAt(2, -29);
  await store.saveKill(listed);
  await store.saveKill(pending);
  await listAt(store.client, listed.kill.id, "-1 minute");
  await listAt(store.client, pending.kill.id, "1 minute");
  await store.rebuildBattles(SOURCE.replayId);

  const ids = async (sql) => (await store.client.query(sql)).rows.map((row) => row.id);
  assert.deepEqual(await ids("SELECT id FROM kb_public_kills"), [listed.kill.id]);
  assert.deepEqual(await ids("SELECT DISTINCT kill_id AS id FROM kb_public_attackers"), [listed.kill.id]);
  // The two kills chain into one battle, which waits for its last kill.
  assert.deepEqual(await ids("SELECT id FROM kb_battles"), [listed.kill.id]);
  assert.deepEqual(await ids("SELECT id FROM kb_public_battles"), []);
});

test("the region backfill gives breach kills without a zone id their session's region", async () => {
  const { backfillRegions } = require("../backfill-killboard-regions");
  const store = await freshStore();
  const breach = killAt(1, -30);
  const other = { ...killAt(2, -30), kill: { ...killAt(2, -30).kill, id: "777:2", replayId: 777 } };
  const hub = { ...killAt(3, -30), kill: { ...killAt(3, -30).kill, id: "888:3", replayId: 888, sessionKind: "hub" } };
  const reconnect = { ...killAt(4, -30), kill: { ...killAt(4, -30).kill, regionId: "orrery" } };
  for (const each of [breach, other, hub, reconnect]) await store.saveKill(each);
  const regionsOf = async (ids) =>
    ids.map((id) => ({ replay_id: id, region_id: { [SOURCE.replayId]: "cloud_wake", 888: "hub_region" }[id] ?? null }));
  const quiet = { log() {} };

  const dry = await backfillRegions(store.client, regionsOf, { log: quiet });
  assert.deepEqual(dry, { recordings: 2, kills: 1, withoutRegion: 1 });
  const zones = async () =>
    Object.fromEntries((await store.client.query("SELECT id, region_id FROM kb_kills ORDER BY id")).rows.map((r) => [r.id, r.region_id]));
  assert.equal((await zones())[breach.kill.id], "");

  await backfillRegions(store.client, regionsOf, { apply: true, log: quiet });
  assert.deepEqual(await zones(), {
    [breach.kill.id]: "cloud_wake",
    "777:2": "",
    "888:3": "",
    [reconnect.kill.id]: "orrery",
  });
});

test("the zone name backfill names event-route kills from their region id and renames their battles", async () => {
  const { backfillZoneNames } = require("../backfill-killboard-regions");
  const store = await freshStore();
  const unnamed = (sequence, minutes) => {
    const each = killAt(sequence, minutes);
    return { ...each, kill: { ...each.kill, regionId: "alpha_tournament_1", regionName: "" } };
  };
  for (const each of [unnamed(1, -30), unnamed(2, -29), killAt(3, -10)]) await store.saveKill(each);
  await store.rebuildBattles(SOURCE.replayId);
  const quiet = { log() {} };
  const names = new Map([["alpha_tournament_1", "CLOUD WAKE"]]);

  assert.deepEqual(await backfillZoneNames(store.client, names, { log: quiet }), { kills: 2, unknown: [] });
  await backfillZoneNames(store.client, names, { apply: true, log: quiet });
  const zones = (await store.client.query("SELECT region_name FROM kb_kills ORDER BY sequence")).rows.map((r) => r.region_name);
  assert.deepEqual(zones.slice(0, 2), ["CLOUD WAKE", "CLOUD WAKE"]);
  const battle = (await store.client.query("SELECT region_name FROM kb_battles")).rows[0];
  assert.equal(battle.region_name, "CLOUD WAKE");
});

test("the game data API's role reads only the public views, with a statement timeout", async () => {
  const db = new PGlite();
  await db.exec("CREATE ROLE killboard_api LOGIN");
  const store = new KillboardStore(db);
  await store.migrate();
  await store.migrate();
  const listed = killAt(1, -30);
  await store.saveKill(listed);
  await listAt(db, listed.kill.id, "-1 minute");

  await db.exec("SET ROLE killboard_api");
  assert.equal((await db.query("SELECT count(*)::int AS n FROM kb_public_kills")).rows[0].n, 1);
  for (const table of ["kb_kills", "kb_attackers", "kb_battles", "kb_scans"])
    await assert.rejects(db.query(`SELECT 1 FROM ${table}`), /permission denied/, table);
  await db.exec("RESET ROLE");
  const config = await db.query("SELECT rolconfig FROM pg_roles WHERE rolname = 'killboard_api'");
  assert.deepEqual(config.rows[0].rolconfig, ["statement_timeout=5s"]);
});

const fs = require("node:fs");
const os = require("node:os");
const { KillboardWorker, readViewerLinks, readReportManifests } = require("../lib/killboard/worker");

/** A follower that reports the fixture's deaths on its first sync and completes on the next. */
function fakeFollowerFactory(events, { failWith = null } = {}) {
  return (options) => ({
    replayId: Number(options.replay.replay_id),
    directory: options.directory,
    state: "starting",
    loading: false,
    ending: false,
    syncs: 0,
    get active() {
      return this.state === "starting" || this.state === "following";
    },
    async start() {
      this.state = "following";
    },
    finish() {
      this.ending = true;
    },
    async sync() {
      this.syncs++;
      if (this.syncs === 1) for (const event of events) options.onManifest(this, event);
      else this.state = failWith ? "failed" : "complete";
      if (failWith) this.error = failWith;
    },
    fail(message) {
      this.state = "failed";
      this.error = message;
    },
    async stop() {
      this.state = "stopped";
    },
  });
}

function replayRow(replayId, extra = {}) {
  return { replay_id: replayId, game_id: `g${replayId}`, app_version: "b-main:abc", room_name: "room", started_at: FIXTURE.replay.started_at, is_tutorial: false, ...extra };
}

function workerFor(store, overrides = {}) {
  return new KillboardWorker({
    client: {},
    store,
    dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), "killboard-")),
    resolveRuntime: async () => ({ commit: SOURCE.buildSha }),
    listLive: async () => [],
    listByIds: async (_client, ids) => ids.map((id) => replayRow(id)),
    log: { log() {}, error() {} },
    ...overrides,
  });
}

test("the worker stores a live recording's player deaths, then its battles and its scan", async () => {
  const store = await freshStore();
  const worker = workerFor(store, {
    listLive: async () => [replayRow(SOURCE.replayId)],
    createFollower: fakeFollowerFactory(FIXTURE.events),
  });
  await worker.tick();
  await worker.tick();
  const kills = await store.client.query("SELECT id, source, build_sha FROM kb_kills");
  assert.deepEqual(kills.rows, [{ id: `${SOURCE.replayId}:11`, source: "live", build_sha: SOURCE.buildSha }]);
  const scans = await store.client.query("SELECT replay_id, state, kill_count FROM kb_scans");
  assert.deepEqual(scans.rows, [{ replay_id: SOURCE.replayId, state: "complete", kill_count: 1 }]);
  // A scanned recording is not followed again.
  await worker.tick();
  assert.equal(worker.followers.size, 0);
});

test("the worker works through its backlog newest first, within its limit", async () => {
  const store = await freshStore();
  const started = [];
  const worker = workerFor(store, {
    maxBacklog: 1,
    backlog: async () => [3, 2, 1],
    createFollower: (options) => {
      started.push(Number(options.replay.replay_id));
      return fakeFollowerFactory([])(options);
    },
  });
  for (let index = 0; index < 6; index++) await worker.tick();
  assert.deepEqual(started, [3, 2, 1]);
});

test("a recording whose build has no live scanner is imported from its cached report", async () => {
  const store = await freshStore();
  const worker = workerFor(store, {
    backlog: async () => [SOURCE.replayId],
    resolveRuntime: async () => {
      throw Object.assign(new Error("predates live kill manifest streaming"), { code: "REPLAY_RUNTIME_NOT_LIVE" });
    },
    reportManifests: () => ({ runtimeCommit: "oldbuild", manifests: [PLAYER_DEATH.manifest] }),
  });
  await worker.tick();
  const kills = await store.client.query("SELECT id, source, value_total, build_sha FROM kb_kills");
  assert.deepEqual(kills.rows, [{ id: `${SOURCE.replayId}:11`, source: "report", value_total: null, build_sha: "oldbuild" }]);
});

test("viewer links reach every death of the fight whose last card carried one", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "killboard-posted-"));
  const file = path.join(directory, "posted.jsonl");
  fs.writeFileSync(
    file,
    [
      { key: "9:1", outcome: "posted", fight: "9:1" },
      { key: "9:2", outcome: "posted", fight: "9:1", viewer: "https://x.test/v", clipUrl: "https://x.test/c.mp4" },
      { key: "clip:9:1", outcome: "clip-posted", fight: "9:1" },
      { key: "9:5", outcome: "suppressed" },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n"
  );
  assert.deepEqual(readViewerLinks(file), [
    { id: "9:1", url: "https://x.test/v", clipUrl: "https://x.test/c.mp4" },
    { id: "9:2", url: "https://x.test/v", clipUrl: "https://x.test/c.mp4" },
  ]);
});

test("a cached report yields its player-death manifests in either field casing", () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), "killboard-cache-"));
  fs.mkdirSync(path.join(cache, "5"));
  fs.writeFileSync(
    path.join(cache, "5", "telemetry-report.json"),
    JSON.stringify({ runtimeCommit: "c", manifests: [{ victimIsNpc: true }, { VictimIsNpc: false, Sequence: 1 }, { victimIsNpc: false, sequence: 2 }] })
  );
  assert.equal(readReportManifests(cache, 5).manifests.length, 2);
  assert.equal(readReportManifests(cache, 6), null);
});

test("live breaches claim the worker's live capacity before hub rooms", async () => {
  const store = await freshStore();
  const started = [];
  const worker = workerFor(store, {
    maxLive: 1,
    listLive: async () => [replayRow(1, { room_name: "hub:forge:0" }), replayRow(2, { room_name: "breach-room" })],
    createFollower: (options) => {
      started.push(Number(options.replay.replay_id));
      return fakeFollowerFactory([])(options);
    },
  });
  await worker.tick();
  assert.deepEqual(started, [2]);
});

test("each module on the kill card carries its recorded roll from the manifest", () => {
  const { kill } = killRows(SOURCE, PLAYER_DEATH);
  const flak = kill.card.fitting.items.find((item) => item.name === "FLAK CANNON");
  assert.deepEqual(flak.facts, {
    quality: "Faction",
    pointRating: 180,
    charges: 0,
    isHarmonized: false,
    isMirrored: false,
    modifiers: [],
  });
  const rolled = killRows(SOURCE, {
    ...PLAYER_DEATH,
    manifest: {
      ...PLAYER_DEATH.manifest,
      fitting: {
        ...PLAYER_DEATH.manifest.fitting,
        items: PLAYER_DEATH.manifest.fitting.items.map((item) =>
          item.itemId === flak.itemId
            ? { ...item, rolledModifiers: [{ statType: "TurretRange", operation: "Multiply", modifierTier: 3, value: { raw: 1, value: 1.08 }, slot: 0, isFractured: false }] }
            : item
        ),
      },
    },
  });
  assert.deepEqual(rolled.kill.card.fitting.items.find((item) => item.itemId === flak.itemId).facts.modifiers, [
    { stat: "TurretRange", operation: "Multiply", tier: 3, value: 1.08, isFractured: false },
  ]);
  assert.equal(killRows(SOURCE, { ...PLAYER_DEATH, card: null }).kill.card, null);
  // Each attacker carries the weapon that dealt its most damage.
  assert.deepEqual(kill.card.attackers[0].weapon, {
    prototype: "Content/SessionDestinations/Shared/Quantum/Modules/Turrets/Railgun Variants/RailgunEntityPrototype",
    def: BigInt("0x1414CA720B9DF1DF").toString(),
  });
});
