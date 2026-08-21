from functools import partial
import json
from queue import Queue

import pytest

from main_logic import tts_client
from main_logic.core import LLMSessionManager
from main_logic.tts_client.workers import cosyvoice as cosyvoice_worker_module
from main_logic.tts_client.workers import local_cosyvoice as local_cosyvoice_worker_module
from utils.tts import provider_registry


class _ConfigManager:
    def __init__(self, core_config=None, *, tts_custom=None, keys=None, cosy_runtime=None):
        self.core_config = dict(core_config or {})
        self.tts_custom = dict(tts_custom or {"is_custom": False})
        self.keys = dict(keys or {})
        self.cosy_runtime = dict(cosy_runtime or {})

    def get_core_config(self):
        return dict(self.core_config)

    def get_model_api_config(self, model_type):
        if model_type == "tts_custom":
            return dict(self.tts_custom)
        if model_type == "realtime":
            return {
                "api_type": self.core_config.get("CORE_API_TYPE", "qwen"),
                "base_url": self.core_config.get("CORE_URL", ""),
            }
        return {}

    def get_tts_api_key(self, provider):
        return self.keys.get(provider, "")

    def get_cosyvoice_clone_runtime(self, provider):
        return dict(self.cosy_runtime.get(provider, {}))

    def load_json_config(self, _filename, default):
        return dict(self.core_config) if self.core_config else default

    def get_voices_for_current_api(self, **_kwargs):
        return {}

    def voice_id_exists_in_any_storage(self, _voice_id):
        return False


def _install(monkeypatch, config, voice_meta=None):
    monkeypatch.setattr(tts_client, "get_config_manager", lambda: config)
    monkeypatch.setattr(tts_client, "_get_voice_meta", lambda _voice_id: voice_meta)


@pytest.mark.unit
def test_explicit_qwen_cosyvoice_preset_binds_slot_model_voice_and_keybook_key(monkeypatch):
    """Regression for the reported qwen/cosyvoice-v3.5-flash/longanyang setup."""
    cm = _ConfigManager({
        "CORE_API_TYPE": "gemini",
        "CORE_API_KEY": "gemini-core-key",
        "ENABLE_CUSTOM_API": True,
        "ttsModelProvider": "qwen",
        "ttsModelUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "ttsModelId": "cosyvoice-v3.5-flash",
        "ttsVoiceId": "longanyang",
        "TTS_MODEL_API_KEY": "",
        "ASSIST_API_KEY_QWEN": "qwen-keybook-key",
    })
    _install(monkeypatch, cm)

    worker, api_key, provider_key = tts_client.get_tts_worker(
        core_api_type="gemini",
        has_custom_voice=False,
        voice_id="",
    )

    assert isinstance(worker, partial)
    assert worker.func is tts_client.cosyvoice_vc_tts_worker
    assert worker.keywords == {
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "enrolled_model": "cosyvoice-v3.5-flash",
        "provider_key": "qwen",
        "configured_voice": "longanyang",
    }
    assert api_key == "qwen-keybook-key"
    assert provider_key == "qwen"


@pytest.mark.unit
def test_cosyvoice_worker_accepts_bound_voice_when_character_voice_is_empty(monkeypatch):
    class _WorkerConfig:
        def get_model_api_config(self, _model_type):
            return {}

    monkeypatch.setattr(cosyvoice_worker_module, "get_config_manager", lambda: _WorkerConfig())
    monkeypatch.setattr(tts_client, "_get_voice_meta", lambda _voice_id: None)
    requests = Queue()
    responses = Queue()
    requests.put((tts_client.TTS_SHUTDOWN_SENTINEL, None))

    tts_client.cosyvoice_vc_tts_worker(
        requests,
        responses,
        "qwen-keybook-key",
        "",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        enrolled_model="cosyvoice-v3.5-flash",
        provider_key="qwen",
        configured_voice="longanyang",
    )

    assert responses.get_nowait() == ("__ready__", True)


@pytest.mark.unit
@pytest.mark.parametrize("foreign_provider", ["cosyvoice", "minimax"])
def test_explicit_qwen_rejects_foreign_clone_metadata(monkeypatch, foreign_provider):
    cm = _ConfigManager({
        "CORE_API_TYPE": "qwen",
        "ttsModelProvider": "qwen",
        "ttsModelId": "qwen3-tts-flash-realtime",
        "ttsVoiceId": "Momo",
        "ASSIST_API_KEY_QWEN": "qwen-key",
    })
    _install(
        monkeypatch,
        cm,
        {"provider": foreign_provider, "source": "clone", "clone_model": "cosyvoice-v3.5-flash"},
    )

    worker, api_key, provider_key = tts_client.get_tts_worker(
        core_api_type="qwen",
        has_custom_voice=True,
        voice_id="foreign-clone",
    )

    assert isinstance(worker, partial)
    assert worker.func is tts_client.invalid_tts_configuration_worker
    assert worker.keywords == {
        "provider_key": "qwen",
        "reason": "voice_owned_by_other_provider",
    }
    assert api_key == ""
    assert provider_key == "qwen"


@pytest.mark.unit
def test_follow_assist_unsupported_provider_fails_without_core_fallback(monkeypatch):
    cm = _ConfigManager({
        "CORE_API_TYPE": "qwen",
        "ENABLE_CUSTOM_API": True,
        "assistApi": "kimi",
        "ttsModelProvider": "follow_assist",
    })
    _install(monkeypatch, cm)

    worker, api_key, provider_key = tts_client.get_tts_worker(
        core_api_type="qwen",
        has_custom_voice=False,
        voice_id="",
    )

    assert isinstance(worker, partial)
    assert worker.func is tts_client.invalid_tts_configuration_worker
    assert worker.keywords == {
        "provider_key": "kimi",
        "reason": "unsupported_or_unowned_provider",
    }
    assert api_key == ""
    assert provider_key == "kimi"


@pytest.mark.unit
@pytest.mark.parametrize(
    ("mode", "provider", "role_url", "role_key_field", "expected_worker", "expected_url"),
    [
        (
            "follow_core",
            "openai",
            "wss://api.openai.com/v1/realtime",
            "CORE_API_KEY",
            tts_client.openai_tts_worker,
            "https://api.openai.com/v1",
        ),
        (
            "follow_assist",
            "qwen",
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            "OPENROUTER_API_KEY",
            tts_client.qwen_realtime_tts_worker,
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
        ),
    ],
)
def test_followed_named_provider_uses_its_tts_endpoint_before_role_url(
    monkeypatch,
    mode,
    provider,
    role_url,
    role_key_field,
    expected_worker,
    expected_url,
):
    config = {
        "CORE_API_TYPE": provider if mode == "follow_core" else "gemini",
        "CORE_URL": role_url if mode == "follow_core" else "",
        "OPENROUTER_URL": role_url if mode == "follow_assist" else "",
        "assistApi": provider if mode == "follow_assist" else "gemini",
        "ENABLE_CUSTOM_API": True,
        "ttsModelProvider": mode,
        "ttsVoiceId": "Momo" if provider == "qwen" else "marin",
        role_key_field: "followed-role-key",
    }
    cm = _ConfigManager(config)
    _install(monkeypatch, cm)

    worker, api_key, provider_key = tts_client.get_tts_worker(
        core_api_type=config["CORE_API_TYPE"],
        has_custom_voice=False,
        voice_id="",
    )

    assert isinstance(worker, partial)
    assert worker.func is expected_worker
    assert worker.keywords["base_url"] == expected_url
    assert api_key == "followed-role-key"
    assert provider_key == provider


@pytest.mark.unit
def test_unknown_legacy_voice_does_not_wildcard_to_cosyvoice(monkeypatch):
    cm = _ConfigManager({"CORE_API_TYPE": "qwen"})
    _install(monkeypatch, cm)

    worker, _api_key, provider_key = tts_client.get_tts_worker(
        core_api_type="qwen",
        has_custom_voice=True,
        voice_id="metadata-was-lost",
    )

    assert worker is tts_client.qwen_realtime_tts_worker
    assert provider_key == "qwen"


@pytest.mark.unit
def test_explicit_cosyvoice_owner_still_routes_clone(monkeypatch):
    cm = _ConfigManager(
        {"CORE_API_TYPE": "qwen", "ttsModelProvider": "cosyvoice"},
        cosy_runtime={
            "cosyvoice": {
                "api_key": "cosy-key",
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
            }
        },
    )
    _install(
        monkeypatch,
        cm,
        {"provider": "cosyvoice", "source": "clone", "clone_model": "cosyvoice-v3.5-flash"},
    )

    worker, api_key, provider_key = tts_client.get_tts_worker(
        core_api_type="qwen",
        has_custom_voice=True,
        voice_id="owned-clone",
    )

    assert isinstance(worker, partial)
    assert worker.func is tts_client.cosyvoice_vc_tts_worker
    assert worker.keywords["provider_key"] == "cosyvoice"
    assert api_key == "cosy-key"
    assert provider_key == "cosyvoice"


@pytest.mark.unit
def test_cosyvoice_intl_missing_key_never_inherits_generic_tts_key(monkeypatch):
    cm = _ConfigManager(
        {"CORE_API_TYPE": "qwen"},
        cosy_runtime={
            "cosyvoice_intl": {
                "api_key": "",
                "base_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
            }
        },
    )
    _install(
        monkeypatch,
        cm,
        {
            "provider": "cosyvoice_intl",
            "source": "clone",
            "clone_model": "cosyvoice-v3.5-flash",
        },
    )

    worker, api_key, provider_key = tts_client.get_tts_worker(
        core_api_type="qwen",
        has_custom_voice=True,
        voice_id="intl-clone",
    )

    assert isinstance(worker, partial)
    assert worker.func is tts_client.cosyvoice_vc_tts_worker
    assert worker.keywords["provider_key"] == "cosyvoice_intl"
    assert api_key == ""
    assert provider_key == "cosyvoice_intl"
    assert LLMSessionManager.resolve_tts_api_key(
        provider_key,
        api_key,
        {"api_key": "must-not-leak"},
    ) == ""


@pytest.mark.unit
def test_local_cosyvoice_metadata_routes_to_bound_worker(monkeypatch):
    cm = _ConfigManager(
        {"CORE_API_TYPE": "qwen"},
        tts_custom={
            "is_custom": True,
            "base_url": "ws://127.0.0.1:50000/v1/audio/speech/stream",
        },
    )
    _install(monkeypatch, cm, {"provider": "local", "source": "clone", "is_local": True})

    worker, api_key, provider_key = tts_client.get_tts_worker(
        core_api_type="qwen",
        has_custom_voice=True,
        voice_id="local-speaker",
    )

    assert isinstance(worker, partial)
    assert worker.func is tts_client.local_cosyvoice_worker
    assert worker.keywords == {
        "base_url": "ws://127.0.0.1:50000/v1/audio/speech/stream",
    }
    assert api_key == ""
    assert provider_key == "local_cosyvoice"


@pytest.mark.unit
def test_bound_local_cosyvoice_url_never_reads_config_manager(monkeypatch):
    def _unexpected_config_read():
        raise AssertionError("bound Local CosyVoice URL must bypass ConfigManager")

    monkeypatch.setattr(local_cosyvoice_worker_module, "get_config_manager", _unexpected_config_read)
    responses = Queue()

    tts_client.local_cosyvoice_worker(
        Queue(),
        responses,
        "",
        "local-speaker",
        base_url="https://not-a-websocket.example.com",
    )

    error_kind, payload = responses.get_nowait()
    assert error_kind == "__error__"
    payload = json.loads(payload)
    assert payload["provider"] == "local_cosyvoice"
    assert payload["reason"] == "missing_or_invalid_url"
    assert responses.get_nowait() == ("__ready__", False)


@pytest.mark.unit
def test_named_tts_builtin_metadata_is_visible_with_preset_capability():
    metadata = {item["key"]: item for item in provider_registry.ui_metadata()}

    for provider_key in ("qwen", "qwen_intl", "gemini", "step", "free", "grok", "openai", "glm"):
        assert provider_key in metadata
        assert "preset" in metadata[provider_key]["capabilities"]
        assert metadata[provider_key]["tts_config_visible"] is True

    assert metadata["mimo"]["default_url"] == "https://api.xiaomimimo.com/v1"
    assert metadata["mimo"]["default_model"] == "mimo-v2.5-tts"
    assert metadata["mimo"]["default_voice"] == "mimo_default"


@pytest.mark.unit
def test_invalid_configuration_worker_reports_owner_then_false_ready():
    responses = Queue()

    tts_client.invalid_tts_configuration_worker(
        Queue(),
        responses,
        "",
        "",
        provider_key="qwen",
        reason="unsupported_model_family",
    )

    error_kind, payload = responses.get_nowait()
    assert error_kind == "__error__"
    payload = json.loads(payload)
    assert payload["code"] == "TTS_CONFIG_INVALID"
    assert payload["provider"] == "qwen"
    assert payload["reason"] == "unsupported_model_family"
    assert responses.get_nowait() == ("__ready__", False)


@pytest.mark.unit
@pytest.mark.parametrize("stale_provider", ["qwen", "custom", "vllm_omni", "follow_assist"])
def test_custom_api_master_off_ignores_stale_tts_model_provider(monkeypatch, stale_provider):
    cm = _ConfigManager({
        "CORE_API_TYPE": "qwen",
        "assistApi": "gemini",
        "ENABLE_CUSTOM_API": False,
        "ttsModelProvider": stale_provider,
        "ttsModelId": "cosyvoice-v3.5-flash",
        "ttsVoiceId": "longanyang",
        "ASSIST_API_KEY_QWEN": "stale-qwen-key",
    })
    _install(monkeypatch, cm)

    worker, api_key, provider_key = tts_client.get_tts_worker(
        core_api_type="qwen",
        has_custom_voice=False,
        voice_id="",
    )

    assert worker is tts_client.qwen_realtime_tts_worker
    assert api_key is None
    assert provider_key == "qwen"
