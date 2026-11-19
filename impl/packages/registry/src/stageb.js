// Stage B admission probes (DS-ADM-02..04): identity fingerprinting, context
// verification with capping, capacity ramp with measured-over-claimed metrics.
// Every prompt comes from the registry's probe corpus (corpus.js), never from text in this file.
import { createHash } from 'node:crypto';
import { fetchJsonCapped } from './safefetch.js';
import { testable, untestedOfferings, NO_TESTED_OFFERINGS } from './probes.js';
import { loadCorpus, sample, IDENTITY_CAPTURE, IDENTITY_SAMPLE } from './corpus.js';
import { vendorClaim, vendorTable } from './vendors.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const DEV_CORPUS = loadCorpus(null);

/** Context probe sizes, as fractions of the claimed window (DS-ADM-03). */
export const CONTEXT_FRACTIONS = [0.25, 0.5, 0.9];
/** Capacity ramp (DS-ADM-04): parallel requests per step; one batch per step, all within one time budget. */
export const CAPACITY_RAMP = { steps: [1, 4, 8], durationMs: 3000 };
export { IDENTITY_CAPTURE, IDENTITY_SAMPLE };

/** Why Stage B refuses `verified` without a signed card (ONP-2 §8). */
export const UNSIGNED_CARD = 'card signature not verified: a card must be signed for the verified tier (ONP-2 §8)';
/** Why an offering's identity could not be checked: nothing to compare against. */
export const NO_REFERENCE = 'no identity reference for this artefact';

async function chatOnce(safeFetch, card, offering, content, maxTokens = 64, timeoutMs = 60_000) {
  const t0 = performance.now();
  const { status, body } = await fetchJsonCapped(safeFetch, `${card.endpoints.openai}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'onp-offering': `${card.node.id}/${offering.offering_id}`,
      'onp-card-revision': card.revision,
    },
    body: JSON.stringify({
      model: offering.binding.model_id,
      messages: [{ role: 'user', content }],
      temperature: 0,
      max_tokens: maxTokens,
    }),
  }, timeoutMs);
  return {
    status,
    text: body?.choices?.[0]?.message?.content ?? null,
    usage: body?.usage ?? null,
    latencyMs: performance.now() - t0,
  };
}

/**
 * Capture reference fingerprints for an artifact from a TRUSTED deployment (run by the registry
 * operator against a known-good serving of the weights). `prompts` come from the private corpus.
 */
export async function captureFingerprints(safeFetch, card, offering, prompts = DEV_CORPUS.identityPrompts(IDENTITY_CAPTURE)) {
  const refs = [];
  for (const prompt of prompts) {
    const { status, text } = await chatOnce(safeFetch, card, offering, prompt);
    if (status !== 200 || text === null) throw new Error(`reference capture failed: status ${status}`);
    refs.push({ prompt, expected_hash: sha256(text) });
  }
  return refs;
}

/**
 * DS-ADM-02: identity check against stored references. A reply that does not match is asked once
 * more before it counts (ONP-3 §6.3 disputes only a confirmed failure: batching on an engine with
 * parallel slots can change a temperature-0 reply now and then).
 */
async function probeIdentity(safeFetch, card, offering, refs) {
  let matches = 0, stale = false, retried = 0;
  const ask = async (prompt) => {
    const { status, text } = await chatOnce(safeFetch, card, offering, prompt);
    if (status === 409) stale = true;   // pinned revision is no longer current: not evidence about identity
    return status === 200 && text !== null ? sha256(text) : null;
  };
  for (const ref of refs) {
    let hash = await ask(ref.prompt);
    if (hash !== ref.expected_hash && !stale) { retried++; hash = await ask(ref.prompt); }
    if (hash === ref.expected_hash) matches++;
    if (stale) break;
  }
  // Deterministic battery: require all prompts to match the reference distribution.
  return { ok: matches === refs.length, matches, total: refs.length, ...(retried ? { retried } : {}), ...(stale ? { stale: true } : {}) };
}

/** The needle counts as retrieved if its number appears in the reply as a whole number. */
export function needleFound(text, digits) {
  if (typeof text !== 'string') return false;
  const number = String(digits).split(':').pop();
  return new RegExp(`(^|[^0-9])${number}([^0-9]|$)`).test(text);
}

/** Characters per token for this model's tokenizer, measured from a short prompt's reported usage. */
async function calibrate(safeFetch, card, offering, corpus) {
  const tail = `\n\n${corpus.chatPrompt()}`;
  const prompt = corpus.haystack(4000 - tail.length) + tail;
  try {
    const { status, usage } = await chatOnce(safeFetch, card, offering, prompt, 4);
    const reported = usage?.prompt_tokens;
    if (status === 200 && reported > 0) return { charsPerToken: prompt.length / reported, measured: true };
  } catch { /* fall through to the default */ }
  return { charsPerToken: 4, measured: false };
}

/**
 * DS-ADM-03: retrieval at 25/50/90% of the claimed window; returns the verified cap.
 * - Prompts are sized in the model's own tokens (calibrated from reported usage), not a chars/4 guess.
 * - The fact sits near the start: engines that silently drop the front of an over-long prompt lose it,
 *   and a reported prompt_tokens well short of the target is failed as a cut prompt.
 * - The haystack, the fact and its question come from the corpus, and the number is random per probe.
 * - The cap is the largest size with every smaller size passing, so one lucky answer can't vouch for a window.
 */
async function probeContext(safeFetch, card, offering, corpus) {
  const claimed = offering.serving?.context_window ?? 4096;
  const { charsPerToken, measured } = await calibrate(safeFetch, card, offering, corpus);
  const results = [];
  let cap = 0, unbroken = true;
  for (const fraction of CONTEXT_FRACTIONS) {
    const tokens = Math.floor(claimed * fraction);
    const digits = String(10_000_000 + Math.floor(Math.random() * 89_999_999));
    const needle = corpus.needle();
    const fact = ` ${needle.fact.replace('{n}', digits)} `;
    const question = `\n\n${needle.question}`;
    const body = Math.floor(tokens * charsPerToken) - fact.length - question.length - 40; // 40: chat template slack
    const before = Math.floor(body * 0.1);
    const prompt = corpus.haystack(before) + fact + corpus.haystack(body - before) + question;
    let found = false, why = null, promptTokens = null;
    try {
      // Prefill on modest hardware is slow: allow ~30 ms per claimed token on top of the base timeout.
      const { status, text, usage } = await chatOnce(safeFetch, card, offering, prompt, 64, 60_000 + tokens * 30);
      promptTokens = usage?.prompt_tokens ?? null;
      if (status !== 200) why = `status ${status}`;
      else if (measured && promptTokens != null && promptTokens < tokens * 0.85) why = `prompt cut to ${promptTokens} tokens`;
      else if (!needleFound(text, digits)) why = 'number not in reply';
      else found = true;
    } catch (err) { why = /abort|timeout/i.test(String(err?.message)) ? 'timeout' : String(err?.message ?? err).slice(0, 80); }
    results.push({ fraction, tokens, found, ...(promptTokens != null ? { prompt_tokens: promptTokens } : {}), ...(why ? { why } : {}) });
    if (found && unbroken) cap = tokens; else unbroken = false;
  }
  const allPassed = results.every((r) => r.found);
  return { ok: allPassed, claimed, verified_cap: allPassed ? claimed : cap, chars_per_token: Math.round(charsPerToken * 100) / 100, results };
}

/** DS-ADM-04: stepped-concurrency ramp; measures TTFT p50/p95 and rough TPS. */
async function probeCapacity(safeFetch, card, offering, corpus, { steps = CAPACITY_RAMP.steps, durationMs = CAPACITY_RAMP.durationMs } = {}) {
  const latencies = [];
  let completed = 0, failed = 0, outputTokens = 0;
  const deadline = Date.now() + durationMs;
  for (const concurrency of steps) {
    while (Date.now() < deadline) {
      const batch = await Promise.all(Array.from({ length: concurrency }, async () => {
        try {
          const r = await chatOnce(safeFetch, card, offering, corpus.chatPrompt(), 48);
          return r.status === 200 ? r : null;
        } catch { return null; }
      }));
      for (const r of batch) {
        if (!r) { failed++; continue; }
        completed++;
        latencies.push(r.latencyMs);
        outputTokens += r.usage?.completion_tokens ?? 0;
      }
      break; // one batch per step within the time budget
    }
  }
  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies.length ? Math.round(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]) : null;
  const totalSeconds = Math.max(0.001, durationMs / 1000);
  return {
    ok: completed > 0 && failed / Math.max(1, completed + failed) < 0.1,
    completed, failed,
    ttft_ms: { p50: pct(0.5), p95: pct(0.95) },
    tps: Math.round(outputTokens / totalSeconds),
  };
}

/**
 * The identity part of Stage B for one offering. Returns a verdict:
 * - `{ok: true}` every sampled reference matched;
 * - `{ok: false}` a reference did not match: evidence of a different model (the node is disputed);
 * - `{ok: false, unverified: true, reason}` nothing could be compared, so identity is unknown and the
 *   offering cannot be verified: no usable reference for the artefact, or a proprietary artefact
 *   claimed outside the vendor's namespace.
 */
async function identityOf(store, nodeId, safeFetch, card, offering, { corpus, vendors, identitySample }) {
  const artifact = offering.model?.artifact;
  const claim = vendorClaim(artifact, nodeId, vendors);
  if (!claim.ok) return { ok: false, unverified: true, reason: `${artifact} is not this node's to claim (vendor namespace)` };
  // References captured with public prompts prove nothing: a node could have recognised them.
  const refs = (await store.getFingerprints(artifact)).filter((r) => corpus.usableReference(r.prompt));
  if (!refs.length) return { ok: false, unverified: true, reason: NO_REFERENCE };
  return probeIdentity(safeFetch, card, offering, sample(refs, identitySample));
}

/**
 * Run Stage B for every offering the tests can call (TESTED_PROFILES). Records probes + observations;
 * returns per-offering verdicts, and in `untested` the offerings it could not call.
 * Not ok, with `reason`, when the card is unsigned (`signed: false`), when no offering can be
 * tested, when any tested offering's identity could not be checked (no reference: unverified, not a
 * dispute), or when the capacity ramp fails. `identityFailed` (a reference mismatch) means disputed.
 */
export async function runStageB(store, nodeId, card, {
  safeFetch, capacity = {}, corpus = DEV_CORPUS, vendors = vendorTable(), signed = true, identitySample = IDENTITY_SAMPLE,
} = {}) {
  const untested = untestedOfferings(card);
  if (!signed) {
    await store.recordProbe(nodeId, null, 'B', 'signature', false, UNSIGNED_CARD);
    return { ok: false, identityFailed: false, reason: UNSIGNED_CARD, verdicts: [], untested };
  }
  if (!card.offerings.some(testable)) {
    return { ok: false, identityFailed: false, reason: NO_TESTED_OFFERINGS, verdicts: [], untested };
  }
  const verdicts = [];
  for (const offering of card.offerings) {
    if (!testable(offering)) continue;
    const verdict = { offering_id: offering.offering_id, identity: null, context: null, capacity: null };

    verdict.identity = await identityOf(store, nodeId, safeFetch, card, offering, { corpus, vendors, identitySample });
    if (verdict.identity.stale) {
      // The node rejected our pinned revision (409). Abort without judging: the caller re-indexes and retries.
      return { ok: false, identityFailed: false, stale: true, verdicts: [...verdicts, verdict], untested };
    }
    await store.recordProbe(nodeId, offering.offering_id, 'B', 'identity', verdict.identity.ok,
      verdict.identity.unverified ? `identity unverified: ${verdict.identity.reason}` : `${verdict.identity.matches}/${verdict.identity.total} reference matches`);

    verdict.context = await probeContext(safeFetch, card, offering, corpus);
    await store.recordProbe(nodeId, offering.offering_id, 'B', 'context', verdict.context.ok,
      `claimed ${verdict.context.claimed}, verified ${verdict.context.verified_cap}`,
      verdict.context);
    // Every run replaces the last result: a pass stores the full claimed window, which lifts an
    // earlier cap; 0 = nothing verified, shown as unverified rather than trusting the claim.
    await store.setObservation(nodeId, offering.offering_id, 'context_cap', verdict.context.verified_cap);

    verdict.capacity = await probeCapacity(safeFetch, card, offering, corpus, capacity);
    await store.recordProbe(nodeId, offering.offering_id, 'B', 'capacity', verdict.capacity.ok, null, verdict.capacity);
    if (verdict.capacity.ttft_ms.p50 != null) {
      await store.setObservation(nodeId, offering.offering_id, 'ttft_ms', verdict.capacity.ttft_ms);
      await store.setObservation(nodeId, offering.offering_id, 'tps', verdict.capacity.tps);
    }

    verdicts.push(verdict);
  }

  const identityFailed = verdicts.some((v) => !v.identity.ok && !v.identity.unverified);
  const unverified = verdicts.filter((v) => v.identity.unverified);
  const capacityFailed = verdicts.filter((v) => !v.capacity?.ok);
  const reasons = [
    ...unverified.map((v) => `${v.offering_id}: identity unverified (${v.identity.reason})`),
    ...capacityFailed.map((v) => `${v.offering_id}: capacity ramp failed`),
  ];
  const ok = !identityFailed && reasons.length === 0;
  return { ok, identityFailed, ...(ok || identityFailed ? {} : { reason: reasons.join('; ') }), verdicts, untested };
}
