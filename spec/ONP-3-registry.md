# ONP-3: Registry & Discovery API

**OpenNodes Protocol — Draft 0.1, revision 2 — 2026-10-31** ([changes](CHANGES.md))

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
| `GET /v0/locations` | **Where models run**: serving sites by country, with evidence and the models each serves (§5c) |
| `GET /v0/residency` | **Residency commitments**: what each provider promises about where data stays (§5d) |
| `GET /v0/attestations?subject=…` | VCs known for a node/offering |
| `GET /v0/health` | Registry self-description: ONP versions, ranking components (§6), federation peers (§8), fee policy |

Errors follow RFC 9457 (`application/problem+json`). The `type` member is `https://opennodes.io/problems/{name}` and `title` is the bare `{name}` (e.g. `unknown-node`, `namespace-mismatch`, `rate-limited`); clients SHOULD match on `title`. The names in use are listed at `https://opennodes.io/problems/`.

## 3. Registration lifecycle

`submitted → challenged → indexed(unverified) → community → verified → attested`, with `suspended` and `delisted` reachable from any state (probe failures, fraud, operator request). State transitions are recorded and queryable — listing history is part of a node's reputation.

## 4. Namespace verification

Identical family to the MCP Registry: prove control of the domain in `node.id` via **DNS TXT** (`_onp-challenge.{domain}`) or **HTTP** (`/.well-known/onp-challenge/{token}`). GitHub-style OAuth namespaces are NOT supported — an AI Node is a network service; origin control is the right proof.

**Binding (normative).** `node.id` is a reverse-DNS name (`io.example.ai` ↔ `ai.example.io`). A registry MUST accept a card, and an HTTP challenge response, only from a host that controls that name: the host equal to the id's domain, or a parent domain of it (the owner of `example.io` controls `io.example.*`). A child host never controls its parent's namespace (`alice.github.io` cannot claim `io.github`). Without this binding an HTTP challenge proves control of *a* server rather than of the namespace claimed, and any party could take over another operator's listing. The DNS TXT method is bound by construction.

**Probe credentials.** An operator whose API requires a key MAY hand the registry a probe credential at registration. A registry MUST hold it as pending until the namespace challenge succeeds (so a third party re-submitting the card cannot replace it), MUST attach it only to requests toward the card's own `endpoints` origins, and MUST NOT disclose it through any API. For such **card-only listings** — a signed card hosted as a static file, the operator's existing API as `endpoints.openai` — `endpoints.health` MAY be the OpenAI `/models` endpoint; a `200` with a `data` array counts as healthy.

**Claiming imported listings.** When a registered node reaches `community` or higher, a registry SHOULD retire imported catalog listings whose API host lies within that node's namespace (state `claimed`, recorded with the claiming node id), so an operator's verified listing replaces its unverified import instead of appearing beside it. The match is bound to the namespace: a node cannot claim listings served from hosts it does not control. Re-submitting a card for a node that is already listed MUST NOT change its state; the listing moves only when the fresh challenge is verified. Registries SHOULD rate-limit registration and verification per client and SHOULD limit how often the admission battery (§4a) can be triggered for a node, since the battery sends real load to the operator.

**Institutional fast-track.** Registries MAY maintain institution allowlists (accredited universities, national/EuroHPC computation centres, government research bodies) keyed on domain class and published membership rosters. A namespace under a listed institution skips nothing technical (§4a still runs) but enters review at `verified`-candidate status and MAY carry an `institutional` badge in search results. This is the intended onboarding path for the first wave of supply.

## 4a. Admission testing — proof of resource

Registration alone never grants a trust tier. Tiers above `unverified` are gated by an **automated admission test battery** the registry runs against the live endpoints, using a probe allowance the node declares in its card (`payment.probe_allowance`: free request budget per registry per day) or paying as an ordinary client. All results are recorded as `onp:ConformanceResult` / `onp:BenchmarkResult` attestations (§7), so admission evidence is portable across registries.

**Stage A — Reachability & conformance (gate to `community`, minutes):**
1. Card well-formed, signed, fetchable; `health` endpoint live. Card consistency: every offering declares `data_policy`, and every offering's `pricing.schemes` is a subset of the node's `payment.schemes` (ONP-2 §5).
2. One blind invocation per offering through the declared binding profile; response schema, streaming, and `usage` accounting conform (ONP-4).
3. `GET /models` agrees with the card's offerings.

**Stage B — Identity & capability (gate to `verified`, hours–days):**
4. **Model identity fingerprint** — for open-weight artifacts: a fixed battery of prompts at temperature 0 compared against a reference run of the claimed artifact+quantization on a deployment the registry trusts; mismatch ⇒ `disputed`, admission refused. Registries MAY compare exact output text (what the reference registry does in Draft 0.1: every prompt must match) or output/logprob distributions where the endpoint exposes them. Because outputs can legitimately differ across hardware, quantization kernels and batching even at temperature 0, a mismatch on hardware unlike the reference's SHOULD trigger a reference capture on comparable hardware or a review before `disputed` is final. A two-tier check (distribution comparison where logprobs exist, behavioral signature otherwise) is a Draft 0.2 item. When the offering declares `logprobs` (ONP-2 §5), registries SHOULD compare token log-probabilities; otherwise they compare outputs only and SHOULD record the result as lower-confidence. For proprietary artifacts: only the vendor's own verified namespace may claim them (§6.3).
5. **Context verification** — retrieval probes (needle-in-haystack family) at 25/50/90% of the claimed `context_window`; failure caps the *advertised* window to the largest verified size rather than rejecting outright. Probes SHOULD be sized in the model's own tokens (calibrated from the endpoint's reported `usage.prompt_tokens`), SHOULD place the fact near the *start* of the prompt so that an engine silently discarding the front of an over-long prompt fails, and SHOULD treat a reported `prompt_tokens` well below the probe size as a failed (truncated) probe. The verified size is the largest probe size at which that probe and every smaller one succeeded. Question wording SHOULD be plain ("what is the magic number"): small models refuse or mangle unusual tokens.
6. **Capacity ramp** — concurrent load stepped up toward claimed throughput; measures TTFT/TPS percentiles under load and sustains ≥ N minutes (registry-declared, default 15). Claimed `expected_ttft_ms`/`expected_tps` outside measured bounds are re-labeled with the registry's observed values in search results — the node's claims are never silently trusted over measurements.
7. **Capability spot-checks** — if `supports` declares `tool_calls`/`json_mode`/`vision`, one functional probe each.

**Stage C — Sustained observation (gate to full `verified` weight in rank, 7 days):**
8. Liveness probes at ≥5-minute cadence over a rolling window; availability below the card's declared `sla` blocks promotion. Consecutive liveness failures MAY suspend a node, but a liveness suspension is temporary: registries MUST keep probing a node suspended for liveness and SHOULD restore it to the tier it held after a small number of consecutive successes (the reference registry: 3 failures to suspend, 3 successes to reinstate). Suspensions for disputes, fraud, or operator request are not lifted this way. A transient outage — the operator's or the registry's own — must not become a permanent delisting.
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
&region=EU                   // residency: pinned regions and live serving sites (else node regions) entirely within this code
&location_basis=documented   // minimum evidence for every serving site (ONP-2 §3a)
&exclude_lineage=CN          // drop offerings whose declared model lineage includes these countries
&jurisdiction=eea            // operator country: eea (alias eu) or ISO 3166-1 codes, e.g. CA or DE,FI
&scheme=x402                 // payment scheme
&tier=verified               // minimum trust tier
&basis=attested              // only attested performance/benchmarks
&invocable=true              // only offerings with an invocation endpoint (drops listing-only imports)
&sort=rank|price|ttft|tps|elo
&q=free-text
&limit=50&cursor=…
```

Matching rules:
- `region=X` matches an offering when its residency codes are non-empty and **every** one lies within `X` under the containment rule of ONP-2 §3. The residency codes are all `data_policy.region_pinning` codes plus the regions of all live serving locations (ONP-2 §3a); when an offering has neither, the node's `regions`. A residency requirement is only met when no listed location falls outside it, so an offering served from Canada *and* the US does not match `region=CA`, and one whose `locations` is an empty list (unknown) matches no region.
- `location_basis=B` matches an offering that has at least one live serving location and whose every live location has a basis at least as strong as `B` (`claimed` < `documented` < `measured` < `attested`).
- `exclude_lineage=C1,C2` drops an offering when its `model.lineage_origins` contains any listed country. Offerings that declare no lineage are kept and MUST be shown as unknown, not as compliant.
- `lang=fr` matches the tag `fr` and its subtags (`fr-CA`); `lang=fr-CA` matches only `fr-CA`.
- `jurisdiction` matches the operator's country: as **declared** in a registered node's signed card, or **inferred** by the registry for an unclaimed import of a provider it knows (each offering carries `jurisdiction: {country, regions, basis}` with `basis` = `declared` | `inferred`). Offerings with no country never match. Clients that must not rely on inference filter on `basis` as well.

Responses return offering summaries: the card excerpt, trust tier, the effective serving `locations` (live only) and `residency` codes, the operator `jurisdiction` with the registry's server-location check (§6.4), the **effective hardware allocation** (the offering-level `hardware` override if present, else the node-level declaration — see ONP-2 §6), registry **observations** (measured uptime, TTFT/TPS percentiles from probes, price history), and `rank` with `rank_explanation` (§6). Results MUST distinguish card-claimed vs. registry-observed vs. attested values; performance sorts (`ttft`, `tps`) MUST prefer observed values over claims.

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

Steps may name a concrete offering or embed a §5 `select` query (the registry resolves it and reports which offering it priced). Estimates carry the `card_revision` they priced against, so the client can pin the same revision at invocation (ONP-4 §2) and the estimate is enforceable, not advisory. Estimation is side-effect-free. Public registries SHOULD offer it free and without authentication. Any registry MAY require authentication (a private or entitlement-scoped catalogue will), and every registry SHOULD rate-limit `estimate` and `recommend` per client, answering `429` per ONP-4 §9.

## 5b. Recommendation (advisor)

`POST /v0/recommend` turns a task into a ranked shortlist with an enforceable estimate — the primitive an agent calls when it does not want to compose a search query itself (ONP-6 §6). The body carries either `task` (free text) or `features` — the output of a client-side feature extraction (modality, task class, language, estimated input/output tokens, needed capabilities, latency sensitivity, privacy sensitivity) — plus a `policy` (`min_tier`, `max_input_per_mtok`, `max_total_usd`, `region`, `jurisdiction`, `prefer_local`, `preset`); `jurisdiction` has the §5 meaning, and offerings running on the user's own machine or network always satisfy it. Registries MUST accept `features` so a client never has to disclose its prompt; reference clients (gateway, stdio MCP server) extract features locally and send only those.

The response lists recommendations each with `offering`, pinned `card_revision`, `estimate` (§5a bounds), `score`, its `components` (quality prior, price, trust, measured performance) with the `weights` used, and human-readable `reasons`; the equivalent §5 search `query`; counts of considered/eligible offerings with per-filter rejection reasons; optionally a two-step ONP-6 scenario (cheap triage/draft → strong expert/refine) when it would plausibly save money; and MCP tool categories the task likely needs. Hard requirements (capabilities, context, data policy, tier, price) are filters, never score inputs. Quality priors MUST be labeled by basis (size heuristic, claimed benchmark, attested benchmark, or registry-measured task probes once available) and measured performance MUST outweigh claimed performance — the same discipline as §6.

The advisor is deliberately deterministic and reproducible: same catalog, same features, same policy → same answer, so an agent can audit a recommendation and a registry cannot hide a sponsored placement inside it (sponsorship, if any, is a labeled field per §6, never a score component).


## 5c. Where models run

`GET /v0/locations` answers "which providers serve which models in this country, and who says so": every known serving site, with its evidence and the models it serves. Registries that hold location data SHOULD offer it.

```
?country=CA          // or region=CA-QC; containment as in ONP-2 §3
&basis=documented    // minimum evidence for a site
&status=live         // live | planned; omit for both
&model=gpt-oss       // substring of a model name or artifact; keeps only sites serving a match
&exclude_lineage=CN  // drops models whose declared lineage includes these countries
&residency=processing // keeps sites covered by a commitment at least this strong (ONP-2 §3b)
&availability=opt_in // with residency: default < opt_in < enterprise; counts commitments up to this
&near=45.50,-73.57   // a WGS 84 point: adds distance_km to each site, nearest first
&within_km=300       // with near: great-circle radius; country-level points never match
&format=csv          // one row per site and model; or format=geojson (RFC 7946)
```

```json
{"summary": {"countries": 1, "sites": 24, "located_offerings": 41, "unlocated_offerings": 9970},
 "countries": [{"country": "CA", "providers": 14, "sites": 24, "live_sites": 20, "models": 37}],
 "sites": [{"node_id": "…", "provider": "…", "operator_country": "US", "tier": "unverified", "source": "import",
            "country": "CA", "region": "CA-QC", "site": "Montréal (ca-central-1)", "status": "live",
            "basis": "documented", "source_url": "https://…", "checked": "2026-11-02",
            "geo": {"lat": 45.5019, "lon": -73.5674, "precision": "city", "derived": false},
            "models": [{"offering_id": "…", "name": "…", "artifact": "…", "lineage_origins": ["US"]}],
            "models_note": null}]}
```

- A site is one (node, region, site) triple. It lists the models of every offering whose effective locations include it, live or planned, so planned capacity is visible without counting as serving in §5 search.
- Sources are node cards (registered and imported) and **curated seeds**: dated, source-linked datasets maintained with the registry, for providers that publish sites but not machine-readable cards. A seed provider that publishes sites but no model list appears with `models: []` and a `models_note`.
- `summary.unlocated_offerings` counts offerings with no known location. Registries SHOULD publish it: it is the size of the gap.
- **Points.** Each site carries `geo`: the location's own point (`derived: false`), or an approximate label point for its region or country (`derived: true`, `precision` `region` or `country`), or `null`. A `within_km` radius matches only points placed at least to the region, because a country-level placeholder says nothing about distance.
- **GeoJSON.** `format=geojson` returns an RFC 7946 FeatureCollection (`application/geo+json`) with one Point feature per site that has a point, coordinates in `[lon, lat]` order. Properties are flat, with lists joined by `"; "`, so desktop GIS tools read them as columns. The foreign member `unmapped` counts sites without a point.
- `measured` is the only basis a registry may assign (ONP-2 §3a). It requires probe points inside the region under test, and the registry MUST record which probe points produced it.
- Sites of registered nodes carry `server_check`: the registry's server-location result for the node's API host (§6.4: verdict, server country, latency verdict, date). It tests where the endpoint answers from, not each declared site, so a passing check does not by itself make a site `measured`.
- Sites carry `residency`: the provider's commitments (ONP-2 §3b) that apply at that site, meaning those whose scope contains the site's region, plus any `none` or `unstated` entry. A site in Ohio does not inherit a provider's EU commitment. `residency=` keeps sites with a covering commitment at least as strong as the value (`storage` also matches `processing`).
- A curated seed entry MAY describe an existing node instead of creating its own listing. Its sites and residency are then shown under that node, and its offerings are placed at those sites only when the seed says every model is served from every listed site. This changes nothing in §5 search, which reads cards only.

## 5d. Residency commitments

`GET /v0/residency` lists what each provider promises about where data stays (ONP-2 §3b), from cards and curated seeds, including providers with no known sites, such as routers. Each entry carries the node ids it covers, the provider's `kind` (`inference`, `cloud`, `lab`, `router`, `local`, `unknown`), its operator country, the number of known sites and its commitments, each with source and date.

```
?scope=EU            // keeps providers with a processing or storage commitment that keeps data within EU:
                     // every scope code inside it, or with per_region one of them
&commitment=processing
&availability=default // default < opt_in < enterprise; counts commitments up to this
&kind=inference
&format=csv
```

`summary` counts providers by their strongest commitment, so the share of providers that state nothing is visible.

## 6. Verification, observations, and ranking

Registries earn their place by turning claims into signals:

### 6.1 Liveness probes
`health` endpoint, RECOMMENDED ≥ every 5 min for `verified`+; uptime observations published per offering.

### 6.2 Conformance probes
Periodic blind invocations through the advertised binding (registry pays like any client, or uses a node-granted probe allowance declared in the card). Checks: endpoint speaks the profile; streamed usage matches receipts (receipt sampling, ONP-5 §5); latency percentiles.

### 6.3 Identity probes (anti-impersonation)
For offerings claiming a known open-weight artifact, registries SHOULD run behavioral fingerprint tests (exact-output or distribution checks against a reference, §4a.4; log-probability comparison where `logprobs` is declared) and MUST downgrade `model.artifact` to `disputed` on a confirmed failure. For proprietary artifacts (`urn:proprietary:*`), only the vendor's own verified namespace may claim them — a third party cannot list "gpt-5".

### 6.4 Server-location checks (anti residency misstatement, ONP-1 §6 threat 5)
Registries SHOULD check where a node's API host is: (a) geolocation and network owner of its public IP address, reporting CDN/anycast networks as such rather than as a location; (b) TCP round-trip times from two or more probe sites in known places, compared with the physical minimum (light in fibre ≈ 100 km per ms of round trip) for the geolocated point. Results are published per node (`location`: `verdict` = `match` | `same_region` | `mismatch` | `cdn` | `inconsistent` | `unknown`, the server's country and network, per-site RTTs) and, in search results, under `jurisdiction.location`. A jurisdiction filter (§5) MUST exclude an offering whose server was found outside the requested jurisdiction (unless behind a CDN, or its geolocation is contradicted by latency). These checks are evidence, not proof: a front server in one country forwarding requests elsewhere defeats both, which is why attested residency (§7) remains the strong guarantee. The reference registry checks registered nodes after admission and all candidates for jurisdiction filters daily, from Nuremberg (DE) and Helsinki (FI).

### 6.5 Ranking
Each registry computes `rank` however it wants **but MUST publish, in `GET /v0/health`, the component list and weights** (e.g. `uptime:0.3, price:0.2, attested_quality:0.3, latency:0.2`) and per-result `rank_explanation` with component values. Undisclosed ranking inputs are non-conformant. Paid placement, if any, MUST be labeled `sponsored` and excluded from `rank`.

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

The protocol is fee-neutral. Expected models, in ascending ambition: free/foundation-funded root (MCP-Registry style); listing fees for `verified` tier processing; attestation services; **settlement operation** (ONP-5 §4 — the OpenRouter-proven ~5% take on prepaid credits); sponsored placement (mandatory labeling per §6.5). Ad-financed inference and token exchanges are deliberately out of Draft 0.1 (no market precedent).
