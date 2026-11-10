// Request counts (ONP-3 §6.6): how often the registry returns each node to a client, per ISO week and
// surface. A response counts each node in it once. Only node ids, weeks and counts are kept: never the
// query, task, prompt or features, and nothing about the client.

/** Where a node can be returned: GET /v0/offerings, POST /v0/recommend, and MCP tools/call on /mcp. */
export const SURFACES = ['search', 'recommend', 'mcp'];
/** Row key for the number of responses on a surface, whichever nodes they held. */
const RESPONSES = '*';
const DAY_MS = 86_400_000;

/** ISO 8601 week of a date in UTC, e.g. "2026-W46". */
export function isoWeek(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));   // the week's Thursday decides its year
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d - Date.UTC(year, 0, 1)) / DAY_MS + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Monday (UTC) that starts an ISO week, as YYYY-MM-DD. */
export function weekStart(week) {
  const [year, w] = week.split('-W').map(Number);
  const jan4 = Date.UTC(year, 0, 4);
  const monday1 = jan4 - ((new Date(jan4).getUTCDay() || 7) - 1) * DAY_MS;
  return new Date(monday1 + (w - 1) * 7 * DAY_MS).toISOString().slice(0, 10);
}

/** The `n` ISO weeks ending with the one holding `date`, newest first. */
export function recentWeeks(n, date = new Date()) {
  return Array.from({ length: n }, (_, i) => isoWeek(new Date(date.getTime() - i * 7 * DAY_MS)));
}

/**
 * Every node id anywhere in a response: `node_id` values (offerings, recommendations, scenario
 * roles, sites) and `node_ids` lists (residency providers).
 */
export function nodeIdsIn(value, ids = new Set()) {
  if (Array.isArray(value)) for (const v of value) nodeIdsIn(v, ids);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (k === 'node_id' && typeof v === 'string') ids.add(v);
      else if (k === 'node_ids' && Array.isArray(v)) for (const id of v) { if (typeof id === 'string') ids.add(id); }
      else if (v && typeof v === 'object') nodeIdsIn(v, ids);
    }
  }
  return ids;
}

const emptyWeek = (week) => ({ week, starts: weekStart(week), search: 0, recommend: 0, mcp: 0, total: 0 });

/**
 * Counts in memory, written to the store in batches (every `flushMs`, before every read, and on
 * stop), so a search never waits on a database write.
 */
export function makeRequestCounter(store, { flushMs = 60_000, clock = () => new Date() } = {}) {
  let pending = new Map();   // "node\tweek\tsurface" -> n
  const add = (nodeId, week, surface, n) => {
    const key = `${nodeId}\t${week}\t${surface}`;
    pending.set(key, (pending.get(key) ?? 0) + n);
  };

  /** One response on `surface` returned these nodes (duplicates count once). */
  function count(surface, nodeIds) {
    if (!SURFACES.includes(surface)) throw new Error(`unknown surface: ${surface}`);
    const week = isoWeek(clock());
    add(RESPONSES, week, surface, 1);
    for (const id of new Set(nodeIds)) if (id && id !== RESPONSES) add(id, week, surface, 1);
  }

  let chain = Promise.resolve();
  function flush() {
    chain = chain.then(async () => {
      if (!pending.size) return;
      const batch = pending;
      pending = new Map();
      const rows = [...batch].map(([key, n]) => {
        const [node_id, week, surface] = key.split('\t');
        return { node_id, week, surface, n };
      });
      try { await store.addRequestCounts(rows); }
      catch { for (const r of rows) add(r.node_id, r.week, r.surface, r.n); }   // retried on the next flush
    });
    return chain;
  }
  const timer = flushMs > 0 ? setInterval(() => { flush(); }, flushMs) : null;
  timer?.unref?.();

  /** Node detail: the last `weeks` ISO weeks for one node, newest first, zero weeks included. */
  async function forNode(nodeId, weeks = 12) {
    await flush();
    const range = recentWeeks(weeks, clock());
    const rows = await store.requestCounts({ nodeId, sinceWeek: range.at(-1) });
    const byWeek = new Map(range.map((w) => [w, emptyWeek(w)]));
    for (const r of rows) {
      const w = byWeek.get(r.week);
      if (!w || !SURFACES.includes(r.surface)) continue;
      w[r.surface] += Number(r.n);
      w.total += Number(r.n);
    }
    return [...byWeek.values()];
  }

  /**
   * Stats endpoint: per week, the responses on each surface and the nodes they returned (most
   * returned first, at most `limit`), optionally for one node only.
   */
  async function stats({ weeks = 4, nodeId = null, limit = 50 } = {}) {
    await flush();
    const range = recentWeeks(weeks, clock());
    const rows = await store.requestCounts({ sinceWeek: range.at(-1) });
    const out = new Map(range.map((w) => [w, { week: w, starts: weekStart(w), responses: { search: 0, recommend: 0, mcp: 0 }, nodes: new Map() }]));
    for (const r of rows) {
      const w = out.get(r.week);
      if (!w || !SURFACES.includes(r.surface)) continue;
      const n = Number(r.n);
      if (r.node_id === RESPONSES) { w.responses[r.surface] += n; continue; }
      if (nodeId && r.node_id !== nodeId) continue;
      const node = w.nodes.get(r.node_id) ?? { node_id: r.node_id, search: 0, recommend: 0, mcp: 0, total: 0 };
      node[r.surface] += n;
      node.total += n;
      w.nodes.set(r.node_id, node);
    }
    return [...out.values()].map((w) => {
      const nodes = [...w.nodes.values()].sort((a, b) => b.total - a.total || a.node_id.localeCompare(b.node_id));
      return { week: w.week, starts: w.starts, responses: w.responses, nodes_returned: nodes.length, nodes: nodes.slice(0, limit) };
    });
  }

  async function stop() {
    if (timer) clearInterval(timer);
    await flush();
  }

  return { count, flush, forNode, stats, stop };
}
