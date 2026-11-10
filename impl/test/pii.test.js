// PII masking before the open pool (core/src/pii.js, adapted from WebTester's Privacy/ masking):
// detectors, placeholders and the per-request vault, OpenAI request/answer/stream handling, and when
// a request is masked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createApp, listen, closeApp, sendJson, readJson, trustedView,
  regexDetector, sidecarDetector, llmDetector, compositeDetector, piiDetectorFrom, isLocalEndpoint, parseLlmPiiAnswer,
  PiiVault, mergeSpans, maskText, unmaskText, maskStrings, maskChatRequest, maskEmbeddingRequest, unmaskCompletion,
  createSseUnmasker, needsMasking, parseMaskMode, maskModeOf, strongerMaskMode, describeMaskCounts, normalizePiiType,
} from '@opennodes/core';

/** Finds fixed strings: stands in for Presidio, LLM Guard or a local model. */
const fixed = (...pairs) => ({
  name: 'fixed',
  async detect(text) {
    const out = [];
    for (const [v, type] of pairs) for (let i = text.indexOf(v); i >= 0; i = text.indexOf(v, i + 1)) out.push({ start: i, end: i + v.length, type, score: 1, source: 'fixed' });
    return out;
  },
});
const JANE = fixed(["Jane O'Neil", 'PERSON'], ['jane@example.org', 'EMAIL'], ['416-555-0199', 'PHONE']);

const found = async (text) => (await regexDetector().detect(text)).map((s) => [text.slice(s.start, s.end), s.type]);

test('regex: structured identifiers are found, with their type', async () => {
  assert.deepEqual(await found('Mail jane.doe+x@example.co.uk or call (416) 555-0199 / +44 20 7946 0958 / +380 44 123 4567'), [
    ['jane.doe+x@example.co.uk', 'EMAIL'], ['(416) 555-0199', 'PHONE'], ['+44 20 7946 0958', 'PHONE'], ['+380 44 123 4567', 'PHONE'],
  ]);
  assert.deepEqual(await found('Card 4111 1111 1111 1111, Amex 3782-822463-10005, IBAN DE89 3704 0044 0532 0130 00 and FR1420041010050500013M02606'), [
    ['4111 1111 1111 1111', 'CARD'], ['3782-822463-10005', 'CARD'], ['DE89 3704 0044 0532 0130 00', 'IBAN'], ['FR1420041010050500013M02606', 'IBAN'],
  ]);
  assert.deepEqual(await found('SIN 046-454-286, SSN 078-05-1120, postal M4G 3C5, host 81.2.69.160'), [
    ['046-454-286', 'ID'], ['078-05-1120', 'ID'], ['M4G 3C5', 'POSTAL'], ['81.2.69.160', 'IP'],
  ]);
  // WebTester's held-out form: born date and health card by their labels
  assert.deepEqual(await found('Tenant: Dmitri Volkov\nBorn: 1982-11-02\nHealth card no. 9876-543-210-XY\nPassport: X1234567'), [
    ['1982-11-02', 'DOB'], ['9876-543-210-XY', 'ID'], ['X1234567', 'ID'],
  ]);
  assert.deepEqual(await found('DOB 3 March 1990; date of birth: 03/04/1975'), [['3 March 1990', 'DOB'], ['03/04/1975', 'DOB']]);
});

test('regex: ordinary text is left alone', async () => {
  const text = [
    'colour #F3E5C0, ticket L-2024-00873, run 2026-11-10 at 10:14, ts 1731234567890, v1.2.3, port 8080',
    'card-like 4111 1111 1111 1112 (fails Luhn), IBAN-like DE00 3704 0044 0532 0130 00 (fails mod 97)',
    'servers 127.0.0.1, 10.0.0.5, 192.168.1.20, mask 255.255.255.0, account_id, sin(x), license MIT',
    'model llama-3.3-70b, 230 result(s), $1,234.56, B30117',
  ].join('\n');
  assert.deepEqual(await found(text), []);
});

test('placeholders: one per value across the request, and back again', async () => {
  const vault = new PiiVault();
  const text = "Applicant: Jane O'Neil (jane@example.org). Call Jane O'Neil at 416-555-0199.";
  const masked = maskText(text, await JANE.detect(text), vault);
  assert.equal(masked, 'Applicant: [[PERSON_1]] ([[EMAIL_1]]). Call [[PERSON_1]] at [[PHONE_1]].');
  assert.equal(unmaskText(masked, vault), text);
  assert.equal(maskText("Signed: Jane O'Neil", await JANE.detect("Signed: Jane O'Neil"), vault), 'Signed: [[PERSON_1]]');
  assert.deepEqual(vault.counts(), { PERSON: 1, EMAIL: 1, PHONE: 1 });
  assert.equal(describeMaskCounts(vault.counts()), 'EMAIL=1,PERSON=1,PHONE=1');
  assert.equal(unmaskText('unknown [[PERSON_9]] stays', vault), 'unknown [[PERSON_9]] stays');
});

test('placeholders already in the text are kept, never reused, never unmasked', async () => {
  const vault = new PiiVault();
  const [masked] = await maskStrings(['Template [[PERSON_1]] for Jane O\'Neil'], { detector: JANE, vault });
  assert.equal(masked, 'Template [[PERSON_1]] for [[PERSON_2]]');
  assert.equal(unmaskText(masked, vault), "Template [[PERSON_1]] for Jane O'Neil");
  // a detector that flags everything does not chew into a placeholder
  assert.equal(maskText('[[EMAIL_3]]', [{ start: 0, end: 11, type: 'ID', score: 1, source: 'greedy' }], new PiiVault()), '[[EMAIL_3]]');
});

test('masking: overlapping findings merge, spans stop at a line break and lose edge punctuation', () => {
  const spans = mergeSpans([
    { start: 10, end: 14, type: 'PERSON', score: 0.9, source: 'a' },
    { start: 10, end: 21, type: 'PERSON', score: 0.8, source: 'b' },
    { start: 40, end: 45, type: 'ID', score: 0.5, source: 'a' },
  ]);
  assert.deepEqual(spans.map((s) => [s.start, s.end, s.source]), [[10, 21, 'b+a'], [40, 45, 'a']]);
  const text = 'Name: "Robert Chen",\nMailing address';
  assert.equal(maskText(text, [{ start: 6, end: text.length, type: 'PERSON', score: 1, source: 'x' }], new PiiVault()), 'Name: "[[PERSON_1]]",\nMailing address');
});

test('a chat request is masked everywhere text can carry personal data; tools and settings are not', async () => {
  const body = {
    model: 'onp/auto', temperature: 0.2,
    tools: [{ type: 'function', function: { name: 'fill', description: 'Fill a form field', parameters: { type: 'object' } } }],
    messages: [
      { role: 'system', content: "You help Jane O'Neil." },
      { role: 'user', content: [{ type: 'text', text: 'Mail jane@example.org' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fill', arguments: JSON.stringify({ field: 'Phone', value: '416-555-0199' }) } }] },
      { role: 'tool', tool_call_id: 'c1', content: "Saved for Jane O'Neil" },
    ],
  };
  const { body: out, vault, counts, unmaskable } = await maskChatRequest(body, { detector: JANE });
  const sent = JSON.stringify(out);
  for (const v of ["Jane O'Neil", 'jane@example.org', '416-555-0199']) assert.ok(!sent.includes(v), `${v} was sent`);
  assert.equal(out.messages[0].content, 'You help [[PERSON_1]].');
  assert.equal(out.messages[1].content[0].text, 'Mail [[EMAIL_1]]');
  assert.deepEqual(JSON.parse(out.messages[2].tool_calls[0].function.arguments), { field: 'Phone', value: '[[PHONE_1]]' });
  assert.equal(out.messages[3].content, 'Saved for [[PERSON_1]]');
  assert.deepEqual(out.tools, body.tools);
  assert.equal(out.temperature, 0.2);
  assert.deepEqual(counts, { PERSON: 1, EMAIL: 1, PHONE: 1 });
  assert.deepEqual(unmaskable, ['image_url']);
  assert.equal(vault.size, 3);
  assert.equal(body.messages[0].content, "You help Jane O'Neil.", 'the caller\'s body is not changed');

  // nothing found: the arguments keep their exact bytes
  const plain = { messages: [{ role: 'assistant', tool_calls: [{ function: { name: 'f', arguments: '{ "a" : 1 }' } }] }] };
  assert.equal((await maskChatRequest(plain, { detector: JANE })).body.messages[0].tool_calls[0].function.arguments, '{ "a" : 1 }');
});

test('the answer gets the values back, and tool-call arguments stay valid JSON', async () => {
  const { vault } = await maskChatRequest({ messages: [{ role: 'user', content: "Jane O'Neil, jane@example.org" }] }, { detector: fixed(["Jane O'Neil", 'PERSON'], ['jane@example.org', 'EMAIL'], ['Say "hi"', 'PERSON']) });
  vault.placeholderFor('Say "hi"\\', 'PERSON');   // quotes and backslashes must be escaped inside JSON
  const completion = {
    id: 'x', choices: [{ index: 0, finish_reason: 'tool_calls', message: {
      role: 'assistant', content: 'Writing to [[PERSON_1]] at [[EMAIL_1]].', reasoning_content: 'user is [[PERSON_1]]',
      tool_calls: [{ id: 't', type: 'function', function: { name: 'send', arguments: '{"to":"[[EMAIL_1]]","name":"[[PERSON_1]]","note":"[[PERSON_2]]"}' } }],
    } }],
  };
  const out = unmaskCompletion(completion, vault);
  assert.equal(out.choices[0].message.content, "Writing to Jane O'Neil at jane@example.org.");
  assert.equal(out.choices[0].message.reasoning_content, "user is Jane O'Neil");
  assert.deepEqual(JSON.parse(out.choices[0].message.tool_calls[0].function.arguments), { to: 'jane@example.org', name: "Jane O'Neil", note: 'Say "hi"\\' });
  assert.equal(completion.choices[0].message.content, 'Writing to [[PERSON_1]] at [[EMAIL_1]].', 'the upstream object is not changed');
});

test('a streamed answer is unmasked, also when a placeholder is split over chunks and network reads', async () => {
  const vault = new PiiVault();
  vault.placeholderFor("Jane O'Neil", 'PERSON');
  vault.placeholderFor('jane@example.org', 'EMAIL');
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const sse = [
    chunk({ role: 'assistant', content: 'Hello [[PER' }),
    chunk({ content: 'SON_1]], mail [' }),
    chunk({ content: '[EMAIL_1]] or [x]' }),
    chunk({ tool_calls: [{ index: 0, id: 't', function: { name: 'send', arguments: '{"to":"[[EMA' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: 'IL_1]]","n":"[[PERSON_1]]"}' } }] }),
    chunk({}, 'stop'),
    'data: [DONE]\n\n',
  ].join('');
  // feed it in awkward pieces: events split mid-JSON and mid-line
  const u = createSseUnmasker(vault);
  let out = '';
  for (let i = 0; i < sse.length; i += 7) out += u.push(sse.slice(i, i + 7));
  out += u.end();
  const events = out.split('\n\n').filter(Boolean);
  assert.equal(events.at(-1), 'data: [DONE]');
  const chunks = events.slice(0, -1).map((e) => JSON.parse(e.slice(6)));
  const text = chunks.map((c) => c.choices[0].delta.content ?? '').join('');
  assert.equal(text, "Hello Jane O'Neil, mail jane@example.org or [x]");
  const args = chunks.map((c) => c.choices[0].delta.tool_calls?.[0]?.function?.arguments ?? '').join('');
  assert.deepEqual(JSON.parse(args), { to: 'jane@example.org', n: "Jane O'Neil" });
  assert.ok(!out.includes('[[PERSON_1]]') && !out.includes('[[EMAIL_1]]'));
});

test('a stream that ends without finish_reason still delivers what was held back', () => {
  const vault = new PiiVault();
  vault.placeholderFor('Ann Lee', 'PERSON');
  const u = createSseUnmasker(vault);
  let out = u.push(`data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta: { content: 'Bye [[PERSON_1]] [' } }] })}\n\n`);
  out += u.end();
  const text = out.split('\n\n').filter(Boolean).map((e) => JSON.parse(e.slice(6)).choices[0].delta.content).join('');
  assert.equal(text, 'Bye Ann Lee [');
});

test('embeddings: string inputs are masked, token arrays are reported as unmaskable', async () => {
  const r = await maskEmbeddingRequest({ model: 'e', input: ['about jane@example.org', 'plain'] }, { detector: regexDetector() });
  assert.deepEqual(r.body.input, ['about [[EMAIL_1]]', 'plain']);
  assert.deepEqual((await maskEmbeddingRequest({ model: 'e', input: [[1, 2, 3]] }, { detector: regexDetector() })).unmaskable, ['tokens']);
});

/* ---------------------------------------------------------------- when */

const TRUSTED = Object.freeze({
  node_id: 'io.lab.eu', offering_id: 'm', tier: 'verified', model: { lineage_origins: ['FR'] },
  jurisdiction: { country: 'DE', basis: 'declared', location: null }, data_policy: { retention: 'none', training_on_inputs: false },
  endpoints: { openai: 'https://lab.example/v1' },
});

test('masking applies to the open pool by default, never to the user\'s own machines', () => {
  const view = trustedView('EU,CA');
  assert.equal(needsMasking(TRUSTED, { view }), false);
  assert.equal(needsMasking({ ...TRUSTED, jurisdiction: { country: 'CN', basis: 'declared' } }, { view }), true);
  assert.equal(needsMasking({ ...TRUSTED, jurisdiction: { country: 'UA', basis: 'declared' } }, { view }), true);   // UA is not trusted unless configured
  assert.equal(needsMasking({ ...TRUSTED, model: {} }, { view }), true);                 // undeclared lineage: open pool
  assert.equal(needsMasking({ ...TRUSTED, tier: 'community' }, { view }), true);
  assert.equal(needsMasking({ node_id: 'local', tier: 'local', model: {} }, { view }), false);
  assert.equal(needsMasking({ ...TRUSTED, tier: 'lan', model: {} }, { view }), false);
  assert.equal(needsMasking(TRUSTED, { view, mode: 'all' }), true);
  assert.equal(needsMasking({ ...TRUSTED, model: {} }, { view, mode: 'off' }), false);
  assert.equal(needsMasking({ ...TRUSTED, jurisdiction: { country: 'UA', basis: 'declared' } }, { view: trustedView('EU,CA,UA') }), false);
});

test('mask modes: a misspelt value is an error, and a request can only ask for more masking', () => {
  assert.equal(parseMaskMode(undefined), 'open');
  assert.equal(parseMaskMode('0'), 'off');
  assert.equal(parseMaskMode('ALL'), 'all');
  assert.throws(() => parseMaskMode('of'), /off, open or all/);
  assert.equal(strongerMaskMode('open', 'all'), 'all');
  assert.equal(maskModeOf({ 'onp-mask-pii': 'off' }, 'open'), 'open');
  assert.equal(maskModeOf({ 'onp-mask-pii': 'all' }, 'open'), 'all');
  assert.equal(maskModeOf({ 'onp-mask-pii': 'open' }, 'off'), 'open');
  assert.equal(maskModeOf({}, 'off'), 'off');
});

/* ---------------------------------------------------------------- detectors that need a service */

test('detectors that read raw text must be on this machine or the private network', () => {
  assert.throws(() => llmDetector({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' }), /not on this machine/);
  assert.throws(() => sidecarDetector({ url: 'https://pii.example.com' }), /not on this machine/);
  assert.throws(() => piiDetectorFrom({ env: { ONP_PII_SERVICE: 'http://8.8.8.8:5123' } }), /not on this machine/);
  for (const u of ['http://127.0.0.1:5123', 'http://172.16.0.10:8000/v1', 'http://[::1]:1', 'http://gpu-box:8000', 'http://pii.lan', 'http://100.101.1.2']) assert.ok(isLocalEndpoint(u), u);
  for (const u of ['https://example.com', 'http://8.8.8.8', 'http://[2001:db8::1]', 'not a url']) assert.ok(!isLocalEndpoint(u), u);
  assert.equal(normalizePiiType('EMAIL_ADDRESS'), 'EMAIL');
  assert.equal(normalizePiiType('ON_PROPERTY_PIN'), 'ID');
});

test('a local Presidio service: code-point offsets become JavaScript offsets', async (t) => {
  const seen = [];
  const app = createApp([['POST', '/detect', async (req, res) => {
    const { text } = await readJson(req);
    seen.push(text);
    const cp = [...text];   // Python offsets: code points
    const at = cp.join('').indexOf('Robert Chen');
    const start = [...text.slice(0, at)].length;
    sendJson(res, 200, { engine: 'presidio', entities: [{ type: 'PERSON', start, end: start + 11, score: 0.85 }] });
  }]]);
  const port = await listen(app, 0);
  t.after(() => closeApp(app));
  const detector = compositeDetector(regexDetector(), sidecarDetector({ url: `http://127.0.0.1:${port}` }));
  const [masked] = await maskStrings(['🙂🙂 Robert Chen, robert@example.ca'], { detector, vault: new PiiVault() });
  assert.equal(masked, '🙂🙂 [[PERSON_1]], [[EMAIL_1]]');
  assert.equal(seen.length, 1, 'one call per request');
});

test('a local model lists the values; every occurrence is masked; a failing detector fails the request', async (t) => {
  const app = createApp([['POST', '/v1/chat/completions', async (req, res) => {
    const body = await readJson(req);
    if (body.messages[1].content.includes('FAIL')) return sendJson(res, 400, { error: 'bad' });
    sendJson(res, 200, { choices: [{ message: { content: '```json\n{"pii":[{"text":"Leila Haddad","type":"NAME"},{"text":"[[EMAIL_1]]","type":"EMAIL"}]}\n```' } }] });
  }]]);
  const port = await listen(app, 0);
  t.after(() => closeApp(app));
  const detector = piiDetectorFrom({ llm: `gemma3@http://127.0.0.1:${port}/v1`, env: {} });
  assert.equal(detector.name, 'regex+llm:gemma3');
  const out = await maskChatRequest({ messages: [{ role: 'user', content: 'Leila Haddad wrote to Leila Haddad about [[EMAIL_1]]' }] }, { detector });
  assert.equal(out.body.messages[0].content, '[[PERSON_1]] wrote to [[PERSON_1]] about [[EMAIL_1]]');
  await assert.rejects(maskStrings(['FAIL'], { detector, vault: new PiiVault() }), /HTTP 400/);
  assert.deepEqual(parseLlmPiiAnswer('I could not find anything.'), []);
});
