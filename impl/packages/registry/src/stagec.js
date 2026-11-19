// Stage C (DS-ADM-06): continuous observation of community+ nodes.
// - liveness sweep on a fixed cadence -> rolling availability observation,
//   auto-suspension after consecutive failures
// - random blind invocations at unpredictable times (anti-"benchmark mode": a node cannot serve the
//   real model only when it detects a test window), worded from the registry's probe corpus like
//   any customer request; repeated failures cost the node its tier
// - an excused 409 is followed by a fresh blind invocation within the hour (ONP-3 §4a.9), so
//   publishing a new card revision to refuse a probe does not buy a quiet stretch
// - on verified and attested nodes some blind invocations ask an identity prompt instead: a light
//   identity check between Stage B runs. A confirmed mismatch makes Stage B due within the hour;
//   only Stage B can dispute.
// What the registry owes a node lives in the private `schedule` table (rows FOLLOW_UP, LIGHT_CHECK),
// never in a probe record: no API says when the next probe comes or which probes carried what.
import { fetchJsonCapped } from './safefetch.js';
import { testable, NO_TESTED_OFFERINGS } from './probes.js';
import { loadCorpus } from './corpus.js';
import { chatOnce, matchesReference, IDENTITY_MAX_TOKENS } from './stageb.js';
import { between } from './schedule.js';

const OBSERVED_STATES = ['community', 'verified', 'attested'];
/** Tiers a Stage B pass gave: their blind invocations may carry the light identity check. */
const IDENTITY_STATES = ['verified', 'attested'];
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
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
/**
 * Every excused 409 is followed by a fresh blind invocation at a random time in this window, pinned
 * to the revision the node moved to. Its upper end leaves room for the follow-up tick (at most
 * 1.5 x FOLLOW_UP_TICK_MS late), so it arrives within the hour.
 */
export const FOLLOW_UP_MS = [0, 55 * MINUTE];
/** Mean gap between looks for follow-ups that are due (same jitter as the sweeps). */
export const FOLLOW_UP_TICK_MS = MINUTE;
/**
 * Share of blind invocations on verified and attested nodes that ask one of the offering's identity
 * references instead of an ordinary prompt (none when the artefact has no usable reference).
 */
export const IDENTITY_SHARE = 0.25;
/** At most one Stage B per node in this long is made due by blind identity checks. */
export const IDENTITY_STAGE_B_GAP_MS = DAY;
/** Every blind invocation's output cap: the identity requests' (stageb.js), so all look alike. */
export const BLIND_MAX_TOKENS = IDENTITY_MAX_TOKENS;
/** Private schedule rows (store.setSchedule): the follow-up a node is owed, and its last light identity check. */
export const FOLLOW_UP = 'C:follow-up';
export const LIGHT_CHECK = 'C:identity';
/** Where tiers go when blind probes keep failing: one step down. */
const DEMOTE = { attested: 'verified', verified: 'community', community: 'indexed' };

const iso = (ms) => new Date(ms).toISOString();

export function startStageC(store, {
  safeFetch,
  fetchFor = null,                // (nodeId, card) -> fetch that carries the node's probe key
  refreshCard = null,             // re-index a node's card when its revision moved (restart / reprice)
  // (nodeId, card) -> make Stage B due within the hour, returns when (schedule.js stageBSoon); null
  // when this registry runs no timetable: a confirmed light-check mismatch is then only recorded.
  requestStageB = null,
  corpus = loadCorpus(null),      // probe prompts (corpus.js)
  livenessIntervalMs = LIVENESS_INTERVAL_MS,   // tests shorten this
  blindIntervalMs = BLIND_INTERVAL_MS,
  followUpTickMs = FOLLOW_UP_TICK_MS,
  followUpMs = FOLLOW_UP_MS,
  failThreshold = 3,
  recoverThreshold = 3,           // consecutive liveness successes that lift a liveness suspension
  blindFailThreshold = BLIND_FAIL_THRESHOLD,
  maxExcused409 = MAX_EXCUSED_409_PER_DAY,
  identityShare = IDENTITY_SHARE,
  identityStageBGapMs = IDENTITY_STAGE_B_GAP_MS,
  random = Math.random,
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
      if (stopped) return;
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
      await probeNode(node, card, callable);
    }
  }

  /**
   * The fresh blind invocations owed after excused 409s: each due one runs now, pinned to the card
   * the registry holds (the revision the node moved to), without fetching the card first. Its 409
   * goes through the same rules as any other, so a node that refuses it again with yet another
   * revision spends another of its daily excuses and is owed another follow-up.
   */
  async function followUpTick() {
    for (const nodeId of await store.dueSchedules(FOLLOW_UP, iso(Date.now()))) {
      if (stopped) return;
      const row = await store.getSchedule(nodeId, FOLLOW_UP);
      await store.setSchedule(nodeId, FOLLOW_UP, { ...row, next_at: null, last_at: iso(Date.now()) });
      const node = await store.getNode(nodeId);
      if (!OBSERVED_STATES.includes(node?.state)) continue;   // delisted, disputed, suspended: nothing owed
      const card = await store.latestCard(nodeId);
      const callable = card?.offerings.filter(testable) ?? [];
      if (callable.length) await probeNode(node, card, callable);
    }
  }

  /** One blind invocation of a random callable offering, recorded as `blind` whatever it asked. */
  async function probeNode(node, card, callable) {
    const offering = callable[Math.floor(random() * callable.length)];
    const ref = await identityReference(node, offering);
    const result = await blindProbe(node, card, offering, ref);
    // The record says only whether the reply conformed: never that it carried an identity prompt,
    // nor how that comparison went (node detail publishes the last probe records).
    await store.recordProbe(node.id, result.offeringId, 'C', 'blind', result.ok, result.detail, result.measured);
    if (!result.ok) await demoteOnBlindFailures(node);
    if (result.identity) await afterLightCheck(node, card, result.identity);
  }

  /**
   * The light identity check rides on about `identityShare` of the blind invocations of verified and
   * attested nodes: one of the offering's stored references, asked as the probe's prompt.
   */
  async function identityReference(node, offering) {
    if (!IDENTITY_STATES.includes(node.state) || !offering.model?.artifact) return null;
    if (random() >= identityShare) return null;
    const refs = (await store.getFingerprints(offering.model.artifact)).filter((r) => corpus.usableReference(r.prompt));
    return refs.length ? refs[Math.floor(random() * refs.length)] : null;
  }

  /**
   * One blind chat call, in the identity requests' shape (temperature 0, the same output cap). A fresh
   * 409 is excused within the daily bound: the card is re-indexed, the call retried once at once
   * (conformance only: the node knows that one is a probe), and a fresh blind invocation is owed
   * within the hour. With `ref`, a conforming reply is also compared with the reference.
   */
  async function blindProbe(node, card, offering, ref = null) {
    const ask = async (c, o, prompt) => chatOnce(fetchFor ? await fetchFor(node.id, c) : safeFetch, c, o, prompt, BLIND_MAX_TOKENS, 30_000);
    // `note` explains a 409 in the recorded detail.
    const judge = ({ status, text, usage }, o, note = null) => {
      const ok = status === 200 && typeof text === 'string'
        && Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens);
      const detail = ok ? null : status === 409 ? ['409', note].filter(Boolean).join(' ') : `status ${status} or missing content or usage`;
      return { ok, offeringId: o.offering_id, detail, measured: usage ? { usage } : null };
    };
    try {
      let reply = await ask(card, offering, ref ? ref.prompt : corpus.chatPrompt());
      if (reply.status !== 409) {
        const result = judge(reply, offering);
        if (ref && result.ok) result.identity = await lightCheck(reply, () => ask(card, offering, ref.prompt), ref);
        return result;
      }
      // 409: the pinned revision is no longer current (restart, reprice), or the node is refusing a
      // request it took for a probe. Re-index the card; excuse it only if the revision really moved.
      await refreshCard?.(node.id);
      const fresh = await store.latestCard(node.id);
      if (!fresh || fresh.revision === card.revision) return judge(reply, offering, 'with the current card revision pinned');
      const excused = await store.countProbes(node.id, 'blind-409', iso(Date.now() - DAY));
      if (excused >= maxExcused409) {
        return judge(reply, offering, `again after ${excused} card revisions in 24 h (at most ${maxExcused409} are excused)`);
      }
      await store.recordProbe(node.id, offering.offering_id, 'C', 'blind-409', false,
        `409 with revision ${card.revision} pinned; card re-indexed at ${fresh.revision}, probe retried, a fresh one due within the hour`);
      await oweFollowUp(node.id, fresh.revision);
      const retryOffering = fresh.offerings.find((o) => o.offering_id === offering.offering_id && testable(o))
        ?? fresh.offerings.find(testable);
      if (!retryOffering) return { ok: false, offeringId: offering.offering_id, detail: `the new revision ${fresh.revision} has no tested offering`, measured: null };
      reply = await ask(fresh, retryOffering, corpus.chatPrompt());
      return judge(reply, retryOffering, reply.status === 409 ? 'on the retry with the re-indexed revision' : null);
    } catch (err) {
      return { ok: false, offeringId: offering.offering_id, detail: String(err.message ?? err), measured: null };
    }
  }

  /**
   * The light identity check (ONP-3 §4a.9) under Stage B's one-repeat rule: a reply that is not the
   * reference's is asked once more, and only a second miss (or no answer to the repeat) counts.
   */
  async function lightCheck(reply, repeat, ref) {
    if (matchesReference(reply.text, ref)) return { match: true, repeated: false };
    let again = null;
    try { again = await repeat(); } catch { /* no answer to the repeat: the miss stands */ }
    return { match: again?.status === 200 && matchesReference(again.text, ref), repeated: true };
  }

  /**
   * Record a light check in the node's private LIGHT_CHECK row; a confirmed mismatch makes Stage B
   * due within the hour, at most once per `identityStageBGapMs`. The tier does not change here.
   */
  async function afterLightCheck(node, card, { match }) {
    const prev = await store.getSchedule(node.id, LIGHT_CHECK);
    const now = Date.now();
    let asked = prev?.next_at ?? null;   // when the last Stage B this check asked for was due
    if (!match && requestStageB && (!asked || now - Date.parse(asked) >= identityStageBGapMs)) {
      asked = await requestStageB(node.id, card) ?? asked;
    }
    await store.setSchedule(node.id, LIGHT_CHECK, {
      last_at: iso(now), next_at: asked, ok: match, revision: card.revision,
      failures: match ? 0 : (prev?.failures ?? 0) + 1,
    });
  }

  /** After an excused 409: a fresh blind invocation within the hour (a sooner one already owed stays). */
  async function oweFollowUp(nodeId, revision) {
    const prev = await store.getSchedule(nodeId, FOLLOW_UP);
    const due = Date.now() + between(followUpMs, random);
    const owed = prev?.next_at ? Date.parse(prev.next_at) : Infinity;
    await store.setSchedule(nodeId, FOLLOW_UP, {
      last_at: prev?.last_at ?? null, next_at: iso(Math.min(owed, due)), ok: null, revision,
      failures: (prev?.failures ?? 0) + 1,   // excused 409s so far
    });
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

  const jitter = (base) => base * (JITTER[0] + random() * (JITTER[1] - JITTER[0]));
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
  loop(followUpTick, followUpTickMs);

  return {
    stop: () => { stopped = true; },
    /** One blind sweep, or one look for due follow-ups, now (tests). */
    blindSweep,
    followUpTick,
  };
}
