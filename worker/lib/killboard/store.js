"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { groupBattles } = require("./battles");

const SCHEMA = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
// A reconnect loss repeats the breach death of the same ship within this window (as in the kill feed).
const SAME_LOSS_WINDOW = "24 hours";

const KILL_COLUMNS = [
  ["id", "id"],
  ["replay_id", "replayId"],
  ["sequence", "sequence"],
  ["build_sha", "buildSha"],
  ["session_kind", "sessionKind"],
  ["occurred_at", "occurredAt"],
  ["public_at", "publicAt"],
  ["death_cause", "deathCause"],
  ["region_id", "regionId"],
  ["region_name", "regionName"],
  ["tier", "tier"],
  ["is_travel_lane", "isTravelLane"],
  ["victim_user_id", "victimUserId"],
  ["victim_name", "victimName"],
  ["ship_item_id", "shipItemId"],
  ["hull_name", "hullName"],
  ["hull_def", "hullDef"],
  ["hull_class", "hullClass"],
  ["hull_rarity", "hullRarity"],
  ["victim_br", "victimBr"],
  ["value_hull", "valueHull"],
  ["value_fitting", "valueFitting"],
  ["value_cargo", "valueCargo"],
  ["value_total", "valueTotal"],
  ["total_damage", "totalDamage"],
  ["attacker_count", "attackerCount"],
  ["player_attacker_count", "playerAttackerCount"],
  ["is_pvp", "isPvp"],
  ["is_solo", "isSolo"],
  ["final_blow_name", "finalBlowName"],
  ["final_blow_user_id", "finalBlowUserId"],
  ["final_blow_hull", "finalBlowHull"],
  ["final_blow_hull_def", "finalBlowHullDef"],
  ["card", "card"],
  ["source", "source"],
];

const DEFINITION_COLUMNS = new Set(["hull_def", "final_blow_hull_def"]);

const ATTACKER_COLUMNS = [
  ["ordinal", "ordinal"],
  ["is_player", "isPlayer"],
  ["user_id", "userId"],
  ["name", "name"],
  ["hull_name", "hullName"],
  ["hull_def", "hullDef"],
  ["hull_class", "hullClass"],
  ["build_rating", "buildRating"],
  ["damage", "damage"],
  ["shield_damage", "shieldDamage"],
  ["is_final_blow", "isFinalBlow"],
];

/**
 * The killboard database, as its worker writes it. `client` speaks pg's query(text, params).
 * Writes are idempotent: a kill is keyed by its recording and sequence, so rescanning a
 * recording rewrites the same rows, and a recording's battles are rebuilt whole.
 */
class KillboardStore {
  constructor(client) {
    this.client = client;
  }

  async migrate() {
    // pg runs a parameterless multi-statement query; PGlite needs exec for it.
    if (typeof this.client.exec === "function") await this.client.exec(SCHEMA);
    else await this.client.query(SCHEMA);
  }

  /**
   * Saves one kill and its attackers. Returns false when it is a reconnect loss that repeats a
   * recorded breach death of the same ship; a breach death recorded after its reconnect loss
   * replaces that loss.
   */
  async saveKill({ kill, attackers }) {
    return this.transaction(async () => {
      if (kill.shipItemId) {
        const sameLoss = await this.client.query(
          `SELECT id, death_cause FROM kb_kills
           WHERE ship_item_id = $1 AND id <> $2
             AND (death_cause = 'ReconnectLoss') <> ($3 = 'ReconnectLoss')
             AND occurred_at BETWEEN $4::timestamptz - interval '${SAME_LOSS_WINDOW}' AND $4::timestamptz + interval '${SAME_LOSS_WINDOW}'`,
          [kill.shipItemId, kill.id, kill.deathCause, kill.occurredAt]
        );
        if (sameLoss.rows.length > 0) {
          if (kill.deathCause === "ReconnectLoss") return false;
          await this.client.query("DELETE FROM kb_kills WHERE id = ANY($1::text[])", [sameLoss.rows.map((row) => row.id)]);
        }
      }

      const names = KILL_COLUMNS.map(([column]) => column);
      const values = KILL_COLUMNS.map(([column, field]) => (column === "card" && kill.card ? JSON.stringify(kill.card) : kill[field] ?? null));
      await this.client.query(
        `INSERT INTO kb_kills (${names.join(", ")}, ingested_at)
         VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")}, now())
         ON CONFLICT (id) DO UPDATE SET
         ${names
           .filter((name) => name !== "id")
           // A rescan that kept no definition ids does not erase ones the backfill filled.
           .map((name) => (DEFINITION_COLUMNS.has(name) ? `${name} = COALESCE(EXCLUDED.${name}, kb_kills.${name})` : `${name} = EXCLUDED.${name}`))
           .join(", ")},
         ingested_at = now()`,
        values
      );
      const known = new Map(
        (await this.client.query("SELECT ordinal, hull_def FROM kb_attackers WHERE kill_id = $1", [kill.id])).rows.map((row) => [row.ordinal, row.hull_def]),
      );
      await this.client.query("DELETE FROM kb_attackers WHERE kill_id = $1", [kill.id]);
      for (const attacker of attackers) {
        const columns = ATTACKER_COLUMNS.map(([column]) => column);
        await this.client.query(
          `INSERT INTO kb_attackers (kill_id, ${columns.join(", ")})
           VALUES ($1, ${columns.map((_, index) => `$${index + 2}`).join(", ")})`,
          [kill.id, ...ATTACKER_COLUMNS.map(([column, field]) => (column === "hull_def" ? attacker[field] ?? known.get(attacker.ordinal) ?? null : attacker[field]))]
        );
      }
      return true;
    });
  }

  /** Regroups one recording's kills into battles and links each kill to its battle. */
  async rebuildBattles(replayId) {
    const kills = await this.client.query(
      `SELECT k.id, k.replay_id, k.sequence, k.occurred_at, k.public_at, k.region_name, k.value_total, k.victim_user_id,
              COALESCE(array_agg(a.user_id) FILTER (WHERE a.is_player AND a.user_id <> ''), '{}') AS attacker_user_ids
       FROM kb_kills k LEFT JOIN kb_attackers a ON a.kill_id = k.id
       WHERE k.replay_id = $1
       GROUP BY k.id`,
      [replayId]
    );
    const { battles, battleOf } = groupBattles(
      kills.rows.map((row) => ({
        id: row.id,
        replayId: Number(row.replay_id),
        sequence: Number(row.sequence),
        occurredAt: new Date(row.occurred_at).getTime(),
        publicAt: new Date(row.public_at).getTime(),
        regionName: row.region_name,
        valueTotal: row.value_total == null ? null : Number(row.value_total),
        victimUserId: row.victim_user_id,
        attackerUserIds: row.attacker_user_ids,
      }))
    );
    await this.transaction(async () => {
      await this.client.query("DELETE FROM kb_battles WHERE replay_id = $1", [replayId]);
      for (const battle of battles)
        await this.client.query(
          `INSERT INTO kb_battles (id, replay_id, started_at, ended_at, public_at, region_name, kill_count, value_total, pilot_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            battle.id,
            battle.replayId,
            new Date(battle.startedAt).toISOString(),
            new Date(battle.endedAt).toISOString(),
            new Date(battle.publicAt).toISOString(),
            battle.regionName,
            battle.killCount,
            battle.valueTotal,
            battle.pilotCount,
          ]
        );
      for (const row of kills.rows)
        await this.client.query("UPDATE kb_kills SET battle_id = $2 WHERE id = $1 AND battle_id IS DISTINCT FROM $2", [
          row.id,
          battleOf.get(row.id) ?? null,
        ]);
    });
    return battles.length;
  }

  async recordScan(replayId, { state, buildSha = null, killCount = 0, error = null }) {
    await this.client.query(
      `INSERT INTO kb_scans (replay_id, state, build_sha, kill_count, error, scanned_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (replay_id) DO UPDATE SET state = EXCLUDED.state, build_sha = EXCLUDED.build_sha,
         kill_count = EXCLUDED.kill_count, error = EXCLUDED.error, scanned_at = now()`,
      [replayId, state, buildSha, killCount, error]
    );
  }

  /** Recordings already scanned to their end, or known to be unscannable. */
  async settledReplayIds() {
    const result = await this.client.query("SELECT replay_id FROM kb_scans WHERE state IN ('complete', 'unsupported')");
    return new Set(result.rows.map((row) => Number(row.replay_id)));
  }

  /**
   * Links kills to what the kill feed published for their fight: its kill cam viewer page and,
   * once rendered, its clip ([{ id, url, clipUrl }]).
   */
  async applyViewers(links) {
    let updated = 0;
    for (const { id, url, clipUrl = null } of links) {
      const result = await this.client.query(
        `UPDATE kb_kills SET viewer_url = $2, clip_url = COALESCE($3, clip_url)
         WHERE id = $1 AND (viewer_url IS DISTINCT FROM $2 OR ($3::text IS NOT NULL AND clip_url IS DISTINCT FROM $3))`,
        [id, url, clipUrl]
      );
      updated += result.rowCount ?? result.affectedRows ?? 0;
    }
    return updated;
  }

  async transaction(work) {
    await this.client.query("BEGIN");
    try {
      const result = await work();
      await this.client.query("COMMIT");
      return result;
    } catch (error) {
      await this.client.query("ROLLBACK");
      throw error;
    }
  }
}

module.exports = { KillboardStore };
