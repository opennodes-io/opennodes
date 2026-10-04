"""Card revisions stay stable across restarts unless the content changes."""
from onp_node.config import stable_revision


def card(price, revision):
    return {"onp": "0.1", "revision": revision, "node": {"id": "org.example.box"},
            "offerings": [{"offering_id": "m", "pricing": {"input_per_mtok": price}}]}


def test_same_content_keeps_revision(tmp_path):
    state = tmp_path / "rev.json"
    first = stable_revision(card(0.1, "2026-10-01T00:00:00.000Z"), state)
    again = stable_revision(card(0.1, "2026-10-02T00:00:00.000Z"), state)   # restart: new timestamp, same content
    assert again["revision"] == first["revision"] == "2026-10-01T00:00:00.000Z"


def test_changed_content_gets_new_revision(tmp_path):
    state = tmp_path / "rev.json"
    stable_revision(card(0.1, "2026-10-01T00:00:00.000Z"), state)
    repriced = stable_revision(card(0.2, "2026-10-02T00:00:00.000Z"), state)
    assert repriced["revision"] == "2026-10-02T00:00:00.000Z"
