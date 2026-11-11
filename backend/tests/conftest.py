from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient

from stemtutor.config import load_config
from stemtutor.server import create_app

logging.getLogger("root").setLevel(logging.ERROR)


@pytest.fixture()
def cfg(tmp_path, monkeypatch):
    monkeypatch.setenv("STEMTUTOR_FRONTEND", str(tmp_path / "no-ui"))
    return load_config(tmp_path / "data")


@pytest.fixture()
def client(cfg):
    app = create_app(cfg, synchronous_jobs=True)
    with TestClient(app, base_url="http://127.0.0.1:8765") as c:
        yield c
