// Where models run (ONP-3 §5c): every known serving site, with its evidence basis and the
// models it serves, built from card locations (registered nodes and imports) plus the curated
// seeds: site-only providers (sites but no models) and entries that describe an existing node.
// Residency commitments (ONP-2 §3b, ONP-3 §5d) come from cards and seeds and are attached to
// each site they cover.
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  sendJson, problem, regionWithin, countryOf, basisRank, pointFor, distanceKm, parsePoint, precisionRank,
  residencyAt, residencyMeets, commitmentRank, scopeCovers, RESIDENCY_COMMITMENTS,
} from '@opennodes/core';
import { siteLocation } from './importers.js';

const DATA_DIR = fileURLToPath(new URL('./data/', import.meta.url));
const HIDDEN = ['delisted', 'suspended', 'submitted', 'challenged', 'disputed', 'claimed'];

/** The curated seeds bundled with the registry (src/data/locations-*.json). */
export function loadLocationSeeds(dir = DATA_DIR) {
  return readdirSync(dir).filter((f) => /^locations-.+\.json$/.test(f)).sort()
    .map((f) => JSON.parse(readFileSync(dir + f, 'utf8')));
}

/** `{seed}:{id}` -> seed provider, for `residency_of` references between seeds. */
const seedIndex = (seeds) => new Map(seeds.flatMap((seed) => (seed.providers ?? []).map((p) => [`${seed.seed}:${p.id}`, { seed, p }])));
/** A seed provider's own commitments, or those of the entry it points to with `residency_of`. */
const seedResidency = (index, p) => (p.residency_of ? index.get(p.residency_of)?.p.residency : p.residency) ?? null;

/**
 * Where the nodes a seed entry describes serve every one of their models: the entry's own live
 * sites when `placement` is "all", or the live sites of the entry named by `serves_from`
 * ("eu:scaleway": the whole API runs at that entry's sites). Search and recommend use these for
 * offerings whose card declares no location (ONP-3 §5); each location is marked `via: "seed"`.
 */
export function seedPlacements(seeds) {
  const index = seedIndex(seeds);
  const out = new Map();   // node id -> locations
  for (const seed of seeds) {
    for (const p of seed.providers ?? []) {
      if (p.models?.length || !p.nodes?.length) continue;
      const from = p.serves_from ? index.get(p.serves_from)?.p : p.placement === 'all' ? p : null;
      const locs = (from?.sites ?? []).map(siteLocation).filter((l) => (l.status ?? 'live') === 'live')
        .map(({ geo: _g, ...l }) => ({ ...l, via: 'seed' }));
      if (!locs.length) continue;
      for (const id of p.nodes) if (!out.has(id)) out.set(id, locs);
    }
  }
  return out;
}

/** Visible nodes with their latest cards. */
async function listedCards(store) {
  const cards = [];
  for (const node of await store.allNodes()) {
    if (HIDDEN.includes(node.state)) continue;
    const card = await store.latestCard(node.id);
    if (card) cards.push({ node, card });
  }
  return cards;
}

/** All sites, unfiltered: one entry per (node, region, site), models attached. */
export async function collectSites(store, seeds = []) {
  const sites = new Map();
  let located = 0, unlocated = 0;
  const index = seedIndex(seeds);
  const siteFor = (base, loc) => {
    const key = `${base.node_id}|${loc.region}|${loc.site ?? ''}`;
    if (!sites.has(key)) {
      const { commitments, ...rest } = base;
      sites.set(key, {
        ...rest,
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
        residency: commitments ? residencyAt(commitments, loc.region) : null,
        models: [],
        models_note: null,
      });
    }
    return sites.get(key);
  };

  const cards = await listedCards(store);
  const listed = new Set(cards.map((c) => c.node.id));

  // Seed entries that describe registered nodes (`nodes`): the first listed node holds the
  // sites; with placement "all", the offerings of every listed node are served there.
  const attached = new Map();   // node id -> { p, primary }
  for (const seed of seeds) {
    for (const p of seed.providers ?? []) {
      if (p.models?.length || !p.nodes?.length) continue;
      const primary = p.nodes.find((id) => listed.has(id));
      for (const id of p.nodes) if (listed.has(id)) attached.set(id, { p, primary });
    }
  }
  const residencyOf = new Map();  // node id -> commitments, from seeds
  for (const seed of seeds) {
    for (const p of seed.providers ?? []) {
      const r = seedResidency(index, p);
      if (!r) continue;
      if (p.models?.length) residencyOf.set(`import.seed.${seed.seed}.${p.id}`, r);
      for (const id of p.nodes ?? []) if (!residencyOf.has(id)) residencyOf.set(id, r);
    }
  }

  const bases = new Map();
  for (const { node, card } of cards) {
    // The registry's server-location check (location.js, ONP-3 §6.4) covers the node's API host,
    // not each site: shown beside the declared sites, never turning one into `measured` by itself.
    const check = (await store.getObservations(node.id, '_node')).location ?? null;
    const via = attached.get(node.id);
    const holds = via?.primary === node.id;
    bases.set(node.id, {
      node_id: node.id,
      provider: holds ? via.p.name : (card.node?.name ?? node.id),
      operator: card.node?.operator?.name ?? via?.p.operator?.name ?? null,
      operator_country: card.node?.operator?.country ?? via?.p.operator?.country ?? null,
      tier: node.state === 'indexed' ? 'unverified' : node.state,
      source: holds ? 'seed' : (node.source ?? 'registration'),
      server_check: check ? {
        verdict: check.verdict, server_country: check.server?.country ?? null,
        latency: check.latency?.verdict ?? 'unknown', checked_at: check.checked_at ?? null,
      } : null,
      commitments: card.node?.residency ?? residencyOf.get(node.id) ?? null,
    });
  }
  for (const { node, card } of cards) {
    const base = bases.get(node.id);
    for (const loc of card.node?.locations ?? []) siteFor(base, loc);
    const via = attached.get(node.id);
    const seedLocs = via ? (via.p.sites ?? []).map(siteLocation) : [];
    if (via?.primary === node.id) {
      for (const loc of seedLocs) {
        siteFor(base, loc).models_note = via.p.placement === 'all' ? null
          : (via.p.models_note ?? 'The provider does not say which models run at which site.');
      }
    }
    for (const o of card.offerings) {
      let locs = Array.isArray(o.locations) ? o.locations : (card.node?.locations ?? []);
      let holder = base;
      if (!locs.length && !Array.isArray(o.locations) && via?.p.placement === 'all' && seedLocs.length) {
        locs = seedLocs;
        holder = bases.get(via.primary);
      }
      if (!locs.length) { unlocated++; continue; }
      located++;
      for (const loc of locs) {
        siteFor(holder, loc).models.push({
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
      if (p.models?.length) continue;                       // imported as a card; its sites came in above
      if (p.nodes?.some((id) => listed.has(id))) continue;  // attached to a registered node above
      const base = {
        node_id: `import.seed.${seed.seed}.${p.id}`,
        provider: p.name,
        operator: p.operator?.name ?? p.name,
        operator_country: p.operator?.country ?? null,
        tier: 'unverified',
        source: 'seed',
        server_check: null,
        commitments: seedResidency(index, p),
      };
      for (const s of p.sites ?? []) siteFor(base, siteLocation(s)).models_note = p.models_note ?? 'Models not published';
    }
  }
  // Several nodes of one provider at one site: each model once.
  for (const s of sites.values()) {
    const seen = new Set();
    s.models = s.models.filter((m) => { const k = `${m.name}|${m.artifact}`; return !seen.has(k) && seen.add(k); });
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
  if (q('residency')) {
    if (!['processing', 'storage'].includes(q('residency'))) throw Object.assign(new Error('residency must be processing or storage'), { status: 400 });
    sites = sites.filter((s) => residencyMeets(s.residency, q('residency'), q('availability') ?? 'enterprise'));
  }
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
  'lat', 'lon', 'precision', 'derived', 'distance_km', 'residency'];
/** "processing EU (opt_in); none" — a site's or provider's commitments as one cell. */
export const residencyText = (list) => (list ?? []).map((r) => [r.commitment, (r.scope ?? []).join(r.per_region ? '|' : '+'),
  r.availability && r.availability !== 'default' ? `(${r.availability})` : ''].filter(Boolean).join(' ')).join('; ');
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
        residency: residencyText(s.residency),
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
      residency: residencyText(s.residency),
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

/**
 * Residency commitments per provider (ONP-3 §5d): curated seed entries (an entry that points to
 * another with `residency_of` is folded into it), registered cards that declare their own, and
 * every other listed node as unstated. Query: scope (a processing or storage commitment whose
 * scope lies within it), commitment (minimum), availability, kind, node_id.
 */
export async function buildResidency(store, seeds, query) {
  const q = (k) => query.get(k);
  if (q('commitment') && !['processing', 'storage'].includes(q('commitment'))) throw Object.assign(new Error('commitment must be processing or storage'), { status: 400 });
  const { sites } = await collectSites(store, seeds);
  const siteCount = new Map();
  for (const s of sites) siteCount.set(s.node_id, (siteCount.get(s.node_id) ?? 0) + 1);
  const index = seedIndex(seeds);
  const entries = new Map();
  const covered = new Set();
  for (const seed of seeds) {
    for (const p of seed.providers ?? []) {
      const key = p.residency_of && index.has(p.residency_of) ? p.residency_of : `${seed.seed}:${p.id}`;
      const holder = index.get(key).p;
      if (!entries.has(key)) {
        entries.set(key, {
          id: key, provider: holder.name, kind: holder.kind ?? null,
          operator: holder.operator?.name ?? null, operator_country: holder.operator?.country ?? null,
          node_ids: new Set(), sites: 0, source: 'seed', residency: holder.residency ?? [],
        });
      }
      const e = entries.get(key);
      for (const id of [...(p.nodes ?? []), `import.seed.${seed.seed}.${p.id}`]) { e.node_ids.add(id); covered.add(id); }
    }
  }
  for (const { node, card } of await listedCards(store)) {
    if (covered.has(node.id)) continue;
    entries.set(node.id, {
      id: node.id, provider: card.node?.name ?? node.id, kind: null,
      operator: card.node?.operator?.name ?? null, operator_country: card.node?.operator?.country ?? null,
      node_ids: new Set([node.id]), sites: 0,
      source: card.node?.residency ? 'card' : 'none', residency: card.node?.residency ?? [],
    });
  }
  let list = [...entries.values()].map((e) => {
    const ids = [...e.node_ids];
    const strongest = e.residency.reduce((best, r) => (commitmentRank(r.commitment) > commitmentRank(best) ? r.commitment : best), 'unstated');
    return { ...e, node_ids: ids, sites: ids.reduce((n, id) => n + (siteCount.get(id) ?? 0), 0),
      strongest: RESIDENCY_COMMITMENTS.includes(strongest) ? strongest : 'unstated' };
  });
  const availability = q('availability') ?? 'enterprise';
  const min = q('commitment') ?? (q('scope') ? 'storage' : null);
  if (min || q('scope')) {
    list = list.filter((e) => e.residency.some((r) => residencyMeets([r], min ?? 'unstated', availability)
      && (!q('scope') || (commitmentRank(r.commitment) >= 2 && (r.scope ?? []).length
        // One area: all of it inside the requested scope. Separate choices: one of them is.
        && (r.per_region ? r.scope.some : r.scope.every).call(r.scope, (s) => scopeCovers(q('scope'), s))))));
  }
  if (q('kind')) list = list.filter((e) => e.kind === q('kind'));
  if (q('node_id')) list = list.filter((e) => e.node_ids.includes(q('node_id')));
  list.sort((a, b) => a.provider.localeCompare(b.provider));
  const by = Object.fromEntries(RESIDENCY_COMMITMENTS.map((c) => [c, list.filter((e) => e.strongest === c).length]));
  return {
    generated_at: new Date().toISOString(),
    filters: Object.fromEntries([...query].filter(([k]) => k !== 'format')),
    summary: { providers: list.length, by_strongest_commitment: by },
    providers: list,
  };
}

const RESIDENCY_CSV = ['provider', 'kind', 'operator', 'operator_country', 'node_ids', 'sites', 'commitment', 'scope',
  'availability', 'programme', 'statement', 'source', 'checked'];
/** One row per provider and commitment; a provider with none gets one "unstated" row. */
export function residencyCsv(report) {
  const rows = [RESIDENCY_CSV.join(',')];
  for (const e of report.providers) {
    for (const r of e.residency.length ? e.residency : [{ commitment: 'unstated' }]) {
      const row = { ...e, ...r, node_ids: e.node_ids.join(' '), scope: (r.scope ?? []).join(' '), availability: r.availability ?? 'default' };
      rows.push(RESIDENCY_CSV.map((c) => csvCell(row[c])).join(','));
    }
  }
  return rows.join('\n') + '\n';
}

export function locationRoutes(store, seeds) {
  return [
    ['GET', '/v0/residency', async (req, res, { query }) => {
      let report;
      try { report = await buildResidency(store, seeds, query); }
      catch (err) { if (err.status === 400) return problem(res, 400, 'bad-query', err.message); throw err; }
      if (query.get('format') === 'csv') {
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'inline; filename="residency.csv"' });
        res.end(residencyCsv(report));
        return;
      }
      sendJson(res, 200, report);
    }],
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
