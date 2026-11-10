// PII masking on the client (ONP-3 §5e). The open pool is for requests without personal data. Before a
// request goes to an open-pool offering, a client replaces the personal data it can find with
// placeholders such as [[EMAIL_1]], keeps what each placeholder stands for (for that request only, in
// memory), and puts the values back into the answer on this machine. The operator sees placeholders.
//
// Masking does not make a request trusted: a request marked sensitive still goes to the trusted pool
// only (ONP-3 §5e). Masking protects the requests that are allowed into the open pool.
//
// Adapted from WebTester (src/WebTester.Core/Privacy: PiiDetectors.cs, PiiMasker.cs,
// MaskingLlmProvider.cs). Detectors only point at personal data; one masker replaces it, so every
// detector is masked the same way. A detector that reads raw text must run on this machine or the
// private network.
import { inTrustedPool, trustedView } from './advisor.js';

/* ---------------------------------------------------------------- types */

/** The placeholder types: what every detector's findings are called. */
export const PII_TYPES = Object.freeze(['PERSON', 'USERNAME', 'EMAIL', 'PHONE', 'ADDRESS', 'POSTAL', 'DOB', 'CARD', 'IBAN', 'IP', 'ID']);

/** One vocabulary for the names detectors use (Presidio, LLM Guard, a local LLM). Unknown kinds are IDs. */
export function normalizePiiType(type) {
  const t = String(type ?? '').trim().toUpperCase();
  if (['PERSON', 'PER', 'NAME', 'FIRST_NAME', 'LAST_NAME', 'FULLNAME', 'NAME_STUDENT'].includes(t)) return 'PERSON';
  if (['USERNAME', 'USER_NAME'].includes(t)) return 'USERNAME';
  if (['EMAIL', 'EMAIL_ADDRESS'].includes(t)) return 'EMAIL';
  if (['PHONE', 'PHONE_NUMBER', 'TELEPHONE', 'TELEPHONENUM'].includes(t)) return 'PHONE';
  if (['ADDRESS', 'STREET_ADDRESS', 'STREET', 'LOCATION', 'LOC', 'BUILDINGNUM'].includes(t)) return 'ADDRESS';
  if (['POSTAL', 'CA_POSTAL_CODE', 'ZIPCODE', 'ZIP', 'POSTCODE'].includes(t)) return 'POSTAL';
  if (['DOB', 'DATE_OF_BIRTH', 'DATEOFBIRTH'].includes(t)) return 'DOB';
  if (['CARD', 'CREDIT_CARD', 'CREDITCARDNUMBER'].includes(t)) return 'CARD';
  if (['IBAN', 'IBAN_CODE'].includes(t)) return 'IBAN';
  if (['IP', 'IP_ADDRESS'].includes(t)) return 'IP';
  return 'ID';
}

/* ---------------------------------------------------------------- where a detector may run */

const isPrivateIpv4 = (a, b) => a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 0;

/**
 * Is the URL on this machine or the private network? A detector reads unmasked text, so it must be.
 * Loopback, private and link-local addresses, `localhost`, `.local` `.lan` `.internal` `.intranet`
 * `.home.arpa` names and single-label hosts are; anything else is not, nor is a URL that does not parse.
 */
export function isLocalEndpoint(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return false; }
  if (!host) return false;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return isPrivateIpv4(Number(v4[1]), Number(v4[2]));
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    return v6 === '::1' || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
  }
  if (host === 'localhost' || /\.(localhost|local|lan|internal|intranet|home\.arpa)$/.test(host)) return true;
  return !host.includes('.');
}

/* ---------------------------------------------------------------- detectors */
// A detector is { name, detect(text) -> Promise<[{ start, end, type, score, source }]> } (UTF-16 offsets).

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function ibanValid(raw) {
  const s = raw.replace(/ /g, '');
  if (s.length < 15 || s.length > 34) return false;
  const moved = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const ch of moved) rest = (rest * 10 + Number(ch)) % 97;
  return rest === 1;
}

function publicIpv4(ip) {
  const [a, b, c, d] = ip.split('.').map(Number);
  if ([a, b, c, d].some((x) => x > 255)) return false;
  return !isPrivateIpv4(a, b) && a < 224;   // multicast and reserved identify nobody
}

const DATE = String.raw`(?:\d{4}-\d{2}-\d{2}|\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})|[A-Z][a-z]{2,8}\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}|\d{1,2} [A-Z][a-z]{2,8}\.? \d{4})`;
const ID_WORDS = String.raw`passport|driver'?s? licen[cs]e|licen[cs]e|health card|health number|health insurance|insurance number|national id|id card|identity card|social insurance|social security|SIN|SSN|NHS number|NHS|tax id|TIN|account|acct|MRN|patient id|member id|employee id`;

/**
 * Structured identifiers, most specific first; a later rule never re-matches text an earlier one took.
 * WebTester's classifiers (e-mail, card, SIN, NANP phone, Canadian postal code), checked where a check
 * exists (Luhn for cards, mod 97 for IBAN), plus international phones, IBAN, US SSN, public IPv4,
 * and dates of birth and identifiers named by a label ("DOB: …", "passport no. …").
 * WebTester's bare 9-digit and 10+-digit rules are left out: in general prompts and code they are
 * mostly timestamps and ids, not personal data.
 */
export const PII_PATTERNS = Object.freeze([
  { type: 'EMAIL', rx: /\b[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+\b/g },
  { type: 'IBAN', rx: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/g, valid: ibanValid },
  { type: 'CARD', rx: /\b(?:\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}|\d{4}[ -]?\d{6}[ -]?\d{5})\b/g, valid: (m) => luhn(m.replace(/\D/g, '')) },
  { type: 'DOB', rx: new RegExp(String.raw`\b(?:date of birth|birth ?date|d\.o\.b\.?|dob|born(?: on)?)\s*[:-]?\s*(${DATE})`, 'gid'), group: 1 },
  { type: 'ID', rx: new RegExp(String.raw`\b(?:${ID_WORDS})(?:\s+(?:no\.?|number|num|#|id))?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]*\d[A-Z0-9-]*)`, 'gid'), group: 1, valid: (m) => m.length >= 5 },
  { type: 'ID', rx: /\b\d{3}-\d{2}-\d{4}\b/g },                               // US SSN
  { type: 'ID', rx: /\b\d{3}[ -]\d{3}[ -]\d{3}\b/g },                         // Canadian SIN, any 3-3-3 grouping
  { type: 'PHONE', rx: /(?<![\w+])\+(?:\d[ .()-]{0,2}){7,14}\d\b/g, valid: (m) => { const n = m.replace(/\D/g, '').length; return n >= 8 && n <= 15; } },
  { type: 'PHONE', rx: /(?:\+?1[ .-])?\(?\b\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g },  // NANP
  { type: 'IP', rx: /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w]|\.\d)/g, valid: publicIpv4 },
  // Canadian postal code (A1A 1A1); never after '#' (a hex colour has the same shape)
  { type: 'POSTAL', rx: /(?<![#\w])[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z][ -]?\d[ABCEGHJ-NPRSTV-Z]\d(?!\w)/g },
]);

/** Placeholders already in the text (ours or the user's): never masked again, never reused. */
const PLACEHOLDER = /\[\[[A-Z]+_\d+\]\]/g;

/** Rules only: structured identifiers. Finds no names and no street addresses. */
export function regexDetector() {
  return {
    name: 'regex',
    async detect(text) {
      const found = [];
      if (!text) return found;
      const taken = new Uint8Array(text.length);
      for (const m of text.matchAll(PLACEHOLDER)) taken.fill(1, m.index, m.index + m[0].length);
      for (const { type, rx, valid, group } of PII_PATTERNS) {
        for (const m of text.matchAll(rx)) {
          const value = group ? m[group] : m[0];
          if (!value || (valid && !valid(value))) continue;
          const start = group ? m.indices[group][0] : m.index;
          const end = start + value.length;
          if (taken.subarray(start, end).some(Boolean)) continue;
          taken.fill(1, start, end);
          found.push({ start, end, type, score: 1, source: 'regex' });
        }
      }
      return found.sort((a, b) => a.start - b.start);
    },
  };
}

/** Python counts code points, JavaScript counts UTF-16 units: offsets[codePoint] = UTF-16 offset. */
function codePointOffsets(text) {
  const map = [];
  let i = 0;
  for (const ch of text) { map.push(i); i += ch.length; }
  map.push(i);
  return map;
}

/**
 * WebTester's local detection service (tools/pii/pii_service.py): Microsoft Presidio with Canadian
 * recognizers, or LLM Guard. POST {url}/detect {text} answers positions and types only, never values.
 */
export function sidecarDetector({ url, name = 'presidio', fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  if (!isLocalEndpoint(url)) throw new Error(`PII service ${url} is not on this machine or the private network: it would receive unmasked text`);
  const detectUrl = `${url.replace(/\/$/, '')}/detect`;
  return {
    name,
    async detect(text) {
      if (!text) return [];
      const res = await fetchImpl(detectUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }), signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${name}: ${body.error ?? `HTTP ${res.status}`}`);
      const map = codePointOffsets(text);
      const at = (i) => map[Math.min(Math.max(0, i), map.length - 1)];
      return (body.entities ?? []).map((e) => ({ start: at(e.start), end: at(e.end), type: normalizePiiType(e.type), score: e.score ?? 0.5, source: name }))
        .filter((s) => s.end > s.start);
    },
  };
}

export const LLM_DETECTOR_INSTRUCTIONS =
  'You find personal data in text so it can be masked before the text is sent to an AI provider.\n'
  + 'List every piece of personal data exactly as it appears in the text (same spelling, same spacing): '
  + "people's names (also \"Surname, Given\" and initials such as \"J. Smith\"), user names of people, street addresses "
  + '(number and street), postal codes, phone numbers, e-mail addresses, dates of birth, and personal or account '
  + "identifiers (national ID, social insurance or security number, health card, driver's licence, passport, card "
  + 'and bank account numbers, IP addresses).\n'
  + 'Do NOT list: placeholders such as [[PERSON_1]], code identifiers, file names, product, model or company names, '
  + 'organisation or site names, cities or countries on their own, colours, coordinates, counts, amounts, dates '
  + 'that are not dates of birth, or any other text that does not identify a person.\n'
  + 'Answer with JSON only: {"pii": [{"text": "...", "type": "PERSON|ADDRESS|POSTAL|PHONE|EMAIL|DOB|ID|USERNAME"}]}. '
  + 'If there is none, answer {"pii": []}.';

/** Reads the model's JSON answer, tolerating a code fence or words around it. */
export function parseLlmPiiAnswer(content) {
  const a = content.indexOf('{'), b = content.lastIndexOf('}');
  if (a < 0 || b <= a) return [];
  try {
    const { pii } = JSON.parse(content.slice(a, b + 1));
    return Array.isArray(pii) ? pii.filter((x) => typeof x?.text === 'string' && x.text.trim()).map((x) => ({ text: x.text, type: x.type ?? 'ID' })) : [];
  } catch { return []; }
}

function* chunks(text, size) {
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const nl = text.lastIndexOf('\n', end - 1);
      if (nl > start) end = nl + 1;
    }
    yield [start, text.slice(start, end)];
    start = end;
  }
}

/**
 * A local model (Ollama, vLLM: OpenAI-compatible) lists the personal data in the text. The model only
 * names strings; finding and replacing them is done here, so it cannot rewrite or drop other text.
 * It reads the raw text, so a remote endpoint is refused.
 */
export function llmDetector({ baseUrl = 'http://127.0.0.1:11434/v1', model, fetchImpl = globalThis.fetch, chunkChars = 3000, timeoutMs = 120_000 } = {}) {
  if (!model) throw new Error('llmDetector needs a model');
  if (!isLocalEndpoint(baseUrl)) throw new Error(`model endpoint ${baseUrl} is not on this machine or the private network: it would receive unmasked text`);
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  async function ask(chunk) {
    const body = JSON.stringify({
      model, temperature: 0, max_tokens: 1024, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: LLM_DETECTOR_INSTRUCTIONS }, { role: 'user', content: `Text:\n<<<\n${chunk}\n>>>` }],
    });
    for (let attempt = 1; ; attempt++) {   // a LAN link can drop a request: three tries
      try {
        const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(timeoutMs) });
        if (res.ok) {
          const answer = await res.json();
          return parseLlmPiiAnswer(answer?.choices?.[0]?.message?.content ?? '');
        }
        if (res.status < 500 || attempt === 3) throw new Error(`PII model ${model}: HTTP ${res.status}`);
      } catch (err) {
        if (attempt === 3 || /HTTP 4\d\d/.test(err.message)) throw err;
      }
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }

  return {
    name: `llm:${model}`,
    async detect(text) {
      const spans = [];
      if (!text?.trim()) return spans;
      for (const [offset, chunk] of chunks(text, chunkChars)) {
        for (const { text: value, type } of await ask(chunk)) {
          if (value.length < 2 || /^\[\[[A-Z]+_\d+\]\]$/.test(value)) continue;
          // every place the value occurs: the model names it once
          for (let i = chunk.indexOf(value); i >= 0; i = chunk.indexOf(value, i + value.length)) {
            spans.push({ start: offset + i, end: offset + i + value.length, type: normalizePiiType(type), score: 0.9, source: `llm:${model}` });
          }
        }
      }
      return spans;
    },
  };
}

/** Several detectors at once: whatever any of them finds is masked. One failing fails the whole. */
export function compositeDetector(...detectors) {
  const parts = detectors.flat().filter(Boolean);
  return {
    name: parts.map((d) => d.name).join('+'),
    parts,
    async detect(text) { return (await Promise.all(parts.map((d) => d.detect(text)))).flat(); },
  };
}

/**
 * The detector a client uses: the rules always, plus a local Presidio / LLM Guard service
 * (`service`, ONP_PII_SERVICE) and a local model (`llm` = "model" or "model@baseUrl", ONP_PII_LLM).
 */
export function piiDetectorFrom({ service, llm, env = globalThis.process?.env ?? {}, fetchImpl } = {}) {
  service ??= env.ONP_PII_SERVICE || null;
  llm ??= env.ONP_PII_LLM || null;
  const parts = [regexDetector()];
  if (service) parts.push(sidecarDetector({ url: service, fetchImpl }));
  if (llm) {
    const at = llm.lastIndexOf('@http');
    parts.push(llmDetector(at > 0 ? { model: llm.slice(0, at), baseUrl: llm.slice(at + 1), fetchImpl } : { model: llm, fetchImpl }));
  }
  return parts.length === 1 ? parts[0] : compositeDetector(parts);
}

/* ---------------------------------------------------------------- vault and masker */

/**
 * What each placeholder stands for, for one request. In memory only: it turns masked text back into
 * personal data, so it is never logged or sent. Counts by type may be logged.
 */
export class PiiVault {
  #byValue = new Map();
  #byPlaceholder = new Map();
  #counters = new Map();
  #reserved = new Set();

  get size() { return this.#byPlaceholder.size; }

  /** Placeholders already in the request: new ones skip them, and unmasking leaves them alone. */
  reserve(text) {
    if (typeof text === 'string') for (const m of text.matchAll(PLACEHOLDER)) this.#reserved.add(m[0]);
  }

  /** The placeholder for a value: the same value always gets the same one. */
  placeholderFor(value, type) {
    const known = this.#byValue.get(value);
    if (known) return known;
    const t = normalizePiiType(type);
    let n = this.#counters.get(t) ?? 0, p;
    do { p = `[[${t}_${++n}]]`; } while (this.#reserved.has(p));
    this.#counters.set(t, n);
    this.#byValue.set(value, p);
    this.#byPlaceholder.set(p, value);
    return p;
  }

  valueOf(placeholder) { return this.#byPlaceholder.get(placeholder); }

  /** How many values of each type were masked, e.g. { EMAIL: 1, PERSON: 2 }: safe to log. */
  counts() {
    const out = {};
    for (const p of this.#byPlaceholder.keys()) { const t = p.slice(2, p.lastIndexOf('_')); out[t] = (out[t] ?? 0) + 1; }
    return out;
  }
}

/** Overlapping findings become one span (the widest), typed by the most confident. */
export function mergeSpans(spans) {
  const merged = [];
  for (const s of [...spans].filter((x) => x.end > x.start).sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = merged.at(-1);
    if (last && s.start < last.end) {
      const best = s.score > last.score ? s : last;
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, s.end), type: best.type, score: Math.max(s.score, last.score),
        source: last.source === s.source ? last.source : `${last.source}+${s.source}` };
    } else merged.push({ ...s });
  }
  return merged;
}

const EDGE_START = /[\s,;("']/;
const EDGE_END = /[\s,;)"'.]/;

/** The text with every finding replaced by its placeholder. */
export function maskText(text, spans, vault) {
  if (!text) return text;
  const keep = new Uint8Array(text.length);
  for (const m of text.matchAll(PLACEHOLDER)) keep.fill(1, m.index, m.index + m[0].length);
  let out = '', cursor = 0;
  for (const s of mergeSpans(spans)) {
    let start = Math.max(s.start, cursor), end = Math.min(s.end, text.length);
    while (start < end && EDGE_START.test(text[start])) start++;
    const nl = text.indexOf('\n', start);   // never across a line break: on a form the next line is the next label
    if (nl >= 0 && nl < end) end = nl;
    while (end > start && EDGE_END.test(text[end - 1])) end--;
    if (end <= start || keep.subarray(start, end).some(Boolean)) continue;
    out += text.slice(cursor, start) + vault.placeholderFor(text.slice(start, end), s.type);
    cursor = end;
  }
  return out + text.slice(cursor);
}

/** Placeholders back to their values; unknown ones stay. `encode` formats a value (e.g. for inside JSON). */
export function unmaskText(text, vault, encode = null) {
  if (!text || !vault?.size) return text;
  return text.replace(PLACEHOLDER, (p) => {
    const v = vault.valueOf(p);
    return v === undefined ? p : encode ? encode(v) : v;
  });
}

/** A value written inside a JSON string literal. */
export const jsonStringContent = (v) => JSON.stringify(v).slice(1, -1);

/**
 * Detect once over many strings (one call to a service or model per request, not per message), then
 * mask each. Segments are joined by blank lines, which no masked span crosses.
 */
export async function maskStrings(texts, { detector, vault }) {
  if (!texts.length) return [];
  for (const t of texts) vault.reserve(t);
  const offsets = [];
  let joined = '';
  for (const t of texts) { offsets.push(joined.length); joined += `${t}\n\n`; }
  const spans = await detector.detect(joined);
  return texts.map((t, i) => {
    const from = offsets[i], to = from + t.length;
    const mine = spans.filter((s) => s.start < to && s.end > from)
      .map((s) => ({ ...s, start: Math.max(0, s.start - from), end: Math.min(t.length, s.end - from) }));
    return mine.length ? maskText(t, mine, vault) : t;
  });
}

/* ---------------------------------------------------------------- OpenAI bodies */

/** Collects the string slots of a JSON value (tool-call arguments), to mask them and write them back. */
function stringSlots(node, slots) {
  if (Array.isArray(node)) node.forEach((v, i) => (typeof v === 'string' ? slots.push({ get: () => node[i], set: (x) => { node[i] = x; } }) : stringSlots(v, slots)));
  else if (node && typeof node === 'object') for (const k of Object.keys(node)) {
    if (typeof node[k] === 'string') slots.push({ get: () => node[k], set: (x) => { node[k] = x; } });
    else stringSlots(node[k], slots);
  }
}

const field = (obj, key) => ({ get: () => obj[key], set: (x) => { obj[key] = x; } });

/** JSON text whose string values are slots: written back as JSON once masked. */
function jsonSlots(holder, key, slots, after) {
  let parsed;
  try { parsed = JSON.parse(holder[key]); } catch { slots.push(field(holder, key)); return; }
  if (!parsed || typeof parsed !== 'object') { slots.push(field(holder, key)); return; }
  const mine = [];
  stringSlots(parsed, mine);
  const before = mine.map((s) => s.get());
  slots.push(...mine);
  // rewritten only when a value changed: otherwise the arguments keep their exact bytes
  after.push(() => { if (mine.some((s, i) => s.get() !== before[i])) holder[key] = JSON.stringify(parsed); });
}

async function applySlots(slots, after, opts) {
  const masked = await maskStrings(slots.map((s) => s.get()), opts);
  slots.forEach((s, i) => s.set(masked[i]));
  for (const f of after) f();
}

/**
 * Mask an OpenAI chat request (onp.openai.chat/v1): message text (system, user, assistant, tool), text
 * content parts, the arguments of earlier tool calls, and a legacy `prompt`. Tool definitions,
 * names and settings are left as they are. Images, audio and files cannot be masked: they are listed
 * in `unmaskable`, and the caller decides (the reference clients do not send them to the open pool).
 * Returns { body, vault, counts, unmaskable }; `body` is a copy.
 */
export async function maskChatRequest(body, { detector, vault = new PiiVault() } = {}) {
  const out = structuredClone(body);
  const slots = [], after = [], unmaskable = [];
  for (const m of Array.isArray(out.messages) ? out.messages : []) {
    if (!m || typeof m !== 'object') continue;
    if (typeof m.content === 'string') slots.push(field(m, 'content'));
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (typeof p?.text === 'string' && (p.type === 'text' || p.type == null)) slots.push(field(p, 'text'));
        else if (p?.type) unmaskable.push(p.type);
      }
    }
    for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      if (typeof tc?.function?.arguments === 'string') jsonSlots(tc.function, 'arguments', slots, after);
    }
    if (typeof m.function_call?.arguments === 'string') jsonSlots(m.function_call, 'arguments', slots, after);
  }
  if (typeof out.prompt === 'string') slots.push(field(out, 'prompt'));
  await applySlots(slots, after, { detector, vault });
  return { body: out, vault, counts: vault.counts(), unmaskable: [...new Set(unmaskable)] };
}

/** Mask an embeddings request: string inputs. Token arrays cannot be masked: `unmaskable: ['tokens']`. */
export async function maskEmbeddingRequest(body, { detector, vault = new PiiVault() } = {}) {
  const out = structuredClone(body);
  const slots = [], unmaskable = [];
  if (typeof out.input === 'string') slots.push(field(out, 'input'));
  else if (Array.isArray(out.input)) out.input.forEach((x, i) => (typeof x === 'string' ? slots.push(field(out.input, i)) : unmaskable.push('tokens')));
  await applySlots(slots, [], { detector, vault });
  return { body: out, vault, counts: vault.counts(), unmaskable: [...new Set(unmaskable)] };
}

function unmaskMessage(m, vault) {
  if (!m || typeof m !== 'object') return;
  for (const k of ['content', 'refusal', 'reasoning_content', 'reasoning']) if (typeof m[k] === 'string') m[k] = unmaskText(m[k], vault);
  if (Array.isArray(m.content)) for (const p of m.content) if (typeof p?.text === 'string') p.text = unmaskText(p.text, vault);
  for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
    if (typeof tc?.function?.arguments === 'string') tc.function.arguments = unmaskText(tc.function.arguments, vault, jsonStringContent);
  }
  if (typeof m.function_call?.arguments === 'string') m.function_call.arguments = unmaskText(m.function_call.arguments, vault, jsonStringContent);
}

/** Put the values back into a chat completion: text, reasoning, and tool-call arguments (kept valid JSON). */
export function unmaskCompletion(completion, vault) {
  if (!vault?.size || !completion || typeof completion !== 'object') return completion;
  const out = structuredClone(completion);
  for (const c of Array.isArray(out.choices) ? out.choices : []) {
    unmaskMessage(c.message, vault);
    if (typeof c.text === 'string') c.text = unmaskText(c.text, vault);
  }
  return out;
}

/** The end of a text that may be the start of a placeholder ("[", "[[EMA", "[[EMAIL_1]"). */
const PARTIAL_PLACEHOLDER = /\[(?:\[(?:[A-Z]+(?:_\d*\]?)?)?)?$/;

/**
 * A streamed answer (server-sent events of chat.completion.chunk) with the values put back. A
 * placeholder split over two chunks is held back until it is whole. Feed it the stream's text with
 * push(); it returns what to forward. end() returns whatever is still held.
 */
export function createSseUnmasker(vault) {
  let buffer = '';
  let template = null;   // id, object, created, model of the last chunk: for a closing chunk of our own
  const held = new Map();   // `${choice}|content`, `${choice}|tool|${index}` -> text held back

  const take = (key, text, encode, final) => {
    const all = (held.get(key) ?? '') + text;
    const m = final ? null : PARTIAL_PLACEHOLDER.exec(all);
    const cut = m && all.length - m.index <= 40 ? m.index : all.length;
    held.set(key, all.slice(cut));
    return unmaskText(all.slice(0, cut), vault, encode);
  };

  function rewrite(chunk) {
    template = { id: chunk.id, object: chunk.object, created: chunk.created, model: chunk.model };
    for (const c of Array.isArray(chunk.choices) ? chunk.choices : []) {
      const d = c.delta ?? (c.delta = {});
      const final = c.finish_reason != null;
      for (const k of ['content', 'reasoning_content', 'reasoning']) {
        if (typeof d[k] === 'string' || (final && held.get(`${c.index}|${k}`))) {
          const s = take(`${c.index}|${k}`, d[k] ?? '', null, final);
          if (typeof d[k] === 'string' || s) d[k] = s;
        }
      }
      for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        if (typeof tc?.function?.arguments === 'string') tc.function.arguments = take(`${c.index}|tool|${tc.index}`, tc.function.arguments, jsonStringContent, final);
      }
      if (final) {   // whatever is still held for this choice (a tool call that ended on "[")
        for (const [key, rest] of held) {
          const [ci, kind, ti] = key.split('|');
          if (Number(ci) !== c.index || kind !== 'tool' || !rest) continue;
          (d.tool_calls ??= []).push({ index: Number(ti), function: { arguments: unmaskText(rest, vault, jsonStringContent) } });
          held.set(key, '');
        }
      }
    }
    return chunk;
  }

  /** Everything still held, as one chunk of our own (a stream that ended without finish_reason); null if nothing is. */
  function closingChunk() {
    const choices = new Map();
    for (const [key, rest] of held) {
      if (!rest) continue;
      const [ci, kind, ti] = key.split('|');
      const d = choices.get(ci) ?? {};
      if (kind === 'tool') (d.tool_calls ??= []).push({ index: Number(ti), function: { arguments: unmaskText(rest, vault, jsonStringContent) } });
      else d[kind] = unmaskText(rest, vault);
      choices.set(ci, d);
    }
    held.clear();
    if (!choices.size) return null;
    return { ...(template ?? { object: 'chat.completion.chunk' }), choices: [...choices].map(([i, delta]) => ({ index: Number(i), delta, finish_reason: null })) };
  }
  const closing = () => { const c = closingChunk(); return c ? `data: ${JSON.stringify(c)}\n\n` : ''; };

  function event(raw) {
    const lines = raw.split(/\r?\n/);
    const at = lines.findIndex((l) => l.startsWith('data:'));
    if (at < 0) return `${raw}\n\n`;
    const data = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    if (data.trim() === '[DONE]') return `${closing()}${raw}\n\n`;
    let chunk;
    try { chunk = JSON.parse(data); } catch { return `${raw}\n\n`; }
    const rest = lines.filter((l) => !l.startsWith('data:'));
    return `${[...rest, `data: ${JSON.stringify(rewrite(chunk))}`].join('\n')}\n\n`;
  }

  return {
    push(text) {
      buffer += text;
      let out = '';
      for (let m = buffer.match(/\r?\n\r?\n/); m; m = buffer.match(/\r?\n\r?\n/)) {
        out += event(buffer.slice(0, m.index));
        buffer = buffer.slice(m.index + m[0].length);
      }
      return out;
    },
    end() {
      const tail = buffer.trim() ? event(buffer) : '';
      buffer = '';
      return tail + closing();
    },
    /** For a caller that parses the stream itself: one chunk object, values put back (the same object). */
    chunk: (obj) => rewrite(obj),
    /** For such a caller, at the end: the chunk of whatever is still held, or null. */
    close: () => closingChunk(),
  };
}

/** A streamed answer (bytes of server-sent events) as text with the values put back, piece by piece. */
export async function* unmaskSse(byteStream, vault) {
  const unmasker = createSseUnmasker(vault);
  const decoder = new TextDecoder();
  for await (const bytes of byteStream) {
    const out = unmasker.push(decoder.decode(bytes, { stream: true }));
    if (out) yield out;
  }
  const tail = unmasker.push(decoder.decode()) + unmasker.end();
  if (tail) yield tail;
}

/* ---------------------------------------------------------------- when to mask */

/** Masking modes, weakest first: `off`; `open` (default): open-pool offerings; `all`: every hosted offering. */
export const PII_MASK_MODES = Object.freeze(['off', 'open', 'all']);

/** A mode from a flag, variable or header value; `fallback` when absent. A misspelt value is an error, not "off". */
export function parseMaskMode(value, fallback = 'open') {
  if (value == null || String(value).trim() === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (['0', 'off', 'false', 'no', 'none'].includes(v)) return 'off';
  if (['1', 'on', 'true', 'yes', 'open'].includes(v)) return 'open';
  if (v === 'all') return 'all';
  throw Object.assign(new Error(`PII mask mode must be off, open or all, not ${JSON.stringify(String(value))}`), { status: 400 });
}

/** The stronger of two modes: a request can ask for more masking than the client's setting, never less. */
export const strongerMaskMode = (a, b) => (PII_MASK_MODES.indexOf(a) >= PII_MASK_MODES.indexOf(b) ? a : b);

/** The `onp-mask-pii: off|open|all` request header, combined with the client's mode. */
export function maskModeOf(headers = {}, clientMode = 'open') {
  const asked = headers['onp-mask-pii'];
  return asked == null ? clientMode : strongerMaskMode(clientMode, parseMaskMode(asked, clientMode));
}

/**
 * Must a request to this offering be masked? Never for a model on the user's own machine or network
 * (nothing reaches an operator); in `open` mode for an offering outside the trusted pool under the
 * client's trusted view; in `all` mode for every hosted offering.
 */
export function needsMasking(offering, { mode = 'open', view = trustedView() } = {}) {
  if (mode === 'off') return false;
  if (offering?.local || offering?.tier === 'local' || offering?.tier === 'lan') return false;
  return mode === 'all' || !inTrustedPool(offering, view);
}

/** For logs and the `onp-pii-masked` header: "EMAIL=1,PERSON=2" (types and counts, never values). */
export const describeMaskCounts = (counts = {}) => Object.entries(counts).sort().map(([t, n]) => `${t}=${n}`).join(',');

/**
 * What a client sends to this offering: the masked request ({ body, vault, counts }), or null when the
 * offering may have the request as it is. `mask` runs the detector and returns maskChatRequest's or
 * maskEmbeddingRequest's result; when trying several offerings for one request, pass one that caches
 * its promise, so detection runs once. Throws `policy: …` (so nothing is sent to this offering) when
 * detection fails or the request holds content that cannot be masked (images, audio, files, tokens).
 */
export async function maskedRequestFor(offering, { mode = 'open', view = trustedView(), mask }) {
  if (!needsMasking(offering, { mode, view })) return null;
  const id = `${offering.node_id}/${offering.offering_id}`;
  let masked;
  try { masked = await mask(); }
  catch (err) { throw new Error(`policy: PII masking failed, so nothing was sent to ${id} (${err.message})`); }
  if (masked.unmaskable.length) {
    throw new Error(`policy: ${masked.unmaskable.join(', ')} content cannot be masked, so it is not sent to ${id} (${mode === 'all' ? 'PII masking for every hosted offering' : 'open pool'})`);
  }
  return masked;
}

/** Caches the promise of `fn`: one detection per request however many offerings are tried. */
export const oncePerRequest = (fn) => { let p = null; return () => (p ??= fn()); };

/** Response header for a masked request: `onp-pii-masked: EMAIL=1,PHONE=1` (or `none`); {} when not masked. */
export const piiMaskedHeader = (masked) => (masked ? { 'onp-pii-masked': describeMaskCounts(masked.counts) || 'none' } : {});
