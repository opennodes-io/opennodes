# ONP-2: The Node Card

**OpenNodes Protocol — Draft 0.1 — 2026-08-20**

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
  "data_policy": {"retention": "none", "training_on_inputs": false,
                  "region_pinning": ["eu"]}
}
```

Field rules:

- `modality` ∈ `text` | `image` | `audio` | `video` | `embedding` | `multimodal` | `agent`. Diffusion models use `image`/`video` with the corresponding binding profile (ONP-4 §4) and per-unit pricing (`per_image`, `per_second`).
- `model.artifact` — a URI linking the served weights to a public artifact record where one exists: `hf:{org}/{repo}` (Hugging Face model card) or `urn:proprietary:{vendor}:{model}` for closed models (e.g. `urn:proprietary:openai:gpt-5`). This is the endpoint↔artifact join.
- Every performance or quality number carries `basis`: **`claimed`** (self-reported) or **`attested`** (backed by a linked Verifiable Credential from an attester). Registries and clients MUST NOT present claimed values as verified.
- `serving.languages` — declared language coverage with coarse grades (`native` | `strong` | `basic`); per-language eval attestations upgrade a grade to `attested`. This powers the `lang=` search filter (ONP-3 §5) — language-optimal routing is a first-class selection criterion, not an afterthought.
- `binding.profile` — an ONP-4 profile identifier; `model_id` is the string a client passes on the wire (e.g. as OpenAI `model`).
- `data_policy` is REQUIRED for `community` tier and above: retention, training-use, and region guarantees are primary selection criteria for enterprise clients.

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

Hardware claims are informational for ranking/expectation-setting; the `mlperf.system_id` link is the standard way to make them checkable.

## 7. `compliance` (optional)

`{"certifications": ["soc2-type2", "iso27001"], "gdpr": true, "attestations": [...]}` — same claimed/attested discipline.

## 8. `signatures`

The card MUST carry at least one JWS (RFC 7515, detached payload = the card minus `signatures`) by a key discoverable via the origin (`/.well-known/jwks.json`) or the node's DID document. Registries MUST reject unsigned cards for `verified`+ tiers and SHOULD accept-but-label them at lower tiers.

## 9. JSON Schema

A normative JSON Schema for the card lives at `schemas/ai-node.schema.json` (to be generated from this document; the prose is authoritative in Draft 0.1).
