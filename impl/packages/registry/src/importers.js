// DS-IMP-01: seed importers so search is useful before any real registration.
// Imported records enter as unverified, unsigned, source='import', and are
// excluded from verified tiers until claimed by their operator.
import { validateCard } from '@opennodes/core';

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 100);
const vendorSlug = (s) => slug(s).replace(/[._]/g, '-');

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
 * Import a models.dev-shaped catalog: { providerId: { id, name, api?, doc?, models: { key: model } } }.
 * Each provider becomes a synthetic node `import.modelsdev.{provider}`; each model an offering.
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
        pricing: {
          currency: 'USD',
          input_per_mtok: Number(model?.cost?.input ?? 0),
          output_per_mtok: Number(model?.cost?.output ?? 0),
          schemes: ['prepaid'],
        },
      });
    }
    if (!offeringList.length) { skipped.push(providerId); continue; }

    const nodeId = `import.modelsdev.${slug(providerId).replace(/[._]/g, '-')}`;
    const base = provider?.api ?? provider?.doc ?? 'https://models.dev';
    const card = {
      onp: '0.1',
      revision: new Date().toISOString(),
      node: {
        id: nodeId,
        name: provider?.name ?? providerId,
        description: `Imported from models.dev; metadata only, unclaimed by the operator.`,
        operator: { name: provider?.name ?? providerId },
      },
      endpoints: { openai: base, health: `${base.replace(/\/$/, '')}/health` },
      offerings: offeringList,
      payment: { schemes: [{ scheme: 'prepaid' }] },
    };
    const errors = validateCard(card);
    if (errors.length) { skipped.push(`${providerId}: ${errors[0]}`); continue; }

    await store.upsertNode(nodeId, new URL(base).origin, `import:modelsdev:${providerId}`, 'indexed', 'import');
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
        pricing: {
          currency: 'USD',
          input_per_mtok: perMtok(p.pricing?.input),
          output_per_mtok: perMtok(p.pricing?.output),
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
