// ONP Gateway (REQ-002 TC-GW): local OpenAI-compatible server over discovered offerings.
// Third-party clients point their base URL here and need zero ONP knowledge; the gateway
// does discovery, policy, revision pinning, price_changed recovery, fallback, and receipts.
import { appendFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { createApp, listen, closeApp, sendJson, problem, readJson, verifyJws, keyFromJwk, costForUsage, round6, extractFeatures, recommend, recommendEmbedders, isEmbedder, parseAutoModel, AUTO_MODEL_NAMES, responseBudgetMs, fetchWithin } from '@opennodes/core';
import { OnpClient } from './client.js';
import { loadChecks, DEFAULT_CHECKS_PATH } from './check.js';
import { Reputation } from './reputation.js';

const CACHE_TTL_MS = 30_000;
const CHECK_TTL_MS = 7 * 24 * 3600_000;   // a user's own check counts for a week
export const TIERS = ['unverified', 'community', 'verified', 'attested'];
const atLeast = (tier, floor) => (TIERS.indexOf(tier) >= TIERS.indexOf(floor) ? tier : floor);
// Advisor-routed virtual models (the ONP answer to openrouter/auto). Routing runs
// locally on the gateway's cached catalog: the prompt never leaves the machine.
// onp/auto, onp/auto-cheap|fast|quality|private, and onp/auto-<where> (eu, or a country code such as
// ca): only operators in that jurisdiction (ONP-2 node.operator.country).
const AUTO_IDS = AUTO_MODEL_NAMES.map((n) => `onp/${n}`);

// Standard provider key variables. A key found here is sent only to its own host,
// and makes that host's imported listings eligible for onp/auto routing.
export const ENV_KEYS = {
  'openrouter.ai': ['OPENROUTER_API_KEY'],
  'router.huggingface.co': ['HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN'],
  'api.openai.com': ['OPENAI_API_KEY'],
  'api.mistral.ai': ['MISTRAL_API_KEY'],
  'api.groq.com': ['GROQ_API_KEY'],
  'api.together.xyz': ['TOGETHER_API_KEY'],
  'api.deepinfra.com': ['DEEPINFRA_API_KEY'],
  'api.fireworks.ai': ['FIREWORKS_API_KEY'],
};
// Registry text search matches node ids; these find a host's listings when the
// host name alone would not (Hugging Face providers are imported as import.hf.*).
const HOST_SEARCH = { 'router.huggingface.co': 'import.hf.' };

/** Upstream credentials by hostname: env-detected keys, overridden by explicit --key entries. */
export function credentialsFrom(keys = {}, env = process.env) {
  const out = {};
  for (const [host, names] of Object.entries(ENV_KEYS)) {
    const name = names.find((n) => env[n]);
    if (name) out[host] = env[name];
  }
  return { ...out, ...keys };
}

const hostOf = (o) => { try { return new URL(o.endpoints.openai).hostname; } catch { return null; } };
// a domain is found by its name (api.acme.ai -> "acme"); an IP address has none, so search without a text filter
const searchHint = (host) => HOST_SEARCH[host] ?? (/^[\d.]+$|^\[/.test(host) ? '' : host.split('.').slice(-2, -1)[0]);

/**
 * Can this machine call the offering right now? Registered nodes with a free tier need no
 * account; anything else (imported catalogs, paid-only nodes) needs a key for its host.
 */
export function callable(offering, creds) {
  const host = hostOf(offering);
  if (!host) return false;
  if (creds[host]) return true;
  return offering.source !== 'import' && (offering.pricing?.schemes ?? []).includes('free');
}

export async function startGateway({
  registry, port = 4141, host = '127.0.0.1', token = null,
  aliases = {}, virtuals = {}, policy = {}, ledgerPath = null,
  keys = {},   // BYOK upstream credentials by hostname, e.g. {"openrouter.ai": "sk-or-...", "router.huggingface.co": "hf_..."}
  env = process.env,   // where standard provider key variables are read from; pass {} to disable
  checksPath = DEFAULT_CHECKS_PATH,   // results of `onp check`; null to ignore them
  reputationPath = null,   // where passive reputation persists (the CLI uses ~/.opennodes); null = this run only
  ollama = null,   // your local Ollama (the CLI uses http://127.0.0.1:11434): its embedding models serve /v1/embeddings first
} = {}) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !token) {
    throw new Error('refusing non-loopback bind without --token (TC-NFR-03)');
  }
  const client = new OnpClient({ registry, policy });
  const creds = credentialsFrom(keys, env);
  const jwksCache = new Map();
  const receipts = [];
  let cache = { at: 0, byId: new Map() };
  let lastAdvice = null;
  const reputation = new Reputation(reputationPath);

  // The routing pool: what this machine can actually call. Registered nodes at the minimum tier
  // (community unless --min-tier says otherwise), plus the listings of every host we hold a key for;
  // those imports are unverified, so they rank lower on trust and drop out under a higher min tier.
  const minTier = policy.min_tier ?? 'community';
  async function refresh() {
    if (Date.now() - cache.at < CACHE_TTL_MS && cache.byId.size) return;
    const lists = await Promise.all([
      client.search({ tier: minTier === 'unverified' ? 'community' : minTier, limit: 200 }),
      // registered nodes that haven't passed their checks yet: free ones need no key
      ...(minTier === 'unverified' ? [client.search({ tier: 'unverified', scheme: 'free', limit: 200 })] : []),
      ...Object.keys(creds).map((h) => client.search({ q: searchHint(h), limit: 200 })
        .then((os) => os.filter((o) => hostOf(o) === h)).catch(() => [])),
    ]);
    const offerings = lists.flat().filter((o) => callable(o, creds));
    cache = { at: Date.now(), byId: new Map(offerings.map((o) => [`${o.node_id}/${o.offering_id}`, o])) };
  }

  /**
   * The user's own `onp check` results (last 7 days) adjust the pool: an offering that didn't answer is
   * left out; one that did gets the user's measured speed where the registry has none, loses declared
   * JSON/tool support that failed, and is capped below a context size that lost the fact.
   */
  function withLocalChecks(offerings) {
    const local = checksPath ? loadChecks(checksPath) : {};
    return offerings.flatMap((o) => {
      const c = local[`${o.node_id}/${o.offering_id}`];
      if (!c || Date.now() - Date.parse(c.at) > CHECK_TTL_MS) return [o];
      if (!c.usable) return [];
      const observed = { ...o.observed };
      if (observed.ttft_ms?.p50 == null && c.ttft_ms) observed.ttft_ms = { p50: c.ttft_ms };
      if (!(observed.tps > 0) && c.tps) observed.tps = c.tps;
      if (observed.probe_success == null) observed.probe_success = c.ok ? 1 : 0.5;
      const serving = { ...o.serving };
      const lost = { 'json mode': 'json_mode', 'tool calls': 'tool_calls' };
      serving.supports = (serving.supports ?? []).filter((s) => !c.failed.some((f) => lost[f] === s));
      const ctx = c.checks?.find((x) => x.name === 'context' && x.status === 'fail');
      const size = Number(ctx?.detail?.match(/^(\d+) tokens/)?.[1]);
      if (size) serving.context_window = Math.min(serving.context_window ?? Infinity, Math.floor(size / 2));
      return [{ ...o, observed, serving, checked_by_you: c.ok ? 'passed' : `issues: ${c.failed.join(', ')}` }];
    });
  }

  /** An explicitly named offering outside the routing pool: look it up directly. */
  async function lookup(id) {
    const [nodeId, offeringId] = id.split('/');
    if (!nodeId || !offeringId) return null;
    const res = await fetch(`${client.registry}/v0/offerings/${encodeURIComponent(nodeId)}/${encodeURIComponent(offeringId)}`);
    return res.ok ? res.json() : null;
  }

  /** Resolve a requested model id to an ordered candidate list of offerings. */
  async function resolve(modelId, body = null) {
    await refresh();
    const auto = parseAutoModel(modelId, 'onp/');
    if (auto) {
      const messages = body?.messages ?? [];
      const last = [...messages].reverse().find((m) => m.role === 'user');
      const text = typeof last?.content === 'string' ? last.content
        : (last?.content ?? []).map((p) => p.text ?? '').join(' ');
      const features = extractFeatures(text, {
        messages: messages.slice(0, -1), est_output_tokens: body?.max_tokens ?? null,
        request: body ? { tools: body.tools, json: ['json_object', 'json_schema'].includes(body.response_format?.type) } : null,
      });
      const { preset } = auto;
      const result = recommend(reputation.apply(withLocalChecks([...cache.byId.values()])), features, {
        preset, limit: 5,
        min_tier: preset === 'private' ? atLeast(minTier, 'community') : policy.min_tier,   // private never goes below community
        max_input_per_mtok: policy.max_input_per_mtok,
        jurisdiction: auto.jurisdiction ?? policy.jurisdiction,
        prefer_local: preset === 'private',
      });
      lastAdvice = { model: modelId, features, recommendations: result.recommendations.map((r) => {
        const mine = cache.byId.get(r.offering) && withLocalChecks([cache.byId.get(r.offering)])[0]?.checked_by_you;
        const seen = reputation.describe(r.offering);
        return { offering: r.offering, score: r.score, reasons: [...r.reasons, ...(mine ? [`checked by you: ${mine}`] : []), ...(seen ? [seen] : [])] };
      }) };
      return result.recommendations.map((r) => cache.byId.get(r.offering)).filter(Boolean);
    }
    if (virtuals[modelId]) {
      const results = await client.search(Object.fromEntries(new URLSearchParams(virtuals[modelId])));
      return results.filter((o) => callable(o, creds)).map((o) => (cache.byId.get(`${o.node_id}/${o.offering_id}`) ?? o));
    }
    // A named offering is honoured even outside the pool: the caller chose it.
    const target = aliases[modelId] ?? modelId;
    const offering = cache.byId.get(target) ?? await lookup(target);
    return offering ? [offering] : [];
  }

  /** sent: { revision, bytes } of the request as pinned and sent, to check the receipt is about it. */
  async function verifyReceipt(offering, receiptJws, sent = null) {
    const origin = new URL(offering.endpoints.openai).origin;
    if (receiptJws.startsWith('http')) receiptJws = await fetchReceipt(receiptJws, origin);
    if (!jwksCache.has(origin)) {
      jwksCache.set(origin, await (await fetch(`${origin}/.well-known/jwks.json`)).json());
    }
    const receipt = verifyJws(receiptJws, keyFromJwk(jwksCache.get(origin).keys[0]));
    const expected = costForUsage(offering.pricing, receipt.usage.prompt_tokens, receipt.usage.completion_tokens);
    if (round6(receipt.amount.value) !== round6(expected)) throw new Error('receipt amount mismatch');
    if (sent?.revision && receipt.card_revision !== sent.revision) throw new Error('receipt names another card revision');
    if (sent?.bytes && receipt.request_hash !== `sha256:${createHash('sha256').update(sent.bytes).digest('hex')}`) {
      throw new Error('receipt request_hash does not match the request sent');
    }
    return receipt;
  }

  /** Fetch a receipt published by URL: only from the node's own origin; brief retry while it materializes. */
  async function fetchReceipt(url, origin) {
    if (new URL(url).origin !== origin) throw new Error(`receipt URL outside the node's origin: ${url}`);
    for (let i = 0; ; i++) {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return (await res.text()).trim();
      if (res.status !== 404 || i >= 4) throw new Error(`receipt ${res.status}`);
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }

  function logRequest(entry) {
    receipts.push(entry);
    if (ledgerPath) appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
    console.log(`[gateway] ${entry.model} -> ${entry.offering} rev=${entry.revision} ` +
      `${entry.cost != null ? entry.currency + ' ' + entry.cost : entry.receipt_error ? 'RECEIPT FAILED: ' + entry.receipt_error : 'no-receipt'} ${entry.latency_ms}ms${entry.fallback ? ' (fallback)' : ''}`);
  }

  const authed = (req, res) => {
    if (!token) return true;
    if (req.headers.authorization === `Bearer ${token}`) return true;
    problem(res, 401, 'unauthorized', 'missing or wrong bearer token');
    return false;
  };

  /** One upstream attempt. Returns {done:true} when the response was written, or {retryPricing|failed}. */
  async function attempt(offering, body, res, requestedModel) {
    client.checkPolicy(offering, body.max_tokens ?? 1024);
    const t0 = performance.now();
    // BYOK: attach the operator's key for this upstream host (imported catalogs
    // like OpenRouter/HF need their own credentials; ONP nodes may need none).
    const upstreamKey = creds[new URL(offering.endpoints.openai).hostname];
    // Give up on this node if it hasn't started answering within a budget built from its measured
    // latency and the request size, so failover reaches the next candidate quickly.
    const { models: _fallbacks, ...upstreamBody } = body;   // the fallback list is ours, not the node's
    const budgetMs = responseBudgetMs(offering, {
      stream: Boolean(body.stream),
      promptTokens: Math.ceil(JSON.stringify(body.messages ?? '').length / 4),
      maxTokens: body.max_tokens ?? body.max_completion_tokens ?? 512,
    });
    const requestBytes = JSON.stringify({ ...upstreamBody, model: offering.binding.model_id });
    const upstream = await fetchWithin(`${offering.endpoints.openai}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'onp-offering': `${offering.node_id}/${offering.offering_id}`,
        'onp-card-revision': offering.card_revision,
        ...(upstreamKey ? { authorization: `Bearer ${upstreamKey}` } : {}),
      },
      body: requestBytes,
    }, budgetMs);

    const firstMs = Math.round(performance.now() - t0);   // headers: for a stream, the first token is on its way
    if (upstream.status === 409) return { retryPricing: true };
    if (!upstream.ok) return { failed: `upstream ${upstream.status}` };

    const receiptRef = upstream.headers.get('onp-receipt');
    const sent = { revision: offering.card_revision, bytes: requestBytes };
    const entry = {
      ts: new Date().toISOString(), model: requestedModel,
      offering: `${offering.node_id}/${offering.offering_id}`, revision: offering.card_revision,
      receipt_id: null, cost: null, currency: null, usage: null,
      latency_ms: Math.round(performance.now() - t0),
    };
    const settle = (receipt) => Object.assign(entry, receipt && {
      receipt_id: receipt.receipt_id, cost: receipt.amount.value, currency: receipt.amount.currency, usage: receipt.usage,
    });

    if (!body.stream) {
      // Whole answer in hand: a receipt that doesn't verify means trying the next node instead.
      try { if (receiptRef) settle(await verifyReceipt(offering, receiptRef, sent)); }
      catch (err) { return { failed: `receipt verification: ${err.message}` }; }
    }

    if (body.stream) {
      res.writeHead(200, { 'content-type': upstream.headers.get('content-type') ?? 'text/event-stream' });
      await new Promise((resolve, reject) => {
        const nodeStream = Readable.fromWeb(upstream.body);
        nodeStream.pipe(res);
        nodeStream.on('end', resolve);
        nodeStream.on('error', reject);
      });
      // A streamed receipt is published by URL once the stream ends, so it is checked afterwards;
      // the answer is already delivered, so a failure is recorded in the ledger, not retried.
      try { if (receiptRef) settle(await verifyReceipt(offering, receiptRef, sent)); }
      catch (err) { entry.receipt_error = err.message; }
    } else {
      const completion = await upstream.json();
      sendJson(res, 200, { ...completion, model: requestedModel });
    }
    logRequest(entry);
    return { done: true, ms: Math.round(performance.now() - t0), ...(body.stream ? { first_ms: firstMs } : {}) };
  }

  /* ---------------------------------------------------------------- embeddings */
  let embedListings = { at: 0, byBase: new Map() };
  let localEmbed = { at: 0, list: [] };

  /** The registry's Ollama-library embedding listings, by model base name (sizes and pulls for ranking). */
  async function libraryEmbedders() {
    if (Date.now() - embedListings.at < CACHE_TTL_MS * 10 && embedListings.byBase.size) return embedListings.byBase;
    try {
      const list = await client.search({ modality: 'embedding', limit: 200 });
      embedListings = { at: Date.now(), byBase: new Map(list.filter((o) => o.local).map((o) => [o.binding.model_id.split(':')[0], o])) };
    } catch { /* ranking just has less to go on */ }
    return embedListings.byBase;
  }

  /** Embedding models already pulled into the local Ollama: free, and nothing leaves this machine. */
  async function localEmbedders() {
    if (!ollama) return [];
    if (Date.now() - localEmbed.at < CACHE_TTL_MS) return localEmbed.list;
    let list = [];
    try {
      const res = await fetch(`${ollama}/api/tags`, { signal: AbortSignal.timeout(2000) });
      const { models = [] } = res.ok ? await res.json() : {};
      const library = await libraryEmbedders();
      list = models.flatMap((m) => {
        const base = m.name.split(':')[0];
        const lib = library.get(base);
        const o = {
          node_id: 'local', offering_id: m.name, tier: 'local', source: 'local', modality: lib ? 'embedding' : 'text',
          model: { name: m.name, ...(lib?.model?.params_b ? { params_b: lib.model.params_b } : {}) },
          binding: { model_id: m.name }, endpoints: { openai: `${ollama}/v1` },
          pricing: { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0 },
          local: { run: `ollama pull ${base}`, ...(lib?.local?.pulls ? { pulls: lib.local.pulls } : {}) }, observed: {},
        };
        return isEmbedder(o) ? [o] : [];
      });
    } catch { /* no local Ollama running */ }
    localEmbed = { at: Date.now(), list };
    return list;
  }

  /** Candidates for an embeddings request: auto models rank local, registered and keyed embedders. */
  async function resolveEmbedding(modelId, body) {
    await refresh();
    const local = await localEmbedders();
    const auto = parseAutoModel(modelId, 'onp/');
    if (auto) {
      const remote = [...cache.byId.values()].filter(isEmbedder);
      const pool = reputation.apply(auto.preset === 'private' ? local : [...local, ...remote]);
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const sample = inputs.filter((x) => typeof x === 'string').slice(0, 5).join(' ').slice(0, 4000);
      // what gets embedded is the user's own material: treat it as private, so local models lead
      const features = { ...extractFeatures(sample, { request: {} }), corpus: { documents: inputs.length, private: true } };
      const ranked = recommendEmbedders(pool, features, { min_tier: policy.min_tier, jurisdiction: auto.jurisdiction ?? policy.jurisdiction, limit: 5 });
      lastAdvice = { model: modelId, kind: 'embeddings', features, recommendations: ranked.map((r) => {
        const seen = reputation.describe(r.offering);
        return { offering: r.offering, score: r.score, reasons: seen ? [...r.reasons, seen] : r.reasons };
      }) };
      const byId = new Map(pool.map((o) => [`${o.node_id}/${o.offering_id}`, o]));
      return ranked.map((r) => byId.get(r.offering)).filter(Boolean);
    }
    const target = aliases[modelId] ?? modelId;
    const mine = local.find((o) => o.offering_id === target || o.offering_id === `${target}:latest`);
    if (mine) return [mine];
    const offering = cache.byId.get(target) ?? await lookup(target);
    return offering ? [offering] : [];
  }

  /** One upstream embeddings call; same contract as attempt(). */
  async function attemptEmbedding(offering, body, res, requestedModel) {
    const isLocal = offering.tier === 'local';
    if (!isLocal) client.checkPolicy(offering, 0);
    const t0 = performance.now();
    const upstreamKey = isLocal ? null : creds[new URL(offering.endpoints.openai).hostname];
    const { models: _fallbacks, ...upstreamBody } = body;
    const chars = JSON.stringify(body.input ?? '').length;
    const upstream = await fetchWithin(`${offering.endpoints.openai}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(!isLocal && offering.source !== 'import' ? { 'onp-offering': `${offering.node_id}/${offering.offering_id}`, 'onp-card-revision': offering.card_revision } : {}),
        ...(upstreamKey ? { authorization: `Bearer ${upstreamKey}` } : {}),
      },
      body: JSON.stringify({ ...upstreamBody, model: offering.binding.model_id }),
    }, 30_000 + Math.ceil(chars / 4) * 2);   // ~2 ms per input token on modest hardware
    if (!upstream.ok) return { failed: `upstream ${upstream.status}` };
    const result = await upstream.json().catch(() => null);
    if (!Array.isArray(result?.data)) return { failed: 'no embeddings in the response' };
    const tokens = result.usage?.prompt_tokens ?? result.usage?.total_tokens ?? null;
    const price = offering.pricing?.input_per_mtok;
    logRequest({
      ts: new Date().toISOString(), model: requestedModel, kind: 'embeddings',
      offering: `${offering.node_id}/${offering.offering_id}`, revision: offering.card_revision ?? null,
      receipt_id: null, currency: offering.pricing?.currency ?? 'USD', usage: result.usage ?? null,
      cost: isLocal ? 0 : tokens != null && price != null ? round6(tokens * price / 1e6) : null,
      latency_ms: Math.round(performance.now() - t0),
    });
    sendJson(res, 200, { ...result, model: requestedModel });
    return { done: true, ms: Math.round(performance.now() - t0) };
  }

  async function repin(offering) {
    const origin = new URL(offering.endpoints.openai).origin;
    const { card } = await client.resolveCard(origin);
    const fresh = card.offerings.find((o) => o.offering_id === offering.offering_id);
    if (!fresh) return null;
    return { ...offering, pricing: fresh.pricing, card_revision: card.revision };
  }

  const app = createApp([
    ['GET', '/v1/models', async (req, res) => {
      if (!authed(req, res)) return;
      await refresh();
      const ids = [...AUTO_IDS, ...cache.byId.keys(), ...Object.keys(aliases), ...Object.keys(virtuals)];
      sendJson(res, 200, {
        object: 'list',
        data: ids.map((id) => ({ id, object: 'model', owned_by: 'opennodes-gateway' })),
      });
    }],

    ['POST', '/v1/chat/completions', async (req, res) => {
      if (!authed(req, res)) return;
      const body = await readJson(req, 10_000_000);
      const candidates = await resolve(body.model, body);
      // OpenRouter-compatible fallback list: `models: [...]` adds further models to try, in order.
      if (Array.isArray(body.models)) {
        const seen = new Set(candidates.map((o) => `${o.node_id}/${o.offering_id}`));
        for (const m of body.models.slice(0, 10)) {
          if (typeof m !== 'string' || m === body.model) continue;
          for (const o of await resolve(m, body)) {
            const key = `${o.node_id}/${o.offering_id}`;
            if (!seen.has(key)) { seen.add(key); candidates.push(o); }
          }
        }
      }
      if (!candidates.length && (parseAutoModel(body.model, 'onp/') || virtuals[body.model])) {
        return problem(res, 404, 'no-callable-offerings',
          `nothing in the registry matches ${body.model} that this gateway can call: free registered nodes need no key; ` +
          'for imported catalogs pass --key <host>=<key> or set a provider variable such as OPENROUTER_API_KEY or HF_TOKEN');
      }
      if (!candidates.length) return problem(res, 404, 'model-not-found', String(body.model));

      const errors = [];
      for (let i = 0; i < candidates.length; i++) {
        let offering = candidates[i];
        const id = `${candidates[i].node_id}/${candidates[i].offering_id}`;
        const t0 = performance.now();
        try {
          let result = await attempt(offering, body, res, body.model);
          if (result.retryPricing) {
            offering = await repin(offering);
            if (offering) result = await attempt(offering, body, res, body.model);
            else result = { failed: 'offering gone after reprice' };
          }
          if (result.done) { reputation.record(id, { ok: true, ms: result.ms, first_ms: result.first_ms }); return; }
          reputation.record(id, { ok: false, ms: Math.round(performance.now() - t0), why: result.failed });
          errors.push(`${id}: ${result.failed}`);
        } catch (err) {
          if (!err.message.startsWith('policy: ')) reputation.record(id, { ok: false, ms: Math.round(performance.now() - t0), why: err.message });
          errors.push(`${id}: ${err.message}`);
        }
        if (res.headersSent) return res.end();   // a stream started and broke: nothing more we can send
      }
      // refused by this gateway's own policy (--min-tier, price caps), not a node failure
      if (errors.every((e) => e.includes(': policy: '))) return problem(res, 403, 'policy-refused', errors.join(' | '));
      problem(res, 502, 'all-candidates-failed', errors.join(' | '));
    }],

    ['POST', '/v1/embeddings', async (req, res) => {
      if (!authed(req, res)) return;
      const body = await readJson(req, 50_000_000);
      if (body.input == null || !body.model) return problem(res, 400, 'bad-request', 'embeddings need "model" and "input"');
      const candidates = await resolveEmbedding(body.model, body);
      const auto = parseAutoModel(body.model, 'onp/');
      if (!candidates.length) {
        return auto
          ? problem(res, 404, 'no-callable-offerings', `no embedding model this gateway can call for ${body.model}: pull one into your local Ollama (ollama pull nomic-embed-text)` +
            (auto.preset === 'private' ? '' : ', or pass --key <host>=<key> for a hosted provider that lists embedding models'))
          : problem(res, 404, 'model-not-found', String(body.model));
      }
      const errors = [];
      for (const offering of candidates) {
        const id = `${offering.node_id}/${offering.offering_id}`;
        const t0 = performance.now();
        try {
          const r = await attemptEmbedding(offering, body, res, body.model);
          if (r.done) { reputation.record(id, { ok: true, ms: r.ms }); return; }
          reputation.record(id, { ok: false, ms: Math.round(performance.now() - t0), why: r.failed });
          errors.push(`${id}: ${r.failed}`);
        } catch (err) {
          if (!err.message.startsWith('policy: ')) reputation.record(id, { ok: false, ms: Math.round(performance.now() - t0), why: err.message });
          errors.push(`${id}: ${err.message}`);
        }
      }
      if (errors.every((e) => e.includes(': policy: '))) return problem(res, 403, 'policy-refused', errors.join(' | '));
      problem(res, 502, 'all-candidates-failed', errors.join(' | '));
    }],

    ['GET', '/gateway/reputation', (req, res) => {
      if (!authed(req, res)) return;
      sendJson(res, 200, { note: 'outcome and timing of your own calls through this gateway; no prompts or answers are kept', offerings: reputation.report() });
    }],

    ['GET', '/gateway/advice', (req, res) => {
      if (!authed(req, res)) return;
      sendJson(res, 200, lastAdvice ?? { model: null, recommendations: [] });
    }],

    ['GET', '/gateway/receipts', (req, res) => {
      if (!authed(req, res)) return;
      const total = round6(receipts.reduce((s, r) => s + (r.cost ?? 0), 0));
      sendJson(res, 200, { total_cost: total, count: receipts.length, entries: receipts.slice(-100) });
    }],
  ]);

  const actualPort = await listen(app, port, host);
  return {
    port: actualPort,
    origin: `http://${host}:${actualPort}`,
    keyHosts: Object.keys(creds),
    receipts,
    close: () => { reputation.flush(); return closeApp(app); },
    reputation,
  };
}
