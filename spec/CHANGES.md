# ONP specification changes

## Draft 0.1, revision 2 — 2026-10-31

Compatibility and editorial fixes found while profiling ONP for a sovereign, closed-catalogue deployment. Cards written for revision 1 stay valid. The only exception is an `ephemeral` retention without a bound, and no published card uses that.

| # | Where | Change |
|---|---|---|
| D1 | ONP-2 §9 | Schema path corrected to `schemas/open-node.schema.json`. The schema is normative for structure, the prose for semantics |
| D2 | schema `$id`, ONP-5 §2, problem types | One domain: `opennodes.io` (schema `$id`, settlement example, `https://opennodes.io/problems/{name}` in the JS and Python servers) |
| D3 | ONP-1 §5, schema `onp` | Any `0.x` version is accepted; implementations MUST accept higher minor versions |
| D4 | ONP-2 §5, ONP-5 §2, ONP-3 §4a | Offering `pricing.schemes` MUST be a subset of node `payment.schemes`; checked at Stage A |
| D5 | ONP-2 §5 | `tools` listed as a core modality |
| D6 | ONP-3 §6, ONP-5 §5 | ONP-3 §6 numbered 6.1–6.4 so existing citations resolve |
| D7 | ONP-2 §8 | JCS (RFC 8785) canonicalization is normative for card signatures (matches both reference implementations) |
| D8 | ONP-2 §5, ONP-3 §4a | `supports` core vocabulary extended: `parallel_tool_calls`, `structured_outputs`, `audio_input`, `reasoning`, `logprobs`, `prompt_caching`; fingerprinting falls back to output-only comparison when `logprobs` is absent |
| D9 | ONP-2 §5, schema | `retention` values defined; `retention_max_seconds` added and required for `ephemeral`; registries check `data_policy` presence at Stage A |
| D10 | ONP-2 §5, schema | `expected_tps` defined as per-stream; new optional offering `capacity` block (`aggregate_output_tps`, `max_concurrency`, `rate_limits`) |
| D11 | docs/00-project-overview | Fact sheet test and offering counts refreshed |
| D12 | ONP-2 §3, ONP-3 §5 | ISO 3166 region codes with containment (`CA` ⊇ `CA-QC`); `region=` search requires every pinned location inside; `lang=` matches BCP 47 subtags; language tags may carry regions (`fr-CA`) |
| D13 | ONP-3 §5a | Estimate/recommend: free and unauthenticated on public registries; MAY require authentication; SHOULD be rate-limited |
| D14 | ONP-4 §9 | Registered problem types and status codes for refusals, rate limits and capacity; fallbacks MUST NOT weaken the caller's policy |
| D15 | ONP-1 §5, schema | Open vocabularies for `modality`, `supports`, `scheme`, `retention`, with safe defaults for unknown values, so profiles can extend ONP without breaking validation |

### Reference implementation changes

- `@opennodes/core`: schema copy synced; new `regionWithin` / `residencyWithin` helpers; advisor region policy uses containment (every pinned location must lie inside the required region); problem-type domain.
- `@opennodes/registry`: Stage A `card-consistency` check; `region=` search filter (previously specified but not implemented); BCP 47 prefix matching for `lang=`; offering summaries carry `node_regions`.
- `onp-node` (Node Kit): problem-type domain.
- Tests: `impl/test/spec-rev2.test.js` (6 tests).

The packages need a version bump before publishing (core is consumed by registry, CLI and router at a pinned version).
