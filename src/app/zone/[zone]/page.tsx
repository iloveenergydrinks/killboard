import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadGameArt } from "#/lib/art-server";
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

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const name = decodeURIComponent((await params).zone);
  return { title: name };
}

export default async function ZonePage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const name = decodeURIComponent((await params).zone);
  const [stats, { art }] = await Promise.all([
    getGroupStats({ column: "zone", value: name }),
    loadGameArt(),
  ]);
  const killerArt = (row: Tally) => pilotShipArt(art, row);
  if (!stats) notFound();
  const filters = { ...parseFilters(await searchParams), zone: name };
  const { kills, nextCursor } = await listKills(filters);
  const path = zoneHref(name);
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
                { zone: name },
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
              filterHref(path, { ...filters, zone: null }, { cursor })
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
