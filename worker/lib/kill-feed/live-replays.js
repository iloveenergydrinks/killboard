"use strict";

const { MAIN_APP_VERSION_PATTERN, IGNORED_REPLAY_IDS } = require("../recordings");

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/**
 * Dashboard-population recordings whose newest chunk arrived within `windowSeconds`.
 * The newest chunk, not the start time, decides liveness: a hub room can record for hours.
 */
async function listLiveReplays(client, { windowSeconds, startedWithinSeconds }) {
  const result = await client.query(
    `WITH candidates AS MATERIALIZED (
       SELECT r.id, r.game_id, r.app_version, r.room_name, r.created_at
       FROM replays r
       WHERE r.app_version ~* $1
         AND NOT (r.id = ANY($2::integer[]))
         AND r.created_at >= (NOW() AT TIME ZONE 'UTC') - MAKE_INTERVAL(secs => $4)
     ),
     live AS MATERIALIZED (
       SELECT c.*, latest.chunk_number AS last_chunk, latest.is_last, latest.created_at AS last_chunk_at
       FROM candidates c
       CROSS JOIN LATERAL (
         SELECT rc.chunk_number, rc.is_last, rc.created_at
         FROM replay_chunks rc
         WHERE rc.game_id = c.game_id
         ORDER BY rc.chunk_number DESC
         LIMIT 1
       ) latest
       WHERE latest.created_at >= (NOW() AT TIME ZONE 'UTC') - MAKE_INTERVAL(secs => $3)
     )
     SELECT
       live.id AS replay_id,
       live.game_id,
       live.app_version,
       live.room_name,
       TO_CHAR(live.created_at, ${ISO_UTC}) AS started_at,
       live.last_chunk,
       live.is_last AS complete,
       TO_CHAR(live.last_chunk_at, ${ISO_UTC}) AS last_chunk_at,
       COALESCE(config.is_tutorial, false) AS is_tutorial,
       config.region_id
     FROM live
     LEFT JOIN LATERAL (
       SELECT NULLIF(ge.payload->'runtimeConfig'->>'isTutorialSession', '')::boolean AS is_tutorial,
              NULLIF(ge.payload->'runtimeConfig'->>'selectedTravelRegionId', '') AS region_id
       FROM game_events ge
       WHERE ge.game_id = live.game_id AND ge.event_type = 'configs'
       ORDER BY ge.created_at DESC
       LIMIT 1
     ) config ON true
     ORDER BY live.created_at`,
    [MAIN_APP_VERSION_PATTERN, IGNORED_REPLAY_IDS, windowSeconds, startedWithinSeconds]
  );
  return result.rows;
}

/** The named recordings in the live listing's shape, for following them from their start. */
async function listReplays(client, replayIds) {
  const result = await client.query(
    `SELECT r.id AS replay_id, r.game_id, r.app_version, r.room_name,
            TO_CHAR(r.created_at, ${ISO_UTC}) AS started_at,
            COALESCE(config.is_tutorial, false) AS is_tutorial,
            config.region_id
     FROM replays r
     LEFT JOIN LATERAL (
       SELECT NULLIF(ge.payload->'runtimeConfig'->>'isTutorialSession', '')::boolean AS is_tutorial,
              NULLIF(ge.payload->'runtimeConfig'->>'selectedTravelRegionId', '') AS region_id
       FROM game_events ge
       WHERE ge.game_id = r.game_id AND ge.event_type = 'configs'
       ORDER BY ge.created_at DESC
       LIMIT 1
     ) config ON true
     WHERE r.id = ANY($1::integer[])
     ORDER BY r.created_at`,
    [replayIds]
  );
  return result.rows;
}

/** Recorded chunks from `fromChunk` onward, in chunk order. */
async function loadChunks(client, gameId, fromChunk) {
  const result = await client.query(
    `SELECT chunk_number, last_tick, tick_count, tick_count_total, is_last, is_compressed, input
     FROM replay_chunks
     WHERE game_id = $1 AND chunk_number >= $2
     ORDER BY chunk_number`,
    [gameId, fromChunk]
  );
  return result.rows;
}

module.exports = { listLiveReplays, listReplays, loadChunks };
