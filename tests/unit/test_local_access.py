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
    capture_router._is_loopback_request,
    community_oauth._loopback_request_source,
    _shared._is_loopback_request,
])
@pytest.mark.parametrize("deployment", ["NEKO_BEHIND_PROXY", "NEKO_ACTIVITY_TRACKER_REMOTE", "ACTIVITY_TRACKER_REMOTE"])
def test_all_local_resource_consumers_reject_remote_deployments(check, deployment, monkeypatch):
    monkeypatch.setenv(deployment, "true")
    for headers in ({}, {"x-forwarded-for": "127.0.0.1"}, {"cf-connecting-ip": "203.0.113.9"}):
        request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"), headers=headers)
        assert check(request) is False


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
