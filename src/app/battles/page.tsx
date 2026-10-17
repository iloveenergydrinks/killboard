import { loadGameArt } from "#/lib/art-server";
import { listBattles } from "#/lib/api";
import {
  BattleLedger,
  SectionHead,
  Unavailable,
} from "../_components/components";
import { formatNumber } from "../_components/format";

export const dynamic = "force-dynamic";
export const metadata = { title: "Battles" };

export default async function BattlesPage() {
  const [battles, { art }] = await Promise.all([
    listBattles({ limit: 100 }).then((page) => page.battles),
    loadGameArt(),
  ]);
  return (
    <main>
      <section className="kb-scene is-compact">
        <div className="kb-scene-media" aria-hidden="true" />
        <div className="kb-shell kb-scene-body">
          <div className="kb-record-kicker">
            <span className="kb-label kb-signal">Battles</span>
          </div>
          <h1 className="kb-headline">Every fight</h1>
        </div>
      </section>
      <section className="kb-shell kb-section">
        <SectionHead title="Recent" count={formatNumber(battles.length)} />
        <BattleLedger battles={battles} art={art} />
      </section>
    </main>
  );
}
