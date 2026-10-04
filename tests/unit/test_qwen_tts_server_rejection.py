"""Qwen realtime TTS must surface server rejections instead of going silent.

DashScope refuses an account-level problem (arrears) *after* a successful
handshake: it closes the WebSocket with 1007 + "…account is in good standing"
and sends no error event. The worker had already reported "ready", and the
close was swallowed by ``except ConnectionClosed: pass`` — leaving the user
with subtitles and no audio, and the log with nothing at all.
"""

import asyncio
import json
import queue
import threading
import time

import websockets
from websockets.frames import Close

from main_logic.tts_client._infra import TTS_SHUTDOWN_SENTINEL
from main_logic.tts_client.workers import qwen as qwen_mod
from main_logic.tts_client.workers.qwen import (
    _server_rejection_payload,
    qwen_realtime_tts_worker,
)

_ARREARS_REASON = "Access denied, please make sure your account is in good standing."
_TEXT = "你好呀，今天过得怎么样？"


def _closed_exc(code, reason):
    return websockets.exceptions.ConnectionClosedError(Close(code, reason), None)


def test_rejection_payload_maps_arrears_close():
    payload = _server_rejection_payload(_closed_exc(1007, _ARREARS_REASON))
    assert payload["data"]["close_code"] == 1007
    assert _ARREARS_REASON in payload["data"]["message"]
    # 不带顶层 code：由 core 的关键词分类决定是 API_ARREARS 还是别的，
    # worker 不自己复制一套判定。
    assert "code" not in payload


def test_rejection_payload_stays_quiet_on_ordinary_closes():
    assert _server_rejection_payload(_closed_exc(1000, "")) is None
    assert _server_rejection_payload(_closed_exc(1001, "bye")) is None
    # 我们自己关的 / 网络断链：没有 rcvd，留给既有重连路径。
    assert _server_rejection_payload(
        websockets.exceptions.ConnectionClosedError(None, None)
    ) is None


def test_rejection_payload_synthesizes_reason_when_empty():
    payload = _server_rejection_payload(_closed_exc(1011, ""))
    assert "1011" in payload["data"]["message"]


class _Socket:
    """Scripted qwen socket: the server refuses only after the buffer commit."""

    def __init__(self):
        self._events = queue.SimpleQueue()
        self.server_close = None
        self.closed = threading.Event()
        self.sent_types = []

    def __aiter__(self):
        return self

    async def __anext__(self):
        while self._events.empty():
            if self.server_close is not None:
                raise websockets.exceptions.ConnectionClosedError(self.server_close, None)
            if self.closed.is_set():
                raise StopAsyncIteration
            await asyncio.sleep(0)
        return self._events.get()

    async def send(self, payload):
        if self.closed.is_set():
            raise RuntimeError("socket already closed")
        event = json.loads(payload)
        self.sent_types.append(event["type"])
        if event["type"] == "session.update":
            self._events.put(json.dumps({"type": "session.updated"}))
        elif event["type"] == "input_text_buffer.commit":
            self.server_close = Close(1007, _ARREARS_REASON)

    async def close(self):
        self.closed.set()


class _Requests:
    def __init__(self, *items):
        self._items = list(items)
        self._lock = threading.Lock()

    def get(self):
        with self._lock:
            if self._items:
                return self._items.pop(0)
        return (TTS_SHUTDOWN_SENTINEL, None)


def _drain_until(resp_q, head, timeout=6.0):
    deadline = time.time() + timeout
    seen = []
    while time.time() < deadline:
        try:
            item = resp_q.get(timeout=0.2)
        except queue.Empty:
            continue
        seen.append(item)
        if isinstance(item, tuple) and item[0] == head:
            return item, seen
    return None, seen


def test_commit_rejection_reaches_the_response_queue(monkeypatch):
    """commit 之后被服务端 1007 拒绝 → 必须是 __error__，不能静默结束。"""
    created = []

    async def _connect(*_args, **_kwargs):
        # speech_id 切换会让 worker 关掉旧连接重连，所以一次用例会建多个 socket；
        # 服务端拒绝发生在最后那条连接上。
        socket = _Socket()
        created.append(socket)
        return socket

    monkeypatch.setattr(qwen_mod.websockets, "connect", _connect)
    monkeypatch.setattr(
        qwen_mod,
        "_resolve_qwen_realtime_tts_url",
        lambda: "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime",
    )

    req_q = _Requests(("speech-1", _TEXT), (None, None))
    resp_q = queue.Queue()

    worker = threading.Thread(
        target=qwen_realtime_tts_worker,
        args=(req_q, resp_q, "sk-test-key", ""),
        daemon=True,
    )
    worker.start()
    try:
        ready, _ = _drain_until(resp_q, "__ready__")
        assert ready is not None and ready[1] is True, "握手应当成功，否则不是本用例的形态"

        error, _seen = _drain_until(resp_q, "__error__")
        assert error is not None, (
            "服务端 1007 拒绝被静默吞掉了：前端只会看到有字幕没声音"
        )
        payload = json.loads(error[1])
        assert payload["data"]["close_code"] == 1007
        assert "good standing" in payload["data"]["message"]
        assert "code" not in payload
        committed = [s for s in created if "input_text_buffer.commit" in s.sent_types]
        assert committed, f"worker 从未发出 commit：{[s.sent_types for s in created]}"
    finally:
        req_q._items.append((TTS_SHUTDOWN_SENTINEL, None))
        worker.join(timeout=5)
