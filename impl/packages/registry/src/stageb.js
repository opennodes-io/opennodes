// Stage B admission probes (DS-ADM-02..04): identity fingerprinting, context
// verification with capping, capacity ramp with measured-over-claimed metrics.
import { createHash } from 'node:crypto';
import { fetchJsonCapped } from './safefetch.js';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** The fixed identity battery: deterministic prompts, temperature 0. */
export const FINGERPRINT_PROMPTS = [
  'ONP identity probe 1: repeat exactly: correlation-4417',
  'ONP identity probe 2: repeat exactly: meridian-9022',
  'ONP identity probe 3: repeat exactly: basalt-7301',
];

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
 * Capture reference fingerprints for an artifact from a TRUSTED deployment
 * (run by the registry operator against a known-good serving of the weights).
 */
export async function captureFingerprints(safeFetch, card, offering) {
  const refs = [];
  for (const prompt of FINGERPRINT_PROMPTS) {
    const { status, text } = await chatOnce(safeFetch, card, offering, prompt);
    if (status !== 200 || text === null) throw new Error(`reference capture failed: status ${status}`);
    refs.push({ prompt, expected_hash: sha256(text) });
  }
  return refs;
}

/** DS-ADM-02: identity check against stored references. */
async function probeIdentity(safeFetch, card, offering, refs) {
  let matches = 0, stale = false;
  for (const ref of refs) {
    const { status, text } = await chatOnce(safeFetch, card, offering, ref.prompt);
    if (status === 409) stale = true;   // pinned revision is no longer current: not evidence about identity
    if (status === 200 && text !== null && sha256(text) === ref.expected_hash) matches++;
  }
  // Deterministic battery: require all prompts to match the reference distribution.
  return { ok: matches === refs.length, matches, total: refs.length, ...(stale ? { stale: true } : {}) };
}

/** The needle counts as retrieved if its number appears in the reply as a whole number. */
export function needleFound(text, digits) {
  if (typeof text !== 'string') return false;
  const number = String(digits).split(':').pop();
  return new RegExp(`(^|[^0-9])${number}([^0-9]|$)`).test(text);
}

const FILLER = 'lorem ipsum context filler segment. ';
const fill = (chars) => FILLER.repeat(Math.ceil(Math.max(0, chars) / FILLER.length)).slice(0, Math.max(0, chars));
const QUESTION = '\n\nWhat is the magic number mentioned in the text above? Reply with the number only.';

/** Characters per token for this model's tokenizer, measured from a short prompt's reported usage. */
async function calibrate(safeFetch, card, offering) {
  const chars = 4000;
  try {
    const { status, usage } = await chatOnce(safeFetch, card, offering, `${fill(chars)}\n\nReply with OK.`, 4);
    const reported = usage?.prompt_tokens;
    if (status === 200 && reported > 0) return { charsPerToken: chars / reported, measured: true };
  } catch { /* fall through to the default */ }
  return { charsPerToken: 4, measured: false };
}

/**
 * DS-ADM-03: retrieval at 25/50/90% of the claimed window; returns the verified cap.
 * - Prompts are sized in the model's own tokens (calibrated from reported usage), not a chars/4 guess.
 * - The fact sits near the start: engines that silently drop the front of an over-long prompt lose it,
 *   and a reported prompt_tokens well short of the target is failed as a cut prompt.
 * - The question is plain ("the magic number"): small models refuse or mangle odd tokens like NEEDLE.
 * - The cap is the largest size with every smaller size passing, so one lucky answer can't vouch for a window.
 */
async function probeContext(safeFetch, card, offering) {
  const claimed = offering.serving?.context_window ?? 4096;
  const { charsPerToken, measured } = await calibrate(safeFetch, card, offering);
  const results = [];
  let cap = 0, unbroken = true;
  for (const fraction of [0.25, 0.5, 0.9]) {
    const tokens = Math.floor(claimed * fraction);
    const digits = String(Math.floor(tokens * 7919)); // deterministic per size
    const fact = ` The magic number is ${digits}. `;
    const body = Math.floor(tokens * charsPerToken) - fact.length - QUESTION.length - 40; // 40: chat template slack
    const before = Math.floor(body * 0.1);
    const prompt = fill(before) + fact + fill(body - before) + QUESTION;
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
async function probeCapacity(safeFetch, card, offering, { steps = [1, 4, 8], durationMs = 3000 } = {}) {
  const latencies = [];
  let completed = 0, failed = 0, outputTokens = 0;
  const deadline = Date.now() + durationMs;
  for (const concurrency of steps) {
    while (Date.now() < deadline) {
      const batch = await Promise.all(Array.from({ length: concurrency }, async () => {
        try {
          const r = await chatOnce(safeFetch, card, offering, 'ONP capacity probe: reply with a short sentence.', 48);
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
 * Run Stage B for every chat offering. Records probes + observations; returns per-offering verdicts.
 * Identity refs come from await store.getFingerprints(artifact); absence of refs is recorded, not failed
 * (proprietary artifacts are guarded by the vendor-namespace rule instead).
 */
export async function runStageB(store, nodeId, card, { safeFetch, capacity = {} } = {}) {
  const verdicts = [];
  for (const offering of card.offerings) {
    if (offering.binding.profile !== 'onp.openai.chat/v1') continue;
    const verdict = { offering_id: offering.offering_id, identity: null, context: null, capacity: null };

    const refs = await store.getFingerprints(offering.model.artifact);
    if (refs.length) {
      verdict.identity = await probeIdentity(safeFetch, card, offering, refs);
      if (verdict.identity.stale) {
        // The node rejected our pinned revision (409). Abort without judging: the caller re-indexes and retries.
        return { ok: false, identityFailed: false, stale: true, verdicts: [...verdicts, verdict] };
      }
      await store.recordProbe(nodeId, offering.offering_id, 'B', 'identity', verdict.identity.ok,
        `${verdict.identity.matches}/${verdict.identity.total} reference matches`);
    } else {
      await store.recordProbe(nodeId, offering.offering_id, 'B', 'identity', true, 'no reference fingerprints for artifact; skipped');
    }

    verdict.context = await probeContext(safeFetch, card, offering);
    await store.recordProbe(nodeId, offering.offering_id, 'B', 'context', verdict.context.ok,
      `claimed ${verdict.context.claimed}, verified ${verdict.context.verified_cap}`,
      verdict.context);
    // Every run replaces the last result: a pass stores the full claimed window, which lifts an
    // earlier cap; 0 = nothing verified, shown as unverified rather than trusting the claim.
    await store.setObservation(nodeId, offering.offering_id, 'context_cap', verdict.context.verified_cap);

    verdict.capacity = await probeCapacity(safeFetch, card, offering, capacity);
    await store.recordProbe(nodeId, offering.offering_id, 'B', 'capacity', verdict.capacity.ok, null, verdict.capacity);
    if (verdict.capacity.ttft_ms.p50 != null) {
      await store.setObservation(nodeId, offering.offering_id, 'ttft_ms', verdict.capacity.ttft_ms);
      await store.setObservation(nodeId, offering.offering_id, 'tps', verdict.capacity.tps);
    }

    verdicts.push(verdict);
  }

  const identityFailed = verdicts.some((v) => v.identity && !v.identity.ok);
  const ok = !identityFailed && verdicts.every((v) => v.capacity?.ok);
  return { ok, identityFailed, verdicts };
}
