// Offering search + transparent ranking (ONP-3 §5–6).
import {
  residencyWithin, residencyCodes, servingLocations, basisRank,
  inJurisdiction, localSizes, pullsOf, specialtyOf, isEmbedder,
  trustedView, poolOf, inTrustedPool, lineageAllowed, meetsDataPolicy, RETENTION_LEVELS,
} from '@opennodes/core';
import { testable } from './probes.js';

/** BCP 47 prefix match (ONP-3 §5): `fr` matches `fr` and `fr-CA`; `fr-CA` matches only itself. */
export const langMatches = (tag, wanted) => {
  const t = String(tag).toLowerCase();
  const w = String(wanted).toLowerCase();
  return t === w || t.startsWith(`${w}-`);
};

export const RANK_COMPONENTS = { price: 0.35, tier: 0.35, probe_success: 0.30 };
const TIER_SCORE = { unverified: 0, community: 0.4, verified: 0.8, attested: 1.0 };

// The assembled catalog (10k+ offerings, ~one store read each) is kept in memory per store and
// rebuilt only after a write (see watchStoreWrites) or after MAX_AGE_MS as a safety net. Concurrent
// requests share one rebuild. Callers must not mutate the returned offerings.
const MAX_AGE_MS = 60_000;
const catalogs = new WeakMap();   // store -> { items, at, stale, building }

// Curated seed placements (locations.js seedPlacements): node id -> where it serves every model.
const placements = new WeakMap();   // store -> Map
// A request to these hosts passes through a third-party router before it reaches the provider, so
// the provider's sites say nothing about where the prompt goes: no seed placement for them.
const ROUTER_HOSTS = new Set(['router.huggingface.co', 'openrouter.ai']);
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return null; } };

/** Use these seed placements in search from now on (the server sets them at start and on seed import). */
export function setSeedPlacements(store, map) {
  placements.set(store, map);
  markCatalogStale(store);
}

// The registry's trusted view (core trustedView: jurisdictions from ONP_TRUSTED_JURISDICTIONS).
const trustedViews = new WeakMap();   // store -> view

/** Use this trusted view for `pool` labels and `trust=trusted` from now on (the server sets it at start). */
export function setTrustedView(store, view) {
  trustedViews.set(store, view);
  markCatalogStale(store);
}
export const trustedViewOf = (store) => trustedViews.get(store) ?? trustedView();

/** Mark the cached catalog stale: the next read rebuilds it. */
export function markCatalogStale(store) {
  const entry = catalogs.get(store);
  if (entry) entry.stale = true;
}

/** Wrap the store's write methods so any change to nodes, cards, probes or observations marks the catalog stale. */
export function watchStoreWrites(store) {
  for (const name of ['upsertNode', 'setState', 'setNodeFlag', 'saveRevision', 'recordProbe', 'addFingerprints', 'setObservation']) {
    const write = store[name];
    if (typeof write !== 'function' || write.__marksCatalogStale) continue;
    const wrapped = async function (...args) {
      try { return await write.apply(this, args); } finally { markCatalogStale(store); }
    };
    wrapped.__marksCatalogStale = true;
    store[name] = wrapped;
  }
  return store;
}

/** Searchable offering summaries, from memory when nothing has changed. */
export async function collectOfferings(store) {
  let entry = catalogs.get(store);
  if (entry?.items && !entry.stale && Date.now() - entry.at < MAX_AGE_MS) return entry.items;
  if (entry?.building) return entry.building;
  if (!entry) { entry = {}; catalogs.set(store, entry); }
  entry.stale = false;   // a write landing during the rebuild sets it again, so the next read rebuilds
  entry.building = buildOfferings(store).then(
    (items) => { entry.items = items; entry.at = Date.now(); entry.building = null; return items; },
    (err) => { entry.building = null; throw err; });
  return entry.building;
}

/** Flatten indexed nodes into searchable offering summaries. */
async function buildOfferings(store) {
  const out = [];
  const view = trustedViewOf(store);
  for (const node of await store.allNodes()) {
    if (['delisted', 'suspended', 'submitted', 'challenged', 'disputed', 'claimed'].includes(node.state)) continue;
    const card = await store.latestCard(node.id);
    if (!card) continue;
    const probes = await store.probesFor(node.id);
    // Pass rate over the recent window of conformance (A) and continuous (C) checks. Stage A
    // alone runs every 6 h and is pushed out of the window by liveness checks within hours,
    // which left healthy verified nodes showing 0 probes and a 0 pass rate.
    const checks = probes.filter((p) => p.stage === 'A' || p.stage === 'C');
    const probeSuccess = checks.length ? checks.filter((p) => p.ok).length / checks.length : 0;
    const tier = node.state === 'indexed' ? 'unverified' : node.state;
    const nodeObs = await store.getObservations(node.id, '_node');
    const availability = nodeObs.availability ?? null;
    const loc = nodeObs.location ?? null;
    const placed = ROUTER_HOSTS.has(hostOf(card.endpoints?.openai)) ? null : placements.get(store)?.get(node.id);
    // Server-location check (location.js): what the registry found, next to what the operator declared.
    const location = loc ? {
      verdict: loc.verdict, server_country: loc.server?.country ?? null, network: loc.server?.network ?? null,
      cdn: Boolean(loc.server?.cdn), latency: loc.latency?.verdict ?? 'unknown', checked_at: loc.checked_at,
    } : null;
    for (const declared of card.offerings) {
      // No location on the card: a curated seed may say where this node serves every model.
      const offering = placed && !Array.isArray(declared.locations) && !(card.node?.locations ?? []).length
        ? { ...declared, locations: placed } : declared;
      const obs = await store.getObservations(node.id, offering.offering_id);
      // Measured values override claims (DS-ADM-03/04): cap the advertised context to
      // the verified size, and surface registry-measured latency/throughput.
      const serving = { ...offering.serving };
      if (obs.context_cap != null && obs.context_cap < (serving.context_window ?? Infinity)) {
        serving.context_window = obs.context_cap;
        serving.context_capped_from = offering.serving.context_window;
      }
      // Verification covers only profiles the tests can call (ONP-3 §4a): another offering does
      // not inherit the node's tier. Imported listings are never tested.
      const covered = testable(offering);
      out.push({
        node_id: node.id,
        offering_id: offering.offering_id,
        tier: covered ? tier : 'unverified',
        tested: covered && node.source !== 'import',
        source: node.source ?? 'registration',
        institutional: Boolean(node.institutional),
        founding: Boolean(node.founding),   // admin-set label (ONP-3 §4b), never a rank input
        card_revision: card.revision,
        modality: offering.modality,
        modalities: offering.modalities ?? null,
        local: offering.local ?? null,
        model: offering.model,
        serving,
        binding: offering.binding,
        pricing: offering.pricing,
        data_policy: offering.data_policy ?? null,
        node_regions: card.node?.regions ?? [],
        // Where the operator is (ONP-2 node.operator.country, node.regions).
        // Registered nodes declare it in their signed card; imports get it from the importer's list of
        // known providers, labeled inferred. `location` is the registry's own server-location check.
        jurisdiction: {
          country: card.node?.operator?.country ?? null,
          regions: card.node?.regions ?? [],
          basis: card.node?.operator?.country ? (node.source === 'import' ? 'inferred' : 'declared') : null,
          location,
        },
        // Where requests are served: live sites with their evidence basis (ONP-2 §3a), and the
        // codes a residency check must cover (pins + sites, else node regions).
        locations: servingLocations(offering, card),
        residency: residencyCodes(offering, card),
        // Allocated hardware for THIS offering (offering-level override wins over the
        // node-level description) — same artifact on different vendors runs on different
        // silicon, and clients deserve to see which. Always basis-labeled, never measured.
        hardware: offering.hardware ?? card.hardware ?? null,
        benchmarks: offering.benchmarks ?? null,
        observed: {
          probe_success: round2(probeSuccess),
          probes: checks.length,
          ttft_ms: obs.ttft_ms ?? null,
          tps: obs.tps ?? null,
          availability,
        },
        endpoints: card.endpoints,
        // false for listing-only imports (no known API endpoint): shown, never called
        invocable: Boolean(card.endpoints?.openai),
      });
      // Trusted or open pool (ONP-3 §5e), under this registry's trusted view.
      out.at(-1).pool = poolOf(out.at(-1), view);
    }
  }
  return out;
}

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const oneOf = (name, value, allowed) => {
  if (value != null && !allowed.includes(value)) throw bad(`${name} must be ${allowed.join(' or ')}, not ${JSON.stringify(value)}`);
  return value;
};

/** Whether an offering publishes a per-token price (imports with no known price leave it out). */
export const pricePublished = (pricing) => pricing?.input_per_mtok != null || pricing?.output_per_mtok != null;

/** Search returning the page plus the total number of matches (before `limit`). */
export async function searchOfferingsPaged(store, query) {
  let items = await collectOfferings(store);

  const q = (k) => query.get(k);
  if (q('invocable') === 'true') items = items.filter((o) => o.invocable);
  if (q('invocable') === 'false') items = items.filter((o) => !o.invocable);
  if (q('modality')) items = items.filter((o) => o.modality === q('modality'));
  if (q('family')) items = items.filter((o) => o.model.family === q('family') || o.model.artifact === q('family'));
  if (q('min_context')) items = items.filter((o) => (o.serving?.context_window ?? 0) >= Number(q('min_context')));
  if (q('supports')) {
    const wanted = q('supports').split(',');
    items = items.filter((o) => wanted.every((s) => o.serving?.supports?.includes(s)));
  }
  if (q('max_input_price')) items = items.filter((o) => (o.pricing.input_per_mtok ?? Infinity) <= Number(q('max_input_price')));
  if (q('scheme')) items = items.filter((o) => o.pricing.schemes.includes(q('scheme')));
  if (q('jurisdiction')) items = items.filter((o) => inJurisdiction(o, q('jurisdiction')));
  if (q('region')) {
    // Residency: every pinned region and live serving site (else the node's regions) inside.
    items = items.filter((o) => residencyWithin(o.residency, q('region')));
  }
  if (q('location_basis')) {
    // Evidence: the offering has serving sites and every one is at least this well supported.
    const min = basisRank(q('location_basis'));
    items = items.filter((o) => o.locations.length && o.locations.every((l) => basisRank(l.basis) >= min));
  }
  // Origin policy on declared lineage: offerings that declare none are kept (unknown), unless
  // lineage=declared asks for a declared lineage.
  const declared = oneOf('lineage', q('lineage'), ['declared', 'any']) === 'declared';
  if (q('exclude_lineage') || declared) {
    const exclude = (q('exclude_lineage') ?? '').split(',').filter(Boolean);
    items = items.filter((o) => lineageAllowed(o, { exclude, declared }));
  }
  // Data policy (ONP-2 §5): at most this retention, no training on inputs. No data_policy fails.
  const retention = oneOf('retention', q('retention'), RETENTION_LEVELS);
  const noTraining = oneOf('no_training', q('no_training'), ['true', 'false']) === 'true';
  if (retention || noTraining) items = items.filter((o) => meetsDataPolicy(o, { retention, no_training: noTraining }));
  // The trusted pool (ONP-3 §5e): every condition of the registry's trusted view at once.
  if (oneOf('trust', q('trust'), ['trusted', 'open']) === 'trusted') {
    const view = trustedViewOf(store);
    items = items.filter((o) => inTrustedPool(o, view));
  }
  if (q('tier')) {
    const order = ['unverified', 'community', 'verified', 'attested'];
    const min = order.indexOf(q('tier'));
    items = items.filter((o) => order.indexOf(o.tier) >= min);
  }
  if (q('lang')) {
    const [lang, minGrade = 'basic'] = q('lang').split(':');
    const grades = ['basic', 'strong', 'native'];
    items = items.filter((o) => (o.serving?.languages ?? []).some(
      (l) => langMatches(l.lang, lang) && grades.indexOf(l.grade) >= grades.indexOf(minGrade)));
  }
  if (q('q')) {
    const needle = q('q').toLowerCase();
    items = items.filter((o) => JSON.stringify(o.model).toLowerCase().includes(needle)
      || o.offering_id.includes(needle) || o.node_id.includes(needle));
  }
  // Local models (the Ollama library) have no server: they run on the visitor's own machine and are
  // listed apart from hosted offerings. `memory_gb` keeps the local models with a size that fits.
  if (q('memory_gb')) {
    const gb = Number(q('memory_gb'));
    items = items.filter((o) => !o.local || !localSizes(o).length || localSizes(o)[0].memory_gb <= gb);
  }
  const counts = { hosted: items.filter((o) => !o.local).length, local: items.filter((o) => o.local).length };
  if (q('local') === 'true') items = items.filter((o) => o.local);
  if (q('local') === 'false') items = items.filter((o) => !o.local);
  // `ids`: offering or model ids, comma-separated (the registry UI sends the models installed in the
  // visitor's own Ollama, which the browser read from it directly)
  if (q('ids') != null) {
    const ids = new Set(q('ids').split(',').map((s) => s.trim()).filter(Boolean));
    items = items.filter((o) => ids.has(o.offering_id) || ids.has(o.binding?.model_id));
  }

  // Rank depends on the filtered set: annotate copies, never the shared cached offerings.
  items = items.map((o) => ({ ...o }));
  // Price scores by position among the results (cheapest 1, dearest 0), not against the single
  // most expensive offering: one outlier made almost everything "cheap" and every import tie.
  const prices = items.map((o) => o.pricing.input_per_mtok).filter((p) => p != null).sort((a, b) => a - b);
  const cheaperThan = (p) => { let lo = 0, hi = prices.length; while (lo < hi) { const m = (lo + hi) >> 1; if (prices[m] < p) lo = m + 1; else hi = m; } return lo; };
  // Local models rank by popularity among the listed local models (log of Ollama pulls): price, trust
  // tier and checks describe a server, and a local model has none.
  const maxPulls = Math.max(1, ...items.filter((o) => o.local).map(pullsOf));
  for (const o of items) {
    if (o.local) {
      const sizes = localSizes(o);
      o.local = { ...o.local, sizes_memory: sizes.map(({ tag, memory_gb }) => ({ tag, memory_gb })) };
      o.specialty = isEmbedder(o) ? 'embedding' : specialtyOf(o);
      const popularity = pullsOf(o) > 1 ? Math.log10(pullsOf(o)) / Math.log10(Math.max(10, maxPulls)) : 0;
      o.rank = round2(popularity);
      o.rank_explanation = { basis: 'local', weights: { popularity: 1 }, components: { popularity: round2(popularity) }, pulls: o.local.pulls ?? null };
      continue;
    }
    const p = o.pricing.input_per_mtok;
    const components = {
      price: p == null ? 0 : prices.length > 1 ? 1 - cheaperThan(p) / (prices.length - 1) : 1,
      tier: TIER_SCORE[o.tier] ?? 0,
      probe_success: o.observed.probe_success,
    };
    o.rank = round2(Object.entries(RANK_COMPONENTS).reduce((sum, [k, w]) => sum + w * components[k], 0));
    o.rank_explanation = { weights: RANK_COMPONENTS, components };
  }

  // Performance sorts prefer registry-measured values; claimed expected_* is the
  // fallback, and offerings with neither sink to the bottom (ONP-3 §4).
  const ttftOf = (o) => o.observed.ttft_ms?.p50 ?? o.serving?.expected_ttft_ms?.p50 ?? Infinity;
  const tpsOf = (o) => (o.observed.tps > 0 ? o.observed.tps : null) ?? o.serving?.expected_tps?.p50 ?? -Infinity;
  const sort = q('sort') ?? 'rank';
  const minMemory = (o) => o.local?.sizes_memory?.[0]?.memory_gb ?? Infinity;
  items.sort((a, b) => {
    // hosted before local in a mixed list: their scores measure different things
    if (Boolean(a.local) !== Boolean(b.local)) return Number(Boolean(a.local)) - Number(Boolean(b.local));
    if (a.local) {
      if (sort === 'size') return minMemory(a) - minMemory(b) || b.rank - a.rank || a.offering_id.localeCompare(b.offering_id);
      if (sort === 'name') return a.offering_id.localeCompare(b.offering_id);
      return b.rank - a.rank || pullsOf(b) - pullsOf(a) || a.offering_id.localeCompare(b.offering_id);
    }
    if (sort === 'price') return (a.pricing.input_per_mtok ?? Infinity) - (b.pricing.input_per_mtok ?? Infinity);
    if (sort === 'ttft') return ttftOf(a) - ttftOf(b);
    if (sort === 'tps') return tpsOf(b) - tpsOf(a);
    // Equal rank: callable before listing-only, larger context first, then by name — a stable,
    // meaningful order instead of whatever order the catalogs were imported in.
    return b.rank - a.rank || Number(b.invocable) - Number(a.invocable)
      || (b.serving?.context_window ?? 0) - (a.serving?.context_window ?? 0)
      || String(a.model?.name ?? '').localeCompare(String(b.model?.name ?? ''))
      || `${a.node_id}/${a.offering_id}`.localeCompare(`${b.node_id}/${b.offering_id}`);
  });

  const limit = Math.min(Number(q('limit') ?? 50), 200);
  const offset = Math.max(0, Math.floor(Number(q('offset') ?? 0)) || 0);
  return { offerings: items.slice(offset, offset + limit), total: items.length, offset, counts };
}

export async function searchOfferings(store, query) {
  return (await searchOfferingsPaged(store, query)).offerings;
}

const round2 = (n) => Math.round(n * 100) / 100;
