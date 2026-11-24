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
/** Why a card-only listing that passes Stage B stays at community (ONP-3 §4, §4a). */
export const CUSTOMER_ACCESS_NEEDED = 'card-only listing: its probes carry the operator\'s own probe key, so verified needs probes sent with access the registry bought as a customer (ONP-3 §4)';
/**
 * Output cap of an identity request: reference capture, Stage B and the blind identity check. Every
 * Stage C blind invocation is sent with it too (and at temperature 0), so the ones carrying an
 * identity prompt look like the rest.
 */
export const IDENTITY_MAX_TOKENS = 64;

/**
 * One chat completion at temperature 0, the request every identity comparison is made with
 * (Stage C blind invocations use it as well). Body keys in this order, every time.
 */
export async function chatOnce(safeFetch, card, offering, content, maxTokens = IDENTITY_MAX_TOKENS, timeoutMs = 60_000) {
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

/** Whether a reply's text is the reference's: the exact-output comparison of ONP-3 §4a.4. */
export const matchesReference = (text, ref) => typeof text === 'string' && sha256(text) === ref.expected_hash;

/** 409s to identity prompts excused (the run stops unjudged and is retried) since the node's last judged Stage B. */
export const MAX_EXCUSED_409 = 3;
/** The probe record of an excused one. */
export const STAGE_B_409 = 'identity-409';

/**
 * What a 409 to an identity prompt means (ONP-3 §4a.4), by Stage C's rule: the card is re-fetched,
 * and only a really new revision excuses it. `revisionMoved()` re-fetches and returns the new
 * revision, or null when the pinned one is still current.
 * - `stale`: a new revision, within the bound: recorded, the run stops unjudged, the caller retries;
 * - `refused`: the current revision was pinned: a reply that does not match;
 * - `moved`: a new revision again, beyond the bound: the run ends as not passed, never as a dispute
 *   (the card the run holds is stale now, so even an honest node refuses what follows).
 */
function makeOn409(store, nodeId, card, { revisionMoved, maxExcused409 }) {
  // `status`: the reply that sent the registry to the card. Since rev. 14 scheduled runs go out on
  // the card already held, so a 404 for a model the node has just dropped gets the same rule as a
  // 409: re-fetched after the reply, excused only if the revision really moved, within the bound.
  return async (offering, status = 409) => {
    const fresh = revisionMoved ? await revisionMoved() : null;
    if (!fresh) return { kind: 'refused' };
    const since = (await store.getSchedule(nodeId, 'B'))?.last_at ?? '';
    const excused = await store.countProbes(nodeId, STAGE_B_409, since);
    if (excused >= maxExcused409) {
      return { kind: 'moved', reason: `the card revision moved again during Stage B, after ${excused} such 409s since the last judged run (at most ${maxExcused409} are excused)` };
    }
    await store.recordProbe(nodeId, offering.offering_id, 'B', STAGE_B_409, false,
      `${status} with revision ${card.revision} pinned; card re-indexed at ${fresh}; Stage B runs again later`);
    return { kind: 'stale' };
  };
}

/**
 * DS-ADM-02: identity check against stored references. A reply that does not match is asked once
 * more before it counts (ONP-3 §6.3 disputes only a confirmed failure: batching on an engine with
 * parallel slots can change a temperature-0 reply now and then). A 409 counts as a reply that does
 * not match unless `on409` excuses it (makeOn409).
 */
async function probeIdentity(safeFetch, card, offering, refs, on409) {
  let matches = 0, retried = 0, refused = 0, stop = null;
  const ask = async (prompt) => {
    const { status, text } = await chatOnce(safeFetch, card, offering, prompt);
    if (status !== 200) {
      // A 409, or another failure (a 404 for a model dropped since the card was fetched): only a
      // revision that really moved excuses it; with the current revision pinned it does not match.
      const what = await on409(offering, status);
      if (what.kind === 'refused') { if (status === 409) refused++; } else stop = what;
      return null;
    }
    return status === 200 && text !== null ? sha256(text) : null;
  };
  for (const ref of refs) {
    let hash = await ask(ref.prompt);
    if (hash !== ref.expected_hash && !stop) { retried++; hash = await ask(ref.prompt); }
    if (hash === ref.expected_hash) matches++;
    if (stop) break;
  }
  const extra = { ...(retried ? { retried } : {}), ...(refused ? { refused } : {}) };
  if (stop?.kind === 'stale') return { ok: false, matches, total: refs.length, ...extra, stale: true };
  if (stop?.kind === 'moved') return { ok: false, matches, total: refs.length, ...extra, moved: true, reason: stop.reason };
  // Deterministic battery: require all prompts to match the reference distribution.
  return { ok: matches === refs.length, matches, total: refs.length, ...extra };
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
async function identityOf(store, nodeId, safeFetch, card, offering, { corpus, vendors, identitySample, on409 }) {
  const artifact = offering.model?.artifact;
  const claim = vendorClaim(artifact, nodeId, vendors);
  if (!claim.ok) return { ok: false, unverified: true, reason: `${artifact} is not this node's to claim (vendor namespace)` };
  // References captured with public prompts prove nothing: a node could have recognised them.
  const refs = (await store.getFingerprints(artifact)).filter((r) => corpus.usableReference(r.prompt));
  if (!refs.length) return { ok: false, unverified: true, reason: NO_REFERENCE };
  return probeIdentity(safeFetch, card, offering, sample(refs, identitySample), on409);
}

/**
 * Run Stage B for every offering the tests can call (TESTED_PROFILES). Records probes + observations;
 * returns per-offering verdicts, and in `untested` the offerings it could not call.
 * Not ok, with `reason`, when the card is unsigned (`signed: false`), when no offering can be
 * tested, when any tested offering's identity could not be checked (no reference: unverified, not a
 * dispute), or when the capacity ramp fails. `identityFailed` (a reference mismatch) means disputed.
 * `stale`: an excused 409 stopped the run unjudged. `revisionMoved` (see makeOn409): without it,
 * every 409 to an identity prompt counts as a reply that does not match.
 */
export async function runStageB(store, nodeId, card, {
  safeFetch, capacity = {}, corpus = DEV_CORPUS, vendors = vendorTable(), signed = true, identitySample = IDENTITY_SAMPLE,
  revisionMoved = null, maxExcused409 = MAX_EXCUSED_409,
} = {}) {
  const on409 = makeOn409(store, nodeId, card, { revisionMoved, maxExcused409 });
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

    verdict.identity = await identityOf(store, nodeId, safeFetch, card, offering, { corpus, vendors, identitySample, on409 });
    if (verdict.identity.stale) {
      // The card's revision really moved (an excused 409, recorded). Abort without judging: the caller retries.
      return { ok: false, identityFailed: false, stale: true, verdicts: [...verdicts, verdict], untested };
    }
    const { matches, total, refused } = verdict.identity;
    await store.recordProbe(nodeId, offering.offering_id, 'B', 'identity', verdict.identity.ok,
      verdict.identity.unverified ? `identity unverified: ${verdict.identity.reason}`
        : verdict.identity.moved ? `not judged: ${verdict.identity.reason}`
          : `${matches}/${total} reference matches${refused ? `; ${refused} replies refused with 409, the current card revision pinned` : ''}`);
    if (verdict.identity.moved) {
      // Beyond the bound: not passed, and nothing more is sent on a card that is no longer current.
      return { ok: false, identityFailed: false, reason: `${offering.offering_id}: ${verdict.identity.reason}`, verdicts: [...verdicts, verdict], untested };
    }

    verdict.context = await probeContext(safeFetch, card, offering, corpus);
    await store.recordProbe(nodeId, offering.offering_id, 'B', 'context', verdict.context.ok,
      `claimed ${verdict.context.claimed}, verified ${verdict.context.verified_cap}`,
      verdict.context);
    // Every run replaces the last result: a pass stores the full claimed window, which lifts an
    // earlier cap; 0 = nothing verified, shown as unverified rather than trusting the claim.
    await store.setObservation(nodeId, offering.offering_id, 'context_cap', verdict.context.verified_cap);

    verdict.capacity = await probeCapacity(safeFetch, card, offering, corpus, capacity);
    if (!verdict.capacity.ok) {
      // A failed ramp on a card that has since moved (the model dropped or changed during the run)
      // is not judged, by the same rule and bound as a 409.
      const what = await on409(offering, 'capacity failure');
      if (what.kind === 'stale') return { ok: false, identityFailed: false, stale: true, verdicts: [...verdicts, verdict], untested };
      if (what.kind === 'moved') return { ok: false, identityFailed: false, reason: `${offering.offering_id}: ${what.reason}`, verdicts: [...verdicts, verdict], untested };
    }
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
