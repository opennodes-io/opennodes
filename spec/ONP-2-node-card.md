# ONP-2: The Node Card

**OpenNodes Protocol — Draft 0.1, revision 2 — 2026-10-31** ([changes](CHANGES.md))

The Node Card is the self-description document of an AI Node. It is the unit registries index and the ground truth clients verify against. Design follows A2A's Agent Card (well-known URI, signed JSON) but describes *inference resources*, not agent skills.

---

## 1. Location and transport

- A Node MUST serve its card at `https://{origin}/.well-known/open-node.json` over TLS.
- Content type `application/open-node+json` (fallback `application/json`).
- Cards SHOULD set `Cache-Control: max-age` ≤ 3600. Clients and registries treat the card as authoritative over any registry copy.
- A single origin hosts exactly one card; one card MAY describe many Model Offerings.

## 2. Top-level structure

```json
{
  "onp": "0.1",
  "revision": "2026-08-20T12:00:00Z",
  "node": { ... },          // §3 identity & operator
  "endpoints": { ... },     // §4 service endpoints
  "offerings": [ ... ],     // §5 model offerings (the core)
  "hardware": { ... },      // §6 optional, node-level
  "payment": { ... },       // ONP-5 §2 — accepted schemes
  "compliance": { ... },    // §7 optional
  "signatures": [ ... ]     // §8 JWS
}
```

`revision` is a strictly increasing ISO-8601 timestamp; it is what receipts and disputes reference.

## 3. `node` — identity and operator

```json
"node": {
  "id": "ai.example-lab.inference",
  "name": "Example Lab Inference",
  "description": "EU-hosted inference for open-weight models.",
  "operator": {
    "name": "Example Lab GmbH",
    "url": "https://example-lab.ai",
    "contact": "noc@example-lab.ai",
    "country": "DE"
  },
  "did": "did:web:example-lab.ai",
  "regions": ["eu-central"],
  "founded": "2025-03"
}
```

- `id` — reverse-DNS, MUST be under a domain the operator controls (verified per ONP-3 §4, same challenge family as the MCP Registry).
- `did` — OPTIONAL W3C DID; `did:web` RECOMMENDED so the DID resolves through the same origin that hosts the card.
- `regions` (and `data_policy.region_pinning`, §5) — region codes SHOULD be ISO 3166-1 alpha-2 (`CA`, `DE`), ISO 3166-2 subdivisions (`CA-QC`), or the ISO-reserved `EU`. Matching is case-insensitive, and a code **contains** its subdivisions: a requirement of `CA` is met by `CA-QC`, but a requirement of `CA-QC` is not met by `CA`. Free-form legacy values (`eu-central`) are tolerated and follow the same rule (`eu` contains `eu-central`), but new cards SHOULD use ISO codes.

## 4. `endpoints`

```json
"endpoints": {
  "openai": "https://api.example-lab.ai/v1",
  "health": "https://api.example-lab.ai/onp/health",
  "receipts": "https://api.example-lab.ai/onp/receipts",
  "a2a": null,
  "docs": "https://example-lab.ai/docs"
}
```

`health` is REQUIRED: `GET` returns `200` with `{"status":"ok","load":0.42,"queue_ms":120}` (fields beyond `status` optional). Registries probe it (ONP-3 §6).

## 5. `offerings` — Model Offerings

The core of the card. Each entry joins **model artifact ↔ serving configuration ↔ price ↔ binding**, the join no existing standard provides.

```json
{
  "offering_id": "llama-4-70b-instruct-fp8",
  "modality": "text",
  "model": {
    "name": "Llama 4 70B Instruct",
    "family": "llama-4",
    "artifact": "hf:meta-llama/Llama-4-70B-Instruct",
    "params_b": 70,
    "quantization": "fp8",
    "license": "llama4",
    "revision_pin": "sha256:9f2a…"
  },
  "serving": {
    "context_window": 262144,
    "max_output_tokens": 32768,
    "supports": ["streaming", "tool_calls", "json_mode", "vision"],
    "languages": [{"lang": "en", "grade": "native"},
                  {"lang": "uk", "grade": "strong", "basis": "attested",
                   "attestation": "https://attest.example.org/vc/ghi789"},
                  {"lang": "de", "grade": "basic"}],
    "expected_ttft_ms": {"p50": 210, "p95": 900, "basis": "claimed"},
    "expected_tps": {"p50": 95, "basis": "attested",
                     "attestation": "https://attest.example.org/vc/abc123"}
  },
  "binding": {"profile": "onp.openai.chat/v1", "model_id": "llama-4-70b-fp8"},
  "benchmarks": [
    {"suite": "mmlu-pro", "score": 71.2, "basis": "claimed"},
    {"suite": "lmarena-elo", "score": 1301, "basis": "attested",
     "attestation": "https://attest.example.org/vc/def456"}
  ],
  "pricing": {
    "currency": "USD",
    "input_per_mtok": 0.55,
    "output_per_mtok": 1.80,
    "schemes": ["x402", "prepaid"],
    "free_tier": {"requests_per_day": 50}
  },
  "availability": {"sla": 0.99, "interruptible": false},
  "capacity": {"aggregate_output_tps": {"p50": 4200, "basis": "claimed"},
               "max_concurrency": 128,
               "rate_limits": {"rpm": 600, "input_tpm": 2000000, "output_tpm": 300000}},
  "data_policy": {"retention": "none", "training_on_inputs": false,
                  "region_pinning": ["EU"]}
}
```

Field rules:

- `modality` — core values `text` | `image` | `audio` | `video` | `embedding` | `multimodal` | `agent` | `tools`. `tools` marks a non-inference tool node (ONP-4 §6). Diffusion models use `image`/`video` with the corresponding binding profile (ONP-4 §4) and per-unit pricing (`per_image`, `per_second`). The list is open (ONP-1 §5).
- `serving.supports` — core values:

  | Value | Meaning |
  |---|---|
  | `streaming` | SSE streaming per ONP-4 §2 |
  | `tool_calls` | OpenAI tools / `tool_choice` |
  | `parallel_tool_calls` | Several tool calls in one turn |
  | `json_mode` | `response_format: {"type": "json_object"}` |
  | `structured_outputs` | `response_format: {"type": "json_schema"}` with schema adherence |
  | `vision` | Image input parts |
  | `audio_input` | Audio input parts |
  | `edit` | Image edits (ONP-4 §4) |
  | `reasoning` | Separate reasoning tokens or effort control |
  | `logprobs` | `logprobs` / `top_logprobs` honoured. Registries use them for identity fingerprinting (ONP-3 §4a) |
  | `prompt_caching` | Cached-input discount applied; see `pricing.cached_input_per_mtok` |

  A node MUST NOT declare a capability it does not implement. Stage B spot-checks declared capabilities (ONP-3 §4a).
- `model.artifact` — a URI linking the served weights to a public artifact record where one exists: `hf:{org}/{repo}` (Hugging Face model card) or `urn:proprietary:{vendor}:{model}` for closed models (e.g. `urn:proprietary:openai:gpt-5`). This is the endpoint↔artifact join.
- Every performance or quality number carries `basis`: **`claimed`** (self-reported) or **`attested`** (backed by a linked Verifiable Credential from an attester). Registries and clients MUST NOT present claimed values as verified.
- `serving.languages` — declared language coverage with coarse grades (`native` | `strong` | `basic`); per-language eval attestations upgrade a grade to `attested`. `lang` is a BCP 47 tag (`en`, `fr`, `fr-CA`, `pt-BR`); a search for `fr` also matches `fr-CA`. This powers the `lang=` search filter (ONP-3 §5) — language-optimal routing is a first-class selection criterion, not an afterthought.
- `serving.expected_ttft_ms` / `serving.expected_tps` — what **one stream** experiences: time to first token, and decode rate in output tokens per second for a single request.
- `capacity` (OPTIONAL) — what the **offering as a whole** sustains:
  - `aggregate_output_tps`: total output tokens per second across concurrent streams;
  - `max_concurrency`;
  - `rate_limits` (`rpm`, `input_tpm`, `output_tpm`), which the node enforces per client.
  Registry capacity ramps (ONP-3 §4a) measure both quantities. As with every claim, measurements override them.
- `binding.profile` — an ONP-4 profile identifier; `model_id` is the string a client passes on the wire (e.g. as OpenAI `model`).
- `pricing.schemes` — the schemes accepted for this offering. It MUST be a subset of the node-level `payment.schemes` (ONP-5 §2), which carries each scheme's parameters (networks, signup URL, settlement registry). Registries check this at Stage A (ONP-3 §4a).
- `data_policy` is REQUIRED for `community` tier and above: retention, training-use, and region guarantees are primary selection criteria for enterprise clients. `retention`:
  - `none`: content is not stored beyond the lifetime of the request;
  - `ephemeral`: content may be held for a bounded time for abuse monitoring or caching, and `retention_max_seconds` is REQUIRED;
  - `logged`: content may be stored without a declared bound.
  Registries MUST check that `data_policy` is present before promoting a node to `community` (Stage A, ONP-3 §4a).

**Agent offerings** (`modality: "agent"`): the offering wraps an A2A endpoint; `binding.profile` is `onp.a2a/v1` and the card links the A2A Agent Card. This lets ONP registries index agents without competing with A2A — A2A describes *how to talk to it*, ONP describes *what it costs and how it ranks*.

## 6. `hardware` (optional, node-level or per-offering override)

```json
"hardware": {
  "accelerators": [{"type": "H200", "count": 16, "memory_gb": 141}],
  "basis": "claimed",
  "mlperf": {"suite": "inference-v6.0", "system_id": "ExampleLab_H200x16",
             "url": "https://mlcommons.org/..."}
}
```

The same open-weight artifact served by different vendors is **not the same product**: allocated hardware determines the throughput, latency, and batch behavior a client will actually experience. Model catalogs (OpenRouter, HF) describe the software artifact and mostly omit the silicon behind each provider; ONP treats the allocation as first-class metadata. An offering-level `hardware` object (same shape) declares the resources allocated to *that offering* and overrides the node-level description in registry projections — a node with 16× H200 may still serve a given model on a 2-GPU slice, and clients deserve to see which.

Precedence for expectation-setting, weakest claim first:

1. **`hardware` (claimed/attested)** — sizing signal only; never enters rank directly.
2. **`serving.expected_ttft_ms` / `expected_tps` (claimed)** — the node's own performance promise.
3. **Registry observations (measured)** — Stage B capacity-ramp and Stage C blind-probe TTFT/TPS percentiles. Where these exist they override both of the above in search results and sorts (`sort=ttft|tps`), because **user outcome is measured performance, not installed hardware**.

The `mlperf.system_id` link is the standard way to make a hardware claim checkable; attested hardware upgrades `basis` but still never outranks a measurement.

## 7. `compliance` (optional)

`{"certifications": ["soc2-type2", "iso27001"], "gdpr": true, "attestations": [...]}` — same claimed/attested discipline.

## 8. `signatures`

The card MUST carry at least one JWS (RFC 7515, detached payload = the card minus `signatures`) by a key discoverable via the origin (`/.well-known/jwks.json`) or the node's DID document. Registries MUST reject unsigned cards for `verified`+ tiers and SHOULD accept-but-label them at lower tiers.

**Canonicalization (normative).** The signed payload is the **JSON Canonicalization Scheme (JCS, RFC 8785)** serialization of the card minus `signatures`:
- object members sorted by UTF-16 code units, arrays in order, no insignificant whitespace;
- numbers serialized as ECMAScript does (`JSON.stringify`), so `1.0` becomes `1`;
- strings with minimal escaping.

Each entry in `signatures` holds the JWS protected header and signature; the verifier rebuilds the signing input from the canonical payload. Implementations outside JavaScript must match ECMAScript number output. The reference Python Node Kit writes integral floats as integers. Card authors SHOULD avoid values that need exponent notation, such as prices below 1e-6; express them in a larger unit instead.

## 9. JSON Schema

The normative JSON Schema for the card is [`schemas/open-node.schema.json`](../schemas/open-node.schema.json) (JSON Schema 2020-12, `$id` `https://opennodes.io/schemas/0.1/open-node.schema.json`). The schema is normative for **structure**; this document is normative for **semantics**. Where they disagree, file an issue: it is a bug in one of them. Vocabulary fields are open token lists per ONP-1 §5.
