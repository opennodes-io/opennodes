"""Cross-language e2e: Python Node Kit fronting a mock engine, registered and
Stage-A-probed by the real JS registry. Proves the JWS/card byte-compatibility
between the Python signer and the JS verifier, plus the full proxy behavior."""
import asyncio
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path

from aiohttp import web, ClientSession
from aiohttp.test_utils import TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from onp_node.config import build_card  # noqa: E402
from onp_node.jws import generate_private_key, verify_jws  # noqa: E402
from onp_node.server import NodeKitServer  # noqa: E402

IMPL = Path(__file__).resolve().parents[2] / "impl"
REGISTRY_PORT = 4391


def make_mock_engine():
    """Minimal OpenAI-compatible engine: /models + /chat/completions with usage + streaming."""
    async def models(_req):
        return web.json_response({"object": "list", "data": [{"id": "mock/tiny-1", "object": "model"}]})

    async def chat(req):
        body = await req.json()
        prompt = "\n".join(m.get("content", "") for m in body.get("messages", []))
        reply = f"mock-engine says: {prompt[:80]}"
        usage = {"prompt_tokens": max(1, len(prompt) // 4),
                 "completion_tokens": max(1, len(reply) // 4)}
        usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
        if body.get("stream"):
            resp = web.StreamResponse(headers={"content-type": "text/event-stream"})
            await resp.prepare(req)
            chunk = {"choices": [{"index": 0, "delta": {"content": reply}}]}
            await resp.write(f"data: {json.dumps(chunk)}\n\n".encode())
            final = {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": usage}
            await resp.write(f"data: {json.dumps(final)}\n\ndata: [DONE]\n\n".encode())
            await resp.write_eof()
            return resp
        return web.json_response({
            "id": "cmpl-1", "object": "chat.completion", "model": body["model"],
            "choices": [{"index": 0, "message": {"role": "assistant", "content": reply},
                         "finish_reason": "stop"}],
            "usage": usage,
        })

    app = web.Application()
    app.router.add_get("/v1/models", models)
    app.router.add_post("/v1/chat/completions", chat)
    return app


class StableStringify(unittest.TestCase):
    def test_integral_floats_match_js(self):
        # Regression: JS JSON.stringify(0.0) === "0"; Python must not emit "0.0".
        from onp_node.jws import stable_stringify
        self.assertEqual(stable_stringify({"a": 0.0, "b": 1.5, "c": [2.0, True]}),
                         '{"a":0,"b":1.5,"c":[2,true]}')


class CrossLanguageE2E(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # 1. mock engine
        self.engine = TestServer(make_mock_engine())
        await self.engine.start_server()
        engine_base = f"http://127.0.0.1:{self.engine.port}/v1"

        # 2. node kit in front of it, on a pre-picked free port so the card's
        #    public_url matches the bound origin
        import socket
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            kit_port = s.getsockname()[1]
        self.kit_origin = f"http://127.0.0.1:{kit_port}"

        self.key = generate_private_key()
        self.challenge_file = Path(self.tmp.name) / "challenge.txt"
        cfg = {
            "node": {"id": "org.example.mockcluster", "name": "Mock Cluster",
                     "public_url": self.kit_origin, "operator_name": "Example U", "country": "DE"},
            "engine": {"base_url": engine_base},
            "serving": {"context_window": 8192, "max_output_tokens": 1024},
            "pricing": {"currency": "USD", "input_per_mtok": 0.2, "output_per_mtok": 0.6,
                        "schemes": ["free"]},
            "data_policy": {"retention": "none", "training_on_inputs": False},
        }
        card = build_card(cfg, ["mock/tiny-1"])
        kit = NodeKitServer(card, self.key, engine_base, challenge_file=self.challenge_file)
        self.kit_server = TestServer(kit.build_app(), port=kit_port)
        await self.kit_server.start_server()

        # 3. the real JS registry as a subprocess
        env = {**os.environ, "PORT": str(REGISTRY_PORT), "ONP_ALLOW_PRIVATE": "1", "ONP_STAGE_C": "0"}
        self.registry_proc = subprocess.Popen(
            ["node", str(IMPL / "packages" / "registry" / "bin.js")],
            env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        self.registry = f"http://127.0.0.1:{REGISTRY_PORT}"
        for _ in range(50):
            try:
                with urllib.request.urlopen(f"{self.registry}/v0/health", timeout=1):
                    break
            except OSError:
                await asyncio.sleep(0.1)
        else:
            raise RuntimeError("registry did not come up")

        self.http = ClientSession()

    async def asyncTearDown(self):
        await self.http.close()
        await self.kit_server.close()
        await self.engine.close()
        self.registry_proc.terminate()
        self.registry_proc.wait(timeout=10)
        self.tmp.cleanup()

    async def test_full_cross_language_loop(self):
        # Register: JS registry fetches the Python-signed card
        async with self.http.post(f"{self.registry}/v0/nodes",
                                  json={"card_url": f"{self.kit_origin}/.well-known/open-node.json"}) as r:
            reg = await r.json()
            self.assertEqual(r.status, 202, reg)
        self.assertEqual(reg["node_id"], "org.example.mockcluster")

        # Serve the HTTP challenge from the kit's challenge file, then verify
        self.challenge_file.write_text(reg["challenge"]["token"])
        async with self.http.post(f"{self.registry}{reg['challenge']['verify']}") as r:
            verify = await r.json()
        self.assertEqual(verify["state"], "community", verify)
        # THE cross-language assertion: JS registry verified the Python Ed25519 JWS
        self.assertTrue(verify["signature_verified"], "JS registry must verify the Python-signed card")
        self.assertTrue(verify["stage_a"]["ok"], verify["stage_a"])

        # Search finds the offering with real pricing
        async with self.http.get(f"{self.registry}/v0/offerings?modality=text") as r:
            offerings = (await r.json())["offerings"]
        self.assertEqual(len(offerings), 1)
        self.assertEqual(offerings[0]["pricing"]["input_per_mtok"], 0.2)
        self.assertEqual(offerings[0]["binding"]["model_id"], "mock/tiny-1")

        # Pinned invoke through the kit -> mock engine; inline receipt verifies in Python
        card_rev = offerings[0]["card_revision"]
        async with self.http.post(
            f"{self.kit_origin}/v1/chat/completions",
            json={"model": "mock/tiny-1", "messages": [{"role": "user", "content": "hello kit"}]},
            headers={"onp-offering": "org.example.mockcluster/mock-tiny-1",
                     "onp-card-revision": card_rev},
        ) as r:
            self.assertEqual(r.status, 200)
            body = await r.json()
            receipt_jws = r.headers["onp-receipt"]
        self.assertIn("mock-engine says: hello kit", body["choices"][0]["message"]["content"])
        async with self.http.get(f"{self.kit_origin}/.well-known/jwks.json") as r:
            jwk = (await r.json())["keys"][0]
        receipt = verify_jws(receipt_jws, jwk)
        self.assertEqual(receipt["card_revision"], card_rev)
        expected = round(0.2 * receipt["usage"]["prompt_tokens"] / 1e6
                         + 0.6 * receipt["usage"]["completion_tokens"] / 1e6, 6)
        self.assertEqual(receipt["amount"]["value"], expected)

        # Streaming: receipt arrives by URL and resolves to a verifiable JWS
        async with self.http.post(
            f"{self.kit_origin}/v1/chat/completions",
            json={"model": "mock/tiny-1", "stream": True,
                  "messages": [{"role": "user", "content": "stream please"}]},
        ) as r:
            receipt_url = r.headers["onp-receipt"]
            text = await r.text()
        self.assertIn("mock-engine says: stream please", text)
        self.assertIn("data: [DONE]", text)
        self.assertTrue(receipt_url.startswith("http"))
        async with self.http.get(receipt_url) as r:
            stream_receipt = verify_jws(await r.text(), jwk)
        self.assertGreater(stream_receipt["usage"]["completion_tokens"], 0)

        # ONP 409s: offering mismatch and stale price pin
        async with self.http.post(
            f"{self.kit_origin}/v1/chat/completions",
            json={"model": "mock/tiny-1", "messages": [{"role": "user", "content": "x"}]},
            headers={"onp-offering": "org.example.mockcluster/wrong-offering"},
        ) as r:
            self.assertEqual(r.status, 409)
        async with self.http.post(
            f"{self.kit_origin}/v1/chat/completions",
            json={"model": "mock/tiny-1", "messages": [{"role": "user", "content": "x"}]},
            headers={"onp-card-revision": "1999-01-01T00:00:00.000Z"},
        ) as r:
            self.assertEqual(r.status, 409)
            self.assertIn("price_changed", (await r.json())["type"])

        # Plain OpenAI traffic (no ONP headers) passes untouched (NK-INV-02)
        async with self.http.post(
            f"{self.kit_origin}/v1/chat/completions",
            json={"model": "mock/tiny-1", "messages": [{"role": "user", "content": "plain"}]},
        ) as r:
            self.assertEqual(r.status, 200)


if __name__ == "__main__":
    unittest.main()
