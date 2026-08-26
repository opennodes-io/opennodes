// Offering search + transparent ranking (ONP-3 §5–6).

export const RANK_COMPONENTS = { price: 0.35, tier: 0.35, probe_success: 0.30 };
const TIER_SCORE = { unverified: 0, community: 0.4, verified: 0.8, attested: 1.0 };

/** Flatten indexed nodes into searchable offering summaries. */
export async function collectOfferings(store) {
  const out = [];
  for (const node of await store.allNodes()) {
    if (['delisted', 'suspended', 'submitted', 'challenged', 'disputed'].includes(node.state)) continue;
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
      if (obs.context_cap && obs.context_cap < (serving.context_window ?? Infinity)) {
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
        observed: {
          probe_success: round2(probeSuccess),
          probes: stageA.length,
          ttft_ms: obs.ttft_ms ?? null,
          tps: obs.tps ?? null,
          availability,
        },
        endpoints: card.endpoints,
      });
    }
  }
  return out;
}

export async function searchOfferings(store, query) {
  let items = await collectOfferings(store);

  const q = (k) => query.get(k);
  if (q('modality')) items = items.filter((o) => o.modality === q('modality'));
  if (q('family')) items = items.filter((o) => o.model.family === q('family') || o.model.artifact === q('family'));
  if (q('min_context')) items = items.filter((o) => (o.serving?.context_window ?? 0) >= Number(q('min_context')));
  if (q('supports')) {
    const wanted = q('supports').split(',');
    items = items.filter((o) => wanted.every((s) => o.serving?.supports?.includes(s)));
  }
  if (q('max_input_price')) items = items.filter((o) => (o.pricing.input_per_mtok ?? Infinity) <= Number(q('max_input_price')));
  if (q('scheme')) items = items.filter((o) => o.pricing.schemes.includes(q('scheme')));
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

  const sort = q('sort') ?? 'rank';
  items.sort((a, b) => sort === 'price'
    ? (a.pricing.input_per_mtok ?? Infinity) - (b.pricing.input_per_mtok ?? Infinity)
    : b.rank - a.rank);

  const limit = Math.min(Number(q('limit') ?? 50), 200);
  return items.slice(0, limit);
}

const round2 = (n) => Math.round(n * 100) / 100;
