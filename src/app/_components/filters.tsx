import Link from "next/link";
import type { KillboardArt } from "#/lib/art-server";
import { filterHref } from "#/lib/filters.mjs";
import { Art, Chevron } from "./components";
import { formatCause } from "./format";

export type Filters = {
  zoneId?: string;
  // A zone by name, from links made before zones had ids.
  zone?: string;
  tier?: number;
  hull?: string;
  class?: string;
  cause?: string;
  pilot?: string;
  brMin?: number;
  brMax?: number;
  valueMin?: number;
  valueMax?: number;
  kind?: string;
  size?: string;
  from?: string;
  to?: string;
  sort: string;
  cursor?: string;
};

export type FilterOptions = {
  zones: { id: string; name: string; isTournament: boolean }[];
  // Every ship the board names, with the id of its hull where it has one.
  hulls: { name: string; def: string | null }[];
  classes: string[];
  causes: string[];
  tiers: { index: number; name: string }[];
};

// Filters the quick chips and the hull strip already show; the rest open the full form.
const QUICK = new Set(["kind", "size", "hull", "sort", "cursor"]);

function Select({
  name,
  label,
  value,
  options,
  groups,
}: {
  name: string;
  label: string;
  value?: string | number;
  options?: [string, string][];
  groups?: { group: string; hulls: { name: string }[] }[];
}) {
  return (
    <div className="kb-field">
      <label htmlFor={`kb-${name}`} className="kb-label">
        {label}
      </label>
      <select
        id={`kb-${name}`}
        name={name}
        defaultValue={value == null ? "" : String(value)}
      >
        <option value="">Any</option>
        {groups?.map(({ group, hulls }) => (
          <optgroup key={group} label={group.toUpperCase()}>
            {hulls.map((hull) => (
              <option key={hull.name} value={hull.name}>
                {hull.name}
              </option>
            ))}
          </optgroup>
        ))}
        {options?.map(([optionValue, text]) => (
          <option key={optionValue} value={optionValue}>
            {text}
          </option>
        ))}
      </select>
    </div>
  );
}

function Range({
  label,
  min,
  max,
  value,
}: {
  label: string;
  min: string;
  max: string;
  value: [number | undefined, number | undefined];
}) {
  return (
    <div className="kb-field">
      <label htmlFor={`kb-${min}`} className="kb-label">
        {label}
      </label>
      <div className="kb-range">
        <input
          id={`kb-${min}`}
          type="number"
          name={min}
          min={0}
          placeholder="MIN"
          defaultValue={value[0] ?? ""}
        />
        <input
          type="number"
          name={max}
          min={0}
          placeholder="MAX"
          defaultValue={value[1] ?? ""}
          aria-label={`${label} max`}
        />
      </div>
    </div>
  );
}

/**
 * Every killboard filter. Quick chips and a strip of the hulls on the board toggle the common
 * cuts; the full form is a plain GET form behind a no-script toggle, so a filtered view is a
 * shareable URL and the page works without client JavaScript.
 */
export function FilterBar({
  path,
  filters,
  options,
  art,
}: {
  path: string;
  filters: Filters;
  options: FilterOptions;
  art: KillboardArt;
}) {
  const toggle = (label: string, changes: Partial<Filters>, on: boolean) => (
    <Link
      key={label}
      href={filterHref(
        path,
        filters,
        on
          ? Object.fromEntries(Object.keys(changes).map((key) => [key, null]))
          : changes,
      )}
      className={`kb-chip${on ? " is-active" : ""}`}
    >
      {label}
    </Link>
  );
  const set = Object.entries(filters).filter(
    ([key, value]) => key !== "sort" && key !== "cursor" && value != null,
  );
  const formOpen = set.some(([key]) => !QUICK.has(key));
  const hullGroups = art.hullGroups(options.hulls);
  return (
    <div className="kb-filterbox">
      <input
        type="checkbox"
        id="kb-filters-toggle"
        className="kb-sr-only"
        defaultChecked={formOpen}
      />
      <div className="kb-toolbar">
        {toggle("PvP", { kind: "pvp" }, filters.kind === "pvp")}
        {toggle("PvE", { kind: "pve" }, filters.kind === "pve")}
        {toggle("Solo", { size: "solo" }, filters.size === "solo")}
        {toggle("Gang", { size: "gang" }, filters.size === "gang")}
        {toggle("Most valuable", { sort: "value" }, filters.sort === "value")}
        {toggle("Highest BR", { sort: "br" }, filters.sort === "br")}
        <span className="kb-toolbar-spacer" />
        {set.length ? (
          <Link href={path} className="kb-chip">
            Clear {set.length}
          </Link>
        ) : null}
        <label htmlFor="kb-filters-toggle" className="kb-chip kb-filters-label">
          All filters <Chevron />
        </label>
      </div>
      <form method="get" action={path} className="kb-filters">
        {filters.pilot ? (
          <input type="hidden" name="pilot" value={filters.pilot} />
        ) : null}
        <Select
          name="zoneId"
          label="Zone"
          value={filters.zoneId}
          options={options.zones.map((zone) => [
            zone.id,
            // Event routes reuse public zone names.
            zone.isTournament ? `${zone.name} · event` : zone.name,
          ])}
        />
        <Select
          name="tier"
          label="Tier"
          value={filters.tier}
          options={options.tiers.map((tier) => [
            String(tier.index),
            tier.name,
          ])}
        />
        <Select
          name="hull"
          label="Ship"
          value={filters.hull}
          groups={hullGroups}
        />
        <Select
          name="class"
          label="Class"
          value={filters.class}
          options={options.classes.map((shipClass) => [shipClass, shipClass])}
        />
        <Range
          label="Build rating"
          min="brMin"
          max="brMax"
          value={[filters.brMin, filters.brMax]}
        />
        <Range
          label="Value · ore"
          min="valueMin"
          max="valueMax"
          value={[filters.valueMin, filters.valueMax]}
        />
        <Select
          name="cause"
          label="Cause"
          value={filters.cause}
          options={options.causes.map((cause) => [cause, formatCause(cause)])}
        />
        <Select
          name="kind"
          label="Attackers"
          value={filters.kind}
          options={[
            ["pvp", "Players"],
            ["pve", "NPCs only"],
          ]}
        />
        <Select
          name="size"
          label="Fight"
          value={filters.size}
          options={[
            ["solo", "Solo"],
            ["gang", "Gang"],
          ]}
        />
        <div className="kb-field">
          <label htmlFor="kb-from" className="kb-label">
            From
          </label>
          <input
            id="kb-from"
            type="date"
            name="from"
            defaultValue={filters.from ?? ""}
          />
        </div>
        <div className="kb-field">
          <label htmlFor="kb-to" className="kb-label">
            To
          </label>
          <input
            id="kb-to"
            type="date"
            name="to"
            defaultValue={filters.to ?? ""}
          />
        </div>
        <div className="kb-field">
          <label htmlFor="kb-sort" className="kb-label">
            Sort
          </label>
          <select id="kb-sort" name="sort" defaultValue={filters.sort}>
            <option value="recent">Newest</option>
            <option value="value">Value</option>
            <option value="br">Build rating</option>
          </select>
        </div>
        <div className="kb-filter-actions">
          <button type="submit" className="kb-button">
            Apply <Chevron double />
          </button>
        </div>
      </form>
      <HullStrip path={path} filters={filters} groups={hullGroups} />
    </div>
  );
}

/** Every hull as its render, grouped by role; one click filters the feed to that ship. */
function HullStrip({
  path,
  filters,
  groups,
}: {
  path: string;
  filters: Filters;
  groups: { group: string; hulls: { name: string; image: string | null }[] }[];
}) {
  return (
    <nav className="kb-hulls" aria-label="Filter by ship">
      {groups.map(({ group, hulls }) => (
        <section key={group} className="kb-hull-group">
          <h3 className="kb-label">{group}</h3>
          <div className="kb-hull-row">
            {hulls.map((hull) => {
              const selected = filters.hull === hull.name;
              return (
                <Link
                  key={hull.name}
                  href={filterHref(path, filters, {
                    hull: selected ? null : hull.name,
                  })}
                  className={`kb-hull${selected ? " is-active" : ""}`}
                  aria-current={selected ? "true" : undefined}
                >
                  <Art src={hull.image} alt="" />
                  <span className="kb-label">{hull.name}</span>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </nav>
  );
}
