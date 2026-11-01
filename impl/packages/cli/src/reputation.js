// Passive reputation: what this machine has seen of each offering in real use (gateway, Ollama router).
// Per offering, the last calls' outcome and timing only: never prompts, answers or keys. It fills gaps
// in what the registry measured (imported listings are never probed) and benches an offering that keeps
// failing, so routing gets better just from being used.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_REPUTATION_PATH = join(homedir(), '.opennodes', 'reputation.json');
const KEEP = 50;                         // calls remembered per offering
const MAX_AGE_MS = 30 * 24 * 3600_000;   // older calls don't count
const MIN_CALLS = 3;                     // fewer than this says nothing
const BENCH_STREAK = 3;                  // consecutive failures that bench an offering...
const BENCH_MS = 15 * 60_000;            // ...for this long after the last one

const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

export class Reputation {
  /** path: where to keep it between runs; null keeps it in memory only. */
  constructor(path = null) {
    this.path = path;
    this.calls = {};
    if (path) { try { this.calls = JSON.parse(readFileSync(path, 'utf8')); } catch { /* first run */ } }
    this.timer = null;
  }

  /** outcome: { ok, ms, first_ms?, why? } — first_ms is time to the first streamed byte. */
  record(id, outcome) {
    const list = (this.calls[id] ??= []);
    list.push({ at: Date.now(), ok: Boolean(outcome.ok), ms: outcome.ms ?? null,
      ...(outcome.first_ms != null ? { first_ms: outcome.first_ms } : {}), ...(outcome.why ? { why: String(outcome.why).slice(0, 120) } : {}) });
    if (list.length > KEEP) list.splice(0, list.length - KEEP);
    this.save();
  }

  /** Writes are batched: a burst of calls costs one write. */
  save() {
    if (!this.path || this.timer) return;
    this.timer = setTimeout(() => this.flush(), 1000);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.path) return;
    try { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify(this.calls)); } catch { /* best effort */ }
  }

  summary(id, now = Date.now()) {
    const recent = (this.calls[id] ?? []).filter((c) => now - c.at < MAX_AGE_MS);
    if (recent.length < MIN_CALLS) return null;
    const ok = recent.filter((c) => c.ok);
    let streak = 0;
    for (let i = recent.length - 1; i >= 0 && !recent[i].ok; i--) streak++;
    const last = recent[recent.length - 1];
    return {
      calls: recent.length, ok: ok.length, rate: Math.round((ok.length / recent.length) * 100) / 100,
      first_ms: median(ok.map((c) => c.first_ms).filter((v) => v != null)),
      ms: median(ok.map((c) => c.ms).filter((v) => v != null)),
      failing_streak: streak,
      benched: streak >= BENCH_STREAK && now - last.at < BENCH_MS,
      last_error: [...recent].reverse().find((c) => !c.ok)?.why ?? null,
    };
  }

  /** Human line for advice output, e.g. "your calls: 19 of 20 ok, first token 820 ms". */
  describe(id) {
    const s = this.summary(id);
    if (!s) return null;
    return `your calls: ${s.ok} of ${s.calls} ok${s.first_ms != null ? `, first token ${s.first_ms} ms` : ''}${s.benched ? `; benched for now after ${s.failing_streak} failures in a row` : ''}`;
  }

  /**
   * Adjust a routing pool: benched offerings drop out; others get this machine's success rate and
   * timing where the registry has measured nothing (registry measurements, from blind probes, win).
   */
  apply(offerings) {
    return offerings.flatMap((o) => {
      const s = this.summary(`${o.node_id}/${o.offering_id}`);
      if (!s) return [o];
      if (s.benched) return [];
      const observed = { ...o.observed };
      if (observed.probe_success == null) observed.probe_success = s.rate;
      if (observed.ttft_ms?.p50 == null && s.first_ms != null) observed.ttft_ms = { p50: s.first_ms };
      return [{ ...o, observed }];
    });
  }

  /** Everything, for /gateway/reputation. */
  report(now = Date.now()) {
    return Object.keys(this.calls).map((id) => {
      const s = this.summary(id, now);
      if (s) return { offering: id, ...s };
      const calls = this.calls[id].filter((c) => now - c.at < MAX_AGE_MS).length;
      return { offering: id, calls, note: `too few calls to count yet (${MIN_CALLS} needed)` };
    }).filter((r) => r.calls).sort((a, b) => b.calls - a.calls);
  }
}
