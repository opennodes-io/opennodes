# Proposal: relay binding for nodes without a public endpoint

**Status:** design proposal for ONP Draft 0.2. **Not normative.** None of this is in revision 12 or release 0.1.54 (27 November 2026), and it comes with no code change.
**Date:** 2026-11-20.
**For review by:** the maintainer, and Mark Lindley, Two Minds (twomindsworks.com), whose review of 18 November 2026 is recorded in [KNOWN-ISSUES](../KNOWN-ISSUES.md).
**Checked against:** `main` at `8e74fe6`. Statements about current behaviour cite the spec section or the file and line at that commit (§14).

## Summary

- Today a node must answer at a public HTTPS endpoint. A GPU at home behind NAT can list only through a tunnel, which ONP cannot describe. Some tunnels read every prompt. Others hide the node behind an ingress server that the registry locates as if it were the node.
- This note proposes a second transport, the **relay binding**. The node keeps an outbound connection to one to four relays named in its signed card, and clients send requests for that node through a relay. It takes the pull principle of AI Horde's workers without the central queue.
- Prompt and reply are encrypted end to end to a key in the node's signed card, using HPKE in the Oblivious HTTP message format. The relay forwards ciphertext. It still sees who connects, to which node, when, and how much.
- Receipts stay node-signed and travel inside the encrypted reply. A relay can drop, delay or replay traffic, but it cannot read, change or forge it. This holds only once clients verify receipts with the card's own key, which they do not do today (§6.2).
- Registry probes take the same path as customer requests. The node then no longer sees the registry's address or client stack. The tells inside the request (shape, cadence, credential) remain, and §7 lists them.
- Relay nodes stay in the open pool in Draft 0.2. A relay can report the node's egress address and time the connection, but that evidence is weaker than today's server check, and the same forwarding box defeats it. Relay nodes enter the trusted pool only with attested residency.

---

## 1. The problem

What ONP requires of a node today:

- The card is served at `https://{origin}/.well-known/open-node.json` (ONP-2 §1), and the key set at the same origin (ONP-2 §8).
- `endpoints.openai` and `endpoints.health` are required (`schemas/open-node.schema.json:37`). Registries, the gateway and clients call them directly.
- The Node Kit assumes TLS is terminated in front of it and that it has a public URL ([node-kit/README.md](../../node-kit/README.md), "MVP shortcuts").
- The registry's fetcher refuses private addresses (`impl/packages/registry/src/safefetch.js:9-32`), so a node on a home network address cannot be probed.
- The server-location check (ONP-3 §6.4) needs an address the registry can connect to. ONP-2 §4 says it plainly: an origin reachable only through a tunnel cannot be checked.

What a home operator does today is run a tunnel. What follows depends on the tunnel:

- **Some tunnels handle requests in clear at their edge.** Cloudflare Tunnel applies caching and its web application firewall there ([Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/)), so the provider sees every prompt and reply. ngrok's HTTP endpoints are reported to terminate TLS at ngrok's cloud; this was not confirmed verbatim.
- **Other tunnels pass TLS through to the device.** These are Tailscale Funnel ([Funnel](https://tailscale.com/kb/1223/funnel)) and ngrok's TLS endpoints with termination at the agent ([TLS endpoints](https://ngrok.com/docs/gateway/endpoints/tls.md), a paid plan). The provider then sees only metadata, much as a relay would.
- **Cloudflare's network is on the registry's CDN list** (`impl/packages/registry/src/location.js:45`). A node behind Cloudflare Tunnel therefore gets `server_check: cdn`, no declared origin can pass because the origin has no public address, and the node stays in the open pool.
- **Other tunnel ingresses are not on the list.** The registry locates the ingress server as if it were the node. The verdict then says where the tunnel's ingress is, not where the GPU is, and it can be `match`: the KNOWN-ISSUES 4.7 row on the fixed CDN list is still open. A tunnelled node can thus reach the trusted pool on evidence about someone else's server.
- **Either way, ONP has no way to say what the path is.** A card cannot state that the node sits behind a tunnel, and a registry cannot tell a tunnelled home node from a server in a datacentre.

Tailscale Funnel shows that the confidentiality part already works. What ONP lacks is:

- an open path that anyone can run and that a card can name;
- a way to probe the node along that path;
- a location rule that does not mistake the intermediary for the node.

The nodes that need another way in:

- volunteers and small labs with consumer GPUs behind NAT or carrier-grade NAT;
- universities and companies whose firewalls allow outbound connections but no inbound ports;
- the user's own machine on another network (a home GPU used from a laptop elsewhere).

**Goal.** Let such a node serve with no inbound port, no public address and no TLS certificate for an API host. The intermediary should see no more than metadata, the card should say what the path is, and admission and receipts should work as they do for direct nodes.

**Non-goals:**

- splitting a model across machines (Petals);
- a central job queue;
- a credit currency (§11);
- anonymity against a global network observer.

## 2. What we take from AI Horde, and what we leave

How AI Horde works ([API spec](https://aihorde.net/api/swagger.json)):

- A text worker calls `POST /v2/generate/text/pop` with the models it serves and its limits (`max_length`, `max_context_length`).
- It receives a job payload with the prompt, the generation parameters and a `ttl`, the time after which the job counts as stale and is aborted.
- It returns the result with `POST /v2/generate/text/submit` (`id`, `generation`, `state`). Completed jobs earn kudos ([kudos.md](https://github.com/Haidra-Org/haidra-assets/blob/main/docs/kudos.md)).
- Workers poll for work whenever their local queue has room. The coordinator times out abandoned jobs and hands them to another worker where it can ([workers.md](https://github.com/Haidra-Org/haidra-assets/blob/main/docs/workers.md)).
- Clients submit with `POST /v2/generate/text/async`, read the result with `GET /v2/generate/text/status/{id}` and cancel with `DELETE` on the same path. The native text API returns finished generations. The spec also has a progress endpoint for streamed chat jobs (`POST /v2/generate/text/progress`), and the [README](https://github.com/Haidra-Org/AI-Horde/blob/main/README.md) says its OpenAI-compatible endpoint can stream.

What we take:

- **The worker dials out.** NAT and firewalls stop mattering, because the node never accepts an inbound connection.
- **The worker states its capacity when it asks for work**, so back-pressure is built in (§4.2).
- **A deadline on each job** (§4.4).

What we leave:

- **The coordinator owns the queue and picks the worker.** In ONP the client picks the node: discovery stays with registries, and invocation stays point to point (ONP-4 §8). A relay forwards only to the node the client named. It never reassigns a job, and it could not, because the job is encrypted to one node's key.
- **Plaintext.** The pop payload carries the prompt to the worker in clear. The coordinator holds requests and filters prompts: moderators keep regex filters (`POST /v2/filters`), and a worker can report a job as `csam` on submit. So both the coordinator and the worker see prompts. This is inferred from the API spec, because the answers on the [FAQ page](https://aihorde.net/faq) did not render when fetched.
- **Polling.** A persistent stream replaces pop and submit. Polling adds up to one poll interval to every job and makes empty requests when no job is waiting, and token streaming needs a stream anyway.
- **Kudos** (§11).

## 3. Roles and trust assumptions

| Role | Holds | Trusted for |
|---|---|---|
| **Node** | The card signing key (Ed25519, ONP-2 §8), a new encryption key (X25519) published in the card, and the engine | Its own outputs and receipts, as today. Probes check it as today |
| **Relay** | A connection table, plus encrypted receipts parked for clients (§4.4) | Availability only. Never for confidentiality, integrity or billing |
| **Client** (gateway, SDK, router) | The card, fetched and verified at the card origin, never from the relay | — |
| **Registry** | As today; it probes through relays (§7) | As today |

The address-hiding property in §5 and §7 rests on one assumption: **the relay and the node do not share what they see.** Oblivious HTTP makes the same assumption about its relay and gateway ([RFC 9458](https://www.rfc-editor.org/rfc/rfc9458)). A node operator can name its own relay. That is allowed, but it removes the property and leaves the node no worse placed than a direct node. Confidentiality and receipt integrity do not depend on this assumption.

## 4. Mechanism

### 4.1 The card

**Where the card lives (decision).** A node without a public API still needs an id and a card that ONP-3 §4 accepts. There are two ways:

| | **A. Static card at an origin the operator controls** (recommended) | B. Card hosted by the relay |
|---|---|---|
| Example | `https://ai.example.org/.well-known/open-node.json` on any static host, or `https://alice.github.io/.well-known/open-node.json` with id `io.github.alice` | `https://alice.relay.example.net/.well-known/open-node.json` |
| Namespace (ONP-3 §4) | Unchanged: the host controls the id. A host equal to the id's domain qualifies (`impl/packages/registry/src/namespace.js:13-18`), so a free static-host subdomain is enough and no domain purchase is needed | The relay operator controls `net.example.relay.*` under the parent-domain rule, so it can replace the card and its keys |
| Tooling | Exists: the card-only flow, `onp-node card --out well-known` | New |
| End-to-end encryption | Holds: the relay never serves the key | Broken unless clients pin the key some other way |

**A caveat for free static hosts.** The vendor-namespace rule (ONP-3 §6.3) takes the id's second label as the node's own vendor label (`impl/packages/registry/src/vendors.js:27`, `:74-76`). So every `io.github.*` node shares the label `github` and may claim `urn:proprietary:github:*`.

- This is harmless for open-weight offerings named `hf:` or `ollama:`.
- The Node Kit's fallback name for a model with no public record, `urn:proprietary:<label>:<model>`, would collide between users of one host.

An own domain avoids this. Draft 0.2 could make the rule respect the Public Suffix List.

Option A keeps ONP-3 §4 as it is. The static host can read and replace the card, as it can for card-only listings today, and the operator chooses that host. Option B would let the relay swap the encryption key and read every request, so this note does not propose it (Q1).

**Proposed card fields** (ONP-2 §4):

```json
"endpoints": {
  "relay": [
    {"url": "https://relay-a.example.net/onp/relay/v1"},
    {"url": "https://relay.example.org/onp/relay/v1"}
  ],
  "relay_keys": "AAAgABEA…",        // OHTTP key configurations (RFC 9458 §3), base64url
  "docs": "https://ai.example.org/docs"
}
```

- `relay`: 1 to 4 relay base URLs, the same bound as `origin_addresses`. The node connects to `{url}/connect`, and clients send to `{url}/nodes/{node_id}/requests`.
- `relay_keys`: the node's HPKE public keys in the OHTTP key-configuration encoding (key id, KEM, and KDF and AEAD pairs). The field sits in the card body, so the card signature covers it. It is a separate key from the signing key: a client never encrypts to the Ed25519 key.
- `openai` and `health` become optional when `relay` and `relay_keys` are present. A card has `openai` (direct), `relay`, or both. A card with both lets clients that want the node not to see their address use the relay, which is the same split OHTTP gives. For the trusted pool only the direct path counts (§8).

### 4.2 The node's connection to a relay

- **Transport.** The node opens a WebSocket ([RFC 6455](https://www.rfc-editor.org/rfc/rfc6455)) over TLS to `{relay}/connect`. Every relay MUST accept this baseline, because WebSocket on port 443 passes most firewalls and proxies. A relay MAY also accept the same protocol over HTTP/2 or HTTP/3 extended CONNECT ([RFC 8441](https://www.rfc-editor.org/rfc/rfc8441), [RFC 9220](https://www.rfc-editor.org/rfc/rfc9220)). Polling is not used (§2).
- **Authentication.** The relay sends a nonce. The node answers with a JWS, signed with its card key, over `{relay, node_id, card_url, nonce, iat}`. The relay then:
  - fetches the card from `card_url`;
  - checks that the host of `card_url` controls `node_id` (the ONP-3 §4 rule);
  - checks that the card names this relay;
  - verifies the JWS with the card's key, chosen by `kid`.

  The relay checks again when the card's cache lifetime ends. This stops another party from attaching as the node and swallowing its traffic. Such a party could not read the traffic, but it could drop it or answer with errors.
- **Framing.** Frames are `open(stream)`, `data(stream, bytes)`, `end(stream)`, `cancel(stream, reason)`, `credit(n)` and `ping(nonce)` / `pong(nonce)`. Over HTTP/2 the native streams and windows carry the same meaning.
- **Capacity: the pull part.**
  - The node grants the relay credits. Each credit is a job it will accept now, and the node never grants more than `capacity.max_concurrency`.
  - The relay opens a stream only while it holds a credit, and each finished job returns one.
  - Without a credit the relay answers the client `503 capacity-exhausted` at once (ONP-4 §9). It MAY hold a request for a few seconds waiting for a credit. It MUST NOT keep a queue that outlives the client's connection.

  This is AI Horde's rule that a worker asks for work only when its queue has room (§2), without a poll interval and without a central queue.
- **Several relays.** The node connects to every relay in its card and divides its credits among them. A relay the node cannot reach simply stays idle.

### 4.3 A request, end to end

1. The client fetches the card at its origin, verifies the signature (ONP-2 §8), and picks an offering and one of the card's relays.
2. It builds the **inner request**: an ordinary ONP-4 request, `POST /v1/chat/completions`, encoded as Binary HTTP ([RFC 9292](https://www.rfc-editor.org/rfc/rfc9292)). The request carries:
   - `ONP-Offering` and `ONP-Card-Revision`;
   - `Content-Type`;
   - the payment header, if any (`Authorization`, `X-PAYMENT`);
   - `Date` and `Idempotency-Key` (§4.5, §6.3);
   - the JSON body.
3. It encapsulates the request with HPKE to a key from `relay_keys` (RFC 9458 request encapsulation). For a streamed reply it uses the chunked variant, `draft-ietf-ohai-chunked-ohttp` (an IETF draft when this note was written).
4. It sends `POST {relay}/nodes/{node_id}/requests` with the encapsulated bytes. Of the request itself, the relay sees only the node id in the path.
5. The relay opens a stream on the node's connection and copies bytes in both directions.
6. The node decapsulates the request and applies the replay rules (§6.3). It then handles the request exactly as a direct request: the same 409s, the same accounting and the same receipt. It encrypts the reply under the response key that the request's HPKE context derives.
7. The relay streams the ciphertext back, and the client decrypts it.

**ONP-4 runs unchanged inside the envelope:** profiles, ONP headers, `409 offering-mismatch` and `price_changed`, the x402 `402` flow, `429` and `503`. With x402, the `402` arrives encrypted and the client retries with the payment in a new envelope, so payment costs one extra round trip through the relay.

**Relay-level errors** arrive outside the envelope as RFC 9457 problems:

- `node-offline` (`503`): the node is not connected;
- `relay-timeout` (`504`): no first byte arrived before the relay's deadline;
- `relay-rate-limited` (`429`);
- `unknown-node` (`404`): no connected node names this relay.

These errors are the relay's statements, not the node's answer. §7.1 explains how registries count them.

**An inner header profile.** Clients MUST build the inner request with a fixed set of headers in a fixed order, and with no user agent. Without this, the inner request re-creates the client fingerprint that the relay hides (§7.2). The reference libraries (core, used by the gateway, the CLI and the registry) would share one builder.

### 4.4 Streaming, cancellation and back-pressure

- **Streaming.** The node encrypts each SSE event as one chunk. The chunked format authenticates the last chunk, so a relay that cuts a stream short cannot pass it off as complete.
- **The receipt in the stream.** ONP-4 §2 says the `ONP-Receipt` header of a stream MUST carry a URL that the client fetches from the node. A relay node has no public origin for that URL. In relay mode the optional in-band event, a final `event: onp.receipt` after the usage chunk, becomes **REQUIRED**, and the inner `ONP-Receipt` header carries `in-band`. Today neither the Node Kit nor the gateway implements the in-band event:
  - the Node Kit sends only the URL (`node-kit/onp_node/server.py:164-168`);
  - the gateway reads only the header and fetches the URL (`impl/packages/cli/src/gateway.js:332-365`).
- **A receipt after a cut.** If the client cancels or disconnects before the last chunk, the node still signs a receipt for the tokens it produced. It parks the receipt at the relay, encrypted under a key exported from the request's HPKE context (the Export interface, [RFC 9180](https://www.rfc-editor.org/rfc/rfc9180) §5.3), under a handle given in the inner response headers. The client fetches `GET {relay}/receipts/{handle}` within 24 hours, the retention ONP-4 §2 already asks of nodes. The relay holds bytes it cannot read.
- **Cancellation.** When the client closes its request, the relay MUST send `cancel(stream)` to the node at once. The node aborts the engine request (the Node Kit closes its upstream connection) and parks the receipt for what was produced.
- **Back-pressure.** Flow-control windows run per stream, end to end:
  - The relay buffers at most a small fixed amount per stream (for example 256 KiB, published in its descriptor, §9) and stops opening the window to the node while the client is not reading.
  - The node then stops reading from the engine, so the engine's own HTTP stream pauses.
  - A node MAY cancel a stream whose client has read nothing for a set time.
- **Deadlines.** Each relay publishes a first-byte deadline (for example 120 s). When it expires the relay answers `relay-timeout`. Unlike AI Horde, the relay never hands the job to anyone else. Retrying is the client's decision (§4.5).

### 4.5 Retries and idempotency

- Retrying the same request through another relay of the **same node** is safe for privacy, because it reaches the same operator and the same key. It does not widen the open gateway failover issue (KNOWN-ISSUES 4.11), which is about sending one prompt to several operators. That issue stays as it is.
- It is not safe for billing: relay A may have delivered the job and then lost the reply. The inner request therefore carries a random `Idempotency-Key`, and the node keeps these keys for 10 minutes. A repeated key never causes a second run:
  - while the first run is going, the node answers `409 request-in-progress`;
  - after it, the node answers `409 duplicate-request` with the first run's receipt.

  The node does not keep the reply itself: holding it would break `retention: none` (ONP-2 §5). A node whose declared retention is `ephemeral` MAY keep it for that window and return it. A client that lost a reply on a `none` node has paid for it and must ask again under a new key. Q9 asks whether that is acceptable.
- Receipts gain an optional `request_id` holding that key. Two receipts with the same `request_hash`, for the same body sent twice on purpose, then stay distinct.

## 5. Privacy

### 5.1 Encryption

- **Algorithms.**
  - HPKE (RFC 9180) base mode with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-128-GCM, with ChaCha20-Poly1305 as the alternative AEAD.
  - The OHTTP message and key-configuration formats (RFC 9458) rather than a new format.
  - Inner messages in Binary HTTP (RFC 9292).
- **No new dependencies.** Node's built-in `crypto` has X25519, HKDF, AES-GCM and ChaCha20-Poly1305. The Node Kit's existing `cryptography` dependency has the same. After the supply-chain work of revision 12 (KNOWN-ISSUES 4.12), this matters.
- **Rotation.** A new key goes into a new card revision. The node keeps accepting the previous key id for at least twice the card's cache lifetime (ONP-2 §1: at most 3600 s).
- **Revocation** is not solved here, as it is not for signing keys (KNOWN-ISSUES 4.2, open). The node's encryption key is static, so a stolen key exposes every request ever encrypted to it that someone recorded. OHTTP has the same property. The encryption key file needs the same care as the signing key, and the Node Kit keeps that one as a plaintext file today (KNOWN-ISSUES 4.2).

### 5.2 What the relay still sees

| The relay sees | What it reveals | What this proposal offers |
|---|---|---|
| The client's IP address, TLS fingerprint and request times | Who uses which node, and when. IP addresses are personal data under the GDPR | A retention statement in the relay descriptor (§9); the client chooses its relay |
| The target node id (in the path) | The card is public, so the operator and its models. A node with one offering reveals the model | None |
| The request size | Roughly the prompt length | Optional padding to size buckets, by the client |
| The number and timing of response chunks | Roughly the output tokens and the decode speed | Optional coalescing and padding, by the node, at a cost in latency |
| The node's egress address, its connection times and its credits | The operator's network and region, when it is online, and its load | The retention statement; see §8 on VPNs |
| Relay-level errors and cancellations | Failures and abandoned requests | — |

The relay does **not** see the prompt, the reply, which offering of a multi-offering node is called, the ONP headers, the payment credential or the receipt.

Compared with today:

- A tunnel that handles HTTP at its edge sees everything in the table, plus the plaintext. A tunnel that passes TLS through sees about what a relay sees, but the card cannot say so (§1).
- A direct node sees the client's address and the plaintext.
- A relay node sees the plaintext but not the client's address, and the relay sees the address but not the plaintext. This is OHTTP's split, and it holds only while the two do not collude (§3).

### 5.3 What moves from the relay to the node, and back

- **Content policy.** AI Horde's coordinator filters prompts. A relay cannot. Content policy stays with the node, where it already is for direct nodes.
- **Per-client rate limits.** The node enforces `capacity.rate_limits` per client (ONP-2 §5), and a relay node no longer sees the client's address. There are two options:
  - The relay enforces the card's per-client limits by client address, since it can read them from the card, and the node enforces only its total through credits.
  - The node enforces them per credential.

  The second option gives the node a stable per-client identifier, and §7 needs the node to have none. Q5 asks which to choose.

## 6. Receipts

### 6.1 What stays

- Receipts are signed with the node's card key (JWS over the JCS payload, ONP-5 §5) and keep their fields.
- `request_hash` is the SHA-256 of the **inner request's body bytes**: the body of the Binary HTTP message as the node decapsulated it. These are exactly the bytes the client serialized and kept. ONP-5 §5 needs this sentence, because it now speaks of "the raw HTTP request body bytes exactly as received".
- The receipt travels inside the encrypted reply. The AEAD stops a relay from changing it, the signature stops a relay from forging it, and §6.3 stops replays.

### 6.2 Required change: verify with the card's key

"The relay cannot forge receipts" holds only if clients verify receipts with the key that signed the card, taken from the card origin. Today they do not:

| Component | Receipt key today | Location |
|---|---|---|
| Gateway | `keys[0]` of the key set at the origin of `endpoints.openai` | `impl/packages/cli/src/gateway.js:214-219` |
| CLI client | Cards and receipts both use `keys[0]` | `impl/packages/cli/src/client.js:53-54`, `:116-117` |
| Ollama router | The pinned key for LAN peers; otherwise `keys[0]` at the API origin | `impl/packages/ollama-router/src/router.js:277-278` |
| Registry, by contrast | Verifies cards with the key set at the card URL's origin, choosing the key by `kid` | `impl/packages/registry/src/server.js:125-139`, origin taken from the card URL at `:351` |

A relay node has no API origin. A client that looked for the key set next to the relay would let the relay choose the key.

**Change:** every client verifies cards and receipts with the key the card's signature names (`kid`), taken from the key set at the card origin. This is the ONP-2 §8 rule, and the registry already follows it. The change also fixes direct nodes whose API is on another host than their card, and it is needed for key rotation, because `keys[0]` picks the wrong key once a key set holds two.

The gateway's rule that a receipt URL must be on the node's own origin (`gateway.js:229-231`) stays for direct nodes. Relay nodes use in-band and parked receipts (§4.4) instead.

### 6.3 Replay

- A relay can send an encapsulated request it has seen a second time. OHTTP does not prevent this by itself (RFC 9458, security considerations).
- The inner request MUST carry `Date`, and the node rejects a request outside ±5 minutes (`stale-request`).
- Within that window the node keeps the encapsulated key (`enc`) of every request. `enc` is unique per encapsulation, so the node rejects a repeat (`409 replayed-request`). The cost is about 32 bytes per request for 10 minutes.
- `Idempotency-Key` (§4.5) handles a client's own retries, which use a fresh encapsulation. The `enc` cache handles relay replays. Both are needed.

### 6.4 Settlement

- Relays take no part in settlement. The payment credential travels inside the envelope.
- Relay fees stay outside the protocol, apart from disclosure in the relay descriptor (Q8).
- Receipts gain an optional `via` field: the relay base URL the request came through, as the node states it. A client or registry can then attribute failures and latency to a relay.

## 7. Admission and probes

### 7.1 Running the battery over a relay

- **Stage A** (ONP-3 §4a items 1–3):
  - The card fetch and signature check at the card origin are unchanged.
  - The health check becomes an encrypted `GET /onp/health` through a relay, so the node answers and not the relay.
  - The `/models` agreement check becomes an encrypted `GET /v1/models`.
  - The blind invocation is encrypted, and Stage A requires its in-band receipt.
- **Stages B and C** send every request through relays. The capacity ramp then measures the node plus the relay hop, which is what customers get.
- **Coverage.** Until a registry can speak the relay transport, a relay-only offering is untested. ONP-3 §4a "Coverage" already says what follows: the node passes neither Stage A nor Stage B and stays `unverified`. The reference registry handles profiles it cannot call this way today (`impl/packages/registry/src/probes.js:22-30`), so relay cards can appear before registries support them without anything breaking.
- **Which relay.** A registry MUST probe only through relays the card names. It SHOULD choose among them as the reference clients do, uniformly among those that are up. A registry-run relay that customers do not use would itself mark probes.
- **Attribution.** Today 3 consecutive failed blind invocations while health passes drop a node one tier (ONP-3 §4a.9). Over a relay, two failures pull in opposite directions:
  - A third-party relay that drops large requests while passing tiny health requests would demote an honest node.
  - A relay the node's operator runs sees the registry's address. It could answer suspected probes with `relay-timeout` while health passes. If relay errors never counted, that would be a free dodge, the same hole the `409` rules of revision 12 closed.

  Proposed rules, modelled on the `409` excuse:
  - Every relay-level error (§4.3), and every relay `5xx` outside the envelope, on a path whose health check passes MUST be recorded against that relay.
  - A bounded number per node and day is excused (for example 3). Each excused error brings a fresh blind invocation within the hour, through a relay chosen at random from the card.
  - Beyond the bound, a relay-level error counts as a failed blind invocation of the node. The node chose its relays, as a direct node chooses its CDN.
  - A node with every relay down is offline, and the liveness rules of item 8 apply.
  - Registries publish observations per relay, so an operator whose relay is failing can see it and drop that relay.

  An honest node with a bad third-party relay can lose a tier this way. The scheduled stages bring it back once it drops the relay (R7).

### 7.2 What the node can still use to spot a probe

| Tell | Direct node today | Relay node with an independent relay | Notes |
|---|---|---|---|
| **Source address**: probes come from the registry's address (KNOWN-ISSUES 4.6, "one source address", open) | Visible | **Hidden**: the node sees only the relay | The relay sees the address instead (see the collusion row) |
| **Client stack**: TLS fingerprint and HTTP headers. Probes go out through Node's `fetch` with its defaults (`user-agent: node`, `accept-language: *`, `sec-fetch-mode: cors`); the probe code sets no user agent (`impl/packages/registry/src/stageb.js:36-50`) | Visible. `onp gateway` traffic looks the same, but most SDK traffic does not | **Hidden** if every client follows the inner header profile (§4.3) | Needs that profile to be normative |
| **Dedicated probe key** of card-only listings (ONP-3 §4) | Visible | Arises only if the offering needs a key. A relay node runs the Node Kit and can offer `free` or x402 | The rule stays: no `verified` on probe-key probes |
| **The customer account the registry bought** (revision 12) | Visible over time | Visible if the credential is per account | Closed only by unlinkable payment tokens (Privacy Pass, [RFC 9576](https://www.rfc-editor.org/rfc/rfc9576) / [RFC 9578](https://www.rfc-editor.org/rfc/rfc9578)) in the Draft 0.2 settlement API. A relay cannot help here |
| **Request shape**: every Stage C call uses temperature 0 and `max_tokens` 64 (`stageb.js:30`, `:48`; `impl/packages/registry/src/stagec.js:54`) | Visible | Visible (inside the envelope) | An independent fix: draw shapes from a mix like customers' (R5) |
| **Cadence**: blind calls about hourly with jitter, and a Stage B burst of up to 20 requests (ONP-3 §4a, probe load) | Visible | Visible | — |
| **A card fetch just before each blind sweep** (`stagec.js:142`) | Visible to a node that serves its own card | Hidden if the card sits on a static host whose logs the operator does not read; otherwise visible | An independent fix: refresh cards on a schedule unrelated to probes |
| **Base rate**: a small node whose only traffic is the registry's | Visible | Visible | Many home nodes will be this node |
| **Relay collusion**: the operator runs its relay or reads its logs | — | Restores the address and the timing | A registry cannot verify that a relay is independent. It can record each relay's declared operator (§9) |

**Conclusion.** Relay mode removes the network-level tells (the address and the client stack) for nodes whose relays someone else runs. It does nothing about the tells inside the request.

It weakens the probe-key problem only indirectly. A relay node has no API outside ONP, so it has no reason to be a card-only listing with a dedicated probe key. Wherever a per-account key is required, the account remains a tell, and only unlinkable payment tokens close that.

The KNOWN-ISSUES row "one source address" could read "addressed for relay nodes with an independent relay". The other 4.6 rows stay as they are.

**Relay obligation.** The address gain needs one MUST for relays: forward nothing about the client to the node. That means no forwarded-for header, no client id and no stream labels per client.

## 8. Location evidence

**Today** (ONP-3 §6.4, `impl/packages/registry/src/location.js`) the registry:

1. resolves the API host and takes the first IPv4 address (`:301`);
2. looks up its MaxMind GeoLite country through RIPEstat (`:93`) and its network owner;
3. recognises CDN networks from a fixed list (`:45`);
4. measures TCP connect round-trip times on port 443 from Nuremberg and Helsinki (`:116`) and compares them with the speed of light in fibre.

A reply faster than physics allows makes the verdict `inconsistent` (`:161`). A reply far slower than expected is a soft signal that decides nothing.

**What a relay can add:**

1. **Egress address.** The relay sees the source address of the node's connection. It can sign a statement `{node_id, address, first_seen, last_seen}`, and the registry locates that address as it locates a front.
2. **Round-trip time.** The relay can time a challenge on the open connection that the node must answer under its card key. This binds the measurement to whatever holds the key. It is the same binding a TLS certificate gives in direct mode, and no stronger.
3. **Registry-run relays.** A registry could run relays at its own probe sites and ask relay nodes to name them. Points 1 and 2 would then be the registry's own measurements, as they are today.

**Limits.** All of the following hold:

- **A forwarding box defeats it** (ONP-3 §6.4, last paragraph). A box in the declared country holds the keys and passes jobs on to a GPU elsewhere. It passes every check. It is a small rented server, the same cost as a forwarding front in direct mode.
- **A plain VPN exit moves the address anywhere.** With the keys still on the real machine, the round-trip time includes the leg to it, which only the "too slow" signal could catch, and that signal decides nothing today.
- **Home addresses locate poorly.** Residential and mobile addresses locate only to the ISP's region, carrier-grade NAT addresses are shared, and dynamic addresses change, so a check goes stale faster than for a datacentre server.
- **The reporter is a third party.** Unless the registry runs the relay, the evidence is someone else's statement, and a relay run with the node defeats it at no cost.
- **One relay is one vantage point.** Today's check uses two of the registry's own sites.
- **The relay processes personal data too.** It holds the client address and the request metadata of personal-data requests, so for the trusted pool its jurisdiction would also matter.

**Compared with tunnels today.** A node behind a tunnel whose ingress network is not on the CDN list is located at the ingress (§1), and can pass. Keeping relay nodes out of the trusted pool is therefore stricter than what tunnels get now. That is deliberate: the relay path is declared, so the registry knows it is not looking at the node.

The tunnel gap is a direct-mode issue (KNOWN-ISSUES 4.7, fixed CDN list) and is worth fixing on its own: the registry would recognise known tunnel ingress networks as it recognises CDNs.

**Position: not enough for the trusted pool.** Relay nodes stay in the open pool in Draft 0.2. They enter the trusted pool only with attested residency, which is already planned for Draft 0.2 (KNOWN-ISSUES, "Planned for Draft 0.2"), and through a relay in a trusted jurisdiction. Concretely:

- A new location verdict `relay` and evidence level `server_check: relay`, treated like `cdn`: the front cannot be located.
  - The reference code already fails closed on it: `serverCheckOf` maps any verdict it does not know to `unchecked` (`impl/packages/core/src/advisor.js:461-468`), and the trusted pool requires `passed` or `passed_origin` (`:471`).
  - The trusted-pool rule of ONP-3 §5e needs no new condition, only the new value in the list of evidence levels.
- The egress location a relay observes is published for information only, under `location.relay_observed`: per relay, the address's network and country, the round-trip time, and who measured it. It never counts as `passed`.
- A card with both a direct and a relay path is in the trusted pool only for requests sent the direct way.
- A LAN peer pinned by its card key (ONP-3 §5b) is unchanged. Whether a pinned key reached through a relay, such as the user's own home GPU used from elsewhere, counts as the user's own machine is question R4.

## 9. Federation

- **Anyone can run a relay.** The reference would be a new package (for example `@opennodes/relay`). It is stateless apart from its connection table and the parked receipts.
- **Relay descriptor** at `GET {relay}/.well-known/onp-relay.json`, signed with a relay key whose key set sits at the relay origin. Like a card's data policy, its entries are declarations. It gives:
  - the operator, its country and a contact;
  - the ONP versions it supports;
  - its limits: maximum request size, first-byte deadline, buffer per stream and per-client rate limits;
  - its metadata retention: what it logs and for how long;
  - its fees, if any.
- **A card names one to four relays.** Two or more are RECOMMENDED. The node connects to all of them. A client tries the card's relays in a random order. A connection failure or a relay-level error (§4.3) moves it to the next relay, retrying with the same `Idempotency-Key`. A relay that failed is skipped for a few minutes. Clients do not need any outside source to know which relays are up, though they MAY use a registry's per-relay observations (below) to order them.
- **Registries MAY list relays** seen in cards, with their observations (`GET /v0/relays`): whether they are up, the probe failure rate through each, and the declared operator.
- **No relay-to-relay forwarding** in Draft 0.2.

**Failure and abuse cases**

| Case | Effect | Defence |
|---|---|---|
| A relay drops requests | Client timeouts | The client retries through another relay (§4.5); observations per relay; the operator removes the relay from its card |
| A third-party relay drops only the registry's requests (it can see the registry's address) to get a node demoted | Demotion of an honest node | Errors are recorded per relay and a few a day are excused (§7.1); probes from varied networks (KNOWN-ISSUES 4.6, open); the operator drops the relay and the scheduled stages restore the tier |
| A node's own relay answers suspected probes with relay errors | A dodge | Excuses are bounded, each one brings a fresh probe within the hour, and beyond the bound the errors count against the node (§7.1) |
| A relay delays traffic selectively | Worse measured latency | Latency observations per relay; the node chooses its relays |
| A relay replays a request | Double work and double billing | The `Date` window and the `enc` cache: `409 replayed-request` (§6.3) |
| A relay truncates a stream | The client gets part of a reply | The chunked format authenticates the last chunk; the parked receipt shows what was produced |
| A relay substitutes the node's key | Interception | The key is in the signed card, fetched at the card origin, never from the relay |
| A relay answers in the node's place | Fake replies | It cannot produce a reply that decrypts under the client's HPKE context, nor a receipt signed with the card key |
| A relay logs metadata | Loss of privacy | The descriptor's retention statement; client choice; padding (§5.2) |
| Someone attaches to a relay as another node | Jobs swallowed, though not read | The card-key challenge at connect; the relay checks that the card names it (§4.2) |
| A node serves another model or inflates usage | As for direct nodes | The same battery and receipts; relay mode changes nothing here |
| A node floods relays or holds many idle connections | Relay resources exhausted | Limits per node id and per address; a connection needs a signed card that names the relay |
| A client floods a node through relays | Node overload | Credits bound concurrency; per-client limits at the relay; an immediate `503` without a credit |
| A client uses a relay to reach other hosts | — | A relay connects only to nodes that dialled in. Its only outbound requests are card fetches, which it guards like the registry's fetcher (`impl/packages/registry/src/safefetch.js`) |
| A relay ignores cancellation | The node wastes compute | The node cancels streams nobody is reading (§4.4) and stops naming the relay |
| A relay and a node collude | The client's address and timing are exposed to the node | The stated assumption (§3). It cannot be detected; the client chooses a relay it trusts |
| A relay goes offline | The node is unreachable through it | Two or more relays per card |

## 10. Comparison

| | AI Horde | Petals | ONP direct (today) | ONP relay (proposed) |
|---|---|---|---|---|
| **Topology** | Central coordinator. Workers pull jobs (`/v2/generate/text/pop`, then `/submit`) | Peer-to-peer swarm | The client calls the node's public HTTPS endpoint | The node dials out to relays; the client calls the node through a relay |
| **Who picks the server** | The coordinator. The client can restrict it (`trusted_workers`, `workers`, `worker_blacklist`) | Not checked for this note | The client (registries rank) | The client (registries rank). The relay only forwards |
| **Server behind NAT** | Yes: outbound polling | Yes: libp2p circuit relay. Relayed servers are slower ([FAQ](https://github.com/bigscience-workshop/petals/wiki/FAQ:-Frequently-asked-questions)) | Only through a tunnel, which the card cannot describe (§1) | Yes |
| **Model placement** | Whole model per worker. Inferred: the worker loads the required model, and no splitting is documented ([workers.md](https://github.com/Haidra-Org/haidra-assets/blob/main/docs/workers.md)) | Split by blocks across servers. The client keeps the embeddings locally (FAQ) | Whole model per node | Whole model per node |
| **Who sees prompts** | The worker (the pop payload carries the prompt) and the coordinator (it holds requests and filters prompts). Inferred from the [API spec](https://aihorde.net/api/swagger.json) | Servers in the swarm can recover inputs and outputs. The docs advise against sensitive data on the public swarm ([Security page](https://github.com/bigscience-workshop/petals/wiki/Security,-privacy,-and-AI-safety)) | The node | The node only. The relay sees metadata (§5.2) |
| **Who sees the client's address** | The coordinator | Peers (Security page) | The node | The relay, not the node |
| **Streaming** | Finished generations on the native text API; a progress endpoint for streamed chat jobs and a streaming OpenAI-compatible endpoint | Not checked for this note | SSE (ONP-4 §2) | SSE in encrypted chunks (§4.4) |
| **Incentive** | Kudos: earned for jobs and uptime, they buy queue priority, are not money, and may not be sold ([kudos.md](https://github.com/Haidra-Org/haidra-assets/blob/main/docs/kudos.md)) | None live. Non-monetary points are planned (FAQ) | Payment schemes: x402, prepaid, free (ONP-5) | As direct |
| **Checking servers** | Trusted status after uptime and successful jobs; content checks on images (kudos.md, workers.md) | None by default. The docs suggest comparing with a second peer or using a private swarm (Security page) | Admission battery, blind probes, signed receipts (ONP-3 §4a) | The same battery through relays, with fewer network tells (§7) |
| **Accounting** | The coordinator's kudos ledger | None | Node-signed receipts (ONP-5 §5) | Node-signed receipts inside the envelope (§6) |
| **Location evidence** | None | None | Geolocation and round-trip times of the API host (ONP-3 §6.4) | The egress address a relay observes, for information only; open pool (§8) |
| **Abuse filtering** | Coordinator prompt filters; a `csam` state on submit | None documented | The node's policy | The node's policy. The relay cannot filter |

Petals' wiki pages cited here were last edited in 2022–2023, so they may not describe the current code.

## 11. What stays out

- **Kudos-style non-monetary credits.**
  - Kudos solve one problem: why volunteer for a free service run by one coordinator, which keeps the ledger.
  - ONP has no central ledger by design. Registries federate, and the card at the node's origin is the ground truth (ONP-3 §1, §8). A non-monetary credit needs one ledger, or it becomes a token.
  - A credit that buys priority has value, so people farm it and trade it, which is why AI Horde's terms forbid selling kudos (kudos.md).
  - ONP already covers both cases: `free` with `free_tier` limits for volunteers, and real schemes for paid service.
  - A community that wants credits can run a settlement operator with a non-monetary unit as a new payment scheme (the scheme list is open, ONP-5 §2), without touching discovery, invocation or relays.
  - So: out of the protocol, possible as a scheme.
- **A central job queue**, scheduling at the relay, and relays that reassign jobs.
- **Plaintext relays**, for example relay URLs that look like an `openai` endpoint to 0.1 clients. These would recreate the visibility of a tunnel or of a coordinator.
- **Content filtering at the relay.** End-to-end encryption rules it out, and content policy stays with nodes.
- **Splitting a model across machines** (Petals).
- **Relay meshes, onion routing**, and protection against a global observer.
- **Paying relays inside the protocol** (Q8).

## 12. What would change, part by part

**ONP-1**

- §2: a fourth conformance class, **ONP Relay** (§9 obligations).
- §6: threat 6, **the intermediary**. A relay reads, alters, replays, drops, delays or analyses traffic, or colludes with a node. The defences are end-to-end encryption, receipts signed with the card key, the replay rules and client choice of relay. The metadata exposure is stated (§5.2).

**ONP-2**

- §1: a card may describe a node with no public API. The card origin is still HTTPS and controls the id, and a relay never serves the card (§4.1).
- §4: `endpoints.relay` (1 to 4 entries) and `endpoints.relay_keys` (OHTTP key configurations) in the signed card. `openai` and `health` are required unless `relay` is present, and dual mode is allowed.
- §8: the card key also authenticates the node to relays. Clients choose keys by `kid` at the card origin. Encryption keys are separate from signing keys. Rotation has a grace period.
- §9 and the schema: `endpoints` requires either `openai` and `health`, or `relay` and `relay_keys` (Q6 on compatibility).

**ONP-3**

- §4a:
  - the battery runs through relays (§7.1), with Stage A health and `/models` checks inside the envelope and the in-band receipt required;
  - probes go only through relays the card names, chosen as clients choose;
  - relay-level errors count against the relay path;
  - the coverage rule applies until a registry supports the transport;
  - inner requests follow the client header profile.
- §5: offering summaries carry `transport` (`direct`, `relay` or both), and search gains `transport=` so clients without relay support can leave such nodes out.
- §5e: `server_check: relay` does not qualify. For a node with both paths, `pool` describes the direct path only, and a client that marks a request sensitive MUST NOT send it through a relay (§8). R4 asks about a pinned key reached through a relay.
- §6.4: the `relay` verdict and evidence level; relay-observed evidence published for information only.
- §2 and §8: optional `GET /v0/relays`, and relay descriptors in federation.

**ONP-4**

- New §10, the **relay transport**:
  - framing and credits;
  - Binary HTTP inside OHTTP, with the chunked variant for streams;
  - relay-level errors;
  - cancellation and back-pressure;
  - `Date` and `Idempotency-Key`;
  - the inner header profile.
- §2: in relay mode the in-band `onp.receipt` event is REQUIRED, with `ONP-Receipt: in-band`, plus parked receipts (§4.4).
- §9: new problem names: `node-offline`, `relay-timeout`, `relay-rate-limited`, `unknown-node`, `replayed-request`, `stale-request`, `request-in-progress`, `duplicate-request`.

**ONP-5**

- §5: `request_hash` defined for the envelope (the inner body bytes); optional `request_id` and `via`.
- §4: relays are not settlement parties.
- The settlement API (Draft 0.2): consider unlinkable tokens, to remove the account tell (§7.2).

**A new part, ONP-8: Relays** (ONP-7 is already taken by the sovereignty profile ONP-2 §3a refers to). It holds what a relay MUST do:

- forward only to the node named in the request, and add nothing about the client;
- forward cancellation;
- bound its buffers and keep no queue beyond the client's connection;
- park encrypted receipts for 24 hours;
- publish a descriptor, with metadata retention.

Q4 asks whether this belongs in ONP-4 instead.

**Node Kit (`onp-node`)**

- `init --relay URL …` writes the relay endpoints and generates the X25519 key, stored like the signing key.
- `card --out well-known` already exists for card-only listings and writes the relay card for a static host.
- `serve --relay` does the following:
  - dials out, with no public URL and no listening port needed;
  - decapsulates requests and keeps the replay and idempotency caches;
  - grants credits from `max_concurrency`;
  - aborts the engine request on cancellation;
  - sends the in-band receipt and parks receipts.
- `check` runs through a relay.
- `register` takes the card URL, as the card-only flow does.
- `namespace_ok` checks the public URL's host today (`node-kit/onp_node/cli.py:80-89`). In relay mode it checks the card URL's host.

**Core, gateway and CLI**

- Core: HPKE, OHTTP and Binary HTTP on Node's `crypto`; one inner-request builder shared by every client; card and receipt verification by `kid` at the card origin (§6.2).
- Gateway:
  - the relay transport for offerings with `endpoints.relay`;
  - relay choice, and retries with `Idempotency-Key`;
  - in-band and parked receipts;
  - receipt verification with the card key (`gateway.js:213-226`);
  - sensitive requests to a node with both paths go only the direct way.

  The fallback policy stays as it is (ONP-4 §9).
- Advisor: `server_check: relay` does not pass, which is already the effect today (§8). Recommendations carry `transport`.
- Ollama router: possibly reaching a pinned peer through a relay (R4).

**Registry**

- The relay transport in every probe path (`probes.js`, `chatOnce` in `stageb.js`, `stagec.js`), with failures attributed per relay.
- The `relay` verdict in `location.js`, and `GET /v0/relays`.
- Card refresh decoupled from the blind sweep (`stagec.js:142`). This helps direct nodes too.

**Relay:** a new package.

**Tests:** the fixture node gains a relay mode and relay misbehaviours: drop, delay, replay, truncate and key swap.

## 13. Open questions

**For the maintainer**

- **Q1.** Is a static card at an origin the operator controls (a domain, or a free static-host subdomain) acceptable for home operators? Or should ONP also offer relay-hosted cards, which need key pinning?
- **Q2.** Allow dual mode (direct and relay on one card) in Draft 0.2, or start with relay-only cards?
- **Q3.** Transport baseline: WebSocket only, or HTTP/2 and HTTP/3 extended CONNECT from the start?
- **Q4.** A new part (ONP-8 Relays), or a section of ONP-4?
- **Q5.** Per-client rate limits for relay nodes: at the relay by address, or at the node by credential? The second brings back a probe tell (§5.3).
- **Q6.** Compatibility. A relay-only card fails the 0.1 schema, which requires `openai`. Clients and registries on 0.1 would then ignore relay nodes, which is safe because they cannot call them, but it strains ONP-1 §5's rule that higher minor versions MUST be accepted. Is that reading acceptable, or should `openai` become optional in the 0.1 schema first?
- **Q7.** Should the project run a public relay? Who pays for it, and is it acceptable that it would see the addresses of most relay clients?
- **Q8.** Relay economics: disclosure only, or a fee field in the protocol?
- **Q9.** A node that declares `retention: none` cannot return a lost reply on a retry, so the client pays twice for that request (§4.5). Accept this, or allow a short reply cache that is stated in the data policy?

**For the reviewer (Mark Lindley)**

- **R1.** Is non-collusion between relay and node an acceptable basis for the address gain in §7, given that a node operator can name its own relay?
- **R2.** Would a relay run by the registry at its probe sites make the relay-observed egress address and round-trip time good enough for `same_region`? Or does the forwarding-box argument settle it, so relay nodes stay in the open pool until attested residency?
- **R3.** Are the `Date` window, the `enc` cache and `Idempotency-Key` enough against replay and double billing?
- **R4.** May a key the user pinned, reached through a relay ("my home GPU from my laptop"), count as the user's own machine under ONP-3 §5e?
- **R5.** Request shape and cadence. Should Stage C vary temperature and `max_tokens`? Doing so would also change the shape in which identity references are captured, and it applies to direct nodes as much as to relay nodes.
- **R6.** Should the KNOWN-ISSUES row "one source address" change status for relay nodes with an independent relay (§7.2)?
- **R7.** Relay-level errors on a path whose health passes (§7.1): are a few excused errors a day, each followed by a fresh probe within the hour, and then counted against the node, the right balance? The alternatives are a node's own relay dodging probes, and an honest node losing a tier to a bad third-party relay.

## 14. Checked against `main` (`8e74fe6`)

Current behaviour this note relies on, and where it was checked:

| Claim | Where |
|---|---|
| `endpoints.openai` and `endpoints.health` are required by the card schema | `schemas/open-node.schema.json:37` |
| An origin reachable only through a tunnel cannot be checked | ONP-2 §4; `node-kit/README.md` (card-only section) |
| The registry refuses private and loopback targets | `impl/packages/registry/src/safefetch.js:9-32` |
| A host equal to the id's domain controls the id, so `alice.github.io` may claim `io.github.alice` | `impl/packages/registry/src/namespace.js:13-18` |
| The registry verifies cards with the key set at the card URL's origin, chosen by `kid` | `impl/packages/registry/src/server.js:125-139`, `:351` |
| The gateway verifies receipts with `keys[0]` at the API origin; the CLI client does the same for cards and receipts; the router does so for peers it has not pinned | `impl/packages/cli/src/gateway.js:213-226`; `impl/packages/cli/src/client.js:53-54`, `:116-117`; `impl/packages/ollama-router/src/router.js:277-278` |
| The gateway accepts receipt URLs only on the node's own origin | `impl/packages/cli/src/gateway.js:229-231` |
| Streamed receipts are by URL only; no in-band `onp.receipt` event is sent or read | `node-kit/onp_node/server.py:164-168`; `impl/packages/cli/src/gateway.js:332-365`; a search for `onp.receipt` finds no sender and no reader in the Node Kit, the gateway or the fixture node |
| `request_hash` is the SHA-256 of the raw request body | `node-kit/onp_node/server.py:84-102`; `impl/packages/cli/src/gateway.js:223` |
| The probe key or customer access is attached only toward the card's endpoint origins | `impl/packages/registry/src/server.js:160-167` |
| Every Stage C call uses temperature 0 and at most 64 output tokens; about 1 in 4 asks an identity reference | `impl/packages/registry/src/stageb.js:30`, `:48`; `impl/packages/registry/src/stagec.js:50`, `:54` |
| Probes set no user agent, so they carry Node `fetch`'s defaults (`user-agent: node`, checked with Node 24) | `impl/packages/registry/src/stageb.js:36-50`; the only user agent the registry sets is the origin check's (`location.js:198`) |
| The card is re-fetched just before each blind sweep | `impl/packages/registry/src/stagec.js:142` |
| The location check takes the first IPv4, uses MaxMind GeoLite through RIPEstat and a fixed CDN list, and measures TCP connects on port 443 | `impl/packages/registry/src/location.js:301`, `:93`, `:45`, `:116` |
| Only "too fast" changes the location verdict | `impl/packages/registry/src/location.js:161` |
| An unknown location verdict is `unchecked`, and the trusted pool needs `passed` or `passed_origin` | `impl/packages/core/src/advisor.js:446`, `:461-471` |
| The admission battery calls only `onp.openai.chat/v1` | `impl/packages/registry/src/probes.js:22-30` |
| The Node Kit checks the namespace against its public URL | `node-kit/onp_node/cli.py:80-89` |
| The CLI client resolves cards and verifies receipts at the origin of `endpoints.openai` | `impl/packages/cli/src/client.js:102-103`, `:116-117` |
| The vendor rule takes the id's second label as the node's own vendor label, so `io.github.*` nodes share `github`; there is no built-in entry for it | `impl/packages/registry/src/vendors.js:27`, `:74-76`; `impl/packages/registry/src/data/proprietary-vendors.json` |
| The CDN list holds Cloudflare, Fastly, Akamai, CDN77, Edgio and Edgecast, so other tunnel ingresses are located as ordinary fronts | `impl/packages/registry/src/location.js:45-48` |

Statements about outside services (AI Horde, Petals, Cloudflare Tunnel, Tailscale Funnel, ngrok) come from their own pages, linked where they are used, as read on 20 November 2026.

**Noticed along the way (not part of this proposal):**

- ONP-2 §4 still says, in its second paragraph on origin addresses, that an origin passes with "any HTTP status below 500". Revision 12 (CHANGES S10) and ONP-3 §6.4 require `200` with the same model ids. The two sections disagree.
- A node behind a tunnel whose ingress is not on the CDN list is located at the ingress, and can pass the server check (§1, §8; KNOWN-ISSUES 4.7).
- Every `*.github.io`-style node shares a vendor label (§4.1).
- The blind sweep re-fetches the card just before each blind call (`stagec.js:142`), which tells a direct node that serves its own card that a probe is coming.
