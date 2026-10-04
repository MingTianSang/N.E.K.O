"""Deployment flags shared by server startup and request authorization."""

import os


def is_behind_proxy() -> bool:
    """Use the same proxy flag semantics at startup and at access boundaries."""
    return os.environ.get("NEKO_BEHIND_PROXY", "").strip().lower() in ("1", "true", "yes")


def uvicorn_proxy_options() -> dict:
    """Disable forwarded peers on desktop and trust loopback proxies explicitly."""
    return {
        "proxy_headers": is_behind_proxy(),
        "forwarded_allow_ips": "127.0.0.1,::1",
    }
