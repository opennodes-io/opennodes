// Fixture AI Node: a conforming ONP node serving a deterministic echo model.
// Used by e2e tests and as the reference target for registry Stage A probes.
import { randomUUID, createHash } from 'node:crypto';
import {
  createApp, listen, closeApp, sendJson, problem, readJson,
  generateKeypair, signCard, signJson, validateCard, costForUsage,
} from '@opennodes/core';

const MODEL_ID = 'onp-echo-1';

function buildCard(origin, revision, claimContextTokens = 8192) {
  return {
    onp: '0.1',
    revision,
    node: {
      id: 'org.opennodes.fixture',
      name: 'OpenNodes Fixture Node',
      description: 'Deterministic echo model for conformance testing.',
      operator: { name: 'OpenNodes Project', country: 'DE' },
      regions: ['eu-central'],
    },
    endpoints: {
      openai: `${origin}/v1`,
      health: `${origin}/onp/health`,
    },
    offerings: [{
      offering_id: 'echo-1',
      modality: 'text',
      model: { name: 'Echo 1', family: 'echo', artifact: 'urn:proprietary:opennodes:echo-1', params_b: 0.001 },
      serving: {
        context_window: claimContextTokens,
        max_output_tokens: 2048,
        supports: ['streaming', 'json_mode'],
        languages: [{ lang: 'en', grade: 'native' }],
      },
      binding: { profile: 'onp.openai.chat/v1', model_id: MODEL_ID },
      pricing: { currency: 'USD', input_per_mtok: 0.10, output_per_mtok: 0.40, schemes: ['free', 'prepaid'] },
      availability: { sla: 0.99, interruptible: false },
      data_policy: { retention: 'none', training_on_inputs: false, region_pinning: ['eu'] },
    }],
    payment: {
      schemes: [{ scheme: 'free' }, { scheme: 'prepaid', signup: `${origin}/signup` }],
      probe_allowance: { requests_per_day: 200 },
    },
  };
}

const approxTokens = (text) => Math.max(1, Math.ceil(text.length / 4));

/** Start a fixture node. Returns { port, origin, setChallenge, card, keys, close }. */
export async function startFixtureNode({
  port = 0, host = '127.0.0.1', acceptAnyChallenge = false,
  realContextTokens = 8192,          // what the model can actually retrieve from
  claimContextTokens = null,         // what the card claims (null = honest)
  impersonate = false,               // serve different outputs under the same artifact claim
} = {}) {
  const keys = generateKeypair();
  const state = { challenges: new Map(), card: null, origin: null, requests: 0 };

  const makeReceipt = (offering, usage, requestBody, pinnedRevision) => signJson({
    receipt_id: `r_${randomUUID()}`,
    node_id: 'org.opennodes.fixture',
    offering_id: offering.offering_id,
    card_revision: pinnedRevision ?? state.card.revision,
    request_hash: 'sha256:' + createHash('sha256').update(JSON.stringify(requestBody)).digest('hex'),
    usage,
    amount: { currency: offering.pricing.currency, value: costForUsage(offering.pricing, usage.prompt_tokens, usage.completion_tokens) },
    scheme: 'free',
    issued_at: new Date().toISOString(),
  }, keys.privateKey);

  const app = createApp([
    ['GET', '/.well-known/open-node.json', (req, res) => {
      res.writeHead(200, { 'content-type': 'application/open-node+json', 'cache-control': 'max-age=60' });
      res.end(JSON.stringify(state.card));
    }],
    ['GET', '/.well-known/jwks.json', (req, res) => {
      sendJson(res, 200, { keys: [{ ...keys.publicJwk, kid: 'onp-1' }] });
    }],
    ['GET', '/.well-known/onp-challenge/:token', (req, res, { params }) => {
      if (acceptAnyChallenge || state.challenges.has(params.token)) sendJson(res, 200, { token: params.token });
      else problem(res, 404, 'unknown-challenge', params.token);
    }],
    ['GET', '/onp/health', (req, res) => {
      sendJson(res, 200, { status: 'ok', load: 0.1, queue_ms: 5 });
    }],
    ['GET', '/v1/models', (req, res) => {
      sendJson(res, 200, { object: 'list', data: [{ id: MODEL_ID, object: 'model', owned_by: 'org.opennodes.fixture' }] });
    }],
    ['POST', '/v1/chat/completions', async (req, res) => {
      const body = await readJson(req);
      if (body.model !== MODEL_ID) return problem(res, 404, 'model-not-found', String(body.model));

      const offering = state.card.offerings[0];
      const offeringHeader = req.headers['onp-offering'];
      if (offeringHeader && offeringHeader !== `org.opennodes.fixture/${offering.offering_id}`) {
        return problem(res, 409, 'offering-mismatch', offeringHeader);
      }
      const pinned = req.headers['onp-card-revision'];
      if (pinned && pinned !== state.card.revision) {
        return problem(res, 409, 'price_changed', `pinned ${pinned}, current ${state.card.revision}`);
      }

      state.requests++;
      state.lastAuth = req.headers.authorization ?? null;
      const prompt = (body.messages ?? []).map((m) => typeof m.content === 'string' ? m.content : '').join('\n');
      // The model only "sees" its real context window; text beyond it is invisible.
      const visible = prompt.slice(0, realContextTokens * 4);
      const prefix = impersonate ? 'mimic:' : 'echo:';
      const needle = visible.match(/NEEDLE:\d+/);
      const reply = needle
        ? `${prefix} the needle token is ${needle[0]}`
        : `${prefix} ${visible.slice(0, 500)}`;
      const usage = {
        prompt_tokens: approxTokens(prompt),
        completion_tokens: approxTokens(reply),
      };
      usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
      const receipt = makeReceipt(offering, usage, body, pinned);
      const completion = {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: MODEL_ID,
        choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }],
        usage,
      };

      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'onp-receipt': receipt });
        const chunk = (delta, extra = {}) => res.write(`data: ${JSON.stringify({
          id: completion.id, object: 'chat.completion.chunk', model: MODEL_ID,
          choices: [{ index: 0, delta, finish_reason: extra.finish ?? null }], ...extra.usage ? { usage } : {},
        })}\n\n`);
        chunk({ role: 'assistant', content: reply });
        chunk({}, { finish: 'stop', usage: true });
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        sendJson(res, 200, completion, { 'onp-receipt': receipt });
      }
    }],
  ], { cors: true }); // nodes SHOULD serve browser clients (registry playground, web agents)

  const actualPort = await listen(app, port, host);
  state.origin = `http://${host}:${actualPort}`;
  const unsigned = buildCard(state.origin, new Date().toISOString(), claimContextTokens ?? realContextTokens);
  const errors = validateCard(unsigned);
  if (errors.length) throw new Error('fixture card invalid: ' + errors.join('; '));
  state.card = signCard(unsigned, keys.privateKey);

  return {
    port: actualPort,
    origin: state.origin,
    keys,
    get card() { return state.card; },
    get requestCount() { return state.requests; },
    get lastAuth() { return state.lastAuth ?? null; },
    setChallenge: (token) => state.challenges.set(token, true),
    /** Publish a new revision (e.g. price change) — used to test 409 price_changed. */
    reprice: (outputPerMtok) => {
      const next = buildCard(state.origin, new Date(Date.now() + 1000).toISOString(), claimContextTokens ?? realContextTokens);
      next.offerings[0].pricing.output_per_mtok = outputPerMtok;
      state.card = signCard(next, keys.privateKey);
      return state.card.revision;
    },
    close: () => closeApp(app),
  };
}
