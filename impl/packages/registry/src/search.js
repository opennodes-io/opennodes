// Offering search + transparent ranking (ONP-3 §5–6).
import { inJurisdiction } from '@opennodes/core';

export const RANK_COMPONENTS = { price: 0.35, tier: 0.35, probe_success: 0.30 };
const TIER_SCORE = { unverified: 0, community: 0.4, verified: 0.8, attested: 1.0 };

// The assembled catalog (10k+ offerings, ~one store read each) is kept in memory per store and
// rebuilt only after a write (see watchStoreWrites) or after MAX_AGE_MS as a safety net. Concurrent
// requests share one rebuild. Callers must not mutate the returned offerings.
const MAX_AGE_MS = 60_000;
const catalogs = new WeakMap();   // store -> { items, at, stale, building }

/** Mark the cached catalog stale: the next read rebuilds it. */
export function markCatalogStale(store) {
  const entry = catalogs.get(store);
  if (entry) entry.stale = true;
}

/** Wrap the store's write methods so any change to nodes, cards, probes or observations marks the catalog stale. */
export function watchStoreWrites(store) {
  for (const name of ['upsertNode', 'setState', 'saveRevision', 'recordProbe', 'addFingerprints', 'setObservation']) {
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
  for (const node of await store.allNodes()) {
    if (['delisted', 'suspended', 'submitted', 'challenged', 'disputed', 'claimed'].includes(node.state)) continue;
    const card = await store.latestCard(node.id);
    if (!card) continue;
    const probes = await store.probesFor(node.id);
    const stageA = probes.filter((p) => p.stage === 'A');
    const probeSuccess = stageA.length ? stageA.filter((p) => p.ok).length / stageA.length : 0;
    const tier = node.state === 'indexed' ? 'unverified' : node.state;
    const availability = (await store.getObservations(node.id, '_node')).availability ?? null;
    for (const offering of card.offerings) {
      const obs = await store.getObservations(node.id, offering.offering_id);
      // Measured values override claims (DS-ADM-03/04): cap the advertised context to
      // the verified size, and surface registry-measured latency/throughput.
      const serving = { ...offering.serving };
      if (obs.context_cap != null && obs.context_cap < (serving.context_window ?? Infinity)) {
        serving.context_window = obs.context_cap;
        serving.context_capped_from = offering.serving.context_window;
      }
      out.push({
        node_id: node.id,
        offering_id: offering.offering_id,
        tier,
        source: node.source ?? 'registration',
        institutional: Boolean(node.institutional),
        card_revision: card.revision,
        modality: offering.modality,
        modalities: offering.modalities ?? null,
        local: offering.local ?? null,
        model: offering.model,
        serving,
        binding: offering.binding,
        pricing: offering.pricing,
        data_policy: offering.data_policy ?? null,
        // Where the operator is (ONP-2 node.operator.country, node.regions).
        // Registered nodes declare it in their signed card; imports get it from the importer's list of
        // known providers, labeled inferred.
        jurisdiction: {
          country: card.node?.operator?.country ?? null,
          regions: card.node?.regions ?? [],
          basis: card.node?.operator?.country ? (node.source === 'import' ? 'inferred' : 'declared') : null,
        },
        // Allocated hardware for THIS offering (offering-level override wins over the
        // node-level description) — same artifact on different vendors runs on different
        // silicon, and clients deserve to see which. Always basis-labeled, never measured.
        hardware: offering.hardware ?? card.hardware ?? null,
        benchmarks: offering.benchmarks ?? null,
        observed: {
          probe_success: round2(probeSuccess),
          probes: stageA.length,
          ttft_ms: obs.ttft_ms ?? null,
          tps: obs.tps ?? null,
          availability,
        },
        endpoints: card.endpoints,
        // false for listing-only imports (no known API endpoint): shown, never called
        invocable: Boolean(card.endpoints?.openai),
      });
    }
  }
  return out;
}

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
  if (q('tier')) {
    const order = ['unverified', 'community', 'verified', 'attested'];
    const min = order.indexOf(q('tier'));
    items = items.filter((o) => order.indexOf(o.tier) >= min);
  }
  if (q('lang')) {
    const [lang, minGrade = 'basic'] = q('lang').split(':');
    const grades = ['basic', 'strong', 'native'];
    items = items.filter((o) => (o.serving?.languages ?? []).some(
      (l) => l.lang === lang && grades.indexOf(l.grade) >= grades.indexOf(minGrade)));
  }
  if (q('q')) {
    const needle = q('q').toLowerCase();
    items = items.filter((o) => JSON.stringify(o.model).toLowerCase().includes(needle)
      || o.offering_id.includes(needle) || o.node_id.includes(needle));
  }

  // Rank depends on the filtered set: annotate copies, never the shared cached offerings.
  items = items.map((o) => ({ ...o }));
  const maxPrice = Math.max(...items.map((o) => o.pricing.input_per_mtok ?? 0), 0.000001);
  for (const o of items) {
    const components = {
      price: 1 - (o.pricing.input_per_mtok ?? maxPrice) / maxPrice,
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
  items.sort((a, b) => {
    if (sort === 'price') return (a.pricing.input_per_mtok ?? Infinity) - (b.pricing.input_per_mtok ?? Infinity);
    if (sort === 'ttft') return ttftOf(a) - ttftOf(b);
    if (sort === 'tps') return tpsOf(b) - tpsOf(a);
    return b.rank - a.rank;
  });

  const limit = Math.min(Number(q('limit') ?? 50), 200);
  return { offerings: items.slice(0, limit), total: items.length };
}

export async function searchOfferings(store, query) {
  return (await searchOfferingsPaged(store, query)).offerings;
}

const round2 = (n) => Math.round(n * 100) / 100;
