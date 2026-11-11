"""The API has no password: only this computer's own StemTutor pages may use it."""

from __future__ import annotations

from stemtutor.server import _host_name


def test_own_pages_work(client):
    assert client.get("/api/health").status_code == 200
    r = client.put("/api/settings", json=client.get("/api/settings").json(), headers={"origin": "http://127.0.0.1:8765"})
    assert r.status_code == 200
    # the Vite dev server proxies the UI from another local port
    assert client.get("/api/lessons", headers={"origin": "http://localhost:5173", "host": "localhost:5173"}).status_code == 200


def test_dns_rebinding_host_is_refused(client):
    assert client.get("/api/lessons", headers={"host": "evil.example:8765"}).status_code == 403


def test_cross_site_writes_are_refused(client):
    r = client.post("/api/lessons", data={"mode": "auto", "url": "https://example.com/x"}, headers={"origin": "https://evil.example"})
    assert r.status_code == 403
    assert client.post("/api/lessons/x-000000/cancel", headers={"origin": "null"}).status_code == 403


def test_cross_site_reads_of_the_api_are_refused(client):
    headers = {"sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors"}
    assert client.get("/api/lessons", headers=headers).status_code == 403
    # following a link to the app from another site still opens it
    nav = {"sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate"}
    assert client.get("/", headers=nav).status_code != 403


def test_host_parsing():
    assert _host_name("127.0.0.1:8765") == "127.0.0.1"
    assert _host_name("[::1]:8765") == "::1"
    assert _host_name("LOCALHOST") == "localhost"
