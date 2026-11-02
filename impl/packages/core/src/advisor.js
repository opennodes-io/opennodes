// ONP Advisor (ONP-3 §5b, ONP-6 §6): task → features → ranked offerings with an
// enforceable estimate and a transparent explanation. Deterministic and pure so it runs
// client-side (gateway, stdio MCP, SDK) as well as in the registry; a client can send
// only the extracted *features* to a registry and never the prompt (privacy by design).
import { estimateBounds, round6 } from './pricing.js';

/* ------------------------------------------------------------------ features */

const STOPWORDS = {
  en: ['the', 'and', 'is', 'to', 'of', 'in', 'that', 'for', 'with', 'you', 'this', 'are', 'what', 'how', 'please'],
  de: ['und', 'der', 'die', 'das', 'ist', 'nicht', 'mit', 'ein', 'eine', 'für', 'auf', 'bitte', 'wie', 'ich'],
  fr: ['le', 'la', 'les', 'et', 'est', 'des', 'une', 'pour', 'que', 'dans', 'pas', 'vous', 'avec', 'sur'],
  es: ['el', 'la', 'los', 'las', 'y', 'es', 'que', 'para', 'con', 'una', 'por', 'como', 'del', 'este'],
  it: ['il', 'la', 'di', 'che', 'è', 'per', 'una', 'con', 'non', 'sono', 'del', 'come', 'questo', 'gli'],
  pt: ['o', 'a', 'os', 'as', 'que', 'é', 'para', 'com', 'uma', 'não', 'por', 'como', 'você', 'isso'],
  pl: ['i', 'jest', 'nie', 'się', 'na', 'do', 'że', 'jak', 'to', 'czy', 'proszę', 'oraz', 'dla', 'być'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'niet', 'met', 'voor', 'zijn', 'hoe', 'wat', 'je'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'ne', 'nasıl', 'değil', 'olan', 'var', 'mi', 'da', 'de', 'çok'],
};
const SCRIPT_HINTS = [
  [/[іїєґ]/i, 'uk'], [/[Ѐ-ӿ]/, 'ru'],
  [/[぀-ヿ]/, 'ja'], [/[가-힯]/, 'ko'], [/[一-鿿]/, 'zh'],
  [/[؀-ۿ]/, 'ar'], [/[֐-׿]/, 'he'], [/[฀-๿]/, 'th'],
];

export function detectLanguage(text) {
  for (const [re, lang] of SCRIPT_HINTS) if (re.test(text)) return lang;
  const words = text.toLowerCase().match(/[\p{L}']+/gu) ?? [];
  if (words.length < 3) return 'en';
  let best = 'en', bestScore = 0;
  for (const [lang, stops] of Object.entries(STOPWORDS)) {
    const set = new Set(stops);
    const score = words.filter((w) => set.has(w)).length;
    if (score > bestScore) { best = lang; bestScore = score; }
  }
  return best;
}

/** One RAG answer reads the question plus retrieved passages: about this many input tokens. */
const RAG_CALL_INPUT_TOKENS = 6000;
/** Assumed size of one document when estimating the cost of indexing a collection. */
const TOKENS_PER_DOCUMENT = 1000;

const CUES = {
  image_generation: /\b(generate|create|draw|paint|render|make)\b[^.]{0,40}\b(image|picture|photo|illustration|logo|icon|artwork|wallpaper)\b|\btext[- ]to[- ]image\b/i,
  audio: /\b(transcribe|speech to text|text to speech|tts|voice ?over|podcast audio)\b/i,
  code: /\b(code|function|class|bug|refactor|unit test|regex|sql|python|javascript|typescript|rust|java\b|c\+\+|golang|bash|script|compile|stack ?trace|api endpoint)\b/i,
  reasoning_high: /\b(prove|proof|theorem|derive|step[- ]by[- ]step|rigorous|optimi[sz]e|complexity|trade-?offs?|why does|root cause|debug|formal|puzzle|olympiad)\b/i,
  reasoning_medium: /\b(analy[sz]e|compare|evaluate|plan|design|architect|estimate|decide|strategy|reason)\b/i,
  extraction: /\b(extract|parse|pull out|list all|as json|to json|json format|structured|csv|table of|key ?value|schema)\b/i,
  classification: /\b(classify|categori[sz]e|label|sentiment|is this .* or|yes or no|which category|tag this|spam)\b/i,
  translation: /\b(translate|translation|into (english|german|french|spanish|polish|ukrainian|italian|portuguese|japanese|chinese))\b/i,
  summarization: /\b(summari[sz]e|summary|tl;?dr|key points|brief me|condense|abstract of)\b/i,
  // answering from a document collection: an embedding model to index it, a generator to answer
  rag: /\b(rag|retrieval[- ]augmented|knowledge ?base|vector (store|db|database|index|search)|semantic search|embeddings?|(chat with|talk to|ask) (my|our|your|the) (\d[\d,.]*k? )?([a-z-]+ ){0,2}(documents|docs|pdfs|files|data|wiki|tickets|notes|manuals|contracts|records)|(questions?|q&a|answers?|search) (over|across|about|from|on|in) (about |around |roughly |~)?(my|our|the|these|\d[\d,.]*k?|thousands of|hundreds of) ([a-z-]+ ){0,2}(documents|docs|pdfs|files|pages|manuals|contracts|notes|articles|records|tickets))\b/i,
  corpus: /(\d[\d,.]*\s*k?|thousands of|hundreds of|millions of)\s+(?:[a-z-]+\s+){0,2}(documents|docs|pdfs|files|pages|manuals|contracts|notes|articles|records|tickets)\b/i,
  // where it should run: "on my laptop" prefers the user's own machine; "offline" requires it
  wants_local: /\b(on my (own )?(laptop|machine|computer|pc|mac|desktop|workstation|server|hardware|gpu)|on (this|our own|our) (machine|computer|server|hardware)|locally|run (it )?local(ly)?|local (model|llm|only)|self[- ]hosted|on[- ]prem(ise|ises)?)\b/i,
  local_only: /\b(offline|air[- ]?gapped|no (cloud|internet)|without (the )?(cloud|internet)|(must|should|can) ?not leave (my|our|this|the) (machine|network|computer|laptop|premises)|never leaves? (my|our|this|the) (machine|network|computer|laptop|premises))\b/i,
  private_corpus: /\b(internal|private|confidential|proprietary|company|our|my|in-house|customers?)\b/i,   // their own documents: private by default
  writing_long: /\b(essay|article|blog post|report|white ?paper|documentation|chapter|story|long[- ]form|detailed (guide|explanation)|cover letter|proposal)\b/i,
  short_output: /\b(one word|yes or no|single (word|number|line)|just the (answer|number)|briefly|in one sentence)\b/i,
  agentic: /\b(browse|open the (website|page|url)|click|fill (in|out) the form|book|order|schedule|send (an )?email|run (it|the (tests|script|command))|execute|deploy|install)\b/i,
  batch: /\b(batch|bulk|all (the )?(files|rows|records|documents|emails)|every (file|row|record)|dataset|thousands?)\b/i,
  tools_search: /\b(latest|current|today|this week|recent|news|search (the )?(web|internet)|look up|up[- ]to[- ]date|what is the (price|weather|score))\b|https?:\/\//i,
  tools_code_exec: /\b(run (this|the) (code|script)|execute|calculate exactly|compute|simulate|plot|chart the data)\b/i,
  tools_files: /\b(my (files|folder|directory|repo|project)|this (folder|directory|repository)|read the file|in the codebase)\b/i,
  tools_db: /\b(query the (database|table|db)|sql query|select \* from|postgres|mysql|sqlite database)\b/i,
  tools_browser: /\b(open the (website|page|url)|click|fill (in|out) the form|screenshot of the page|navigate to)\b/i,
  sensitive: /\b(confidential|do not share|nda|patient|diagnosis|medical record|salary|payroll|iban|passport|ssn|social security|password|api key|internal only|proprietary)\b|[\w.+-]+@[\w-]+\.[a-z]{2,}|\b(\+?\d[\d\s().-]{8,}\d)\b|\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/i,
};

/**
 * Extract routing features from a task description (or raw prompt).
 * Never returns the text itself — only what a router needs.
 * request: when routing a real API call, { tools, json } from that call. What it needs is then
 * read from the call itself (tools sent, JSON output asked for), not guessed from the prompt's
 * words — "what's on today?" needs no tool-capable model unless the client sends tools.
 */
export function extractFeatures(task, { attachments = [], est_output_tokens = null, messages = [], request = null } = {}) {
  const text = typeof task === 'string' ? task : String(task?.prompt ?? task?.text ?? '');
  const historyChars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length), 0);
  const attachmentTokens = attachments.reduce((n, a) => n + Math.ceil((a.chars ?? a.size_bytes ?? 0) / 4) + (a.type === 'image' ? 1000 : 0), 0);
  const estInput = Math.max(1, Math.ceil((text.length + historyChars) / 4) + attachmentTokens);
  const hasImages = attachments.some((a) => a.type === 'image')
    || messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));

  let modality = 'text';
  if (CUES.image_generation.test(text)) modality = 'image';
  else if (CUES.audio.test(text)) modality = 'audio';

  let taskClass = 'chat';
  if (modality === 'image') taskClass = 'image_generation';
  else if (CUES.agentic.test(text)) taskClass = 'agentic';
  else if (CUES.code.test(text)) taskClass = 'code';
  else if (CUES.rag.test(text)) taskClass = 'rag';
  else if (CUES.extraction.test(text)) taskClass = 'extraction';
  else if (CUES.classification.test(text)) taskClass = 'classification';
  else if (CUES.translation.test(text)) taskClass = 'translation';
  else if (CUES.summarization.test(text)) taskClass = 'summarization';
  else if (CUES.reasoning_high.test(text)) taskClass = 'reasoning';
  else if (CUES.writing_long.test(text)) taskClass = 'writing';

  const reasoning = CUES.reasoning_high.test(text) || taskClass === 'reasoning' ? 'high'
    : (CUES.reasoning_medium.test(text) || taskClass === 'code' ? 'medium' : 'low');

  let estOutput = est_output_tokens;
  if (estOutput == null) {
    if (CUES.short_output.test(text) || taskClass === 'classification') estOutput = 64;
    else if (CUES.writing_long.test(text)) estOutput = 2000;
    else if (taskClass === 'code') estOutput = 1024;
    else if (taskClass === 'summarization' || taskClass === 'extraction') estOutput = Math.min(1024, Math.max(128, Math.ceil(estInput / 4)));
    else if (taskClass === 'translation') estOutput = Math.max(64, estInput);
    else estOutput = 512;
  }

  // RAG: one answer reads the question plus retrieved passages, not just the short task text
  const retrieval = CUES.rag.test(text);
  let corpus = null;
  if (retrieval) {
    const m = text.match(CUES.corpus);
    let documents = null;
    if (m) {
      const n = m[1].toLowerCase().replace(/[\s,]/g, '');
      documents = n.startsWith('thousands') ? 1000 : n.startsWith('hundreds') ? 100 : n.startsWith('millions') ? 1_000_000
        : Math.round(parseFloat(n) * (n.endsWith('k') ? 1000 : 1));
    }
    corpus = { documents: Number.isFinite(documents) ? documents : null, private: CUES.private_corpus.test(text) };
  }
  // (a real call routed by the gateway already carries its passages: its own size counts)
  const callInput = taskClass === 'rag' && !request ? Math.max(estInput, RAG_CALL_INPUT_TOKENS) : estInput;

  const tools = [];
  if (CUES.tools_search.test(text)) tools.push('web_search');
  if (CUES.tools_code_exec.test(text)) tools.push('code_execution');
  if (CUES.tools_files.test(text)) tools.push('filesystem');
  if (CUES.tools_db.test(text)) tools.push('database');
  if (CUES.tools_browser.test(text)) tools.push('browser');

  return {
    modality,
    task_class: taskClass,
    language: detectLanguage(text),
    est_input_tokens: callInput,
    est_output_tokens: estOutput,
    needs: {
      tools: request ? (request.tools?.length ?? 0) > 0 : tools.length > 0 || taskClass === 'agentic',
      tool_categories: tools,
      json: request ? Boolean(request.json) : CUES.extraction.test(text) && /json|schema|structured/i.test(text),
      vision: hasImages,
      long_context: estInput > 16_000,
      reasoning,
      retrieval,
    },
    corpus,
    // a real routed call states placement with its model name (auto-private), not in its prompt words
    locality: request ? null : CUES.local_only.test(text) ? 'required' : CUES.wants_local.test(text) ? 'preferred' : null,
    latency: CUES.batch.test(text) ? 'batch' : 'interactive',
    privacy: CUES.sensitive.test(text) ? 'sensitive' : 'normal',
  };
}

/* ------------------------------------------------------------------ ranking */

// 'local' and 'lan' are client-side tiers (your own machines): fully trusted by definition.
const TIER_SCORE = { unverified: 0, community: 0.4, verified: 0.8, attested: 1.0, lan: 1.0, local: 1.0 };
const TIER_ORDER = ['unverified', 'community', 'verified', 'attested'];
const tierRank = (t) => (t === 'local' || t === 'lan') ? TIER_ORDER.length : TIER_ORDER.indexOf(t);
const LANG_GRADE = { basic: 0.4, strong: 0.8, native: 1.0 };
const BENCH_FOR_CLASS = {
  code: /humaneval|mbpp|swe-?bench|livecodebench|codeforces/i,
  reasoning: /gsm8k|math|gpqa|arc|aime|mmlu[- ]?pro|bbh/i,
  chat: /arena|elo|mt-?bench|alpaca|ifeval/i,
  writing: /arena|elo|mt-?bench|ifeval/i,
  extraction: /ifeval|json|structured/i,
  classification: /mmlu|ifeval/i,
  translation: /flores|wmt|bleu|comet/i,
  summarization: /rouge|summ|arena/i,
  agentic: /swe-?bench|tau-?bench|bfcl|tool|agent/i,
  rag: /rag|squad|hotpot|natural ?questions|ruler|longbench|ifeval/i,
};

/**
 * Embedding and reranking models: catalogs often list them as plain "text", so the name decides too.
 * They index and re-order documents; they never answer a chat.
 */
const EMBED_NAME = /embed|\be5\b|e5-(large|base|small|mistral)|\bbge\b|bge-(m3|large|base|small)|\bgte\b|gte-|minilm|nomic-embed|jina-embed|snowflake-arctic-embed|text-embedding/i;
const RERANK_NAME = /rerank/i;
const nameOf = (o) => `${o.model?.name ?? ''} ${o.binding?.model_id ?? ''} ${o.offering_id ?? ''}`;
export const isEmbedder = (o) => o.modality === 'embedding' || (o.modality !== 'image' && EMBED_NAME.test(nameOf(o)) && !RERANK_NAME.test(nameOf(o)));
const isRetrievalModel = (o) => isEmbedder(o) || RERANK_NAME.test(nameOf(o));

/**
 * Embedder quality from size: very small models (tens of millions of parameters) retrieve noticeably
 * worse; ~0.1–1B is the usual sweet spot; multi-billion ones are a little better and slower.
 */
function embedQuality(o) {
  const p = o.model?.params_b;
  if (!p) return 0.6;
  return p < 0.05 ? 0.3 : p < 0.1 ? 0.5 : p <= 1.5 ? 0.8 : 0.9;
}
/** Ollama library pull count ("95.1M", "300.4K") as a number: a tie-break, never a score. */
function pullsOf(o) {
  const m = String(o.local?.pulls ?? '').match(/^([\d.]+)\s*([KMB]?)/i);
  return m ? parseFloat(m[1]) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2].toUpperCase()] ?? 1) : 0;
}

/** Generators described or named as built for answering from retrieved passages. */
const RAG_TUNED = /\b(rag|retrieval[- ]augmented|grounded generation|citations?)\b|chatqa|command[- ]?r\b|command-r/i;
const ragTuned = (o) => RAG_TUNED.test(`${nameOf(o)} ${o.model?.description ?? ''}`);
const MULTILINGUAL_EMBED = /m3|multilingual|\be5\b|e5-|qwen3-embedding|granite-embedding|jina|gte-multilingual|embeddinggemma|labse/i;

/**
 * The same model under several names or hosts takes one place in the first pass, and no node takes
 * more than two, so the shortlist offers real alternatives (and failover reaches another provider).
 */
const modelKey = (o) => String(o.model?.name ?? o.binding?.model_id ?? '').toLowerCase()
  .replace(/:latest$/, '').replace(/[-_ ]?(\d{4,8}|\(free\)|free)$/, '').replace(/[^a-z0-9.]/g, '');
function diversify(scored, limit) {
  const picked = [], models = new Set(), perNode = new Map();
  for (const c of scored) {
    if (picked.length >= limit) break;
    const k = modelKey(c.offering), n = c.offering.node_id;
    if (models.has(k) || (perNode.get(n) ?? 0) >= 2) continue;
    picked.push(c); models.add(k); perNode.set(n, (perNode.get(n) ?? 0) + 1);
  }
  for (const c of scored) { if (picked.length >= limit) break; if (!picked.includes(c)) picked.push(c); }
  return picked;
}

/**
 * Memory a model needs to run locally at Ollama's default 4-bit quantization, in GB — an estimate:
 * ~0.6 GB per billion parameters for the weights, plus runtime and a default-size context cache.
 * (8B ≈ 6 GB, 70B ≈ 46 GB.) Real use varies with quantization and context length.
 */
export function memoryGbFor(paramsB) {
  return Math.round((paramsB * 0.6 + 0.5 + Math.min(4, paramsB * 0.06)) * 10) / 10;
}
const sizeParams = (tag) => {
  const m = String(tag).match(/^(\d+(?:\.\d+)?)([mb])$/i);
  return m ? (m[2].toLowerCase() === 'b' ? Number(m[1]) : Number(m[1]) / 1000) : null;
};
/** A locally-run model's sizes (Ollama tags like "8b", "270m") with their memory estimate, smallest first. */
export function localSizes(o) {
  if (!o.local) return [];
  const tags = o.local.sizes?.length ? o.local.sizes : (o.model?.params_b ? [`${o.model.params_b}b`] : []);
  return tags.map((tag) => ({ tag, params_b: sizeParams(tag) })).filter((x) => x.params_b)
    .sort((a, b) => a.params_b - b.params_b).map((x) => ({ ...x, memory_gb: memoryGbFor(x.params_b) }));
}
const sizesLine = (sizes) => sizes.map((x) => `${x.tag} ~${x.memory_gb} GB`).join(', ');

/** Quality prior of a ~8B model: enough for light work (see isLight). */
const LIGHT_ENOUGH = 0.33;
/** Quality prior of a ~50B model: answering from retrieved passages gains little beyond it. */
const RAG_ENOUGH = 0.6;

/** Quick, simple work a small model on the user's own machine handles well. */
export function isLight(features) {
  return features.needs.reasoning === 'low' && !features.needs.long_context && !features.needs.tools
    && !['code', 'agentic', 'reasoning', 'writing'].includes(features.task_class);
}

/** Per-task weights (must sum to 1). */
export function weightsFor(features, preset = null) {
  let w = { quality: 0.35, price: 0.25, trust: 0.20, perf: 0.20 };
  const tc = features.task_class;
  if (tc === 'reasoning' || tc === 'code' || tc === 'agentic') w = { quality: 0.5, price: 0.15, trust: 0.2, perf: 0.15 };
  if (tc === 'classification' || tc === 'extraction' || tc === 'translation') w = { quality: 0.25, price: 0.4, trust: 0.15, perf: 0.2 };
  if (tc === 'rag') w = { quality: 0.35, price: 0.3, trust: 0.15, perf: 0.2 };   // many answers, each from a few passages
  if (features.latency === 'batch') w = { ...w, perf: 0.05, price: w.price + w.perf - 0.05 };
  if (preset === 'cheap') w = { quality: 0.15, price: 0.55, trust: 0.15, perf: 0.15 };
  if (preset === 'fast') w = { quality: 0.2, price: 0.15, trust: 0.15, perf: 0.5 };
  if (preset === 'quality') w = { quality: 0.6, price: 0.05, trust: 0.2, perf: 0.15 };
  if (preset === 'private') {
    // The pool is the user's own machines, so privacy needs no weight: rank for the task as
    // `auto` does (a hard task goes to the strongest machine). Trust keeps a floor for pools
    // that also hold community-tier nodes.
    const trust = Math.max(w.trust, 0.3);
    const k = (1 - trust) / (1 - w.trust);
    w = { quality: w.quality * k, price: w.price * k, trust, perf: w.perf * k };
  }
  return w;
}

const NAME_CUES = [
  [/\b(nano|lite|tiny|mini|small|flash|haiku|instant|1b|3b|4b|7b|8b)\b/i, -0.15],
  [/\b(pro|opus|max|ultra|large|70b|72b|120b|235b|405b|reasoning|thinking|r1)\b/i, 0.15],
  [/:free\b|\(free\)|-free\b/i, -0.1],
];

/**
 * Quality prior, labeled by basis: declared parameter count (best), a relevant claimed/
 * attested benchmark (refines it), or — for proprietary listings that declare neither —
 * output-price and name cues (weak, and said so in the explanation).
 */
function qualityPrior(o, features) {
  const params = o.model?.params_b ?? null;
  let q;
  let basis;
  if (params) {
    q = Math.min(1, Math.log10(params + 1) / Math.log10(700));
    basis = 'declared size';
  } else {
    const out = o.pricing?.output_per_mtok ?? 0;
    q = out > 0 ? Math.min(0.8, 0.3 + 0.12 * Math.log10(out * 10 + 1)) : 0.3;   // $0.1 → 0.30, $1 → 0.43, $10 → 0.54, $60 → 0.63
    for (const [re, delta] of NAME_CUES) if (re.test(o.model?.name ?? '')) q += delta;
    q = Math.max(0.1, Math.min(0.8, q));
    basis = 'price/name cues (size undeclared)';
  }
  const re = BENCH_FOR_CLASS[features.task_class];
  const bench = (o.benchmarks ?? []).find((b) => re?.test(b.suite ?? ''));
  if (bench && Number.isFinite(bench.score)) {
    const s = bench.score > 1 ? bench.score / 100 : bench.score;   // percent or fraction
    q = 0.5 * q + 0.5 * Math.min(1, s) * (bench.basis === 'attested' ? 1 : 0.9);
    basis = `${bench.basis} benchmark ${bench.suite}`;
  }
  if (features.needs.reasoning === 'high' && params && params < 20) q *= 0.7;  // small models struggle on hard reasoning
  return { q, basis };
}

function perfScore(o, features) {
  const obs = o.observed ?? {};
  const ttft = obs.ttft_ms?.p50 ?? o.serving?.expected_ttft_ms?.p50 ?? null;
  const tps = (obs.tps > 0 ? obs.tps : null) ?? o.serving?.expected_tps?.p50 ?? null;
  const measured = obs.ttft_ms?.p50 != null || obs.tps > 0;
  const ttftScore = ttft == null ? 0.4 : Math.max(0, 1 - ttft / 3000);
  const tpsScore = tps == null ? 0.4 : Math.min(1, tps / 150);
  const blended = features.latency === 'interactive' ? 0.6 * ttftScore + 0.4 * tpsScore : 0.2 * ttftScore + 0.8 * tpsScore;
  return measured ? blended : blended * 0.85;   // claims are worth less than measurements
}

function languageFit(o, lang) {
  if (lang === 'en') return 1;
  const decl = (o.serving?.languages ?? []).find((l) => l.lang === lang);
  if (decl) return LANG_GRADE[decl.grade] ?? 0.5;
  return (o.serving?.languages ?? []).length ? 0.2 : 0.5;   // undeclared: unknown, not disqualified
}

/** EU member states plus Iceland, Liechtenstein and Norway (ISO 3166-1 alpha-2). */
export const EEA_COUNTRIES = Object.freeze([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO',
]);

/** Expand a jurisdiction filter: 'eea' (alias 'eu') or a comma list of country codes. */
export function jurisdictionCountries(spec) {
  if (!spec) return null;
  const parts = String(spec).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  return new Set(parts.flatMap((p) => (p === 'EEA' || p === 'EU' ? EEA_COUNTRIES : [p])));
}

/**
 * Is the offering's operator in the jurisdiction? Registered nodes declare their country; imports of
 * known providers carry an inferred one (`jurisdiction.basis`). No country counts as outside. When the
 * registry's server-location check found the API host in a country outside the jurisdiction (and not
 * behind a CDN, and the geolocation wasn't contradicted by latency), the offering is excluded too.
 */
export function inJurisdiction(offering, spec) {
  const allowed = jurisdictionCountries(spec);
  if (!allowed) return true;
  const country = offering.jurisdiction?.country;
  if (!country || !allowed.has(String(country).toUpperCase())) return false;
  const loc = offering.jurisdiction?.location;
  if (loc?.server_country && !loc.cdn && loc.verdict !== 'inconsistent' && !allowed.has(String(loc.server_country).toUpperCase())) return false;
  return true;
}

/**
 * How long a client should wait for an offering to *start* answering before failing over to the next
 * candidate. Built from what the registry measured (time to first token, throughput), the prompt size,
 * and — for non-streamed requests, whose headers only arrive once the whole answer is done — the
 * expected generation time. Bounded to [floorMs, ceilMs]. Once a stream has started it is never cut.
 */
export function responseBudgetMs(offering, { stream = false, promptTokens = 0, maxTokens = 512, floorMs = 15_000, ceilMs = 180_000 } = {}) {
  const ttft = offering?.observed?.ttft_ms?.p95 ?? (offering?.observed?.ttft_ms?.p50 ? offering.observed.ttft_ms.p50 * 2 : null)
    ?? offering?.serving?.expected_ttft_ms?.p95 ?? 10_000;
  const tps = (offering?.observed?.tps > 0 ? offering.observed.tps : null) ?? offering?.serving?.expected_tps?.p50 ?? 10;
  let budget = 3 * ttft + promptTokens * 15;                    // ~15 ms per prompt token covers CPU prefill
  if (!stream) budget += (maxTokens / tps) * 1000 * 1.5;          // the whole answer before the first byte
  return Math.round(Math.min(ceilMs, Math.max(floorMs, budget)));
}

/** fetch() that gives up if the response hasn't *started* within budgetMs; the body may then take as long as it needs. */
export async function fetchWithin(url, init, budgetMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`no response within ${Math.round(budgetMs / 1000)} s`)), budgetMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    throw controller.signal.aborted ? controller.signal.reason : err;
  } finally {
    clearTimeout(timer);
  }
}

const AUTO_PRESETS = Object.freeze({ cheap: 'cheap', fast: 'fast', quality: 'quality', private: 'private' });

/** Auto-routing model names listed by the gateway and the Ollama router (any auto-<country> also works). */
export const AUTO_MODEL_NAMES = Object.freeze(['auto', 'auto-cheap', 'auto-fast', 'auto-quality', 'auto-private', 'auto-eu', 'auto-ca']);

/**
 * Parse an auto-routing model name: `auto`, `auto-cheap|fast|quality|private`, or `auto-<where>`
 * with <where> = `eu` / `eea` or a two-letter country code (`auto-ca`, `auto-de`).
 * `prefix` is the namespace ('onp/' in the gateway, '' in the Ollama router).
 * Returns { preset, jurisdiction } or null when the name isn't an auto model.
 */
export function parseAutoModel(name, prefix = '') {
  if (typeof name !== 'string' || !name.startsWith(`${prefix}auto`)) return null;
  const rest = name.slice(prefix.length + 4);
  if (rest === '') return { preset: null, jurisdiction: null };
  if (!rest.startsWith('-')) return null;
  const tag = rest.slice(1).toLowerCase();
  if (tag in AUTO_PRESETS) return { preset: AUTO_PRESETS[tag], jurisdiction: null };
  if (tag === 'eu' || tag === 'eea') return { preset: null, jurisdiction: 'eea' };
  if (/^[a-z]{2}$/.test(tag)) return { preset: null, jurisdiction: tag.toUpperCase() };
  return null;
}

/**
 * Rank offerings for extracted features under a policy.
 * policy: { min_tier, max_input_per_mtok, max_total_usd, region, jurisdiction, prefer_local, preset, limit }
 * jurisdiction: 'eea' or country codes; the user's own machines (local / LAN) always qualify.
 */
export function recommend(offerings, features, policy = {}) {
  const minTier = TIER_ORDER.indexOf(policy.min_tier ?? 'unverified');
  const needCtx = Math.ceil((features.est_input_tokens + features.est_output_tokens) * 1.15);
  const required = [];
  if (features.needs.tools) required.push('tool_calls');
  if (features.needs.json) required.push('json_mode');
  if (features.needs.vision) required.push('vision');

  const rejected = {};
  const reject = (why) => { rejected[why] = (rejected[why] ?? 0) + 1; return false; };
  const candidates = offerings.filter((o) => {
    if (o.modality !== features.modality && !(features.modality === 'text' && o.modality === 'multimodal')) return reject('modality');
    if (features.modality !== 'embedding' && isRetrievalModel(o)) return reject('embedding_model');
    if (tierRank(o.tier) < minTier) return reject('tier');
    if ((o.pricing?.input_per_mtok ?? 0) > (policy.max_input_per_mtok ?? Infinity)) return reject('price');
    const ctx = o.serving?.context_window;
    if (ctx && ctx < needCtx) return reject('context');
    const sup = o.serving?.supports ?? [];
    if (required.some((r) => !sup.includes(r))) return reject('capabilities');
    if (features.privacy === 'sensitive') {
      const dp = o.data_policy;
      if (!dp || dp.training_on_inputs === true || (dp.retention && dp.retention !== 'none')) return reject('data_policy');
    }
    if (policy.region) {
      const pins = o.data_policy?.region_pinning ?? [];
      if (pins.length && !pins.includes(policy.region)) return reject('region');
    }
    if (policy.jurisdiction && !o.local && !inJurisdiction(o, policy.jurisdiction)) return reject('jurisdiction');
    if (features.locality === 'required' && !o.local) return reject('not_local');
    if (policy.local_memory_gb && o.local) {
      const sizes = localSizes(o);
      if (sizes.length && !sizes.some((x) => x.memory_gb <= policy.local_memory_gb)) return reject('memory');
    }
    return true;
  });

  const w = weightsFor(features, policy.preset ?? null);
  // auto-private, simple request: a mid-size model (~8B) is good enough, so a bigger one earns
  // nothing more and the user's own machine wins; demanding work still goes to the strongest.
  // RAG: past ~50B a bigger model earns nothing more; price, speed, trust and RAG tuning decide.
  const qualityCap = policy.preset === 'private' && isLight(features) ? LIGHT_ENOUGH
    : features.task_class === 'rag' ? RAG_ENOUGH : 1;
  const maxPrice = Math.max(...candidates.map((o) => o.pricing?.input_per_mtok ?? 0), 0.000001);
  const scored = candidates.map((o) => {
    const sizes = localSizes(o);
    const fits = policy.local_memory_gb ? sizes.filter((x) => x.memory_gb <= policy.local_memory_gb) : [];
    const pick = fits.at(-1) ?? null;
    const prior = qualityPrior(pick ? { ...o, model: { ...o.model, params_b: pick.params_b } } : o, features);
    const tuned = features.task_class === 'rag' && ragTuned(o);
    const components = {
      quality: round2(Math.min(1, Math.min(qualityCap, prior.q) * languageFit(o, features.language) + (tuned ? 0.1 : 0))),
      price: round2(1 - (o.pricing?.input_per_mtok ?? maxPrice) / maxPrice),
      trust: round2(0.7 * (TIER_SCORE[o.tier] ?? 0) + 0.3 * (o.observed?.probe_success ?? 0)),
      perf: round2(perfScore(o, features)),
    };
    let score = Object.entries(w).reduce((s, [k, wk]) => s + wk * components[k], 0);
    if (policy.prefer_local && o.local && (policy.preset !== 'private' || isLight(features))) score += 0.1;
    if (features.locality === 'preferred' && o.local) score += 0.15;   // the task asked to run on the user's own machine
    const bounds = estimateBounds(o.pricing ?? {}, features.est_input_tokens, features.est_output_tokens);
    const local_fit = sizes.length ? { sizes: sizes.map(({ tag, memory_gb }) => ({ tag, memory_gb })), pick: pick?.tag ?? null,
      ...(pick ? { run: `ollama run ${o.binding?.model_id ?? o.model?.name}:${pick.tag}` } : {}), basis: '4-bit estimate' } : null;
    return { offering: o, score: round2(score), components, basis: prior.basis, rag_tuned: tuned, local_fit, estimate: { currency: o.pricing?.currency ?? 'USD', ...bounds } };
  }).filter((c) => c.estimate.max <= (policy.max_total_usd ?? Infinity));

  // Deterministic order: score, then cheaper estimate, then larger model, then id.
  scored.sort((a, b) => (b.score - a.score)
    || (a.estimate.max - b.estimate.max)
    || ((b.offering.model?.params_b ?? 0) - (a.offering.model?.params_b ?? 0))
    || `${a.offering.node_id}/${a.offering.offering_id}`.localeCompare(`${b.offering.node_id}/${b.offering.offering_id}`));
  const limit = policy.limit ?? 3;
  const top = diversify(scored, limit).map((c) => ({
    offering: `${c.offering.node_id}/${c.offering.offering_id}`,
    model: c.offering.model?.name,
    artifact: c.offering.model?.artifact ?? null,
    node_id: c.offering.node_id,
    tier: c.offering.tier,
    card_revision: c.offering.card_revision,
    endpoint: c.offering.endpoints?.openai ?? null,
    model_id: c.offering.binding?.model_id ?? null,
    score: c.score,
    components: c.components,
    quality_basis: c.basis,
    estimate: c.estimate,
    hardware: c.offering.hardware ?? null,
    measured: {
      ttft_ms: c.offering.observed?.ttft_ms?.p50 ?? null,
      tps: c.offering.observed?.tps ?? null,
    },
    ...(c.local_fit ? { local_fit: c.local_fit } : {}),
    reasons: explain(c, features, w, policy),
  }));

  return {
    features,
    query: equivalentQuery(features, policy, required, needCtx),
    weights: w,
    considered: offerings.length,
    eligible: candidates.length,
    rejected,
    recommendations: top,
    scenario: suggestScenario(scored, features, policy),
    tools: suggestTools(features),
    ...(features.needs?.retrieval ? { roles: { embed: rankEmbedders(offerings, features, policy, minTier), generate: 'recommendations' } } : {}),
  };
}

/**
 * RAG needs an embedding model as well as a generator: rank embedders for indexing the collection.
 * Fit favours multilingual models for non-English text and the user's own machine for a private
 * collection; the indexing estimate assumes ~1,000 tokens per document (stated in the output).
 */
/** Rank embedding models for indexing (also used by the gateway's /v1/embeddings). Full list, best first. */
export function recommendEmbedders(offerings, features, policy = {}) {
  return rankEmbedders(offerings, features, policy, TIER_ORDER.indexOf(policy.min_tier ?? 'unverified'), policy.limit ?? Infinity);
}

function rankEmbedders(offerings, features, policy, minTier, limit = 3) {
  const docs = features.corpus?.documents ?? null;
  const tokens = docs ? docs * TOKENS_PER_DOCUMENT : null;
  const pool = offerings.filter((o) => isEmbedder(o)
    && (features.locality !== 'required' || o.local)
    && tierRank(o.tier) >= minTier
    && !(policy.local_memory_gb && o.local && localSizes(o).length && !localSizes(o).some((x) => x.memory_gb <= policy.local_memory_gb))
    && (o.pricing?.input_per_mtok ?? 0) <= (policy.max_input_per_mtok ?? Infinity)
    && (!policy.jurisdiction || o.local || inJurisdiction(o, policy.jurisdiction)));
  const maxPrice = Math.max(...pool.map((o) => o.pricing?.input_per_mtok ?? 0), 0.000001);
  const multilingual = features.language !== 'en';
  const ranked = pool.map((o) => {
    const local = Boolean(o.local);
    const fit = 0.5 + (multilingual && MULTILINGUAL_EMBED.test(nameOf(o)) ? 0.3 : 0) + (features.corpus?.private && local ? 0.2 : 0)
      + (features.locality && local ? 0.2 : 0);
    const components = {
      fit: round2(Math.min(1, fit)),
      quality: embedQuality(o),
      price: round2(1 - (o.pricing?.input_per_mtok ?? maxPrice) / maxPrice),
      trust: round2(0.7 * (TIER_SCORE[local ? 'local' : o.tier] ?? 0) + 0.3 * (o.observed?.probe_success ?? 0)),
    };
    const score = round2(0.35 * components.fit + 0.2 * components.quality + 0.3 * components.price + 0.15 * components.trust);
    const reasons = [];
    if (local) reasons.push(`runs on your machine${o.local.run ? ` (${o.local.run})` : ''}${localSizes(o).length ? `, ${sizesLine(localSizes(o))}` : ''} — documents never leave it`);
    else reasons.push(`hosted by ${o.node_id}${o.jurisdiction?.country ? ` (${o.jurisdiction.country})` : ''}`);
    if (multilingual && MULTILINGUAL_EMBED.test(nameOf(o))) reasons.push(`multilingual model, for ${features.language} text`);
    if (o.source === 'import') reasons.push('imported catalog listing — unprobed');
    const indexing = local ? { usd: 0, basis: 'your own hardware' }
      : tokens && o.pricing?.input_per_mtok != null ? { usd: round6(tokens * o.pricing.input_per_mtok / 1e6), basis: `${docs.toLocaleString('en-US')} documents × ~${TOKENS_PER_DOCUMENT} tokens at the listed price` }
      : o.pricing?.input_per_mtok == null ? { usd: null, basis: 'price not published' } : null;
    if (o.local?.pulls) reasons.push(`${o.local.pulls} Ollama pulls`);
    return { offering: `${o.node_id}/${o.offering_id}`, model: o.model?.name, node_id: o.node_id, tier: o.tier, model_id: o.binding?.model_id ?? null,
      endpoint: o.endpoints?.openai ?? null, score, components, reasons, ...(indexing ? { indexing_estimate: indexing } : {}), popularity: pullsOf(o) };
  }).sort((a, b) => b.score - a.score || b.popularity - a.popularity || a.offering.localeCompare(b.offering))
    .map(({ popularity: _p, ...r }) => r);
  return ranked.slice(0, limit);
}

function explain(c, features, w, policy = {}) {
  const o = c.offering;
  const r = [];
  const dominant = Object.entries(c.components).sort((a, b) => (w[b[0]] * b[1]) - (w[a[0]] * a[1]))[0]?.[0];
  if (dominant === 'price') r.push(`price-led: ${fmtPrice(o.pricing)}`);
  if (dominant === 'quality') r.push(`quality-led for ${features.task_class} — basis: ${c.basis}${o.model?.params_b ? `, ${o.model.params_b}B` : ''}${features.task_class === 'rag' && (o.model?.params_b ?? 0) > 50 ? ' (size counted up to ~50B for RAG)' : ''}`);
  if (dominant === 'trust') r.push(`${o.tier} tier with ${Math.round((o.observed?.probe_success ?? 0) * 100)}% probe pass`);
  if (dominant === 'perf') r.push(o.observed?.ttft_ms?.p50 != null ? `measured ${o.observed.ttft_ms.p50}ms TTFT` : 'best claimed latency (unmeasured)');
  if (features.language !== 'en') {
    const decl = (o.serving?.languages ?? []).find((l) => l.lang === features.language);
    r.push(decl ? `${features.language} declared ${decl.grade}` : `${features.language} support undeclared`);
  }
  if (o.hardware?.accelerators?.length) r.push(`on ${o.hardware.accelerators.map((a) => `${a.count}× ${a.type}`).join(' + ')} (${o.hardware.basis ?? 'claimed'})`);
  if (o.jurisdiction?.country) {
    const tags = [EEA_COUNTRIES.includes(String(o.jurisdiction.country).toUpperCase()) ? 'EEA' : null, o.jurisdiction.basis === 'inferred' ? 'inferred' : null].filter(Boolean);
    r.push(`operator in ${o.jurisdiction.country}${tags.length ? ` (${tags.join(', ')})` : ''}`);
  }
  if (c.local_fit) {
    const pick = c.local_fit.sizes.find((x) => x.tag === c.local_fit.pick);
    r.push(pick
      ? `runs on your machine: ${pick.tag} needs ~${pick.memory_gb} GB RAM/VRAM, within ${policy.local_memory_gb} GB (4-bit estimate)`
      : `runs on your machine — memory needed (4-bit estimate): ${sizesLine(c.local_fit.sizes)}`);
  }
  if (o.local && features.locality) r.push(features.locality === 'required' ? 'runs offline on your own machine, as the task requires' : 'runs on your own machine, as the task asked');
  if (c.rag_tuned) r.push('described as built for answering from retrieved documents (RAG)');
  if (o.source === 'import') r.push('imported catalog listing — unprobed');
  return r;
}

function equivalentQuery(features, policy, required, needCtx) {
  const q = { modality: features.modality === 'text' ? 'text' : features.modality, min_context: needCtx };
  if (required.length) q.supports = required.join(',');
  if (features.language !== 'en') q.lang = `${features.language}:strong`;
  if (policy.min_tier) q.tier = policy.min_tier;
  if (policy.max_input_per_mtok != null) q.max_input_price = policy.max_input_per_mtok;
  if (policy.local_memory_gb) q.local_memory_gb = policy.local_memory_gb;
  if (policy.jurisdiction) q.jurisdiction = policy.jurisdiction;
  return q;
}

/** Propose an ONP-6 scenario when a two-tier chain is likely to beat one call. */
function suggestScenario(scored, features, policy) {
  if (scored.length < 2) return null;
  const best = scored[0];
  const cheap = [...scored].sort((a, b) => a.estimate.max - b.estimate.max)[0];
  if (cheap.offering === best.offering) return null;
  const savings = best.estimate.max - cheap.estimate.max;
  if (features.needs.reasoning === 'high' || features.task_class === 'writing') {
    return {
      onp_scenario: '0.1',
      name: features.task_class === 'writing' ? 'draft-then-refine' : 'triage-then-expert',
      why: features.task_class === 'writing'
        ? 'cheap model drafts, strong model refines — most tokens spent at the low price'
        : 'cheap model classifies difficulty; hard cases escalate to the strongest fit',
      roles: {
        cheap: { node_id: cheap.offering.node_id, offering_id: cheap.offering.offering_id },
        strong: { node_id: best.offering.node_id, offering_id: best.offering.offering_id },
      },
      steps: features.task_class === 'writing'
        ? [{ id: 'draft', role: 'cheap', input: '$user' }, { id: 'refine', role: 'strong', input: 'draft', prompt: 'Improve the draft; keep its structure.' }]
        : [{ id: 'triage', role: 'cheap', input: '$user', prompt: 'Answer if simple; otherwise output route=complex' },
           { id: 'expert', role: 'strong', if: "triage.route == 'complex'", input: '$user' }],
      policy: { max_total_usd: policy.max_total_usd ?? round6(best.estimate.max * 1.5) },
      estimated_savings_usd_if_simple: round6(Math.max(0, savings)),
    };
  }
  return null;
}

/** Tool categories → well-known MCP servers (seed list; a registry MCP-directory import replaces it). */
const TOOL_SEED = {
  web_search: [{ name: 'fetch', install: 'uvx mcp-server-fetch' }, { name: 'brave-search', install: 'npx -y @modelcontextprotocol/server-brave-search' }],
  code_execution: [{ name: 'python-sandbox', install: 'uvx mcp-run-python' }],
  filesystem: [{ name: 'filesystem', install: 'npx -y @modelcontextprotocol/server-filesystem <dir>' }],
  database: [{ name: 'sqlite', install: 'uvx mcp-server-sqlite --db-path <file>' }, { name: 'postgres', install: 'npx -y @modelcontextprotocol/server-postgres <url>' }],
  browser: [{ name: 'playwright', install: 'npx -y @playwright/mcp' }],
};
export function suggestTools(features) {
  const cats = features.needs?.tool_categories ?? [];
  if (!cats.length) return [];
  return cats.map((category) => ({ category, source: 'seed', servers: TOOL_SEED[category] ?? [] }));
}

const round2 = (n) => Math.round(n * 100) / 100;
const fmtPrice = (p) => p?.input_per_mtok != null ? `$${p.input_per_mtok}/MTok in` : 'free';
