// Feed shaping: a node that keeps dropping offline and coming back would otherwise fill
// the public feed with suspended/reinstated pairs. Consecutive liveness transitions of
// one node collapse into a single availability event; everything else passes through.

const isLiveness = (e) => /^(liveness:|reinstated:)/.test(e.reason ?? '');

/** events: newest first. Returns newest first, with liveness runs (2+ events) collapsed. */
export function collapseFlaps(events) {
  const out = [];
  const open = new Map();   // node_id -> collapsed entry still accepting older liveness events
  for (const e of events) {
    if (!isLiveness(e)) {
      open.delete(e.node_id);
      out.push(e);
      continue;
    }
    const run = open.get(e.node_id);
    if (run) {
      run.events.push(e);
      continue;
    }
    const entry = { ...e, events: [e] };
    open.set(e.node_id, entry);
    out.push(entry);
  }
  return out.map((entry) => {
    if (!entry.events) return entry;
    const { events: run, ...newest } = entry;
    if (run.length === 1) return newest;
    const oldest = run[run.length - 1];
    const outages = run.filter((e) => e.to === 'suspended').length;
    const now = newest.to === 'suspended' ? 'suspended now' : `${newest.to} again`;
    return {
      ...newest,
      from: oldest.from,
      kind: 'availability',
      collapsed: run.length,
      since: oldest.at,
      reason: `availability: ${outages} outage${outages === 1 ? '' : 's'} since ${oldest.at.slice(0, 10)}, ${now}`,
    };
  });
}
