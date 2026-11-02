// `onp check`: the user's own quick verification of an offering the registry hasn't verified
// (imported catalog listings, registered nodes still awaiting their checks), with the user's key
// and a hard spend cap. Same ideas as the registry's Stage B, sized for a personal budget:
// is the model there, does it answer, are tokens reported plausibly, how fast is it, does a
// fact survive a long prompt, do declared JSON/tool support work. Results are kept locally
// (checks.json) and the gateway uses them when it auto-routes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fetchWithin } from '@opennodes/core';

export const DEFAULT_CHECKS_PATH = join(homedir(), '.opennodes', 'checks.json');
/** Price assumed for spend estimates when a listing publishes none (deliberately high). */
const UNPRICED = { input_per_mtok: 10, output_per_mtok: 30 };
const FILLER = 'lorem ipsum context filler segment. ';
const fill = (chars) => FILLER.repeat(Math.ceil(Math.max(0, chars) / FILLER.length)).slice(0, Math.max(0, chars));

export function loadChecks(path = DEFAULT_CHECKS_PATH) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}
export function saveCheck(result, path = DEFAULT_CHECKS_PATH) {
  const all = loadChecks(path);
  all[result.offering] = result;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(all, null, 2));
}

/**
 * Run the battery. `offering` is a registry offering (or a minimal { endpoints.openai, binding.model_id }).
 * Every request is priced before it is sent; a step that would push the total over maxUsd is skipped.
 */
export async function checkOffering(offering, { key = null, maxUsd = 0.02, contextTokens = 8192, log = () => {} } = {}) {
  const base = offering.endpoints.openai.replace(/\/$/, '');
  const model = offering.binding.model_id;
  const priced = offering.pricing?.input_per_mtok != null || offering.pricing?.output_per_mtok != null;
  const price = priced ? { input_per_mtok: offering.pricing.input_per_mtok ?? 0, output_per_mtok: offering.pricing.output_per_mtok ?? 0 } : UNPRICED;
  const headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
  if (offering.source && offering.source !== 'import' && offering.node_id) {
    headers['onp-offering'] = `${offering.node_id}/${offering.offering_id}`;
    if (offering.card_revision) headers['onp-card-revision'] = offering.card_revision;
  }
  const checks = [];
  let spent = 0, charsPerToken = 4;
  const cost = (inTok, outTok) => (inTok * price.input_per_mtok + outTok * price.output_per_mtok) / 1e6;
  const record = (name, status, detail, extra = {}) => { checks.push({ name, status, detail, ...extra }); log(name, status, detail); };
  const affordable = (inTok, outTok) => spent + cost(inTok, outTok) <= maxUsd;

  async function chat(messages, { maxTokens = 16, extra = {}, budgetMs = 60_000 } = {}) {
    const t0 = performance.now();
    const res = await fetchWithin(`${base}/chat/completions`, {
      method: 'POST', headers,
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0, ...extra }),
    }, budgetMs);
    const body = await res.json().catch(() => null);
    const u = body?.usage;
    spent += u ? cost(u.prompt_tokens ?? 0, u.completion_tokens ?? 0) : 0;
    return { status: res.status, body, usage: u, ms: Math.round(performance.now() - t0), text: body?.choices?.[0]?.message?.content ?? '' };
  }

  // 1. The model is where the listing says (free: no tokens)
  try {
    const res = await fetchWithin(`${base}/models`, { headers }, 20_000);
    const ids = res.ok ? ((await res.json().catch(() => null))?.data ?? []).map((m) => m.id) : null;
    if (!ids) record('model listed', 'warn', `GET /models answered ${res.status}`);
    else if (ids.some((id) => id.toLowerCase() === model.toLowerCase())) record('model listed', 'pass', `${model} is in /models`);
    else record('model listed', 'fail', `${model} is not among the ${ids.length} models this API lists`);
  } catch (err) { record('model listed', 'warn', err.message); }

  // 2. It answers, and says which model answered
  let answers = false;
  try {
    const r = await chat([{ role: 'user', content: 'Reply with exactly: OK-4417' }], { maxTokens: 12 });
    if (r.status !== 200) record('answers', 'fail', `status ${r.status}: ${String(r.body?.error?.message ?? r.body?.detail ?? '').slice(0, 120)}`);
    else {
      answers = true;
      const same = !r.body?.model || r.body.model.toLowerCase().includes(model.split('/').pop().toLowerCase().split(':')[0]);
      record('answers', r.text.includes('OK-4417') ? 'pass' : 'warn',
        `${r.ms} ms${r.text.includes('OK-4417') ? '' : '; did not follow a one-line instruction'}${same ? '' : `; reports model ${r.body.model}`}`,
        { reported_model: r.body?.model ?? null });
    }
  } catch (err) { record('answers', 'fail', err.message); }
  if (!answers) return finish();

  // 3. Token counts are reported and plausible (they are what you are billed on)
  if (affordable(600, 4)) {
    const chars = 2000;
    const r = await chat([{ role: 'user', content: `${fill(chars)}\n\nReply with OK.` }], { maxTokens: 4 }).catch((err) => ({ error: err.message }));
    const pt = r.usage?.prompt_tokens;
    if (r.error) record('usage reported', 'warn', r.error);
    else if (!pt) record('usage reported', 'fail', 'no usage in the response: cost cannot be checked');
    else {
      charsPerToken = chars / pt;
      const plausible = charsPerToken > 1.5 && charsPerToken < 8;
      record('usage reported', plausible ? 'pass' : 'warn', `${pt} prompt tokens for ${chars} characters (${charsPerToken.toFixed(1)} chars/token${plausible ? '' : ', unusual'})`);
    }
  } else record('usage reported', 'skip', 'over the spend cap');

  // 4. Speed: time to first token and throughput from a streamed reply
  if (affordable(30, 64)) {
    try {
      const t0 = performance.now();
      const res = await fetchWithin(`${base}/chat/completions`, {
        method: 'POST', headers,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Count from 1 to 30, separated by spaces.' }], max_tokens: 64, temperature: 0, stream: true, stream_options: { include_usage: true } }),
      }, 60_000);
      if (!res.ok || !res.body) record('speed', 'warn', `streaming answered ${res.status}`);
      else {
        let first = null, chars = 0, outTokens = null, buf = '';
        const dec = new TextDecoder();
        for await (const chunk of res.body) {
          buf += dec.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
            let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
            const delta = ev.choices?.[0]?.delta?.content;
            if (delta) { first ??= performance.now(); chars += delta.length; }
            if (ev.usage?.completion_tokens) { outTokens = ev.usage.completion_tokens; spent += cost(ev.usage.prompt_tokens ?? 0, outTokens); }
          }
        }
        const end = performance.now();
        if (first == null) record('speed', 'warn', 'stream carried no text');
        else {
          const tokens = outTokens ?? Math.round(chars / charsPerToken);
          const secs = Math.max(0.05, (end - first) / 1000);
          const ttft = Math.round(first - t0), tps = Math.round(tokens / secs);
          record('speed', 'pass', `${ttft} ms to first token · ${tps} tokens/s${outTokens == null ? ' (estimated)' : ''}`, { ttft_ms: ttft, tps });
          if (outTokens == null) spent += cost(30, tokens);
        }
      }
    } catch (err) { record('speed', 'warn', err.message); }
  } else record('speed', 'skip', 'over the spend cap');

  // 5. A fact near the start survives a long prompt
  const claimed = offering.serving?.context_window ?? null;
  const target = Math.floor(Math.min(contextTokens === 'full' ? (claimed ?? 8192) * 0.9 : Number(contextTokens), claimed ?? Infinity));
  if (target >= 1000 && affordable(target, 16)) {
    const digits = String(target * 7919);
    const fact = ` The magic number is ${digits}. `;
    const question = '\n\nWhat is the magic number mentioned in the text above? Reply with the number only.';
    const body = Math.floor(target * charsPerToken) - fact.length - question.length - 40;
    const before = Math.floor(body * 0.1);
    try {
      const r = await chat([{ role: 'user', content: fill(before) + fact + fill(body - before) + question }], { maxTokens: 16, budgetMs: 60_000 + target * 30 });
      const pt = r.usage?.prompt_tokens;
      if (r.status !== 200) record('context', 'fail', `${target} tokens: status ${r.status}`);
      else if (pt && pt < target * 0.85) record('context', 'fail', `${target} tokens: prompt cut to ${pt} tokens`);
      else if (!new RegExp(`(^|[^0-9])${digits}([^0-9]|$)`).test(r.text)) record('context', 'fail', `${target} tokens: the fact was lost`);
      else record('context', 'pass', `a fact survived a ${target.toLocaleString('en-US')}-token prompt${claimed ? ` (claimed ${claimed.toLocaleString('en-US')})` : ''}`, { tokens: target });
    } catch (err) { record('context', 'fail', `${target} tokens: ${err.message}`); }
  } else record('context', 'skip', target < 1000 ? 'no context size to test' : `a ${target}-token test would exceed the $${maxUsd} cap (raise --max-usd or lower --context)`);

  // 6. Declared JSON mode and tool calls actually work
  const supports = offering.serving?.supports ?? [];
  if (supports.includes('json_mode') && affordable(60, 60)) {
    const r = await chat([{ role: 'user', content: 'Return a JSON object with a key "ok" set to true.' }], { maxTokens: 60, extra: { response_format: { type: 'json_object' } } }).catch((err) => ({ error: err.message }));
    let parsed = null; try { parsed = JSON.parse(r.text); } catch { /* not JSON */ }
    record('json mode', parsed && typeof parsed === 'object' ? 'pass' : 'fail', r.error ?? (parsed ? 'valid JSON object' : `not JSON: ${String(r.text).slice(0, 60)}`));
  }
  if (supports.includes('tool_calls') && affordable(150, 60)) {
    const tools = [{ type: 'function', function: { name: 'get_time', description: 'Current time in a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
    const r = await chat([{ role: 'user', content: 'What time is it in Warsaw? Use the tool.' }], { maxTokens: 60, extra: { tools } }).catch((err) => ({ error: err.message }));
    const call = r.body?.choices?.[0]?.message?.tool_calls?.[0];
    record('tool calls', call?.function?.name === 'get_time' ? 'pass' : 'fail', r.error ?? (call ? `called ${call.function?.name}` : 'answered without calling the tool'));
  }
  return finish();

  function finish() {
    const failed = checks.filter((c) => c.status === 'fail').map((c) => c.name);
    const speed = checks.find((c) => c.name === 'speed' && c.status === 'pass');
    return {
      offering: offering.node_id ? `${offering.node_id}/${offering.offering_id}` : `${base}#${model}`,
      endpoint: base, model, tier: offering.tier ?? null,
      at: new Date().toISOString(),
      ok: answers && failed.length === 0,
      usable: answers,
      failed,
      ...(speed ? { ttft_ms: speed.ttft_ms, tps: speed.tps } : {}),
      spent_usd: Math.round(spent * 1e6) / 1e6,
      price_basis: priced ? 'listed price' : `no published price; estimated at $${UNPRICED.input_per_mtok}/$${UNPRICED.output_per_mtok} per MTok`,
      checks,
    };
  }
}
