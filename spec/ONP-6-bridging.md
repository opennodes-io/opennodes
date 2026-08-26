# ONP-6: Bridging — MCP, WebMCP, Web Data, and Scenarios

**OpenNodes Protocol — Draft 0.1 — 2026-08-20**

The AI Node Client is where discovery becomes useful: the user (or an app on their behalf) picks discovered offerings and wires them to tools and data. This part specifies the client-side contracts so that a scenario built in one client runs in another.

---

## 1. Client roles

An ONP Client is simultaneously:
- an **ONP consumer** (discovery, invocation, settlement — ONP-2..5),
- an **MCP host** (connecting user-chosen MCP servers, standard MCP client role),
- optionally a **WebMCP agent** (consuming in-page tools where the platform exposes them),
- optionally a **web fetcher** (plain HTTP retrieval for conventional sites).

The bridge pattern is uniform: **the selected ONP offering supplies the model; MCP/WebMCP/web supply tools and context; the client runs the loop.**

## 2. MCP bridge

Contract for pairing any tool-calling offering with any MCP server:

1. Eligibility: the offering's `serving.supports` MUST include `tool_calls`; clients MUST refuse (or warn and run tool-free) otherwise.
2. Translation: MCP `tools/list` results map to the binding's tool schema (for `onp.openai.chat/v1`: MCP tool → OpenAI function declaration; `inputSchema` passes through as JSON Schema). Tool-call results return as tool-role messages. This mapping is what every chat app hand-rolls today; ONP-6 fixes it normatively so scenarios are portable.
3. The loop (model → tool_calls → MCP `tools/call` → results → model) runs entirely client-side; the node never sees MCP credentials.
4. Consent & audit: clients MUST record which offering saw which tool results (data-flow provenance), and MUST apply the card's `data_policy` when deciding which servers may be paired with which nodes (e.g. a server marked `sensitive` only pairs with `retention: none` offerings). Registry-side, MCP servers indexed via `onp.mcp.server/v1` (ONP-4 §6) make server discovery part of the same search surface.

## 3. WebMCP bridge

Where the platform provides WebMCP (`navigator.modelContext`, W3C WebML CG draft; Chrome origin trial as of mid-2026):

- Browser-resident clients (extension or built-in) enumerate page-registered tools and expose them into the same loop as MCP tools, marked `origin-scoped` (they exist only while the page session lives).
- **Registry flag:** an ONP Registry MAY maintain a **site directory** — `GET /v0/sites?webmcp=true` — listing origins that declare WebMCP support (self-registered with the same DNS/HTTP challenge, liveness-checked by loading the origin and probing for tool registration). This is the "enhanced website registry" from the concept: cheap to run, useful to clients deciding whether to drive a site via tools or via fetch.
- Caveat (normative posture): WebMCP is pre-standard; clients MUST treat it as progressive enhancement and fall back to §4.

## 4. Conventional web data

Plain HTTP fetch under the client's user agent, robots/permissions policy, and the same provenance log (which offering saw which origin's content). No new protocol; the only ONP rule is provenance + `data_policy` enforcement, same as §2.4.

## 5. Scenarios — portable multi-node composition

A **Scenario** is a declarative JSON document a client executes; it is how "use a cheap local model to triage, escalate to a frontier model, with my MCP tools" travels between clients.

```json
{
  "onp_scenario": "0.1",
  "name": "research-then-draft",
  "roles": {
    "triage":  {"select": {"modality": "text", "max_input_price": 0.2,
                            "min_tier": "community", "sort": "price"}},
    "drafter": {"select": {"family": "gpt-5", "min_tier": "verified"},
                "fallback": {"family": "claude-5", "min_tier": "verified"}}
  },
  "tools": {"mcp": ["io.github.user/search-server"], "webmcp": true, "web": true},
  "steps": [
    {"id": "classify", "role": "triage",
     "prompt": "Classify the request; output route=simple|complex", "input": "$user"},
    {"id": "answer_simple", "if": "classify.route == 'simple'",
     "role": "triage", "input": "$user", "tools": false},
    {"id": "answer_complex", "if": "classify.route == 'complex'",
     "role": "drafter", "input": "$user", "tools": true}
  ],
  "policy": {"max_total_usd": 0.50, "data": {"web_content_to": ["triage", "drafter"]}}
}
```

Key semantics:
- `roles.*.select` is an ONP-3 §5 search query, resolved at run time against the user's registries — scenarios name *requirements*, not vendors (though `node_id` pinning is allowed). This is late binding: the same scenario gets cheaper/better as the registry does.
- `steps` is deliberately minimal (sequence, condition, role, tools on/off, variable piping). Scenarios are not a workflow language; anything beyond this belongs in application code driving the client SDK.
- `policy` composes with (never overrides) the user's client-level spend/trust policy.

## 6. Agent-driven composition

Most humans will never open a model picker; **AI agents are the expected primary consumers of ONP discovery.** An agent given a task should be able to discover nodes, plan a chain, price it, execute it, and account for it — without human involvement beyond policy. ONP supports this with four primitives, all already defined; this section fixes how they compose:

1. **Discovery as a tool.** A conforming registry SHOULD expose its search and estimation API as an MCP server (`onp.mcp.server/v1` describing itself), so any MCP-host agent gains `search_offerings`, `estimate`, and `get_offering` tools with zero ONP-specific code. Discovery thereby rides the tool standard agents already speak.
2. **Plan → price → pin.** The agent builds a candidate chain (offerings or `select` queries per step), calls `POST /v0/estimate` (ONP-3 §5a), applies the governing spend policy (client-level, ONP-5 §3), and pins `card_revision`s at invocation so the estimate is enforceable.
3. **Composition patterns** (executed by the client/agent runtime; ONP standardizes the description, not the engine):
   - **Sequential** — cheap model drafts/triages, stronger model refines (the Scenario `steps` form, §5);
   - **Parallel fan-out** — the same step across N offerings concurrently, merged by a judge step or voting rule (`mode: "parallel"`, `merge: {"role": "judge"}` in a Scenario step);
   - **Cascade** — attempt on the cheapest conforming offering with an acceptance check; escalate on failure (`escalate_to` on a step);
   - **Specialist routing** — per-input-language or per-modality dispatch using `serving.languages` and `modality` filters.
4. **Accountability.** Every step returns an `ONP-Receipt`; the runtime aggregates receipts into a per-task expense report (estimate vs. actual), which is also the feedback signal an agent uses to improve its own routing over time.

Selection criteria are whatever the caller optimizes — `sort=price`, `sort=rank`, attested-benchmark thresholds, language grades, region pinning — the point of putting rich metadata in the card is precisely that *software* can weigh it even when users won't.

## 7. Developer surface (informative)

Two integration levels are expected: an **SDK** (the client engine as a library: `discover() → select() → invoke()/run_scenario()`, embeddable in IDEs and apps), and the **end-user client** (desktop/mobile/OS-integrated; model-picker UI over registry search, MCP server management, scenario runner, spend dashboard fed by receipts). Both consume only public ONP surfaces — nothing in the client is privileged, which is the point: OS vendors' pluggable-model runtimes (Apple `LanguageModel` protocol, Windows AI Foundry catalogs) can implement ONP resolution natively without asking anyone's permission.
