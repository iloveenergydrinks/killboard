import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { getKill, type Kill } from "#/lib/api";
import { loadGameArt } from "#/lib/art-server";
import {
  Art,
  Chevron,
  SectionHead,
  battleHref,
  hullHref,
  pilotHref,
  zoneHref,
} from "../../_components/components";
import { KillCamLink, ShareBar } from "../../_components/embeds";
import { FittingGrid } from "../../_components/fitting";
import {
  formatCause,
  formatNumber,
  formatOre,
  formatUtc,
  formatZone,
} from "../../_components/format";

export const dynamic = "force-dynamic";

type Params = Promise<{ id: string }>;

const load = async (id: string) => getKill(decodeURIComponent(id));

export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const kill = await load((await params).id).catch(() => null);
  if (!kill) return { title: "Kill" };
  const title = `${kill.victim.name} lost a ${kill.victim.hull.name}`;
  const description = [
    formatOre(kill.value?.total),
    formatZone(kill.zone.name, kill.zone.tier, kill.zone.isTravelLane),
    kill.finalBlow ? `final blow ${kill.finalBlow.name}` : formatCause(kill.deathCause),
  ].join(" · ");
  return {
    title,
    description,
    openGraph: { title, description, type: "article" },
    twitter: { card: "summary", title, description },
  };
}

function Fact({
  label,
  children,
  tone,
}: {
  label: string;
  children: ReactNode;
  tone?: "loss" | "win" | "signal";
}) {
  return (
    <div className="kb-fact">
      <span className="kb-label">{label}</span>
      <div className={`kb-fact-value${tone ? ` is-${tone}` : ""}`}>{children}</div>
    </div>
  );
}

export default async function KillPage({ params }: { params: Params }) {
  const { id } = await params;
  const [kill, { art, tooltips }] = await Promise.all([load(id), loadGameArt()]);
  if (!kill) notFound();
  return <KillView kill={kill} art={art} tooltips={tooltips} />;
}

function KillView({
  kill,
  art,
  tooltips,
}: {
  kill: Kill;
  art: Awaited<ReturnType<typeof loadGameArt>>["art"];
  tooltips: Awaited<ReturnType<typeof loadGameArt>>["tooltips"];
}) {
  const { victim, attackers } = kill;
  const loss = kill.deathCause === "ReconnectLoss";
  const hull = victim.hull;
  const victimArt = art.ship({ name: hull.name, def: hull.def ?? undefined, rarity: victim.rarity });
  const shipOf = (ref: { name: string; def: string | null } | null) =>
    ref ? art.ship({ name: ref.name, def: ref.def ?? undefined }) : null;
  const byDamage = [...attackers].sort((a, b) => b.damage - a.damage);
  const finalBlow = attackers.find((attacker) => attacker.isFinalBlow) ?? null;
  const topDamage = byDamage[0] ?? null;
  const totalDamage =
    kill.totalDamage || attackers.reduce((sum, attacker) => sum + attacker.damage, 0);
  const players = attackers.filter((attacker) => attacker.pilotId).length;
  const attackerBr = attackers.length
    ? Math.round(attackers.reduce((sum, a) => sum + a.buildRating, 0) / attackers.length)
    : null;
  const items = [...(kill.fitting?.items ?? []), ...(kill.cargo?.items ?? [])];
  const destroyed = items.filter((item) => item.isDestroyed).length;
  const title = `${victim.name} lost a ${hull.name} · ${formatOre(kill.value?.total)}`;

  return (
    <main>
      <section className="kb-shell kb-kill-top">
        {kill.links.killCam ? (
          <KillCamLink
            href={kill.links.killCam}
            poster={victimArt}
            label={`Kill cam: ${victim.name} lost a ${hull.name}`}
          />
        ) : (
          <div className="kb-record-stage">
            <Art src={victimArt} alt={hull.name} />
          </div>
        )}
        <div>
          <div className="kb-record-kicker">
            <span className="kb-label kb-signal">{loss ? "Loss" : "Kill"}</span>
            <span className="kb-label">{formatUtc(kill.occurredAt)}</span>
            {kill.zone.name ? (
              <Link href={zoneHref(kill.zone.name)} className="kb-label">
                {formatZone(kill.zone.name, kill.zone.tier, kill.zone.isTravelLane)}
              </Link>
            ) : null}
          </div>
          <h1 className="kb-headline">
            <Link href={pilotHref(victim.pilotId)}>{victim.name}</Link>
          </h1>
          <div className="kb-record-hull">
            {hull.class && art.shipClass(hull.class) ? (
              <img className="kb-class-icon" src={art.shipClass(hull.class)} alt={hull.class} />
            ) : null}
            <Link href={hullHref(hull.name)} className="kb-console">
              {hull.name}
            </Link>
            {hull.class ? <span className="kb-label">{hull.class}</span> : null}
            <span className="kb-label">{formatNumber(victim.buildRating)} BR</span>
            {kill.affinity ? (
              <span className="kb-label">
                Lvl {kill.affinity.level}/{kill.affinity.maxLevel}
              </span>
            ) : null}
            {kill.deathCause !== "Unspecified" ? (
              <span className="kb-tag is-hot">{formatCause(kill.deathCause)}</span>
            ) : null}
          </div>
          <div className="kb-record-value">
            <div className="kb-label">Total {loss ? "loss" : "kill"} value</div>
            <div className="kb-record-total">
              {kill.value == null ? "—" : formatNumber(kill.value.total)}
              <small>ORE</small>
            </div>
          </div>
          {finalBlow ? (
            <div className="kb-final">
              <Art src={shipOf(finalBlow.hull)} alt={finalBlow.hull.name} />
              <div style={{ minWidth: 0 }}>
                <div className="kb-label kb-signal">Final blow</div>
                <div className="kb-row-name">
                  {finalBlow.pilotId ? (
                    <Link href={pilotHref(finalBlow.pilotId)}>{finalBlow.name}</Link>
                  ) : (
                    finalBlow.name
                  )}
                </div>
                <div className="kb-tag">{finalBlow.hull.name}</div>
              </div>
            </div>
          ) : null}
          <ShareBar
            title={title}
            clipUrl={kill.links.clip}
            clipName={`citadel-kill-${kill.id.replace(":", "-")}.mp4`}
          />
        </div>
      </section>

      <section className="kb-shell kb-section">
        <SectionHead title="The fight">
          {kill.battleId ? (
            <Link href={battleHref(kill.battleId)} className="kb-signal-link">
              Battle <Chevron />
            </Link>
          ) : null}
        </SectionHead>
        <div className="kb-fight">
          <Fact label="Damage taken" tone="loss">
            <span>{formatNumber(totalDamage)}</span>
          </Fact>
          <Fact label="Attackers">
            <span>
              {attackers.length === 0
                ? "None"
                : players === 0
                  ? `${attackers.length} NPC${attackers.length === 1 ? "" : "s"}`
                  : `${attackers.length} · ${players} pilot${players === 1 ? "" : "s"}`}
            </span>
          </Fact>
          {topDamage ? (
            <Fact label="Top damage">
              <Art src={shipOf(topDamage.hull)} alt="" />
              <span>
                {topDamage.name}{" "}
                {totalDamage > 0
                  ? `${Math.round((topDamage.damage / totalDamage) * 100)}%`
                  : ""}
              </span>
            </Fact>
          ) : null}
          <Fact label="Build rating">
            <span>
              {formatNumber(victim.buildRating)}
              {attackerBr != null ? ` vs ${formatNumber(attackerBr)}` : ""}
            </span>
          </Fact>
          {items.length ? (
            <Fact label="Modules lost · dropped">
              <span>
                {destroyed} · {items.length - destroyed}
              </span>
            </Fact>
          ) : null}
          <Fact label="Hull · fitting · cargo">
            <span>
              {kill.value
                ? [kill.value.hull, kill.value.fitting, kill.value.cargo]
                    .map((value) => formatNumber(value))
                    .join(" · ")
                : "—"}
            </span>
          </Fact>
        </div>
        {byDamage.length ? (
          <ol className="kb-ledger kb-attackers">
            {byDamage.map((attacker, index) => (
              <li key={index} className="kb-row">
                <span className="kb-row-lead">
                  <Art src={shipOf(attacker.hull)} alt={attacker.hull.name} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="kb-row-name" style={{ display: "block" }}>
                    {attacker.pilotId ? (
                      <Link href={pilotHref(attacker.pilotId)}>{attacker.name}</Link>
                    ) : (
                      attacker.name
                    )}
                    {attacker.isFinalBlow ? (
                      <span className="kb-tag is-hot"> Final blow</span>
                    ) : null}
                  </span>
                  <span className="kb-tag">
                    {attacker.hull.name} · {formatNumber(attacker.buildRating)} BR
                  </span>
                </span>
                <span className="kb-row-value">
                  {formatNumber(attacker.damage)}
                  {totalDamage > 0
                    ? ` · ${Math.round((attacker.damage / totalDamage) * 100)}%`
                    : ""}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </section>

      <section className="kb-shell kb-section">
        <SectionHead
          title={loss ? "Loss manifest" : "Kill manifest"}
          count={formatOre(kill.value?.total)}
        />
        {kill.fitting || kill.cargo ? (
          <div className="kb-manifest-grids">
            {kill.fitting ? (
              <div>
                <div className="kb-label">
                  Fitting · {formatOre(kill.value?.fitting)}
                </div>
                <FittingGrid
                  grid={kill.fitting}
                  art={art}
                  tooltips={tooltips}
                  label={`${victim.name}'s fitting`}
                />
              </div>
            ) : null}
            {kill.cargo?.items.length ? (
              <div>
                <div className="kb-label">Cargo · {formatOre(kill.value?.cargo)}</div>
                <FittingGrid
                  grid={kill.cargo}
                  art={art}
                  tooltips={tooltips}
                  label={`${victim.name}'s cargo`}
                />
              </div>
            ) : null}
          </div>
        ) : (
          <div className="kb-empty">This build kept no manifest</div>
        )}
        <div className="kb-label kb-manifest-hint">
          Hover a module for its details · struck out: lost with the ship
        </div>
      </section>
    </main>
  );
}
