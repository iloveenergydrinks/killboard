"use strict";

// A kill joins the battle of the previous kill in its recording when it follows within this.
const BATTLE_GAP_MILLISECONDS = 120 * 1000;
// A single loss is a kill, not a battle.
const MIN_BATTLE_KILLS = 2;

/**
 * Groups one recording's kills into battles: kills ordered by time chain into one battle while
 * each follows the previous within BATTLE_GAP_MILLISECONDS. A battle is named by its recording
 * and its first kill's sequence, so rebuilding a recording's battles gives the same ids.
 *
 * kills: [{ id, replayId, sequence, occurredAt (ms), publicAt (ms), regionName, valueTotal,
 *           victimUserId, attackerUserIds }]
 * Returns { battles: [...], battleOf: Map<killId, battleId> }.
 */
function groupBattles(kills) {
  const ordered = [...kills].sort((a, b) => a.occurredAt - b.occurredAt || a.sequence - b.sequence);
  const chains = [];
  for (const kill of ordered) {
    const chain = chains[chains.length - 1];
    if (chain && kill.occurredAt - chain[chain.length - 1].occurredAt <= BATTLE_GAP_MILLISECONDS) chain.push(kill);
    else chains.push([kill]);
  }

  const battles = [];
  const battleOf = new Map();
  for (const chain of chains) {
    if (chain.length < MIN_BATTLE_KILLS) continue;
    const first = chain[0];
    const last = chain[chain.length - 1];
    const id = `${first.replayId}:${first.sequence}`;
    const pilots = new Set();
    for (const kill of chain) {
      pilots.add(kill.victimUserId);
      for (const userId of kill.attackerUserIds) pilots.add(userId);
      battleOf.set(kill.id, id);
    }
    battles.push({
      id,
      replayId: first.replayId,
      startedAt: first.occurredAt,
      endedAt: last.occurredAt,
      publicAt: Math.max(...chain.map((kill) => kill.publicAt)),
      regionName: mostCommon(chain.map((kill) => kill.regionName).filter(Boolean)) ?? "",
      killCount: chain.length,
      valueTotal: chain.reduce((sum, kill) => sum + (kill.valueTotal ?? 0), 0),
      pilotCount: pilots.size,
    });
  }
  return { battles, battleOf };
}

function mostCommon(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = null;
  for (const [value, count] of counts) if (best === null || count > counts.get(best)) best = value;
  return best;
}

module.exports = { groupBattles, BATTLE_GAP_MILLISECONDS };
