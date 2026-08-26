// Stage A admission probes (DS-ADM-01): health, blind invocation, /models agreement.
// All outbound traffic goes through the SSRF-guarded fetcher (safefetch.js).
import { fetchJsonCapped } from './safefetch.js';

/** Run Stage A against a card. Records results via store; returns { ok, results }. */
export async function runStageA(store, nodeId, card, { safeFetch } = {}) {
  if (!safeFetch) safeFetch = (url, opts = {}, t = 10_000) => fetch(url, { ...opts, signal: AbortSignal.timeout(t) });
  const fetchJson = (url, opts, timeoutMs = 10_000) => fetchJsonCapped(safeFetch, url, opts, timeoutMs);
  const results = [];
  const record = async (offeringId, kind, ok, detail, measured) => {
    await store.recordProbe(nodeId, offeringId, 'A', kind, ok, detail, measured);
    results.push({ offeringId, kind, ok, detail });
  };

  // 1. Health endpoint
  try {
    const t0 = performance.now();
    const { status, body } = await fetchJson(card.endpoints.health);
    const ok = status === 200 && body?.status === 'ok';
    await record(null, 'health', ok, ok ? null : `status ${status}`, { latency_ms: Math.round(performance.now() - t0) });
  } catch (err) {
    await record(null, 'health', false, String(err.message ?? err));
  }

  // 2. /models agreement
  let modelIds = new Set();
  try {
    const { status, body } = await fetchJson(`${card.endpoints.openai}/models`);
    modelIds = new Set((body?.data ?? []).map((m) => m.id));
    const cardIds = card.offerings.filter((o) => o.binding.profile.startsWith('onp.openai.')).map((o) => o.binding.model_id);
    const missing = cardIds.filter((id) => !modelIds.has(id));
    await record(null, 'models-agreement', status === 200 && missing.length === 0,
      missing.length ? `card offerings absent from /models: ${missing.join(', ')}` : null);
  } catch (err) {
    await record(null, 'models-agreement', false, String(err.message ?? err));
  }

  // 3. Blind invocation per chat offering
  for (const offering of card.offerings) {
    if (offering.binding.profile !== 'onp.openai.chat/v1') continue;
    try {
      const t0 = performance.now();
      // Generous timeout: CPU-backed nodes legitimately take tens of seconds per completion.
      const { status, headers, body } = await fetchJson(`${card.endpoints.openai}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'onp-offering': `${card.node.id}/${offering.offering_id}`,
          'onp-card-revision': card.revision,
        },
        body: JSON.stringify({
          model: offering.binding.model_id,
          messages: [{ role: 'user', content: 'ONP Stage A conformance probe. Reply briefly.' }],
          max_tokens: 32,
        }),
      }, 90_000);
      const usage = body?.usage;
      const ok = status === 200
        && typeof body?.choices?.[0]?.message?.content === 'string'
        && Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens);
      const hasReceipt = Boolean(headers.get('onp-receipt'));
      await record(offering.offering_id, 'blind-invocation', ok,
        ok ? (hasReceipt ? null : 'no ONP-Receipt header') : `status ${status} or missing usage`,
        { latency_ms: Math.round(performance.now() - t0), usage: usage ?? null, receipt: hasReceipt });
    } catch (err) {
      await record(offering.offering_id, 'blind-invocation', false, String(err.message ?? err));
    }
  }

  return { ok: results.every((r) => r.ok), results };
}
