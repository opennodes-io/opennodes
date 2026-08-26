# ONP-4: Invocation Profiles

**OpenNodes Protocol — Draft 0.1 — 2026-08-20**

ONP does not define a new inference wire format. An invocation **profile** is a named, versioned contract stating: which existing API shape the offering speaks, the minimum feature subset a conforming node must implement, and how ONP concerns (usage accounting, receipts, payment) ride along. Profiles are identified by reverse-namespace strings carried in `offering.binding.profile`.

---

## 1. Profile registry (Draft 0.1)

| Profile id | Wire format | Modality |
|---|---|---|
| `onp.openai.chat/v1` | OpenAI Chat Completions-compatible | text, multimodal |
| `onp.openai.responses/v1` | OpenAI Responses-compatible | text, multimodal, agentic |
| `onp.openai.embeddings/v1` | OpenAI Embeddings-compatible | embedding |
| `onp.openai.images/v1` | OpenAI Images-compatible (generate/edit) | image (diffusion) |
| `onp.audio.speech/v1` | OpenAI Audio-compatible (TTS/STT) | audio |
| `onp.a2a/v1` | A2A v1.0 task lifecycle | agent |
| `onp.mcp.server/v1` | The node itself is an MCP server | tools (not inference) |

New profiles enter via the ONP extension process (reverse-DNS vendor profiles allowed, e.g. `com.example.video-gen/v2`).

## 2. `onp.openai.chat/v1` — the mandatory baseline

Every text-modality ONP Node MUST implement this profile for at least one offering.

**Required subset:**
- `POST {endpoints.openai}/chat/completions` with `model`, `messages` (system/user/assistant + image parts if `vision` declared), `temperature`, `max_tokens`/`max_completion_tokens`, `stream`.
- Streaming via SSE with a terminal `usage` chunk (`stream_options.include_usage` honored, or usage always sent).
- `usage.prompt_tokens` / `completion_tokens` MUST be returned on every response — settlement depends on it.
- If `supports` declares `tool_calls`: OpenAI tools/tool_choice semantics. Same for `json_mode` (`response_format`).
- `GET {endpoints.openai}/models` MUST list exactly the `binding.model_id`s of the card's current offerings — the two discovery surfaces must agree.

**ONP headers (all profiles):**

| Header | Direction | Meaning |
|---|---|---|
| `ONP-Offering` | request | `{node_id}/{offering_id}` the client believes it is invoking; node MUST 409 if the id no longer matches the model behind the endpoint |
| `ONP-Card-Revision` | request | Card revision the client priced against; node MUST 409 (`price_changed`) if superseded by a revision with different pricing for the offering |
| `ONP-Receipt` | response | URL or inline JWS of the usage receipt (ONP-5 §5) |

These three headers are the whole "protocol": they pin *what* you think you're calling and *at what price*, which plain OpenAI-compatibility cannot express.

## 3. `onp.openai.responses/v1`

For nodes exposing the Responses shape (stateful items, built-in tools). Same required-usage and ONP-header rules. An offering MAY declare both chat and responses bindings.

## 4. Image/diffusion and audio profiles

`onp.openai.images/v1`: `POST /images/generations` (and `/edits` if `supports` includes `edit`) with `prompt`, `size`, `n`; response includes `usage`-equivalent accounting `{"images": n, "size": "1024x1024"}`. Pricing uses `per_image` (size-tiered map allowed) instead of per-token. Diffusion-specific parameters (steps, guidance, seed, negative prompt) pass through an `extra` object; nodes document supported keys in the card's `docs` link — Draft 0.1 does not normalize them.

`onp.audio.speech/v1`: TTS priced `per_mchar`, STT priced `per_minute`; accounting fields mirror the pricing unit.

## 5. `onp.a2a/v1` — agent nodes

The offering's endpoint is an A2A service; `endpoints.a2a` links the Agent Card. ONP adds only: the offering-level pricing block (per-task or per-token as declared), the `ONP-*` headers on the HTTP binding, and receipts. Everything else is A2A v1.0.

## 6. `onp.mcp.server/v1` — tool nodes

A registry MAY index MCP servers as non-inference nodes (modality `tools` implied) so that one discovery surface covers both "brains" and "hands". The offering carries the MCP endpoint + auth mode; pricing (if any) is per-call and settles like any offering (x402-paywalled MCP tools are already deployed practice on Cloudflare). This makes an ONP registry a strict superset of an MCP server catalog without forking MCP's own registry: registries SHOULD import `server.json` records from the official MCP Registry via its public API rather than take direct MCP-server registrations.

## 7. Client conformance

An ONP Client MUST implement `onp.openai.chat/v1` (including the ONP headers and 409 handling: on `price_changed`, re-fetch card, re-apply user spend policy, retry or surface). Clients SHOULD implement streaming, tool_calls pass-through (needed for MCP bridging, ONP-6), and the images profile.

## 8. Selection & fallback semantics (informative)

Discovery returns offerings; invocation is point-to-point. Client-side routing (fallback chains, cheapest-conforming, quality-first) is a client feature, not protocol — but the card gives routers everything OpenRouter-style suffixes encode (`:floor` ≈ sort by price, `:nitro` ≈ sort by observed TPS), portable across vendors.
