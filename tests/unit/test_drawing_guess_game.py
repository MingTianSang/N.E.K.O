import json
from pathlib import Path

import pytest

from main_routers import game_router


class _FakeRequest:
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload


@pytest.fixture(autouse=True)
def _clear_drawing_guess_state(monkeypatch):
    game_router._drawing_guess_sessions.clear()
    monkeypatch.setattr(
        game_router,
        "_absorb_request_language",
        lambda data, lanlan_name: data.get("i18n_language") or data.get("language"),
    )
    monkeypatch.setattr(
        game_router,
        "_drawing_guess_persona_context",
        lambda lanlan_name, language=None: {
            "lanlan_name": lanlan_name,
            "master_name": "Master",
            "language": language or "en",
            "persona_prompt": "playful test persona",
            "persona_context": "test persona is playing drawing guess",
        },
    )
    yield
    game_router._drawing_guess_sessions.clear()


def test_drawing_guess_answer_matching_accepts_aliases():
    apple = game_router._DRAWING_GUESS_WORD_BY_ID["apple"]

    assert game_router._drawing_guess_match_answer("red apple", apple)["matched"] is True
    assert game_router._drawing_guess_match_answer("苹果", apple)["matched"] is True
    assert game_router._drawing_guess_match_answer("banana", apple)["matched"] is False
    assert game_router._drawing_guess_is_hint_request("提示一下") is True


def test_drawing_guess_word_bank_is_expanded_and_localized():
    locales = set(game_router._DRAWING_GUESS_LOCALES)
    assert len(game_router._DRAWING_GUESS_WORDS) >= 40
    assert len({word["id"] for word in game_router._DRAWING_GUESS_WORDS}) == len(game_router._DRAWING_GUESS_WORDS)
    for word in game_router._DRAWING_GUESS_WORDS:
        hint_map = word.get("hint") or word.get("hints")
        assert set(word["labels"]) == locales
        assert set(hint_map) == locales
        assert set(word["aliases"]) == locales
        for locale in locales:
            assert game_router._drawing_guess_word_label(word, locale).strip(), (word["id"], locale, "label")
            assert game_router._drawing_guess_word_hint(word, locale).strip(), (word["id"], locale, "hint")
            assert game_router._drawing_guess_match_answer(word["labels"][locale], word)["matched"] is True


def test_drawing_guess_svg_sanitizer_removes_answer_leaks_and_events():
    dirty = (
        '<svg viewBox="0 0 800 500" xmlns="http://www.w3.org/2000/svg">'
        '<script>alert("apple")</script>'
        '<text x="10" y="10">apple</text>'
        '<circle cx="10" cy="10" r="5" onclick="alert(1)" fill="url(javascript:alert(1))" />'
        '<path d="M0 0 L10 10" stroke="#111" />'
        '</svg>'
    )

    clean = game_router._sanitize_drawing_guess_svg(dirty)

    assert "<script" not in clean
    assert "<text" not in clean
    assert "onclick" not in clean
    assert "javascript" not in clean
    assert "<path" in clean


@pytest.mark.asyncio
async def test_drawing_guess_neko_draw_round_accepts_correct_guess():
    started = await game_router.drawing_guess_round_start(
        "drawing_guess",
        _FakeRequest({"lanlan_name": "Lan", "session_id": "dg-1", "drawer": "neko", "i18n_language": "en"}),
    )
    assert started["ok"] is True
    assert started["round"]["drawer"] == "neko"
    assert "label" not in started["round"]["answer"]

    drawn = await game_router.drawing_guess_ai_draw(
        "drawing_guess",
        _FakeRequest({"lanlan_name": "Lan", "session_id": "dg-1", "i18n_language": "en", "use_model": False}),
    )
    assert drawn["ok"] is True
    assert drawn["round"]["phase"] == "user_guessing"
    assert "<svg" in drawn["svg"]
    assert "<text" not in drawn["svg"]
    assert "candidates" not in drawn["round"]

    session = game_router._drawing_guess_sessions["Lan:dg-1"]
    word = game_router._drawing_guess_current_word(session)
    answer = game_router._drawing_guess_word_label(word, "en")
    guessed = await game_router.drawing_guess_input(
        "drawing_guess",
        _FakeRequest({
            "lanlan_name": "Lan",
            "session_id": "dg-1",
            "i18n_language": "en",
            "text": answer,
            "intent": "guess",
            "use_model": False,
        }),
    )

    assert guessed["ok"] is True
    assert guessed["type"] == "correct_guess"
    assert guessed["round"]["phase"] == "round_complete"
    assert guessed["round"]["score"]["user"] == 1
    assert guessed["round"]["answer"]["label"] == answer


@pytest.mark.asyncio
async def test_drawing_guess_user_draw_round_vision_fallback_completes_round():
    started = await game_router.drawing_guess_round_start(
        "drawing_guess",
        _FakeRequest({"lanlan_name": "Lan", "session_id": "dg-2", "drawer": "user", "i18n_language": "en"}),
    )
    assert started["ok"] is True
    assert started["round"]["drawer"] == "user"
    assert started["round"]["answer"]["label"]

    guessed = await game_router.drawing_guess_vision_guess(
        "drawing_guess",
        _FakeRequest({
            "lanlan_name": "Lan",
            "session_id": "dg-2",
            "i18n_language": "en",
            "use_vision_model": False,
        }),
    )

    assert guessed["ok"] is True
    assert guessed["matched"] is True
    assert guessed["source"] == "fallback"
    assert guessed["round"]["phase"] == "round_complete"
    assert guessed["round"]["score"]["neko"] == 1


def test_drawing_guess_invite_config_prompts_and_locales_complete():
    from config import MINI_GAME_INVITE_AVAILABLE_GAMES, MINI_GAME_LAUNCH_URL_BY_GAME
    from config.prompts.prompts_activity import WORK_BREAK_GAME_INVITE_PROMPTS_BY_GAME
    from config.prompts.prompts_proactive import MINI_GAME_INVITE_LINES_BY_GAME

    assert "drawing_guess" in MINI_GAME_INVITE_AVAILABLE_GAMES
    assert MINI_GAME_LAUNCH_URL_BY_GAME["drawing_guess"] == "/drawing_guess_demo"
    for lang in ("zh", "en", "ja", "ko", "ru", "es", "pt"):
        assert MINI_GAME_INVITE_LINES_BY_GAME["drawing_guess"][lang].strip()
        prompt = WORK_BREAK_GAME_INVITE_PROMPTS_BY_GAME["drawing_guess"][lang]
        assert prompt.strip()
        assert "{master}" in prompt
        assert "{app}" in prompt
        assert "{minutes}" in prompt

    locale_dir = Path("static/locales")
    required_paths = [
        ("title",),
        ("hud", "round"),
        ("status", "userDrawing"),
        ("phase", "userGuessing"),
        ("actions", "saveNeko"),
        ("tools", "undo"),
        ("chat", "placeholder"),
        ("chat", "placeholderUserGuessing"),
        ("chat", "placeholderUserDrawing"),
        ("chat", "placeholderNekoGuessing"),
        ("messages", "welcome"),
        ("result", "title"),
        ("result", "userCorrect"),
        ("result", "nekoWrong"),
        ("answer", "label"),
        ("aria", "userCanvas"),
    ]
    for locale in ("en", "ja", "ko", "zh-CN", "zh-TW", "ru", "pt", "es"):
        data = json.loads((locale_dir / f"{locale}.json").read_text(encoding="utf-8"))
        section = data["drawingGuess"]
        assert "candidates" not in section
        for path in required_paths:
            value = section
            for key in path:
                value = value[key]
            assert isinstance(value, str) and value.strip(), (locale, path)
