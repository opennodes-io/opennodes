// Ollama native API <-> OpenAI chat API translation, plus SSE / NDJSON stream helpers.
// Ollama's /api/chat and /api/generate stream newline-delimited JSON objects; ONP nodes
// (onp.openai.chat/v1) stream OpenAI server-sent events. This module converts both ways.

const now = () => new Date().toISOString();

/** Ollama /api/chat body -> OpenAI /v1/chat/completions body. */
export function ollamaChatToOpenAI(body, modelId) {
  const messages = (body.messages ?? []).map((m) => {
    const out = { role: m.role };
    if (m.role === 'tool') {
      out.content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      out.tool_call_id = m.tool_call_id ?? 'call_0';
      if (m.tool_name) out.name = m.tool_name;
      return out;
    }
    if (Array.isArray(m.images) && m.images.length) {
      out.content = [
        ...(m.content ? [{ type: 'text', text: m.content }] : []),
        ...m.images.map((img) => ({ type: 'image_url', image_url: { url: img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}` } })),
      ];
    } else {
      out.content = m.content ?? '';
    }
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.tool_calls = m.tool_calls.map((tc, i) => ({
        id: tc.id ?? `call_${i}`, type: 'function',
        function: { name: tc.function?.name, arguments: JSON.stringify(tc.function?.arguments ?? {}) },
      }));
    }
    return out;
  });
  const o = body.options ?? {};
  const req = { model: modelId, messages, stream: body.stream !== false };
  if (o.temperature != null) req.temperature = o.temperature;
  if (o.top_p != null) req.top_p = o.top_p;
  if (o.num_predict != null && o.num_predict > 0) req.max_tokens = o.num_predict;
  if (o.stop != null) req.stop = o.stop;
  if (o.seed != null) req.seed = o.seed;
  if (o.frequency_penalty != null) req.frequency_penalty = o.frequency_penalty;
  if (o.presence_penalty != null) req.presence_penalty = o.presence_penalty;
  if (body.format === 'json') req.response_format = { type: 'json_object' };
  else if (body.format && typeof body.format === 'object') req.response_format = { type: 'json_schema', json_schema: { name: 'response', schema: body.format } };
  if (Array.isArray(body.tools) && body.tools.length) req.tools = body.tools;
  if (req.stream) req.stream_options = { include_usage: true };
  return req;
}

/** Ollama /api/generate body -> OpenAI chat body (prompt/system/images folded into messages). */
export function ollamaGenerateToOpenAI(body, modelId) {
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: body.system });
  messages.push({ role: 'user', content: body.prompt ?? '', images: body.images });
  return ollamaChatToOpenAI({ ...body, messages }, modelId);
}

/** Parse an OpenAI SSE byte stream into JSON events. Yields parsed `data:` objects; stops at [DONE]. */
export async function* parseSse(webStream) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const event = buf.slice(0, idx); buf = buf.slice(idx + 2);
      for (const line of event.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try { yield JSON.parse(data); } catch { /* ignore malformed event */ }
      }
    }
  }
}

/** Parse an NDJSON byte stream into objects. */
export async function* parseNdjson(webStream) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (line) { try { yield JSON.parse(line); } catch { /* skip */ } }
    }
  }
  if (buf.trim()) { try { yield JSON.parse(buf); } catch { /* skip */ } }
}

const DONE_REASON = { stop: 'stop', length: 'length', tool_calls: 'stop', content_filter: 'stop' };

/**
 * Accumulates OpenAI chat chunks and produces Ollama-shaped chat/generate chunks.
 * mode: 'chat' (message.content) | 'generate' (response).
 */
export class OllamaChunker {
  constructor({ model, mode = 'chat', startedAt = performance.now() }) {
    this.model = model; this.mode = mode; this.t0 = startedAt;
    this.content = ''; this.thinking = ''; this.toolCalls = new Map(); this.usage = null; this.finish = null;
  }
  /** Consume one OpenAI chunk; returns an Ollama delta object to emit (or null). */
  take(chunk) {
    if (chunk.usage) this.usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return null;
    const d = choice.delta ?? choice.message ?? {};
    if (choice.finish_reason) this.finish = choice.finish_reason;
    const text = d.content ?? '';
    const think = d.reasoning ?? d.reasoning_content ?? '';
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const key = tc.index ?? this.toolCalls.size;
        const cur = this.toolCalls.get(key) ?? { id: tc.id, name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        this.toolCalls.set(key, cur);
      }
    }
    if (!text && !think) return null;
    this.content += text; this.thinking += think;
    return this.delta(text, think);
  }
  delta(text, think = '') {
    const base = { model: this.model, created_at: now(), done: false };
    if (this.mode === 'generate') return { ...base, response: text, ...(think ? { thinking: think } : {}) };
    return { ...base, message: { role: 'assistant', content: text, ...(think ? { thinking: think } : {}) } };
  }
  tools() {
    return [...this.toolCalls.values()].map((tc) => {
      let args = {};
      try { args = tc.args ? JSON.parse(tc.args) : {}; } catch { args = { _raw: tc.args }; }
      return { function: { name: tc.name, arguments: args } };
    });
  }
  /** Final Ollama object (done: true) with timing + token counts. */
  final({ promptTokens = null, completionTokens = null } = {}) {
    const elapsedNs = Math.round((performance.now() - this.t0) * 1e6);
    const pt = this.usage?.prompt_tokens ?? promptTokens ?? 0;
    const ct = this.usage?.completion_tokens ?? completionTokens ?? Math.ceil(this.content.length / 4);
    const tools = this.tools();
    const base = {
      model: this.model, created_at: now(), done: true,
      done_reason: DONE_REASON[this.finish] ?? 'stop',
      total_duration: elapsedNs, load_duration: 0,
      prompt_eval_count: pt, prompt_eval_duration: Math.round(elapsedNs * 0.2),
      eval_count: ct, eval_duration: Math.round(elapsedNs * 0.8),
    };
    if (this.mode === 'generate') return { ...base, response: '' };
    return { ...base, message: { role: 'assistant', content: '', ...(tools.length ? { tool_calls: tools } : {}) } };
  }
  /** Non-streaming Ollama response with the whole content. */
  whole(opts) {
    const f = this.final(opts);
    if (this.mode === 'generate') return { ...f, response: this.content, ...(this.thinking ? { thinking: this.thinking } : {}) };
    return { ...f, message: { ...f.message, content: this.content, ...(this.thinking ? { thinking: this.thinking } : {}) } };
  }
}

/** Ollama /api/show "capabilities" -> ONP serving.supports. */
export function capabilitiesToSupports(caps = []) {
  const s = new Set(['streaming', 'json_mode']);        // Ollama can constrain any model to JSON
  if (caps.includes('tools')) s.add('tool_calls');
  if (caps.includes('vision')) s.add('vision');
  return [...s];
}

/** "8.0B" / "70B" / "1.5B" / "400M" -> number of billions. */
export function parseParamsB(s) {
  if (!s) return null;
  const m = String(s).match(/([\d.]+)\s*([BM])/i);
  if (!m) return null;
  const n = Number(m[1]);
  return m[2].toUpperCase() === 'M' ? n / 1000 : n;
}

/** Context window from Ollama model_info (any "<arch>.context_length" key). */
export function contextFromModelInfo(info = {}) {
  for (const [k, v] of Object.entries(info)) if (k.endsWith('.context_length') && Number.isFinite(v)) return v;
  return null;
}
