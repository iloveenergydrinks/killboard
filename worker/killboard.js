#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { connect } = require("./lib/db");
const { DATA_ROOT } = require("./lib/config");
const { KillboardStore } = require("./lib/killboard/store");
const { KillboardWorker, readViewerLinks, readReportManifests } = require("./lib/killboard/worker");

const USAGE = `usage: node killboard.js [--every 15s] [--max-live 6] [--max-backlog 2]
       node killboard.js --migrate

Keeps the killboard database in KILLBOARD_DATABASE_URL (a writer role) current: follows live
main-build recordings, works through earlier recordings with player deaths (newest first, from
the replay dashboard's analytics and the kill feed's record), and links kills to the kill cam
viewer pages the kill feed published. Applies the killboard schema on start; --migrate applies it
and exits, for a database whose worker runs elsewhere.`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.KILLBOARD_DATABASE_URL) throw new Error("Set KILLBOARD_DATABASE_URL.");
  const killboard = new Client({ connectionString: process.env.KILLBOARD_DATABASE_URL });
  await killboard.connect();
  const store = new KillboardStore(killboard);
  await store.migrate();
  if (args.migrateOnly) {
    await killboard.end();
    console.log("killboard schema applied");
    return;
  }
  const client = await connect();

  const postedFile = path.join(DATA_ROOT, "kill-feed", "posted.jsonl");
  const worker = new KillboardWorker({
    client,
    store,
    dataRoot: DATA_ROOT,
    maxLive: args.maxLive,
    maxBacklog: args.maxBacklog,
    backlog: async () => (args.maxBacklog > 0 ? backlogReplayIds(postedFile) : []),
    reportManifests: (replayId) => readReportManifests(path.join(DATA_ROOT, "dashboard-cache"), replayId),
    viewerLinks: () => readViewerLinks(postedFile),
  });

  let stopping = false;
  const stop = () => (stopping = true);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  console.log(`killboard polling every ${args.every / 1000}s; up to ${args.maxLive} live and ${args.maxBacklog} backlog replays`);
  try {
    while (!stopping) {
      try {
        await worker.tick();
      } catch (error) {
        console.error(`killboard poll failed: ${error.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, args.every));
    }
  } finally {
    await worker.close();
    await client.end();
    await killboard.end();
  }
}

/**
 * Recordings with a player death, newest first: those the replay dashboard's analytics saw a
 * ship lost or a death manifest in, and those the kill feed handled a death from.
 */
function backlogReplayIds(postedFile) {
  const ids = new Set();
  const analytics = path.join(DATA_ROOT, "analytics.sqlite");
  if (fs.existsSync(analytics)) {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(analytics, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `SELECT DISTINCT replay_id FROM runs
           WHERE outcome = 'ship-lost' OR COALESCE(json_extract(data, '$.manifestDeaths'), 0) > 0`
        )
        .all();
      for (const row of rows) ids.add(Number(row.replay_id));
    } finally {
      db.close();
    }
  }
  if (fs.existsSync(postedFile))
    for (const line of fs.readFileSync(postedFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record.replayId) ids.add(Number(record.replayId));
    }
  return [...ids].sort((a, b) => b - a);
}

function parseArgs(argv) {
  const args = { every: 15_000, maxLive: 6, maxBacklog: 2, migrateOnly: false };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index + 1];
    switch (argv[index]) {
      case "--every": {
        const match = /^(\d+)(s|m)$/.exec(value ?? "");
        if (!match) throw new Error("--every must look like 15s or 1m.");
        args.every = Number(match[1]) * (match[2] === "m" ? 60_000 : 1_000);
        index++;
        break;
      }
      case "--max-live":
      case "--max-backlog": {
        const count = Number(value);
        if (!Number.isInteger(count) || count < 0) throw new Error(`${argv[index]} must be a non-negative integer.`);
        args[argv[index] === "--max-live" ? "maxLive" : "maxBacklog"] = count;
        index++;
        break;
      }
      case "--migrate":
        args.migrateOnly = true;
        break;
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown option '${argv[index]}'.\n${USAGE}`);
    }
  }
  return args;
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
