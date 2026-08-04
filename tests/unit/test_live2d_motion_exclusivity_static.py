import json
import shutil
import subprocess
import textwrap
from pathlib import Path

import pytest

from tests.node_harness import run_node_stdin


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


def _run_node_harness(script: str) -> subprocess.CompletedProcess[str]:
    node_executable = shutil.which("node")
    if node_executable is None:
        pytest.skip("node not found")
    return run_node_stdin(
        node_executable,
        script,
        capture_output=True,
        cwd=PROJECT_ROOT,
        timeout=10,
        check=False,
    )


def _manager_harness(body: str) -> str:
    return textwrap.dedent(
        f"""
        const assert = require('node:assert');
        const fs = require('node:fs');
        const vm = require('node:vm');
        const context = {{
          console: {{ log() {{}}, warn() {{}}, error() {{}} }},
          window: {{}},
          Live2DManager: function Live2DManager() {{}},
          setTimeout, clearTimeout, setInterval, clearInterval,
        }};
        context.global = context;
        context.window.Live2DManager = context.Live2DManager;
        vm.createContext(context);
        vm.runInContext(fs.readFileSync({json.dumps(str(LIVE2D_MODEL_PATH))}, 'utf8'), context);
        {body}
        """
    )


def test_idle_motion_starts_with_idle_priority():
    source = LIVE2D_MODEL_PATH.read_text(encoding="utf-8")
    idle_method_start = source.index("Live2DManager.prototype._playIdleMotion")
    idle_start = source[
        idle_method_start : source.index("// 配置已加载的模型", idle_method_start)
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
    assert idle_start.count("canStartIdleMotion()") >= 2
    assert "!this.hasActiveActionMotion(expectedModel)" in idle_start


def test_main_action_entry_rejects_a_second_action_and_stops_only_idle():
    source = LIVE2D_MODEL_PATH.read_text(encoding="utf-8")
    action_start = source.index("Live2DManager.prototype.playActionMotion")
    action_end = source.index("// 缓动函数集合", action_start)
    action_source = source[action_start:action_end]

    assert "this.hasActiveActionMotion(model)" in action_source
    assert "this._simpleMotionActive === true" in source
    assert "return false" in action_source
    assert "currentPriority === LIVE2D_MOTION_PRIORITY.IDLE" in action_source
    assert "this._clearMotionTimer()" in action_source
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


def test_emotion_motion_checks_the_gate_before_resetting_existing_motion():
    source = (
        PROJECT_ROOT / "static" / "live2d" / "live2d-emotion.js"
    ).read_text(encoding="utf-8")
    play_motion_start = source.index("Live2DManager.prototype.playMotion")
    play_motion_end = source.index("// 播放简单动作", play_motion_start)
    play_motion_source = source[play_motion_start:play_motion_end]
    set_emotion_start = source.index("Live2DManager.prototype.setEmotion")
    set_emotion_end = source.index("// 同步服务器端的情绪映射", set_emotion_start)
    set_emotion_source = source[set_emotion_start:set_emotion_end]

    for block in (play_motion_source, set_emotion_source):
        action_guard_index = block.index("this.hasActiveActionMotion(this.currentModel)")
        reset_index = block.index("resetTransientMotionAndExpressionState")
        assert action_guard_index < reset_index

    smooth_reset_index = set_emotion_source.index("smoothResetToInitialState")
    guard_after_smooth_reset = set_emotion_source.index(
        "this.hasActiveActionMotion(this.currentModel)", smooth_reset_index
    )
    destructive_reset_index = set_emotion_source.index(
        "resetTransientMotionAndExpressionState", smooth_reset_index
    )
    assert smooth_reset_index < guard_after_smooth_reset < destructive_reset_index


def test_simple_motion_fallback_does_not_overlap_an_action():
    source = (
        PROJECT_ROOT / "static" / "live2d" / "live2d-emotion.js"
    ).read_text(encoding="utf-8")
    play_motion_start = source.index("Live2DManager.prototype.playMotion")
    play_motion_end = source.index("// 播放简单动作", play_motion_start)
    play_motion_source = source[play_motion_start:play_motion_end]
    motion_result_index = play_motion_source.index("const motion =")
    late_action_guard_index = play_motion_source.index(
        "this.hasActiveActionMotion(this.currentModel)", motion_result_index
    )
    simple_fallback_index = play_motion_source.index(
        "this.playSimpleMotion(emotion)", motion_result_index
    )
    assert motion_result_index < late_action_guard_index < simple_fallback_index

    simple_start = source.index("Live2DManager.prototype.playSimpleMotion")
    simple_end = source.index("// 清理当前情感效果", simple_start)
    simple_source = source[simple_start:simple_end]
    centralized_guard_index = simple_source.index(
        "this.hasActiveActionMotion(this.currentModel)"
    )
    parameter_write_index = simple_source.index("_setActiveMotionParamIds")
    assert centralized_guard_index < parameter_write_index
    assert "this._simpleMotionActive = true" in simple_source

    clear_timer_start = source.index("Live2DManager.prototype._clearMotionTimer")
    clear_timer_end = source.index(
        "Live2DManager.prototype._resetExplicitMotionParameters", clear_timer_start
    )
    assert "this._simpleMotionActive = false" in source[clear_timer_start:clear_timer_end]


def test_startup_idle_emotion_uses_idle_priority():
    source = LIVE2D_MODEL_PATH.read_text(encoding="utf-8")
    configure_start = source.index("Live2DManager.prototype._configureLoadedModel")
    configure_source = source[configure_start:]

    assert "this.setEmotion('Idle', {" in configure_source
    assert "motionPriority: LIVE2D_MOTION_PRIORITY.IDLE" in configure_source
    assert "Live2DManager.prototype.playIdleMotion" in source


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


def test_failed_action_start_clears_only_its_motion_reservation():
    script = _manager_harness(
        """
        (async () => {
          const events = [];
          const state = {
            currentPriority: 1,
            reservePriority: 0,
            reservedGroup: undefined,
            reservedIndex: undefined,
            reservedIdleGroup: 'Idle',
            setReserved(group, index, priority) {
              this.reservedGroup = group;
              this.reservedIndex = index;
              this.reservePriority = priority;
            },
          };
          const motionManager = {
            state,
            stopAllMotions() {
              events.push('stop-idle');
              state.currentPriority = 0;
              state.reservedIdleGroup = undefined;
            },
          };
          const manager = new context.Live2DManager();
          manager._clearMotionTimer = () => { events.push('clear-idle-timer'); };
          const model = {
            internalModel: { motionManager },
            async motion(group, index, priority) {
              events.push('start-action');
              state.setReserved(group, index, priority);
              throw new Error('load failed');
            },
          };
          manager.currentModel = model;

          await assert.rejects(manager.playActionMotion('Tap', 0), /load failed/);
          assert.deepStrictEqual(events, ['clear-idle-timer', 'stop-idle', 'start-action']);
          assert.strictEqual(state.reservePriority, 0);
          assert.strictEqual(state.reservedGroup, undefined);
          assert.strictEqual(state.reservedIndex, undefined);

          model.motion = async (group, index, priority) => {
            state.setReserved(group, index, priority);
            return false;
          };
          assert.strictEqual(await manager.playActionMotion('Missing', undefined), false);
          assert.strictEqual(state.reservePriority, 0);
          assert.strictEqual(state.reservedGroup, undefined);
          assert.strictEqual(state.reservedIndex, undefined);
        })().catch((error) => { console.error(error); process.exitCode = 1; });
        """
    )
    result = _run_node_harness(script)
    assert result.returncode == 0, result.stderr


def test_model_removal_clears_simple_motion_gate_with_motion_timer():
    script = _manager_harness(
        """
        (async () => {
          let timerClears = 0;
          const manager = new context.Live2DManager();
          manager._simpleMotionActive = true;
          manager.motionTimer = { type: 'timeout', id: 123 };
          manager._clearMotionTimer = () => {
            timerClears += 1;
            manager._simpleMotionActive = false;
            manager.motionTimer = null;
          };

          await manager.removeModel({ skipCloseWindows: true });
          assert.strictEqual(timerClears, 1);
          assert.strictEqual(manager._simpleMotionActive, false);
          assert.strictEqual(manager.motionTimer, null);
        })().catch((error) => { console.error(error); process.exitCode = 1; });
        """
    )
    result = _run_node_harness(script)
    assert result.returncode == 0, result.stderr


def test_action_invalidates_an_idle_motion_that_finishes_loading_late():
    script = _manager_harness(
        """
        (async () => {
          let resolveIdle;
          let resolveAction;
          let stopCount = 0;
          const state = {
            currentPriority: 0,
            reservePriority: 0,
            currentGroup: undefined,
            currentIndex: undefined,
            reservedGroup: undefined,
            reservedIndex: undefined,
            reservedIdleGroup: 'Idle',
            reservedIdleIndex: 0,
            setReserved(group, index, priority) {
              this.reservedGroup = group;
              this.reservedIndex = index;
              this.reservePriority = priority;
            },
            setCurrent(group, index, priority) {
              this.currentGroup = group;
              this.currentIndex = index;
              this.currentPriority = priority;
            },
          };
          const motionManager = {
            state,
            definitions: { Idle: [{ File: 'idle.motion3.json' }] },
            motionGroups: {},
            startMotion() {
              return new Promise((resolve) => {
                resolveIdle = () => {
                  state.reservedIdleGroup = undefined;
                  state.reservedIdleIndex = undefined;
                  state.setCurrent('Idle', 0, 1);
                  resolve(true);
                };
              });
            },
            startRandomMotion: async () => false,
            stopAllMotions() {
              stopCount += 1;
              state.setCurrent(undefined, undefined, 0);
              state.setReserved(undefined, undefined, 0);
              state.reservedIdleGroup = undefined;
              state.reservedIdleIndex = undefined;
            },
          };
          const manager = new context.Live2DManager();
          manager.isAvatarPerformanceCapabilityLocked = () => false;
          manager._clearMotionTimer = () => {};
          manager._clearActiveMotionParamIds = () => {};
          manager._trackActiveMotionParametersFromFile = async () => {};
          const model = {
            destroyed: false,
            internalModel: { motionManager },
            motion(group, index, priority) {
              state.setReserved(group, index, priority);
              return new Promise((resolve) => {
                resolveAction = () => {
                  state.setReserved(undefined, undefined, 0);
                  state.setCurrent(group, index, priority);
                  resolve(true);
                };
              });
            },
          };
          manager.currentModel = model;

          const idlePromise = manager._playIdleMotion(motionManager);
          const actionPromise = manager.playActionMotion('Tap', 0);
          assert.strictEqual(typeof resolveIdle, 'function');
          assert.strictEqual(typeof resolveAction, 'function');

          resolveIdle();
          await idlePromise;
          assert.strictEqual(stopCount, 2);
          assert.strictEqual(state.currentPriority, 0);
          assert.strictEqual(state.reservePriority, 2);
          assert.strictEqual(state.reservedGroup, 'Tap');
          assert.strictEqual(state.reservedIndex, 0);

          resolveAction();
          assert.strictEqual(await actionPromise, true);
          assert.strictEqual(state.currentPriority, 2);
          assert.strictEqual(state.currentGroup, 'Tap');
        })().catch((error) => { console.error(error); process.exitCode = 1; });
        """
    )
    result = _run_node_harness(script)
    assert result.returncode == 0, result.stderr


def test_performance_session_checks_action_gate_before_suspending_motions():
    source = (
        PROJECT_ROOT / "static" / "avatar" / "avatar-performance-stage.js"
    ).read_text(encoding="utf-8")
    acquire_start = source.index("acquireSession(session) {")
    acquire_end = source.index("releaseSession(session) {", acquire_start)
    acquire_source = source[acquire_start:acquire_end]

    action_guard_index = acquire_source.index("manager.hasActiveActionMotion(model)")
    suspend_index = acquire_source.index("manager.suspendTemporaryMotions(")
    assert action_guard_index < suspend_index
    assert "if (!hasActiveAction)" in acquire_source
    assert "this.motionSuspendSource = '';" in acquire_source
