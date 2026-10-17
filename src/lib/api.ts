import "server-only";
import { PAGE_SIZE, apiParams } from "./filters.mjs";
import { gameDataApiUrl, gameDataUserAgent } from "./game-data";

// The killboard's kills, battles, pilots and leaderboards, read from the game data API's kill routes
// (https://api.thecitadel.com/v1/kills…), which own the data and its publication delay. This file
// only shapes the API's responses into the rows the pages draw; it holds no data of its own.

const REQUEST_TIMEOUT_MS = 8000;
// The API caches kill lists for 10 seconds; one refetch per window per server is enough.
const REVALIDATE_SECONDS = 10;

/** The API could not answer: pages show their "signal lost" state. */
export class KillboardUnavailable extends Error {}

type Query = URLSearchParams | Record<string, string | number | undefined | null>;

async function get<T>(path: string, query?: Query): Promise<T | null> {
  const params =
    query instanceof URLSearchParams
      ? query
      : new URLSearchParams(
          Object.entries(query ?? {})
            .filter(([, value]) => value != null && value !== "")
            .map(([key, value]) => [key, String(value)]),
        );
  const search = params.toString();
  const url = `${gameDataApiUrl()}${path}${search ? `?${search}` : ""}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": gameDataUserAgent(), Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      next: { revalidate: REVALIDATE_SECONDS },
    });
  } catch (error) {
    throw new KillboardUnavailable(`${path}: ${(error as Error).message}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new KillboardUnavailable(`${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

// ── The API's shapes (tools/game-data-api/openapi/openapi.json) ─────────────────────────────

export type HullRef = { def: string | null; name: string; class: string | null };
type ZoneRef = { id: string | null; name: string };
type KillZone = ZoneRef & { tier: number; isTravelLane: boolean };
type Party = { pilotId: string | null; name: string; hull: HullRef | null };
type Victim = {
  pilotId: string;
  name: string;
  hull: HullRef;
  rarity: string | null;
  buildRating: number;
};
export type KillValue = { hull: number; fitting: number; cargo: number; total: number };
export type KillSummary = {
  id: string;
  cursor: string;
  occurredAt: string;
  listedAt: string;
  build: string;
  zone: KillZone;
  deathCause: string;
  victim: Victim;
  value: KillValue | null;
  attackerCount: number;
  playerAttackerCount: number;
  isPvp: boolean;
  isSolo: boolean;
  finalBlow: Party | null;
  battleId: string | null;
  links: { killCam: string | null; clip: string | null };
};
export type ItemModifier = {
  stat: string;
  operation: string;
  value: number | string;
  tier: number | null;
  isFractured: boolean;
};
export type ItemPort = {
  row: number;
  col: number;
  direction: string;
  state: string;
  cipher: { def: string | null; name: string; rarity?: string | null } | null;
};
export type ContainerItem = {
  def: string | null;
  name: string;
  category: string;
  slotType: string;
  shape: string;
  row: number;
  col: number;
  rotation: number;
  rarity: string | null;
  quality: string | null;
  quantity: number;
  isDestroyed: boolean;
  artifact: string | null;
  pointRating: number | null;
  modifiers: ItemModifier[];
  ports: ItemPort[];
};
export type Container = { rows: number; columns: number; slots: string[]; items: ContainerItem[] };
export type Attacker = {
  pilotId: string | null;
  name: string;
  hull: HullRef;
  buildRating: number;
  damage: number;
  shieldDamage: number;
  isFinalBlow: boolean;
};
export type Kill = KillSummary & {
  totalDamage: number;
  affinity: { level: number; maxLevel: number; points: { moduleType: string; points: number }[] } | null;
  fitting: Container | null;
  cargo: Container | null;
  attackers: Attacker[];
};
type PilotCount = { pilotId: string; name: string; hull: HullRef | null; count: number; value: number };
type HullCount = { hull: HullRef; count: number };
type ZoneCount = { zone: ZoneRef; count: number; value: number };
type KillTotals = {
  kills: number;
  valueDestroyed: number;
  pilots: number;
  averageBuildRating: number;
  pvpKills: number;
  topKillers: PilotCount[];
};
type LostShip = { killId: string; hull: HullRef };
type BattleSummary = {
  id: string;
  startedAt: string;
  endedAt: string;
  zone: ZoneRef;
  killCount: number;
  valueDestroyed: number;
  pilotCount: number;
  lost: LostShip[];
  attackerHulls: HullRef[];
};
type Battle = BattleSummary & {
  kills: KillSummary[];
  pilots: {
    pilotId: string;
    name: string;
    hulls: HullRef[];
    kills: number;
    losses: number;
    damage: number;
    valueLost: number;
  }[];
};
type Pilot = {
  id: string;
  name: string;
  kills: number;
  finalBlows: number;
  losses: number;
  valueDestroyed: number;
  valueLost: number;
  efficiency: number | null;
  nemeses: PilotCount[];
  victims: PilotCount[];
  hullsLost: HullCount[];
  hullsFlown: HullCount[];
};
type Leaderboards = {
  window: string;
  topKillers: PilotCount[];
  topFinalBlows: PilotCount[];
  topDestroyers: PilotCount[];
  biggestLosses: KillSummary[];
  deadliestZones: ZoneCount[];
  deadliestHulls: HullCount[];
};

// ── Rows the pages draw ──────────────────────────────────────────────────────────────────────

/** A ship as the art lookup reads it: its name, definition id, class and the rarity of its render. */
function ship(hull: HullRef | null | undefined, rarity?: string | null, buildRating = 0) {
  if (!hull) return null;
  return {
    name: hull.name,
    def: hull.def ?? undefined,
    shipClass: hull.class ?? "",
    buildRating,
    rarity: rarity ?? null,
  };
}

function killRow(kill: KillSummary) {
  return {
    id: kill.id,
    occurredAt: kill.occurredAt,
    regionName: kill.zone.name,
    tier: kill.zone.tier,
    isTravelLane: kill.zone.isTravelLane,
    deathCause: kill.deathCause,
    victimUserId: kill.victim.pilotId,
    victimName: kill.victim.name,
    hullName: kill.victim.hull.name,
    hullDef: kill.victim.hull.def,
    hullClass: kill.victim.hull.class ?? "",
    victimBr: kill.victim.buildRating,
    valueTotal: kill.value?.total ?? null,
    attackerCount: kill.attackerCount,
    playerAttackerCount: kill.playerAttackerCount,
    isPvp: kill.isPvp,
    isSolo: kill.isSolo,
    finalBlowName: kill.finalBlow?.name ?? null,
    finalBlowUserId: kill.finalBlow?.pilotId ?? null,
    finalBlowHull: kill.finalBlow?.hull?.name ?? null,
    finalBlowHullDef: kill.finalBlow?.hull?.def ?? null,
    battleId: kill.battleId,
    viewerUrl: kill.links.killCam,
    clipUrl: kill.links.clip,
    victimShip: ship(kill.victim.hull, kill.victim.rarity, kill.victim.buildRating),
    finalBlowShip: ship(kill.finalBlow?.hull),
  };
}

const pilotTally = (row: PilotCount, n = row.count) => ({
  userId: row.pilotId,
  name: row.name,
  n,
  value: row.value,
  hull: row.hull?.name ?? null,
  hullDef: row.hull?.def ?? null,
});

const hullTally = (row: HullCount) => ({
  userId: null,
  name: row.hull.name,
  n: row.count,
  hull: row.hull.name,
  hullDef: row.hull.def,
});

function battleRow(battle: BattleSummary) {
  const lostNames = new Set(battle.lost.map((each) => each.hull.name));
  return {
    id: battle.id,
    startedAt: battle.startedAt,
    endedAt: battle.endedAt,
    regionName: battle.zone.name,
    killCount: battle.killCount,
    valueTotal: battle.valueDestroyed,
    pilotCount: battle.pilotCount,
    lost: battle.lost.map((each) => ({
      hull: each.hull.name,
      hullDef: each.hull.def,
      ship: ship(each.hull),
    })),
    attackers: battle.attackerHulls
      .filter((hull) => !lostNames.has(hull.name))
      .map((hull) => ({ hull: hull.name, def: hull.def })),
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────

export const WINDOWS = { week: 7, month: 30, all: null } as const;
const CLASSES = ["Frigate", "Cruiser", "Dreadnought"];
// KillManifestDeathCause, as the API names them.
const CAUSES = ["Unspecified", "BreachCollapse", "ReconnectLoss", "ReactorStarvation"];

type Filters = Record<string, string | number | undefined | null>;

/** One page of kills matching a filter, and the cursor of the next. */
export async function listKills(filters: Filters, limit = PAGE_SIZE) {
  const params = apiParams(filters);
  params.set("limit", String(limit));
  const page = await get<{ kills: KillSummary[]; nextCursor: string | null }>("/v1/kills", params);
  return {
    kills: (page?.kills ?? []).map(killRow),
    nextCursor: page?.nextCursor ?? null,
  };
}

/** Totals for a filter: kills, value destroyed, pilots, average rating, PvP kills and top killers. */
export async function killTotals(filters: Filters) {
  const params = apiParams({ ...filters, sort: undefined, cursor: undefined });
  const totals = await get<KillTotals>("/v1/kills/summary", params);
  return {
    kills: totals?.kills ?? 0,
    value: totals?.valueDestroyed ?? 0,
    pilots: totals?.pilots ?? 0,
    averageBr: totals?.averageBuildRating ?? 0,
    pvp: totals?.pvpKills ?? 0,
    killers: (totals?.topKillers ?? []).map((row) => pilotTally(row)),
  };
}

/**
 * The values the filter form offers. The API lists no zones of its own, so the zones are those the
 * all-time leaderboard ranks; ships come from the game data (art.hullGroups).
 */
export async function filterOptions() {
  const boards = await get<Leaderboards>("/v1/leaderboards", { window: "all" });
  return {
    zones: (boards?.deadliestZones ?? []).map((row) => row.zone.name).sort(),
    hulls: [] as { name: string; def: string | null }[],
    classes: CLASSES,
    causes: CAUSES,
  };
}

/** A ship's or a zone's record: losses, value lost, pilots, average rating, PvP and top killers. */
export async function getGroupStats({ column, value }: { column: "hull" | "zone"; value: string }) {
  const totals = await killTotals({ [column]: value });
  if (!totals.kills) return null;
  return {
    losses: totals.kills,
    valueLost: totals.value,
    pilots: totals.pilots,
    averageBr: totals.averageBr,
    pvp: totals.pvp,
    killers: totals.killers,
  };
}

/** A kill as the API serves it: card, fitting, cargo and every attacker; null when unknown. */
export async function getKill(id: string) {
  return get<Kill>(`/v1/kills/${encodeURIComponent(id)}`);
}

/** Battles, newest first, with the ships lost and the hulls that fought. */
export async function listBattles({ limit = 20, cursor }: { limit?: number; cursor?: string } = {}) {
  const page = await get<{ battles: BattleSummary[]; nextCursor: string | null }>("/v1/battles", {
    limit,
    cursor,
  });
  return {
    battles: (page?.battles ?? []).map(battleRow),
    nextCursor: page?.nextCursor ?? null,
  };
}

/** A battle with its kills in order and every pilot's part in it; null when unknown. */
export async function getBattle(id: string) {
  const battle = await get<Battle>(`/v1/battles/${encodeURIComponent(id)}`);
  if (!battle) return null;
  return {
    battle: battleRow(battle),
    kills: battle.kills.map(killRow),
    pilots: battle.pilots.map((pilot) => ({
      userId: pilot.pilotId,
      name: pilot.name,
      hulls: pilot.hulls.map((hull) => hull.name).join(", "),
      hullDef: pilot.hulls[0]?.def ?? null,
      kills: pilot.kills,
      losses: pilot.losses,
      damage: pilot.damage,
      valueLost: pilot.valueLost,
    })),
  };
}

/** A pilot's record; null when the pilot has no public kill. */
export async function getPilot(id: string) {
  const pilot = await get<Pilot>(`/v1/pilots/${encodeURIComponent(id)}`);
  if (!pilot) return null;
  return {
    userId: pilot.id,
    name: pilot.name,
    kills: pilot.kills,
    finalBlows: pilot.finalBlows,
    losses: pilot.losses,
    valueDestroyed: pilot.valueDestroyed,
    valueLost: pilot.valueLost,
    efficiency: pilot.efficiency,
    nemesis: pilot.nemeses.map((row) => pilotTally(row)),
    victims: pilot.victims.map((row) => pilotTally(row)),
    hullsLost: pilot.hullsLost.map(hullTally),
    hullsFlown: pilot.hullsFlown.map(hullTally),
  };
}

/** Leaderboards over the last week, month or all time. */
export async function getLeaderboards(window: keyof typeof WINDOWS) {
  const boards = await get<Leaderboards>("/v1/leaderboards", { window });
  return {
    topKillers: (boards?.topKillers ?? []).map((row) => pilotTally(row)),
    topFinalBlows: (boards?.topFinalBlows ?? []).map((row) => pilotTally(row)),
    // Ranked by the value they destroyed, which is what the board shows.
    topDestroyers: (boards?.topDestroyers ?? []).map((row) => pilotTally(row, row.value)),
    biggestLosses: (boards?.biggestLosses ?? []).map(killRow),
    deadliestZones: (boards?.deadliestZones ?? []).map((row) => ({
      userId: null,
      name: row.zone.name,
      n: row.count,
      value: row.value,
    })),
    deadliestHulls: (boards?.deadliestHulls ?? []).map(hullTally),
  };
}
