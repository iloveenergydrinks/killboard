import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadGameArt } from "#/lib/art-server";
import { getBattle } from "#/lib/api";
import {
  Art,
  KillLedger,
  Readouts,
  SectionHead,
  Unavailable,
  pilotHref,
  zoneHref,
} from "../../_components/components";
import { formatNumber, formatOre, formatUtc } from "../../_components/format";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;
type Pilot = {
  userId: string;
  name: string;
  hulls: string;
  hullDef: string | null;
  kills: number;
  losses: number;
  damage: number;
  valueLost: number;
};

async function load(id: string) {
  return getBattle(decodeURIComponent(id));
}

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const report = await load((await params).id);
  if (!report) return { title: "Battle" };
  const { battle } = report;
  const title = `Battle · ${battle.regionName || "Unknown zone"}`;
  const description = `${battle.killCount} ships lost · ${battle.pilotCount} pilots · ${formatOre(battle.valueTotal, { short: true })}`;
  return { title, description, openGraph: { title, description } };
}

export default async function BattlePage({ params }: { params: Params }) {
  const [report, { art }] = await Promise.all([
    load((await params).id),
    loadGameArt(),
  ]);
  if (report === undefined) return <Unavailable />;
  if (!report) notFound();
  const { battle, kills, pilots } = report as {
    battle: Record<string, any>;
    kills: any[];
    pilots: Pilot[];
  };
  const minutes = Math.max(
    1,
    Math.round(
      (Date.parse(battle.endedAt) - Date.parse(battle.startedAt)) / 60000,
    ),
  );
  const topDamage = Math.max(1, ...pilots.map((pilot) => pilot.damage));

  return (
    <main>
      <section className="kb-scene is-compact">
        <div className="kb-scene-media" aria-hidden="true" />
        <div className="kb-shell kb-scene-body">
          <div className="kb-record-kicker">
            <span className="kb-label kb-signal">Battle</span>
            <span className="kb-label">{formatUtc(battle.startedAt)}</span>
          </div>
          <h1 className="kb-headline">
            {battle.regionName ? (
              <Link href={zoneHref(battle.regionName)}>
                {battle.regionName}
              </Link>
            ) : (
              "Unknown zone"
            )}
          </h1>
          <Readouts
            items={[
              {
                label: "Ships lost",
                value: formatNumber(battle.killCount),
                tone: "loss",
              },
              {
                label: "Destroyed",
                value: formatOre(battle.valueTotal, { short: true }),
                tone: "signal",
              },
              { label: "Pilots", value: formatNumber(battle.pilotCount) },
              { label: "Duration", value: `${minutes} MIN` },
            ]}
          />
        </div>
      </section>
      <div className="kb-shell kb-columns kb-section">
        <section>
          <SectionHead title="Losses" count={formatNumber(kills.length)} />
          <KillLedger kills={kills} art={art} />
        </section>
        <aside>
          <SectionHead title="Pilots" count={formatNumber(pilots.length)} />
          <ol className="kb-ledger">
            {pilots.map((pilot) => {
              const hull = pilot.hulls?.split(", ")[0] ?? "";
              return (
                <li key={pilot.userId}>
                  <Link href={pilotHref(pilot.userId)} className="kb-row">
                    <span className="kb-row-lead">
                      <Art src={art.hull(pilot.hullDef)} alt={hull} />
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span
                        className="kb-row-name"
                        style={{ display: "block" }}
                      >
                        {pilot.name}
                      </span>
                      <span className="kb-tag">
                        {pilot.kills} kills ·{" "}
                        {pilot.losses ? (
                          <span className="is-hot">{pilot.losses} lost</span>
                        ) : (
                          "survived"
                        )}
                      </span>
                      <span
                        className="kb-bar is-signal"
                        style={{ display: "block" }}
                      >
                        <span
                          style={{
                            width: `${Math.max(2, (pilot.damage / topDamage) * 100)}%`,
                          }}
                        />
                      </span>
                    </span>
                    <span className="kb-row-value">
                      {formatNumber(pilot.damage)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ol>
        </aside>
      </div>
    </main>
  );
}
