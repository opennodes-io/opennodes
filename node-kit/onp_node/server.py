"""The Node Kit server (NK-INV/NK-PAY/NK-REG): a reverse proxy in front of an
OpenAI-compatible engine. The engine is untouched; the kit adds the ONP layer:
card + JWKS + challenge serving, ONP header validation (409s), usage accounting,
signed receipts (inline for non-streaming, by-URL for streams), and health."""
import hashlib
import json
import uuid
from datetime import datetime, UTC

from aiohttp import web, ClientSession, ClientTimeout

from .jws import sign_json, sign_card, public_jwk


def _now() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _approx_tokens(text: str) -> int:
    return max(1, len(text) // 4)


class NodeKitServer:
    def __init__(self, card: dict, private_key, engine_base: str, challenge_file=None):
        self.key = private_key
        self.card = sign_card(card, private_key)
        self.engine_base = engine_base.rstrip("/")
        self.challenge_file = challenge_file
        self.receipts: dict[str, str] = {}          # receipt_id -> jws
        self.offering_by_model = {o["binding"]["model_id"]: o for o in card["offerings"]}
        self.session: ClientSession | None = None

    # -- helpers -------------------------------------------------------------
    def _problem(self, status, type_, detail):
        return web.json_response(
            {"type": f"https://opennodes.org/problems/{type_}", "title": type_,
             "status": status, "detail": detail},
            status=status, content_type="application/problem+json")

    def _make_receipt(self, offering, usage, request_bytes, pinned_revision, scheme="free"):
        pricing = offering["pricing"]
        amount = round(
            pricing.get("input_per_mtok", 0) * usage["prompt_tokens"] / 1_000_000
            + pricing.get("output_per_mtok", 0) * usage["completion_tokens"] / 1_000_000, 6)
        payload = {
            "receipt_id": f"r_{uuid.uuid4()}",
            "node_id": self.card["node"]["id"],
            "offering_id": offering["offering_id"],
            "card_revision": pinned_revision or self.card["revision"],
            "request_hash": "sha256:" + hashlib.sha256(request_bytes).hexdigest(),
            "usage": usage,
            "amount": {"currency": pricing.get("currency", "USD"), "value": amount},
            "scheme": scheme,
            "issued_at": _now(),
        }
        jws = sign_json(payload, self.key)
        self.receipts[payload["receipt_id"]] = jws
        return payload["receipt_id"], jws

    # -- routes --------------------------------------------------------------
    async def well_known_card(self, _req):
        return web.json_response(self.card, headers={"cache-control": "max-age=60"},
                                 content_type="application/open-node+json")

    async def jwks(self, _req):
        return web.json_response({"keys": [public_jwk(self.key)]})

    async def challenge(self, req):
        token = req.match_info["token"]
        active = None
        if self.challenge_file and self.challenge_file.exists():
            active = self.challenge_file.read_text().strip()
        if active and token == active:
            return web.json_response({"token": token})
        return self._problem(404, "unknown-challenge", token)

    async def health(self, _req):
        return web.json_response({"status": "ok"})

    async def get_receipt(self, req):
        jws = self.receipts.get(req.match_info["rid"])
        if not jws:
            return self._problem(404, "unknown-receipt", req.match_info["rid"])
        return web.Response(text=jws, content_type="text/plain")

    async def models(self, _req):
        data = [{"id": mid, "object": "model", "owned_by": self.card["node"]["id"]}
                for mid in self.offering_by_model]
        return web.json_response({"object": "list", "data": data})

    async def chat(self, req):
        raw = await req.read()
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            return self._problem(400, "bad-json", "request body is not JSON")

        offering = self.offering_by_model.get(body.get("model"))
        if not offering:
            return self._problem(404, "model-not-found", str(body.get("model")))

        # ONP headers are additive (NK-INV-02): plain OpenAI traffic passes untouched.
        onp_offering = req.headers.get("onp-offering")
        expected = f"{self.card['node']['id']}/{offering['offering_id']}"
        if onp_offering and onp_offering != expected:
            return self._problem(409, "offering-mismatch", onp_offering)
        pinned = req.headers.get("onp-card-revision")
        if pinned and pinned != self.card["revision"]:
            return self._problem(409, "price_changed",
                                 f"pinned {pinned}, current {self.card['revision']}")

        upstream = await self.session.post(f"{self.engine_base}/chat/completions", data=raw,
                                           headers={"content-type": "application/json"})
        if upstream.status != 200:
            detail = (await upstream.text())[:500]
            return self._problem(502, "engine-error", f"engine returned {upstream.status}: {detail}")

        if body.get("stream"):
            # Receipt content is unknown until the stream ends -> ONP-Receipt carries a URL.
            receipt_id = f"r_{uuid.uuid4()}"
            public = self.card["endpoints"]["health"].rsplit("/onp/", 1)[0]
            resp = web.StreamResponse(headers={
                "content-type": upstream.headers.get("content-type", "text/event-stream"),
                "onp-receipt": f"{public}/onp/receipts/{receipt_id}",
            })
            await resp.prepare(req)
            usage = None
            prompt_text = "\n".join(m.get("content", "") for m in body.get("messages", [])
                                    if isinstance(m.get("content"), str))
            completion_chars = 0
            async for chunk in upstream.content.iter_any():
                await resp.write(chunk)
                for line in chunk.decode("utf-8", "ignore").splitlines():
                    if line.startswith("data: ") and line != "data: [DONE]":
                        try:
                            evt = json.loads(line[6:])
                            usage = evt.get("usage") or usage
                            delta = evt.get("choices", [{}])[0].get("delta", {}).get("content")
                            if delta:
                                completion_chars += len(delta)
                        except (json.JSONDecodeError, IndexError):
                            pass
            await resp.write_eof()
            if usage is None:  # engine omitted stream usage: approximate (NK-INV-01)
                usage = {"prompt_tokens": _approx_tokens(prompt_text),
                         "completion_tokens": max(1, completion_chars // 4)}
                usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
            rid, jws = self._make_receipt(offering, usage, raw, pinned)
            self.receipts[receipt_id] = jws  # reachable under the pre-announced id
            return resp

        payload = await upstream.json()
        usage = payload.get("usage")
        if not usage or "prompt_tokens" not in usage:
            prompt_text = "\n".join(m.get("content", "") for m in body.get("messages", [])
                                    if isinstance(m.get("content"), str))
            reply = payload.get("choices", [{}])[0].get("message", {}).get("content") or ""
            usage = {"prompt_tokens": _approx_tokens(prompt_text),
                     "completion_tokens": _approx_tokens(reply)}
            usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
            payload["usage"] = usage
        _rid, jws = self._make_receipt(offering, usage, raw, pinned)
        return web.json_response(payload, headers={"onp-receipt": jws})

    # -- lifecycle -----------------------------------------------------------
    def build_app(self) -> web.Application:
        # Nodes SHOULD serve browser clients (registry playgrounds, web agents):
        # permissive CORS with the ONP headers allowed and receipts exposed.
        @web.middleware
        async def cors(request, handler):
            if request.method == "OPTIONS":
                resp = web.Response(status=204)
            else:
                resp = await handler(request)
            resp.headers["Access-Control-Allow-Origin"] = "*"
            resp.headers["Access-Control-Allow-Headers"] = "content-type, authorization, onp-offering, onp-card-revision"
            resp.headers["Access-Control-Expose-Headers"] = "onp-receipt"
            return resp

        app = web.Application(middlewares=[cors])
        app.router.add_route("OPTIONS", "/{tail:.*}", lambda r: web.Response(status=204))
        app.router.add_get("/.well-known/open-node.json", self.well_known_card)
        app.router.add_get("/.well-known/jwks.json", self.jwks)
        app.router.add_get("/.well-known/onp-challenge/{token}", self.challenge)
        app.router.add_get("/onp/health", self.health)
        app.router.add_get("/onp/receipts/{rid}", self.get_receipt)
        app.router.add_get("/v1/models", self.models)
        app.router.add_post("/v1/chat/completions", self.chat)
        app.on_startup.append(self._open_session)
        app.on_cleanup.append(self._close_session)
        return app

    async def _open_session(self, _app):
        self.session = ClientSession(timeout=ClientTimeout(total=120))

    async def _close_session(self, _app):
        if self.session:
            await self.session.close()
