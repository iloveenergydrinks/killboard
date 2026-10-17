const number = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Ore value as the board shows it; unknown for kills from builds without card facts. */
export function formatOre(
  value: number | null | undefined,
  { short = false } = {},
) {
  if (value == null) return "—";
  return `${short ? compact.format(value) : number.format(value)} ORE`;
}

export function formatNumber(value: number | null | undefined) {
  return value == null ? "—" : number.format(Math.round(value));
}

export function formatUtc(iso: string) {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function formatAgo(iso: string, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 60) return `${days}d ago`;
  return iso.slice(0, 10);
}

export function formatPercent(value: number | null) {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

const CAUSES: Record<string, string> = {
  Unspecified: "Destroyed",
  BreachCollapse: "Breach collapse",
  ReconnectLoss: "Lost while disconnected",
  ReactorStarvation: "Reactor starvation",
};

export function formatCause(cause: string) {
  return CAUSES[cause] ?? cause;
}

const TIER_NUMERALS = [
  "",
  "I",
  "II",
  "III",
  "IV",
  "V",
  "VI",
  "VII",
  "VIII",
  "IX",
  "X",
];

/** A zone as the game's kill card names it: the region and its tier numeral (killCardContent.ts). */
export function formatZone(
  regionName: string,
  tier?: number | null,
  isTravelLane = false,
) {
  if (!regionName) return "Unknown zone";
  const numeral =
    tier == null ? "" : tier > 10 ? String(tier) : (TIER_NUMERALS[tier] ?? "");
  if (
    isTravelLane ||
    !numeral ||
    regionName.toUpperCase().endsWith(` ${numeral}`)
  )
    return regionName;
  return `${regionName} ${numeral}`;
}

export function tierLabel(tier: number) {
  return tier > 10 ? String(tier) : TIER_NUMERALS[tier] || "0";
}

export const enc = encodeURIComponent;
