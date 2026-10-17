import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { loadGameArt } from "#/lib/art-server";
import type { Zone } from "#/lib/game-data";
import { filterHref, parseFilters } from "#/lib/filters.mjs";
import { getGroupStats, listKills } from "#/lib/api";
import {
  Chevron,
  KillLedger,
  Pager,
  Readouts,
  SectionHead,
  TallyList,
  type Tally,
  Unavailable,
  zoneHref,
  pilotHref,
  pilotShipArt,
} from "../../_components/components";
import { formatNumber, formatOre } from "../../_components/format";

export const dynamic = "force-dynamic";

type Params = Promise<{ zone: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * The zone a page's path names: by its id, as /v1/zones lists it, else by the name a kill recorded
 * before zones had ids. Zone ids are lowercase words joined by underscores; names are not.
 */
function findZone(zones: Zone[], key: string) {
  const zone = zones.find((each) => each.id === key) ?? null;
  return { zone, byId: zone != null || /^[a-z0-9_]+$/.test(key) };
}

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const key = decodeURIComponent((await params).zone);
  const { data } = await loadGameArt();
  return { title: findZone(data.zones, key).zone?.name || key };
}

export default async function ZonePage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const key = decodeURIComponent((await params).zone);
  const { art, data } = await loadGameArt();
  const { zone, byId } = findZone(data.zones, key);
  // A link by name to a public zone moves to the zone's id: event routes reuse public names.
  const named = byId ? null : data.zones.find((each) => each.name === key && !each.isTournament);
  if (named) permanentRedirect(zoneHref(named.id, named.name));
  const column = byId ? "zoneId" : "zone";
  const name = zone?.name || key;
  const stats = await getGroupStats({ column, value: key });
  const killerArt = (row: Tally) => pilotShipArt(art, row);
  if (!stats) notFound();
  const filters = { ...parseFilters(await searchParams), [column]: key };
  const { kills, nextCursor } = await listKills(filters);
  const path = zoneHref(byId ? key : null, key);
  const stats_items = [
    { label: "Lost", value: formatNumber(stats.losses), tone: "loss" as const },
    {
      label: "Value lost",
      value: formatOre(stats.valueLost, { short: true }),
      tone: "signal" as const,
    },
    { label: "Pilots", value: formatNumber(stats.pilots) },
    { label: "Avg BR", value: formatNumber(stats.averageBr) },
    { label: "To players", value: formatNumber(stats.pvp) },
  ];

  return (
    <main>
      <section className="kb-scene is-compact">
        <div className="kb-scene-media" aria-hidden="true" />
        <div className="kb-shell kb-scene-body">
          <div className="kb-record-kicker">
            <span className="kb-label kb-signal">Zone</span>
            <Link
              href={filterHref(
                "/",
                { sort: "recent", page: 1 },
                { [column]: key },
              )}
              className="kb-label"
            >
              Filter the feed <Chevron />
            </Link>
          </div>
          <h1 className="kb-headline">{name}</h1>
          <Readouts items={stats_items} />
        </div>
      </section>
      <div className="kb-shell kb-columns kb-section">
        <section>
          <SectionHead title="Losses" count={formatNumber(stats.losses)} />
          <KillLedger kills={kills} art={art} />
          <Pager
            paged={Boolean(filters.cursor)}
            nextCursor={nextCursor}
            href={(cursor) =>
              filterHref(path, { ...filters, [column]: null }, { cursor })
            }
          />
        </section>
        <aside>
          <SectionHead title="Top killers" />
          <TallyList
            rows={stats.killers}
            image={killerArt}
            href={(row) => (row.userId ? pilotHref(row.userId) : null)}
            signal
            empty="No player kills"
          />
        </aside>
      </div>
    </main>
  );
}
