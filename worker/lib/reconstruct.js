"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * Rebuilds a QuantumReplayFile JSON for one recorded session from the webhook DB.
 *
 * Mapping (verified against Quantum's GetRecordedReplay encoding):
 * - InputHistoryDeltaCompressed = { Base64: concat(decoded chunk bytes), IsCompressed: false }
 *   (webhook chunks are raw delta-compressed input stream segments, NOT gzipped)
 * - RuntimeConfigData           = { Base64: replays.runtime_config,      IsCompressed: false }
 *   (the column is already gzip of the serialized RuntimeConfig; ConfigFromByteArray
 *    decompresses it — do not set IsCompressed here or Decode() will gunzip twice)
 * - DeterministicConfig         = replays.session_config (verbatim JSON object)
 */
async function reconstruct(client, replayIdOrGameId, outputDir) {
  const replayRow = await loadReplay(client, replayIdOrGameId);
  if (!replayRow) throw new Error(`No replay found for '${replayIdOrGameId}'.`);

  const chunks = await client.query(
    `SELECT chunk_number, is_last, last_tick, tick_count, tick_count_total,
            is_compressed, input
       FROM replay_chunks
      WHERE game_id = $1
      ORDER BY chunk_number`,
    [replayRow.game_id]
  );

  if (chunks.rows.length === 0)
    throw new Error(`Replay ${replayRow.id} has no recorded chunks.`);

  const completeStream = validateChunks(chunks.rows, replayRow.id);
  const parts = [];
  let lastTick = 0;
  for (const chunk of chunks.rows) {
    parts.push(Buffer.from(chunk.input, "base64"));
    lastTick = Math.max(lastTick, chunk.last_tick ?? 0);
  }
  const combinedInput = Buffer.concat(parts).toString("base64");

  const replayFile = {
    ...replayHeader(replayRow),
    InputHistoryDeltaCompressed: {
      Base64: combinedInput,
      IsCompressed: false,
    },
    LastTick: lastTick,
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const replayPath = path.join(outputDir, "replay.json");
  fs.writeFileSync(replayPath, JSON.stringify(replayFile));

  const meta = {
    replayId: replayRow.id,
    gameId: replayRow.game_id,
    roomName: replayRow.room_name,
    appVersion: replayRow.app_version,
    region: replayRow.region,
    createdAt: replayRow.created_at,
    sessionKind: replayRow.is_hub_session == null ? "unknown" : replayRow.is_hub_session ? "hub" : "breach",
    chunkCount: chunks.rows.length,
    completeStream,
    lastTick,
    inputBytes: Buffer.byteLength(combinedInput, "base64"),
    files: { replay: path.resolve(replayPath) },
  };
  const metaPath = path.join(outputDir, "meta.json");
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  return { replayPath, metaPath, meta };
}

/** The recorded session header shared by whole-replay reconstruction and live following. */
function replayHeader(replayRow) {
  return {
    RuntimeConfigData: {
      Base64: replayRow.runtime_config,
      IsCompressed: false,
    },
    DeterministicConfig: replayRow.session_config,
    InitialTick: 0,
  };
}

/**
 * Accepts recorded chunks in arrival order. Whole-replay reconstruction and live following
 * share these continuity rules, so a streamed prefix is valid exactly when reconstruction
 * would accept it.
 */
class ChunkSequence {
  constructor(replayId) {
    this.replayId = replayId;
    this.nextChunk = 0;
    this.tickCountTotal = 0;
    this.lastTick = -1;
    this.complete = false;
  }

  accept(chunk) {
    const replayId = this.replayId;
    const index = this.nextChunk;
    if (this.complete)
      throw new Error(`Replay ${replayId} marks non-terminal chunk ${index - 1} as last.`);
    if (chunk.chunk_number !== index)
      throw new Error(
        `Replay ${replayId} chunk gap: expected ${index}, got ${chunk.chunk_number}.`
      );
    if (!Number.isInteger(chunk.tick_count) || chunk.tick_count < 0)
      throw new Error(
        `Replay ${replayId} chunk ${index} has invalid tick_count ${chunk.tick_count}.`
      );
    if (chunk.tick_count_total !== this.tickCountTotal + chunk.tick_count)
      throw new Error(
        `Replay ${replayId} chunk ${index} has tick_count_total ` +
          `${chunk.tick_count_total}; expected ${this.tickCountTotal + chunk.tick_count}.`
      );
    if (!Number.isInteger(chunk.last_tick) || chunk.last_tick < this.lastTick)
      throw new Error(
        `Replay ${replayId} chunk ${index} has non-monotonic last_tick ${chunk.last_tick}.`
      );
    if (chunk.is_compressed)
      throw new Error(
        `Chunk ${index} is flagged compressed; this tool only handles ` +
          "raw webhook segments. Extend reconstruction before proceeding."
      );

    this.nextChunk++;
    this.tickCountTotal = chunk.tick_count_total;
    this.lastTick = chunk.last_tick;
    this.complete = Boolean(chunk.is_last);
  }
}

function validateChunks(chunks, replayId) {
  const sequence = new ChunkSequence(replayId);
  for (const chunk of chunks) sequence.accept(chunk);
  return sequence.complete;
}

async function loadReplay(client, key) {
  const byId = /^\d+$/;
  const res = byId.test(key)
    ? await client.query(
        `SELECT r.id, r.game_id, r.app_id, r.app_version, r.region, r.cloud,
                r.room_name, r.session_config, r.runtime_config,
                r.created_at::text AS created_at,
                (SELECT (ge.payload->'runtimeConfig'->>'isHubSession')::boolean
                   FROM game_events ge
                  WHERE ge.game_id = r.game_id AND ge.event_type = 'configs'
                  LIMIT 1) AS is_hub_session
           FROM replays r WHERE r.id = $1`,
        [Number(key)]
      )
    : await client.query(
        `SELECT r.id, r.game_id, r.app_id, r.app_version, r.region, r.cloud,
                r.room_name, r.session_config, r.runtime_config,
                r.created_at::text AS created_at,
                (SELECT (ge.payload->'runtimeConfig'->>'isHubSession')::boolean
                   FROM game_events ge
                  WHERE ge.game_id = r.game_id AND ge.event_type = 'configs'
                  LIMIT 1) AS is_hub_session
           FROM replays r WHERE r.game_id LIKE $1`,
        [`${key}%`]
      );
  return res.rows[0] ?? null;
}

module.exports = { reconstruct, validateChunks, ChunkSequence, replayHeader, loadReplay };
