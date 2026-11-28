// Re-verification on the registry's own timetable (ONP-3 §4a):
// - Stage A at least every 6 h and on every new card revision, for registered nodes from `indexed` up;
// - Stage B for a node that reaches `community`, at a random time within a day; again at a random time
//   within 3 days of any change to a tested offering's model, serving, hardware or binding block (or a
//   new tested offering), within the hour after a confirmed mismatch in a blind identity check
//   (stagec.js), and on a random timer, 1 to 91 days after a pass, otherwise. That timer is its own
//   row (TIMER) and only a run it set off draws it again: a run set off by a change does not, so an
//   operator who changes the card every day cannot keep pushing the random run away.
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
  // After a change to a tested offering (or a new one): anywhere in three days, so that an operator who
  // changes the card cannot know the hour of the run that follows (ONP-3 §4a, re-verification).
  stageBChangeMs: [0, 72 * HOUR],
  // After a confirmed mismatch in a blind identity check (stagec.js). The upper end leaves room for
  // the tick (at most 1.5 x tickMs late), so the run starts within the hour.
  stageBIdentityMs: [0, 50 * 60_000],
  stageBLegacyMs: [DAY, 7 * DAY],        // nodes verified before the schedule existed: re-run in this window
  // The card revision really moved during Stage B (an excused 409, stageb.js): run again at a random
  // time within the hour (tick slack included). At most MAX_EXCUSED_409 in a row; the next run is judged.
  staleRetryMs: [0, 50 * 60_000],
});

/** States whose nodes get Stage A on schedule, and the subset that gets Stage B. */
export const STAGE_A_STATES = ['indexed', 'community', 'verified', 'attested'];
export const STAGE_B_STATES = ['community', 'verified', 'attested'];
/**
 * The private schedule row holding a node's random Stage B timer (drawn after a pass). Kept apart
 * from row 'B', whose next_at is the soonest of everything due, so that runs set off by a change or
 * a light-check mismatch never redraw it.
 */
export const TIMER = 'B:timer';
/**
 * The private row that holds automatic Stage B after a run ended "identity inconclusive" (ONP-3
 * §4a.4): `digest` lists the artefacts (JSON). With the same references a second run would give the
 * same mismatch and dispute without anyone having looked, so no change, retry or blind check sets
 * Stage B off until the artefact is captured again (reopenAfterCapture) or an admin runs Stage B.
 */
export const HOLD = 'B:hold';

/** Artefacts a node's Stage B hold waits on ([] when there is no hold). */
export async function heldArtifacts(store, nodeId) {
  const row = await store.getSchedule(nodeId, HOLD);
  try { return row?.digest ? JSON.parse(row.digest) : []; } catch { return []; }
}

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
    /**
     * A blind identity check found a reply that is not the reference's, twice (stagec.js): Stage B
     * is due at a random time within the hour, unless a sooner run is already planned. It changes
     * nothing else: only Stage B can dispute. Returns the planned time (ISO).
     */
    async stageBSoon(nodeId, card) {
      const prev = await store.getSchedule(nodeId, 'B');
      if ((await heldArtifacts(store, nodeId)).length) return prev?.next_at ?? null;   // held: see HOLD
      const at = Date.now() + between(o.stageBIdentityMs, random);
      const next = iso(Math.min(prev?.next_at ? Date.parse(prev.next_at) : Infinity, at));
      await store.setSchedule(nodeId, 'B', prev ? { ...prev, next_at: next } : {
        last_at: null, next_at: next, ok: null, revision: null, digest: servingDigest(card), pending_digest: null, failures: 0,
      });
      return next;
    },
    /** After any Stage B run. A dispute leaves nothing scheduled: the node is out until a resolution. */
    async afterStageB(nodeId, card, result) {
      const prev = await store.getSchedule(nodeId, 'B') ?? {};
      const now = Date.now();
      if (result.inconclusive) {
        // Not passed, not disputed: nothing runs until a recapture or an admin's run (HOLD).
        const artifacts = [...new Set([...await heldArtifacts(store, nodeId), ...result.inconclusive.map((i) => i.artifact)])];
        await store.setSchedule(nodeId, HOLD, { last_at: iso(now), next_at: null, digest: JSON.stringify(artifacts) });
        await store.setSchedule(nodeId, 'B', {
          last_at: iso(now), next_at: null, ok: false, revision: card?.revision ?? null,
          digest: servingDigest(card), pending_digest: null, failures: (prev.failures ?? 0) + 1,
        });
        return;
      }
      if (result.stale) {
        // Unjudged: last_at stays, so the excused 409s since the last judged run keep counting.
        await store.setSchedule(nodeId, 'B', { ...prev, next_at: iso(now + between(o.staleRetryMs, random)), failures: (prev.failures ?? 0) + 1 });
        return;
      }
      // The random timer is drawn again only when it is due or missing: a run that a change or a
      // light-check mismatch set off leaves it where it was, so it still fires (ONP-3 §4a).
      let timer = await store.getSchedule(nodeId, TIMER);
      const timerAt = timer?.next_at ? Date.parse(timer.next_at) : null;
      if (result.ok && !result.identityFailed && (timerAt === null || timerAt <= now)) {
        timer = { last_at: iso(now), next_at: iso(now + between([o.stageBMinGapMs, o.stageBIntervalMs], random)) };
        await store.setSchedule(nodeId, TIMER, timer);
      }
      const pending = timer?.next_at && Date.parse(timer.next_at) > now ? Date.parse(timer.next_at) : Infinity;
      const next = result.identityFailed ? null
        : iso(Math.min(pending, result.ok ? Infinity : now + o.stageBRetryMs * between([0.85, 1], random)));
      await store.setSchedule(nodeId, 'B', {
        last_at: iso(now), next_at: next, ok: result.ok, revision: card?.revision ?? null,
        digest: servingDigest(card), pending_digest: null, failures: result.ok ? 0 : (prev.failures ?? 0) + 1,
      });
      // A judged run (an admin's, while held) ends the hold.
      if (await store.getSchedule(nodeId, HOLD)) await store.deleteSchedule(nodeId, HOLD);
    },
    /**
     * The artefact's references were captured again: nodes held on it (HOLD) get Stage B at a random
     * time in the first-run window once nothing else holds them. Returns the node ids reopened.
     */
    async reopenAfterCapture(artifact) {
      const reopened = [];
      for (const node of await store.allNodes()) {
        const held = await heldArtifacts(store, node.id);
        if (!held.includes(artifact)) continue;
        const rest = held.filter((a) => a !== artifact);
        if (rest.length) {
          const row = await store.getSchedule(node.id, HOLD);
          await store.setSchedule(node.id, HOLD, { ...row, digest: JSON.stringify(rest) });
          continue;
        }
        await store.deleteSchedule(node.id, HOLD);
        if (STAGE_B_STATES.includes(node.state)) await this.firstStageB(node.id, await store.latestCard(node.id), 'first');
        reopened.push(node.id);
      }
      return reopened;
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
      if ((await heldArtifacts(store, node.id)).length) continue;   // identity inconclusive: see HOLD
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
        // A tested offering's model, serving, hardware or binding changed since the last Stage B, or a
        // tested offering is new: run it at a random time in the change window.
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
