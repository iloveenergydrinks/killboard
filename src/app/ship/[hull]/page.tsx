import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadGameArt } from "#/lib/art-server";
import { filterHref, parseFilters } from "#/lib/filters.mjs";
import { getGroupStats, listKills } from "#/lib/api";
import {
  Art,
  Chevron,
  KillLedger,
  Pager,
  Readouts,
  SectionHead,
  TallyList,
  type Tally,
  Unavailable,
  hullHref,
  pilotHref,
  pilotShipArt,
} from "../../_components/components";
import { formatNumber, formatOre } from "../../_components/format";

export const dynamic = "force-dynamic";

type Params = Promise<{ hull: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const name = decodeURIComponent((await params).hull);
  return { title: name };
}

export default async function ShipPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const name = decodeURIComponent((await params).hull);
  const [stats, { art, data }] = await Promise.all([
    getGroupStats({ column: "hull", value: name }),
    loadGameArt(),
  ]);
  if (!stats) notFound();
  const killerArt = (row: Tally) => pilotShipArt(art, row);
  const filters = { ...parseFilters(await searchParams), hull: name };
  const { kills, nextCursor } = await listKills(filters);
  const path = hullHref(name);
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
      <section className="kb-shell kb-record">
        <div className="kb-record-stage">
          <Art
            src={art.hull(
              [...data.hulls.values()].find((hull) => hull.name === name)?.art?.base ??
                kills[0]?.victimShip?.art,
            )}
            alt={name}
          />
        </div>
        <div>
          <div className="kb-record-kicker">
            <span className="kb-label kb-signal">Ship</span>
            <Link
              href={filterHref(
                "/",
                { sort: "recent", page: 1 },
                { hull: name },
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
              filterHref(path, { ...filters, hull: null }, { cursor })
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
