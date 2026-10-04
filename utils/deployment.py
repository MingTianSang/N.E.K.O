"""Deployment flags shared by server startup and request authorization."""

import os


def is_behind_proxy() -> bool:
    """Use the same proxy flag semantics at startup and at access boundaries."""
    return os.environ.get("NEKO_BEHIND_PROXY", "").strip().lower() in ("1", "true", "yes")
