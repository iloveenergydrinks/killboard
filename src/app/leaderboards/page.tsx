import Link from "next/link";
import { loadGameArt } from "#/lib/art-server";
import { WINDOWS, getLeaderboards } from "#/lib/api";
import {
  KillLedger,
  SectionHead,
  TallyList,
  type Tally,
  Unavailable,
  hullHref,
  pilotHref,
  zoneHref,
  pilotShipArt,
} from "../_components/components";
import { formatOre } from "../_components/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Leaderboards" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const LABELS: Record<string, string> = {
  week: "7 days",
  month: "30 days",
  all: "All time",
};

export default async function LeaderboardsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const requested = (await searchParams).window;
  const window =
    typeof requested === "string" && Object.hasOwn(WINDOWS, requested)
      ? requested
      : "week";
  const [boards, { art }] = await Promise.all([
    getLeaderboards(window as keyof typeof WINDOWS),
    loadGameArt(),
  ]);
  const shipArt = (row: Tally) => pilotShipArt(art, row);
  const pilot = (row: { userId: string | null }) =>
    row.userId ? pilotHref(row.userId) : null;

  return (
    <main>
      <section className="kb-scene is-compact">
        <div className="kb-scene-media" aria-hidden="true" />
        <div className="kb-shell kb-scene-body">
          <div className="kb-record-kicker">
            <span className="kb-label kb-signal">Leaderboards</span>
          </div>
          <h1 className="kb-headline">{LABELS[window]}</h1>
          <div
            className="kb-toolbar"
            style={{ borderBottom: 0, paddingBottom: 0 }}
          >
            {Object.keys(WINDOWS).map((key) => (
              <Link
                key={key}
                href={
                  key === "week"
                    ? "/leaderboards"
                    : `/leaderboards?window=${key}`
                }
                className={`kb-chip${key === window ? " is-active" : ""}`}
              >
                {LABELS[key]}
              </Link>
            ))}
          </div>
        </div>
      </section>
      <div className="kb-shell kb-pair">
        <section className="kb-section">
          <SectionHead title="Top killers" />
          <TallyList
            rows={boards.topKillers}
            image={shipArt}
            href={pilot}
            signal
          />
        </section>
        <section className="kb-section">
          <SectionHead title="Value destroyed" />
          <TallyList
            rows={boards.topDestroyers}
            image={shipArt}
            href={pilot}
            signal
            format={(n) => formatOre(n, { short: true })}
          />
        </section>
        <section>
          <SectionHead title="Deadliest ships" />
          <TallyList
            rows={boards.deadliestHulls}
            href={(row) => hullHref(row.name)}
            image={(row) => art.hull(row.hullDef)}
          />
        </section>
        <section>
          <SectionHead title="Deadliest zones" />
          <TallyList
            rows={boards.deadliestZones}
            href={(row) => zoneHref(row.name)}
          />
        </section>
        <section>
          <SectionHead title="Final blows" />
          <TallyList
            rows={boards.topFinalBlows}
            image={shipArt}
            href={pilot}
          />
        </section>
      </div>
      <section className="kb-shell kb-section">
        <SectionHead title="Biggest losses" />
        <KillLedger
          kills={boards.biggestLosses}
          art={art}
          empty="No valued losses" />
      </section>
    </main>
  );
}
