#!/usr/bin/env node
"use strict";

// One-time backfill of the zone id on killboard kills recorded before the worker kept the session's
// region. Dry run by default; --apply writes.
//
//   KILLBOARD_DATABASE_URL=... DATABASE_URL=... node backfill-killboard-regions.js [--apply]
//
// A breach kill without a region id takes the region its recording's session was deployed to
// (runtimeConfig.selectedTravelRegionId in the recordings database), as the worker now does for
// new kills. Hub kills have no region, and a kill that already has one keeps it.
//
// Then a kill with a region id but no zone name (an event route: scanners before the fix in
// KillCardFacts.Location named only the public regions) takes that region's name from the game data
// API's /v1/zones, by id, and its recording's battles are rebuilt so they name the zone too.

const { connect } = require("./lib/db");
const { listReplays } = require("./lib/kill-feed/live-replays");
const { KillboardStore } = require("./lib/killboard/store");

const USAGE = "usage: node backfill-killboard-regions.js [--apply]";
const BATCH = 200;

/**
 * Backfills `killboard` (pg's query(text, params)) from `regionsOf(replayIds)`, which resolves to
 * [{ replay_id, region_id }]. Returns the totals; writes only with apply.
 */
async function backfillRegions(killboard, regionsOf, { apply = false, log = console } = {}) {
  const replayIds = (
    await killboard.query(
      `SELECT DISTINCT replay_id FROM kb_kills WHERE region_id = '' AND session_kind = 'breach' ORDER BY replay_id`,
    )
  ).rows.map((row) => Number(row.replay_id));
  const totals = { recordings: replayIds.length, kills: 0, withoutRegion: 0 };
  for (let start = 0; start < replayIds.length; start += BATCH) {
    const batch = replayIds.slice(start, start + BATCH);
    const regions = new Map((await regionsOf(batch)).map((row) => [Number(row.replay_id), row.region_id ?? ""]));
    for (const replayId of batch) {
      const regionId = regions.get(replayId) ?? "";
      if (!regionId) {
        totals.withoutRegion += 1;
        continue;
      }
      const query = apply
        ? `UPDATE kb_kills SET region_id = $2 WHERE replay_id = $1 AND region_id = '' AND session_kind = 'breach'`
        : `SELECT 1 FROM kb_kills WHERE replay_id = $1 AND region_id = '' AND session_kind = 'breach' AND $2::text <> ''`;
      const result = await killboard.query(query, [replayId, regionId]);
      totals.kills += result.rowCount ?? result.rows.length;
    }
  }
  log.log(
    `${apply ? "applied" : "dry run"}: ${totals.kills} kills in ${totals.recordings - totals.withoutRegion} recordings ` +
      `${apply ? "given" : "would get"} their zone id; ${totals.withoutRegion} recordings have no region on record`,
  );
  return totals;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply")) throw new Error(USAGE);
  if (!process.env.KILLBOARD_DATABASE_URL) throw new Error("Set KILLBOARD_DATABASE_URL (a writer role).");
  const { Client } = require("pg");
  const killboard = new Client({ connectionString: process.env.KILLBOARD_DATABASE_URL });
  await killboard.connect();
  const recordings = await connect();
  try {
    await backfillRegions(killboard, (ids) => listReplays(recordings, ids), { apply: args.includes("--apply") });
    await backfillZoneNames(killboard, await fetchZoneNames(), { apply: args.includes("--apply") });
  } finally {
    await recordings.end();
    await killboard.end();
  }
}

/**
 * Names the zone of kills that have a region id but no name, from `zoneNames` (a Map of region id
 * to the game's name for it), and rebuilds their recordings' battles. Writes only with apply.
 */
async function backfillZoneNames(killboard, zoneNames, { apply = false, log = console } = {}) {
  const rows = (
    await killboard.query(
      `SELECT region_id, array_agg(DISTINCT replay_id) AS replays, count(*)::int AS kills
       FROM kb_kills WHERE region_name = '' AND region_id <> '' GROUP BY region_id ORDER BY region_id`,
    )
  ).rows;
  const totals = { kills: 0, unknown: [] };
  const replays = new Set();
  for (const row of rows) {
    const name = zoneNames.get(row.region_id);
    if (!name) {
      totals.unknown.push(row.region_id);
      continue;
    }
    totals.kills += row.kills;
    for (const replayId of row.replays) replays.add(Number(replayId));
    if (apply)
      await killboard.query(`UPDATE kb_kills SET region_name = $2 WHERE region_id = $1 AND region_name = ''`, [
        row.region_id,
        name,
      ]);
  }
  if (apply) {
    const store = new KillboardStore(killboard);
    for (const replayId of replays) await store.rebuildBattles(replayId);
  }
  log.log(
    `${apply ? "applied" : "dry run"}: ${totals.kills} kills in ${replays.size} recordings ${apply ? "given" : "would get"} ` +
      `their zone's name${totals.unknown.length ? `; no name for ${totals.unknown.join(", ")}` : ""}`,
  );
  return totals;
}

/** The game's zone names by region id, from the game data API (GAME_DATA_API_URL). */
async function fetchZoneNames() {
  const base = (process.env.GAME_DATA_API_URL || "https://api.thecitadel.com").replace(/\/+$/, "");
  const response = await fetch(`${base}/v1/zones`, {
    headers: { "User-Agent": "CitadelKillboardWorker/1.0 (+https://wrecks.gg)" },
  });
  if (!response.ok) throw new Error(`/v1/zones answered ${response.status}`);
  const { zones } = await response.json();
  return new Map(zones.map((zone) => [zone.id, zone.name]));
}

module.exports = { backfillRegions, backfillZoneNames };

if (require.main === module)
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
