"""教程抑制不得把主动搭话的临时关闭态变成用户设置。

回归背景：首页教程对十个 proactive 键做多层内存抑制（头像重载控制器先关、
feature controller 后 begin），旧实现里 feature controller 的恢复快照读到的是
已被上一层关死的内存值，教程结束时"恢复"出全关；同时 saveSettings /
syncSettingsToServer / _markUserDirtySettings 都把抑制态当用户设置持久化，
关闭态经 localStorage、周期同步和跨窗口广播扩散后永久化。

这里钉住修复的三条不变量：
1. 两层抑制的快照都以持久化设置（project_neko_settings）为用户真值来源，
   内存值只做兜底；
2. 抑制激活期间，落盘 / POST / dirty 标记一律以持久化真值替换这十个键；
3. 教程收口恢复后回写一次 localStorage，纠正抑制期间漏网的关闭态。
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HOME_TUTORIAL_RUNTIME_PATH = ROOT / "static" / "tutorial" / "core" / "home-tutorial-runtime.js"
RELOAD_CONTROLLER_PATH = ROOT / "static" / "tutorial" / "avatar" / "reload-controller.js"
APP_SETTINGS_PATH = ROOT / "static" / "app" / "app-settings.js"

PROACTIVE_KEYS = (
    "proactiveChatEnabled",
    "proactiveVisionEnabled",
    "proactiveVisionChatEnabled",
    "proactiveNewsChatEnabled",
    "proactiveCommunityChatEnabled",
    "proactiveVideoChatEnabled",
    "proactivePersonalChatEnabled",
    "proactiveMusicEnabled",
    "proactiveMemeEnabled",
    "proactiveMiniGameInviteEnabled",
)


def _function_block(source: str, marker: str) -> str:
    return source.split(marker, 1)[1].split("\n    }", 1)[0]


def test_both_tutorial_layers_snapshot_persisted_user_truth_first():
    for path in (HOME_TUTORIAL_RUNTIME_PATH, RELOAD_CONTROLLER_PATH):
        source = path.read_text(encoding="utf-8")
        assert "function readPersistedProactiveSettings()" in source, path

        read_fn = _function_block(source, "function readPersistedProactiveSettings() {")
        assert "getItem('project_neko_settings')" in read_fn, path

        snapshot_fn = _function_block(source, "function snapshotProactiveState() {")
        # 持久化真值优先，内存镜像只做缺失键的兜底。
        assert "typeof persisted[key] === 'boolean'" in snapshot_fn, path
        assert snapshot_fn.index("readPersistedProactiveSettings()") < snapshot_fn.index(
            "typeof window[key] !== 'undefined'"
        ), path


def test_tutorial_restore_repersists_proactive_state():
    runtime = HOME_TUTORIAL_RUNTIME_PATH.read_text(encoding="utf-8")
    assert "function persistRestoredProactiveState()" in runtime
    persist_fn = _function_block(runtime, "function persistRestoredProactiveState() {")
    assert "skipServerSync: true," in persist_fn
    # 恢复回写必须带 tutorialProactiveRestore：那一刻抑制标记可能还没清完，
    # saveSettings 需要跳过 hold 护栏，让刚恢复的用户真值覆盖漏网的关闭态。
    assert "tutorialProactiveRestore: true" in persist_fn

    end_fn = _function_block(
        runtime, "function endHomeTutorialFeatureSuppression(reason) {"
    )
    assert "persistRestoredProactiveState();" in end_fn
    # 回写必须发生在快照恢复之后，写的才是恢复后的用户真值。
    assert end_fn.index("applyProactiveState(snapshot.proactive);") < end_fn.index(
        "persistRestoredProactiveState();"
    )

    reload_source = RELOAD_CONTROLLER_PATH.read_text(encoding="utf-8")
    assert "function persistRestoredProactiveState()" in reload_source
    restore_block = reload_source.split("restoreOverride()", 1)[1].split(
        "window.TutorialAvatarReloadController", 1
    )[0]
    assert "persistRestoredProactiveState();" in restore_block
    assert restore_block.index(
        "applyProactiveState(proactiveSnapshot, { restart: true });"
    ) < restore_block.index("persistRestoredProactiveState();")


def test_settings_hold_helper_covers_both_suppression_layers():
    source = APP_SETTINGS_PATH.read_text(encoding="utf-8")
    for key in PROACTIVE_KEYS:
        assert f"'{key}'" in source.split(
            "const _TUTORIAL_HELD_PROACTIVE_KEYS = [", 1
        )[1].split("];", 1)[0]

    active_fn = _function_block(
        source, "function _isTutorialProactiveSuppressionActive() {"
    )
    # feature controller 抑制……
    assert "window.NekoHomeTutorialFeatureController" in active_fn
    assert "controller.isActive()" in active_fn
    # ……以及头像重载控制器先行抑制的窗口期，两层都要识别。
    assert "window.universalTutorialManager" in active_fn
    assert "hasActiveOverride" in active_fn

    hold_fn = _function_block(source, "function _tutorialProactiveHoldValues() {")
    assert "_isTutorialProactiveSuppressionActive()" in hold_fn
    assert "localStorage.getItem('project_neko_settings')" in hold_fn
    assert "typeof persisted[key] === 'boolean'" in hold_fn


def test_settings_persistence_paths_apply_tutorial_hold():
    source = APP_SETTINGS_PATH.read_text(encoding="utf-8")

    # 落盘：saveSettings 在 _writeSharedSettings 之前还原这十个键；
    # 唯一的放行口是教程收口的恢复回写（tutorialProactiveRestore）。
    save_fn = source.split("function saveSettings(options)", 1)[1].split(
        "function loadSettings()", 1
    )[0]
    assert "if (!(options && options.tutorialProactiveRestore)) {" in save_fn
    assert "const tutorialProactiveHold = _tutorialProactiveHoldValues();" in save_fn
    assert save_fn.index(
        "if (tutorialProactiveHold) Object.assign(settings, tutorialProactiveHold);"
    ) < save_fn.index("_writeSharedSettings(")

    # POST：发送时快照同样过护栏（头像重载层单独抑制时 guard 不生效）。
    sync_fn = source.split(
        "async function syncSettingsToServer(options)", 1
    )[1].split("function startPeriodicSync()", 1)[0]
    assert sync_fn.index("const settings = getConversationSettings();") < sync_fn.index(
        "const sendHold = _tutorialProactiveHoldValues();"
    ) < sync_fn.index("await _fetchConversationSettingsJsonWithTimeout(")

    # dirty 标记：抑制不是用户意图，diff 前还原持久化真值。
    mark_fn = _function_block(source, "function _markUserDirtySettings() {")
    assert "const tutorialProactiveHold = _tutorialProactiveHoldValues();" in mark_fn
    assert mark_fn.index(
        "if (tutorialProactiveHold) Object.assign(current, tutorialProactiveHold);"
    ) < mark_fn.index("if (_settingsBaseline) {")

    # 优化决策确认的直接落盘路径也带护栏。
    ack_index = source.index("_writeSharedSettings(ackSettings, []);")
    ack_block = source[ack_index - 400:ack_index]
    assert "const ackHold = _tutorialProactiveHoldValues();" in ack_block
    assert "if (ackHold) Object.assign(ackSettings, ackHold);" in ack_block
