"""onp-node CLI: init | serve | check | register  (REQ-003 subset)."""
import argparse
import asyncio
import json
import sys
from pathlib import Path

from aiohttp import web, ClientSession, ClientTimeout

from .config import DEFAULT_CONFIG, load_config, build_card
from .check import run_check
from .jws import generate_private_key, private_key_to_pem, private_key_from_pem
from .server import NodeKitServer

CONFIG = Path("onp-node.toml")
KEYFILE = Path("onp-node-key.pem")
CHALLENGE = Path("onp-node-challenge.txt")


async def interrogate_engine(base_url: str) -> list[str]:
    async with ClientSession(timeout=ClientTimeout(total=15)) as session:
        async with session.get(f"{base_url.rstrip('/')}/models") as r:
            if r.status != 200:
                raise SystemExit(f"engine /models returned {r.status} — is the engine running at {base_url}?")
            return [m["id"] for m in (await r.json()).get("data", [])]


def cmd_init(args):
    if CONFIG.exists() and not args.force:
        raise SystemExit(f"{CONFIG} exists (use --force to overwrite)")
    models = asyncio.run(interrogate_engine(args.engine))
    if not models:
        raise SystemExit("engine lists no models")
    CONFIG.write_text(DEFAULT_CONFIG.format(
        node_id=args.id, name=args.name or args.id, public_url=args.public_url,
        operator=args.operator or args.name or args.id, engine_base=args.engine,
    ), encoding="utf-8")
    if not KEYFILE.exists():
        KEYFILE.write_text(private_key_to_pem(generate_private_key()), encoding="utf-8")
    print(f"engine models: {', '.join(models)}")
    print(f"wrote {CONFIG} and {KEYFILE} — review pricing/data_policy, then: onp-node serve")


def make_server() -> tuple[NodeKitServer, dict]:
    cfg = load_config(CONFIG)
    key = private_key_from_pem(KEYFILE.read_text(encoding="utf-8"))
    models = asyncio.run(interrogate_engine(cfg["engine"]["base_url"]))
    include = cfg["engine"].get("models")  # optional allowlist: offer only these engine models
    if include:
        missing = [m for m in include if m not in models]
        if missing:
            raise SystemExit(f"config lists models the engine does not serve: {missing}")
        models = [m for m in models if m in include]
    card = build_card(cfg, models)
    return NodeKitServer(card, key, cfg["engine"]["base_url"], challenge_file=CHALLENGE), cfg


def cmd_serve(args):
    server, cfg = make_server()
    port = args.port or int(cfg["node"]["public_url"].rsplit(":", 1)[-1].split("/")[0])
    print(f"onp-node serving {len(server.offering_by_model)} offering(s) on port {port}")
    print(f"card: {cfg['node']['public_url'].rstrip('/')}/.well-known/open-node.json")
    web.run_app(server.build_app(), host=args.host, port=port, print=None)


def cmd_check(args):
    cfg = load_config(CONFIG)
    report = asyncio.run(run_check(args.url or cfg["node"]["public_url"]))
    for r in report["results"]:
        mark = "ok " if r["ok"] else "FAIL"
        print(f"  [{mark}] {r['kind']}" + (f" — {r['detail']}" if r["detail"] else ""))
    print("self-test:", "PASS" if report["ok"] else "FAIL")
    if not report["ok"]:
        sys.exit(1)


async def _register(registry: str, card_url: str):
    async with ClientSession(timeout=ClientTimeout(total=60)) as session:
        async with session.post(f"{registry.rstrip('/')}/v0/nodes", json={"card_url": card_url}) as r:
            reg = await r.json()
            if r.status not in (200, 202):
                raise SystemExit(f"registration rejected: {json.dumps(reg)}")
        token = reg["challenge"]["token"]
        CHALLENGE.write_text(token, encoding="utf-8")  # kit serves the HTTP challenge itself
        print(f"challenge token staged at {CHALLENGE} (HTTP method; DNS TXT alternative: "
              f"{reg['challenge']['methods'].get('dns', 'n/a')})")
        async with session.post(f"{registry.rstrip('/')}{reg['challenge']['verify']}") as r:
            verify = await r.json()
            if r.status != 200:
                raise SystemExit(f"verification failed: {json.dumps(verify)}")
        return verify


def cmd_register(args):
    cfg = load_config(CONFIG)
    report = asyncio.run(run_check(cfg["node"]["public_url"]))
    if not report["ok"] and not args.force:
        for r in report["results"]:
            if not r["ok"]:
                print(f"  [FAIL] {r['kind']} — {r['detail']}")
        raise SystemExit("self-test failed; fix the above or use --force (NK-REG-04)")
    card_url = f"{cfg['node']['public_url'].rstrip('/')}/.well-known/open-node.json"
    verify = asyncio.run(_register(args.registry, card_url))
    print(f"registered: state={verify['state']}, signature_verified={verify.get('signature_verified')}, "
          f"stage_a_ok={verify.get('stage_a', {}).get('ok')}")


def main():
    p = argparse.ArgumentParser(prog="onp-node", description="OpenNodes Node Kit")
    sub = p.add_subparsers(dest="cmd", required=True)

    sp = sub.add_parser("init", help="interrogate the engine and write onp-node.toml + signing key")
    sp.add_argument("--engine", required=True, help="engine OpenAI base URL, e.g. http://127.0.0.1:8000/v1")
    sp.add_argument("--id", required=True, help="reverse-DNS node id, e.g. org.example.cluster1")
    sp.add_argument("--public-url", required=True, help="public origin of this kit, e.g. https://ai.example.org")
    sp.add_argument("--name")
    sp.add_argument("--operator")
    sp.add_argument("--force", action="store_true")
    sp.set_defaults(fn=cmd_init)

    sp = sub.add_parser("serve", help="serve the card + proxy in front of the engine")
    sp.add_argument("--host", default="0.0.0.0")
    sp.add_argument("--port", type=int)
    sp.set_defaults(fn=cmd_serve)

    sp = sub.add_parser("check", help="run the Stage A self-test against this node")
    sp.add_argument("--url")
    sp.set_defaults(fn=cmd_check)

    sp = sub.add_parser("register", help="self-test, then register with a registry (HTTP challenge auto-served)")
    sp.add_argument("registry", help="registry origin, e.g. https://registry.opennodes.org")
    sp.add_argument("--force", action="store_true", help="register even if the self-test fails")
    sp.set_defaults(fn=cmd_register)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
