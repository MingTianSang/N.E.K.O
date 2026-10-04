"""Regression coverage for the local resource access boundary."""

from types import SimpleNamespace

import pytest

from main_routers import capture_router, community_oauth
from main_routers.system_router import _shared


@pytest.fixture(autouse=True)
def local_deployment(monkeypatch):
    for key in ("NEKO_BEHIND_PROXY", "NEKO_ACTIVITY_TRACKER_REMOTE", "ACTIVITY_TRACKER_REMOTE"):
        monkeypatch.delenv(key, raising=False)


@pytest.mark.unit
@pytest.mark.parametrize("check", [
    community_oauth._loopback_request_source,
])
@pytest.mark.parametrize("deployment", ["NEKO_BEHIND_PROXY", "NEKO_ACTIVITY_TRACKER_REMOTE", "ACTIVITY_TRACKER_REMOTE"])
def test_oauth_status_rejects_remote_deployments(check, deployment, monkeypatch):
    monkeypatch.setenv(deployment, "true")
    for headers in ({}, {"x-forwarded-for": "127.0.0.1"}, {"cf-connecting-ip": "203.0.113.9"}):
        request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"), headers=headers)
        assert check(request) is False


@pytest.mark.unit
@pytest.mark.parametrize("check", [capture_router._is_loopback_request, _shared._is_loopback_request])
@pytest.mark.parametrize("deployment", ["NEKO_BEHIND_PROXY", "NEKO_ACTIVITY_TRACKER_REMOTE", "ACTIVITY_TRACKER_REMOTE"])
def test_other_consumers_preserve_loopback_access_in_remote_deployments(check, deployment, monkeypatch):
    monkeypatch.setenv(deployment, "true")
    assert check(SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))) is True
    assert check(SimpleNamespace(client=SimpleNamespace(host="203.0.113.9"))) is False


@pytest.mark.unit
@pytest.mark.parametrize("deployment", ["NEKO_BEHIND_PROXY", "NEKO_ACTIVITY_TRACKER_REMOTE"])
def test_avatar_upload_preflight_and_route_share_peer_policy(deployment, monkeypatch):
    from app.main_server import _avatar_tool_multipart_preflight
    from fastapi import HTTPException, Request
    from main_routers.cookies_login_router import verify_local_access

    monkeypatch.setenv(deployment, "true")
    # Isolate peer authorization from the independently tested CSRF gate.
    monkeypatch.setattr(_shared, "_validate_local_mutation_request", lambda _request: None)
    scope = {"type": "http", "headers": [], "client": ("127.0.0.1", 50000)}
    assert _avatar_tool_multipart_preflight(scope) is None
    verify_local_access(Request(scope))
    scope["client"] = ("203.0.113.9", 50000)
    assert _avatar_tool_multipart_preflight(scope).status_code == 403
    with pytest.raises(HTTPException):
        verify_local_access(Request(scope))


@pytest.mark.unit
@pytest.mark.parametrize("host", ["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1", "::ffff:7f00:1"])
def test_desktop_mode_uses_peer_address_even_with_local_proxy_headers(host):
    request = SimpleNamespace(client=SimpleNamespace(host=host), headers={"x-forwarded-for": "203.0.113.9"})
    assert community_oauth._loopback_request_source(request) is True


@pytest.mark.unit
@pytest.mark.parametrize("host", ["203.0.113.9", "::ffff:203.0.113.9", "invalid", ""])
def test_nonlocal_peers_cannot_spoof_local_access(host):
    request = SimpleNamespace(client=SimpleNamespace(host=host), headers={"x-forwarded-for": "127.0.0.1"})
    assert community_oauth._loopback_request_source(request) is False
