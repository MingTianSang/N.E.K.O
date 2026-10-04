"""HTTP/WebSocket regressions for instance ownership and remote OAuth."""

import re

import pytest
from fastapi import FastAPI, WebSocket
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

import main_routers.card_drop_router as C
import main_routers.community_oauth as O
from utils.instance_access import COOKIE, InstanceAccessMiddleware

KEY = "test-only-instance-key-" + "x" * 40


@pytest.fixture
def remote_app(monkeypatch, tmp_path):
    monkeypatch.setenv("NEKO_INSTANCE_ACCESS_KEY", KEY)
    monkeypatch.setenv("NEKO_BEHIND_PROXY", "true")
    monkeypatch.setenv("NEKO_STORAGE_SELECTED_ROOT", str(tmp_path))
    monkeypatch.setenv("NEKO_COMMUNITY_WEB_CLIENT_ID", "registered-web-client")
    monkeypatch.setenv("NEKO_COMMUNITY_WEB_REDIRECT_URI", "https://neko.example/oauth/callback")
    monkeypatch.setenv("NEKO_AUTH_URL", "https://auth.example")
    monkeypatch.setattr(O, "_oauth_pending_path", lambda: tmp_path / "pending.json")
    monkeypatch.setattr(C, "_auth_path", lambda: tmp_path / "auth.json")
    app = FastAPI()
    app.include_router(C.router)
    app.include_router(O.router)
    app.include_router(O.callback_router)

    @app.post("/private")
    async def mutation():
        return {"ok": True}

    @app.websocket("/socket")
    async def websocket(socket: WebSocket):
        await socket.accept()
        await socket.send_json({"ok": True})
        await socket.close()

    app.add_middleware(InstanceAccessMiddleware)
    wrapped = ProxyHeadersMiddleware(app, trusted_hosts="127.0.0.1,::1")
    return TestClient(wrapped, base_url="https://neko.example", client=("127.0.0.1", 50000))


def pair(client):
    page = client.get("/", headers={"Accept": "text/html"})
    assert page.status_code == 401
    assert "Content-Security-Policy" in page.headers
    challenge = re.search(r'name="challenge" value="([^"]+)"', page.text).group(1)
    response = client.post("/instance-access/login", data={"key": KEY, "challenge": challenge},
                           headers={"Origin": "https://neko.example"}, follow_redirects=False)
    assert response.status_code == 303
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "Secure" in response.headers["set-cookie"]
    return challenge


@pytest.mark.parametrize("route", ["/api/card-drop/oauth/status", "/api/card-drop/auth-status", "/private"])
def test_anonymous_cannot_query_or_mutate(remote_app, monkeypatch, route):
    async def forbidden():
        pytest.fail("Anonymous traffic must not resolve/refresh the owner's account")

    monkeypatch.setattr(O, "resolve_saved_oauth_status", forbidden)
    response = remote_app.request("POST" if route == "/private" else "GET", route,
                                  headers={"X-Forwarded-For": "127.0.0.1", "Sec-Fetch-Site": "same-origin"})
    assert response.status_code == 401
    assert response.headers["cache-control"] == "no-store"


def test_paired_account_queries_omit_backend_paths(remote_app, monkeypatch):
    pair(remote_app)

    async def status():
        return {"logged_in": True, "snapshot": {"local_user_id": "owner"},
                "auth": {"user": {"email": "owner@example.com", "phone": "secret"}}}

    monkeypatch.setattr(O, "resolve_saved_oauth_status", status)
    monkeypatch.setattr(O, "_desktop_session_paths_for_host", lambda: pytest.fail("Remote path discovery"))
    for route in ("/api/card-drop/oauth/status", "/api/card-drop/auth-status"):
        response = remote_app.get(route)
        assert response.status_code == 200
        assert response.json()["user"]["email"] == "owner@example.com"
        assert not {"session_path", "session_paths", "access_token", "refresh_token"} & response.json().keys()
        assert "phone" not in response.json()["user"]
        assert response.headers["cache-control"] == "no-store"
    assert remote_app.post("/private", headers={"Origin": "https://evil.example"}).status_code == 403


def test_cookie_reuse_and_key_rotation(remote_app, monkeypatch):
    pair(remote_app)
    assert remote_app.post("/private").status_code == 200
    cookie = remote_app.cookies.get(COOKIE)
    remote_app.cookies.set(COOKIE, cookie[:-1] + ("0" if cookie[-1] != "0" else "1"))
    assert remote_app.post("/private").status_code == 401
    remote_app.cookies.clear()
    pair(remote_app)
    monkeypatch.setenv("NEKO_INSTANCE_ACCESS_KEY", "different-instance-key-" + "z" * 40)
    assert remote_app.post("/private").status_code == 401


def test_pairing_requires_challenge_origin_and_https(remote_app):
    assert remote_app.post("/instance-access/login", data={"key": KEY}).status_code == 401
    assert remote_app.post("/instance-access/login", data={"key": KEY}, headers={"Origin": "https://evil.example"}).status_code == 403
    response = remote_app.post("http://neko.example/instance-access/login", data={"key": KEY})
    assert response.status_code == 403


def test_websocket_needs_instance_credential(remote_app):
    with pytest.raises(WebSocketDisconnect):
        with remote_app.websocket_connect("wss://neko.example/socket"):
            pass
    with remote_app.websocket_connect("wss://neko.example/socket", headers={"Authorization": f"Bearer {KEY}"}) as socket:
        assert socket.receive_json() == {"ok": True}


def test_remote_start_uses_registered_https_callback(remote_app):
    pair(remote_app)
    response = remote_app.post("/api/card-drop/oauth/start", headers={"Origin": "https://neko.example"})
    assert response.status_code == 200
    from urllib.parse import parse_qs, urlparse

    query = parse_qs(urlparse(response.json()["auth_url"]).query)
    assert query["redirect_uri"] == ["https://neko.example/oauth/callback"]
    assert query["client_id"] == ["registered-web-client"]


def test_completion_is_bound_to_attempt_and_browser(remote_app, monkeypatch):
    pair(remote_app)
    first = remote_app.post("/api/card-drop/oauth/start").json()
    pending = O.C._read_json_dict(O._oauth_pending_path())

    async def status():
        import hashlib
        return {"logged_in": True, "auth": {
            "oauth_attempt_state": hashlib.sha256(first["state"].encode()).hexdigest(),
            "oauth_attempt_identity": pending["instance_identity"],
        }}

    monkeypatch.setattr(O, "resolve_saved_oauth_status", status)
    path = "/api/card-drop/oauth/completion"
    assert remote_app.get(path, params={"state": first["state"]}).json() == {"logged_in": True}
    assert remote_app.get(path, params={"state": "different"}).json() == {"logged_in": False}
    remote_app.cookies.clear()
    pair(remote_app)
    assert remote_app.get(path, params={"state": first["state"]}).json() == {"logged_in": False}


def test_remote_default_uses_one_fixed_platform_relay(remote_app, monkeypatch):
    from urllib.parse import parse_qs, urlparse
    import base64
    import json

    monkeypatch.delenv("NEKO_COMMUNITY_WEB_REDIRECT_URI")
    monkeypatch.delenv("NEKO_COMMUNITY_WEB_CLIENT_ID")
    pair(remote_app)
    result = remote_app.post("/api/card-drop/oauth/start").json()
    query = parse_qs(urlparse(result["auth_url"]).query)
    assert query["redirect_uri"] == ["https://auth.example/oauth/callback"]
    assert query["client_id"] == ["neko-servers-web-prod"]
    assert result["relay_origin"] == "https://auth.example"
    state = result["state"]
    payload = json.loads(base64.urlsafe_b64decode(state + "=" * (-len(state) % 4)))
    assert payload["origin"] == "https://neko.example"
    assert len(payload["nonce"]) >= 40


@pytest.mark.asyncio
@pytest.mark.parametrize("socket", [False, True])
async def test_rotating_key_revokes_live_stream_before_next_account_data(monkeypatch, socket):
    monkeypatch.setenv("NEKO_INSTANCE_ACCESS_KEY", KEY)
    monkeypatch.setenv("NEKO_BEHIND_PROXY", "true")
    sent = []
    scope = {"type": "websocket" if socket else "http", "scheme": "wss" if socket else "https",
             "path": "/stream", "raw_path": b"/stream", "query_string": b"",
             "root_path": "", "method": "GET", "server": ("neko.example", 443),
             "client": ("203.0.113.1", 50000),
             "headers": [(b"host", b"neko.example"), (b"authorization", ("Bearer " + KEY).encode())]}

    async def application(scope, receive, send):
        await send({"type": "websocket.accept"} if socket else
                   {"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "websocket.send", "text": "before"} if socket else
                   {"type": "http.response.body", "body": b"before", "more_body": True})
        monkeypatch.setenv("NEKO_INSTANCE_ACCESS_KEY", "rotated-key-" + "z" * 40)
        await send({"type": "websocket.send", "text": "owner-secret"} if socket else
                   {"type": "http.response.body", "body": b"owner-secret", "more_body": True})
        pytest.fail("Revoked producer must stop")

    async def receive():
        return {"type": "websocket.connect"} if socket else {"type": "http.request", "body": b""}

    async def send(message):
        sent.append(message)

    await InstanceAccessMiddleware(application)(scope, receive, send)
    assert "owner-secret" not in str(sent)
    assert sent[-1] == ({"type": "websocket.close", "code": 4401} if socket else
                        {"type": "http.response.body", "body": b"", "more_body": False})


def test_anonymous_api_does_not_touch_private_credential_storage(remote_app, monkeypatch):
    import utils.instance_access as access

    monkeypatch.setattr(access, "instance_key", lambda: pytest.fail("Anonymous credential file IO"))
    assert remote_app.post("/private", content=b"not-json").status_code == 401


def test_real_streaming_response_closes_on_key_rotation(monkeypatch):
    from starlette.responses import StreamingResponse

    monkeypatch.setenv("NEKO_INSTANCE_ACCESS_KEY", KEY)
    monkeypatch.setenv("NEKO_BEHIND_PROXY", "true")
    app = FastAPI()

    @app.get("/stream")
    async def stream():
        async def chunks():
            yield b"before"
            monkeypatch.setenv("NEKO_INSTANCE_ACCESS_KEY", "new-key-" + "x" * 40)
            yield b"secret"
        return StreamingResponse(chunks())

    app.add_middleware(InstanceAccessMiddleware)
    client = TestClient(app, base_url="https://instance.example")
    response = client.get("/stream", headers={"Authorization": "Bearer " + KEY})
    assert response.text == "before"


def test_docker_host_browser_pairs_even_without_forwarding_headers(monkeypatch):
    monkeypatch.setenv("NEKO_BEHIND_PROXY", "true")
    monkeypatch.setenv("NEKO_INSTANCE_ACCESS_KEY", KEY)
    app = FastAPI()

    @app.get("/")
    async def home():
        return {"ok": True}

    app.add_middleware(InstanceAccessMiddleware)
    client = TestClient(app, base_url="https://127.0.0.1", client=("127.0.0.1", 50000))
    page = client.get("/", headers={"Accept": "text/html"})
    assert page.status_code == 401
    challenge = re.search(r'name="challenge" value="([^"]+)"', page.text).group(1)
    connected = client.post("/instance-access/login", data={"key": KEY, "challenge": challenge},
                            headers={"Origin": "https://127.0.0.1"}, follow_redirects=False)
    assert connected.status_code == 303
    assert client.get("/", headers={"Sec-Fetch-Site": "same-origin"}).json() == {"ok": True}
