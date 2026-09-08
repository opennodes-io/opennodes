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
 */
export function extractFeatures(task, { attachments = [], est_output_tokens = null, messages = [] } = {}) {
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
    est_input_tokens: estInput,
    est_output_tokens: estOutput,
    needs: {
      tools: tools.length > 0 || taskClass === 'agentic',
      tool_categories: tools,
      json: CUES.extraction.test(text) && /json|schema|structured/i.test(text),
      vision: hasImages,
      long_context: estInput > 16_000,
      reasoning,
    },
    latency: CUES.batch.test(text) ? 'batch' : 'interactive',
    privacy: CUES.sensitive.test(text) ? 'sensitive' : 'normal',
  };
}

/* ------------------------------------------------------------------ ranking */

const TIER_SCORE = { unverified: 0, community: 0.4, verified: 0.8, attested: 1.0 };
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
};

/** Per-task weights (must sum to 1). */
export function weightsFor(features, preset = null) {
  let w = { quality: 0.35, price: 0.25, trust: 0.20, perf: 0.20 };
  const tc = features.task_class;
  if (tc === 'reasoning' || tc === 'code' || tc === 'agentic') w = { quality: 0.5, price: 0.15, trust: 0.2, perf: 0.15 };
  if (tc === 'classification' || tc === 'extraction' || tc === 'translation') w = { quality: 0.25, price: 0.4, trust: 0.15, perf: 0.2 };
  if (features.latency === 'batch') w = { ...w, perf: 0.05, price: w.price + w.perf - 0.05 };
  if (preset === 'cheap') w = { quality: 0.15, price: 0.55, trust: 0.15, perf: 0.15 };
  if (preset === 'fast') w = { quality: 0.2, price: 0.15, trust: 0.15, perf: 0.5 };
  if (preset === 'quality') w = { quality: 0.6, price: 0.05, trust: 0.2, perf: 0.15 };
  if (preset === 'private') w = { quality: 0.25, price: 0.15, trust: 0.45, perf: 0.15 };
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

/**
 * Rank offerings for extracted features under a policy.
 * policy: { min_tier, max_input_per_mtok, max_total_usd, region, prefer_local, preset, limit }
 */
export function recommend(offerings, features, policy = {}) {
  const tiers = ['unverified', 'community', 'verified', 'attested'];
  const minTier = tiers.indexOf(policy.min_tier ?? 'unverified');
  const needCtx = Math.ceil((features.est_input_tokens + features.est_output_tokens) * 1.15);
  const required = [];
  if (features.needs.tools) required.push('tool_calls');
  if (features.needs.json) required.push('json_mode');
  if (features.needs.vision) required.push('vision');

  const rejected = {};
  const reject = (why) => { rejected[why] = (rejected[why] ?? 0) + 1; return false; };
  const candidates = offerings.filter((o) => {
    if (o.modality !== features.modality && !(features.modality === 'text' && o.modality === 'multimodal')) return reject('modality');
    if (tiers.indexOf(o.tier) < minTier) return reject('tier');
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
    return true;
  });

  const w = weightsFor(features, policy.preset ?? null);
  const maxPrice = Math.max(...candidates.map((o) => o.pricing?.input_per_mtok ?? 0), 0.000001);
  const scored = candidates.map((o) => {
    const prior = qualityPrior(o, features);
    const components = {
      quality: round2(prior.q * languageFit(o, features.language)),
      price: round2(1 - (o.pricing?.input_per_mtok ?? maxPrice) / maxPrice),
      trust: round2(0.7 * (TIER_SCORE[o.tier] ?? 0) + 0.3 * (o.observed?.probe_success ?? 0)),
      perf: round2(perfScore(o, features)),
    };
    let score = Object.entries(w).reduce((s, [k, wk]) => s + wk * components[k], 0);
    if (policy.prefer_local && o.local) score += 0.1;
    const bounds = estimateBounds(o.pricing ?? {}, features.est_input_tokens, features.est_output_tokens);
    return { offering: o, score: round2(score), components, basis: prior.basis, estimate: { currency: o.pricing?.currency ?? 'USD', ...bounds } };
  }).filter((c) => c.estimate.max <= (policy.max_total_usd ?? Infinity));

  // Deterministic order: score, then cheaper estimate, then larger model, then id.
  scored.sort((a, b) => (b.score - a.score)
    || (a.estimate.max - b.estimate.max)
    || ((b.offering.model?.params_b ?? 0) - (a.offering.model?.params_b ?? 0))
    || `${a.offering.node_id}/${a.offering.offering_id}`.localeCompare(`${b.offering.node_id}/${b.offering.offering_id}`));
  const limit = policy.limit ?? 3;
  const top = scored.slice(0, limit).map((c) => ({
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
    reasons: explain(c, features, w),
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
  };
}

function explain(c, features, w) {
  const o = c.offering;
  const r = [];
  const dominant = Object.entries(c.components).sort((a, b) => (w[b[0]] * b[1]) - (w[a[0]] * a[1]))[0]?.[0];
  if (dominant === 'price') r.push(`price-led: ${fmtPrice(o.pricing)}`);
  if (dominant === 'quality') r.push(`quality-led for ${features.task_class} — basis: ${c.basis}${o.model?.params_b ? `, ${o.model.params_b}B` : ''}`);
  if (dominant === 'trust') r.push(`${o.tier} tier with ${Math.round((o.observed?.probe_success ?? 0) * 100)}% probe pass`);
  if (dominant === 'perf') r.push(o.observed?.ttft_ms?.p50 != null ? `measured ${o.observed.ttft_ms.p50}ms TTFT` : 'best claimed latency (unmeasured)');
  if (features.language !== 'en') {
    const decl = (o.serving?.languages ?? []).find((l) => l.lang === features.language);
    r.push(decl ? `${features.language} declared ${decl.grade}` : `${features.language} support undeclared`);
  }
  if (o.hardware?.accelerators?.length) r.push(`on ${o.hardware.accelerators.map((a) => `${a.count}× ${a.type}`).join(' + ')} (${o.hardware.basis ?? 'claimed'})`);
  if (o.source === 'import') r.push('imported catalog listing — unprobed');
  return r;
}

function equivalentQuery(features, policy, required, needCtx) {
  const q = { modality: features.modality === 'text' ? 'text' : features.modality, min_context: needCtx };
  if (required.length) q.supports = required.join(',');
  if (features.language !== 'en') q.lang = `${features.language}:strong`;
  if (policy.min_tier) q.tier = policy.min_tier;
  if (policy.max_input_per_mtok != null) q.max_input_price = policy.max_input_per_mtok;
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
