// DS-IMP-01: seed importers so search is useful before any real registration.
// Imported records enter as unverified, unsigned, source='import', and are
// excluded from verified tiers until claimed by their operator.
import { readFileSync } from 'node:fs';
import { validateCard } from '@opennodes/core';
import { ARTIFACT } from './vendors.js';

const { version: REGISTRY_VERSION } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 100);
const vendorSlug = (s) => slug(s).replace(/[._]/g, '-');
/** The value as a string if it is a concrete http(s) URL, else undefined. Templated
 *  per-account URLs (models.dev writes `https://${DATABRICKS_HOST}/...`) have no single base. */
const httpsUrl = (v) => {
  if (typeof v !== 'string' || v.includes('${')) return undefined;
  try { return ['https:', 'http:'].includes(new URL(v).protocol) ? v : undefined; } catch { return undefined; }
};

/** Map input/output modality arrays (the shape both HF and OpenRouter use) to the ONP enum. */
export function mapModalities(inputs = ['text'], outputs = ['text']) {
  const out = new Set(outputs);
  if (out.has('image')) return 'image';
  if (out.has('video')) return 'video';
  if (out.has('audio')) return 'audio';
  if (out.has('embedding') || out.has('embeddings')) return 'embedding';
  return inputs.some((i) => i !== 'text') ? 'multimodal' : 'text';
}

const PIPELINE_TAG_MODALITY = {
  'text-generation': 'text', 'text2text-generation': 'text', 'conversational': 'text',
  'image-text-to-text': 'multimodal', 'visual-question-answering': 'multimodal',
  'text-to-image': 'image', 'image-to-image': 'image',
  'text-to-video': 'video', 'image-to-video': 'video', 'image-text-to-video': 'video',
  'text-to-speech': 'audio', 'automatic-speech-recognition': 'audio', 'audio-to-audio': 'audio',
  'feature-extraction': 'embedding', 'sentence-similarity': 'embedding',
};

/** Per-token price strings/values -> USD per MTok. Values >= 0.01 are assumed per-MTok already. */
const perMtok = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round((n < 0.01 ? n * 1_000_000 : n) * 1e6) / 1e6;
};

async function saveImportedCard(store, nodeId, origin, sourceRef, card) {
  const errors = validateCard(card);
  if (errors.length) return errors[0];
  await store.upsertNode(nodeId, origin, sourceRef, 'indexed', 'import');
  await store.saveRevision(nodeId, card.revision, card, false);
  return null;
}

/**
 * OpenAI-compatible API bases for major providers whose models.dev entry has no `api`
 * (models.dev omits it when a dedicated AI SDK package knows the URL). Each checked
 * against the provider's docs and live (401 on unauthenticated /models), 2026-10-19.
 */
export const MODELS_DEV_API_BASES = {
  groq: 'https://api.groq.com/openai/v1',
  togetherai: 'https://api.together.xyz/v1',   // docs now show api.together.ai; both serve, and the gateway keys TOGETHER_API_KEY to .xyz
  deepinfra: 'https://api.deepinfra.com/v1/openai',
  'fireworks-ai': 'https://api.fireworks.ai/inference/v1',
  mistral: 'https://api.mistral.ai/v1',
  openai: 'https://api.openai.com/v1',
};

/**
 * Country of providers whose own API we import directly and whose company and inference hosting
 * are known to be in that country — conservative on purpose (routers, gateways and providers with
 * mixed or unclear hosting are left out). Imports carry it as an *inferred* jurisdiction; only the
 * operator's own signed card can declare one.
 */
export const KNOWN_PROVIDER_COUNTRY = Object.freeze({
  'cloudferro-sherlock': 'PL', berget: 'SE', evroc: 'SE', 'regolo-ai': 'IT', scaleway: 'FR', ovhcloud: 'FR',
  mistral: 'FR', stackit: 'DE', hetzner: 'DE', infomaniak: 'CH',
});

/** Providers whose models are included in a subscription plan rather than priced per token. */
export const SUBSCRIPTION_PROVIDERS = /-plan(-|$)|^gitlab$/;   // token, coding, code and step plans

function perTokenPriced(providerId, model) {
  if (SUBSCRIPTION_PROVIDERS.test(providerId)) return false;
  return model?.cost?.input != null || model?.cost?.output != null;
}

/**
 * Import a models.dev-shaped catalog: { providerId: { id, name, api?, doc?, models: { key: model } } }.
 * Each provider becomes a synthetic node `import.modelsdev.{provider}`; each model an offering.
 * The API base is the provider's `api`, else MODELS_DEV_API_BASES; `doc` is never used as one.
 * A provider with neither is still listed, but without endpoints.openai/health (not invocable),
 * keeping `doc` as the informational endpoints.docs link.
 * Returns { providers, offerings, skipped }.
 */
export async function importModelsDev(store, catalog) {
  let providers = 0, offerings = 0;
  const skipped = [];
  for (const [providerId, provider] of Object.entries(catalog ?? {})) {
    const models = provider?.models ?? {};
    const offeringList = [];
    for (const [modelKey, model] of Object.entries(models)) {
      const outputs = model?.modalities?.output ?? ['text'];
      const modality = outputs.includes('text') ? 'text' : outputs.includes('image') ? 'image' : 'text';
      offeringList.push({
        offering_id: slug(modelKey) || 'model',
        modality,
        model: {
          name: model?.name ?? modelKey,
          family: slug(providerId),
          artifact: `urn:proprietary:${slug(providerId).replace(/[._]/g, '-')}:${slug(model?.id ?? modelKey).replace(/\//g, '-')}`,
        },
        serving: {
          ...(model?.limit?.context ? { context_window: Math.floor(model.limit.context) } : {}),
          ...(model?.limit?.output ? { max_output_tokens: Math.floor(model.limit.output) } : {}),
          ...(model?.tool_call ? { supports: ['tool_calls'] } : {}),
        },
        binding: { profile: 'onp.openai.chat/v1', model_id: model?.id ?? modelKey },
        // A missing cost is "not published", never "free"; subscription plans (token plans,
        // GitLab Duo) list 0 because usage is included in the plan, not because it is free.
        pricing: {
          currency: 'USD',
          ...(perTokenPriced(providerId, model) ? {
            input_per_mtok: Number(model.cost.input ?? 0),
            output_per_mtok: Number(model.cost.output ?? 0),
          } : {}),
          schemes: ['prepaid'],
        },
      });
    }
    if (!offeringList.length) { skipped.push(providerId); continue; }

    const nodeId = `import.modelsdev.${slug(providerId).replace(/[._]/g, '-')}`;
    const base = httpsUrl(provider?.api ?? MODELS_DEV_API_BASES[providerId])?.replace(/\/+$/, '') ?? null;
    const docs = httpsUrl(provider?.doc);
    const card = {
      onp: '0.1',
      revision: new Date().toISOString(),
      node: {
        id: nodeId,
        name: provider?.name ?? providerId,
        description: `Imported from models.dev; metadata only, unclaimed by the operator.`,
        operator: { name: provider?.name ?? providerId, ...(KNOWN_PROVIDER_COUNTRY[providerId] ? { country: KNOWN_PROVIDER_COUNTRY[providerId] } : {}) },
      },
      endpoints: {
        ...(base ? { openai: base, health: `${base}/health` } : {}),
        ...(docs ? { docs } : {}),
      },
      offerings: offeringList,
      payment: { schemes: [{ scheme: 'prepaid' }] },
    };
    // A listing-only card deliberately lacks the schema's required invocation endpoints.
    const errors = validateCard(card)
      .filter((e) => base || !/^\/endpoints must have required property '(openai|health)'$/.test(e));
    if (errors.length) { skipped.push(`${providerId}: ${errors[0]}`); continue; }

    const origin = new URL(base ?? docs ?? 'https://models.dev').origin;
    await store.upsertNode(nodeId, origin, `import:modelsdev:${providerId}`, 'indexed', 'import');
    await store.saveRevision(nodeId, card.revision, card, false);
    providers++;
    offerings += offeringList.length;
  }
  return { providers, offerings, skipped };
}

export const HF_ROUTER_URL = 'https://router.huggingface.co/v1/models';
export const HF_HUB_URL = 'https://huggingface.co/api/models?inference_provider=all&limit=1000&expand[]=inferenceProviderMapping&expand[]=pipeline_tag&expand[]=safetensors';

/**
 * Import Hugging Face Inference Providers: `router` is the /v1/models response
 * (live serving: per-provider status/capabilities/perf), `hub` the Hub API list
 * (params_b from safetensors, pipeline_tag). One synthetic node per provider
 * (`import.hf.{provider}`); artifact `hf:{repo}` is authoritative.
 */
export async function importHuggingFace(store, router, hub = []) {
  const hubById = new Map((hub ?? []).map((m) => [m.id, m]));
  const byProvider = new Map(); // provider -> offerings[]

  for (const model of router?.data ?? []) {
    const hubEntry = hubById.get(model.id);
    const paramsB = hubEntry?.safetensors?.total
      ? Math.round(hubEntry.safetensors.total / 1e7) / 100 : undefined;
    const inputs = model.architecture?.input_modalities ?? ['text'];
    const outputs = model.architecture?.output_modalities ?? ['text'];
    const modality = hubEntry?.pipeline_tag && PIPELINE_TAG_MODALITY[hubEntry.pipeline_tag]
      ? PIPELINE_TAG_MODALITY[hubEntry.pipeline_tag]
      : mapModalities(inputs, outputs);

    for (const p of model.providers ?? []) {
      if (p.status !== 'live') continue;
      const supports = ['streaming'];
      if (p.supports_tools) supports.push('tool_calls');
      if (p.supports_structured_output) supports.push('json_mode');
      if (inputs.includes('image') && outputs.includes('text')) supports.push('vision');
      const offering = {
        offering_id: slug(model.id),
        modality,
        modalities: { input: inputs, output: outputs }, // Draft 0.2 field, additive
        model: {
          name: model.id,
          family: vendorSlug(model.owned_by ?? model.id.split('/')[0]),
          artifact: `hf:${model.id}`,
          ...(paramsB ? { params_b: paramsB } : {}),
        },
        serving: {
          supports,
          ...(p.context_length ? { context_window: Math.floor(p.context_length) } : {}),
          ...(Number.isFinite(p.first_token_latency_ms)
            ? { expected_ttft_ms: { p50: Math.round(p.first_token_latency_ms), basis: 'claimed' } } : {}),
          ...(Number.isFinite(p.throughput)
            ? { expected_tps: { p50: Math.round(p.throughput), basis: 'claimed' } } : {}),
        },
        binding: { profile: 'onp.openai.chat/v1', model_id: `${model.id}:${p.provider}` },
        // ~a third of HF provider entries carry no pricing: unknown, not free (as for models.dev)
        pricing: {
          currency: 'USD',
          ...(p.pricing && (p.pricing.input != null || p.pricing.output != null) ? {
            input_per_mtok: perMtok(p.pricing.input),
            output_per_mtok: perMtok(p.pricing.output),
          } : {}),
          schemes: p.is_free ? ['free'] : ['prepaid'],
        },
      };
      if (!byProvider.has(p.provider)) byProvider.set(p.provider, []);
      byProvider.get(p.provider).push(offering);
    }
  }

  let providers = 0, offerings = 0;
  const skipped = [];
  for (const [provider, offeringList] of byProvider) {
    const nodeId = `import.hf.${vendorSlug(provider)}`;
    const card = {
      onp: '0.1',
      revision: new Date().toISOString(),
      node: {
        id: nodeId,
        name: `${provider} (via Hugging Face Inference Providers)`,
        description: 'Imported from the Hugging Face Inference Providers router; metadata only, unclaimed by the operator.',
        operator: { name: provider },
      },
      endpoints: { openai: 'https://router.huggingface.co/v1', health: 'https://router.huggingface.co/health' },
      offerings: offeringList,
      payment: { schemes: [{ scheme: 'prepaid', signup: 'https://huggingface.co/settings/billing' }] },
    };
    const err = await saveImportedCard(store, nodeId, 'https://router.huggingface.co', `import:hf:${provider}`, card);
    if (err) { skipped.push(`${provider}: ${err}`); continue; }
    providers++;
    offerings += offeringList.length;
  }
  return { providers, offerings, skipped };
}

export const OLLAMA_LIBRARY_URL = 'https://ollama.com/library';

/** Text of an HTML fragment: the library page escapes apostrophes and ampersands (&#39; &amp;). */
const decodeEntities = (t) => t.replace(/&(#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi, (m, _, dec, hex) =>
  dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16))
    : { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[m.slice(1, -1).toLowerCase()]);

/** Parse ollama.com/library HTML into entries. Resilient to styling churn:
 *  anchors on /library/{name}, spans classified by content (sizes look like "27b"/"270m"). */
export function parseOllamaLibrary(html) {
  const entries = [];
  const blocks = String(html).split('href="/library/').slice(1);
  for (const block of blocks) {
    const name = block.match(/^([a-z0-9._-]+)"/)?.[1];
    if (!name) continue;
    const chunk = block.slice(0, 6000);
    const rawDescription = chunk.match(/<p[^>]*class="[^"]*max-w-lg[^"]*"[^>]*>\s*([^<]{1,400}?)\s*<\/p>/)?.[1]?.trim();
    const description = rawDescription ? decodeEntities(rawDescription) : null;
    const spans = [...chunk.matchAll(/<span[^>]*class="[^"]*inline-flex[^"]*"[^>]*>\s*([^<]{1,40}?)\s*<\/span>/g)].map((m) => m[1].trim());
    const sizes = spans.filter((s) => /^\d+(\.\d+)?[mb]$/i.test(s));
    const capabilities = spans.filter((s) => !/^\d+(\.\d+)?[mb]$/i.test(s));
    const pulls = chunk.match(/<span[^>]*>\s*([\d.]+[KMB]?)\s*<\/span>\s*<span[^>]*>&nbsp;Pulls/)?.[1] ?? null;
    entries.push({ name, description, capabilities, sizes, pulls });
  }
  return entries;
}

const sizeToParamsB = (s) => {
  const m = String(s).match(/^(\d+(?:\.\d+)?)([mb])$/i);
  if (!m) return null;
  return m[2].toLowerCase() === 'b' ? Number(m[1]) : Math.round(Number(m[1]) / 10) / 100;
};

/**
 * Import the Ollama library as locally-runnable offerings on a synthetic node whose
 * endpoint is the user's OWN machine (http://127.0.0.1:11434/v1) — free, local, and
 * directly usable from the model-page playground once `ollama run <name>` has pulled it.
 */
export async function importOllamaLibrary(store, entries) {
  const offeringList = [];
  for (const e of entries ?? []) {
    if (!e?.name) continue;
    const caps = (e.capabilities ?? []).map((c) => String(c).toLowerCase());
    const modality = caps.includes('embedding') ? 'embedding' : (caps.includes('vision') ? 'multimodal' : 'text');
    const paramsCandidates = (e.sizes ?? []).map(sizeToParamsB).filter((n) => n != null);
    const supports = ['streaming'];
    if (caps.includes('tools')) supports.push('tool_calls');
    if (caps.includes('vision')) supports.push('vision');
    offeringList.push({
      offering_id: slug(e.name),
      modality,
      model: {
        name: e.name,
        family: vendorSlug(e.name.split(/[.:0-9]/)[0] || e.name),
        // Library models are open weights with a public record: ollama:{name} (ONP-2 §5), not a proprietary URN.
        artifact: ARTIFACT.test(`ollama:${e.name}`) ? `ollama:${e.name}` : `urn:proprietary:ollama:${vendorSlug(e.name)}`,
        ...(paramsCandidates.length ? { params_b: Math.max(...paramsCandidates) } : {}),
        ...(e.description ? { description: String(e.description).slice(0, 500) } : {}),
      },
      serving: { supports },
      binding: {
        profile: modality === 'embedding' ? 'onp.openai.embeddings/v1' : 'onp.openai.chat/v1',
        model_id: e.name,
      },
      pricing: { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0, schemes: ['free'] },
      local: {
        runtime: 'ollama',
        run: `ollama run ${e.name}`,
        ...(e.pulls ? { pulls: e.pulls } : {}),
        ...(e.sizes?.length ? { sizes: e.sizes } : {}),
      },
    });
  }
  if (!offeringList.length) return { providers: 0, offerings: 0, skipped: ['no entries'] };
  const nodeId = 'import.ollama.library';
  const card = {
    onp: '0.1',
    revision: new Date().toISOString(),
    node: {
      id: nodeId,
      name: 'Ollama library (runs on your machine)',
      description: 'Locally-runnable models from the Ollama library. The endpoint is your own machine: install Ollama, `ollama run <model>`, and these offerings serve at localhost — free, private, no network.',
      operator: { name: 'Ollama (community library)' },
    },
    endpoints: { openai: 'http://127.0.0.1:11434/v1', health: 'http://127.0.0.1:11434' },
    offerings: offeringList,
    payment: { schemes: [{ scheme: 'free' }] },
  };
  const err = await saveImportedCard(store, nodeId, 'https://ollama.com', 'import:ollama-library', card);
  if (err) return { providers: 0, offerings: 0, skipped: [err] };
  return { providers: 1, offerings: offeringList.length, skipped: [] };
}

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';

/**
 * Import the OpenRouter catalog as one synthetic node (`import.openrouter.catalog`):
 * per-token price strings -> per-MTok; `hugging_face_id` gives the artifact join
 * where present, else a proprietary URN under the model author's namespace.
 */
export async function importOpenRouter(store, catalog) {
  const offeringList = [];
  for (const model of catalog?.data ?? []) {
    const inputs = model.architecture?.input_modalities ?? ['text'];
    const outputs = model.architecture?.output_modalities ?? ['text'];
    const supports = ['streaming'];
    const params = model.supported_parameters ?? [];
    if (params.includes('tools')) supports.push('tool_calls');
    if (params.includes('response_format') || params.includes('structured_outputs')) supports.push('json_mode');
    if (inputs.includes('image') && outputs.includes('text')) supports.push('vision');
    const author = vendorSlug(model.id.split('/')[0] || 'unknown');
    offeringList.push({
      offering_id: slug(model.id),
      modality: mapModalities(inputs, outputs),
      modalities: { input: inputs, output: outputs },
      model: {
        name: model.name ?? model.id,
        family: author,
        artifact: model.hugging_face_id
          ? `hf:${model.hugging_face_id}`
          : `urn:proprietary:${author}:${slug(model.id.split('/').slice(1).join('-') || model.id)}`,
        ...(model.description ? { description: String(model.description).slice(0, 500) } : {}),
        ...(Number.isFinite(model.created)
          ? { released: new Date(model.created * 1000).toISOString().slice(0, 10) } : {}),
      },
      serving: {
        supports,
        ...(model.context_length ? { context_window: Math.floor(model.context_length) } : {}),
        ...(model.top_provider?.max_completion_tokens
          ? { max_output_tokens: Math.floor(model.top_provider.max_completion_tokens) } : {}),
      },
      binding: { profile: 'onp.openai.chat/v1', model_id: model.id },
      pricing: {
        currency: 'USD',
        input_per_mtok: perMtok(model.pricing?.prompt),
        output_per_mtok: perMtok(model.pricing?.completion),
        ...(model.pricing?.input_cache_read
          ? { cached_input_per_mtok: perMtok(model.pricing.input_cache_read) } : {}),
        schemes: Number(model.pricing?.prompt) === 0 ? ['free'] : ['prepaid'],
      },
    });
  }
  if (!offeringList.length) return { providers: 0, offerings: 0, skipped: ['empty catalog'] };

  const nodeId = 'import.openrouter.catalog';
  const card = {
    onp: '0.1',
    revision: new Date().toISOString(),
    node: {
      id: nodeId,
      name: 'OpenRouter catalog',
      description: 'Imported from the public OpenRouter models API; metadata only, unclaimed by the operator.',
      operator: { name: 'OpenRouter' },
    },
    endpoints: { openai: 'https://openrouter.ai/api/v1', health: 'https://openrouter.ai/api/v1/models' },
    offerings: offeringList,
    payment: { schemes: [{ scheme: 'prepaid', signup: 'https://openrouter.ai/keys' }] },
  };
  const err = await saveImportedCard(store, nodeId, 'https://openrouter.ai', 'import:openrouter', card);
  if (err) return { providers: 0, offerings: 0, skipped: [err] };
  return { providers: 1, offerings: offeringList.length, skipped: [] };
}

/* ------------------------------------------------------------------ AI Horde */

// The AI Horde (aihorde.net, run by the non-profit Haidra) is a free network of volunteer GPUs: workers
// poll a coordinator and run whole models on their own machines, and queue priority follows kudos, a
// non-monetary credit earned by contributing compute. The registry only reads the public model status
// and Haidra's model reference; it never sends a prompt there (imports are never probed).

/** Text models with at least one online chat worker: the ones the OpenAI-compatible front can serve. */
export const HORDE_STATUS_URL = 'https://aihorde.net/api/v2/status/models?type=text&chat=true';
/** Haidra's text model reference (AGPL-3.0): Horde model name -> display name and Hugging Face record (`url`). */
export const HORDE_TEXT_REFERENCE_URL = 'https://raw.githubusercontent.com/Haidra-Org/AI-Horde-text-model-reference/main/db.json';
/** Haidra's own OpenAI-compatible front for the Horde (documented in the AI-Horde server README). */
export const HORDE_OPENAI_BASE = 'https://oai.aihorde.net/v1';
/** Horde asks every client for `Client-Agent: name:version:contact`. The contact is the project, never a person. */
export const HORDE_CLIENT_AGENT = `opennodes-registry:${REGISTRY_VERSION}:https://opennodes.io`;
/** The Horde FAQ (who can read prompts) and the date it and the privacy policy were read for this data policy. */
export const HORDE_POLICY_SOURCE = 'https://aihorde.net/faq';
export const HORDE_POLICY_CHECKED = '2026-11-20';
const HORDE_NODE_ID = 'import.aihorde.text';
const HORDE_EMPTY = 'AI Horde import: no text model with online chat workers and a public model record';

/**
 * Lineage for Horde models, only where it is certain: a Hugging Face repo that is the developer's own
 * from-scratch release (the developer trained the base itself, and any distillation teacher is its own
 * model). A fine-tune, merge, quantization or re-upload under another account matches none of these and
 * stays unknown: a list naming only the base developer would read as clean (ONP-2 §5). Distilled
 * releases (`*-Distill-*`) are excluded even under a listed account.
 */
export const HORDE_FROM_SCRATCH = Object.freeze([
  [/^Qwen\/Qwen\d/, 'CN'],                        // Qwen/Qwen3-14B, Qwen/Qwen3.8-Flash-Next
  [/^zai-org\/GLM-/, 'CN'],
  [/^google\/gemma-/, 'US'],
  [/^meta-llama\/(Meta-)?Llama-/, 'US'],
  [/^mistralai\/(Mistral|Ministral|Magistral)-/, 'FR'],
]);

/** `org/repo` of a Hugging Face model URL, or null. */
const hfRepo = (url) => {
  const m = /^https:\/\/huggingface\.co\/([A-Za-z0-9][\w.-]*)\/([\w.-]+)\/?$/.exec(String(url ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
};

/** The developer country for a from-scratch release, else null (unknown). */
export function hordeLineage(repo) {
  if (!repo || /distill/i.test(repo)) return null;
  return HORDE_FROM_SCRATCH.find(([re]) => re.test(repo))?.[1] ?? null;
}

/** Horde chat feature declarations -> ONP `serving.supports` (each declared by at least one worker). */
const HORDE_FEATURES = {
  tools: 'tool_calls', json_object: 'json_mode', json_schema: 'structured_outputs',
  vision: 'vision', reasoning_effort: 'reasoning',
};

/**
 * Import the AI Horde's text models as one synthetic node (`import.aihorde.text`).
 * `status` is GET /v2/status/models?type=text&chat=true; `reference` is Haidra's text model reference
 * (db.json). An offering is made only for a model with online chat workers and a Hugging Face record in
 * the reference: model names are declared by the workers, and an open-weight model is named by its public
 * record (ONP-2 §5), so a name with no record is skipped, never given a made-up artifact. Worker count and
 * queue go into the store as the `upstream` observation (reported by the Horde, not measured here).
 * With nothing to list, the node is delisted rather than left showing workers that have gone.
 */
export async function importHorde(store, status, reference = {}) {
  if (!Array.isArray(status)) return { providers: 0, offerings: 0, skipped: ['status is not a list'] };
  const reportedAt = new Date().toISOString();
  const offeringList = [];
  const upstream = new Map();
  const skipped = [];
  for (const m of status) {
    const name = typeof m?.name === 'string' ? m.name : null;
    const workers = Number(m?.chat?.workers ?? 0);
    if (!name || m.type !== 'text' || !(workers >= 1)) continue;
    const ref = reference?.[name];
    const repo = hfRepo(ref?.url);
    if (!repo || !ARTIFACT.test(`hf:${repo}`)) { skipped.push(`${name}: no public model record`); continue; }
    const features = Array.isArray(m.chat.features) ? m.chat.features : [];
    const vision = features.includes('vision');
    const supports = ['streaming', ...new Set(features.map((f) => HORDE_FEATURES[f]).filter(Boolean))];
    const lineage = hordeLineage(repo);
    let offeringId = slug(name.replace(/\//g, '-')) || 'model';
    if (offeringList.some((o) => o.offering_id === offeringId)) offeringId = slug(`${offeringId}-${offeringList.length}`);
    offeringList.push({
      offering_id: offeringId,
      modality: vision ? 'multimodal' : 'text',
      modalities: { input: vision ? ['text', 'image'] : ['text'], output: ['text'] },
      model: {
        name: ref.display_name || ref.model_name || name,
        family: vendorSlug(repo.split('/')[0]),
        artifact: `hf:${repo}`,
        ...(lineage ? { lineage_origins: [lineage] } : {}),
        // No `description`: the reference is AGPL-3.0, so only its facts (names, record URL) are used.
      },
      serving: {
        supports,
        ...(Number.isInteger(m.chat.max_context_length) && m.chat.max_context_length > 0 ? { context_window: m.chat.max_context_length } : {}),
        ...(Number.isInteger(m.chat.max_length) && m.chat.max_length > 0 ? { max_output_tokens: m.chat.max_length } : {}),
      },
      binding: { profile: 'onp.openai.chat/v1', model_id: name },
      // Free; queue order by kudos and the free output allowance have no ONP field yet (see the README).
      pricing: { currency: 'USD', input_per_mtok: 0, output_per_mtok: 0, schemes: ['free'] },
      // Volunteers run the models on their own machines and can read and keep prompts and outputs.
      // Nobody can promise anything about training for them, so training_on_inputs stays unstated.
      data_policy: { retention: 'logged', source: HORDE_POLICY_SOURCE, checked: HORDE_POLICY_CHECKED },
    });
    upstream.set(offeringId, {
      source: 'aihorde', basis: 'reported', reported_at: reportedAt, workers,
      queued_tokens: Number(m.queued ?? 0), jobs: Number(m.jobs ?? 0), eta_s: Number(m.eta ?? 0),
    });
  }

  const node = await store.getNode(HORDE_NODE_ID);
  if (!offeringList.length) {
    if (node?.state === 'indexed') await store.setState(HORDE_NODE_ID, 'delisted', HORDE_EMPTY);
    return { providers: 0, offerings: 0, skipped: [...skipped, 'nothing to list'] };
  }
  const card = {
    onp: '0.1',
    revision: reportedAt,
    node: {
      id: HORDE_NODE_ID,
      name: 'AI Horde (volunteer GPUs)',
      description: 'Imported from the AI Horde public model status (aihorde.net), run by the non-profit Haidra. '
        + 'Free: volunteers run the models on their own machines, and the queue is ordered by kudos, so requests '
        + 'with the anonymous key 0000000000 wait longest; a free registered key gets better priority. '
        + 'Volunteer workers can technically read and keep prompts and outputs: never send personal data. '
        + 'Worker counts and queues are a snapshot reported by the Horde. Call it with your own AI Horde key '
        + 'at the OpenAI-compatible front. Terms: https://aihorde.net/terms. Privacy: https://aihorde.net/privacy. '
        + 'FAQ: https://aihorde.net/faq. Metadata only, unclaimed by the operator.',
      operator: { name: 'AI Horde (Haidra, volunteer workers)', url: 'https://aihorde.net' },
    },
    endpoints: { openai: HORDE_OPENAI_BASE, health: 'https://aihorde.net/api/v2/status/heartbeat', docs: 'https://oai.aihorde.net/docs' },
    offerings: offeringList,
    payment: { schemes: [{ scheme: 'free' }] },
  };
  const err = await saveImportedCard(store, HORDE_NODE_ID, 'https://aihorde.net', 'import:aihorde', card);
  if (err) return { providers: 0, offerings: 0, skipped: [...skipped, err] };
  // Back after an empty snapshot; a delisting by anyone else stays.
  if (node?.state === 'delisted' && (await store.transitionsFor(HORDE_NODE_ID)).at(-1)?.reason === HORDE_EMPTY) {
    await store.setState(HORDE_NODE_ID, 'indexed', 'AI Horde import: chat workers back online');
  }
  for (const [offeringId, value] of upstream) await store.setObservation(HORDE_NODE_ID, offeringId, 'upstream', value);
  return {
    providers: 1, offerings: offeringList.length, skipped,
    workers: [...upstream.values()].reduce((n, u) => n + u.workers, 0),
  };
}

/* ------------------------------------------------------------------ locations (ONP-2 §3a) */

/** Save a listing-only card: like saveImportedCard, but without invocation endpoints. */
async function saveListingCard(store, nodeId, origin, sourceRef, card) {
  const errors = validateCard(card)
    .filter((e) => !/^\/endpoints must have required property '(openai|health)'$/.test(e));
  if (errors.length) return errors[0];
  await store.upsertNode(nodeId, origin, sourceRef, 'indexed', 'import');
  await store.saveRevision(nodeId, card.revision, card, false);
  return null;
}

export const OPENROUTER_PROVIDERS_URL = 'https://openrouter.ai/api/v1/providers';

/**
 * Region segments seen in OpenRouter endpoint tags (`amazon-bedrock/eu-west-1`,
 * `baseten/fp4/us`) -> ONP region codes. `global` means the provider may serve anywhere.
 */
export const CLOUD_REGIONS = {
  us: 'US', eu: 'EU', europe: 'EU', global: null,
  'us-east-1': 'US-VA', 'us-east-2': 'US-OH', 'us-west-2': 'US-OR', 'us-east5': 'US-OH', 'us-central1': 'US-IA',
  'eu-west-1': 'IE', 'eu-central-1': 'DE', swedencentral: 'SE',
  'ca-central-1': 'CA-QC', 'ca-west-1': 'CA-AB', canadacentral: 'CA-ON', canadaeast: 'CA-QC',
  'northamerica-northeast1': 'CA-QC', 'northamerica-northeast2': 'CA-ON',
};

/** Fetch every model's endpoint list (`links.details`), a few at a time. Returns Map(model id -> endpoints). */
export async function fetchOpenRouterEndpoints(getJson, models, concurrency = 4) {
  const out = new Map();
  const queue = [...models];
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const path = m.links?.details ?? `/api/v1/models/${m.id}/endpoints`;
      try { out.set(m.id, (await getJson(new URL(path, 'https://openrouter.ai').href))?.data?.endpoints ?? []); }
      catch { out.set(m.id, []); } // a model can vanish between the two calls
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

/**
 * Import OpenRouter per provider, with the locations providers declare to OpenRouter:
 * `headquarters` -> operator country, `datacenters` -> node locations, and a region segment
 * in the endpoint tag -> that offering's location. All are `claimed`. Only endpoints with
 * some location become offerings (listing-only, node `import.openrouter.p.{provider}`); the
 * rest are counted as `unlocated`, which is the size of the gap.
 */
export async function importOpenRouterProviders(store, providers, models, endpointsById, { checked = today() } = {}) {
  const bySlug = new Map((providers ?? []).map((p) => [p.slug, p]));
  const byName = new Map((providers ?? []).map((p) => [p.name, p]));
  const groups = new Map(); // provider slug -> offerings[]
  let unlocated = 0;

  for (const model of models ?? []) {
    const author = vendorSlug(model.id.split('/')[0] || 'unknown');
    const inputs = model.architecture?.input_modalities ?? ['text'];
    const outputs = model.architecture?.output_modalities ?? ['text'];
    for (const ep of endpointsById.get(model.id) ?? []) {
      const [tagSlug, ...rest] = String(ep.tag ?? '').split('/');
      const provider = bySlug.get(tagSlug) ?? byName.get(ep.provider_name);
      if (!provider) { unlocated++; continue; }
      const regionSeg = rest.find((s) => s in CLOUD_REGIONS);
      const declared = provider.datacenters ?? [];
      if (regionSeg === 'global' || (!regionSeg && !declared.length)) { unlocated++; continue; }

      const supports = ['streaming'];
      const params = ep.supported_parameters ?? model.supported_parameters ?? [];
      if (params.includes('tools')) supports.push('tool_calls');
      if (params.includes('response_format') || params.includes('structured_outputs')) supports.push('json_mode');
      if (inputs.includes('image') && outputs.includes('text')) supports.push('vision');
      const offering = {
        offering_id: slug([model.id.replace('/', '-'), ...rest].join('-')),
        modality: mapModalities(inputs, outputs),
        modalities: { input: inputs, output: outputs },
        model: {
          name: model.name ?? model.id,
          family: author,
          artifact: model.hugging_face_id
            ? `hf:${model.hugging_face_id}`
            : `urn:proprietary:${author}:${slug(model.id.split('/').slice(1).join('-') || model.id)}`,
          ...(ep.quantization && ep.quantization !== 'unknown' ? { quantization: ep.quantization } : {}),
        },
        serving: {
          supports,
          ...(ep.context_length ? { context_window: Math.floor(ep.context_length) } : {}),
          ...(ep.max_completion_tokens ? { max_output_tokens: Math.floor(ep.max_completion_tokens) } : {}),
        },
        binding: { profile: 'onp.openai.chat/v1', model_id: model.id },
        pricing: {
          currency: 'USD',
          input_per_mtok: perMtok(ep.pricing?.prompt),
          output_per_mtok: perMtok(ep.pricing?.completion),
          schemes: ['prepaid'],
        },
        ...(regionSeg ? { locations: [{
          region: CLOUD_REGIONS[regionSeg], basis: 'claimed', note: `OpenRouter endpoint tag ${ep.tag}`,
        }] } : {}),
      };
      if (!groups.has(provider.slug)) groups.set(provider.slug, []);
      const list = groups.get(provider.slug);
      if (list.some((o) => o.offering_id === offering.offering_id)) offering.offering_id = slug(`${offering.offering_id}-${list.length}`);
      list.push(offering);
    }
  }

  let count = 0, offerings = 0;
  const skipped = [];
  for (const [providerSlug, offeringList] of groups) {
    const p = bySlug.get(providerSlug);
    const nodeId = `import.openrouter.p.${vendorSlug(providerSlug)}`;
    const declared = (p.datacenters ?? []).filter((c) => /^[A-Z]{2}$/.test(c));
    const card = {
      onp: '0.1',
      revision: new Date().toISOString(),
      node: {
        id: nodeId,
        name: `${p.name} (via OpenRouter)`,
        description: 'Imported from the OpenRouter provider and endpoint APIs. Locations are what the provider declares to OpenRouter (claimed). Listing only: call it through OpenRouter with provider routing.',
        operator: { name: p.name, ...(/^[A-Z]{2}$/.test(p.headquarters ?? '') ? { country: p.headquarters } : {}) },
        ...(declared.length ? {
          regions: declared,
          locations: declared.map((c) => ({ region: c, basis: 'claimed', source: OPENROUTER_PROVIDERS_URL, checked })),
        } : {}),
      },
      endpoints: { docs: `https://openrouter.ai/provider/${encodeURIComponent(providerSlug)}` },
      offerings: offeringList,
      payment: { schemes: [{ scheme: 'prepaid', signup: 'https://openrouter.ai/keys' }] },
    };
    const err = await saveListingCard(store, nodeId, 'https://openrouter.ai', `import:openrouter-provider:${providerSlug}`, card);
    if (err) { skipped.push(`${providerSlug}: ${err}`); continue; }
    count++;
    offerings += offeringList.length;
  }
  return { providers: count, offerings, unlocated, skipped };
}

/**
 * Import a curated location seed (src/data/locations-*.json): providers, their sites with
 * evidence, and the models each site serves. A provider with listed models becomes a
 * listing-only node `import.seed.{seed}.{id}`; one without (models not published) stays
 * site-only and is served by /v0/locations straight from the seed.
 */
export async function importLocationSeed(store, seed) {
  let providers = 0, offerings = 0, siteOnly = 0;
  const skipped = [];
  for (const p of seed?.providers ?? []) {
    if (!p.models?.length) { siteOnly++; continue; }
    const sites = new Map((p.sites ?? []).map((s) => [s.id, siteLocation(s)]));
    const offeringList = p.models.map((m) => {
      const family = vendorSlug(m.family ?? p.id);
      return {
        offering_id: slug(m.id ?? m.name),
        modality: m.modality ?? 'text',
        model: {
          name: m.name,
          family,
          artifact: m.artifact ?? `urn:proprietary:${family}:${slug(m.id ?? m.name).replace(/\//g, '-')}`,
          ...(m.lineage_origins ? { lineage_origins: m.lineage_origins } : {}),
        },
        serving: {},
        binding: { profile: m.modality === 'embedding' ? 'onp.openai.embeddings/v1' : 'onp.openai.chat/v1', model_id: m.model_id ?? m.name },
        pricing: { currency: 'USD', schemes: ['contract'] },
        ...(m.sites ? { locations: m.sites.map((id) => sites.get(id)).filter(Boolean) } : {}),
      };
    });
    const nodeId = `import.seed.${vendorSlug(seed.seed)}.${vendorSlug(p.id)}`;
    const card = {
      onp: '0.1',
      revision: new Date().toISOString(),
      node: {
        id: nodeId,
        name: p.name,
        description: [p.note, seed.note].filter(Boolean).join(' ').slice(0, 4000),
        operator: { name: p.operator?.name ?? p.name, ...(p.operator?.country ? { country: p.operator.country } : {}), ...(p.operator?.url ? { url: p.operator.url } : {}) },
        locations: [...sites.values()],
      },
      endpoints: { ...(p.operator?.url ? { docs: p.operator.url } : {}) },
      offerings: offeringList,
      payment: { schemes: [{ scheme: 'contract' }] },
    };
    const err = await saveListingCard(store, nodeId, p.operator?.url ? new URL(p.operator.url).origin : 'https://opennodes.io', `import:seed:${seed.seed}:${p.id}`, card);
    if (err) { skipped.push(`${p.id}: ${err}`); continue; }
    providers++;
    offerings += offeringList.length;
  }
  return { providers, offerings, site_only: siteOnly, skipped };
}

/** A seed site -> an ONP location (drops the seed-local `id`). */
export function siteLocation({ id, ...location }) {
  return location;
}

const today = () => new Date().toISOString().slice(0, 10);
