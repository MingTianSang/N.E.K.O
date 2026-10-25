from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
COMMON_UI_PATH = PROJECT_ROOT / "static" / "common_ui.js"
INDEX_CSS_PATH = PROJECT_ROOT / "static" / "css" / "index.css"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_voice_hotkey_can_stop_pngtuber_session():
    script = _read(COMMON_UI_PATH)
    start = script.index("function getAvatarMicButtons()")
    end = script.index("window.toggleScreenShare = function")
    body = script[start:end]
    assert "window.pngtuberManager" in body
    assert "button.dataset.active === 'true'" in body
    assert "window.isRecording === true" in body
    assert "detail: { active: !isActive }" in body


def test_legacy_chat_minimized_animation_matches_css_size():
    script = _read(COMMON_UI_PATH)
    css = _read(INDEX_CSS_PATH)

    assert "const CHAT_MINIMIZED_SIZE_PX = 51;" in script
    assert "const targetSize = CHAT_MINIMIZED_SIZE_PX;" in script
    minimized_block = css.split("#chat-container.minimized {", 1)[1].split("}", 1)[0]
    assert "width: 51px !important;" in minimized_block
    assert "height: 51px !important;" in minimized_block
