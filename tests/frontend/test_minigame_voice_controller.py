import shutil
import subprocess
from pathlib import Path

import pytest


PROJECT_ROOT = Path(__file__).resolve().parents[2]
RUNTIME_SCRIPT = Path(__file__).with_name("test_minigame_voice_controller_runtime.js")
AUDIO_CAPTURE_RUNTIME_SCRIPT = Path(__file__).with_name(
    "test_app_audio_capture_handoff_runtime.js"
)
CONTROLLER_SCRIPT = PROJECT_ROOT / "static" / "app" / "app-minigame-voice-controller.js"
INDEX_TEMPLATE = PROJECT_ROOT / "templates" / "index.html"
CHAT_TEMPLATE = PROJECT_ROOT / "templates" / "chat.html"
PAGES_ROUTER = PROJECT_ROOT / "main_routers" / "pages_router.py"
AUDIO_CAPTURE = PROJECT_ROOT / "static" / "app" / "app-audio-capture.js"
APP_BUTTONS = PROJECT_ROOT / "static" / "app" / "app-buttons.js"


@pytest.mark.frontend
def test_minigame_voice_controller_node_runtime():
    node_path = shutil.which("node")
    if not node_path:
        pytest.skip("node not found")

    result = subprocess.run(
        [node_path, str(RUNTIME_SCRIPT)],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
        timeout=20,
    )
    output = "\n".join(part for part in (result.stdout, result.stderr) if part).strip()
    assert result.returncode == 0, output or f"{RUNTIME_SCRIPT.name} exited with {result.returncode}"


@pytest.mark.frontend
def test_app_audio_capture_handoff_node_runtime():
    node_path = shutil.which("node")
    if not node_path:
        pytest.skip("node not found")

    result = subprocess.run(
        [node_path, str(AUDIO_CAPTURE_RUNTIME_SCRIPT)],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        check=False,
        timeout=20,
    )
    output = "\n".join(part for part in (result.stdout, result.stderr) if part).strip()
    assert result.returncode == 0, (
        output
        or f"{AUDIO_CAPTURE_RUNTIME_SCRIPT.name} exited with {result.returncode}"
    )


@pytest.mark.frontend
def test_minigame_voice_controller_has_one_main_window_owner_and_cache_version():
    index_html = INDEX_TEMPLATE.read_text(encoding="utf-8")
    chat_html = CHAT_TEMPLATE.read_text(encoding="utf-8")
    pages_source = PAGES_ROUTER.read_text(encoding="utf-8")
    controller_source = CONTROLLER_SCRIPT.read_text(encoding="utf-8")
    audio_source = AUDIO_CAPTURE.read_text(encoding="utf-8")
    buttons_source = APP_BUTTONS.read_text(encoding="utf-8")
    script_tag = (
        '<script src="/static/app/app-minigame-voice-controller.js?'
        'v={{ static_asset_version }}"></script>'
    )

    assert script_tag in index_html
    assert "app-minigame-voice-controller.js" not in chat_html
    assert index_html.index("app-audio-capture.js") < index_html.index(
        "app-minigame-voice-controller.js"
    )
    assert '_PROJECT_ROOT / "static/app/app-minigame-voice-controller.js"' in pages_source
    assert "__nekoMiniGameVoiceControllerInstance" in controller_source
    assert "suspendOrdinaryMicCaptureForMiniGameVoice" in audio_source
    assert "restoreOrdinaryMicCaptureAfterMiniGameVoice" in audio_source
    assert "completeOrdinaryMicCaptureHandoff" in audio_source
    assert "isOrdinaryVoiceSessionActive" in audio_source
    assert "endOrdinaryVoiceSession" in audio_source
    assert "ordinaryMicCaptureEpoch" in audio_source
    assert "ensureOrdinaryMicCaptureAllowed();\n\n            // 检查音频轨道状态" in audio_source
    assert "await startAudioWorklet(S.stream);\n            ensureOrdinaryMicCaptureAllowed();" in audio_source
    assert "options.force !== true && !isOrdinaryVoiceSessionActive()" in audio_source

    suspend_start = audio_source.index(
        "async function suspendOrdinaryMicCaptureForMiniGameVoice()"
    )
    suspend_end = audio_source.index(
        "async function restoreOrdinaryMicCaptureAfterMiniGameVoice", suspend_start
    )
    suspend_source = audio_source[suspend_start:suspend_end]
    timeout_guard = suspend_source.index(
        "if (!await waitForOrdinaryMicCaptureOperations(5000))"
    )
    forced_end = suspend_source.index("const endResult = await endOrdinaryVoiceSession({")
    committed_error = suspend_source.index("error.ordinaryVoiceCommitted = !!(")
    assert timeout_guard < forced_end < committed_error < suspend_source.index("throw error;")
    assert "force: true" in suspend_source[forced_end:committed_error]
    assert "reason: 'mini_game_voice_suspend_timeout'" in suspend_source[
        forced_end:committed_error
    ]
    assert "endResult.committed === true || endResult.ended === true" in suspend_source

    end_session_start = audio_source.index("function endOrdinaryVoiceSession(options)")
    end_session_end = audio_source.index("function startGameVoiceSttGate()", end_session_start)
    end_session_source = audio_source[end_session_start:end_session_end]
    commit_point = end_session_source.index("committed = true;")
    success_finalize = end_session_source.index(
        "finalizeOrdinaryVoiceSessionState();", commit_point
    )
    success_return = end_session_source.index("ok: true", success_finalize)
    assert commit_point < success_finalize < success_return
    assert "ended: true,\n                    committed: true" in end_session_source[
        success_return:
    ]
    catch_start = end_session_source.index("} catch (error) {", success_return)
    catch_source = end_session_source[catch_start:]
    committed_cleanup = catch_source.index("if (committed) {")
    failure_finalize = catch_source.index(
        "finalizeOrdinaryVoiceSessionState();", committed_cleanup
    )
    failure_return = catch_source.index("return {", failure_finalize)
    assert committed_cleanup < failure_finalize < failure_return
    assert "ok: false" in catch_source[failure_return:]
    assert "committed: committed" in catch_source[failure_return:]

    assert "stopMiniGameVoiceForOrdinaryVoiceSession" in buttons_source
    assert "'handoff'" in controller_source
    assert "recognitionStartTimeoutMs" in controller_source
    controller_start = controller_source.index("async _startForIdentity(identity, options)")
    controller_stop = controller_source.index("async _stopCurrent(", controller_start)
    controller_start_source = controller_source[controller_start:controller_stop]
    assert "error.ordinaryVoiceCommitted === true" in controller_start_source
    assert "handoffResult.committed === true" in controller_start_source
    assert controller_start_source.count("this.ordinaryMicRestoreAllowed = false;") >= 3

    restore_start = controller_source.index("async _restoreOrdinaryMic(reason)")
    restore_end = controller_source.index("async _startForIdentity(identity, options)", restore_start)
    restore_source = controller_source[restore_start:restore_end]
    committed_branch = restore_source.index("if (!this.ordinaryMicRestoreAllowed) {")
    complete_handoff = restore_source.index("this.completeOrdinaryMicHandoff()", committed_branch)
    committed_return = restore_source.index("return;", complete_handoff)
    ordinary_restore = restore_source.index("this.restoreOrdinaryMic(reason)", committed_return)
    assert committed_branch < complete_handoff < committed_return < ordinary_restore
    assert "window.appState" not in controller_source
    assert "/route/voice-transcript" not in controller_source
    assert "start_session" not in controller_source
