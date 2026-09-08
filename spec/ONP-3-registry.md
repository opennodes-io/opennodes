# ONP-3: Registry & Discovery API

**OpenNodes Protocol — Draft 0.1 — 2026-08-20**

A registry is any service implementing this API. The architecture copies what worked for the MCP Registry (meta-registry + OpenAPI interface + namespace challenges) and adds what that registry deliberately excluded — liveness, verification, ranking — because for *paid inference* those are the product.

---

## 1. Registry model

- **Registry as protocol.** Clients MAY be configured with any number of registries. A community "root" registry is a bootstrap default, not a privileged authority; the Node Card at the node's origin is always ground truth.
- **Pull-based indexing.** A registration stores the card's URL; the registry re-fetches cards on its own schedule (SHOULD ≥ every 6 h — mirroring HF's provider re-test cadence — plus on webhook ping). Registries never accept card *content* that isn't fetchable from the origin.
- **Layered offerings view.** Registries index at Model Offering granularity: search returns offerings (with node context), because "Llama-4-70B at $0.55/MTok in eu-central" is the unit of choice, not the vendor.

## 2. API summary (`/v0`)

| Method & path | Purpose |
|---|---|
| `POST /v0/nodes` | Register: `{"card_url": "https://…/.well-known/open-node.json"}` → returns challenge if namespace unproven |
| `POST /v0/nodes/{id}/verify` | Complete DNS/HTTP challenge |
| `PUT /v0/nodes/{id}/ping` | Ask registry to re-fetch the card now (after a revision) |
| `DELETE /v0/nodes/{id}` | Withdraw listing (card origin proof required) |
| `GET /v0/nodes/{id}` | Node detail: latest indexed card + registry-added observations |
| `GET /v0/offerings` | **Search** (§5) |
| `POST /v0/estimate` | Cost/latency estimate for a planned invocation or chain (§5a) |
| `GET /v0/offerings/{node_id}/{offering_id}` | Offering detail incl. observations, attestations, rank explanation |
| `GET /v0/attestations?subject=…` | VCs known for a node/offering |
| `GET /v0/health` | Registry self-description: ONP versions, ranking components (§6), federation peers (§8), fee policy |

Errors follow RFC 9457 (`application/problem+json`).

## 3. Registration lifecycle

`submitted → challenged → indexed(unverified) → community → verified → attested`, with `suspended` and `delisted` reachable from any state (probe failures, fraud, operator request). State transitions are recorded and queryable — listing history is part of a node's reputation.

## 4. Namespace verification

Identical family to the MCP Registry: prove control of the domain in `node.id` via **DNS TXT** (`_onp-challenge.{domain}`) or **HTTP** (`/.well-known/onp-challenge/{token}`). GitHub-style OAuth namespaces are NOT supported — an AI Node is a network service; origin control is the right proof.

**Institutional fast-track.** Registries MAY maintain institution allowlists (accredited universities, national/EuroHPC computation centres, government research bodies) keyed on domain class and published membership rosters. A namespace under a listed institution skips nothing technical (§4a still runs) but enters review at `verified`-candidate status and MAY carry an `institutional` badge in search results. This is the intended onboarding path for the first wave of supply.

## 4a. Admission testing — proof of resource

Registration alone never grants a trust tier. Tiers above `unverified` are gated by an **automated admission test battery** the registry runs against the live endpoints, using a probe allowance the node declares in its card (`payment.probe_allowance`: free request budget per registry per day) or paying as an ordinary client. All results are recorded as `onp:ConformanceResult` / `onp:BenchmarkResult` attestations (§7), so admission evidence is portable across registries.

**Stage A — Reachability & conformance (gate to `community`, minutes):**
1. Card well-formed, signed, fetchable; `health` endpoint live.
2. One blind invocation per offering through the declared binding profile; response schema, streaming, and `usage` accounting conform (ONP-4).
3. `GET /models` agrees with the card's offerings.

**Stage B — Identity & capability (gate to `verified`, hours–days):**
4. **Model identity fingerprint** — for open-weight artifacts: a fixed battery of prompts at temperature 0 with logprob/output-distribution comparison against a reference run of the claimed artifact+quantization; statistical mismatch ⇒ `disputed`, admission refused. For proprietary artifacts: only the vendor's own verified namespace may claim them (§6.3).
5. **Context verification** — retrieval probes (needle-in-haystack family) at 25/50/90% of the claimed `context_window`; failure caps the *advertised* window to the largest verified size rather than rejecting outright.
6. **Capacity ramp** — concurrent load stepped up toward claimed throughput; measures TTFT/TPS percentiles under load and sustains ≥ N minutes (registry-declared, default 15). Claimed `expected_ttft_ms`/`expected_tps` outside measured bounds are re-labeled with the registry's observed values in search results — the node's claims are never silently trusted over measurements.
7. **Capability spot-checks** — if `supports` declares `tool_calls`/`json_mode`/`vision`, one functional probe each.

**Stage C — Sustained observation (gate to full `verified` weight in rank, 7 days):**
8. Liveness probes at ≥5-minute cadence over a rolling window; availability below the card's declared `sla` blocks promotion.
9. Random low-volume blind invocations at unpredictable times (anti-"benchmark mode": a node cannot serve a bigger model only when it detects testing). Receipt sampling cross-checks `usage` honesty (§6.2).

**Re-verification.** Stage A re-runs on every card revision and at least every 6 h (the HF cadence); Stage B re-runs on any change to `model`, `serving`, or `hardware` blocks and quarterly otherwise; Stage C runs continuously. Failures demote tier and are visible in listing history (§3).

**Hardware claims** (optional, unlocks `attested` for the `hardware` block): TEE-based attestation where the stack supports it (e.g. NVIDIA confidential-computing quotes), an auditor's `onp:HardwareAttestation` VC, or a linked MLPerf submission. Hardware attestation is never required — measured performance (Stage B) is the primary truth; hardware metadata only explains it.

## 5. Search

`GET /v0/offerings` with filter parameters, all optional:

```
?modality=text
&family=llama-4              // or model artifact URI
&min_context=128000
&supports=tool_calls,json_mode
&lang=uk:strong               // language + minimum grade (ONP-2 §5)
&max_input_price=1.00        // USD per MTok
&region=eu
&scheme=x402                 // payment scheme
&tier=verified               // minimum trust tier
&basis=attested              // only attested performance/benchmarks
&sort=rank|price|ttft|tps|elo
&q=free-text
&limit=50&cursor=…
```

Responses return offering summaries: the card excerpt, trust tier, the **effective hardware allocation** (the offering-level `hardware` override if present, else the node-level declaration — see ONP-2 §6), registry **observations** (measured uptime, TTFT/TPS percentiles from probes, price history), and `rank` with `rank_explanation` (§6). Results MUST distinguish card-claimed vs. registry-observed vs. attested values; performance sorts (`ttft`, `tps`) MUST prefer observed values over claims.

## 5a. Estimation

`POST /v0/estimate` takes a planned invocation or chain and returns cost/latency bounds *before* any money moves — the primitive agent planners need:

```json
// request
{"steps": [
  {"offering": "ai.example-lab.inference/llama-4-70b-instruct-fp8",
   "est_input_tokens": 4000, "est_output_tokens": 800},
  {"select": {"family": "gpt-5", "min_tier": "verified"},
   "est_input_tokens": 6000, "est_output_tokens": 2000}
]}
// response
{"total": {"currency": "USD", "min": 0.021, "max": 0.043},
 "steps": [ {"offering": "…", "cost": {…}, "card_revision": "…",
             "expected_latency_ms": {"p50": 3400, "p95": 9100}} ]}
```

Steps may name a concrete offering or embed a §5 `select` query (the registry resolves it and reports which offering it priced). Estimates carry the `card_revision` they priced against, so the client can pin the same revision at invocation (ONP-4 §2) and the estimate is enforceable, not advisory. Estimation is free, unauthenticated, and side-effect-free.

## 5b. Recommendation (advisor)

`POST /v0/recommend` turns a task into a ranked shortlist with an enforceable estimate — the primitive an agent calls when it does not want to compose a search query itself (ONP-6 §6). The body carries either `task` (free text) or `features` — the output of a client-side feature extraction (modality, task class, language, estimated input/output tokens, needed capabilities, latency sensitivity, privacy sensitivity) — plus a `policy` (`min_tier`, `max_input_per_mtok`, `max_total_usd`, `region`, `prefer_local`, `preset`). Registries MUST accept `features` so a client never has to disclose its prompt; reference clients (gateway, stdio MCP server) extract features locally and send only those.

The response lists recommendations each with `offering`, pinned `card_revision`, `estimate` (§5a bounds), `score`, its `components` (quality prior, price, trust, measured performance) with the `weights` used, and human-readable `reasons`; the equivalent §5 search `query`; counts of considered/eligible offerings with per-filter rejection reasons; optionally a two-step ONP-6 scenario (cheap triage/draft → strong expert/refine) when it would plausibly save money; and MCP tool categories the task likely needs. Hard requirements (capabilities, context, data policy, tier, price) are filters, never score inputs. Quality priors MUST be labeled by basis (size heuristic, claimed benchmark, attested benchmark, or registry-measured task probes once available) and measured performance MUST outweigh claimed performance — the same discipline as §6.

The advisor is deliberately deterministic and reproducible: same catalog, same features, same policy → same answer, so an agent can audit a recommendation and a registry cannot hide a sponsored placement inside it (sponsorship, if any, is a labeled field per §6, never a score component).

## 6. Verification, observations, and ranking

Registries earn their place by turning claims into signals:

1. **Liveness probes** — `health` endpoint, RECOMMENDED ≥ every 5 min for `verified`+; uptime observations published per offering.
2. **Conformance probes** — periodic blind invocations through the advertised binding (registry pays like any client, or uses a node-granted probe allowance declared in the card). Checks: endpoint speaks the profile; streamed usage matches receipts; latency percentiles.
3. **Identity probes (anti-impersonation)** — for offerings claiming a known open-weight artifact, registries SHOULD run behavioral fingerprint tests (logprob/output distribution checks against a reference) and MUST downgrade `model.artifact` to `disputed` on failure. For proprietary artifacts (`urn:proprietary:*`), only the vendor's own verified namespace may claim them — a third party cannot list "gpt-5".
4. **Ranking** — each registry computes `rank` however it wants **but MUST publish, in `GET /v0/health`, the component list and weights** (e.g. `uptime:0.3, price:0.2, attested_quality:0.3, latency:0.2`) and per-result `rank_explanation` with component values. Undisclosed ranking inputs are non-conformant. Paid placement, if any, MUST be labeled `sponsored` and excluded from `rank`.

## 7. Attestations

Attestations are **W3C Verifiable Credentials 2.0** whose `credentialSubject` references `{node_id, offering_id, card_revision}`. Standard claim vocabularies defined by ONP:

- `onp:BenchmarkResult` — suite id, harness version, score, run date, methodology URL.
- `onp:ConformanceResult` — binding profile, test-suite version, pass/fail vector.
- `onp:UptimeObservation` — window, availability, probe count.
- `onp:HardwareAttestation` — accelerator inventory (e.g. via TEE quote or auditor).

Registries are attesters for their own observations; independent attesters (eval labs, universities, audit firms) are the intended trust market. Clients choose which attester keys they accept — attester reputation is out of protocol, exactly as CA trust stores are out of TLS.

## 8. Federation

Two mechanisms, both borrowed:

1. **Interface federation (MCP-Registry style):** any registry exposes this same OpenAPI; aggregators/clients merge results from several. `GET /v0/health` lists `peers` the registry itself mirrors.
2. **Mirror feed:** `GET /v0/export?since=…` streams signed card snapshots + observations (NDJSON) so downstream registries/aggregators can replicate without re-crawling. Attestations travel with the feed; observations remain signed by the originating registry, so provenance survives mirroring.

Vertical registries (medical-only, EU-only, on-prem enterprise) and OS-vendor registries (an Apple/Microsoft curated view) are expected specializations — same API, different curation policy.

## 9. Registry monetization hooks (informative)

The protocol is fee-neutral. Expected models, in ascending ambition: free/foundation-funded root (MCP-Registry style); listing fees for `verified` tier processing; attestation services; **settlement operation** (ONP-5 §4 — the OpenRouter-proven ~5% take on prepaid credits); sponsored placement (mandatory labeling per §6.4). Ad-financed inference and token exchanges are deliberately out of Draft 0.1 (no market precedent).
