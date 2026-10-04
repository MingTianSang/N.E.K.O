"""Qwen TTS must turn a server refusal close into a round-attributed error.

DashScope refuses account-level problems (arrears is 1007 + "…account is in
good standing") with a bare WebSocket close and no error event, on a connection
that already reported "ready". The receive loops used to swallow that close, so
the user saw subtitles with no audio while the log and the frontend looked
healthy.

Reporting is only half of it: the error must be pinned to the round that was
rejected (the core blames ``current_speech_id`` otherwise), must not fire for
closes the worker recovers from by itself, and must actually reach the user.
"""

import asyncio
import json
import queue
import time
from unittest.mock import AsyncMock

import pytest
import websockets
from websockets.frames import Close

from main_logic.core import LLMSessionManager
from main_logic.core import tts_runtime as tts_runtime_mod
from main_logic.tts_client._infra import (
    SERVER_CLOSE_REFUSAL_CODES,
    classify_server_close,
)
from main_logic.tts_client.workers import qwen as qwen_mod
from main_logic.tts_client.workers.qwen import qwen_realtime_tts_worker
from tests.unit.test_free_tts_connection_lifetime import (  # noqa: F401 - shared doubles
    _Requests,
    _Socket,
)

_ARREARS_REASON = "Access denied, please make sure your account is in good standing."
_TEXT = "你好呀，今天过得怎么样？"
_SID = "speech-1"
_TTS_URL = (
    "wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-tts-flash-realtime"
)


class _Frame:
    """Minimal stand-in for a websockets close frame."""

    def __init__(self, code, reason=""):
        self.code = code
        self.reason = reason


class _Closed:
    """ConnectionClosed-shaped object with only the fields the classifier reads."""

    def __init__(self, rcvd, rcvd_then_sent=None):
        self.rcvd = rcvd
        self.sent = rcvd
        self.rcvd_then_sent = rcvd_then_sent


# ─────────────────────────── classifier rules ───────────────────────────


@pytest.mark.parametrize("code", sorted(SERVER_CLOSE_REFUSAL_CODES | {4004, 4001}))
def test_refusal_codes_become_a_structured_error(code):
    payload = classify_server_close(_Closed(_Frame(code, _ARREARS_REASON), True))
    assert payload["data"]["close_code"] == code
    assert payload["data"]["message"] == _ARREARS_REASON


@pytest.mark.parametrize(
    ("code", "why"),
    [
        (1000, "normal closure"),
        (1001, "going away"),
        (1005, "no status in frame; websockets counts it normal"),
        (1011, "server error, the worker reconnects"),
        (1012, "restart, the worker reconnects"),
        (1013, "throttled and recoverable; the free tier maps it explicitly"),
    ],
)
def test_recoverable_closes_stay_silent(code, why):
    assert classify_server_close(_Closed(_Frame(code, ""), True)) is None, why


def test_transport_drop_without_a_close_frame_is_not_a_refusal():
    assert classify_server_close(_Closed(None, None)) is None


def test_our_own_close_is_not_reported_as_a_refusal():
    # sid rotation, interrupt and shutdown all close us first and observe the
    # reply; reporting that would blame a live round for our own teardown.
    assert classify_server_close(_Closed(_Frame(4004, "Not Found"), False)) is None


def test_payload_carries_no_top_level_code_so_core_owns_classification():
    payload = classify_server_close(_Closed(_Frame(1007, _ARREARS_REASON), True))
    assert "code" not in payload


def test_a_provider_can_widen_refusals_without_changing_the_default():
    assert classify_server_close(_Closed(_Frame(1013, "quota"), True)) is None
    widened = classify_server_close(
        _Closed(_Frame(1013, "quota"), True), extra_refusal_codes={1013}
    )
    assert widened is not None


def test_a_real_websockets_exception_is_classified():
    exc = websockets.exceptions.ConnectionClosedError(Close(1007, _ARREARS_REASON), None)
    assert classify_server_close(exc)["data"]["close_code"] == 1007


# ─────────── handler: does the refusal reach the user, and whom ───────────


@pytest.mark.asyncio
async def test_handler_reports_arrears_at_once_and_blames_the_rejected_round(
    monkeypatch,
):
    """Arrears must notify on the first occurrence, pinned to the rejected round.

    ``API_ARREARS`` is in IMMEDIATE_REPORT_TTS_CODES, so it bypasses the
    "only the 3rd failure" damper; the ``__tts_sentence_failed__`` marker is what
    stops the core from blaming the round that had already started.
    """
    monkeypatch.setattr(
        tts_runtime_mod.GAME_SPEECH_AUDIO_CACHE, "fail_capture", lambda *_a: None
    )
    response_queue = queue.Queue()
    response_queue.put(("__tts_sentence_failed__", _SID, ""))
    response_queue.put(
        (
            "__error__",
            json.dumps(
                {
                    "type": "error",
                    "data": {"close_code": 1007, "message": _ARREARS_REASON},
                }
            ),
        )
    )

    mgr = LLMSessionManager.__new__(LLMSessionManager)
    mgr.current_speech_id = "next-round"
    mgr.tts_response_queue = response_queue
    mgr.tts_cache_lock = asyncio.Lock()
    mgr.tts_ready = True
    mgr._tts_replay_speech_id = None
    mgr._tts_replay_sentence_audio_emitted = False
    mgr._last_tts_error_code = ""
    mgr._tts_retry_notify_count = 0
    mgr._tts_runtime_is_current = lambda _runtime: True
    mgr._activate_configured_tts_fallback_after_capacity = AsyncMock(return_value=False)
    mgr._confirm_pending_ai_voice_echo = lambda *_a: None
    mgr._discard_pending_ai_voice_echo = lambda: None
    failed_rounds = []
    mgr._mark_game_speech_delivery_failed = lambda sid=None: failed_rounds.append(sid)
    notices = []

    async def send_status(message):
        notices.append(json.loads(message))

    mgr.send_status = send_status

    task = asyncio.create_task(LLMSessionManager.tts_response_handler(mgr))
    deadline = time.time() + 2.0
    while not response_queue.empty() and time.time() < deadline:
        await asyncio.sleep(0.01)
    await asyncio.sleep(0.05)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)

    assert [n["code"] for n in notices] == ["API_ARREARS"]
    # marker 分支和 error 分支都会把这一轮标成投递失败——两次都必须落在被拒的那一
    # 轮上，而不是已经开跑的 next-round。
    assert set(failed_rounds) == {_SID}
    assert "next-round" not in failed_rounds
    assert mgr._last_tts_error_code == "API_ARREARS"


# ─────────────────────────── worker integration ───────────────────────────


class _RefusingSocket(_Socket):
    """Socket double whose server refuses right after the buffer commit."""

    def __init__(self, code=1007, reason=_ARREARS_REASON):
        super().__init__(on_send={"session.update": [{"type": "session.updated"}]})
        self._refusal = Close(code, reason)

    async def __anext__(self):
        """Same contract as the shared double, but poll with a real sleep.

        ``_Socket.__anext__`` busy-waits with ``asyncio.sleep(0)`` while no event
        is queued. In a worker thread that hoggs the GIL, and it has been observed
        pushing an unrelated wall-clock assertion (``test_recovery_capacity_
        deadline_ignores_loop_clock_origin`` requires elapsed < 0.3s) over its
        limit. A 20ms poll keeps the same behaviour at ~1/1000 the cost.
        """
        while self._events.empty():
            if self._server_close is not None:
                raise websockets.exceptions.ConnectionClosedError(
                    self._server_close, None
                )
            if self.closed.is_set():
                raise StopAsyncIteration
            await asyncio.sleep(0.02)
        return self._events.get()

    async def send(self, payload):
        await super().send(payload)
        if json.loads(payload)["type"] == "input_text_buffer.commit":
            self._server_close = self._refusal


def _drive_worker(socket_factory):
    """Run the real worker to completion in this test's own loop; return emissions.

    Deliberately thread-free: ``qwen_realtime_tts_worker`` calls ``asyncio.run``
    itself, so a synchronous caller gets a deterministic, self-contained loop.
    Extra threads here have been observed tipping a wall-clock bound in
    ``test_qwen_provider_fallback.py`` once pytest-randomly interleaves them.
    """
    # The callable is a barrier: _Requests runs it in the blocking get() thread,
    # so the worker stops pulling while its receive task gets the loop and
    # observes the close the server sent after the commit.
    def _let_receive_task_run():
        time.sleep(0.05)

    req_q = _Requests((_SID, _TEXT), (None, None), _let_receive_task_run)
    resp_q = queue.Queue()
    sockets = []

    async def _connect(*_args, **_kwargs):
        socket = socket_factory()
        sockets.append(socket)
        return socket

    original_connect = qwen_mod.websockets.connect
    original_url = qwen_mod._resolve_qwen_realtime_tts_url
    qwen_mod.websockets.connect = _connect
    qwen_mod._resolve_qwen_realtime_tts_url = lambda: _TTS_URL
    try:
        qwen_realtime_tts_worker(req_q, resp_q, "sk-test-key", "")
    finally:
        qwen_mod.websockets.connect = original_connect
        qwen_mod._resolve_qwen_realtime_tts_url = original_url
    emitted = []
    while True:
        try:
            emitted.append(resp_q.get_nowait())
        except queue.Empty:
            break
    return emitted, sockets


def test_refusal_after_commit_is_reported_once_and_pinned_to_the_round():
    emitted, _sockets = _drive_worker(_RefusingSocket)
    heads = [item[0] for item in emitted if isinstance(item, tuple)]
    assert "__ready__" in heads, f"握手应当成功：{emitted}"

    errors = [item for item in emitted if item[0] == "__error__"]
    assert len(errors) == 1, f"一次拒绝只能报一次：{heads}"
    payload = json.loads(errors[0][1])
    assert payload["data"]["close_code"] == 1007
    assert "code" not in payload

    marker_index = heads.index("__tts_sentence_failed__")
    error_index = heads.index("__error__")
    assert error_index == marker_index + 1, "marker 必须紧邻 error 之前"
    assert emitted[marker_index][1] == _SID


def test_recoverable_close_reports_nothing():
    emitted, _sockets = _drive_worker(lambda: _RefusingSocket(code=1011, reason=""))
    heads = [item[0] for item in emitted if isinstance(item, tuple)]
    assert "__error__" not in heads, f"1011 是可恢复断链，不该惊动用户：{heads}"
