"""Instance access credentials, separate from community OAuth and CSRF.

Loopback native traffic remains compatible. Remote HTTP/WebSocket callers
authenticate with a deployment key or an expiring, host-bound browser cookie.
Proxy metadata alone never grants access. Rotating the key revokes cookies.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import html
import ipaddress
import json
import os
import secrets
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse

from utils.deployment import has_forwarding_metadata, is_behind_proxy

COOKIE = "neko_instance_access"
CHALLENGE_COOKIE = "neko_instance_challenge"
SESSION_TTL = 30 * 24 * 3600
LOGIN_PATH = "/instance-access/login"


def _key_path() -> Path:
    root = os.environ.get("NEKO_STORAGE_SELECTED_ROOT", "").strip()
    if root:
        return Path(root) / "instance_access.key"
    from utils.config_manager import get_config_manager

    return Path(get_config_manager().memory_dir).parent / "instance_access.key"


def instance_key() -> str:
    """Load one shared key; create it privately without printing credentials."""
    configured = os.environ.get("NEKO_INSTANCE_ACCESS_KEY", "").strip()
    if configured:
        if len(configured) < 32:
            raise ValueError("instance key must contain at least 32 characters")
        return configured
    path = _key_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        key = path.read_text(encoding="utf-8").strip()
    else:
        key = secrets.token_urlsafe(32)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(key)
            stream.flush()
            os.fsync(stream.fileno())
    if len(key) < 32:
        raise ValueError("instance key file is incomplete")
    return key


def _local_native(request: Request) -> bool:
    """Exempt actual local calls, never forwarded or non-loopback Host traffic."""
    remote = any(os.environ.get(name, "").strip().lower() in {"1", "true", "yes"}
                 for name in ("NEKO_ACTIVITY_TRACKER_REMOTE", "ACTIVITY_TRACKER_REMOTE"))
    if (is_behind_proxy() or remote) and has_forwarding_metadata(request.headers):
        return False
    try:
        peer = ipaddress.ip_address(request.client.host if request.client else "")
        host = request.url.hostname or ""
        host_local = host == "localhost" or ipaddress.ip_address(host).is_loopback
        return (getattr(peer, "ipv4_mapped", None) or peer).is_loopback and host_local
    except ValueError:
        return False


def _signed(key: str, purpose: str, host: str, identifier: str, expires: int) -> str:
    payload = f"{identifier}.{expires}"
    signature = hmac.new(key.encode(), f"{purpose}:{host}:{payload}".encode(), hashlib.sha256).hexdigest()
    return f"{payload}.{signature}"


def _verified(key: str, purpose: str, host: str, token: str) -> str | None:
    try:
        identifier, expiration, _signature = token.split(".")
        expires = int(expiration)
        if not identifier or not time.time() < expires <= time.time() + SESSION_TTL + 60:
            return None
        expected = _signed(key, purpose, host, identifier, expires)
        return identifier if _equal(token, expected) else None
    except (ValueError, TypeError):
        return None


def remote_instance_identity(request: Request, *, key: str | None = None) -> str | None:
    """Verify explicit remote authorization; locality is not an account grant."""
    if not _secure_transport(request):
        return None
    bearer = request.headers.get("authorization", "")
    cookie = request.cookies.get(COOKIE, "")
    if not bearer and not cookie:
        return None
    key = key or instance_key()
    if bearer.startswith("Bearer ") and _equal(bearer[7:], key):
        return "native:" + hashlib.sha256(key.encode()).hexdigest()
    if bearer.startswith("Bearer "):
        identity = _verified(key, "session", request.url.hostname or "", bearer[7:])
        if identity:
            return identity
    return _verified(key, "session", request.url.hostname or "", cookie)


def _equal(left: str, right: str) -> bool:
    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


def _secure_transport(request: Request) -> bool:
    """Allow TLS or an explicitly pinned TLS gateway with private HTTP upstreams."""
    if request.url.scheme in {"https", "wss"}:
        return True
    public = urlsplit(os.environ.get("NEKO_INSTANCE_PUBLIC_ORIGIN", "").strip())
    return bool(is_behind_proxy() and public.scheme == "https" and public.netloc
                and not public.username and not public.query and not public.fragment
                and public.path in {"", "/"} and request.headers.get("host", "") == public.netloc)


def _same_origin(request: Request) -> bool:
    """Authenticate cookies without permitting cross-site mutations."""
    origin = request.headers.get("origin", "").rstrip("/")
    expected = os.environ.get("NEKO_INSTANCE_PUBLIC_ORIGIN", "").strip().rstrip("/")
    expected = expected or str(request.base_url).rstrip("/").replace("wss://", "https://", 1).replace("ws://", "http://", 1)
    if origin:
        return origin == expected
    return request.headers.get("sec-fetch-site", "").lower() not in {"cross-site", "same-site"}


def _strings(request: Request) -> dict:
    locale = request.headers.get("accept-language", "en").split(",")[0].split(";")[0]
    choices = {"en", "ja", "ko", "zh-CN", "zh-TW", "ru", "pt", "es"}
    locale = locale if locale in choices else locale.split("-")[0]
    locale = locale if locale in choices else "en"
    path = Path(__file__).resolve().parents[1] / "static" / "locales" / f"{locale}.json"
    return json.loads(path.read_text(encoding="utf-8"))["instanceAccess"]


class InstanceAccessMiddleware:
    """Gate all service routes before body parsing, including WebSockets."""

    def __init__(self, app):
        self.app = app
        self.attempts: dict[str, tuple[float, int]] = {}

    async def __call__(self, scope, receive, send):
        if scope["type"] not in {"http", "websocket"}:
            return await self.app(scope, receive, send)
        request = Request({**scope, "type": "http", "method": scope.get("method", "GET")})
        if _local_native(request):
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        login_page = scope["type"] == "http" and (path == LOGIN_PATH or (request.method == "GET" and "text/html" in request.headers.get("accept", "")))
        if not login_page and not request.headers.get("authorization") and not request.cookies.get(COOKIE):
            return await self._deny(scope, receive, send, "instance_authorization_required", 401)
        try:
            key = await asyncio.to_thread(instance_key)
            identity = remote_instance_identity(request, key=key)
        except (OSError, ValueError):
            return await self._deny(scope, receive, send, "instance_access_unavailable", 503)
        if scope["type"] == "http" and path == LOGIN_PATH:
            return await self._login(request, key, scope, receive, send)
        if not identity:
            if scope["type"] == "http" and request.method == "GET" and "text/html" in request.headers.get("accept", ""):
                return await self._page(request, key)(scope, receive, send)
            return await self._deny(scope, receive, send, "instance_authorization_required", 401)
        oauth_callback = request.method == "GET" and path in {"/oauth/callback", "/api/card-drop/oauth/callback"}
        if not oauth_callback and not _same_origin(request):
            return await self._deny(scope, receive, send, "origin_not_allowed", 403)
        scope["neko.instance_identity"] = identity
        revoked = False
        started = False

        async def still_authorized():
            # Revalidate before each socket message or HTTP stream chunk so a
            # rotated key/expired cookie cannot leave an account stream open.
            try:
                current_key = await asyncio.to_thread(instance_key)
                return remote_instance_identity(request, key=current_key) == identity
            except (OSError, ValueError):
                return False

        async def private_send(message):
            nonlocal revoked, started
            if revoked:
                raise OSError("instance authorization revoked")
            if not await still_authorized():
                revoked = True
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 4401})
                elif started:
                    await send({"type": "http.response.body", "body": b"", "more_body": False})
                else:
                    await self._deny(scope, receive, send, "instance_authorization_required", 401)
                raise OSError("instance authorization revoked")
            if message["type"] == "http.response.start":
                started = True
                message = {**message, "headers": [(k, v) for k, v in message.get("headers", []) if k.lower() != b"cache-control"] + [(b"cache-control", b"no-store")]}
            await send(message)

        async def private_receive():
            nonlocal revoked
            message = await receive()
            if revoked:
                return ({"type": "websocket.disconnect", "code": 4401}
                        if scope["type"] == "websocket" else {"type": "http.disconnect"})
            if not await still_authorized():
                revoked = True
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 4401})
                    return {"type": "websocket.disconnect", "code": 4401}
                return {"type": "http.disconnect"}
            return message

        try:
            return await self.app(scope, private_receive, private_send)
        except OSError:
            if not revoked:
                raise

    async def _deny(self, scope, receive, send, detail, status):
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4401 if status == 401 else 4403})
        else:
            await JSONResponse({"detail": detail}, status_code=status, headers={"Cache-Control": "no-store"})(scope, receive, send)

    def _page(self, request: Request, key: str, *, failed=False):
        strings = _strings(request)
        challenge = _signed(key, "challenge", request.url.hostname or "", secrets.token_hex(16), int(time.time()) + 600)
        secure = _secure_transport(request)
        message = strings["failed"] if failed else strings["description"]
        if not secure:
            message = strings["httpsRequired"]
        response = HTMLResponse(
            '<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width">'
            f'<title>{html.escape(strings["title"])}</title><main><h1>{html.escape(strings["title"])}</h1>'
            f'<p>{html.escape(message)}</p><form method="post" action="{LOGIN_PATH}">'
            f'<input type="hidden" name="challenge" value="{challenge}">'
            f'<input type="hidden" name="return_path" value="{html.escape(request.url.path if request.url.path != LOGIN_PATH else "/", quote=True)}">'
            f'<label>{html.escape(strings["key"])} <input type="password" name="key" required autocomplete="current-password"></label>'
            f'<button {"disabled" if not secure else ""}>{html.escape(strings["connect"])}</button></form></main></html>',
            status_code=401,
            # no-referrer makes Chromium's native form POST Origin opaque
            # ("null"). same-origin retains the required own-origin signal
            # while preventing a referrer from being sent to another site.
            headers={"Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; form-action 'self'; frame-ancestors 'none'", "Referrer-Policy": "same-origin"},
        )
        response.set_cookie(CHALLENGE_COOKIE, challenge, httponly=True, secure=True, samesite="strict", max_age=600)
        return response

    async def _login(self, request, key, scope, receive, send):
        if request.method != "POST":
            return await self._page(request, key)(scope, receive, send)
        if not _secure_transport(request) or not _same_origin(request):
            return await self._deny(scope, receive, send, "secure_same_origin_required", 403)
        peer = request.client.host if request.client else "unknown"
        now = time.time()
        self.attempts = {ip: item for ip, item in self.attempts.items() if item[0] > now - 60}
        started, count = self.attempts.get(peer, (now, 0))
        if count >= 10 or len(self.attempts) >= 1024:
            return await self._deny(scope, receive, send, "instance_login_rate_limited", 429)
        self.attempts[peer] = (started, count + 1)
        data = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            data.extend(message.get("body", b""))
            if len(data) > 4096:
                return await self._deny(scope, receive, send, "instance_login_body_too_large", 413)
            if not message.get("more_body"):
                break
        fields = parse_qs(data.decode("utf-8", errors="replace"))
        challenge = fields.get("challenge", [""])[0]
        supplied = fields.get("key", [""])[0]
        valid = _verified(key, "challenge", request.url.hostname or "", challenge)
        if not valid or not _equal(challenge, request.cookies.get(CHALLENGE_COOKIE, "")) or not _equal(key, supplied):
            return await self._page(request, key, failed=True)(scope, receive, send)
        self.attempts.pop(peer, None)
        target = fields.get("return_path", ["/"])[0]
        if not target.startswith("/") or target.startswith("//") or "\\" in target or "\r" in target or "\n" in target:
            target = "/"
        response = RedirectResponse(target, status_code=303, headers={"Cache-Control": "no-store"})
        cookie = _signed(key, "session", request.url.hostname or "", secrets.token_hex(16), int(now) + SESSION_TTL)
        response.set_cookie(COOKIE, cookie, max_age=SESSION_TTL, httponly=True, secure=True, samesite="lax")
        response.delete_cookie(CHALLENGE_COOKIE, secure=True, httponly=True, samesite="strict")
        await response(scope, receive, send)


if __name__ == "__main__":
    # Explicit administrator action; never emit this credential from server logs.
    print(instance_key())
