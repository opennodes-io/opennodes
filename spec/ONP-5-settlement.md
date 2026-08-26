# ONP-5: Settlement — Price Advertisement, Payment Schemes, Receipts

**OpenNodes Protocol — Draft 0.1 — 2026-08-20**

ONP does not move money. It standardizes three things existing rails leave open: (1) machine-readable **price advertisement at discovery time** (x402 only quotes at call time; catalogs need it earlier), (2) a **scheme negotiation** surface so one client can pay any node, (3) **signed usage receipts** binding what was billed to what was advertised.

---

## 1. Pricing advertisement

Defined in ONP-2 §5 (`offering.pricing`). Units by modality:

| Unit | Applies to |
|---|---|
| `input_per_mtok` / `output_per_mtok` | text, embeddings (input only), agent (if token-priced) |
| `cached_input_per_mtok` | optional prompt-cache discount |
| `per_image` (flat or size-tiered map) | image |
| `per_second` | video |
| `per_mchar`, `per_minute` | audio TTS / STT |
| `per_task` | agent |
| `per_call` | tool nodes |

Rules:
- Currency is ISO-4217 (stablecoin settlement converts at scheme layer; the advertised currency is what receipts denominate).
- **Price-in-force = price in the card revision the client pinned** via `ONP-Card-Revision` (ONP-4 §2). Nodes wanting to reprice publish a new revision; in-flight and just-pinned requests either honor the old price or 409 — silent repricing is non-conformant.
- `free_tier` and fully free offerings (`schemes: ["free"]`) are first-class: free offerings still return receipts (usage accounting without billing), keeping ranking signals uniform.

## 2. Payment schemes

Card block:

```json
"payment": {
  "schemes": [
    {"scheme": "x402", "networks": ["base", "solana"], "asset": "USDC"},
    {"scheme": "prepaid", "signup": "https://example-lab.ai/keys",
     "settlement_registry": "https://registry.opennodes.org"},
    {"scheme": "free"}
  ],
  "probe_allowance": {"requests_per_day": 200}
}
```

`probe_allowance` grants registries a free daily request budget for admission and conformance testing (ONP-3 §4a); without it, registries probe as paying clients.

### 2.1 `x402` (RECOMMENDED for stranger-to-stranger)
Standard x402 flow: unauthenticated request → `402` with payment requirements → client retries with `X-PAYMENT`. ONP profile constraints: the 402 quote MUST NOT exceed the pinned card price for the request's declared `max_tokens` bound; nodes SHOULD support per-request payment with post-paid usage true-up via receipt (overpayment refund or credit per x402 facilitator capability).

### 2.2 `prepaid` (API-key against node or registry credit)
Two variants:
- **Node-direct:** classic API key from the vendor; ONP adds nothing but receipts.
- **Registry-settled:** the client holds one credit balance at a registry (or any settlement operator); the request carries a registry-issued token (OAuth 2.1 bearer); the node redeems receipts against the operator. This is the OpenRouter model made multi-vendor: **it is the standard's main monetization hook** — operators take a disclosed fee on credit purchase/redemption. The settlement API (deposit, token issue, redeem, statement) is defined in an OpenAPI companion (`schemas/settlement.openapi.yaml`, Draft 0.2 work item).

### 2.3 `free`
No payment; rate limits declared in `free_tier`. Ad-supported and token-exchange models are explicitly deferred (no market precedent) — when they come, they enter as new schemes without touching discovery or invocation.

## 3. Client spend policy

A conforming client MUST enforce a user-configured policy before invocation: max price per MTok/image, per-request ceiling (computed from `max_tokens` × pinned price), per-day budget, allowed schemes, minimum trust tier. OS-integrated clients SHOULD surface this as a system-level control (the "data roaming" analogy: a global AI-spend switch).

## 4. Settlement operators

Any party may operate settlement (registries are the natural ones). Requirements: disclosed fee schedule in `GET /v0/health`; statements queryable by both sides; receipts as the dispute artifact. Nothing prevents a node from accepting several operators — operators compete on fee and reach, nodes multi-home.

## 5. Usage receipts

Response header `ONP-Receipt` carries (inline or by URL) a JWS signed by the node:

```json
{
  "receipt_id": "r_9f81…",
  "node_id": "ai.example-lab.inference",
  "offering_id": "llama-4-70b-instruct-fp8",
  "card_revision": "2026-08-20T12:00:00Z",
  "request_hash": "sha256:…",          // hash of canonical request, no content retained
  "usage": {"prompt_tokens": 1204, "completion_tokens": 833},
  "amount": {"currency": "USD", "value": 0.002162},
  "scheme": "x402",
  "payment_ref": "base:0xabc…",
  "issued_at": "2026-08-20T12:03:11Z"
}
```

Receipts are the audit primitive: clients verify `amount = usage × pinned price`; settlement operators redeem against them; registries sample them during conformance probes (§ONP-3 6.2) to catch usage inflation. Receipts contain no prompt/response content — only the hash, so either side can prove what request a receipt refers to without the receipt leaking data.

## 6. Disputes (informative, Draft 0.1)

Mismatched receipt vs. advertised price, or probe-detected usage inflation → registry marks offering `disputed`, which search surfaces and rank components consume. Financial recourse is between the parties/operator; ONP's job is making the evidence portable and signed.
