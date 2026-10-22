// ONP Gateway (REQ-002 TC-GW): local OpenAI-compatible server over discovered offerings.
// Third-party clients point their base URL here and need zero ONP knowledge; the gateway
// does discovery, policy, revision pinning, price_changed recovery, fallback, and receipts.
import { appendFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createApp, listen, closeApp, sendJson, problem, readJson, verifyJws, keyFromJwk, costForUsage, round6, extractFeatures, recommend } from '@opennodes/core';
import { OnpClient } from './client.js';

const CACHE_TTL_MS = 30_000;
// Advisor-routed virtual models (the ONP answer to openrouter/auto). Routing runs
// locally on the gateway's cached catalog: the prompt never leaves the machine.
const AUTO_MODELS = { 'onp/auto': null, 'onp/auto-cheap': 'cheap', 'onp/auto-fast': 'fast', 'onp/auto-quality': 'quality', 'onp/auto-private': 'private', 'onp/auto-eu': null };
// onp/auto-eu: only operators that declare an EU/EEA country (ONP-2 node.operator.country).
const AUTO_JURISDICTION = { 'onp/auto-eu': 'eea' };

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
const searchHint = (host) => HOST_SEARCH[host] ?? host.split('.').slice(-2, -1)[0];

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

  // The routing pool: what this machine can actually call. Registered nodes at community
  // tier and above, plus the listings of every host we hold a key for.
  async function refresh() {
    if (Date.now() - cache.at < CACHE_TTL_MS && cache.byId.size) return;
    const lists = await Promise.all([
      client.search({ tier: 'community', limit: 200 }),
      ...Object.keys(creds).map((h) => client.search({ q: searchHint(h), limit: 200 })
        .then((os) => os.filter((o) => hostOf(o) === h)).catch(() => [])),
    ]);
    const offerings = lists.flat().filter((o) => callable(o, creds));
    cache = { at: Date.now(), byId: new Map(offerings.map((o) => [`${o.node_id}/${o.offering_id}`, o])) };
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
    if (modelId in AUTO_MODELS) {
      const messages = body?.messages ?? [];
      const last = [...messages].reverse().find((m) => m.role === 'user');
      const text = typeof last?.content === 'string' ? last.content
        : (last?.content ?? []).map((p) => p.text ?? '').join(' ');
      const features = extractFeatures(text, { messages: messages.slice(0, -1), est_output_tokens: body?.max_tokens ?? null });
      const preset = AUTO_MODELS[modelId];
      const result = recommend([...cache.byId.values()], features, {
        preset, limit: 5,
        min_tier: preset === 'private' ? 'community' : policy.min_tier,
        max_input_per_mtok: policy.max_input_per_mtok,
        jurisdiction: AUTO_JURISDICTION[modelId] ?? policy.jurisdiction,
        prefer_local: preset === 'private',
      });
      lastAdvice = { model: modelId, features, recommendations: result.recommendations.map((r) => ({ offering: r.offering, score: r.score, reasons: r.reasons })) };
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

  async function verifyReceipt(offering, receiptJws) {
    if (receiptJws.startsWith('http')) {
      // Streaming responses carry the receipt by URL (materialized after the stream ends).
      receiptJws = (await (await fetch(receiptJws, { signal: AbortSignal.timeout(10_000) })).text()).trim();
    }
    const origin = new URL(offering.endpoints.openai).origin;
    if (!jwksCache.has(origin)) {
      jwksCache.set(origin, await (await fetch(`${origin}/.well-known/jwks.json`)).json());
    }
    const receipt = verifyJws(receiptJws, keyFromJwk(jwksCache.get(origin).keys[0]));
    const expected = costForUsage(offering.pricing, receipt.usage.prompt_tokens, receipt.usage.completion_tokens);
    if (round6(receipt.amount.value) !== round6(expected)) throw new Error('receipt amount mismatch');
    return receipt;
  }

  function logRequest(entry) {
    receipts.push(entry);
    if (ledgerPath) appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
    console.log(`[gateway] ${entry.model} -> ${entry.offering} rev=${entry.revision} ` +
      `${entry.cost != null ? entry.currency + ' ' + entry.cost : 'no-receipt'} ${entry.latency_ms}ms${entry.fallback ? ' (fallback)' : ''}`);
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
    const upstream = await fetch(`${offering.endpoints.openai}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'onp-offering': `${offering.node_id}/${offering.offering_id}`,
        'onp-card-revision': offering.card_revision,
        ...(upstreamKey ? { authorization: `Bearer ${upstreamKey}` } : {}),
      },
      body: JSON.stringify({ ...body, model: offering.binding.model_id }),
      signal: AbortSignal.timeout(120_000),
    });

    if (upstream.status === 409) return { retryPricing: true };
    if (!upstream.ok) return { failed: `upstream ${upstream.status}` };

    const receiptJws = upstream.headers.get('onp-receipt');
    let receipt = null;
    try { if (receiptJws) receipt = await verifyReceipt(offering, receiptJws); }
    catch (err) { return { failed: `receipt verification: ${err.message}` }; }

    const entry = {
      ts: new Date().toISOString(), model: requestedModel,
      offering: `${offering.node_id}/${offering.offering_id}`, revision: offering.card_revision,
      receipt_id: receipt?.receipt_id ?? null, cost: receipt?.amount.value ?? null,
      currency: receipt?.amount.currency ?? null, usage: receipt?.usage ?? null,
      latency_ms: Math.round(performance.now() - t0),
    };

    if (body.stream) {
      res.writeHead(200, { 'content-type': upstream.headers.get('content-type') ?? 'text/event-stream' });
      await new Promise((resolve, reject) => {
        const nodeStream = Readable.fromWeb(upstream.body);
        nodeStream.pipe(res);
        nodeStream.on('end', resolve);
        nodeStream.on('error', reject);
      });
    } else {
      const completion = await upstream.json();
      sendJson(res, 200, { ...completion, model: requestedModel });
    }
    logRequest(entry);
    return { done: true };
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
      const ids = [...Object.keys(AUTO_MODELS), ...cache.byId.keys(), ...Object.keys(aliases), ...Object.keys(virtuals)];
      sendJson(res, 200, {
        object: 'list',
        data: ids.map((id) => ({ id, object: 'model', owned_by: 'opennodes-gateway' })),
      });
    }],

    ['POST', '/v1/chat/completions', async (req, res) => {
      if (!authed(req, res)) return;
      const body = await readJson(req, 10_000_000);
      const candidates = await resolve(body.model, body);
      if (!candidates.length && (body.model in AUTO_MODELS || virtuals[body.model])) {
        return problem(res, 404, 'no-callable-offerings',
          `nothing in the registry matches ${body.model} that this gateway can call: free registered nodes need no key; ` +
          'for imported catalogs pass --key <host>=<key> or set a provider variable such as OPENROUTER_API_KEY or HF_TOKEN');
      }
      if (!candidates.length) return problem(res, 404, 'model-not-found', String(body.model));

      const errors = [];
      for (let i = 0; i < candidates.length; i++) {
        let offering = candidates[i];
        try {
          let result = await attempt(offering, body, res, body.model);
          if (result.retryPricing) {
            offering = await repin(offering);
            if (offering) result = await attempt(offering, body, res, body.model);
            else result = { failed: 'offering gone after reprice' };
          }
          if (result.done) return;
          errors.push(`${candidates[i].node_id}/${candidates[i].offering_id}: ${result.failed}`);
        } catch (err) {
          errors.push(`${candidates[i].node_id}/${candidates[i].offering_id}: ${err.message}`);
        }
      }
      problem(res, 502, 'all-candidates-failed', errors.join(' | '));
    }],

    ['POST', '/v1/embeddings', (req, res) => {
      problem(res, 501, 'not-implemented', 'embeddings profile lands with a fixture that serves it');
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
    close: () => closeApp(app),
  };
}
