// ONP Gateway (REQ-002 TC-GW): local OpenAI-compatible server over discovered offerings.
// Third-party clients point their base URL here and need zero ONP knowledge; the gateway
// does discovery, policy, revision pinning, price_changed recovery, fallback, and receipts.
import { appendFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { createApp, listen, closeApp, sendJson, problem, readJson, verifyJws, keyFromJwk, costForUsage, round6 } from '@opennodes/core';
import { OnpClient } from './client.js';

const CACHE_TTL_MS = 30_000;

export async function startGateway({
  registry, port = 4141, host = '127.0.0.1', token = null,
  aliases = {}, virtuals = {}, policy = {}, ledgerPath = null,
  keys = {},   // BYOK upstream credentials by hostname, e.g. {"openrouter.ai": "sk-or-...", "router.huggingface.co": "hf_..."}
} = {}) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !token) {
    throw new Error('refusing non-loopback bind without --token (TC-NFR-03)');
  }
  const client = new OnpClient({ registry, policy });
  const jwksCache = new Map();
  const receipts = [];
  let cache = { at: 0, byId: new Map() };

  async function refresh() {
    if (Date.now() - cache.at < CACHE_TTL_MS && cache.byId.size) return;
    const offerings = await client.search({});
    cache = { at: Date.now(), byId: new Map(offerings.map((o) => [`${o.node_id}/${o.offering_id}`, o])) };
  }

  /** Resolve a requested model id to an ordered candidate list of offerings. */
  async function resolve(modelId) {
    await refresh();
    if (virtuals[modelId]) {
      const results = await client.search(Object.fromEntries(new URLSearchParams(virtuals[modelId])));
      return results.map((o) => (cache.byId.get(`${o.node_id}/${o.offering_id}`) ?? o));
    }
    const target = aliases[modelId] ?? modelId;
    const offering = cache.byId.get(target);
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
    const upstreamKey = keys[new URL(offering.endpoints.openai).hostname];
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
      const ids = [...cache.byId.keys(), ...Object.keys(aliases), ...Object.keys(virtuals)];
      sendJson(res, 200, {
        object: 'list',
        data: ids.map((id) => ({ id, object: 'model', owned_by: 'opennodes-gateway' })),
      });
    }],

    ['POST', '/v1/chat/completions', async (req, res) => {
      if (!authed(req, res)) return;
      const body = await readJson(req, 10_000_000);
      const candidates = await resolve(body.model);
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
    receipts,
    close: () => closeApp(app),
  };
}
