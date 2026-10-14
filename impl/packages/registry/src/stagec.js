// Stage C (DS-ADM-06): continuous observation of community+ nodes.
// - liveness sweep on a fixed cadence -> rolling availability observation,
//   auto-suspension after consecutive failures
// - random blind invocations at unpredictable times (anti-"benchmark mode":
//   a node cannot serve the real model only when it detects a test window)
import { fetchJsonCapped } from './safefetch.js';

const OBSERVED_STATES = ['community', 'verified', 'attested'];

export function startStageC(store, {
  safeFetch,
  fetchFor = null,                // (nodeId, card) -> fetch that carries the node's probe key
  refreshCard = null,             // re-index a node's card when its revision moved (restart / reprice)
  livenessIntervalMs = 300_000,   // spec: <=5 min; tests shorten this
  blindIntervalMs = 3_600_000,
  failThreshold = 3,
  recoverThreshold = 3,           // consecutive liveness successes that lift a liveness suspension
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
      const chatOfferings = card.offerings.filter((o) => o.binding.profile === 'onp.openai.chat/v1');
      if (!chatOfferings.length) continue;
      const offering = chatOfferings[Math.floor(Math.random() * chatOfferings.length)];
      try {
        const f = fetchFor ? await fetchFor(node.id, card) : safeFetch;
        const { status, body } = await fetchJsonCapped(f, `${card.endpoints.openai}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'onp-offering': `${card.node.id}/${offering.offering_id}`,
            'onp-card-revision': card.revision,
          },
          body: JSON.stringify({
            model: offering.binding.model_id,
            messages: [{ role: 'user', content: `ONP continuous probe ${Math.floor(Math.random() * 1e9)}: reply briefly.` }],
            max_tokens: 32,
          }),
        }, 30_000);
        if (status === 409) { await refreshCard?.(node.id); continue; }   // stale pin, not a failure of the node
        const usage = body?.usage;
        const ok = status === 200 && Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens);
        await store.recordProbe(node.id, offering.offering_id, 'C', 'blind', ok,
          ok ? null : `status ${status} or missing usage`, usage ? { usage } : null);
      } catch (err) {
        await store.recordProbe(node.id, offering.offering_id, 'C', 'blind', false, String(err.message ?? err));
      }
    }
  }

  const jitter = (base) => base * (0.5 + Math.random());
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
