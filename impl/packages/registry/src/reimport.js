// Periodic catalog re-import: keeps imported prices/offerings fresh (imports are
// upserts keyed by node id + revision, so each cycle replaces the previous snapshot).
import {
  importModelsDev, importHuggingFace, importOpenRouter,
  importOllamaLibrary, parseOllamaLibrary,
  importOpenRouterProviders, fetchOpenRouterEndpoints, importHorde,
  HF_ROUTER_URL, HF_HUB_URL, OPENROUTER_URL, OPENROUTER_PROVIDERS_URL, OLLAMA_LIBRARY_URL,
  HORDE_STATUS_URL, HORDE_TEXT_REFERENCE_URL, HORDE_CLIENT_AGENT,
} from './importers.js';

export const MODELS_DEV_URL = 'https://models.dev/api.json';

/**
 * Sources that go stale faster than the catalog interval. AI Horde workers come and go within minutes,
 * so its snapshot is refreshed hourly (one status read an hour is far inside the Horde's limits).
 */
export const SOURCE_INTERVALS = Object.freeze({ horde: 3600 * 1000 });

/** A source's interval: its own when it is a number of at least a minute, never above `intervalMs`. */
const intervalOf = (s, intervalMs, sourceIntervals) => {
  const own = sourceIntervals?.[s];
  return Math.min(Number.isFinite(own) && own >= 60_000 ? own : intervalMs, intervalMs);
};

/** The sources due at `now`: never run, or last run at least their interval ago. */
export function dueSources(sources, lastRun, now, intervalMs, sourceIntervals = SOURCE_INTERVALS) {
  return sources.filter((s) => !lastRun.has(s) || now - lastRun.get(s) >= intervalOf(s, intervalMs, sourceIntervals));
}

export function startReimport(store, {
  safeFetch,
  intervalMs = 6 * 3600 * 1000,          // the HF re-test cadence
  sources = ['openrouter', 'huggingface'],
  sourceIntervals = SOURCE_INTERVALS,
  onCycle = null,
} = {}) {
  let stopped = false;
  const lastRun = new Map();
  const json = async (url, t = 120_000) => (await safeFetch(url, {}, t)).json();
  // A refused or failed read must never look like an empty catalog: that would delist the Horde node.
  const jsonOk = async (url, opts, t = 60_000) => {
    const res = await safeFetch(url, opts, t);
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return res.json();
  };

  async function cycle(only = sources) {
    const results = {};
    for (const source of only) {
      lastRun.set(source, Date.now());
      try {
        if (source === 'openrouter') {
          results[source] = await importOpenRouter(store, await json(OPENROUTER_URL));
        } else if (source === 'huggingface') {
          const router = await json(HF_ROUTER_URL);
          let hub = [];
          try { hub = await json(HF_HUB_URL); } catch { /* enrichment optional */ }
          results[source] = await importHuggingFace(store, router, hub);
        } else if (source === 'openrouter-providers') {
          // One call per model for its endpoint list (~450): prefer a long interval for this source.
          const models = (await json(OPENROUTER_URL)).data;
          const providers = (await json(OPENROUTER_PROVIDERS_URL)).data;
          results[source] = await importOpenRouterProviders(store, providers, models,
            await fetchOpenRouterEndpoints((url) => json(url, 30_000), models));
        } else if (source === 'models-dev') {
          results[source] = await importModelsDev(store, await json(MODELS_DEV_URL));
        } else if (source === 'ollama') {
          const html = await (await safeFetch(OLLAMA_LIBRARY_URL, {}, 120_000)).text();
          results[source] = await importOllamaLibrary(store, parseOllamaLibrary(html));
        } else if (source === 'horde') {
          // Public status only (with the Client-Agent the Horde asks of every client); no prompt is sent.
          const status = await jsonOk(HORDE_STATUS_URL, { headers: { 'client-agent': HORDE_CLIENT_AGENT } });
          // The reference gives each model its public record. Without it nothing can be listed honestly,
          // so a failed read keeps the previous snapshot instead of emptying it.
          const reference = await jsonOk(HORDE_TEXT_REFERENCE_URL, {}, 120_000);
          if (!reference || typeof reference !== 'object' || !Object.keys(reference).length) throw new Error('empty AI Horde model reference');
          results[source] = await importHorde(store, status, reference);
        } else {
          results[source] = { error: `unknown source: ${source}` };
        }
      } catch (err) {
        results[source] = { error: String(err.message ?? err) };
      }
    }
    onCycle?.(results);
    return results;
  }

  // Wake at the shortest interval among the sources and run only the ones that are due.
  const tick = Math.min(intervalMs, ...sources.map((s) => intervalOf(s, intervalMs, sourceIntervals)));
  const loop = async () => {
    if (stopped) return;
    const due = dueSources(sources, lastRun, Date.now(), intervalMs, sourceIntervals);
    if (due.length) await cycle(due).catch(() => {});
    if (!stopped) setTimeout(loop, tick).unref?.();
  };
  setTimeout(loop, 2000).unref?.(); // first cycle shortly after boot

  return { stop: () => { stopped = true; }, cycle };
}
