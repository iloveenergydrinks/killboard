import Link from "next/link";
import type { ReactNode } from "react";
import type { KillboardArt } from "#/lib/art-server";
import {
  enc,
  formatAgo,
  formatCause,
  formatNumber,
  formatOre,
  formatUtc,
  formatZone,
} from "./format";

export type CardShip = {
  name: string;
  // The game's definition id of the ship; absent on older kills.
  def?: string;
  shipClass: string;
  buildRating: number;
  rarity?: string | null;
  // Its image as the API picked it (a victim's at its rarity); null when the API has none.
  art?: string | null;
};

export type KillRow = {
  id: string;
  occurredAt: string;
  // The zone's id, as /v1/zones lists it; null on kills recorded before zones had ids.
  zoneId: string | null;
  regionName: string;
  tier: number;
  isTravelLane: boolean;
  deathCause: string;
  victimUserId: string;
  victimName: string;
  hullName: string;
  hullClass: string;
  victimBr: number;
  valueTotal: number | null;
  attackerCount: number;
  playerAttackerCount: number;
  isPvp: boolean;
  isSolo: boolean;
  finalBlowName: string | null;
  finalBlowUserId: string | null;
  finalBlowHull: string | null;
  battleId: string | null;
  viewerUrl: string | null;
  victimShip: CardShip | null;
  finalBlowShip: CardShip | null;
};

export type Tally = {
  userId: string | null;
  name: string;
  n: number;
  value?: number;
  // The ship the pilot flies (or loses) most, for their row's image.
  hull?: string | null;
  // That ship's image, as the API served it.
  hullArt?: string | null;
  // For a zone's row, its id.
  zoneId?: string | null;
};

export const killHref = (id: string) => `/kill/${enc(id)}`;
export const pilotHref = (userId: string) => `/pilot/${enc(userId)}`;
export const hullHref = (hull: string) => `/ship/${enc(hull)}`;
/** A zone's page, by its id; by its name for a zone recorded without one. */
export const zoneHref = (id: string | null | undefined, name: string) => `/zone/${enc(id || name)}`;
export const battleHref = (id: string) => `/battle/${enc(id)}`;

export function Chevron({
  double = false,
  left = false,
}: {
  double?: boolean;
  left?: boolean;
}) {
  return (
    <span
      className={`kb-chevron${double ? " is-double" : ""}${left ? " is-left" : ""}`}
      aria-hidden="true"
    />
  );
}

/** A ship's render (or any game image), contained in its box; an empty diamond without one. */
export function Art({
  src,
  alt = "",
  className = "",
}: {
  src: string | null;
  alt?: string;
  className?: string;
}) {
  return (
    <span className={`kb-art${src ? "" : " is-empty"} ${className}`}>
      {src ? <img src={src} alt={alt} loading="lazy" decoding="async" /> : null}
    </span>
  );
}

/** The render of the ship a kill card names, or of the hull a row records when the build kept no card. */
export function shipArt(art: KillboardArt, ship: CardShip | null | undefined) {
  return art.ship(ship);
}

export function SectionHead({
  title,
  count,
  children,
}: {
  title: string;
  count?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="kb-section-head">
      <h2 className="kb-title">{title}</h2>
      {count != null ? <span className="kb-count">{count}</span> : children}
    </div>
  );
}

/** Kills as ledger rows: the lost ship, its pilot, the ship that finished it, where, and the value. */
export function KillLedger({
  kills,
  art,
  empty = "No kills",
}: {
  kills: KillRow[];
  art: KillboardArt;
  empty?: string;
}) {
  if (kills.length === 0) return <div className="kb-empty">{empty}</div>;
  return (
    <ol className="kb-ledger">
      {kills.map((kill) => (
        <li key={kill.id} className="kb-kill">
          <Link
            href={killHref(kill.id)}
            className="kb-cover"
            aria-label={`${kill.victimName} lost a ${kill.hullName}`}
          />
          <Art
            src={shipArt(art, kill.victimShip)}
            alt={kill.hullName}
          />
          <div className="kb-kill-victim">
            <div className="kb-kill-name">{kill.victimName}</div>
            <div className="kb-kill-meta">
              <Link href={hullHref(kill.hullName)} className="kb-tag">
                {kill.hullName}
              </Link>
              <span className="kb-tag">{formatNumber(kill.victimBr)} BR</span>
              {kill.deathCause !== "Unspecified" ? (
                <span className="kb-tag is-hot">
                  {formatCause(kill.deathCause)}
                </span>
              ) : kill.isPvp ? (
                <span className="kb-tag is-hot">PvP</span>
              ) : null}
            </div>
          </div>
          <div className="kb-killer">
            {kill.finalBlowName ? (
              <>
                <Chevron double />
                <Art
                  src={shipArt(art, kill.finalBlowShip)}
                  alt={kill.finalBlowHull ?? ""}
                />
                <div className="kb-killer-text">
                  {kill.finalBlowUserId ? (
                    <Link
                      href={pilotHref(kill.finalBlowUserId)}
                      className="kb-killer-name"
                    >
                      {kill.finalBlowName}
                    </Link>
                  ) : (
                    <div className="kb-killer-name">{kill.finalBlowName}</div>
                  )}
                  <div className="kb-tag">
                    {kill.isSolo ? "Solo" : `+${kill.attackerCount - 1} more`}
                  </div>
                </div>
              </>
            ) : (
              <span className="kb-tag">No attacker</span>
            )}
          </div>
          <div className="kb-kill-where">
            {kill.regionName ? (
              <Link href={zoneHref(kill.zoneId, kill.regionName)} className="kb-kill-zone">
                {formatZone(kill.regionName, kill.tier, kill.isTravelLane)}
              </Link>
            ) : (
              <div className="kb-kill-zone">—</div>
            )}
            <div className="kb-tag" title={formatUtc(kill.occurredAt)}>
              {formatAgo(kill.occurredAt)}
              {kill.battleId ? " · battle" : ""}
            </div>
          </div>
          <div className="kb-kill-value">
            <div className="kb-num">
              {formatOre(kill.valueTotal, { short: true })}
            </div>
            {kill.viewerUrl ? (
              <a
                href={kill.viewerUrl}
                className="kb-play kb-tag"
                target="_blank"
                rel="noreferrer"
              >
                Watch <Chevron />
              </a>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export type BattleRow = {
  id: string;
  startedAt: string;
  zoneId: string | null;
  regionName: string;
  killCount: number;
  valueTotal: number;
  pilotCount: number;
  // Every ship lost, in kill order, and each other hull that dealt damage.
  lost: { hull: string; ship: CardShip | null }[];
  attackers: { hull: string; art: string | null }[];
};

/** Battles as rows: kills, where and when, the ships lost and the hulls that fought, the value. */
export function BattleLedger({
  battles,
  art,
}: {
  battles: BattleRow[];
  art: KillboardArt;
}) {
  if (battles.length === 0)
    return <div className="kb-empty">No battles yet</div>;
  return (
    <ol className="kb-ledger">
      {battles.map((battle) => (
        <li key={battle.id}>
          <Link
            href={battleHref(battle.id)}
            className="kb-row kb-battle"
            title={formatUtc(battle.startedAt)}
          >
            <span className="kb-battle-kills">
              <span className="kb-readout-value">{battle.killCount}</span>
              <span className="kb-label">
                {battle.killCount === 1 ? "Kill" : "Kills"}
              </span>
            </span>
            <span style={{ minWidth: 0 }}>
              <span className="kb-row-name" style={{ display: "block" }}>
                {battle.regionName || "Unknown zone"}
              </span>
              <span className="kb-tag">
                {formatAgo(battle.startedAt)} · {battle.pilotCount} pilots
              </span>
              <span className="kb-battle-ships">
                {battle.lost.map((ship, index) => (
                  <Art
                    key={`lost-${index}`}
                    src={shipArt(art, ship.ship)}
                    alt={`${ship.hull} lost`}
                    className="is-lost"
                  />
                ))}
                {battle.attackers.map((attacker, index) => (
                  <Art
                    key={`${attacker.hull}-${index}`}
                    src={art.hull(attacker.art)}
                    alt={attacker.hull}
                  />
                ))}
              </span>
            </span>
            <span className="kb-row-value kb-signal">
              {formatOre(battle.valueTotal, { short: true })}
            </span>
          </Link>
        </li>
      ))}
    </ol>
  );
}

/** Ranked rows of pilots, ships or zones, each with an optional image and a bar against the leader. */
export function TallyList({
  rows,
  href,
  image,
  format = (n) => formatNumber(n),
  signal = false,
  empty = "Nothing yet",
}: {
  rows: Tally[];
  href: (row: Tally) => string | null;
  image?: (row: Tally) => string | null;
  format?: (n: number) => string;
  signal?: boolean;
  empty?: string;
}) {
  if (rows.length === 0) return <div className="kb-empty">{empty}</div>;
  const top = Math.max(...rows.map((row) => row.n), 1);
  return (
    <ol className="kb-ledger">
      {rows.map((row, index) => {
        const target = href(row);
        const body = (
          <>
            <span className="kb-row-lead">
              <span className="kb-rank">
                {String(index + 1).padStart(2, "0")}
              </span>
              {image ? <Art src={image(row)} alt={row.name} /> : null}
            </span>
            <span style={{ minWidth: 0 }}>
              <span className="kb-row-name" style={{ display: "block" }}>
                {row.name}
              </span>
              <span
                className={`kb-bar${signal ? " is-signal" : ""}`}
                style={{ display: "block" }}
              >
                <span
                  style={{ width: `${Math.max(3, (row.n / top) * 100)}%` }}
                />
              </span>
            </span>
            <span className={`kb-row-value${signal ? " kb-signal" : ""}`}>
              {format(row.n)}
            </span>
          </>
        );
        return (
          <li key={`${row.userId ?? row.name}-${index}`}>
            {target ? (
              <Link href={target} className="kb-row">
                {body}
              </Link>
            ) : (
              <div className="kb-row">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Paging through a cursor list: back to the newest page once paged, and on to older kills while
 * the API names a next cursor.
 */
export function Pager({
  paged,
  nextCursor,
  href,
}: {
  paged: boolean;
  nextCursor: string | null;
  href: (cursor: string | null) => string;
}) {
  if (!paged && !nextCursor) return null;
  return (
    <div className="kb-pager">
      {paged ? (
        <Link href={href(null)} className="kb-signal-link">
          <Chevron left /> Newest
        </Link>
      ) : (
        <span />
      )}
      {nextCursor ? (
        <Link href={href(nextCursor)} className="kb-signal-link">
          Older <Chevron />
        </Link>
      ) : (
        <span />
      )}
    </div>
  );
}

export function Unavailable() {
  return (
    <main className="kb-shell kb-notice">
      <div className="kb-label">Offline</div>
      <h1 className="kb-headline" style={{ marginTop: 16 }}>
        Signal lost
      </h1>
    </main>
  );
}

/** A row of machine readouts: label over value, the signal value in orange. */
export function Readouts({
  items,
}: {
  items: { label: string; value: string; tone?: "signal" | "loss" | "win" }[];
}) {
  return (
    <div className="kb-stats">
      {items.map((item) => (
        <div key={item.label} className="kb-stat">
          <span
            className={`kb-stat-value${item.tone ? ` is-${item.tone}` : ""}`}
          >
            {item.value}
          </span>
          <span className="kb-label">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

/** A ranked pilot's most-flown ship, for their row's image. */
export const pilotShipArt = (art: KillboardArt, row: Tally) =>
  art.hull(row.hullArt);
