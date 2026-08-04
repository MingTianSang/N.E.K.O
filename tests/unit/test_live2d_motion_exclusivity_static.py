from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
LIVE2D_MODEL_PATH = PROJECT_ROOT / "static" / "live2d" / "live2d-model.js"
LIVE2D_INTERACTION_PATH = PROJECT_ROOT / "static" / "live2d" / "live2d-interaction.js"
MODEL_RELOAD_PATH = (
    PROJECT_ROOT
    / "static"
    / "app"
    / "app-interpage"
    / "bootstrap-resources-and-model-reload.js"
)


def test_idle_motion_starts_with_idle_priority():
    source = LIVE2D_MODEL_PATH.read_text(encoding="utf-8")
    idle_start = source[
        source.index("const startTrackedMotion = async") : source.index(
            "// 配置已加载的模型", source.index("const startTrackedMotion = async")
        )
    ]

    tracked_idle_call = (
        "motionManager.startMotion(\n"
        "                groupName,\n"
        "                index,\n"
        "                LIVE2D_MOTION_PRIORITY.IDLE"
    )
    random_idle_call = (
        "motionManager.startRandomMotion(\n"
        "            'Idle',\n"
        "            LIVE2D_MOTION_PRIORITY.IDLE"
    )
    assert tracked_idle_call in idle_start
    assert random_idle_call in idle_start


def test_main_action_entry_rejects_a_second_action_and_stops_only_idle():
    source = LIVE2D_MODEL_PATH.read_text(encoding="utf-8")
    action_start = source.index("Live2DManager.prototype.playActionMotion")
    action_end = source.index("// 缓动函数集合", action_start)
    action_source = source[action_start:action_end]

    assert "this.hasActiveActionMotion(model)" in action_source
    assert "return false" in action_source
    assert "currentPriority === LIVE2D_MOTION_PRIORITY.IDLE" in action_source
    assert "motionManager.stopAllMotions()" in action_source
    assert "LIVE2D_MOTION_PRIORITY.NORMAL" in action_source
    assert "return started === undefined ? true : started" in action_source


def test_touch_actions_use_normal_priority_without_force_preemption():
    source = LIVE2D_INTERACTION_PATH.read_text(encoding="utf-8")
    touch_start = source.index("Live2DManager.prototype._playTouchSetAnimation")
    touch_source = source[touch_start:]

    assert "this.playActionMotion(groupName, 0)" in touch_source
    assert "live2dModel.motion(groupName, 0, 3)" not in touch_source


def test_all_main_runtime_motion_entry_points_use_the_single_action_gate():
    emotion_source = (
        PROJECT_ROOT / "static" / "live2d" / "live2d-emotion.js"
    ).read_text(encoding="utf-8")
    interaction_source = LIVE2D_INTERACTION_PATH.read_text(encoding="utf-8")
    performance_source = (
        PROJECT_ROOT / "static" / "avatar" / "avatar-performance-stage.js"
    ).read_text(encoding="utf-8")

    assert "await this.playActionMotion(" in emotion_source
    assert interaction_source.count("await this.playActionMotion(") >= 3
    assert performance_source.count("manager.playActionMotion(") >= 2


def test_saved_idle_motion_does_not_use_force_priority():
    source = MODEL_RELOAD_PATH.read_text(encoding="utf-8")
    restore_start = source.index("async function restoreLive2DIdleAnimationOnMainPage")
    restore_end = source.index("window.restoreLive2DIdleAnimationOnMainPage", restore_start)
    restore_source = source[restore_start:restore_end]

    assert "live2dManager.hasActiveActionMotion(live2dModel)" in restore_source
    action_guard_index = restore_source.index(
        "live2dManager.hasActiveActionMotion(live2dModel)"
    )
    stop_idle_index = restore_source.index("motionManager.stopAllMotions()")
    assert action_guard_index < stop_idle_index
    assert "LIVE2D_MOTION_PRIORITY.IDLE" in restore_source
    assert "live2dModel.motion(groupName, motionIndex, 3)" not in restore_source
