"""Access checks for APIs that expose resources on the backend machine."""

import ipaddress
import os

from fastapi import Request

from main_logic.activity.system_signals import is_remote_backend_deployment


def is_loopback_request(request: Request) -> bool:
    """Check the request peer address without imposing deployment policy."""
    client_host = request.client.host if request.client else ""
    if client_host == "localhost":
        return True
    try:
        address = ipaddress.ip_address(str(client_host or ""))
    except ValueError:
        return False
    mapped = getattr(address, "ipv4_mapped", None)
    return (mapped or address).is_loopback


def is_local_oauth_status_request(request: Request) -> bool:
    """Protect account metadata in proxy and remote deployments.

    Proxy mode can replace the peer address with an untrusted forwarded value.
    TCP tunnels cannot be detected from HTTP metadata; remote deployments must
    explicitly enable NEKO_BEHIND_PROXY or NEKO_ACTIVITY_TRACKER_REMOTE.
    In desktop mode proxy headers are disabled, so the peer address is trusted.
    """
    if os.environ.get("NEKO_BEHIND_PROXY", "").strip().lower() in ("1", "true", "yes"):
        return False
    return not is_remote_backend_deployment() and is_loopback_request(request)
