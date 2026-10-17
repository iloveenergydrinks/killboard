"use strict";

// Which recordings the worker follows: main-branch deployments, as the replay dashboard reads them
// (tools/ship-restore/lib/dashboard-queries.js in the monorepo), less the ones whose recovery was
// waived.

const MAIN_APP_VERSION_PATTERN =
  "^((b-main|main|b-proto-main|proto/main):[0-9a-f]{7,40}|CPHMGL5Z|AKNLEL44)$";

// Recovery explicitly waived on 2026-09-18 for these recordings.
const IGNORED_REPLAY_IDS = Object.freeze([
  12836, 12842, 12849,
  16954, 16958, 16959, 16960, 16961, 16962, 16969, 16971, 16972,
  16973, 16974, 16975, 16976, 16977, 16978, 16979, 16980, 16981,
  18900, // Historical cargo seeding requires Unity asset names.
]);

module.exports = { MAIN_APP_VERSION_PATTERN, IGNORED_REPLAY_IDS };
