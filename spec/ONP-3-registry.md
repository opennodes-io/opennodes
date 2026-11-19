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
| `GET /v0/stats/requests` | **Request counts**: how often search, recommend and MCP returned each node, per ISO week (§6.6; optional) |
| `GET /v0/vendors` | **Vendor-namespace table**: which namespaces may claim `urn:proprietary:{vendor}:*` artefacts (§6.3) |
| `GET /v0/attestations?subject=…` | VCs known for a node/offering |
| `GET /v0/health` | Registry self-description: ONP versions, ranking components (§6), federation peers (§8), fee policy |

Errors follow RFC 9457 (`application/problem+json`). The `type` member is `https://opennodes.io/problems/{name}` and `title` is the bare `{name}` (e.g. `unknown-node`, `namespace-mismatch`, `rate-limited`); clients SHOULD match on `title`. The names in use are listed at `https://opennodes.io/problems/`.

## 3. Registration lifecycle

`submitted → challenged → indexed(unverified) → community → verified → attested`, with `suspended` and `delisted` reachable from any state (probe failures, fraud, operator request), and `disputed` reachable from `community` and above when the registry finds evidence that a node does not serve what it claims (§4a.4). State transitions are recorded and queryable — listing history is part of a node's reputation.

**Disputes end only with a recorded resolution.** A `disputed` node leaves search. Nothing the operator does clears the state by itself: registering again, completing a fresh challenge or asking for a card re-fetch MUST NOT change it. It ends when the registry records a resolution after review, as a transition whose reason says what was found and done (the reference registry: `POST /v0/admin/nodes/{id}/resolve` with `{"resolution": "…"}`, which returns the node to `indexed`; Stage A runs at once and Stage B again on the registry's schedule).

## 4. Namespace verification

Identical family to the MCP Registry: prove control of the domain in `node.id` via **DNS TXT** (`_onp-challenge.{domain}`) or **HTTP** (`/.well-known/onp-challenge/{token}`). GitHub-style OAuth namespaces are NOT supported — an AI Node is a network service; origin control is the right proof.

**Binding (normative).** `node.id` is a reverse-DNS name (`io.example.ai` ↔ `ai.example.io`). A registry MUST accept a card, and an HTTP challenge response, only from a host that controls that name: the host equal to the id's domain, or a parent domain of it (the owner of `example.io` controls `io.example.*`). A child host never controls its parent's namespace (`alice.github.io` cannot claim `io.github`). Without this binding an HTTP challenge proves control of *a* server rather than of the namespace claimed, and any party could take over another operator's listing. The DNS TXT method is bound by construction.

**Probe credentials.** An operator whose API requires a key MAY hand the registry a probe credential at registration. A registry MUST hold it as pending until the namespace challenge succeeds (so a third party re-submitting the card cannot replace it), MUST attach it only to requests toward the card's own `endpoints` origins, and MUST NOT disclose it through any API. For such **card-only listings** — a signed card hosted as a static file, the operator's existing API as `endpoints.openai` — `endpoints.health` MAY be the OpenAI `/models` endpoint; a `200` with a `data` array counts as healthy.

**Claiming imported listings.** When a registered node reaches `community` or higher, a registry SHOULD retire imported catalog listings whose API host lies within that node's namespace (state `claimed`, recorded with the claiming node id), so an operator's verified listing replaces its unverified import instead of appearing beside it. The match is bound to the namespace: a node cannot claim listings served from hosts it does not control. Re-submitting a card for a node that is already listed MUST NOT change its state. Completing the fresh challenge re-indexes the card and runs Stage A under the rules for listed nodes, but MUST NOT reset the tier of a listed node, clear `disputed` (§3), or move when Stage B next runs. Registries SHOULD rate-limit registration, verification and card re-fetch requests per client. A registry MUST NOT let a node's operator or a third party choose when Stage B (§4a) runs: it runs on the registry's own schedule. A registry MAY also run it on its administrator's request; it sends real load to the operator, and a battery the operator can time is one it can prepare for.

**Institutional fast-track.** Registries MAY maintain institution allowlists (accredited universities, national/EuroHPC computation centres, government research bodies) keyed on domain class and published membership rosters. A namespace under a listed institution skips nothing technical (§4a still runs) but enters review at `verified`-candidate status and MAY carry an `institutional` badge in search results. This is the intended onboarding path for the first wave of supply. The badge is an operator mark (§4b).

## 4a. Admission testing — proof of resource

Registration alone never grants a trust tier. Tiers above `unverified` are gated by an **automated admission test battery** the registry runs against the live endpoints, using a probe allowance the node declares in its card (`payment.probe_allowance`: free request budget per registry per day) or paying as an ordinary client. All results are recorded as `onp:ConformanceResult` / `onp:BenchmarkResult` attestations (§7), so admission evidence is portable across registries.

**Probe prompts.** A probe is only a test if the node cannot tell it from a customer's request. Every chat request a registry sends in Stages A, B and C SHOULD be worded like ordinary client traffic and MUST NOT identify itself as a probe (no fixed prefix, no marker). The prompts come from a **probe corpus** the registry keeps private: identity prompts (Stage B item 4) MUST NOT be published or derivable from public material, such as the registry's source code, and the other probe text SHOULD NOT be either. A registry publishes how much it sends (probe load, below), never what. The reference registry reads its corpus from a file named by `ONP_PROBE_CORPUS`; without one it uses a small public development corpus and says so in `GET /v0/health` (`admission.probe_corpus.private: false`).

**Stage A — Reachability & conformance (gate to `community`, minutes):**
1. Card well-formed, signed, fetchable; `health` endpoint live. Card consistency: every offering declares `data_policy`, and every offering's `pricing.schemes` is a subset of the node's `payment.schemes` (ONP-2 §5). Every proprietary artefact (`urn:proprietary:*`) is claimed from the vendor's own namespace (§6.3).
2. One blind invocation per offering through the declared binding profile; response schema, streaming, and `usage` accounting conform (ONP-4).
3. `GET /models` agrees with the card's offerings.

**Stage B — Identity & capability (gate to `verified`, hours–days):**
4. **Model identity fingerprint** — for open-weight artifacts: a fixed battery of prompts at temperature 0 compared against a reference run of the claimed artifact+quantization on a deployment the registry trusts; mismatch ⇒ `disputed`, admission refused. Registries MAY compare exact output text (what the reference registry does in Draft 0.1: every prompt must match) or output/logprob distributions where the endpoint exposes them. Because outputs can legitimately differ across hardware, quantization kernels and batching even at temperature 0, a mismatch on hardware unlike the reference's SHOULD trigger a reference capture on comparable hardware or a review before `disputed` is final. A two-tier check (distribution comparison where logprobs exist, behavioral signature otherwise) is a Draft 0.2 item. When the offering declares `logprobs` (ONP-2 §5), registries SHOULD compare token log-probabilities; otherwise they compare outputs only and SHOULD record the result as lower-confidence. For proprietary artifacts: only the vendor's own verified namespace may claim them (§6.3).
   - **No reference, no `verified`.** An offering whose identity the registry could not check has *unverified* identity, and a registry MUST NOT promote its node to `verified` on it: no reference for the claimed artefact, only references captured with prompts that were public, or a proprietary artefact the node may not claim. Unverified identity is not a dispute: the node stays at `community`, and a `verified` node re-tested this way returns to `community`.
   - **References.** The registry captures references itself, from a deployment of the claimed artefact and quantization it trusts, with prompts from its private corpus. Each run SHOULD ask a random subset of them (the reference registry captures 8 and asks 3). A reply that does not match SHOULD be asked once more before it counts, since batching can change a temperature-0 reply now and then; a mismatch on the repeat is a confirmed failure.
   - **Signed card.** A registry MUST NOT promote a node whose latest card's signature does not verify (ONP-2 §8).
5. **Context verification** — retrieval probes (needle-in-haystack family) at 25/50/90% of the claimed `context_window`; failure caps the *advertised* window to the largest verified size rather than rejecting outright. Probes SHOULD be sized in the model's own tokens (calibrated from the endpoint's reported `usage.prompt_tokens`), SHOULD place the fact near the *start* of the prompt so that an engine silently discarding the front of an over-long prompt fails, and SHOULD treat a reported `prompt_tokens` well below the probe size as a failed (truncated) probe. The verified size is the largest probe size at which that probe and every smaller one succeeded. Question wording SHOULD be plain ("what is the magic number"): small models refuse or mangle unusual tokens.
6. **Capacity ramp** — concurrent load stepped up toward claimed throughput; measures TTFT/TPS percentiles under load and sustains ≥ N minutes (registry-declared, default 15). Claimed `expected_ttft_ms`/`expected_tps` outside measured bounds are re-labeled with the registry's observed values in search results — the node's claims are never silently trusted over measurements.
7. **Capability spot-checks** — if `supports` declares `tool_calls`/`json_mode`/`vision`, one functional probe each.

**Stage C — Sustained observation (gate to full `verified` weight in rank, 7 days):**
8. Liveness probes at ≥5-minute cadence over a rolling window; availability below the card's declared `sla` blocks promotion. Consecutive liveness failures MAY suspend a node, but a liveness suspension is temporary: registries MUST keep probing a node suspended for liveness and SHOULD restore it to the tier it held after a small number of consecutive successes (the reference registry: 3 failures to suspend, 3 successes to reinstate). Suspensions for disputes, fraud, or operator request are not lifted this way. A transient outage — the operator's or the registry's own — must not become a permanent delisting.
9. Random low-volume blind invocations at unpredictable times (anti-"benchmark mode": a node cannot serve a bigger model only when it detects testing), worded from the private corpus. A blind invocation passes when the reply conforms to the binding profile (content and `usage`). Every `409` answer MUST be recorded. When it says the pinned revision is stale, the registry re-fetches the card; if the revision really changed it MAY retry once with the new pin and excuse the `409`, a bounded number of times per node and day (the reference registry: 3). Any other `409`, one with the current revision pinned or beyond the bound, counts as a failed invocation. Repeated failed blind invocations while the node answers its health checks MUST cost the node its tier (the reference registry: 3 in a row since the node's last state change drop it one tier, `verified` to `community`, `community` to `unverified`; the scheduled stages bring it back). A node that does not answer its health checks gets the liveness rules of item 8 instead. Receipt sampling cross-checks `usage` honesty (§6.2); the reference registry does not implement it yet and records only whether a receipt was returned.

**Coverage.** Verification covers only binding profiles that have a defined battery, which in the reference registry today is `onp.openai.chat/v1`: a tier is evidence about the offerings the battery could call and no others, so a registry MUST NOT let another offering inherit its node's tier, and a node with no offering it can call passes neither Stage A nor Stage B (the reference registry caps such offerings to `unverified`, marks them `tested: false` in search results, lists them as `verification.untested_offerings` in node detail and the export feed, and reports a Stage C sweep with nothing to call as `verification.blind_skipped`).

**Re-verification.** Stage A re-runs on every card revision and at least every 6 h (the HF cadence); Stage B runs after a node reaches `community`, re-runs on any change to a tested offering's `model`, `serving`, or `hardware` block or to the node's API endpoint, and at least quarterly otherwise; Stage C runs continuously. Stage B runs at times the registry chooses and does not publish, so that an operator cannot prepare for it. Failures demote tier and are visible in listing history (§3): a structural Stage A failure (the card itself, not an outage) returns a listed node to `unverified`, and a Stage B run that does not pass returns a `verified` node to `community`. The reference registry, with `ONP_SCHEDULE` on (the default), runs the first Stage B 1–24 h after a node reaches `community`, a re-run within 1 h of a change, another 7 days after a run that did not pass, and after a pass the next one at a uniformly random time between 1 and 91 days later. Nodes it verified before this schedule existed get their first scheduled Stage B 1–7 days after the upgrade.

**Probe load.** Registries SHOULD publish what each stage sends to a node: which requests, how large, how often, and what triggers them, so an operator can size the probe allowance. Publishing the load MUST NOT publish the prompts or the next run times. The reference registry publishes its load on the qualification page of its web app (`/#/qualification`). Per chat offering it sends 1 blind invocation in each Stage A run (at least every 6 h); up to 20 in Stage B (3 identity prompts sampled from 8 references, 1 calibration call, 3 context probes at 25/50/90% of the claimed window, and one batch each of 1, 4 and 8 parallel requests within a 3-second budget), plus one repeat for each identity reply that does not match; and per node, in Stage C, a health check every 5 minutes and 1 blind invocation every hour, both on average with randomized gaps, plus one retry after an excused `409`.

**Hardware claims** (optional, unlocks `attested` for the `hardware` block): TEE-based attestation where the stack supports it (e.g. NVIDIA confidential-computing quotes), an auditor's `onp:HardwareAttestation` VC, or a linked MLPerf submission. Hardware attestation is never required — measured performance (Stage B) is the primary truth; hardware metadata only explains it.

## 4b. Operator marks

A registry MAY attach marks to a node: labels for facts its admission tests cannot establish. Two are defined:

- `institutional`: the operator is an institution on the registry's allowlist (§4, institutional fast-track).
- `founding`: the operator is one of the first operators the registry recruited, for example before a public launch.

Marks are set and cleared by the registry, never by the node, and are not lifecycle transitions (§3). They MUST NOT be rank inputs (§6.5) and MUST NOT skip or soften any part of §4a. A registry SHOULD set them only on registered nodes whose namespace it has verified, never on unclaimed imports. A registry that uses marks publishes each as a boolean, `false` when unset, in the node directory (`GET /v0/nodes`), in node detail and in every search result, so clients can show them or ignore them. The reference registry sets them with admin requests `POST /v0/admin/nodes/{id}/institutional` and `POST /v0/admin/nodes/{id}/founding`, with bodies `{"institutional": true|false}` and `{"founding": true|false}`.

## 5. Search

`GET /v0/offerings` with filter parameters, all optional:

```
?modality=text
&family=llama-4              // or model artifact URI
&min_context=128000
&supports=tool_calls,json_mode
&lang=uk:strong               // language + minimum grade (ONP-2 §5)
&max_input_price=1.00        // USD per MTok
&region=EU                   // residency: pinned regions and live serving sites (else node regions) entirely within this code; EU and EEA include member states
&location_basis=documented   // minimum evidence for every serving site (ONP-2 §3a)
&exclude_lineage=CN          // drop offerings whose declared model lineage includes these countries
&lineage=declared            // also drop offerings that declare no lineage (default: any)
&retention=none              // data policy: at most this retention (none < ephemeral < logged)
&no_training=true            // data policy: training_on_inputs is false
&trust=trusted               // only the trusted pool (§5e); open (default) = both pools
&jurisdiction=eea            // declared (or inferred) operator country: eea (alias eu) or ISO 3166-1 codes, e.g. CA or DE,FI
&server_check=passed         // the registry's server-location check passed (§6.4); any (default) = no requirement
&scheme=x402                 // payment scheme
&tier=verified               // minimum trust tier
&basis=attested              // only attested performance/benchmarks
&invocable=true              // only offerings with an invocation endpoint (drops listing-only imports)
&sort=rank|price|ttft|tps|elo
&q=free-text
&limit=50&cursor=…
```

Matching rules:
- `region=X` matches an offering when its residency codes are non-empty and **every** one lies within `X` under the containment rule of ONP-2 §3. The residency codes are all `data_policy.region_pinning` codes plus the regions of all live serving locations (ONP-2 §3a, or a curated seed's placement when the card declares none, §5c); when an offering has neither, the node's `regions`. A residency requirement is only met when no listed location falls outside it, so an offering served from Canada *and* the US does not match `region=CA`, one served from Frankfurt and Paris matches `region=EU` (ONP-2 §3: `EU` contains its member states) but one also served from London does not, and one whose `locations` is an empty list (unknown) matches no region.
- `location_basis=B` matches an offering that has at least one live serving location and whose every live location has a basis at least as strong as `B` (`claimed` < `documented` < `measured` < `attested`).
- `exclude_lineage=C1,C2` drops an offering when its `model.lineage_origins` contains any listed country. Offerings that declare no lineage are kept and MUST be shown as unknown, not as compliant.
- `lineage=declared` drops offerings whose model declares no `lineage_origins` (absent or empty). With `exclude_lineage` it gives a strict origin policy: a declared lineage and none of the listed countries.
- `retention=R` matches an offering whose `data_policy.retention` is at most `R` (`none` < `ephemeral` < `logged`; an unknown value counts as `logged`). `no_training=true` matches an offering whose `data_policy.training_on_inputs` is `false`. When either filter is used, an offering without a `data_policy`, or without the field the filter reads, does not match.
- `trust=trusted` keeps only the trusted pool (§5e); `trust=open` or no `trust` keeps both pools.
- A registry MUST answer `400` (`bad-query`) to an unknown value of `trust`, `lineage`, `retention`, `no_training` or `server_check`, rather than ignore it: these filters protect personal data, and a misspelt value must not widen the result.
- `lang=fr` matches the tag `fr` and its subtags (`fr-CA`); `lang=fr-CA` matches only `fr-CA`.
- `jurisdiction` matches the operator's country: as **declared** in a registered node's signed card, or **inferred** by the registry for an unclaimed import of a provider it knows (each offering carries `jurisdiction: {country, regions, basis}` with `basis` = `declared` | `inferred`). Offerings with no country never match, and neither do offerings whose server the registry located outside the jurisdiction (§6.4). Clients that must not rely on inference filter on `basis` as well. The match is a statement by the operator (or the registry's inference), not proof of where requests are processed, so a registry MUST NOT present it as residency: a user interface labels it as a declaration together with the evidence level, for example "EU-declared operator, server front checked", and every hosted offering summary carries `jurisdiction.server_check` (§6.4). The reference registry also gives `jurisdiction.evidence`, the same in words ("FR operator (EEA, declared), server front checked (FR)").
- `server_check=passed` keeps hosted offerings whose server-location check passed (`jurisdiction.server_check` is `passed` or `passed_origin`, §6.4); models on the user's own machine are kept. `server_check=any` or no `server_check` sets no requirement.
- `retention`, `no_training` and the rest of `data_policy` are what the operator declares (ONP-2 §5); probing cannot verify them, and a registry presents them as declared.

Responses return offering summaries: the card excerpt, trust tier (with `tested`: whether the admission battery covers this offering, §4a), the effective serving `locations` (live only) and `residency` codes, the operator `jurisdiction` with the registry's server-location check (§6.4), the **effective hardware allocation** (the offering-level `hardware` override if present, else the node-level declaration — see ONP-2 §6), registry **observations** (measured uptime, TTFT/TPS percentiles from probes, price history), the offering's `pool` (`trusted` or `open`, §5e), and `rank` with `rank_explanation` (§6). Results MUST distinguish card-claimed vs. registry-observed vs. attested values; performance sorts (`ttft`, `tps`) MUST prefer observed values over claims.

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

`POST /v0/recommend` turns a task into a ranked shortlist with an enforceable estimate — the primitive an agent calls when it does not want to compose a search query itself (ONP-6 §6). The body carries either `task` (free text) or `features` — the output of a client-side feature extraction (modality, task class, language, estimated input/output tokens, needed capabilities, latency sensitivity, privacy sensitivity) — plus a `policy` (`min_tier`, `max_input_per_mtok`, `max_total_usd`, `region`, `jurisdiction`, `server_check`, `prefer_local`, `preset`, `sensitive`); `region`, `jurisdiction` and `server_check` have the §5 meanings (so a hosted offering with no known location does not satisfy `region`, and `jurisdiction` is the declared or inferred operator country), and offerings running on the user's own machine or network (defined below) always satisfy all three. An unknown `server_check` value is answered with `400`. `sensitive: true` (or `trust: "trusted"`) marks a task that carries personal data: only the trusted pool (§5e) qualifies, under the registry's own trusted view, which the request cannot replace; the response then carries `trusted_view`, and an empty `recommendations` list means nothing qualified. Every recommendation carries its `pool`, and every hosted one its `server_check` (§6.4). Registries MUST accept `features` so a client never has to disclose its prompt; reference clients (gateway, stdio MCP server) extract features locally and send only those.

The response lists recommendations each with `offering`, pinned `card_revision`, `estimate` (§5a bounds), `score`, its `components` (quality prior, price, trust, measured performance) with the `weights` used, and human-readable `reasons`; the equivalent §5 search `query`; counts of considered/eligible offerings with per-filter rejection reasons; optionally a two-step ONP-6 scenario (cheap triage/draft → strong expert/refine) when it would plausibly save money; and MCP tool categories the task likely needs. Hard requirements (capabilities, context, data policy, tier, price) are filters, never score inputs. Quality priors MUST be labeled by basis (size heuristic, claimed benchmark, attested benchmark, or registry-measured task probes once available) and measured performance MUST outweigh claimed performance — the same discipline as §6.

The advisor is deliberately deterministic and reproducible: same catalog, same features, same policy → same answer, so an agent can audit a recommendation and a registry cannot hide a sponsored placement inside it (sponsorship, if any, is a labeled field per §6, never a score component).

**The user's own network (clients).** A client that also routes to other machines on the user's network (the reference Ollama router) treats them as follows:

- A LAN peer counts as the user's own network only when the user pinned the key that signs its card (ONP-2 §8) and the peer answers at the origin that card names in `endpoints.openai`. The client verifies the card signature against the pinned key, named by its RFC 7638 thumbprint, and verifies it again whenever it reloads the card. A signature shows who wrote a card, not who serves it, so a copied card served from another address MUST NOT be pinned. Only a pinned peer satisfies `region`, `jurisdiction`, a private-only preset and the trusted pool's "own machine or network" condition (§5e).
- A peer the user added by address alone, or a plain inference server with no card, is an offering of unknown operator, location and data policy. It ranks as `unverified`, satisfies none of those, and the client MAY still send it requests that name it.
- A missing `data_policy` is unknown. It MUST NOT be read as `retention: none` or `training_on_inputs: false`.
- Discovery (for example mDNS) MUST be off unless the user turns it on. A discovered peer is used only when it is pinned. A discovery record that advertises an origin on another host than the one that sent it is ignored, and the client uses the sender's address instead.
- The client invokes a LAN peer at the origin it reached, not at another origin its card names.
- A client that serves a local HTTP API MUST NOT allow cross-origin requests from any web page (no `Access-Control-Allow-Origin: *`). Routes that add peers or show the catalogue, receipts or advice MUST require a credential. Model routes MAY accept requests from the same machine without one, when the Host is a loopback name and any browser `Origin` is a local page or one the user allowed. A client that listens on other interfaces MUST require the credential for requests from other machines.


## 5c. Where models run

`GET /v0/locations` answers "which providers serve which models in this country, and who says so": every known serving site, with its evidence and the models it serves. Registries that hold location data SHOULD offer it.

```
?country=CA          // or region=CA-QC; containment as in ONP-2 §3
&basis=documented    // minimum evidence for a site
&status=live         // live | planned; omit for both
&model=gpt-oss       // substring of a model name or artifact; keeps only sites serving a match
&exclude_lineage=CN  // drops models whose declared lineage includes these countries
&lineage=declared    // also drops models that declare no lineage
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
- Sites of registered nodes carry `server_check`: the registry's server-location result for the node's API host (§6.4: verdict, server country, latency verdict, date, the evidence `level` and, behind a CDN, the declared `origin`'s verdict). It tests where the endpoint answers from, not each declared site, so a passing check does not by itself make a site `measured`.
- Sites carry `residency`: the provider's commitments (ONP-2 §3b) that apply at that site, meaning those whose scope contains the site's region, plus any `none` or `unstated` entry. A site in Ohio does not inherit a provider's EU commitment. `residency=` keeps sites with a covering commitment at least as strong as the value (`storage` also matches `processing`).
- A curated seed entry MAY describe an existing node instead of creating its own listing. Its sites and residency are then shown under that node, and its offerings are placed at those sites only when the seed says every model is served from every listed site (`placement: "all"`), or names another entry whose sites serve the node's whole API (`serves_from`). In those two cases, and only for offerings whose card declares no location, §5 search and §5a recommend also use the seed's live sites as serving locations. Each one is marked `via: "seed"` and keeps its `basis` (`claimed` or `documented`), so `location_basis=` can exclude them. A seed placement MUST NOT apply to a listing reached through a third-party router (the Hugging Face router, OpenRouter): the request passes through the router first, so the provider's sites do not say where the prompt goes.

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

## 5e. Trusted and open pools

Any operator may list, wherever it is. A registry MAY divide offerings into two pools by what a client may send them:

- the **open pool**: every listed offering. It is for tasks with no personal data and no security requirement;
- the **trusted pool**: offerings that meet the registry's **trusted view**. Personal data and sensitive work go only here.

The trusted view combines the §5 filters. An offering is in the trusted pool when all of these hold:

1. its model declares a lineage (`lineage=declared`) and the lineage includes none of the excluded countries (reference registry: `CN`);
2. it runs on the user's own machine or network (a LAN peer pinned by its card key, §5b), or else all of the following hold:
   - its tier is `verified` or higher;
   - its operator is in a trusted jurisdiction, with the §5 `jurisdiction` rule (declared or inferred country, and the server's country where the registry checked it, §6.4);
   - its server-location check passed (§6.4: `server_check` is `passed` or `passed_origin`). An offering whose server front is a CDN edge qualifies only through the origin addresses its card declares (ONP-2 §4), and one whose check is missing, undetermined, `mismatch` or `inconsistent` does not qualify. A registry that runs no server-location checks therefore has no hosted offering in its trusted pool;
   - its declared data policy has `retention: none` and `training_on_inputs: false`.

The trusted jurisdictions are the registry's choice and MUST be published in `GET /v0/health` as `trust.trusted` (the jurisdictions, the expanded country list, the excluded lineage, the minimum tier, `server_check: "passed"` and the data policy); the reference registry also publishes `trust.server_location_checks` (whether it runs them). A client that reads a published view without `server_check` (a registry from before this rule) applies the server-check condition anyway.

Every condition but the tier and the server check rests on what the operator declares: its country, its model's lineage and its data policy. The server check is a network tripwire, not proof of residency (§6.4). The trusted pool is the best a registry can say from declarations and network checks; it does not replace the contract a controller needs with a processor (GDPR Art. 28), and attested residency (§7) remains the strong guarantee. The reference registry trusts `EU,CA` by default, set by `ONP_TRUSTED_JURISDICTIONS`. As in `jurisdiction=`, `EU` there means every EEA country. Every offering summary and recommendation carries `pool`: `trusted` or `open`. Clients MAY apply their own trusted view on top of the registry's, but MUST NOT treat a registry's `open` result as trusted.

**Sensitive requests (clients).** A client that marks a request as carrying personal data sends it only to an offering in the trusted pool, under the client's own trusted view, and checks this again just before sending. It refuses the request when nothing qualifies, and never falls back to the open pool. A client SHOULD refuse a registry answer that does not show the trusted view was applied (`trusted_view` in recommend, `pool` in search), since a registry that predates this section ignores the filters. The reference clients take the mark in three ways:

- for every request: `--sensitive` or `ONP_SENSITIVE=1`;
- for one request: the header `onp-sensitive: 1`;
- by model choice: `auto-sensitive`.

They read their trusted jurisdictions from `ONP_TRUSTED_JURISDICTIONS`.

## 6. Verification, observations, and ranking

Registries earn their place by turning claims into signals:

### 6.1 Liveness probes
`health` endpoint, RECOMMENDED ≥ every 5 min for `verified`+; uptime observations published per offering.

### 6.2 Conformance probes
Periodic blind invocations through the advertised binding (registry pays like any client, or uses a node-granted probe allowance declared in the card). Checks: endpoint speaks the profile; streamed usage matches receipts (receipt sampling, ONP-5 §5); latency percentiles.

### 6.3 Identity probes (anti-impersonation)
For offerings claiming a known open-weight artifact, registries SHOULD run behavioral fingerprint tests (exact-output or distribution checks against a reference, §4a.4; log-probability comparison where `logprobs` is declared) and MUST downgrade `model.artifact` to `disputed` on a confirmed failure. For proprietary artifacts (`urn:proprietary:*`), only the vendor's own verified namespace may claim them — a third party cannot list "gpt-5": a registry MUST NOT admit such a claim from another namespace above `unverified`.

**Which namespace is the vendor's.** A registry keeps a vendor-namespace table and publishes it (`GET /v0/vendors`). The reference registry applies it in Stage A (`artifact-namespace`):
- a vendor in the table is admitted only from a node id inside one of its listed namespaces (built-in entries such as `openai` → `com.openai`; the registry's administrator adds or replaces entries with `POST /v0/admin/vendors/{vendor}`);
- a vendor slug that the registry's imported catalogue listings already use, with no entry, is admitted only from a node whose own domain (its id's first two labels, or three under a country's second-level suffix such as `co.uk`) contains the API host of such a listing, so a provider claiming its imported listing (§4) can name its models under its catalogue slug and a holder of the same name under another TLD cannot. Listings reached through a third-party router (Hugging Face, OpenRouter) do not count, since they name model authors, not the host;
- any other slug is admitted only from the node's own namespace, the second label of its id (`io.acme.gpu1` may claim `urn:proprietary:acme:*`). This is the name a Node Kit writes for a model it cannot name publicly; such an offering can reach `community`, but with no reference it never reaches `verified` (§4a.4).

Open-weight models are named by their public record (`hf:`, `ollama:`, ONP-2 §5), never by a proprietary URN.

### 6.4 Server-location checks (anti residency misstatement, ONP-1 §6 threat 5)
Registries SHOULD check where a node's API host is: (a) geolocation and network owner of its public IP address, reporting CDN/anycast networks as such rather than as a location; (b) TCP round-trip times from two or more probe sites in known places, compared with the physical minimum (light in fibre ≈ 100 km per ms of round trip) for the geolocated point. Results are published per node (`location`: `verdict` = `match` | `same_region` | `mismatch` | `cdn` | `inconsistent` | `unknown`, the server's country and network, per-site RTTs) and, in search results, under `jurisdiction.location`. `match` means the server is in the operator's declared country; `same_region` that both are in the EEA. A jurisdiction filter (§5) MUST exclude an offering whose server was found outside the requested jurisdiction (unless behind a CDN, or its geolocation is contradicted by latency).

**Declared origin addresses.** Behind a CDN the front's address says nothing about where the API runs. A card MAY therefore declare, in `endpoints.origin_addresses` (ONP-2 §4), the addresses of the servers that serve `endpoints.openai` behind the CDN. When the front is a CDN edge, a registry that checks origins checks every declared address, at most four:
- a DNS name is resolved; an address that is not public unicast (loopback, private, link-local, shared, multicast) is not contacted;
- the registry connects to the address itself on port 443 and completes a TLS handshake for the API host (SNI). The certificate MUST be valid for that host under the public CA roots, and the server MUST answer a `GET` of the card's `health` endpoint when it is on the API host, or else of `{openai}/models`, with any status below 500 (a `401` from an API that wants a key is fine: the certificate is the binding, the status only shows that an HTTP server answers). An address that fails this does not serve the API and fails the check. The certificate binds the address to whoever controls the API host's name, so an operator cannot name an arbitrary server in another country;
- the address is then located as in (a) and (b). One on a CDN network is `cdn`, not an origin: a CDN edge can hold valid certificates for every name it fronts. The reference registry recognises CDN networks from a fixed list, so an anycast network outside it is not recognised (known issue).

The origin result is published under `location.origin` (`verdict` and each address with its `verdict`, country and reason), next to the front's `verdict: "cdn"`, which stays as it is. Its `verdict` is `match` or `same_region` only when every declared address passes. An origin check counts only for a front that is a CDN edge: it never changes a `mismatch`, `inconsistent` or `unknown` front. A jurisdiction filter also excludes an offering behind a CDN whose declared origin was located outside the jurisdiction. The registry cannot see whether the CDN really forwards to the declared origins: a passing origin check shows that a server in that place answers for the API host, not that every request reaches it.

**Evidence level.** Search results and recommendations carry `jurisdiction.server_check`, and node detail `server_check`, derived from the check:
- `passed`: the front's verdict is `match` or `same_region`;
- `passed_origin`: the front is a CDN edge, and every declared origin passed;
- `cdn`: the front is a CDN edge, and no declared origin passed (none declared, or one failed);
- `mismatch` or `inconsistent`: as the front's verdict;
- `unchecked`: no check, an undetermined one (`unknown`), or one that no longer applies.

A check applies only to the card it was made for: when the card now names another API host, another operator country or other origin addresses, the registry reports it as `unchecked` (with `reason`) until it checks again, so an operator cannot pass on one host and then point its endpoint elsewhere. The reference registry checks again at once when a refresh (`PUT /v0/nodes/{id}/ping`) brings such a change.

These checks are evidence, not proof: a front server in one country forwarding requests elsewhere defeats them, and so does an origin that forwards. They are tripwires for honest mistakes and careless fraud, which is why attested residency (§7) remains the strong guarantee, and why user interfaces label the jurisdiction as a declaration with this evidence level (§5). The trusted pool requires a passing check (§5e). The reference registry checks registered nodes after admission and on such refreshes, and all candidates for jurisdiction filters daily, from Nuremberg (DE) and Helsinki (FI).

### 6.5 Ranking
Each registry computes `rank` however it wants **but MUST publish, in `GET /v0/health`, the component list and weights** (e.g. `uptime:0.3, price:0.2, attested_quality:0.3, latency:0.2`) and per-result `rank_explanation` with component values. Undisclosed ranking inputs are non-conformant. Paid placement, if any, MUST be labeled `sponsored` and excluded from `rank`.

### 6.6 Request counts
A registry MAY publish how often it returned each node to clients, so operators can see what a listing brings them. Counts are kept per node, per ISO 8601 week (weeks start Monday 00:00 UTC) and per surface: `search` (`GET /v0/offerings`), `recommend` (`POST /v0/recommend`) and `mcp` (successful MCP `tools/call`). A response counts each node in it once, however many of that node's offerings it holds; a registry SHOULD also count the responses on each surface, so a node's count can be read against the total. A registry that counts MUST NOT store the query, task, prompt, extracted features or anything that identifies the client with the counts: the stored record is node, week, surface and number. A registry that uses counts in `rank` MUST list them as a component (§6.5).

The reference registry adds `request_counts` to node detail (the last 12 weeks, newest first: `week`, `starts`, `search`, `recommend`, `mcp`, `total`) and serves `GET /v0/stats/requests?weeks=1..52&node_id=…&limit=…`: per week, the responses on each surface and the nodes returned, most returned first. Its web app is a client like any other, so pages viewed there count too. Counts are not rank inputs.

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
