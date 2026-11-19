// Stage C (DS-ADM-06): continuous observation of community+ nodes.
// - liveness sweep on a fixed cadence -> rolling availability observation,
//   auto-suspension after consecutive failures
// - random blind invocations at unpredictable times (anti-"benchmark mode":
//   a node cannot serve the real model only when it detects a test window), worded from the
//   registry's probe corpus like any customer request; repeated failures cost the node its tier
import { fetchJsonCapped } from './safefetch.js';
import { testable, NO_TESTED_OFFERINGS } from './probes.js';
import { loadCorpus } from './corpus.js';

const OBSERVED_STATES = ['community', 'verified', 'attested'];
/** Mean gap between liveness sweeps (spec: <=5 min); each gap is drawn from 0.5x-1.5x (jitter). */
export const LIVENESS_INTERVAL_MS = 300_000;
/** Mean gap between blind-invocation sweeps: one chat call per node per sweep, same jitter. */
export const BLIND_INTERVAL_MS = 3_600_000;
/** Each gap is the mean times a uniform random factor in this range. */
export const JITTER = [0.5, 1.5];
/** Consecutive failed blind invocations (since the node's last state change) that demote it one tier. */
export const BLIND_FAIL_THRESHOLD = 3;
/**
 * 409 answers to blind probes excused per node per 24 h. A 409 is excused only when the card's
 * revision really moved (the registry re-fetches the card and retries once with the new pin, as
 * since 4 Oct 2026); beyond this many, or with the current revision pinned, it counts as a failure.
 */
export const MAX_EXCUSED_409_PER_DAY = 3;
/** Where tiers go when blind probes keep failing: one step down. */
const DEMOTE = { attested: 'verified', verified: 'community', community: 'indexed' };

export function startStageC(store, {
  safeFetch,
  fetchFor = null,                // (nodeId, card) -> fetch that carries the node's probe key
  refreshCard = null,             // re-index a node's card when its revision moved (restart / reprice)
  corpus = loadCorpus(null),      // probe prompts (corpus.js)
  livenessIntervalMs = LIVENESS_INTERVAL_MS,   // tests shorten this
  blindIntervalMs = BLIND_INTERVAL_MS,
  failThreshold = 3,
  recoverThreshold = 3,           // consecutive liveness successes that lift a liveness suspension
  blindFailThreshold = BLIND_FAIL_THRESHOLD,
  maxExcused409 = MAX_EXCUSED_409_PER_DAY,
} = {}) {
  let stopped = false;

  /**
   * A suspension for liveness is temporary: the node is still probed, and after
   * `recoverThreshold` consecutive successes it returns to the tier it held. Suspensions
   * for any other reason (dispute, fraud, operator request) are never lifted here.
   * Returns the tier to restore to, or null when the node is not eligible.
   */
  async function livenessSuspension(node) {
    if (node.state !== 'suspended') return null;
    const last = [...(await store.transitionsFor(node.id))].reverse().find((t) => t.to_state === 'suspended');
    if (!last || !String(last.reason ?? '').startsWith('liveness:')) return null;
    return OBSERVED_STATES.includes(last.from_state) ? last.from_state : 'community';
  }

  async function livenessSweep() {
    for (const node of await store.allNodes()) {
      const restoreTo = await livenessSuspension(node);
      if (!OBSERVED_STATES.includes(node.state) && !restoreTo) continue;
      const card = await store.latestCard(node.id);
      if (!card) continue;
      let ok = false;
      try {
        const f = fetchFor ? await fetchFor(node.id, card) : safeFetch;
        const { status, body } = await fetchJsonCapped(f, card.endpoints.health, {}, 5_000);
        ok = status === 200 && (body?.status === 'ok' || Array.isArray(body?.data));
      } catch { ok = false; }
      await store.recordProbe(node.id, null, 'C', 'liveness', ok);

      const recent = (await store.probesFor(node.id))
        .filter((p) => p.stage === 'C' && p.kind === 'liveness')
        .slice(0, 20);
      const up = recent.filter((p) => p.ok).length;
      await store.setObservation(node.id, '_node', 'availability', {
        window: recent.length, up,
        ratio: recent.length ? Math.round((up / recent.length) * 1000) / 1000 : null,
      });

      if (restoreTo) {
        let consecutiveOk = 0;
        for (const p of recent) { if (!p.ok) break; consecutiveOk++; }
        if (consecutiveOk >= recoverThreshold) {
          await store.setState(node.id, restoreTo, `reinstated: ${consecutiveOk} consecutive liveness successes`);
          await refreshCard?.(node.id);   // it may have restarted with a new card revision
        }
        continue;
      }
      let consecutiveFails = 0;
      for (const p of recent) { if (p.ok) break; consecutiveFails++; }
      if (consecutiveFails >= failThreshold) {
        await store.setState(node.id, 'suspended', `liveness: ${consecutiveFails} consecutive failures`);
      }
    }
  }

  async function blindSweep() {
    for (const node of await store.allNodes()) {
      if (!OBSERVED_STATES.includes(node.state)) continue;
      await refreshCard?.(node.id);
      const card = await store.latestCard(node.id);
      if (!card) continue;
      // Blind probes call only offerings the tests can call. A node with none is reported in the
      // `blind_skipped` observation (node detail, export feed) instead of passing unobserved.
      const callable = card.offerings.filter(testable);
      const skipped = (await store.getObservations(node.id, '_node')).blind_skipped ?? null;
      if (!callable.length) {
        const profiles = [...new Set(card.offerings.map((o) => o.binding?.profile))];
        if (skipped?.revision !== card.revision) {
          await store.setObservation(node.id, '_node', 'blind_skipped', {
            reason: NO_TESTED_OFFERINGS, profiles, revision: card.revision, since: new Date().toISOString(),
          });
        }
        continue;
      }
      if (skipped) await store.setObservation(node.id, '_node', 'blind_skipped', null);
      const offering = callable[Math.floor(Math.random() * callable.length)];
      const result = await blindProbe(node, card, offering);
      await store.recordProbe(node.id, result.offeringId, 'C', 'blind', result.ok, result.detail, result.measured);
      if (!result.ok) await demoteOnBlindFailures(node);
    }
  }

  /** One blind chat call; a fresh 409 is excused (re-index, one retry) within the daily bound. */
  async function blindProbe(node, card, offering) {
    const call = async (c, o) => {
      const f = fetchFor ? await fetchFor(node.id, c) : safeFetch;
      return fetchJsonCapped(f, `${c.endpoints.openai}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'onp-offering': `${c.node.id}/${o.offering_id}`,
          'onp-card-revision': c.revision,
        },
        body: JSON.stringify({
          model: o.binding.model_id,
          messages: [{ role: 'user', content: corpus.chatPrompt() }],
          max_tokens: 32,
        }),
      }, 30_000);
    };
    // `note` explains a 409 in the recorded detail.
    const judge = ({ status, body }, o, note = null) => {
      const usage = body?.usage;
      const ok = status === 200 && typeof body?.choices?.[0]?.message?.content === 'string'
        && Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens);
      const detail = ok ? null : status === 409 ? ['409', note].filter(Boolean).join(' ') : `status ${status} or missing content or usage`;
      return { ok, offeringId: o.offering_id, detail, measured: usage ? { usage } : null };
    };
    try {
      let reply = await call(card, offering);
      if (reply.status !== 409) return judge(reply, offering);
      // 409: the pinned revision is no longer current (restart, reprice), or the node is refusing a
      // request it took for a probe. Re-index the card; excuse it only if the revision really moved.
      await refreshCard?.(node.id);
      const fresh = await store.latestCard(node.id);
      if (!fresh || fresh.revision === card.revision) return judge(reply, offering, 'with the current card revision pinned');
      const excused = await store.countProbes(node.id, 'blind-409', new Date(Date.now() - 24 * 3600 * 1000).toISOString());
      if (excused >= maxExcused409) {
        return judge(reply, offering, `again after ${excused} card revisions in 24 h (at most ${maxExcused409} are excused)`);
      }
      await store.recordProbe(node.id, offering.offering_id, 'C', 'blind-409', false,
        `409 with revision ${card.revision} pinned; card re-indexed at ${fresh.revision} and probe retried`);
      const retryOffering = fresh.offerings.find((o) => o.offering_id === offering.offering_id && testable(o))
        ?? fresh.offerings.find(testable);
      if (!retryOffering) return { ok: false, offeringId: offering.offering_id, detail: `the new revision ${fresh.revision} has no tested offering`, measured: null };
      reply = await call(fresh, retryOffering);
      return judge(reply, retryOffering, reply.status === 409 ? 'on the retry with the re-indexed revision' : null);
    } catch (err) {
      return { ok: false, offeringId: offering.offering_id, detail: String(err.message ?? err), measured: null };
    }
  }

  /**
   * A node that answers its health checks but keeps failing blind invocations is not serving what
   * its tier says: after `blindFailThreshold` consecutive failures since its last state change it
   * drops one tier. Getting it back takes the scheduled Stage A (community) and Stage B (verified).
   */
  async function demoteOnBlindFailures({ id }) {
    const node = await store.getNode(id);
    const to = DEMOTE[node?.state];
    if (!to) return;
    const since = (await store.transitionsFor(node.id)).at(-1)?.at ?? '';
    let failures = 0;
    for (const p of await store.probesFor(node.id)) {
      if (p.stage !== 'C' || p.kind !== 'blind') continue;
      if (p.at < since || p.ok) break;
      failures++;
    }
    if (failures < blindFailThreshold) return;
    // Only a node that is up loses its tier this way: one that is down gets the liveness rules
    // (a temporary suspension, reinstated when it answers again), not a demotion.
    const card = await store.latestCard(node.id);
    let healthy = false;
    try {
      const f = fetchFor ? await fetchFor(node.id, card) : safeFetch;
      const { status, body } = await fetchJsonCapped(f, card.endpoints.health, {}, 5_000);
      healthy = status === 200 && (body?.status === 'ok' || Array.isArray(body?.data));
    } catch { healthy = false; }
    if (healthy) await store.setState(node.id, to, `blind: ${failures} consecutive failed blind invocations`);
  }

  const jitter = (base) => base * (JITTER[0] + Math.random() * (JITTER[1] - JITTER[0]));
  const loop = (fn, base) => {
    const tick = async () => {
      if (stopped) return;
      await fn().catch(() => {});
      if (!stopped) setTimeout(tick, jitter(base)).unref?.();
    };
    setTimeout(tick, jitter(base)).unref?.();
  };
  loop(livenessSweep, livenessIntervalMs);
  loop(blindSweep, blindIntervalMs);

  return { stop: () => { stopped = true; } };
}
