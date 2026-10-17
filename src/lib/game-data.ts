// The killboard's game data: the hull roster, ship classes and roles, death causes, breach tiers and
// zones, read at runtime from the public game data API (https://api.thecitadel.com,
// tools/game-data-api) instead of from the Unity project. Kills carry the art of what they show and
// their modifiers' wording, so the item, NPC, artifact, cipher and stat lists are not needed here.
//
// Caching, for a Vercel serverless instance:
//  - One copy per instance in module memory, shared by every request it serves, for one build
//    (`X-Citadel-Build`). It is the only place the data is held.
//  - A copy older than the API's own max-age (5 minutes) is revalidated with `If-None-Match`, one
//    conditional request per list, never per page view; a 304 costs the API no body. Concurrent
//    requests share one revalidation.
//  - The lists are only ever swapped in together and only when they report the same build, so
//    a page never mixes two builds (a deploy mid-refresh makes one retry, then keeps the old copy).
//  - Any error keeps serving the last good copy. With no copy at all (a cold instance and an API
//    outage) the data is empty, every image is a named placeholder, and the next attempt waits
//    FAILURE_BACKOFF_MS so a down API is not hammered by every request.
//  - A cold instance costs one request per list once, well inside the API's bucket of 60.

const DEFAULT_API_URL = "https://api.thecitadel.com";
const LISTS = [
  "hulls",
  "ship-classes",
  "ship-roles",
  "death-causes",
  "breach-tiers",
  "zones",
] as const;
type List = (typeof LISTS)[number];

export const REVALIDATE_MS = 5 * 60 * 1000;
export const FAILURE_BACKOFF_MS = 30 * 1000;
const REQUEST_TIMEOUT_MS = 6000;
// A request that finds a stale copy waits this long for its revalidation before using the copy.
const STALE_WAIT_MS = 1500;

/** Image URLs by the rarity variant the game authors, absolute; `base` always exists. */
export type ArtKeys = { base: string } & Record<string, string>;
export type Zone = { id: string; name: string; isTournament: boolean };
export type Hull = {
  def: string;
  name: string;
  shipClass: string;
  role: string | null;
  art: ArtKeys | null;
};

/** One build's data, indexed by definition id. */
export type GameData = {
  build: string | null;
  hulls: Map<string, Hull>;
  /** ShipClass in game order, each with its overlay mark. */
  shipClasses: { name: string; art: ArtKeys | null }[];
  /** The mark for a ship of no known class. */
  unknownClassArt: ArtKeys | null;
  /** ShipRole in game order, None left out. */
  shipRoles: string[];
  /** KillManifestDeathCause in game order. */
  deathCauses: string[];
  /** Breach tiers by index, with the names the game gives them. */
  breachTiers: { index: number; name: string }[];
  /** The zones a kill can happen in, public regions first, by the id a kill's zone carries. */
  zones: Zone[];
};

export const NO_GAME_DATA: GameData = {
  build: null,
  hulls: new Map(),
  shipClasses: [],
  unknownClassArt: null,
  shipRoles: [],
  deathCauses: [],
  breachTiers: [],
  zones: [],
};

type Options = {
  baseUrl?: string;
  userAgent?: string;
  fetch?: typeof fetch;
  now?: () => number;
  log?: Pick<Console, "warn">;
};

type Body = Record<string, unknown>;
type Cached = { etag: string | null; build: string | null; body: Body };

/** The API origin: GAME_DATA_API_URL, else production. */
export function gameDataApiUrl(env: Record<string, string | undefined> = process.env) {
  return (env.GAME_DATA_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, "");
}

/** The User-Agent the API asks for: the app and a contact (GAME_DATA_API_CONTACT overrides the page). */
export function gameDataUserAgent(env: Record<string, string | undefined> = process.env) {
  return `CitadelKillboard/1.0 (+${env.GAME_DATA_API_CONTACT?.trim() || "https://thecitadel.com/killboard"})`;
}

export function createGameData(options: Options = {}) {
  const baseUrl = (options.baseUrl ?? gameDataApiUrl()).replace(/\/+$/, "");
  const userAgent = options.userAgent ?? gameDataUserAgent();
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const log = options.log ?? console;

  const raw = new Map<List, Cached>();
  let current: GameData | null = null;
  let checkedAt = -Infinity;
  let failedAt = -Infinity;
  let inflight: Promise<void> | null = null;

  async function read(list: List): Promise<Cached> {
    const previous = raw.get(list);
    const response = await doFetch(`${baseUrl}/v1/${list}`, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        "user-agent": userAgent,
        ...(previous?.etag ? { "if-none-match": previous.etag } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const build = response.headers.get("x-citadel-build");
    if (response.status === 304 && previous)
      return build && build !== previous.build ? { ...previous, build } : previous;
    if (!response.ok) throw new Error(`${list}: HTTP ${response.status}`);
    return { etag: response.headers.get("etag"), build, body: (await response.json()) as Body };
  }

  /** All the lists of one build, or an error. A deploy in the middle gets one more try. */
  async function readAll(): Promise<Map<List, Cached>> {
    for (let attempt = 0; ; attempt++) {
      const lists = await Promise.all(LISTS.map(async (list) => [list, await read(list)] as const));
      const builds = new Set(lists.map(([, cached]) => cached.build));
      if (builds.size === 1 && !builds.has(null)) return new Map(lists);
      if (attempt === 1) throw new Error(`lists from different builds: ${[...builds].join(", ")}`);
      // The stored ETags may belong to the old build: ask again without them.
      raw.clear();
    }
  }

  async function refresh() {
    try {
      const lists = await readAll();
      const changed = !current || [...lists].some(([list, cached]) => raw.get(list) !== cached);
      for (const [list, cached] of lists) raw.set(list, cached);
      if (changed) current = index(lists, baseUrl);
      checkedAt = now();
    } catch (error) {
      failedAt = now();
      log.warn(`Game data API unavailable${current ? ", serving the last good copy" : ""}: ${(error as Error).message}`);
    }
  }

  return {
    /** The data of the API's build; the last good copy when it cannot be reached; empty with none. */
    async get(): Promise<GameData> {
      if (current && now() - checkedAt < REVALIDATE_MS) return current;
      if (now() - failedAt < FAILURE_BACKOFF_MS) return current ?? NO_GAME_DATA;
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      if (current) {
        // A stale copy answers rather than wait on a slow API.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([inflight, new Promise((resolve) => (timer = setTimeout(resolve, STALE_WAIT_MS)))]);
        clearTimeout(timer);
        return current;
      }
      await inflight;
      return current ?? NO_GAME_DATA;
    },
  };
}

const absolute = (baseUrl: string, art: unknown): ArtKeys | null => {
  if (!art || typeof art !== "object" || typeof (art as ArtKeys).base !== "string") return null;
  return Object.fromEntries(
    Object.entries(art as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, path]) => [key, new URL(path, `${baseUrl}/`).href]),
  ) as ArtKeys;
};

/** A list of names, as the game orders them. */
function strings(lists: Map<List, Cached>, list: List, key: string) {
  const value = lists.get(list)!.body[key];
  return Array.isArray(value) ? value.map(String) : [];
}

function index(lists: Map<List, Cached>, baseUrl: string): GameData {
  const rows = (list: List, key: string) =>
    ((lists.get(list)!.body[key] as Record<string, any>[] | undefined) ?? []).filter(
      (row) => row && typeof row === "object",
    );
  return {
    build: lists.get("hulls")!.build,
    hulls: new Map(
      rows("hulls", "hulls").map((row) => [
        String(row.def),
        {
          def: String(row.def),
          name: String(row.name),
          shipClass: String(row.shipClass ?? ""),
          role: row.role == null ? null : String(row.role),
          art: absolute(baseUrl, row.art),
        } as Hull,
      ]),
    ),
    shipClasses: rows("ship-classes", "shipClasses").map((row) => ({
      name: String(row.name),
      art: absolute(baseUrl, row.art),
    })),
    unknownClassArt: absolute(baseUrl, lists.get("ship-classes")!.body.unknownArt as any),
    shipRoles: strings(lists, "ship-roles", "shipRoles"),
    deathCauses: strings(lists, "death-causes", "deathCauses"),
    zones: rows("zones", "zones").map((row) => ({
      id: String(row.id),
      name: String(row.name),
      isTournament: row.isTournament === true,
    })),
    breachTiers: rows("breach-tiers", "breachTiers")
      .map((row) => ({ index: Number(row.index), name: String(row.name) }))
      .filter((tier) => Number.isInteger(tier.index))
      .sort((a, b) => a.index - b.index),
  };
}
