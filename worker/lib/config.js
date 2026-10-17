"use strict";

const path = require("node:path");

// The replay VM's data folder (REPLAY_DATA_ROOT): the retained game runtimes the scanner plays
// recordings with (runtime/), the dashboard's analytics.sqlite and cached reports, and the kill
// feed's posted.jsonl. The worker shares them with the replay dashboard and kill feed on that host.
const DATA_ROOT = path.resolve(process.env.REPLAY_DATA_ROOT || "/var/lib/citadel-replays");

/** The recordings database (REPLAY_DATABASE_URL), a read-only role with verify-full TLS. */
function databaseUrl() {
  const configured = process.env.REPLAY_DATABASE_URL;
  if (!configured) throw new Error("Set REPLAY_DATABASE_URL.");
  const url = new URL(configured);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.searchParams.get("sslmode") !== "verify-full")
    throw new Error("REPLAY_DATABASE_URL must be a Postgres URL with sslmode=verify-full.");
  return configured;
}

module.exports = { databaseUrl, DATA_ROOT };
