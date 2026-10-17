import Link from "next/link";
import { redirect } from "next/navigation";
import { loadGameArt } from "#/lib/art-server";
import { filterHref, parseFilters } from "#/lib/filters.mjs";
import {
  killTotals,
  listBattles,
  listKills,
} from "#/lib/api";
import {
  BattleLedger,
  Chevron,
  KillLedger,
  Pager,
  SectionHead,
  Unavailable,
} from "./_components/components";
import { FilterBar, type Filters } from "./_components/filters";
import { formatNumber, formatOre } from "./_components/format";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function KillFeedPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const filters = parseFilters(query) as Filters;
  // The filter form submits every field; drop the blank ones so a filtered view is a short, shareable URL.
  if (
    Object.values(query).some(
      (value) => value === "" || (Array.isArray(value) && value.length > 1),
    )
  )
    redirect(filterHref("/", filters, { cursor: filters.cursor }));
  const [{ kills, nextCursor }, totals, battles, { art, data }] = await Promise.all([
    listKills(filters),
    killTotals(filters),
    listBattles({ limit: 8 }).then((page) => page.battles),
    loadGameArt(),
  ]);
  const options = {
    zones: data.zones,
    hulls: [],
    classes: data.shipClasses.map((shipClass) => shipClass.name),
    causes: data.deathCauses,
    tiers: data.breachTiers,
  };
  const filtered = Object.keys(filters).some(
    (key) => key !== "sort" && key !== "cursor",
  );

  return (
    <main>
      <section className="kb-scene">
        <div className="kb-scene-media" aria-hidden="true" />
        <div className="kb-shell kb-scene-body">
          <div className="kb-live kb-console">Live</div>
          <h1 className="kb-display">Killboard</h1>
          <div className="kb-readouts">
            <div className="kb-readout">
              <span className="kb-readout-value">
                {formatNumber(totals.kills)}
              </span>
              <span className="kb-label">Ships lost</span>
            </div>
            <div className="kb-readout">
              <span className="kb-readout-value is-signal">
                {formatOre(totals.value, { short: true })}
              </span>
              <span className="kb-label">Destroyed</span>
            </div>
            <div className="kb-readout">
              <span className="kb-readout-value">
                {formatNumber(totals.pilots)}
              </span>
              <span className="kb-label">Pilots</span>
            </div>
          </div>
        </div>
      </section>

      <div className="kb-shell">
        <FilterBar
          path="/"
          filters={filters}
          options={options}
          art={art}
        />
        <div className="kb-columns kb-section" style={{ marginTop: 28 }}>
          <section>
            <KillLedger
              kills={kills}
              art={art}
              empty={filtered ? "No kills match" : "No kills yet"}
            />
            <Pager
              paged={Boolean(filters.cursor)}
              nextCursor={nextCursor}
              href={(cursor) => filterHref("/", filters, { cursor })}
            />
          </section>
          <aside>
            <SectionHead title="Battles">
              <Link href="/battles" className="kb-signal-link">
                All <Chevron />
              </Link>
            </SectionHead>
            <BattleLedger battles={battles} art={art} />
          </aside>
        </div>
      </div>
    </main>
  );
}
