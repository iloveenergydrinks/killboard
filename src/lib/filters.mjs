// Killboard filters: the URL's search parameters, parsed into a filter, and links that change one.
// Each field is a filter of the game data API's kill routes (https://api.thecitadel.com/v1/kills),
// under the same name; `hull` is a ship's name (the API's `hullName`) and `cursor` its page cursor.

export const PAGE_SIZE = 50;
export const SORTS = ["recent", "value", "br"];
export const KINDS = ["pvp", "pve"];
export const SIZES = ["solo", "gang"];

const TEXT_FIELDS = ["zoneId", "zone", "hull", "class", "cause", "pilot"];
const INTEGER_FIELDS = ["tier", "brMin", "brMax", "valueMin", "valueMax"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR = /^[\w-]{1,200}$/;

/**
 * Reads a filter from search parameters (a URLSearchParams or Next's searchParams object).
 * Unknown or malformed values are dropped, never passed on.
 */
export function parseFilters(searchParams) {
  const get = (name) => {
    const value =
      typeof searchParams?.get === "function"
        ? searchParams.get(name)
        : searchParams?.[name];
    const single = Array.isArray(value) ? value[0] : value;
    return typeof single === "string" ? single.trim() : "";
  };

  const filters = {};
  for (const field of TEXT_FIELDS) {
    const value = get(field);
    if (value && value.length <= 80) filters[field] = value;
  }
  for (const field of INTEGER_FIELDS) {
    const value = get(field);
    if (/^\d{1,9}$/.test(value)) filters[field] = Number(value);
  }
  const kind = get("kind");
  if (KINDS.includes(kind)) filters.kind = kind;
  const size = get("size");
  if (SIZES.includes(size)) filters.size = size;
  for (const field of ["from", "to"]) {
    const value = get(field);
    if (DATE.test(value) && !Number.isNaN(Date.parse(value)))
      filters[field] = value;
  }
  const sort = get("sort");
  filters.sort = SORTS.includes(sort) ? sort : "recent";
  const cursor = get("cursor");
  if (CURSOR.test(cursor)) filters.cursor = cursor;
  return filters;
}

/** The API's query parameters for a filter (sort and cursor included). */
export function apiParams(filters) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value == null || value === "") continue;
    if (key === "sort" && value === "recent") continue;
    params.set(key === "hull" ? "hullName" : key, String(value));
  }
  return params;
}

/**
 * The link for a filter with some fields changed (null removes a field). The cursor resets to
 * the first page unless the change sets it.
 */
export function filterHref(path, filters, changes = {}) {
  const next = { ...filters, cursor: null, ...changes };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(next)) {
    if (value == null || value === "") continue;
    if (key === "sort" && value === "recent") continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
