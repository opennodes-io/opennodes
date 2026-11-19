// Stage A admission probes (DS-ADM-01): card consistency, health, blind invocation, /models agreement.
// All outbound traffic goes through the SSRF-guarded fetcher (safefetch.js).
import { fetchJsonCapped } from './safefetch.js';
import { loadCorpus } from './corpus.js';
import { artifactClaimProblems, vendorTable } from './vendors.js';

/**
 * Stage A checks whose failure is a property of the card, not of the moment: a listed node that
 * fails one of these on a scheduled re-run loses its tier at once. `models-agreement` counts only
 * when /models answered 200 without the card's models (a timeout is an outage, not a card fault).
 * Health and blind-invocation failures are left to Stage C (liveness suspension, blind-failure
 * demotion), so an outage of a few minutes does not cost a node its tier. Each Stage A result
 * carries `structural: true` when it is such a failure.
 */
export const STRUCTURAL_KINDS = ['card-consistency', 'artifact-namespace', 'models-agreement', 'tested-offerings'];
const DEV_CORPUS = loadCorpus(null);

/**
 * Binding profiles the admission tests can call (ONP-3 §4a). Verification covers only these: an
 * offering with another profile is never invoked, so a node's tier says nothing about it.
 */
export const TESTED_PROFILES = ['onp.openai.chat/v1'];
/** Whether the registry's tests can call this offering. */
export const testable = (offering) => TESTED_PROFILES.includes(offering?.binding?.profile);
/** Offering ids of a card that the tests cannot call. */
export const untestedOfferings = (card) => (card?.offerings ?? []).filter((o) => !testable(o)).map((o) => o.offering_id);
export const NO_TESTED_OFFERINGS = `no offerings with a tested profile (${TESTED_PROFILES.join(', ')})`;
/** The `verification` block of node detail and the export feed; nodeObs = the node's `_node` observations. */
export const verificationOf = (card, nodeObs = {}) => ({
  tested_profiles: TESTED_PROFILES,
  untested_offerings: untestedOfferings(card),
  blind_skipped: nodeObs.blind_skipped ?? null,
});

/**
 * Card rules a schema cannot express (ONP-2 §5): every offering declares a data_policy
 * (required from `community` up), and offers only payment schemes the node declares.
 * Returns a list of problems; empty means consistent.
 */
export function cardConsistency(card) {
  const nodeSchemes = new Set((card.payment?.schemes ?? []).map((s) => s.scheme));
  const problems = [];
  for (const o of card.offerings ?? []) {
    if (!o.data_policy) problems.push(`${o.offering_id}: no data_policy`);
    const undeclared = (o.pricing?.schemes ?? []).filter((s) => !nodeSchemes.has(s));
    if (undeclared.length) problems.push(`${o.offering_id}: schemes not in payment.schemes: ${undeclared.join(', ')}`);
  }
  return problems;
}

/**
 * Run Stage A against a card. Records results via store; returns { ok, results }.
 * `corpus`: the probe corpus (corpus.js); `vendors`: the vendor-namespace table (vendors.js).
 */
export async function runStageA(store, nodeId, card, { safeFetch, corpus = DEV_CORPUS, vendors = vendorTable() } = {}) {
  if (!safeFetch) safeFetch = (url, opts = {}, t = 10_000) => fetch(url, { ...opts, signal: AbortSignal.timeout(t) });
  const fetchJson = (url, opts, timeoutMs = 10_000) => fetchJsonCapped(safeFetch, url, opts, timeoutMs);
  const results = [];
  const record = async (offeringId, kind, ok, detail, measured, structural = STRUCTURAL_KINDS.includes(kind)) => {
    await store.recordProbe(nodeId, offeringId, 'A', kind, ok, detail, measured);
    results.push({ offeringId, kind, ok, detail, ...(ok ? {} : { structural }) });
  };

  // 0. Card consistency (no network)
  const problems = cardConsistency(card);
  await record(null, 'card-consistency', problems.length === 0, problems.length ? problems.join('; ') : null);
  // 0b. Vendor-namespace rule (ONP-3 §6.3): a proprietary artefact only from the vendor's namespace.
  const claims = artifactClaimProblems(card, vendors);
  await record(null, 'artifact-namespace', claims.length === 0, claims.length ? claims.join('; ') : null);

  // 1. Health endpoint
  try {
    const t0 = performance.now();
    const { status, body } = await fetchJson(card.endpoints.health);
    // ONP health ({status:'ok'}), or an OpenAI /models listing for card-only operators.
    const ok = status === 200 && (body?.status === 'ok' || Array.isArray(body?.data));
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
      status !== 200 ? `status ${status}` : missing.length ? `card offerings absent from /models: ${missing.join(', ')}` : null,
      null, status === 200);   // a card fault only if /models answered
  } catch (err) {
    await record(null, 'models-agreement', false, String(err.message ?? err), null, false);
  }

  // 3. Blind invocation per offering the tests can call. A node with none gives no functional
  // evidence, so it fails Stage A and stays unverified (ONP-3 §4a item 2).
  if (!card.offerings.some(testable)) {
    const profiles = [...new Set(card.offerings.map((o) => o.binding?.profile))].join(', ');
    await record(null, 'tested-offerings', false, `${NO_TESTED_OFFERINGS}; the card offers ${profiles || 'nothing'}`);
  }
  for (const offering of card.offerings) {
    if (!testable(offering)) continue;
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
          messages: [{ role: 'user', content: corpus.chatPrompt() }],
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
