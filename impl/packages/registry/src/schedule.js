// Re-verification on the registry's own timetable (ONP-3 §4a):
// - Stage A at least every 6 h and on every new card revision, for registered nodes from `indexed` up;
// - Stage B for a node that reaches `community`, at a random time within a day; again soon after any
//   change to a tested offering's model, serving or hardware block; and quarterly otherwise.
// The operator does not choose when Stage B runs, and no API says when it will: the next run time
// lives only in the private `schedule` table. The server supplies the stage runs (and their effect
// on the tier); this module only decides when they are due.
import { createHash } from 'node:crypto';
import { stableStringify } from '@opennodes/core';
import { testable } from './probes.js';

const HOUR = 3_600_000, DAY = 24 * HOUR;

export const SCHEDULE_DEFAULTS = Object.freeze({
  tickMs: 5 * 60_000,                    // how often the scheduler looks for due work
  stageAIntervalMs: 6 * HOUR,            // longest gap between Stage A runs; each gap is 75-100% of it
  // After a pass the next Stage B falls anywhere between these two, uniformly: at least quarterly,
  // and a node that passed cannot count on a quiet stretch in which to swap models.
  stageBMinGapMs: DAY,
  stageBIntervalMs: 91 * DAY,
  stageBRetryMs: 7 * DAY,                // after a Stage B that did not pass (and was not a dispute); 85-100% of it
  stageBFirstMs: [HOUR, DAY],            // a node that reaches community: first Stage B in this window
  stageBChangeMs: [0, HOUR],             // after a change to a tested offering's model, serving or hardware
  stageBLegacyMs: [DAY, 7 * DAY],        // nodes verified before the schedule existed: re-run in this window
  staleRetryMs: 10 * 60_000,             // the card revision moved during Stage B: try again soon (up to 3 times)
});

/** States whose nodes get Stage A on schedule, and the subset that gets Stage B. */
export const STAGE_A_STATES = ['indexed', 'community', 'verified', 'attested'];
export const STAGE_B_STATES = ['community', 'verified', 'attested'];

const iso = (ms) => new Date(ms).toISOString();
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** A uniform random point in [lo, hi]. */
export const between = ([lo, hi], random = Math.random) => lo + random() * (hi - lo);

/**
 * What Stage B measured, as one hash: the tested offerings' model, serving, hardware and binding
 * blocks, the node's hardware, and the API endpoint (another server is another deployment). A
 * change to any of them makes Stage B due (ONP-3 §4a).
 */
export function servingDigest(card) {
  const offerings = (card?.offerings ?? []).filter(testable)
    .map((o) => ({ id: o.offering_id, model: o.model ?? null, serving: o.serving ?? null, hardware: o.hardware ?? null, binding: o.binding ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return sha256(stableStringify({ offerings, hardware: card?.hardware ?? null, endpoint: card?.endpoints?.openai ?? null }));
}

/** Bookkeeping for the schedule table, used by every Stage A / B run whether or not the timer is on. */
export function makePlanner(store, options = {}) {
  const o = { ...SCHEDULE_DEFAULTS, ...options };
  const random = options.random ?? Math.random;
  return {
    options: o,
    /** After any Stage A run: next one within the interval. */
    async afterStageA(nodeId, card, ok) {
      const prev = await store.getSchedule(nodeId, 'A');
      await store.setSchedule(nodeId, 'A', {
        last_at: iso(Date.now()), next_at: iso(Date.now() + o.stageAIntervalMs * between([0.75, 1], random)),
        ok, revision: card?.revision ?? null, failures: ok ? 0 : (prev?.failures ?? 0) + 1,
      });
    },
    /**
     * A first (or renewed) Stage B at a random time: `first` for a node that reached community,
     * `legacy` for one verified before this schedule existed. A sooner run already planned stays.
     */
    async firstStageB(nodeId, card, kind = 'first') {
      const prev = await store.getSchedule(nodeId, 'B');
      const planned = Date.now() + between(kind === 'legacy' ? o.stageBLegacyMs : o.stageBFirstMs, random);
      const existing = prev?.next_at ? Date.parse(prev.next_at) : Infinity;
      const row = {
        last_at: prev?.last_at ?? null, next_at: iso(Math.min(planned, existing)), ok: prev?.ok ?? null,
        revision: prev?.revision ?? null, digest: servingDigest(card), pending_digest: null, failures: 0,
      };
      await store.setSchedule(nodeId, 'B', row);
      return row;
    },
    /** After any Stage B run. A dispute leaves nothing scheduled: the node is out until a resolution. */
    async afterStageB(nodeId, card, result) {
      const prev = await store.getSchedule(nodeId, 'B') ?? {};
      const now = Date.now();
      if (result.stale) {
        const failures = (prev.failures ?? 0) + 1;
        await store.setSchedule(nodeId, 'B', { ...prev, next_at: iso(now + (failures < 3 ? o.staleRetryMs : o.stageBRetryMs * between([0.85, 1], random))), failures });
        return;
      }
      const next = result.identityFailed ? null
        : iso(now + (result.ok ? between([o.stageBMinGapMs, o.stageBIntervalMs], random) : o.stageBRetryMs * between([0.85, 1], random)));
      await store.setSchedule(nodeId, 'B', {
        last_at: iso(now), next_at: next, ok: result.ok, revision: card?.revision ?? null,
        digest: servingDigest(card), pending_digest: null, failures: result.ok ? 0 : (prev.failures ?? 0) + 1,
      });
    },
  };
}

/**
 * Run due work every `tickMs` (jittered), one node at a time. `stageA(nodeId)` and `stageB(nodeId)`
 * are the server's runs; each records its own schedule through the planner.
 */
export function startScheduler(store, planner, { stageA, stageB, random = Math.random } = {}) {
  const o = planner.options;
  let stopped = false, timer = null;

  async function tick() {
    for (const node of await store.allNodes()) {
      if (stopped) return;
      if (node.source === 'import' || !STAGE_A_STATES.includes(node.state)) continue;
      const card = await store.latestCard(node.id);
      if (!card) continue;
      const now = Date.now();

      const a = await store.getSchedule(node.id, 'A');
      if (!a || !a.next_at || Date.parse(a.next_at) <= now || a.revision !== card.revision) {
        await stageA(node.id).catch(() => {});
      }

      const current = await store.getNode(node.id);
      if (!STAGE_B_STATES.includes(current?.state)) continue;
      const fresh = await store.latestCard(node.id);
      let b = await store.getSchedule(node.id, 'B');
      if (!b) {
        // Never scheduled: a node new at community, or one verified before the schedule existed.
        await planner.firstStageB(node.id, fresh, current.state === 'community' ? 'first' : 'legacy');
        continue;
      }
      let nextAt = b.next_at ? Date.parse(b.next_at) : Infinity;
      if (current.state === 'community') {
        // Back at community since its last Stage B (blind-probe demotion, an unsigned card,
        // reinstatement): it gets a new chance within the first-run window.
        const last = (await store.transitionsFor(node.id)).at(-1);
        if (last?.to_state === 'community' && (!b.last_at || last.at > b.last_at) && nextAt > now + o.stageBFirstMs[1]) {
          b = await planner.firstStageB(node.id, fresh, 'first');
          nextAt = Date.parse(b.next_at);
        }
      }
      const digest = servingDigest(fresh);
      if (b.digest && digest !== b.digest && digest !== b.pending_digest) {
        // A tested offering's model, serving or hardware changed since the last Stage B: run it soon.
        nextAt = Math.min(nextAt, now + between(o.stageBChangeMs, random));
        b = { ...b, pending_digest: digest, next_at: iso(nextAt) };
        await store.setSchedule(node.id, 'B', b);
      }
      if (nextAt <= now) await stageB(node.id).catch(() => {});
    }
  }

  const loop = async () => {
    if (stopped) return;
    await tick().catch(() => {});
    if (!stopped) timer = setTimeout(loop, o.tickMs * between([0.5, 1.5], random));
    timer?.unref?.();
  };
  timer = setTimeout(loop, o.tickMs * between([0.5, 1.5], random));
  timer.unref?.();
  return { stop: () => { stopped = true; clearTimeout(timer); }, tick };
}
