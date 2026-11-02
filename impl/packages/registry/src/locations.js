// Where models run (ONP-3 §5c): every known serving site, with its evidence basis and the
// models it serves, built from card locations (registered nodes and imports) plus the
// site-only entries of the curated seeds (providers that publish sites but not models).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  sendJson, problem, regionWithin, countryOf, basisRank, pointFor, distanceKm, parsePoint, precisionRank,
} from '@opennodes/core';
import { siteLocation } from './importers.js';

const DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url));
const HIDDEN = ['delisted', 'suspended', 'submitted', 'challenged', 'disputed', 'claimed'];

/** The curated seeds bundled with the registry (src/data/locations-*.json). */
export function loadLocationSeeds(dir = DATA_DIR) {
  return readdirSync(dir).filter((f) => /^locations-.+\.json$/.test(f)).sort()
    .map((f) => JSON.parse(readFileSync(dir + f, 'utf8')));
}

/** All sites, unfiltered: one entry per (node, region, site), models attached. */
export async function collectSites(store, seeds = []) {
  const sites = new Map();
  let located = 0, unlocated = 0;
  const siteFor = (base, loc) => {
    const key = `${base.node_id}|${loc.region}|${loc.site ?? ''}`;
    if (!sites.has(key)) {
      sites.set(key, {
        ...base,
        country: countryOf(loc.region),
        region: loc.region,
        site: loc.site ?? null,
        status: loc.status ?? 'live',
        basis: loc.basis,
        facility_operator: loc.facility_operator ?? null,
        source_url: loc.source ?? null,
        checked: loc.checked ?? null,
        note: loc.note ?? null,
        geo: pointFor(loc),   // declared point, else an approximate one from the region (derived: true)
        models: [],
        models_note: null,
      });
    }
    return sites.get(key);
  };

  for (const node of await store.allNodes()) {
    if (HIDDEN.includes(node.state)) continue;
    const card = await store.latestCard(node.id);
    if (!card) continue;
    // The registry's server-location check (location.js, ONP-3 §6.4) covers the node's API host,
    // not each site: shown beside the declared sites, never turning one into `measured` by itself.
    const check = (await store.getObservations(node.id, '_node')).location ?? null;
    const base = {
      node_id: node.id,
      provider: card.node?.name ?? node.id,
      operator: card.node?.operator?.name ?? null,
      operator_country: card.node?.operator?.country ?? null,
      tier: node.state === 'indexed' ? 'unverified' : node.state,
      source: node.source ?? 'registration',
      server_check: check ? {
        verdict: check.verdict, server_country: check.server?.country ?? null,
        latency: check.latency?.verdict ?? 'unknown', checked_at: check.checked_at ?? null,
      } : null,
    };
    for (const loc of card.node?.locations ?? []) siteFor(base, loc);
    for (const o of card.offerings) {
      const locs = Array.isArray(o.locations) ? o.locations : (card.node?.locations ?? []);
      if (!locs.length) { unlocated++; continue; }
      located++;
      for (const loc of locs) {
        siteFor(base, loc).models.push({
          offering_id: o.offering_id,
          name: o.model.name,
          artifact: o.model.artifact,
          family: o.model.family ?? null,
          modality: o.modality,
          lineage_origins: o.model.lineage_origins ?? null,
          invocable: Boolean(card.endpoints?.openai),
        });
      }
    }
  }

  for (const seed of seeds) {
    for (const p of seed.providers ?? []) {
      if (p.models?.length) continue; // imported as a card; its sites came in above
      const base = {
        node_id: `import.seed.${seed.seed}.${p.id}`,
        provider: p.name,
        operator: p.operator?.name ?? p.name,
        operator_country: p.operator?.country ?? null,
        tier: 'unverified',
        source: 'seed',
        server_check: null,
      };
      for (const s of p.sites ?? []) siteFor(base, siteLocation(s)).models_note = p.models_note ?? 'Models not published';
    }
  }
  return { sites: [...sites.values()], located_offerings: located, unlocated_offerings: unlocated };
}

/**
 * Filter and summarise. Query: country | region (containment), basis (minimum evidence),
 * status (live | planned), model (substring of name or artifact), exclude_lineage (CSV of
 * countries; drops those models, keeps undeclared lineage), near=lat,lon (adds distance_km,
 * nearest first) with within_km (radius; country-level points never match), format=csv|geojson.
 */
export async function buildLocations(store, seeds, query) {
  const q = (k) => query.get(k);
  const near = q('near') ? parsePoint(q('near')) : null;
  if (q('near') && !near) throw Object.assign(new Error('near must be "lat,lon" in decimal degrees, e.g. 45.50,-73.57'), { status: 400 });
  if (q('within_km') && !(near && Number(q('within_km')) > 0)) throw Object.assign(new Error('within_km needs near and a positive number of km'), { status: 400 });
  const all = await collectSites(store, seeds);
  let sites = all.sites;
  const where = q('region') ?? q('country');
  if (where) sites = sites.filter((s) => regionWithin(s.region, where));
  if (q('basis')) sites = sites.filter((s) => basisRank(s.basis) >= basisRank(q('basis')));
  if (q('status')) sites = sites.filter((s) => s.status === q('status'));
  const banned = q('exclude_lineage')?.toUpperCase().split(',') ?? [];
  const needle = q('model')?.toLowerCase();
  if (banned.length || needle) {
    sites = sites.map((s) => ({
      ...s,
      models: s.models.filter((m) => !(m.lineage_origins ?? []).some((c) => banned.includes(c))
        && (!needle || `${m.name} ${m.artifact}`.toLowerCase().includes(needle))),
    }));
    if (needle) sites = sites.filter((s) => s.models.length);
  }
  sites.sort((a, b) => a.country.localeCompare(b.country) || a.region.localeCompare(b.region)
    || a.provider.localeCompare(b.provider) || String(a.site).localeCompare(String(b.site)));
  if (near) {
    sites = sites.map((s) => ({ ...s, distance_km: s.geo ? Math.round(distanceKm(near, s.geo)) : null }));
    if (q('within_km')) {
      // A radius is only meaningful for points placed at least to the region.
      const r = Number(q('within_km'));
      sites = sites.filter((s) => s.distance_km != null && s.distance_km <= r && precisionRank(s.geo.precision) <= precisionRank('region'));
    }
    sites.sort((a, b) => (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity));  // stable: ties keep country order
  }

  const countries = new Map();
  for (const s of sites) {
    const c = countries.get(s.country) ?? { country: s.country, providers: new Set(), sites: 0, live_sites: 0, models: new Set() };
    c.providers.add(s.node_id);
    c.sites++;
    if (s.status === 'live') c.live_sites++;
    for (const m of s.models) c.models.add(m.artifact);
    countries.set(s.country, c);
  }
  return {
    generated_at: new Date().toISOString(),
    filters: Object.fromEntries([...query].filter(([k]) => k !== 'format')),
    summary: {
      countries: countries.size,
      sites: sites.length,
      located_offerings: all.located_offerings,
      unlocated_offerings: all.unlocated_offerings,
    },
    countries: [...countries.values()].map((c) => ({
      country: c.country, providers: c.providers.size, sites: c.sites, live_sites: c.live_sites, models: c.models.size,
    })),
    sites,
  };
}

const CSV_COLUMNS = ['country', 'region', 'site', 'status', 'basis', 'provider', 'operator', 'operator_country',
  'facility_operator', 'node_id', 'tier', 'source', 'model', 'artifact', 'lineage_origins', 'source_url', 'checked', 'note',
  'lat', 'lon', 'precision', 'derived', 'distance_km'];
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per site and model; a site with no published models gets one row with its note. */
export function locationsCsv(report) {
  const rows = [CSV_COLUMNS.join(',')];
  for (const s of report.sites) {
    const models = s.models.length ? s.models : [{ name: s.models_note ?? '', artifact: '', lineage_origins: null }];
    for (const m of models) {
      const row = {
        ...s, model: m.name, artifact: m.artifact, lineage_origins: (m.lineage_origins ?? []).join(' '),
        lat: s.geo?.lat, lon: s.geo?.lon, precision: s.geo?.precision, derived: s.geo?.derived,
      };
      rows.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(','));
    }
  }
  return rows.join('\n') + '\n';
}

/**
 * RFC 7946 GeoJSON: one Point feature per site with a point ([lon, lat]). Properties are flat
 * (lists joined with "; ") so desktop GIS tools (QGIS, ArcGIS) read them as plain columns.
 * Sites with no point at all are counted in the foreign member `unmapped`.
 */
export function locationsGeoJson(report) {
  const features = report.sites.filter((s) => s.geo).map((s) => ({
    type: 'Feature',
    id: `${s.node_id}|${s.region}|${s.site ?? ''}`,
    geometry: { type: 'Point', coordinates: [s.geo.lon, s.geo.lat] },
    properties: {
      provider: s.provider, operator: s.operator, operator_country: s.operator_country,
      node_id: s.node_id, tier: s.tier, source: s.source,
      country: s.country, region: s.region, site: s.site, status: s.status, basis: s.basis,
      facility_operator: s.facility_operator, source_url: s.source_url, checked: s.checked, note: s.note,
      precision: s.geo.precision, derived: s.geo.derived,
      models_count: s.models.length,
      models: s.models.map((m) => m.name).join('; '),
      lineage: [...new Set(s.models.flatMap((m) => m.lineage_origins ?? []))].join('; '),
      models_note: s.models_note,
      ...(s.distance_km !== undefined ? { distance_km: s.distance_km } : {}),
    },
  }));
  return {
    type: 'FeatureCollection',
    generated_at: report.generated_at,
    filters: report.filters,
    unmapped: report.sites.length - features.length,
    features,
  };
}

export function locationRoutes(store, seeds) {
  return [
    ['GET', '/v0/locations', async (req, res, { query }) => {
      let report;
      try { report = await buildLocations(store, seeds, query); }
      catch (err) { if (err.status === 400) return problem(res, 400, 'bad-query', err.message); throw err; }
      const format = query.get('format');
      if (format === 'csv') {
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'inline; filename="locations.csv"' });
        res.end(locationsCsv(report));
        return;
      }
      if (format === 'geojson') {
        res.writeHead(200, { 'content-type': 'application/geo+json; charset=utf-8', 'content-disposition': 'inline; filename="locations.geojson"' });
        res.end(JSON.stringify(locationsGeoJson(report)));
        return;
      }
      sendJson(res, 200, report);
    }],
  ];
}
