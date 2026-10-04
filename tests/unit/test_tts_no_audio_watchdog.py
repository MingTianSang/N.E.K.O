# Copyright 2025-2026 Project N.E.K.O. Team
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""The no-audio watchdog gives a silent TTS round a terminal state.

A provider can accept all of a turn's text, never return audio, and never close
the connection. Nothing in the previous pipeline notices: ``tts_enqueue`` is
followed by no ``tts_done`` and no ``tts_audio_delivery``, so the user gets
subtitles and silence while the log and the frontend both look healthy. Text
mode cannot fall back to the soft flush either, because that timer is gated on
``input_mode == "audio"``.

Once a turn's commit has been queued, "no sound" is decidable — so the round
gets a deadline, and any audio frame (or any provider-reported error) clears it.
"""

import asyncio
import json
import os
import queue
from queue import Queue
from unittest.mock import MagicMock

import pytest

from main_logic import tts_client
from main_logic.core import LLMSessionManager
from main_logic.core import manager as manager_module
from tests.unit.session_handoff_harness import (  # noqa: F401 - shared fixtures
    MemoryConfig,
)

SID = "round-1"
_TEST_DEADLINE = 0.05


@pytest.fixture
def fast_deadline(monkeypatch):
    monkeypatch.setattr(
        LLMSessionManager,
        "_tts_no_audio_timeout_seconds",
        staticmethod(lambda: _TEST_DEADLINE),
    )


def _make_manager(monkeypatch):
    config = MemoryConfig()
    # DISABLE_TTS=True 会让整条 TTS 走 dummy worker，这里要的是真实收尾路径。
    config.core["DISABLE_TTS"] = False
    monkeypatch.setattr(manager_module, "get_config_manager", lambda: config)
    monkeypatch.setattr(tts_client, "get_config_manager", lambda: config)

    manager = LLMSessionManager(Queue(), "cat", "test prompt")
    manager.use_tts = True
    manager.tts_ready = True
    manager.is_active = True
    manager.tts_thread = MagicMock()
    manager.tts_thread.is_alive.return_value = True
    manager.tts_request_queue = Queue()
    manager.tts_response_queue = Queue()
    manager.current_speech_id = SID
    return manager


def _queued_errors(manager):
    out = []
    while True:
        try:
            item = manager.tts_response_queue.get_nowait()
        except queue.Empty:
            break
        if isinstance(item, tuple) and item[0] == "__error__":
            out.append(item[1])
    return out


@pytest.mark.asyncio
async def test_silent_round_reports_no_audio_timeout(fast_deadline, monkeypatch):
    manager = _make_manager(monkeypatch)

    assert await manager._request_tts_done_for_turn("test") == "queued"
    await asyncio.sleep(_TEST_DEADLINE * 20)

    errors = _queued_errors(manager)
    assert len(errors) == 1, "一轮静默必须恰好产生一个终态"
    payload = json.loads(errors[0])
    assert payload["code"] == "TTS_NO_AUDIO_TIMEOUT"
    assert payload["data"]["message"]


@pytest.mark.asyncio
async def test_audio_output_clears_the_deadline(fast_deadline, monkeypatch):
    manager = _make_manager(monkeypatch)
    assert await manager._request_tts_done_for_turn("test") == "queued"

    # send_speech 先记账再投递：哪怕前端通道已断、这一帧没送出去，provider 确实
    # 回了音频，本轮就不算"什么都不回"。
    await manager.send_speech(b"\x00\x01\x02\x03", SID)
    await asyncio.sleep(_TEST_DEADLINE * 20)

    assert _queued_errors(manager) == []


@pytest.mark.asyncio
async def test_provider_reported_error_suppresses_the_watchdog(
    fast_deadline, monkeypatch
):
    manager = _make_manager(monkeypatch)
    assert await manager._request_tts_done_for_turn("test") == "queued"
    manager._mark_tts_round_output(SID)
    await asyncio.sleep(_TEST_DEADLINE * 20)

    assert _queued_errors(manager) == []


@pytest.mark.asyncio
async def test_moved_on_round_is_not_reported(fast_deadline, monkeypatch):
    """用户已经插话/换轮：旧轮的看门狗不该对新轮报错。"""
    manager = _make_manager(monkeypatch)
    manager._arm_tts_no_audio_watchdog("previous-round")
    manager.current_speech_id = SID
    await asyncio.sleep(_TEST_DEADLINE * 20)

    assert _queued_errors(manager) == []


@pytest.mark.asyncio
async def test_interrupt_cancels_the_watchdog(fast_deadline, monkeypatch):
    manager = _make_manager(monkeypatch)
    assert await manager._request_tts_done_for_turn("test") == "queued"
    manager._cancel_tts_no_audio_watchdog()
    await asyncio.sleep(_TEST_DEADLINE * 20)

    assert _queued_errors(manager) == []


@pytest.mark.asyncio
async def test_retired_worker_is_not_reported(fast_deadline, monkeypatch):
    manager = _make_manager(monkeypatch)
    assert await manager._request_tts_done_for_turn("test") == "queued"
    manager._snapshot_tts_runtime().retired = True
    await asyncio.sleep(_TEST_DEADLINE * 20)

    assert _queued_errors(manager) == []


def test_deadline_is_configurable_and_floored(monkeypatch):
    assert LLMSessionManager._tts_no_audio_timeout_seconds() == 12.0

    monkeypatch.setenv("NEKO_TTS_NO_AUDIO_TIMEOUT_SECONDS", "5")
    assert LLMSessionManager._tts_no_audio_timeout_seconds() == 5.0

    # 手滑填个 0.01 也不能让每个正常轮次都误报。
    monkeypatch.setenv("NEKO_TTS_NO_AUDIO_TIMEOUT_SECONDS", "0.01")
    assert LLMSessionManager._tts_no_audio_timeout_seconds() == 3.0

    monkeypatch.setenv("NEKO_TTS_NO_AUDIO_TIMEOUT_SECONDS", "abc")
    assert LLMSessionManager._tts_no_audio_timeout_seconds() == 12.0


@pytest.mark.parametrize(
    "locale", ["zh-CN", "zh-TW", "en", "ja", "ko", "es", "pt", "ru"]
)
def test_no_audio_code_has_user_facing_text_in_every_locale(locale):
    """没有文案的码 = 又一个「用户看不到任何解释」的静默失败。"""
    root = os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    )
    path = os.path.join(root, "static", "locales", f"{locale}.json")
    with open(path, encoding="utf-8") as handle:
        errors = json.load(handle)["errors"]
    assert "TTS_NO_AUDIO_TIMEOUT" in errors
    assert errors["TTS_NO_AUDIO_TIMEOUT"].strip()
    # 该码不插值 {{msg}}：payload 里没有用户可见文案，别在这里挖坑。
    assert "{{msg}}" not in errors["TTS_NO_AUDIO_TIMEOUT"]
