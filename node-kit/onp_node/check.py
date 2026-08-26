"""NK-REG-04: client-side Stage A self-test, run before registering.
Mirrors the registry's battery so operators see failures with fixable errors first."""
from aiohttp import ClientSession, ClientTimeout


async def run_check(public_url: str) -> dict:
    public = public_url.rstrip("/")
    results = []

    def record(kind, ok, detail=None):
        results.append({"kind": kind, "ok": ok, "detail": detail})

    async with ClientSession(timeout=ClientTimeout(total=30)) as session:
        card = None
        try:
            async with session.get(f"{public}/.well-known/open-node.json") as r:
                card = await r.json()
                required = {"onp", "revision", "node", "endpoints", "offerings", "payment"}
                missing = required - set(card)
                record("card", r.status == 200 and not missing,
                       f"missing fields: {sorted(missing)}" if missing else None)
                signed = bool(card.get("signatures"))
                record("card-signed", signed, None if signed else "card carries no signatures")
        except Exception as err:  # noqa: BLE001 — report, don't crash the check
            record("card", False, str(err))

        try:
            async with session.get(f"{public}/onp/health") as r:
                body = await r.json()
                record("health", r.status == 200 and body.get("status") == "ok",
                       None if r.status == 200 else f"status {r.status}")
        except Exception as err:
            record("health", False, str(err))

        if card:
            try:
                async with session.get(f"{public}/v1/models") as r:
                    listed = {m["id"] for m in (await r.json()).get("data", [])}
                card_ids = {o["binding"]["model_id"] for o in card["offerings"]}
                missing = card_ids - listed
                record("models-agreement", not missing,
                       f"card offerings absent from /v1/models: {sorted(missing)}" if missing else None)
            except Exception as err:
                record("models-agreement", False, str(err))

            for offering in card["offerings"]:
                if offering["binding"]["profile"] != "onp.openai.chat/v1":
                    continue
                try:
                    async with session.post(
                        f"{public}/v1/chat/completions",
                        json={"model": offering["binding"]["model_id"],
                              "messages": [{"role": "user", "content": "onp-node self-test; reply briefly."}],
                              "max_tokens": 32},
                        headers={"onp-offering": f"{card['node']['id']}/{offering['offering_id']}",
                                 "onp-card-revision": card["revision"]},
                    ) as r:
                        body = await r.json()
                        usage = body.get("usage") or {}
                        ok = (r.status == 200
                              and isinstance(body.get("choices", [{}])[0].get("message", {}).get("content"), str)
                              and isinstance(usage.get("prompt_tokens"), int)
                              and isinstance(usage.get("completion_tokens"), int))
                        has_receipt = bool(r.headers.get("onp-receipt"))
                        record(f"blind-invocation:{offering['offering_id']}", ok and has_receipt,
                               None if ok and has_receipt
                               else f"status {r.status}, usage={bool(usage)}, receipt={has_receipt}")
                except Exception as err:
                    record(f"blind-invocation:{offering['offering_id']}", False, str(err))

    return {"ok": all(r["ok"] for r in results), "results": results}
