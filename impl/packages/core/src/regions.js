// Region containment (ONP-2 §3): case-insensitive codes where a code contains its own
// subdivisions, so "CA" contains "CA-QC" and legacy "eu" contains "eu-central"; "EU" and "EEA"
// also contain their member states, and the EEA contains the EU.

/** ISO 3166-1 alpha-2 for a country code; "UK" is the common name for GB (ISO reserves UK). */
export const isoCountry = (c) => { const u = String(c).trim().toUpperCase(); return u === 'UK' ? 'GB' : u; };
/** A region code with its country part in ISO form: "uk-lnd" -> "gb-lnd". */
const isoRegion = (code) => String(code).trim().toLowerCase().replace(/^uk(?=-|$)/, 'gb');

const EU_STATES = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
  'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE']);
const EEA_STATES = new Set([...EU_STATES, 'IS', 'LI', 'NO']);
const UNIONS = { eu: EU_STATES, eea: EEA_STATES };

/** Is region `code` inside `required`? "DE-HE" is inside "DE", "EU" and "EEA"; "NO" only in "EEA". */
export function regionWithin(code, required) {
  const c = isoRegion(code);
  const r = isoRegion(required);
  if (c === r || c.startsWith(`${r}-`)) return true;
  return Boolean(UNIONS[r]) && (UNIONS[r].has(countryOf(code)) || (r === 'eea' && regionWithin(code, 'EU')));
}

/**
 * Does a residency list satisfy a requirement? Every listed location must lie inside
 * `required`; an empty list proves nothing and never satisfies it.
 */
export function residencyWithin(codes, required) {
  return codes.length > 0 && codes.every((c) => regionWithin(c, required));
}

/** The country part of a region code: "CA-QC" -> "CA", "eu-central" -> "EU". */
export const countryOf = (code) => isoCountry(String(code).split('-')[0]);

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

// Residency commitments (ONP-2 §3b), strongest first. Unknown commitments count as unstated;
// unknown availability counts as enterprise (the narrowest offer).
export const RESIDENCY_COMMITMENTS = ['processing', 'storage', 'none', 'unstated'];
export const RESIDENCY_AVAILABILITY = ['default', 'opt_in', 'enterprise'];
/** Higher is stronger: processing 3, storage 2, none 1, unstated 0. */
export const commitmentRank = (c) => { const i = RESIDENCY_COMMITMENTS.indexOf(c); return i < 0 ? 0 : RESIDENCY_COMMITMENTS.length - 1 - i; };
/** Lower is wider: default 0, opt_in 1, enterprise (or unknown) 2. */
export const availabilityRank = (a) => { const i = RESIDENCY_AVAILABILITY.indexOf(a ?? 'default'); return i < 0 ? 2 : i; };

/** Does residency `scope` (one code) cover `region`? The same containment as search (regionWithin). */
export const scopeCovers = (scope, region) => regionWithin(region, scope);

/**
 * The commitments that apply at a site in `region`: a processing or storage promise whose scope
 * covers the region, plus every none or unstated entry (they apply everywhere). A per-region
 * promise is narrowed to the choice that covers the site ("US or EU or JP" in Ohio is "US").
 */
export function residencyAt(commitments, region) {
  return (commitments ?? []).filter((r) => commitmentRank(r.commitment) < 2
    || (r.scope ?? []).some((s) => scopeCovers(s, region)))
    .map((r) => (r.per_region ? { ...r, scope: r.scope.filter((s) => scopeCovers(s, region)) } : r));
}

/** Is there a commitment at least as strong as `commitment`, offered at `availability` or wider? */
export function residencyMeets(commitments, commitment, availability = 'enterprise') {
  return (commitments ?? []).some((r) => commitmentRank(r.commitment) >= commitmentRank(commitment)
    && availabilityRank(r.availability) <= availabilityRank(availability));
}
