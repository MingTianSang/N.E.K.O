import json
import shutil
import subprocess
from pathlib import Path

import pytest

from tests.node_harness import run_node_stdin


ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / "static" / "live2d" / "live2d-model.js"
EMOTION = ROOT / "static" / "live2d" / "live2d-emotion.js"


def _run_node(body: str, *, emotion: bool = False) -> subprocess.CompletedProcess[str]:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node not found")
    load_emotion = (
        f"vm.runInContext(fs.readFileSync({json.dumps(str(EMOTION))}, 'utf8'), context);"
        if emotion
        else ""
    )
    script = f"""
    const assert = require('node:assert');
    const fs = require('node:fs');
    const vm = require('node:vm');
    const context = {{
      console: {{ log() {{}}, warn() {{}}, error() {{}} }}, window: {{}},
      Live2DManager: function Live2DManager() {{}},
      setTimeout, clearTimeout, setInterval, clearInterval,
      requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
      cancelAnimationFrame: clearTimeout, performance: {{ now: Date.now }},
    }};
    context.global = context;
    context.window.Live2DManager = context.Live2DManager;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync({json.dumps(str(MODEL))}, 'utf8'), context);
    {load_emotion}
    {body}
    """
    return run_node_stdin(
        node, script, capture_output=True, cwd=ROOT, timeout=10, check=False
    )


def test_motion_slot_rejects_actions_and_replaces_idle_without_races():
    result = _run_node(
        """
        (async () => {
          function makeMotionManager(events = [], override = null) {
            const state = {
              currentPriority: 0, reservePriority: 0,
              setCurrent(g, i, p) { Object.assign(this, { currentGroup: g, currentIndex: i, currentPriority: p }); },
              setReserved(g, i, p) { Object.assign(this, { reservedGroup: g, reservedIndex: i, reservePriority: p }); },
              setReservedIdle(g, i) { Object.assign(this, { reservedIdleGroup: g, reservedIdleIndex: i }); },
              complete() { this.setCurrent(undefined, undefined, 0); },
            };
            return {
              state,
              stopAllMotions() {
                events.push('stop'); state.complete();
                state.setReserved(undefined, undefined, 0); state.setReservedIdle(undefined, undefined);
              },
              _stopAllMotions() { events.push('stop-stale-idle'); },
              startMotion(group, index, priority) {
                priority === 1 ? state.setReservedIdle(group, index) : state.setReserved(group, index, priority);
                if (override) return override(state, group, index, priority);
                priority === 1 ? state.setReservedIdle(undefined, undefined) : state.setReserved(undefined, undefined, 0);
                state.setCurrent(group, index, priority); events.push(`start:${group}`); return true;
              },
              startRandomMotion(group, priority) { return this.startMotion(group, 0, priority); },
            };
          }
          const makeModel = (mm) => ({
            internalModel: { motionManager: mm },
            motion(group, index, priority) { return mm.startMotion(group, index, priority); },
          });
          const busyMM = makeMotionManager();
          busyMM.state.setCurrent('Busy', 0, 2);
          const busy = new context.Live2DManager(); busy.currentModel = makeModel(busyMM);
          assert.strictEqual(await busy.playActionMotion('Next', 0), false);
          assert.strictEqual(busyMM.state.currentGroup, 'Busy');
          const actionEvents = [], actionMM = makeMotionManager(actionEvents);
          actionMM.state.setCurrent('Idle', 0, 1);
          const action = new context.Live2DManager(); action.currentModel = makeModel(actionMM);
          action._clearMotionTimer = () => actionEvents.push('clear-timer');
          assert.strictEqual(await action.playActionMotion('Tap', 0), true);
          assert.deepStrictEqual(actionEvents, ['clear-timer', 'start:Tap']);
          const failedMM = makeMotionManager([], () => false);
          const failed = new context.Live2DManager(); failed.currentModel = makeModel(failedMM);
          assert.strictEqual(await failed.playActionMotion('Missing', 0), false);
          assert.strictEqual(failedMM.state.reservedGroup, undefined);
          assert.strictEqual(await failed.playIdleMotion('Idle', 0), false);
          assert.strictEqual(failedMM.state.reservedIdleGroup, undefined);
          const idleEvents = [], idleMM = makeMotionManager(idleEvents);
          idleMM.state.setCurrent('OldIdle', 0, 1);
          const idle = new context.Live2DManager(); idle.currentModel = makeModel(idleMM);
          idle._clearMotionTimer = () => idleEvents.push('clear-timer');
          assert.strictEqual(await idle.playIdleMotion('SavedIdle', 0), true);
          assert.deepStrictEqual(idleEvents, ['clear-timer', 'stop', 'start:SavedIdle']);
          let resolveIdle, resolveAction;
          const deferredMM = makeMotionManager([], (state, group, index, priority) => new Promise((resolve) => {
            const finish = () => {
              priority === 1 ? state.setReservedIdle(undefined, undefined) : state.setReserved(undefined, undefined, 0);
              state.setCurrent(group, index, priority); resolve(true);
            };
            if (priority === 1) resolveIdle = finish; else resolveAction = finish;
          }));
          const manager = new context.Live2DManager(); manager.currentModel = makeModel(deferredMM);
          manager._clearMotionTimer = () => {};
          const idlePromise = manager.playIdleMotion('Idle', 0);
          const actionPromise = manager.playActionMotion('Tap', 0);
          resolveIdle();
          assert.strictEqual(await idlePromise, false);
          assert.strictEqual(deferredMM.state.currentPriority, 1);
          assert.strictEqual(deferredMM.state.reservePriority, 2);
          resolveAction();
          assert.strictEqual(await actionPromise, true);
          assert.strictEqual(deferredMM.state.currentPriority, 2);
        })().catch((error) => { console.error(error); process.exitCode = 1; });
        """
    )
    assert result.returncode == 0, result.stderr


def test_expression_slot_replaces_transient_expression_but_preserves_action():
    result = _run_node(
        """
        (async () => {
          const manager = new context.Live2DManager();
          const state = { currentPriority: 2, reservePriority: 0 };
          manager.currentModel = { internalModel: { motionManager: { state } } };
          Object.assign(manager, {
            emotionMapping: { expressions: { happy: ['happy.exp3.json'] }, motions: {} },
            fileReferences: { Expressions: [] }, currentEmotion: 'neutral',
            currentExpressionFile: 'neutral.exp3.json', isEmotionChanging: true,
            getRandomElement: (items) => items[0],
            isAvatarPerformanceCapabilityLocked: () => false,
            _cancelSmoothReset: () => {},
            smoothResetToInitialState: async () => { throw new Error('must preserve active action'); },
            applyPersistentExpressionsNative: async () => { manager.persistentApplied = true; },
          });
          manager.resetTransientMotionAndExpressionState = async (options) => { manager.resetOptions = options; };
          manager.playExpression = async () => { manager.expressionPlayed = true; return true; };
          manager.playMotion = async () => { manager.motionAttempted = true; return false; };
          assert.strictEqual(await manager.setEmotion('happy'), true);
          assert.strictEqual(manager.expressionPlayed && manager.motionAttempted, true);
          assert.strictEqual(manager.resetOptions.preserveMotion, true);
          assert.strictEqual(state.currentPriority, 2);
          assert.strictEqual(manager.persistentApplied, true);
          const expressions = new context.Live2DManager(), resolvers = {};
          expressions.currentModel = {
            internalModel: { motionManager: { state: { currentPriority: 0, reservePriority: 0 } } },
            expression(name) { return new Promise((resolve) => { resolvers[name] = resolve; }); },
          };
          expressions.isAvatarPerformanceCapabilityLocked = () => false;
          expressions.resolveExpressionReferenceByFile = (file) => ({ name: file[0], file });
          expressions.resolveAssetPath = (file) => file;
          expressions.clearExpression = function() {
            this.clearCount = (this.clearCount || 0) + 1;
            assert.strictEqual(arguments[0].preserveMotion, true);
            this._transientExpressionGeneration = (this._transientExpressionGeneration || 0) + 1;
          };
          expressions.applyPersistentExpressionsNative = async () => {};
          context.fetch = async () => ({ ok: true, json: async () => ({ Parameters: [] }) });
          const first = expressions.playExpression('first', 'a.exp3.json');
          while (!resolvers.a) await new Promise((resolve) => setTimeout(resolve, 0));
          const second = expressions.playExpression('second', 'b.exp3.json');
          while (!resolvers.b) await new Promise((resolve) => setTimeout(resolve, 0));
          resolvers.b(true); assert.strictEqual(await second, true);
          resolvers.a(true); assert.strictEqual(await first, false);
          assert.strictEqual(expressions.clearCount, 2);
        })().catch((error) => { console.error(error); process.exitCode = 1; });
        """,
        emotion=True,
    )
    assert result.returncode == 0, result.stderr


def test_all_runtime_entries_use_the_central_slots_before_side_effects():
    model = MODEL.read_text(encoding="utf-8")
    emotion = EMOTION.read_text(encoding="utf-8")
    interaction = (ROOT / "static/live2d/live2d-interaction.js").read_text(encoding="utf-8")
    performance = (ROOT / "static/avatar/avatar-performance-stage.js").read_text(
        encoding="utf-8"
    )
    restore = (
        ROOT / "static/app/app-interpage/bootstrap-resources-and-model-reload.js"
    ).read_text(encoding="utf-8")
    acquire = performance[
        performance.index("acquireSession(session) {") : performance.index(
            "releaseSession(session) {", performance.index("acquireSession(session) {")
        )
    ]

    assert interaction.count("await this.playActionMotion(") >= 3
    assert performance.count("manager.playActionMotion(") >= 2
    assert "await this.playExpression(randomExpression.Name, randomExpression.File)" in interaction
    assert "live2dManager.playIdleMotion(groupName, motionIndex)" in restore
    assert "live2dModel.motion(groupName, motionIndex, 3)" not in restore
    assert acquire.index("manager.hasActiveActionMotion(model)") < acquire.index(
        "manager.suspendTemporaryMotions("
    )
    action_slot = model[model.index("Live2DManager.prototype.playActionMotion") : model.index("Live2DManager.prototype.playIdleMotion")]
    assert "state.setReservedIdle(idleBlock, undefined)" in action_slot
    assert "state.reservedIdleGroup === idleBlock" in action_slot
    assert "await this._trackActiveMotionParametersFromFile(requestedFile)" in action_slot
    assert "this._actionMotionRequestPendingModel = model" in action_slot
    assert "if (this._actionMotionRequestPendingModel === model)" in model
    assert "await this.setEmotion('Idle', {" in model
    idle_fallback = model[model.index("const started = await this._startIdleMotion(expectedModel, 'Idle');") : model.index("Live2DManager.prototype._configureLoadedModel")]
    assert idle_fallback.index("if (!isCurrentIdleRequest()) return;") < idle_fallback.index("if (started === false)")

    clear_expression = emotion[emotion.index("Live2DManager.prototype.clearExpression") : emotion.index("Live2DManager.prototype._getActiveExpressionParamIds")]
    assert "expressionManager.reserveExpressionIndex = -1" in clear_expression
    recorded_reset = emotion[emotion.index("Live2DManager.prototype._resetRecordedParameterIds") : emotion.index("Live2DManager.prototype._getDefaultMotionParameterIds")]
    assert "options.preserveMotion === true" in recorded_reset
    assert "this.clearExpression({ preserveMotion: true })" in interaction
    motion_start_index = emotion.index("const motion = options.motionPriority")
    first_motion_check = emotion.index("if (motion) {", motion_start_index)
    motion_start = emotion[motion_start_index : emotion.index("if (motion) {", first_motion_check + 1)]
    assert motion_start.index("motionTimerGuardGeneration = this._motionTimerGeneration || 0") < motion_start.index("if (!isCurrentMotionInvocation()) return false")
