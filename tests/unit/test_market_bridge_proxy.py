from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from fastapi import Request
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.main_server import web_app


@pytest.mark.asyncio
async def test_market_proxy_preserves_query_token_and_authorization(monkeypatch):
    from utils.instance_access import _verified

    key = "market-test-instance-key-" + "x" * 40
    monkeypatch.setenv("NEKO_INSTANCE_ACCESS_KEY", key)
    monkeypatch.delenv("NEKO_BEHIND_PROXY", raising=False)
    monkeypatch.delenv("NEKO_ACTIVITY_TRACKER_REMOTE", raising=False)
    monkeypatch.delenv("ACTIVITY_TRACKER_REMOTE", raising=False)
    seen: dict[str, object] = {}
    asgi_client = httpx.AsyncClient

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def request(self, method, url, *, content, headers):
            seen.update(method=method, url=url, content=content, headers=headers)
            return httpx.Response(200, content=b"{}", headers={"content-type": "application/json"})

    monkeypatch.setattr(web_app, "_resolve_user_plugin_base", lambda: "http://127.0.0.1:48916")
    monkeypatch.setattr(web_app.httpx, "AsyncClient", lambda **_kwargs: FakeClient())

    app = FastAPI()
    app.add_api_route(
        "/market/{path:path}",
        web_app.proxy_user_plugin_market_bridge,
        methods=["POST"],
    )
    async with asgi_client(
        transport=httpx.ASGITransport(app=app),
        base_url="http://127.0.0.1:48911",
    ) as client:
        response = await client.post(
            "/market/oauth/start?token=query-token",
            headers={"Authorization": "Bearer header-token", "Origin": "http://localhost:48911"},
            content=b"{}",
        )

    assert response.status_code == 200
    assert seen["method"] == "POST"
    assert seen["url"] == "http://127.0.0.1:48916/market/oauth/start?token=query-token"
    assert seen["content"] == b"{}"
    forwarded_headers = seen["headers"]
    assert isinstance(forwarded_headers, dict)
    assert forwarded_headers["authorization"] == "Bearer header-token"
    assert forwarded_headers["origin"] == "http://localhost:48911"
    assert _verified(key, "market-internal", "POST:/market/oauth/start",
                     forwarded_headers["x-neko-market-internal"]) == "market"


@pytest.mark.asyncio
async def test_remote_market_handoff_survives_plugin_proxy_headers(monkeypatch):
    """Exercise both Uvicorn hops with a public cookie and external XFF."""
    import time
    from utils.instance_access import COOKIE, InstanceAccessMiddleware, _signed

    key = "market-remote-instance-key-" + "x" * 40
    monkeypatch.setenv("NEKO_INSTANCE_ACCESS_KEY", key)
    monkeypatch.setenv("NEKO_BEHIND_PROXY", "true")
    monkeypatch.delenv("NEKO_INSTANCE_PUBLIC_ORIGIN", raising=False)
    client_class = httpx.AsyncClient
    plugin = FastAPI()

    @plugin.post("/market/oauth/start")
    async def market(request: Request):
        return {"peer": request.client.host, "authorization": request.headers.get("authorization"),
                "origin": request.headers.get("origin"),
                "xff": request.headers.get("x-forwarded-for"),
                "identity": request.scope.get("neko.instance_identity")}

    plugin.add_middleware(InstanceAccessMiddleware)
    plugin_hop = ProxyHeadersMiddleware(plugin, trusted_hosts="127.0.0.1,::1")

    def upstream_client(**kwargs):
        return client_class(transport=httpx.ASGITransport(app=plugin_hop, client=("127.0.0.1", 50000)),
                            **kwargs)

    monkeypatch.setattr(web_app.httpx, "AsyncClient", upstream_client)
    monkeypatch.setattr(web_app, "_resolve_user_plugin_base", lambda: "http://127.0.0.1:48916")
    main = FastAPI()
    main.add_api_route("/market/{path:path}", web_app.proxy_user_plugin_market_bridge, methods=["POST"])
    main.add_middleware(InstanceAccessMiddleware)
    main_hop = ProxyHeadersMiddleware(main, trusted_hosts="127.0.0.1,::1")
    cookie = _signed(key, "session", "public.example", "owner-session", int(time.time()) + 600)
    async with client_class(transport=httpx.ASGITransport(app=main_hop, client=("127.0.0.1", 40000)),
                            base_url="https://public.example") as client:
        response = await client.post("/market/oauth/start", headers={
            "Cookie": COOKIE + "=" + cookie, "Authorization": "Bearer market-oauth-token",
            "Origin": "https://public.example", "Sec-Fetch-Site": "same-origin",
            "X-Forwarded-For": "203.0.113.20", "X-Real-IP": "203.0.113.20",
            "Forwarded": "for=203.0.113.20", "X-Forwarded-Proto": "https",
            "X-Neko-Market-Internal": "caller-forged-proof",
        }, content=b"{}")
    assert response.status_code == 200
    assert response.json() == {"peer": "127.0.0.1", "authorization": "Bearer market-oauth-token",
                               "origin": "https://public.example", "xff": None, "identity": "market"}
