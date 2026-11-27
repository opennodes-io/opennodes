"""Key handling (review 4.2): the key file is owner-only, a wider mode is narrowed; only EdDSA verifies (ONP-2 §8)."""
import os
import stat

import pytest

from onp_node.cli import write_private_key, read_private_key, KEY_MODE
from onp_node.jws import generate_private_key, private_key_to_pem

posix = pytest.mark.skipif(os.name == "nt", reason="POSIX mode bits; on Windows the file inherits the folder's ACL")


def _pem():
    return private_key_to_pem(generate_private_key())


@posix
def test_new_key_is_0600_even_with_a_permissive_umask(tmp_path):
    old = os.umask(0o000)
    try:
        path = tmp_path / "k.pem"
        write_private_key(path, _pem())
    finally:
        os.umask(old)
    assert stat.S_IMODE(path.stat().st_mode) == KEY_MODE


def test_an_existing_key_is_never_overwritten(tmp_path):
    path = tmp_path / "k.pem"
    write_private_key(path, _pem())
    before = path.read_bytes()
    with pytest.raises(FileExistsError):
        write_private_key(path, _pem())
    assert path.read_bytes() == before
    assert read_private_key(path) is not None


@posix
def test_a_world_readable_key_is_narrowed_on_load(tmp_path, capsys):
    path = tmp_path / "k.pem"
    path.write_text(_pem(), encoding="utf-8")
    os.chmod(path, 0o644)
    read_private_key(path)
    assert stat.S_IMODE(path.stat().st_mode) == KEY_MODE
    assert "readable by others" in capsys.readouterr().err


@posix
def test_a_key_that_cannot_be_narrowed_still_loads(tmp_path, capsys, monkeypatch):
    path = tmp_path / "k.pem"
    path.write_text(_pem(), encoding="utf-8")
    os.chmod(path, 0o644)

    def refuse(*_a, **_k):
        raise PermissionError(1, "Operation not permitted")
    monkeypatch.setattr(os, "chmod", refuse)
    assert read_private_key(path) is not None
    assert "could not narrow it" in capsys.readouterr().err


def test_verify_jws_refuses_any_alg_but_eddsa():
    import base64
    import json as _json
    from onp_node.jws import sign_json, verify_jws, public_jwk
    key = generate_private_key()
    jwk = public_jwk(key)
    assert verify_jws(sign_json({"a": 1}, key), jwk) == {"a": 1}
    b64 = lambda v: base64.urlsafe_b64encode(_json.dumps(v).encode()).rstrip(b"=").decode()
    for alg in ("none", "HS256"):
        with pytest.raises(ValueError, match="not allowed"):
            verify_jws(f"{b64({'alg': alg})}.{b64({'a': 1})}.", jwk)
