from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from .game_route_test_helpers import gr_patch_all as _gr_patch_all
from main_routers.game_router import runtime as gr_runtime
from utils import game_log, game_route_state


class _FakeRequest:
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        return self._payload


@pytest.fixture(autouse=True)
def _isolate_sdk_route_globals():
    """Keep this migration contract independent of the shared reset helper."""
    sessions_snapshot = dict(gr_runtime._game_sessions)
    routes_snapshot = dict(gr_runtime._game_route_states)
    debug_logs_snapshot = dict(game_log._game_session_debug_logs)
    tombstones = getattr(gr_runtime, "_game_route_end_tombstones", None)
    tombstones_snapshot = dict(tombstones) if tombstones is not None else None

    gr_runtime._game_sessions.clear()
    gr_runtime._game_route_states.clear()
    game_log._game_session_debug_logs.clear()
    if tombstones is not None:
        tombstones.clear()
    route_key = game_route_state._route_state_key("Lan", "drawing_guess")
    game_route_state._route_state_locks.pop(route_key, None)
    game_route_state._route_supersede_locks.pop("Lan", None)
    try:
        yield
    finally:
        gr_runtime._game_sessions.clear()
        gr_runtime._game_sessions.update(sessions_snapshot)
        gr_runtime._game_route_states.clear()
        gr_runtime._game_route_states.update(routes_snapshot)
        game_log._game_session_debug_logs.clear()
        game_log._game_session_debug_logs.update(debug_logs_snapshot)
        if tombstones is not None:
            tombstones.clear()
            tombstones.update(tombstones_snapshot or {})
        # asyncio.Lock instances are loop-bound after contention. These tests
        # run one loop per test, so retaining their Lan locks would poison a
        # later concurrency module that deliberately contends on the same key.
        game_route_state._route_state_locks.pop(route_key, None)
        game_route_state._route_supersede_locks.pop("Lan", None)


def _sdk_state(*, route_instance_id="route-B"):
    state = gr_runtime._activate_game_route(
        "drawing_guess",
        "sdk-shared-session",
        "Lan",
    )
    state["_sdk_route_instance_id"] = route_instance_id
    return state


def _route_payload(*, route_instance_id=None, candidates=None, **extra):
    payload = {
        "lanlan_name": "Lan",
        "session_id": "sdk-shared-session",
        "postgameProactive": False,
        **extra,
    }
    if route_instance_id is not None:
        payload["sdk_route_instance_id"] = route_instance_id
    if candidates is not None:
        payload["sdk_route_instance_ids"] = candidates
    return payload


@pytest.mark.unit
def test_sdk_route_instance_candidates_are_primary_first_deduplicated_and_bounded():
    result = gr_runtime._sdk_route_instance_ids({
        "sdk_route_instance_id": " primary ",
        "sdk_route_instance_ids": [
            "primary",
            "second",
            "third",
            "fourth",
            "fifth",
            123,
            "x" * (gr_runtime._SDK_ROUTE_INSTANCE_ID_MAX_CHARS + 1),
        ],
    })

    assert result == ("primary", "second", "third", "fourth")


@pytest.mark.unit
def test_sdk_route_instance_binding_preserves_legacy_and_rejects_stale_callers():
    legacy_state = {
        "game_route_active": True,
        "session_id": "legacy-session",
    }
    assert gr_runtime._sdk_route_instance_error(legacy_state, {}) is None

    identified_state = {
        "game_route_active": True,
        "session_id": "sdk-shared-session",
        "_sdk_route_instance_id": "route-B",
    }
    assert gr_runtime._sdk_route_instance_error(
        identified_state,
        {"sdk_route_instance_id": "route-B"},
    ) is None
    assert gr_runtime._sdk_route_instance_error(
        identified_state,
        {},
    )["reason"] == "route_instance_id_mismatch"
    assert gr_runtime._sdk_route_instance_error(
        identified_state,
        {"sdk_route_instance_id": "route-A"},
    )["reason"] == "route_instance_id_mismatch"
    assert gr_runtime._sdk_route_instance_error(
        None,
        {"sdk_route_instance_id": "ended-route"},
    )["reason"] == "route_instance_id_mismatch"


@pytest.mark.unit
def test_sdk_public_lifecycle_state_excludes_context_and_internal_collections():
    state = {
        "game_type": "drawing_guess",
        "session_id": "sdk-shared-session",
        "lanlan_name": "Lan",
        "game_route_active": True,
        "heartbeat_enabled": True,
        "_sdk_route_instance_id": "route-B",
        "preGameContext": {"history": "private context"},
        "game_dialog_log": [{"text": "private dialogue"}],
        "pending_outputs": [{"result": "private output"}],
        "last_state": {"secret": "game-owned state"},
        "custom_public_field": "not part of the lifecycle contract",
    }

    visible = gr_runtime._public_route_state(state)

    assert visible["game_route_active"] is True
    assert visible["session_id"] == "sdk-shared-session"
    assert visible["dialog_count"] == 1
    assert visible["pending_output_count"] == 1
    assert "sdk_route_instance_id" not in visible
    assert "preGameContext" not in visible
    assert "game_dialog_log" not in visible
    assert "pending_outputs" not in visible
    assert "last_state" not in visible
    assert "custom_public_field" not in visible


@pytest.mark.unit
def test_generationless_public_lifecycle_state_keeps_the_legacy_shape():
    state = {
        "game_type": "soccer",
        "session_id": "legacy-session",
        "lanlan_name": "Lan",
        "game_route_active": True,
        "preGameContext": {"initialMood": "happy"},
        "pre_game_context_source": "ai",
        "game_dialog_log": [{"text": "legacy dialogue"}],
        "pending_outputs": [],
        "_exit_flow_started": False,
    }

    visible = gr_runtime._public_route_state(state)

    assert visible["preGameContext"] == {"initialMood": "happy"}
    assert visible["pre_game_context_source"] == "ai"
    assert visible["game_dialog_log"] == [{"text": "legacy dialogue"}]
    assert visible["dialog_count"] == 1
    assert "_exit_flow_started" not in visible


@pytest.mark.unit
def test_route_generation_tombstones_are_exact_expiring_and_bounded(monkeypatch):
    clock = {"now": 100.0}
    monkeypatch.setattr(gr_runtime.time, "monotonic", lambda: clock["now"])

    gr_runtime._remember_game_route_end_before_start(
        "Lan",
        "drawing_guess",
        "sdk-shared-session",
        "route-A",
    )
    assert gr_runtime._consume_game_route_end_before_start(
        "Lan",
        "drawing_guess",
        "sdk-shared-session",
        "route-B",
    ) is False
    assert gr_runtime._consume_game_route_end_before_start(
        "Lan",
        "drawing_guess",
        "sdk-shared-session",
        "route-A",
    ) is True

    gr_runtime._remember_game_route_end_before_start(
        "Lan",
        "drawing_guess",
        "sdk-shared-session",
        "expired-route",
    )
    clock["now"] += gr_runtime._GAME_ROUTE_END_TOMBSTONE_TTL_SECONDS + 1
    assert gr_runtime._consume_game_route_end_before_start(
        "Lan",
        "drawing_guess",
        "sdk-shared-session",
        "expired-route",
    ) is False

    for index in range(gr_runtime._GAME_ROUTE_END_TOMBSTONE_LIMIT + 1):
        gr_runtime._remember_game_route_end_before_start(
            "Lan",
            "drawing_guess",
            "sdk-shared-session",
            f"bounded-{index}",
        )
    assert len(gr_runtime._game_route_end_tombstones) == (
        gr_runtime._GAME_ROUTE_END_TOMBSTONE_LIMIT
    )
    assert (
        "Lan",
        "drawing_guess",
        "sdk-shared-session",
        "bounded-0",
    ) not in gr_runtime._game_route_end_tombstones


@pytest.mark.unit
@pytest.mark.asyncio
async def test_route_start_binds_generation_without_exposing_it(monkeypatch):
    _gr_patch_all(monkeypatch, "get_session_manager", lambda: {})

    result = await gr_runtime.game_route_start(
        "drawing_guess",
        _FakeRequest(_route_payload(route_instance_id="route-A")),
    )
    state = gr_runtime._get_active_game_route_state("Lan", "drawing_guess")

    assert result["ok"] is True
    assert result["state"]["game_route_active"] is True
    assert state is not None
    assert state["_sdk_route_instance_id"] == "route-A"
    assert "sdk_route_instance_id" not in result["state"]
    assert "_sdk_route_instance_id" not in result["state"]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_route_start_retry_retires_its_unresolved_generation(monkeypatch):
    _gr_patch_all(monkeypatch, "get_session_manager", lambda: {})

    retry = await gr_runtime.game_route_start(
        "drawing_guess",
        _FakeRequest(_route_payload(
            route_instance_id="route-B",
            candidates=["route-B", "route-A"],
        )),
    )
    delayed_original = await gr_runtime.game_route_start(
        "drawing_guess",
        _FakeRequest(_route_payload(route_instance_id="route-A")),
    )
    surviving = gr_runtime._get_active_game_route_state("Lan", "drawing_guess")

    assert retry["ok"] is True
    assert delayed_original == {
        "ok": True,
        "reason": "ended_before_start",
        "state": {"game_route_active": False},
    }
    assert surviving is not None
    assert surviving["game_route_active"] is True
    assert surviving["_sdk_route_instance_id"] == "route-B"


@pytest.mark.unit
@pytest.mark.asyncio
@pytest.mark.parametrize("stale_generation", [None, "route-A"])
async def test_route_heartbeat_rejects_stale_generation_without_mutation(
    monkeypatch,
    stale_generation,
):
    language_updates = []
    manager = SimpleNamespace(
        is_active=False,
        user_language="en",
        set_user_language=language_updates.append,
    )
    _gr_patch_all(monkeypatch, "get_session_manager", lambda: {"Lan": manager})
    state = _sdk_state()
    state["last_heartbeat_at"] = 10.0
    state["last_activity"] = 11.0
    state["last_state"] = {"owner": "route-B"}
    state["_last_canvas_image_data_url"] = "data:image/jpeg;base64,OLD"
    payload = _route_payload(
        currentState={"owner": "route-A"},
        canvas_image_data_url="data:image/jpeg;base64,NEW",
        i18n_language="ja",
    )
    if stale_generation is not None:
        payload["sdk_route_instance_id"] = stale_generation

    result = await gr_runtime.game_route_heartbeat(
        "drawing_guess",
        _FakeRequest(payload),
    )

    assert result["ok"] is False
    assert result["active"] is False
    assert result["reason"] == "route_instance_id_mismatch"
    assert state["last_heartbeat_at"] == 10.0
    assert state["last_activity"] == 11.0
    assert state["last_state"] == {"owner": "route-B"}
    assert state["_last_canvas_image_data_url"] == "data:image/jpeg;base64,OLD"
    assert language_updates == []


@pytest.mark.unit
@pytest.mark.asyncio
async def test_route_drain_rejects_stale_generation_without_consuming_outputs(
    monkeypatch,
):
    language_updates = []
    manager = SimpleNamespace(
        is_active=False,
        user_language="en",
        set_user_language=language_updates.append,
    )
    _gr_patch_all(monkeypatch, "get_session_manager", lambda: {"Lan": manager})
    state = _sdk_state()
    state["pending_outputs"] = [{"type": "first"}, {"type": "second"}]
    state["last_state"] = {"owner": "route-B"}
    state["_last_canvas_image_data_url"] = "data:image/jpeg;base64,OLD"

    stale = await gr_runtime.game_route_drain(
        "drawing_guess",
        _FakeRequest(_route_payload(
            route_instance_id="route-A",
            currentState={"owner": "route-A"},
            canvas_image_data_url="data:image/jpeg;base64,NEW",
            i18n_language="ja",
        )),
    )

    assert stale["ok"] is False
    assert stale["reason"] == "route_instance_id_mismatch"
    assert stale["outputs"] == []
    assert state["pending_outputs"] == [
        {"type": "first"},
        {"type": "second"},
    ]
    assert state["last_state"] == {"owner": "route-B"}
    assert state["_last_canvas_image_data_url"] == "data:image/jpeg;base64,OLD"
    assert language_updates == []

    matching = await gr_runtime.game_route_drain(
        "drawing_guess",
        _FakeRequest(_route_payload(route_instance_id="route-B")),
    )
    assert matching["ok"] is True
    assert matching["outputs"] == [{"type": "first"}, {"type": "second"}]
    assert state["pending_outputs"] == []


@pytest.mark.unit
@pytest.mark.asyncio
@pytest.mark.parametrize("stale_generation", [None, "route-A"])
async def test_stale_route_end_does_not_close_reused_session_generation(
    monkeypatch,
    stale_generation,
):
    _gr_patch_all(monkeypatch, "get_session_manager", lambda: {})
    postgame = AsyncMock(return_value={"ok": True, "action": "skip"})
    _gr_patch_all(monkeypatch, "_deliver_game_postgame", postgame)
    state = _sdk_state()
    payload = _route_payload(reason="delayed-old-end")
    if stale_generation is not None:
        payload["sdk_route_instance_id"] = stale_generation

    result = await gr_runtime._complete_game_end_from_payload(
        "drawing_guess",
        payload,
    )

    assert result == {
        "ok": True,
        "closed": False,
        "route_closed": False,
        "session_id": "sdk-shared-session",
        "reason": "stale_route_instance",
    }
    assert state["game_route_active"] is True
    assert state["_sdk_route_instance_id"] == "route-B"
    postgame.assert_not_awaited()
    tombstones = getattr(gr_runtime, "_game_route_end_tombstones", {})
    stale_key = (
        "Lan",
        "drawing_guess",
        "sdk-shared-session",
        "route-A",
    )
    if stale_generation is None:
        assert stale_key not in tombstones
    else:
        assert stale_key in tombstones
        delayed_start = await gr_runtime.game_route_start(
            "drawing_guess",
            _FakeRequest(_route_payload(route_instance_id=stale_generation)),
        )
        assert delayed_start == {
            "ok": True,
            "reason": "ended_before_start",
            "state": {"game_route_active": False},
        }
        assert gr_runtime._get_active_game_route_state("Lan", "drawing_guess") is state


@pytest.mark.unit
@pytest.mark.asyncio
async def test_route_end_candidates_close_committed_generation_and_retire_the_rest(
    monkeypatch,
):
    _gr_patch_all(monkeypatch, "get_session_manager", lambda: {})
    _gr_patch_all(
        monkeypatch,
        "_deliver_game_postgame",
        AsyncMock(return_value={"ok": True, "action": "skip"}),
    )
    state = _sdk_state(route_instance_id="route-A")

    result = await gr_runtime._complete_game_end_from_payload(
        "drawing_guess",
        _route_payload(
            route_instance_id="route-B",
            candidates=["route-B", "route-A"],
            reason="pagehide",
        ),
    )

    assert result["ok"] is True
    assert result["route_closed"] is True
    assert state["game_route_active"] is False
    assert (
        "Lan",
        "drawing_guess",
        "sdk-shared-session",
        "route-B",
    ) in gr_runtime._game_route_end_tombstones
    assert (
        "Lan",
        "drawing_guess",
        "sdk-shared-session",
        "route-A",
    ) not in gr_runtime._game_route_end_tombstones


@pytest.mark.unit
@pytest.mark.asyncio
async def test_route_end_before_start_consumes_the_exact_generation(monkeypatch):
    _gr_patch_all(monkeypatch, "get_session_manager", lambda: {})

    ended = await gr_runtime._complete_game_end_from_payload(
        "drawing_guess",
        _route_payload(route_instance_id="route-A", reason="pagehide"),
    )
    key = (
        "Lan",
        "drawing_guess",
        "sdk-shared-session",
        "route-A",
    )
    assert ended["ok"] is True
    assert ended["route_closed"] is False
    assert key in gr_runtime._game_route_end_tombstones

    started = await gr_runtime.game_route_start(
        "drawing_guess",
        _FakeRequest(_route_payload(route_instance_id="route-A")),
    )

    assert started == {
        "ok": True,
        "reason": "ended_before_start",
        "state": {"game_route_active": False},
    }
    assert key not in gr_runtime._game_route_end_tombstones
    assert gr_runtime._get_active_game_route_state("Lan", "drawing_guess") is None


@pytest.mark.unit
@pytest.mark.asyncio
async def test_generationless_lifecycle_keeps_session_only_compatibility(monkeypatch):
    _gr_patch_all(monkeypatch, "get_session_manager", lambda: {})
    _gr_patch_all(
        monkeypatch,
        "_deliver_game_postgame",
        AsyncMock(return_value={"ok": True, "action": "skip"}),
    )

    started = await gr_runtime.game_route_start(
        "drawing_guess",
        _FakeRequest(_route_payload()),
    )
    state = gr_runtime._get_active_game_route_state("Lan", "drawing_guess")
    assert started["ok"] is True
    assert state is not None
    assert "_sdk_route_instance_id" not in state
    assert "preGameContext" in started["state"]

    heartbeat = await gr_runtime.game_route_heartbeat(
        "drawing_guess",
        _FakeRequest({"lanlan_name": "Lan"}),
    )
    assert heartbeat["ok"] is True
    assert heartbeat["active"] is True

    state["pending_outputs"] = [{"type": "legacy-output"}]
    drained = await gr_runtime.game_route_drain(
        "drawing_guess",
        _FakeRequest({"lanlan_name": "Lan"}),
    )
    assert drained["ok"] is True
    assert drained["outputs"] == [{"type": "legacy-output"}]

    ended = await gr_runtime._complete_game_end_from_payload(
        "drawing_guess",
        _route_payload(reason="legacy-end"),
    )
    assert ended["ok"] is True
    assert ended["route_closed"] is True
    assert state["game_route_active"] is False
    tombstones = getattr(gr_runtime, "_game_route_end_tombstones", {})
    assert not tombstones
