// Region containment (ONP-2 §3): case-insensitive codes where a code contains its own
// subdivisions, so "CA" contains "CA-QC" and legacy "eu" contains "eu-central".

/** Is region `code` inside `required`? */
export function regionWithin(code, required) {
  const c = String(code).toLowerCase();
  const r = String(required).toLowerCase();
  return c === r || c.startsWith(`${r}-`);
}

/**
 * Does a residency list satisfy a requirement? Every listed location must lie inside
 * `required`; an empty list proves nothing and never satisfies it.
 */
export function residencyWithin(codes, required) {
  return codes.length > 0 && codes.every((c) => regionWithin(c, required));
}

/** The country part of a region code: "CA-QC" -> "CA", "eu-central" -> "EU". */
export const countryOf = (code) => String(code).split('-')[0].toUpperCase();

// Location evidence (ONP-2 §3a), weakest first. Unknown values count as claimed.
export const LOCATION_BASES = ['claimed', 'documented', 'measured', 'attested'];
export const basisRank = (basis) => Math.max(0, LOCATION_BASES.indexOf(basis));

/**
 * Where an offering is served (ONP-2 §3a): its own `locations` when the property is present
 * (an empty list means "unknown" and overrides the node), else the node's. Only live sites
 * count; a missing status is live, an unknown one is treated as planned.
 */
export function servingLocations(offering, card) {
  const list = Array.isArray(offering?.locations) ? offering.locations : (card?.node?.locations ?? []);
  return list.filter((l) => (l.status ?? 'live') === 'live');
}

/**
 * Region codes a residency check must cover: every pinned region and every live serving
 * location, falling back to the node's declared `regions` when neither is given.
 */
export function residencyCodes(offering, card) {
  const pins = offering?.data_policy?.region_pinning ?? [];
  const sites = servingLocations(offering, card).map((l) => l.region);
  const codes = [...pins, ...sites];
  return codes.length ? codes : (card?.node?.regions ?? []);
}
