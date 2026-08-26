// Periodic catalog re-import: keeps imported prices/offerings fresh (imports are
// upserts keyed by node id + revision, so each cycle replaces the previous snapshot).
import {
  importModelsDev, importHuggingFace, importOpenRouter,
  importOllamaLibrary, parseOllamaLibrary,
  HF_ROUTER_URL, HF_HUB_URL, OPENROUTER_URL, OLLAMA_LIBRARY_URL,
} from './importers.js';

export const MODELS_DEV_URL = 'https://models.dev/api.json';

export function startReimport(store, {
  safeFetch,
  intervalMs = 6 * 3600 * 1000,          // the HF re-test cadence
  sources = ['openrouter', 'huggingface'],
  onCycle = null,
} = {}) {
  let stopped = false;
  const json = async (url, t = 120_000) => (await safeFetch(url, {}, t)).json();

  async function cycle() {
    const results = {};
    for (const source of sources) {
      try {
        if (source === 'openrouter') {
          results[source] = await importOpenRouter(store, await json(OPENROUTER_URL));
        } else if (source === 'huggingface') {
          const router = await json(HF_ROUTER_URL);
          let hub = [];
          try { hub = await json(HF_HUB_URL); } catch { /* enrichment optional */ }
          results[source] = await importHuggingFace(store, router, hub);
        } else if (source === 'models-dev') {
          results[source] = await importModelsDev(store, await json(MODELS_DEV_URL));
        } else if (source === 'ollama') {
          const html = await (await safeFetch(OLLAMA_LIBRARY_URL, {}, 120_000)).text();
          results[source] = await importOllamaLibrary(store, parseOllamaLibrary(html));
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

  const loop = async () => {
    if (stopped) return;
    await cycle().catch(() => {});
    if (!stopped) setTimeout(loop, intervalMs).unref?.();
  };
  setTimeout(loop, 2000).unref?.(); // first cycle shortly after boot

  return { stop: () => { stopped = true; }, cycle };
}
