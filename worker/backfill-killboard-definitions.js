#!/usr/bin/env node
"use strict";

// One-time backfill of the game's definition ids (decimal asset GUIDs) on killboard rows recorded
// before the worker kept them. Dry run by default; --apply writes.
//
//   KILLBOARD_DATABASE_URL=... node backfill-killboard-definitions.js [--apply] [--runtime-root <dir>]
//
// Each row's stored prototype paths are looked up in db.json of the runtime bundle of the row's
// own build (<runtime-root>/<build sha>/db.json, default runtime/ beside this script). Rows whose
// bundle is not on this machine, and paths that bundle does not hold, stay without ids; the site
// shows those as named placeholders. Nothing is matched by name.

const path = require("node:path");
const { DATA_ROOT } = require("./lib/config");
const { planBackfill, bundleIndexLoader } = require("./lib/killboard/backfill-definitions");

const USAGE = "usage: node backfill-killboard-definitions.js [--apply] [--runtime-root <dir>]";
const BATCH = 500;

/**
 * Backfills through `client` (pg's query(text, params)). Returns the totals; writes only with apply.
 */
async function backfillDefinitions(client, { runtimeRoot, apply = false, log = console }) {
  const loadIndex = bundleIndexLoader(runtimeRoot);
  const totals = { kills: 0, killsUpdated: 0, attackersUpdated: 0, filled: 0, withoutBundle: 0, changedMeanwhile: 0, missingBuilds: new Set() };
  let after = "";
  for (;;) {
    const kills = (
      await client.query(
        `SELECT id, build_sha, card, hull_def, final_blow_hull_def FROM kb_kills WHERE id > $1 ORDER BY id LIMIT ${BATCH}`,
        [after],
      )
    ).rows;
    if (kills.length === 0) break;
    after = kills.at(-1).id;
    const attackers = (
      await client.query(`SELECT kill_id, ordinal, hull_def, is_final_blow FROM kb_attackers WHERE kill_id = ANY($1::text[])`, [
        kills.map((kill) => kill.id),
      ])
    ).rows;
    const plan = planBackfill(kills, attackers, loadIndex);
    totals.kills += kills.length;
    totals.killsUpdated += plan.kills.length;
    totals.attackersUpdated += plan.attackers.length;
    totals.filled += plan.filled;
    totals.withoutBundle += plan.withoutBundle;
    for (const build of plan.missingBuilds) totals.missingBuilds.add(build);
    if (!apply) continue;
    // One transaction per batch. A row is written only if its card is still the one read: the
    // worker's rescan may have replaced it meanwhile with a newer card, which is left alone.
    const original = new Map(kills.map((kill) => [kill.id, kill.card]));
    await client.query("BEGIN");
    try {
      const conflicted = new Set();
      for (const update of plan.kills) {
        const written = await client.query(
          `UPDATE kb_kills SET card = COALESCE($2::jsonb, card), hull_def = COALESCE(hull_def, $3),
           final_blow_hull_def = COALESCE(final_blow_hull_def, $4)
           WHERE id = $1 AND card IS NOT DISTINCT FROM $5::jsonb`,
          [
            update.id,
            update.card ? JSON.stringify(update.card) : null,
            update.hullDef,
            update.finalBlowHullDef,
            original.get(update.id) == null ? null : JSON.stringify(original.get(update.id)),
          ],
        );
        if (written.rowCount === 0) {
          totals.changedMeanwhile += 1;
          conflicted.add(update.id);
        }
      }
      for (const update of plan.attackers.filter((each) => !conflicted.has(each.killId)))
        await client.query(`UPDATE kb_attackers SET hull_def = COALESCE(hull_def, $3) WHERE kill_id = $1 AND ordinal = $2`, [
          update.killId,
          update.ordinal,
          update.hullDef,
        ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  log.log(
    `${apply ? "applied" : "dry run"}: ${totals.kills} kills read, ${totals.killsUpdated} kills and ${totals.attackersUpdated} attackers ` +
      `${apply ? "updated" : "would be updated"} (${totals.filled} ids found in card), ${totals.withoutBundle} kills left as they were ` +
      `for lack of their build's bundle, ${totals.changedMeanwhile} skipped because a rescan rewrote them meanwhile${totals.missingBuilds.size ? ` (${[...totals.missingBuilds].join(", ")})` : ""}`,
  );
  return totals;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const rootAt = args.indexOf("--runtime-root");
  const known = new Set(["--apply", "--runtime-root", rootAt >= 0 ? args[rootAt + 1] : null]);
  if (args.some((arg) => !known.has(arg))) throw new Error(USAGE);
  if (!process.env.KILLBOARD_DATABASE_URL) throw new Error("Set KILLBOARD_DATABASE_URL (a writer role).");
  const { Client } = require("pg");
  const client = new Client({ connectionString: process.env.KILLBOARD_DATABASE_URL });
  await client.connect();
  try {
    await backfillDefinitions(client, {
      runtimeRoot: path.resolve(rootAt >= 0 ? args[rootAt + 1] : path.join(DATA_ROOT, "runtime")),
      apply,
    });
  } finally {
    await client.end();
  }
}

module.exports = { backfillDefinitions };

if (require.main === module)
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exit(1);
  });
