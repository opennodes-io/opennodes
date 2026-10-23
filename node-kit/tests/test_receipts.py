"""Receipts: bounded in memory, appended to a file, reloaded after a restart."""
import base64
import json
import tomllib

from onp_node.config import DEFAULT_CONFIG, build_card
from onp_node.jws import generate_private_key
from onp_node.server import NodeKitServer, ReceiptStore


def _card():
    cfg = tomllib.loads(DEFAULT_CONFIG.format(engine_base="http://127.0.0.1:11434/v1", node_id="org.example.ai",
                                               public_url="https://ai.example.org", name="Example", operator="Example"))
    return build_card(cfg, ["llama3.2:1b"])


def _payload(jws):
    body = jws.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))


def test_memory_keeps_only_the_newest():
    store = ReceiptStore(keep=3)
    for i in range(5):
        store.add(f"r_{i}", f"jws{i}")
    assert len(store) == 3
    assert store.get("r_0") is None and store.get("r_1") is None
    assert store.get("r_4") == "jws4"


def test_file_is_the_audit_trail_and_survives_restart(tmp_path):
    path = tmp_path / "onp-receipts.jsonl"
    store = ReceiptStore(keep=2, path=path)
    for i in range(4):
        store.add(f"r_{i}", f"jws{i}")
    assert len(path.read_text(encoding="utf-8").splitlines()) == 4   # file keeps everything
    with path.open("a", encoding="utf-8") as f:
        f.write('{"receipt_id": "r_torn", "jw')                       # crash mid-write
    reloaded = ReceiptStore(keep=2, path=path)
    assert reloaded.get("r_3") == "jws3" and reloaded.get("r_1") is None


def test_receipt_id_inside_matches_the_announced_one(tmp_path):
    server = NodeKitServer(_card(), generate_private_key(), "http://127.0.0.1:11434/v1",
                           receipts_file=tmp_path / "r.jsonl")
    offering = server.card["offerings"][0]
    usage = {"prompt_tokens": 3, "completion_tokens": 2, "total_tokens": 5}
    rid, jws = server._make_receipt(offering, usage, b"{}", None, receipt_id="r_announced")
    assert rid == "r_announced" and server.receipts.get("r_announced") == jws
    assert _payload(jws)["receipt_id"] == "r_announced"


def test_default_config_persists_receipts():
    cfg = tomllib.loads(DEFAULT_CONFIG.format(engine_base="x", node_id="a.b", public_url="https://b.a",
                                               name="n", operator="o"))
    assert cfg["receipts"] == {"file": "onp-receipts.jsonl", "keep": 50000}
