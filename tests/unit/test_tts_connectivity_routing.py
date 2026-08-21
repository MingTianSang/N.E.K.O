from unittest.mock import AsyncMock

import pytest

from main_routers.config_router import connectivity


@pytest.mark.unit
@pytest.mark.asyncio
async def test_named_qwen_cosyvoice_probe_never_uses_assist_chat_endpoint(monkeypatch):
    chat_probe = AsyncMock(side_effect=AssertionError("TTS probe must not use chat completions"))
    monkeypatch.setattr(connectivity, "_test_openai_compatible", chat_probe)

    result = await connectivity.test_connectivity(connectivity.ConnectivityTestRequest(
        provider_key="qwen",
        provider_scope="tts",
        url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_key="qwen-keybook-key",
        model="cosyvoice-v3.5-flash",
        voice_id="longanyang",
        sub_type="cosyvoice_tts",
        provider_type="tts",
    ))

    assert result["success"] is False
    assert result["configuration_valid"] is True
    assert result["error_code"] == "configuration_only"
    chat_probe.assert_not_awaited()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_named_qwen_unknown_model_family_is_explicitly_unsupported(monkeypatch):
    chat_probe = AsyncMock(side_effect=AssertionError("TTS probe must not use chat completions"))
    monkeypatch.setattr(connectivity, "_test_openai_compatible", chat_probe)

    result = await connectivity.test_connectivity(connectivity.ConnectivityTestRequest(
        provider_key="qwen",
        provider_scope="tts",
        url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        api_key="qwen-keybook-key",
        model="qwen-plus",
        voice_id="longanyang",
        sub_type="",
    ))

    assert result == {
        "success": False,
        "error": "不支持的 Qwen TTS 模型族",
        "error_code": "unsupported",
    }
    chat_probe.assert_not_awaited()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_named_qwen_realtime_uses_tts_handshake_with_exact_model_and_voice(monkeypatch):
    realtime_probe = AsyncMock(return_value={"success": True})
    chat_probe = AsyncMock(side_effect=AssertionError("TTS probe must not use chat completions"))
    monkeypatch.setattr(connectivity, "_test_qwen_realtime_tts_connectivity", realtime_probe)
    monkeypatch.setattr(connectivity, "_test_openai_compatible", chat_probe)

    result = await connectivity.test_connectivity(connectivity.ConnectivityTestRequest(
        provider_key="qwen_intl",
        provider_scope="tts",
        url="https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        api_key="intl-key",
        model="qwen3-tts-flash-realtime",
        voice_id="Momo",
        sub_type="qwen_realtime_tts",
    ))

    assert result == {
        "success": True,
        "resolved_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    }
    realtime_probe.assert_awaited_once_with(
        "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "intl-key",
        "qwen3-tts-flash-realtime",
        "Momo",
        "qwen_intl",
    )
    chat_probe.assert_not_awaited()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_named_openai_uses_audio_speech_probe(monkeypatch):
    speech_probe = AsyncMock(return_value={"success": True})
    chat_probe = AsyncMock(side_effect=AssertionError("TTS probe must not use chat completions"))
    monkeypatch.setattr(connectivity, "_test_openai_tts_connectivity", speech_probe)
    monkeypatch.setattr(connectivity, "_test_openai_compatible", chat_probe)

    result = await connectivity.test_connectivity(connectivity.ConnectivityTestRequest(
        provider_key="openai",
        provider_scope="tts",
        url="https://api.openai.com/v1",
        api_key="openai-key",
        model="gpt-4o-mini-tts",
        voice_id="marin",
        sub_type="openai_tts",
    ))

    assert result["success"] is True
    speech_probe.assert_awaited_once_with(
        "https://api.openai.com/v1",
        "openai-key",
        "gpt-4o-mini-tts",
        "marin",
    )
    chat_probe.assert_not_awaited()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_followed_assist_without_tts_preset_capability_is_unsupported(monkeypatch):
    chat_probe = AsyncMock(side_effect=AssertionError("TTS probe must not use chat completions"))
    monkeypatch.setattr(connectivity, "_test_openai_compatible", chat_probe)

    result = await connectivity.test_connectivity(connectivity.ConnectivityTestRequest(
        provider_key="claude",
        provider_scope="tts",
        url="https://api.anthropic.com/v1/messages",
        api_key="assist-key",
        model="claude-sonnet-4",
        voice_id="",
        provider_type="tts",
    ))

    assert result == {
        "success": False,
        "error": "供应商 claude 不支持预制音色 TTS",
        "error_code": "unsupported",
    }
    chat_probe.assert_not_awaited()
