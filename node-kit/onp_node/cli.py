"""onp-node CLI: init | serve | check | register | card  (REQ-003 subset)."""
import argparse
import asyncio
import json
import os
import sys
import time
from urllib.parse import urlparse
from pathlib import Path

from aiohttp import web, ClientSession, ClientTimeout

from .config import DEFAULT_CONFIG, load_config, build_card, stable_revision
from .check import run_check
from .jws import generate_private_key, private_key_to_pem, private_key_from_pem, sign_card, public_jwk
from .server import NodeKitServer

CONFIG = Path("onp-node.toml")
KEYFILE = Path("onp-node-key.pem")
CHALLENGE = Path("onp-node-challenge.txt")
REVISION_STATE = Path("onp-node-revision.json")


async def interrogate_engine(base_url: str, key: str | None = None) -> list[str]:
    headers = {"authorization": f"Bearer {key}"} if key else {}
    async with ClientSession(timeout=ClientTimeout(total=15)) as session:
        async with session.get(f"{base_url.rstrip('/')}/models", headers=headers) as r:
            if r.status != 200:
                raise SystemExit(f"engine /models returned {r.status} — is the engine running at {base_url}?")
            return [m["id"] for m in (await r.json()).get("data", [])]


def namespace_ok(node_id: str, public_url: str) -> bool:
    """A registry only accepts a card served by a host that controls the node id (reverse-DNS):
    the host itself or a parent domain. ai.example.org may serve org.example.ai[.anything]."""
    from urllib.parse import urlparse
    host = (urlparse(public_url).hostname or "").lower().rstrip(".")
    domain = ".".join(reversed(node_id.lower().split(".")))
    if host in ("localhost", "::1") or host.startswith(("127.", "10.", "192.168.")) or "." not in host:
        return True   # LAN / dev: registries in dev mode accept these
    return domain == host or domain.endswith("." + host)


def _suggest_id(public_url: str) -> str:
    from urllib.parse import urlparse
    return ".".join(reversed((urlparse(public_url).hostname or "example.org").lower().split(".")))


def cmd_init(args):
    if not namespace_ok(args.id, args.public_url):
        print(f"warning: node id {args.id} does not match {args.public_url} - public registries will refuse it. "
              f"Use the reverse of the host, e.g. --id {_suggest_id(args.public_url)}", file=sys.stderr)
    if CONFIG.exists() and not args.force:
        raise SystemExit(f"{CONFIG} exists (use --force to overwrite)")
    models = asyncio.run(interrogate_engine(args.engine, os.environ.get("ONP_ENGINE_KEY")))
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
    card = stable_revision(build_card(cfg, models), REVISION_STATE)
    return NodeKitServer(card, key, cfg["engine"]["base_url"], challenge_file=CHALLENGE), cfg


def _advertise_mdns(node_id: str, public_url: str, port: int):
    """Announce this node as _onp._tcp on the LAN so `onp-ollama` and other ONP clients find it.
    Optional dependency: pip install 'onp-node[mdns]'."""
    try:
        import socket
        from zeroconf import ServiceInfo, Zeroconf
    except ImportError:
        print("mdns: zeroconf not installed — pip install 'onp-node[mdns]'", file=sys.stderr)
        return None
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
    except OSError:
        ip = "127.0.0.1"
    finally:
        s.close()
    info = ServiceInfo(
        "_onp._tcp.local.", f"{node_id}._onp._tcp.local.",
        addresses=[socket.inet_aton(ip)], port=port,
        properties={"origin": public_url.rstrip("/"), "onp": "0.1"},
        server=f"{node_id.replace('.', '-')}.local.",
    )
    zc = Zeroconf()
    zc.register_service(info)
    print(f"mdns: advertising {node_id} as _onp._tcp at {ip}:{port}")
    return zc


def cmd_serve(args):
    server, cfg = make_server()
    port = args.port or int(cfg["node"]["public_url"].rsplit(":", 1)[-1].split("/")[0])
    print(f"onp-node serving {len(server.offering_by_model)} offering(s) on port {port}")
    print(f"card: {cfg['node']['public_url'].rstrip('/')}/.well-known/open-node.json")
    zc = _advertise_mdns(cfg["node"]["id"], cfg["node"]["public_url"], port) if args.mdns else None
    try:
        web.run_app(server.build_app(), host=args.host, port=port, print=None)
    finally:
        if zc is not None:
            zc.unregister_all_services()
            zc.close()


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
    probe_key = os.environ.get(args.probe_key_env) if args.probe_key_env else None
    if args.probe_key_env and not probe_key:
        raise SystemExit(f"environment variable {args.probe_key_env} is empty")
    if args.card_url:   # card-only listing: the card is a static file on the operator's own domain
        node_id = load_config(CONFIG)["node"]["id"] if CONFIG.exists() else None
        if node_id and not namespace_ok(node_id, args.card_url) and not args.force:
            raise SystemExit(f"node id {node_id} does not match {args.card_url}; the card must be served from the host the id names.")
        verify = asyncio.run(_register_static(args.registry, args.card_url, probe_key, args.wait))
        print(f"registered: state={verify['state']}, signature_verified={verify.get('signature_verified')}, "
              f"stage_a_ok={verify.get('stage_a', {}).get('ok')}, claimed_imports={verify.get('claimed_imports')}")
        return
    _cfg = load_config(CONFIG)
    if not namespace_ok(_cfg["node"]["id"], _cfg["node"]["public_url"]) and not args.force:
        raise SystemExit(f"node id {_cfg['node']['id']} does not match host {_cfg['node']['public_url']}: registries accept a card only "
                         f"from the host the id names (or a parent domain). Set id = \"{_suggest_id(_cfg['node']['public_url'])}\" in "
                         f"{CONFIG}, or prove the namespace by DNS TXT and re-run with --force.")
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


# ---------------------------------------------------------------- card-only listing
# For operators who already run an OpenAI-compatible API and will not put a proxy in front of
# it: the kit signs a Node Card once; the operator hosts it (and the JWKS) as static files on
# their own domain, and registries probe their real API with a probe key they provide.

def make_static_card(cfg: dict, models: list[str], api_base: str, health_url: str | None,
                     signup: str | None, key, state_path: Path) -> tuple[dict, dict]:
    card = build_card(cfg, models)
    base = api_base.rstrip("/")
    card["endpoints"] = {"openai": base, "health": health_url or f"{base}/models"}
    if signup:
        card["payment"]["schemes"] = [
            ({"scheme": "prepaid", "signup": signup} if s.get("scheme") == "prepaid" else s)
            for s in card["payment"]["schemes"]]
    card = stable_revision(card, state_path)
    return sign_card(card, key), {"keys": [public_jwk(key)]}


def cmd_card(args):
    cfg = load_config(CONFIG)
    key = private_key_from_pem(KEYFILE.read_text(encoding="utf-8"))
    api_base = args.api_base or cfg["engine"]["base_url"]
    engine_key = os.environ.get(args.engine_key_env) if args.engine_key_env else None
    models = asyncio.run(interrogate_engine(api_base, engine_key))
    include = cfg["engine"].get("models")
    if include:
        missing = [m for m in include if m not in models]
        if missing:
            raise SystemExit(f"config lists models the API does not serve: {missing}")
        models = [m for m in models if m in include]
    card, jwks = make_static_card(cfg, models, api_base, args.health, args.signup, key, REVISION_STATE)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "open-node.json").write_text(json.dumps(card, indent=2), encoding="utf-8")
    (out / "jwks.json").write_text(json.dumps(jwks, indent=2), encoding="utf-8")
    host = cfg["node"]["public_url"].rstrip("/")
    print(f"signed card for {len(card['offerings'])} offering(s), revision {card['revision']}")
    print(f"publish both files as static JSON on the host the node id names:")
    print(f"  {host}/.well-known/open-node.json   <- {out / 'open-node.json'}")
    print(f"  {host}/.well-known/jwks.json        <- {out / 'jwks.json'}")
    print("then register (the probe key lets the registry call your API for its checks; it is never shown publicly):")
    print(f"  onp-node register https://registry.opennodes.io --card-url {host}/.well-known/open-node.json --probe-key-env ONP_PROBE_KEY")


async def _register_static(registry: str, card_url: str, probe_key: str | None, wait_s: int):
    body = {"card_url": card_url, **({"probe_key": probe_key} if probe_key else {})}
    async with ClientSession(timeout=ClientTimeout(total=120)) as session:
        async with session.post(f"{registry.rstrip('/')}/v0/nodes", json=body) as r:
            reg = await r.json()
            if r.status not in (200, 202):
                raise SystemExit(f"registration rejected: {json.dumps(reg)}")
        token = reg["challenge"]["token"]
        origin = f"{urlparse(card_url).scheme}://{urlparse(card_url).netloc}"
        print("prove you control the namespace — either one is enough:", flush=True)
        print(f"  HTTP: serve the text {token} at {origin}/.well-known/onp-challenge/{token}", flush=True)
        print(f"  DNS:  {reg['challenge']['methods'].get('dns', 'n/a')}", flush=True)
        deadline = time.time() + wait_s
        while True:
            async with session.post(f"{registry.rstrip('/')}{reg['challenge']['verify']}") as r:
                verify = await r.json()
                if r.status == 200:
                    return verify
                if r.status != 403 or time.time() > deadline:
                    raise SystemExit(f"verification not completed: {json.dumps(verify)}")
            print("  waiting for the challenge to appear …", flush=True)
            await asyncio.sleep(20)


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
    sp.add_argument("--mdns", action="store_true", help="advertise this node on the LAN as _onp._tcp (needs onp-node[mdns])")
    sp.set_defaults(fn=cmd_serve)

    sp = sub.add_parser("check", help="run the Stage A self-test against this node")
    sp.add_argument("--url")
    sp.set_defaults(fn=cmd_check)

    sp = sub.add_parser("register", help="self-test, then register with a registry (HTTP challenge auto-served)")
    sp.add_argument("registry", help="registry origin, e.g. https://registry.opennodes.io")
    sp.add_argument("--force", action="store_true", help="register even if the self-test fails")
    sp.add_argument("--card-url", help="card-only listing: URL of your static open-node.json (skips the local kit)")
    sp.add_argument("--probe-key-env", help="name of an env var holding an API key the registry may use for its checks")
    sp.add_argument("--wait", type=int, default=1800, help="card-only: seconds to wait for the challenge (default 1800)")
    sp.set_defaults(fn=cmd_register)

    sp = sub.add_parser("card", help="card-only listing: sign a static Node Card for an API you already run")
    sp.add_argument("--api-base", help="your OpenAI-compatible base URL (default: [engine] base_url)")
    sp.add_argument("--health", help="health URL (default: <api-base>/models)")
    sp.add_argument("--signup", help="where customers get an API key (prepaid scheme)")
    sp.add_argument("--engine-key-env", default="ONP_ENGINE_KEY", help="env var with a key to list your models (default ONP_ENGINE_KEY)")
    sp.add_argument("--out", default="well-known", help="output directory (default ./well-known)")
    sp.set_defaults(fn=cmd_card)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
