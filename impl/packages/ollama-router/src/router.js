// OpenNodes for Ollama: one Ollama-compatible endpoint over three tiers —
//   local  : the user's own Ollama (passthrough, preferred when the model is present)
//   lan    : other machines (plain Ollama servers or ONP nodes), static peers + mDNS
//   public : OpenNodes registry offerings (verified providers, pinned prices, signed receipts)
// Routes: Ollama native API (/api/*) with streaming translation, OpenAI /v1, and advisor
// models auto | auto-cheap | auto-fast | auto-quality | auto-private (never leaves the LAN) | auto-eu.
import { appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  createApp, listen, closeApp, sendJson, problem, readJson,
  verifyJws, keyFromJwk, costForUsage, estimateBounds, round6, extractFeatures, recommend, parseAutoModel, AUTO_MODEL_NAMES,
  responseBudgetMs, fetchWithin, trustedView, trustedJurisdictionsFrom, trustGaps, sensitiveHeader,
} from '@opennodes/core';
import {
  parseMaskMode, maskModeOf, piiDetectorFrom, maskChatRequest, maskedRequestFor, oncePerRequest,
  unmaskCompletion, unmaskSse, createSseUnmasker, piiMaskedHeader,
} from '@opennodes/core';
import { OnpClient } from '@opennodes/cli';
import { Reputation } from '@opennodes/cli/src/reputation.js';
import {
  ollamaChatToOpenAI, ollamaGenerateToOpenAI, parseSse, parseNdjson, OllamaChunker,
  capabilitiesToSupports, parseParamsB, contextFromModelInfo,
} from './translate.js';
import { probePeer, browseMdns } from './discovery.js';

// auto, auto-cheap|fast|quality|private, auto-sensitive (trusted pool only), and auto-<where> (eu, or a
// country code such as ca): your own machines plus public operators in that jurisdiction. Parsed by @opennodes/core.
const LOCAL_TTL = 30_000, PUBLIC_TTL = 60_000;
const VERSION = '0.1.0';
// Ollama clients slice digest[:12] for display: synthesized entries need a real-looking one.
const digestOf = (name) => createHash('sha256').update(name).digest('hex');
const STARTED_AT = new Date().toISOString();
// Ollama clients read failures as {"error": "..."}; problem+json would show as an empty message.
const oerr = (res, status, msg) => sendJson(res, status, { error: msg });

export async function startOllamaRouter({
  port = 11435, host = '127.0.0.1',
  ollama = 'http://127.0.0.1:11434',
  peers = [],                 // origins of LAN Ollama servers or ONP nodes
  registry = null,            // OpenNodes registry URL for the public tier (null = LAN only)
  policy = {},                // { min_tier: 'community', max_request_usd: 0.05, region, sensitive }
  trustedJurisdictions = trustedJurisdictionsFrom(),   // operators of the trusted pool (ONP_TRUSTED_JURISDICTIONS, default EU,CA)
  keys = {},                  // BYOK upstream credentials by hostname (imported catalogs)
  ledgerPath = null,
  reputationPath = null,      // passive reputation of each offering, from real calls (null = this run only)
  mdns = true,
  log = console.log,
  // PII masking (docs/pii-masking.md): 'open' (default; ONP_MASK_PII) masks requests to open-pool public
  // offerings, 'all' every public one, 'off' none; local and LAN models never. Detection: the rules,
  // plus a local Presidio service (piiService, ONP_PII_SERVICE) and a local model (piiLlm, ONP_PII_LLM).
  maskPii = null, piiService = null, piiLlm = null, piiDetector = null,
} = {}) {
  const pol = { min_tier: 'community', max_request_usd: 0.05, sensitive: false, ...policy };
  const maskMode = parseMaskMode(maskPii ?? process.env.ONP_MASK_PII, 'open');
  const detector = piiDetector ?? piiDetectorFrom({ service: piiService, llm: piiLlm });
  // Sensitive requests (policy.sensitive, the onp-sensitive header, or auto-sensitive) use the trusted pool only.
  const trusted = trustedView(trustedJurisdictions);
  const sensitiveOf = (req, name) => Boolean(pol.sensitive) || sensitiveHeader(req.headers) || Boolean(parseAutoModel(name)?.sensitive);
  const client = registry ? new OnpClient({ registry }) : null;
  const jwksCache = new Map();
  const receipts = [];
  const peerMap = new Map();  // origin -> { kind, origin, name, card? }
  let localCache = { at: 0, entries: [] };
  let publicCache = { at: 0, entries: [] };
  let lastAdvice = null;
  const reputation = new Reputation(reputationPath);

  /* ------------------------------------------------------------ catalogs */

  async function ollamaEntries(origin, tier, prefix) {
    const res = await fetch(`${origin}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`${origin}/api/tags -> ${res.status}`);
    const { models = [] } = await res.json();
    return Promise.all(models.map(async (m) => {
      let show = {};
      try {
        const r = await fetch(`${origin}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.name }), signal: AbortSignal.timeout(5_000) });
        if (r.ok) show = await r.json();
      } catch { /* details optional */ }
      const params = parseParamsB(m.details?.parameter_size);
      return {
        name: prefix ? `${prefix}/${m.name}` : m.name, tier, kind: 'ollama', origin, upstreamModel: m.name,
        tag: m, show,
        offering: {
          node_id: tier === 'local' ? 'local' : prefix.slice(4), offering_id: m.name, tier, source: tier,
          card_revision: 'local', modality: m.details?.families?.includes('clip') || m.details?.families?.includes('mllama') ? 'multimodal' : 'text',
          model: { name: m.name, artifact: `ollama:${m.name}`, family: m.details?.family, params_b: params, quantization: m.details?.quantization_level },
          serving: { context_window: contextFromModelInfo(show.model_info) ?? 8192, supports: capabilitiesToSupports(show.capabilities), languages: [] },
          binding: { profile: 'ollama/v1', model_id: m.name },
          pricing: { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0, schemes: ['free'] },
          data_policy: { retention: 'none', training_on_inputs: false, region_pinning: [] },
          observed: { probe_success: 1, probes: 0, ttft_ms: null, tps: null, availability: null },
          endpoints: { openai: `${origin}/v1` }, local: { run: `ollama run ${m.name}` },
        },
      };
    }));
  }

  function onpPeerEntries(peer) {
    const card = peer.card;
    return (card.offerings ?? []).filter((o) => o.modality === 'text' || o.modality === 'multimodal').map((o) => ({
      name: `lan/${peer.name}/${o.offering_id}`, tier: 'lan', kind: 'onp', origin: peer.origin, upstreamModel: o.binding.model_id,
      offering: {
        node_id: card.node.id, offering_id: o.offering_id, tier: 'lan', source: 'lan', card_revision: card.revision,
        modality: o.modality, model: o.model, serving: o.serving, binding: o.binding,
        pricing: { ...o.pricing, input_per_mtok: 0, output_per_mtok: 0 },   // LAN: no money moves; receipts still account usage
        data_policy: o.data_policy ?? { retention: 'none', training_on_inputs: false }, hardware: o.hardware ?? card.hardware ?? null,
        observed: { probe_success: 1, probes: 0 }, endpoints: card.endpoints, lan_pricing: o.pricing,
      },
    }));
  }

  async function localEntries() {
    if (Date.now() - localCache.at < LOCAL_TTL) return localCache.entries;
    const entries = [];
    try { entries.push(...await ollamaEntries(ollama, 'local', '')); }
    catch (err) { log(`[onp-ollama] local Ollama unreachable at ${ollama}: ${err.message}`); }
    for (const peer of peerMap.values()) {
      try {
        if (peer.kind === 'ollama') entries.push(...await ollamaEntries(peer.origin, 'lan', `lan/${peer.name}`));
        else entries.push(...onpPeerEntries(peer));
      } catch (err) { log(`[onp-ollama] peer ${peer.origin} unreachable: ${err.message}`); }
    }
    localCache = { at: Date.now(), entries };
    return entries;
  }

  async function publicEntries() {
    if (!client) return [];
    if (Date.now() - publicCache.at < PUBLIC_TTL) return publicCache.entries;
    let entries = [];
    try {
      const offerings = await client.search({ tier: pol.min_tier, limit: 200 });
      entries = offerings.filter((o) => o.modality === 'text' || o.modality === 'multimodal').map((o) => ({
        name: `onp/${o.node_id}/${o.offering_id}`, tier: 'public', kind: 'onp', origin: new URL(o.endpoints.openai).origin,
        upstreamModel: o.binding.model_id, offering: o,
      }));
    } catch (err) { log(`[onp-ollama] registry unreachable at ${registry}: ${err.message}`); }
    publicCache = { at: Date.now(), entries };
    return entries;
  }

  async function catalog() { return [...await localEntries(), ...await publicEntries()]; }

  async function addPeer(origin) {
    const peer = await probePeer(origin);
    if (!peer) { log(`[onp-ollama] peer ${origin}: neither an ONP node nor an Ollama server`); return null; }
    peerMap.set(peer.origin, peer);
    localCache.at = 0;
    log(`[onp-ollama] peer ${peer.name} (${peer.kind}) at ${peer.origin}`);
    return peer;
  }

  /* ------------------------------------------------------------ routing */

  const lastUserText = (messages = []) => {
    const last = [...messages].reverse().find((m) => m.role === 'user');
    return typeof last?.content === 'string' ? last.content : (last?.content ?? []).map((p) => p.text ?? '').join(' ');
  };

  /** Resolve a requested model name to an ordered list of catalog entries. */
  async function resolve(name, { messages = [], prompt = null, maxTokens = null, request = null, sensitive = false } = {}) {
    const auto = parseAutoModel(name);
    if (auto) {
      const { preset } = auto;
      sensitive ||= Boolean(auto.sensitive);
      const text = prompt ?? lastUserText(messages);
      const features = extractFeatures(text, { messages: prompt ? [] : messages.slice(0, -1), est_output_tokens: maxTokens, request });
      const pool = preset === 'private' ? await localEntries() : await catalog();
      const result = recommend(reputation.apply(pool.map((e) => e.offering)), features, {
        preset, limit: 5, prefer_local: true, max_total_usd: pol.max_request_usd, region: pol.region,
        jurisdiction: auto.jurisdiction ?? pol.jurisdiction,
        sensitive, trusted,
      });
      const byKey = new Map(pool.map((e) => [`${e.offering.node_id}/${e.offering.offering_id}`, e]));
      const chosen = result.recommendations.map((r) => byKey.get(r.offering)).filter(Boolean);
      lastAdvice = { model: name, features, ...(sensitive ? { sensitive: true, trusted_view: trusted } : {}), recommendations: result.recommendations.map((r) => { const seen = reputation.describe(r.offering); return { offering: r.offering, tier: r.tier, score: r.score, reasons: seen ? [...r.reasons, seen] : r.reasons }; }) };
      return chosen;
    }
    const all = await catalog();
    const exact = all.find((e) => e.name === name) ?? all.find((e) => e.name === `${name}:latest`);
    if (exact) return [exact];
    // A bare model name not present locally: fall through to a LAN copy of the same model.
    const lanCopy = all.find((e) => e.tier === 'lan' && e.kind === 'ollama' && (e.upstreamModel === name || e.upstreamModel === `${name}:latest`));
    return lanCopy ? [lanCopy] : [];
  }

  function checkBudget(entry, body) {
    if (entry.tier !== 'public') return null;
    const text = JSON.stringify(body.messages ?? body.prompt ?? '');
    const bounds = estimateBounds(entry.offering.pricing, Math.ceil(text.length / 4), body.options?.num_predict ?? body.max_tokens ?? 1024);
    return bounds.max > pol.max_request_usd ? `estimated up to $${bounds.max} exceeds max_request_usd ${pol.max_request_usd}` : null;
  }

  async function verifyReceipt(entry, receiptJws) {
    if (receiptJws.startsWith('http')) {
      // Published by URL once a stream ends: only from the node's own origin, brief retry while it materializes.
      if (new URL(receiptJws).origin !== new URL(entry.offering.endpoints.openai).origin) throw new Error(`receipt URL outside the node's origin: ${receiptJws}`);
      for (let i = 0; ; i++) {
        const r = await fetch(receiptJws, { signal: AbortSignal.timeout(10_000) });
        if (r.ok) { receiptJws = (await r.text()).trim(); break; }
        if (r.status !== 404 || i >= 4) throw new Error(`receipt ${r.status}`);
        await new Promise((ok) => setTimeout(ok, 250 * (i + 1)));
      }
    }
    const origin = entry.origin;
    if (!jwksCache.has(origin)) jwksCache.set(origin, await (await fetch(`${origin}/.well-known/jwks.json`)).json());
    const receipt = verifyJws(receiptJws, keyFromJwk(jwksCache.get(origin).keys[0]));
    const pricing = entry.offering.lan_pricing ?? entry.offering.pricing;
    const expected = costForUsage(pricing, receipt.usage.prompt_tokens, receipt.usage.completion_tokens);
    if (round6(receipt.amount.value) !== round6(expected)) throw new Error('receipt amount mismatch');
    return receipt;
  }

  function record(entry, requested, receipt, latencyMs, extra = {}) {
    const row = {
      ts: new Date().toISOString(), model: requested, tier: entry.tier, offering: entry.name,
      receipt_id: receipt?.receipt_id ?? null, cost: entry.tier === 'public' ? (receipt?.amount.value ?? null) : 0,
      currency: receipt?.amount.currency ?? 'USD', usage: receipt?.usage ?? extra.usage ?? null, latency_ms: latencyMs,
      ...(extra.pii_masked ? { pii_masked: extra.pii_masked } : {}),   // types and counts only
    };
    receipts.push(row);
    if (ledgerPath) appendFileSync(ledgerPath, JSON.stringify(row) + '\n');
    log(`[onp-ollama] ${requested} -> ${entry.name} (${entry.tier}) ${row.cost != null ? '$' + row.cost : ''} ${latencyMs}ms`);
  }

  /* ------------------------------------------------------------ upstream calls */

  /** ONP node (public or LAN): OpenAI request with pinned headers; returns the fetch Response. */
  async function onpFetch(entry, openaiBody) {
    const o = entry.offering;
    const upstreamKey = keys[new URL(o.endpoints.openai).hostname];
    // Move on to the next candidate if this node hasn't started answering within a budget built
    // from its measured latency and the request size. LAN nodes are rarely measured: longer floor.
    const { models: _fallbacks, ...forwarded } = openaiBody;
    const budgetMs = responseBudgetMs(o, {
      stream: Boolean(openaiBody.stream),
      promptTokens: Math.ceil(JSON.stringify(openaiBody.messages ?? openaiBody.prompt ?? '').length / 4),
      maxTokens: openaiBody.max_tokens ?? openaiBody.max_completion_tokens ?? 512,
      ...(entry.tier === 'public' ? {} : { floorMs: 60_000, ceilMs: 300_000 }),
    });
    const res = await fetchWithin(`${o.endpoints.openai}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(entry.tier === 'public' || entry.kind === 'onp' ? { 'onp-offering': `${o.node_id}/${o.offering_id}`, 'onp-card-revision': o.card_revision } : {}),
        ...(upstreamKey ? { authorization: `Bearer ${upstreamKey}` } : {}),
      },
      body: JSON.stringify({ ...forwarded, model: entry.upstreamModel }),
    }, budgetMs);
    return res;
  }

  /**
   * PII masking for one request: `masked(entry)` is the masked OpenAI body for an entry that needs it, or
   * null; a refusal (detection failed, an image to the open pool) is returned as { refused } instead.
   * Detection runs once per request, on the first entry that needs it.
   */
  function piiFor(req, openaiBody) {
    const mode = maskModeOf(req.headers, maskMode);   // a header can strengthen it, never weaken it
    const mask = oncePerRequest(() => maskChatRequest(openaiBody(), { detector }));
    return async (entry) => {
      try { return { masked: await maskedRequestFor(entry.offering ?? {}, { mode, view: trusted, mask }) }; }
      catch (err) { return { refused: { failed: err.message.replace(/^policy: /, ''), policy: true, refused: true } }; }
    };
  }

  /** Ollama-native request through an ONP node, translated both ways. mode: chat | generate. */
  async function viaOnp(entry, body, res, requested, mode, pii = null) {
    const t0 = performance.now();
    const openaiBody = mode === 'chat' ? ollamaChatToOpenAI(body, entry.upstreamModel) : ollamaGenerateToOpenAI(body, entry.upstreamModel);
    const { masked = null, refused } = pii ? await pii(entry) : {};
    if (refused) return refused;
    const upstream = await onpFetch(entry, masked?.body ?? openaiBody);   // onpFetch sets the model
    const firstMs = Math.round(performance.now() - t0);
    if (!upstream.ok) return { failed: `upstream ${upstream.status}: ${(await upstream.text()).slice(0, 200)}` };
    const receiptHeader = upstream.headers.get('onp-receipt');
    const chunker = new OllamaChunker({ model: requested, mode, startedAt: t0 });
    const stream = body.stream !== false;
    const unmasker = masked?.vault.size ? createSseUnmasker(masked.vault) : null;
    if (stream) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson', ...piiMaskedHeader(masked) });
      const write = (chunk) => { const delta = chunker.take(chunk); if (delta) res.write(JSON.stringify(delta) + '\n'); };
      for await (const chunk of parseSse(upstream.body)) write(unmasker ? unmasker.chunk(chunk) : chunk);
      const held = unmasker?.close();   // a placeholder still held when the stream ended
      if (held) write(held);
    } else {
      const completion = unmaskCompletion(await upstream.json(), masked?.vault);
      chunker.take({ choices: [{ message: completion.choices?.[0]?.message ?? {}, finish_reason: completion.choices?.[0]?.finish_reason }], usage: completion.usage });
    }
    let receipt = null;
    try { if (receiptHeader) receipt = await verifyReceipt(entry, receiptHeader); }
    catch (err) { log(`[onp-ollama] receipt verification failed for ${entry.name}: ${err.message}`); }
    const counts = { promptTokens: receipt?.usage.prompt_tokens, completionTokens: receipt?.usage.completion_tokens };
    if (stream) { res.end(JSON.stringify(chunker.final(counts)) + '\n'); }
    else sendJson(res, 200, chunker.whole(counts), piiMaskedHeader(masked));
    record(entry, requested, receipt, Math.round(performance.now() - t0), { usage: chunker.usage, pii_masked: masked?.counts });
    return { done: true, ...(stream ? { first_ms: firstMs } : {}) };
  }

  /** Ollama-native request passed through to an Ollama server (local or LAN), model name rewritten. */
  async function viaOllama(entry, body, res, requested, path) {
    const t0 = performance.now();
    const upstream = await fetch(`${entry.origin}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, model: entry.upstreamModel }), signal: AbortSignal.timeout(600_000),
    });
    const firstMs = Math.round(performance.now() - t0);
    if (!upstream.ok) return { failed: `upstream ${upstream.status}: ${(await upstream.text()).slice(0, 200)}` };
    let usage = null;
    if (body.stream !== false) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for await (const obj of parseNdjson(upstream.body)) {
        if (obj.done) usage = { prompt_tokens: obj.prompt_eval_count ?? 0, completion_tokens: obj.eval_count ?? 0 };
        res.write(JSON.stringify({ ...obj, model: requested }) + '\n');
      }
      res.end();
    } else {
      const obj = await upstream.json();
      usage = { prompt_tokens: obj.prompt_eval_count ?? 0, completion_tokens: obj.eval_count ?? 0 };
      sendJson(res, 200, { ...obj, model: requested });
    }
    record(entry, requested, null, Math.round(performance.now() - t0), { usage });
    return { done: true, ...(body.stream !== false ? { first_ms: firstMs } : {}) };
  }

  /**
   * Try candidates in order; the first that answers wins. A sensitive request goes only to entries in
   * the trusted pool: the others are refused before anything is sent.
   */
  async function dispatch(res, requested, candidates, attemptFn, { sensitive = false } = {}) {
    if (!candidates.length) {
      return sensitive && parseAutoModel(requested)
        ? oerr(res, 404, `the request is sensitive and no model here is in the trusted pool (${trusted.jurisdictions} operators, declared lineage without CN, verified+, no retention, no training); it was not sent anywhere`)
        : oerr(res, 404, `model '${requested}' not found locally, on the LAN, or in the registry`);
    }
    const errors = [];
    let refused = 0;
    for (const entry of candidates) {
      const id = entry.offering ? `${entry.offering.node_id}/${entry.offering.offering_id}` : entry.name;
      const t0 = performance.now();
      const ms = () => Math.round(performance.now() - t0);
      const gaps = sensitive ? trustGaps(entry.offering ?? {}, trusted) : [];
      if (gaps.length) { refused++; errors.push(`${entry.name}: open pool, the request is sensitive (${gaps.join('; ')})`); continue; }
      try {
        const r = await attemptFn(entry);
        if (r.done) { reputation.record(id, { ok: true, ms: ms(), first_ms: r.first_ms }); return; }
        if (r.refused) refused++;   // not sent: PII masking could not make it safe for this entry
        if (!r.policy) reputation.record(id, { ok: false, ms: ms(), why: r.failed });
        errors.push(`${entry.name}: ${r.failed}`);
      } catch (err) { reputation.record(id, { ok: false, ms: ms(), why: err.message }); errors.push(`${entry.name}: ${err.message}`); }
      if (res.headersSent) return;   // a stream started and broke: nothing more we can send
    }
    if (refused === candidates.length) return oerr(res, 403, `refused: ${errors.join(' | ')}`);
    oerr(res, 502, `all candidates failed: ${errors.join(' | ')}`);
  }

  /* ------------------------------------------------------------ Ollama-shaped views */

  function tagFor(e) {
    const o = e.offering;
    const params = o.model?.params_b;
    if (e.kind === 'ollama' && e.tag) return { ...e.tag, name: e.name, model: e.name, onp: { tier: e.tier, origin: e.origin } };
    return {
      name: e.name, model: e.name, modified_at: /^\d{4}-/.test(o.card_revision ?? '') ? o.card_revision : STARTED_AT, size: 0, digest: digestOf(e.name),
      details: { parent_model: '', format: 'onp', family: o.model?.family ?? '', families: o.model?.family ? [o.model.family] : [],
        parameter_size: params ? `${params}B` : '', quantization_level: o.model?.quantization ?? '' },
      onp: { tier: e.tier, node_id: o.node_id, offering_id: o.offering_id, price_per_mtok: { input: o.pricing?.input_per_mtok ?? 0, output: o.pricing?.output_per_mtok ?? 0 },
        hardware: o.hardware ?? null, measured: { ttft_ms: o.observed?.ttft_ms?.p50 ?? null, tps: o.observed?.tps ?? null }, context: o.serving?.context_window ?? null },
    };
  }
  const autoNote = (name) => {
    const a = parseAutoModel(name);
    if (a?.preset === 'private') return 'routes only to local and LAN models';
    if (a?.sensitive) return `for personal data: routes only to the trusted pool (${trusted.jurisdictions} operators, declared lineage without CN, verified+, no retention, no training)`;
    if (a?.jurisdiction) return `routes to local, LAN and ${a.jurisdiction === 'eea' ? 'EU/EEA' : a.jurisdiction} operators only`;
    return 'routes by the OpenNodes advisor';
  };
  const autoTag = (name) => ({
    name, model: name, modified_at: STARTED_AT, size: 0, digest: digestOf(name),
    details: { parent_model: '', format: 'onp', family: 'advisor', families: ['advisor'], parameter_size: '', quantization_level: '' },
    onp: { tier: 'advisor', note: autoNote(name) },
  });
  const autoTags = () => AUTO_MODEL_NAMES.map(autoTag);

  async function proxyLocal(req, res, path) {
    const body = req.method === 'GET' ? undefined : await readJson(req, 50_000_000);
    const upstream = await fetch(`${ollama}${path}`, { method: req.method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(600_000) });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    if (upstream.body) await new Promise((resolve, reject) => { const s = Readable.fromWeb(upstream.body); s.pipe(res); s.on('end', resolve); s.on('error', reject); });
    else res.end();
  }

  /* ------------------------------------------------------------ routes */

  const app = createApp([
    ['GET', '/', (req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Ollama is running (OpenNodes router)'); }],
    ['HEAD', '/', (req, res) => { res.writeHead(200); res.end(); }],   // Ollama CLI heartbeat
    ['GET', '/api/version', (req, res) => sendJson(res, 200, { version: `0.34.0-onp.${VERSION}` })],
    ['GET', '/api/tags', async (req, res) => sendJson(res, 200, { models: [...autoTags(), ...(await catalog()).map(tagFor)] })],
    ['GET', '/api/ps', (req, res) => proxyLocal(req, res, '/api/ps')],

    ['POST', '/api/show', async (req, res) => {
      const body = await readJson(req);
      const name = body.model ?? body.name;
      const [entry] = await resolve(name);
      if (!entry) return parseAutoModel(name)
        ? sendJson(res, 200, { modelfile: '', parameters: '', template: '', details: autoTag(name).details, capabilities: ['completion', 'tools'], model_info: {} })
        : oerr(res, 404, `model '${name}' not found`);
      if (entry.kind === 'ollama') {
        const r = await fetch(`${entry.origin}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: entry.upstreamModel, verbose: body.verbose ?? false }) });
        return sendJson(res, r.status, await r.json());
      }
      const o = entry.offering;
      const caps = ['completion', ...(o.serving?.supports?.includes('tool_calls') ? ['tools'] : []), ...(o.serving?.supports?.includes('vision') ? ['vision'] : [])];
      sendJson(res, 200, { modelfile: `# OpenNodes offering ${o.node_id}/${o.offering_id}`, parameters: '', template: '', details: tagFor(entry).details,
        model_info: { 'general.architecture': o.model?.family ?? 'unknown', 'onp.context_length': o.serving?.context_window ?? null },
        capabilities: caps, onp: tagFor(entry).onp });
    }],

    ['POST', '/api/chat', async (req, res) => {
      const body = await readJson(req, 50_000_000);
      const sensitive = sensitiveOf(req, body.model);
      let pii;
      try { pii = piiFor(req, () => ollamaChatToOpenAI(body, '')); } catch (err) { return oerr(res, 400, err.message); }
      const candidates = await resolve(body.model, { messages: body.messages, maxTokens: body.options?.num_predict, request: { tools: body.tools, json: Boolean(body.format) }, sensitive });
      await dispatch(res, body.model, candidates, async (entry) => {
        const over = checkBudget(entry, body); if (over) return { failed: over, policy: true };
        return entry.kind === 'ollama' ? viaOllama(entry, body, res, body.model, '/api/chat') : viaOnp(entry, body, res, body.model, 'chat', pii);
      }, { sensitive });
    }],

    ['POST', '/api/generate', async (req, res) => {
      const body = await readJson(req, 50_000_000);
      const sensitive = sensitiveOf(req, body.model);
      let pii;
      try { pii = piiFor(req, () => ollamaGenerateToOpenAI(body, '')); } catch (err) { return oerr(res, 400, err.message); }
      const candidates = await resolve(body.model, { prompt: body.prompt ?? '', maxTokens: body.options?.num_predict, request: { tools: [], json: Boolean(body.format) }, sensitive });
      await dispatch(res, body.model, candidates, async (entry) => {
        const over = checkBudget(entry, body); if (over) return { failed: over, policy: true };
        return entry.kind === 'ollama' ? viaOllama(entry, body, res, body.model, '/api/generate') : viaOnp(entry, body, res, body.model, 'generate', pii);
      }, { sensitive });
    }],

    // Local-only Ollama operations (model management, embeddings).
    ...['/api/embed', '/api/embeddings', '/api/pull', '/api/push', '/api/create', '/api/copy'].map((p) => ['POST', p, (req, res) => proxyLocal(req, res, p)]),
    ['DELETE', '/api/delete', (req, res) => proxyLocal(req, res, '/api/delete')],

    // OpenAI-compatible surface.
    ['GET', '/v1/models', async (req, res) => sendJson(res, 200, { object: 'list', data: [...AUTO_MODEL_NAMES, ...(await catalog()).map((e) => e.name)].map((id) => ({ id, object: 'model', owned_by: 'opennodes-ollama-router' })) })],
    ['POST', '/v1/chat/completions', async (req, res) => {
      const body = await readJson(req, 50_000_000);
      const sensitive = sensitiveOf(req, body.model);
      const want = { messages: body.messages, maxTokens: body.max_tokens, request: { tools: body.tools, json: ['json_object', 'json_schema'].includes(body.response_format?.type) }, sensitive };
      const candidates = await resolve(body.model, want);
      // OpenRouter-compatible fallback list: `models: [...]` adds further models to try, in order.
      if (Array.isArray(body.models)) {
        const keyOf = (e) => `${e.tier}|${e.origin ?? ''}|${e.offering ? `${e.offering.node_id}/${e.offering.offering_id}` : e.name}`;
        const seen = new Set(candidates.map(keyOf));
        for (const m of body.models.slice(0, 10)) {
          if (typeof m !== 'string' || m === body.model) continue;
          for (const e of await resolve(m, want)) if (!seen.has(keyOf(e))) { seen.add(keyOf(e)); candidates.push(e); }
        }
      }
      const { models: _fallbacks, ...forwarded } = body;
      let pii;
      try { pii = piiFor(req, () => forwarded); } catch (err) { return oerr(res, 400, err.message); }
      await dispatch(res, body.model, candidates, async (entry) => {
        const over = checkBudget(entry, body); if (over) return { failed: over, policy: true };
        const { masked = null, refused } = entry.kind === 'ollama' ? {} : await pii(entry);   // your own Ollama servers: never masked
        if (refused) return refused;
        const t0 = performance.now();
        const upstream = entry.kind === 'ollama'
          ? await fetch(`${entry.origin}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...forwarded, model: entry.upstreamModel }), signal: AbortSignal.timeout(600_000) })
          : await onpFetch(entry, masked?.body ?? forwarded);
        const firstMs = Math.round(performance.now() - t0);
        if (!upstream.ok) return { failed: `upstream ${upstream.status}` };
        const receiptHeader = upstream.headers.get('onp-receipt');
        res.writeHead(200, { 'content-type': upstream.headers.get('content-type') ?? 'application/json', ...piiMaskedHeader(masked) });
        if (masked?.vault.size && body.stream) {   // values put back as the answer arrives
          for await (const text of unmaskSse(upstream.body, masked.vault)) res.write(text);
          res.end();
        } else if (masked?.vault.size) {
          res.end(JSON.stringify(unmaskCompletion(await upstream.json(), masked.vault)));
        } else await new Promise((resolve, reject) => { const s = Readable.fromWeb(upstream.body); s.pipe(res); s.on('end', resolve); s.on('error', reject); });
        let receipt = null;
        try { if (receiptHeader) receipt = await verifyReceipt(entry, receiptHeader); } catch (err) { log(`[onp-ollama] receipt: ${err.message}`); }
        record(entry, body.model, receipt, Math.round(performance.now() - t0), { pii_masked: masked?.counts });
        return { done: true, ...(body.stream ? { first_ms: firstMs } : {}) };
      }, { sensitive });
    }],

    // Router introspection.
    ['GET', '/router/catalog', async (req, res) => sendJson(res, 200, { local_ollama: ollama, peers: [...peerMap.values()].map((p) => ({ name: p.name, kind: p.kind, origin: p.origin })), registry, policy: pol, trusted_view: trusted, pii_masking: { mode: maskMode, detector: detector.name }, models: (await catalog()).map((e) => ({ name: e.name, tier: e.tier, kind: e.kind, origin: e.origin, pool: trustGaps(e.offering ?? {}, trusted).length ? 'open' : 'trusted' })) })],
    ['GET', '/router/advice', (req, res) => sendJson(res, 200, lastAdvice ?? { model: null, recommendations: [] })],
    ['GET', '/router/reputation', (req, res) => sendJson(res, 200, { note: 'outcome and timing of your own calls through this router; no prompts or answers are kept', offerings: reputation.report() })],
    ['GET', '/router/receipts', (req, res) => sendJson(res, 200, { total_cost: round6(receipts.reduce((s, r) => s + (r.cost ?? 0), 0)), count: receipts.length, entries: receipts.slice(-100) })],
    ['POST', '/router/peers', async (req, res) => { const { origin } = await readJson(req); const peer = await addPeer(String(origin)); peer ? sendJson(res, 200, { name: peer.name, kind: peer.kind, origin: peer.origin }) : oerr(res, 422, `peer unreachable: ${origin}`); }],
  ], { cors: true });

  for (const origin of peers) await addPeer(origin);
  const stopMdns = mdns ? await browseMdns((origin) => { addPeer(origin); }) : () => {};

  const actualPort = await listen(app, port, host);
  return {
    port: actualPort, origin: `http://${host}:${actualPort}`, receipts, addPeer,
    pii: { mode: maskMode, detector: detector.name },   // PII masking before the open pool
    get peers() { return [...peerMap.values()]; },
    reputation,
    close: async () => { stopMdns(); reputation.flush(); await closeApp(app); },
  };
}
