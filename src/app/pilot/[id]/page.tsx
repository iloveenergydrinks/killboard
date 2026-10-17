import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadGameArt } from "#/lib/art-server";
import { filterHref, parseFilters } from "#/lib/filters.mjs";
import { getPilot, listKills } from "#/lib/api";
import {
  Art,
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
import {
  formatNumber,
  formatOre,
  formatPercent,
} from "../../_components/format";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const pilot = await getPilot(decodeURIComponent((await params).id)).catch(() => null);
  if (!pilot) return { title: "Pilot" };
  const description = `${pilot.kills} kills · ${pilot.losses} losses · ${formatOre(pilot.valueDestroyed, { short: true })} destroyed`;
  return {
    title: pilot.name,
    description,
    openGraph: { title: `${pilot.name} · Citadel killboard`, description },
  };
}

export default async function PilotPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const userId = decodeURIComponent((await params).id);
  const [pilot, { art }] = await Promise.all([
    getPilot(userId),
    loadGameArt(),
  ]);
  if (!pilot) notFound();
  const filters = { ...parseFilters(await searchParams), pilot: userId };
  const { kills, nextCursor } = await listKills(filters);
  const signatureRow = pilot.hullsFlown[0] ?? pilot.hullsLost[0] ?? null;
  const signature = signatureRow?.name ?? null;
  const hullArt = (row: { hullDef?: string | null }) => art.hull(row.hullDef);
  const flownArt = (row: Tally) => pilotShipArt(art, row);

  return (
    <main>
      <section className="kb-shell kb-record">
        <div className="kb-record-stage">
          <Art
            src={art.hull(signatureRow?.hullDef)}
            alt={signature ?? ""}
          />
        </div>
        <div>
          <div className="kb-record-kicker">
            <span className="kb-label kb-signal">Pilot</span>
            {signature ? (
              <span className="kb-label">Flies {signature}</span>
            ) : null}
          </div>
          <h1 className="kb-headline">{pilot.name}</h1>
          <Readouts
            items={[
              { label: "Kills", value: formatNumber(pilot.kills), tone: "win" },
              {
                label: "Losses",
                value: formatNumber(pilot.losses),
                tone: "loss",
              },
              { label: "Final blows", value: formatNumber(pilot.finalBlows) },
              {
                label: "Destroyed",
                value: formatOre(pilot.valueDestroyed, { short: true }),
                tone: "signal",
              },
              {
                label: "Lost",
                value: formatOre(pilot.valueLost, { short: true }),
              },
              { label: "Efficiency", value: formatPercent(pilot.efficiency) },
            ]}
          />
        </div>
      </section>
      <div className="kb-shell kb-pair">
        <section>
          <SectionHead title="Ships flown" />
          <TallyList
            rows={pilot.hullsFlown}
            image={hullArt}
            href={(row) => hullHref(row.name)}
            empty="No kills yet"
          />
        </section>
        <section>
          <SectionHead title="Ships lost" />
          <TallyList
            rows={pilot.hullsLost}
            image={hullArt}
            href={(row) => hullHref(row.name)}
            empty="No losses"
          />
        </section>
        <section>
          <SectionHead title="Nemesis" />
          <TallyList
            rows={pilot.nemesis}
            image={flownArt}
            href={(row) => (row.userId ? pilotHref(row.userId) : null)}
            empty="Untouched"
          />
        </section>
        <section>
          <SectionHead title="Victims" />
          <TallyList
            rows={pilot.victims}
            image={flownArt}
            href={(row) => (row.userId ? pilotHref(row.userId) : null)}
            signal
            empty="No player kills"
          />
        </section>
      </div>
      <section className="kb-shell kb-section">
        <SectionHead
          title="Record"
          count={formatNumber(pilot.kills + pilot.losses)}
        />
        <KillLedger kills={kills} art={art} />
        <Pager
          paged={Boolean(filters.cursor)}
          nextCursor={nextCursor}
          href={(cursor) =>
            filterHref(pilotHref(userId), { ...filters, pilot: null }, { cursor })
          }
        />
      </section>
    </main>
  );
}
