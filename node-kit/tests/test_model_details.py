"""Per-model details in the card: what the engine reports, overridden by [model."<id>"]."""
import asyncio
import tomllib

from aiohttp import web

from onp_node.cli import engine_details, _params_b
from onp_node.config import DEFAULT_CONFIG, build_card


def _cfg(extra=""):
    return tomllib.loads(DEFAULT_CONFIG.format(engine_base="http://127.0.0.1:11434/v1", node_id="org.example.ai",
                                                public_url="https://ai.example.org", name="Example",
                                                operator="Example") + extra)


def _reply(data=None, status=200):
    async def handler(_req):
        return web.json_response(data, status=status) if data is not None else web.Response(status=status)
    return handler


async def _serve(routes):
    app = web.Application()
    app.add_routes(routes)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    port = site._server.sockets[0].getsockname()[1]
    return runner, f"http://127.0.0.1:{port}/v1"


def test_params_parsing():
    assert _params_b("8.2B") == 8.2 and _params_b("567M") == 0.567 and _params_b("") is None and _params_b("big") is None


def test_ollama_reports_size_and_capabilities_but_not_context():
    async def show(req):
        name = (await req.json())["model"]
        caps = ["completion", "tools"] if name == "qwen3:8b" else ["completion", "vision"]
        return web.json_response({"details": {"parameter_size": "8.2B", "quantization_level": "Q4_K_M", "family": "qwen3"},
                                  "capabilities": caps, "model_info": {"qwen3.context_length": 40960}})

    async def run():
        runner, base = await _serve([
            web.get("/v1/models", _reply({"data": [{"id": "qwen3:8b"}, {"id": "llava:7b"}]})),
            web.post("/api/show", show)])
        try:
            return await engine_details(base, ["qwen3:8b", "llava:7b"])
        finally:
            await runner.cleanup()

    d = asyncio.run(run())
    assert d["qwen3:8b"] == {"params_b": 8.2, "quantization": "Q4_K_M", "family": "qwen3", "supports": ["tool_calls"]}
    assert d["llava:7b"]["supports"] == ["vision"]
    assert "context_window" not in d["qwen3:8b"]     # Ollama serves less than the trained maximum


def test_vllm_reports_served_context():
    async def run():
        runner, base = await _serve([
            web.get("/v1/models", _reply({"data": [{"id": "Qwen/Qwen3-235B-A22B-FP8", "max_model_len": 32768}]})),
            web.post("/api/show", _reply(status=404))])
        try:
            return await engine_details(base, ["Qwen/Qwen3-235B-A22B-FP8"])
        finally:
            await runner.cleanup()

    assert asyncio.run(run()) == {"Qwen/Qwen3-235B-A22B-FP8": {"context_window": 32768}}


def test_unreachable_engine_details_are_empty():
    assert asyncio.run(engine_details("http://127.0.0.1:9/v1", ["m"])) == {"m": {}}


def test_card_merges_engine_details_and_operator_overrides():
    cfg = _cfg('''
[model."Qwen/Qwen3-235B-A22B-FP8"]
params_b = 235
supports = ["tool_calls", "json_mode", "bogus"]
quantization = "fp8"
languages = ["en", { lang = "pl", grade = "native" }]
expected_tps = 60
expected_ttft_ms = { p50 = 400, p95 = 1200 }
''')
    card = build_card(cfg, ["Qwen/Qwen3-235B-A22B-FP8", "llama3.2:1b"],
                      {"Qwen/Qwen3-235B-A22B-FP8": {"context_window": 32768, "params_b": 200}})
    big, small = card["offerings"]
    assert big["model"]["params_b"] == 235 and big["model"]["quantization"] == "fp8"     # operator wins
    assert big["serving"]["context_window"] == 32768                                      # from vLLM
    assert big["serving"]["supports"] == ["streaming", "tool_calls", "json_mode"]          # unknown values dropped
    assert big["serving"]["languages"] == [{"lang": "en", "grade": "strong"}, {"lang": "pl", "grade": "native"}]
    assert big["serving"]["expected_tps"] == {"p50": 60.0, "basis": "claimed"}
    assert big["serving"]["expected_ttft_ms"] == {"basis": "claimed", "p50": 400, "p95": 1200}
    assert "params_b" not in small["model"] and small["serving"]["supports"] == ["streaming"]
    assert small["serving"]["context_window"] == 8192                                     # [serving] default
