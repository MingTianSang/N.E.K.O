const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const reloadControllerSource = fs.readFileSync(
    path.join(__dirname, 'tutorial/avatar/reload-controller.js'),
    'utf8'
);

function loadReloadControllerWindow() {
    const window = {
        appState: {
            proactiveChatEnabled: true,
            proactiveVisionEnabled: true,
            proactiveVisionChatEnabled: true,
            proactiveNewsChatEnabled: false,
            proactiveVideoChatEnabled: true,
            proactivePersonalChatEnabled: false,
            proactiveMusicEnabled: true,
            proactiveMemeEnabled: false,
            proactiveMiniGameInviteEnabled: true
        },
        proactiveChatEnabled: true,
        proactiveVisionEnabled: true,
        proactiveVisionChatEnabled: true,
        proactiveNewsChatEnabled: false,
        proactiveVideoChatEnabled: true,
        proactivePersonalChatEnabled: false,
        proactiveMusicEnabled: true,
        proactiveMemeEnabled: false,
        proactiveMiniGameInviteEnabled: true,
        stopCalls: [],
        stopProactiveChatSchedule() {
            this.stopCalls.push('chat');
        },
        stopProactiveVisionDuringSpeech() {
            this.stopCalls.push('vision');
        },
        releaseProactiveVisionStream() {
            this.stopCalls.push('stream');
        },
        scheduleCalls: 0,
        scheduleProactiveChat() {
            this.scheduleCalls += 1;
        },
        setTimeout(fn, ms = 0) {
            return setTimeout(fn, ms);
        },
        clearTimeout
    };
    const context = vm.createContext({
        window,
        console,
        setTimeout,
        clearTimeout
    });
    vm.runInContext(reloadControllerSource, context, {
        filename: path.join(__dirname, 'tutorial/avatar/reload-controller.js')
    });
    return window;
}

test('tutorial avatar reload snapshots proactive chat and restores it after model restore', async () => {
    const window = loadReloadControllerWindow();
    const calls = [];
    const host = {
        constructor: {
            detectModelPrefix() {
                return 'live2d';
            }
        }
    };
    const controller = window.TutorialAvatarReloadController.createController({
        host,
        timeoutMs: 200,
        resolveCurrentName: () => Promise.resolve('LanLan'),
        fetchCharacters: () => Promise.resolve({
            '猫娘': {
                LanLan: {
                    model_type: 'live2d',
                    live2d: 'lanlan'
                }
            }
        }),
        buildSnapshotPayload: () => ({ model_type: 'live2d', live2d: 'lanlan' }),
        reloadModel: (name, payload, options) => {
            calls.push({ type: 'reload', name, payload, options });
            return Promise.resolve();
        },
        setPreparing: (value) => calls.push({ type: 'preparing', value }),
        revealPrepared: () => calls.push({ type: 'reveal' }),
        applyIdentityOverride: (payload) => calls.push({ type: 'identity', payload }),
        clearViewportWatcher: () => calls.push({ type: 'clearViewport' })
    });

    await controller.beginOverride();

    assert.equal(window.proactiveChatEnabled, false);
    assert.equal(window.appState.proactiveChatEnabled, false);
    assert.equal(window.proactiveVisionChatEnabled, false);
    assert.equal(window.appState.proactiveVisionChatEnabled, false);
    assert.deepEqual(window.stopCalls, ['chat', 'vision', 'stream']);

    await controller.restoreOverride();

    assert.equal(window.proactiveChatEnabled, true);
    assert.equal(window.appState.proactiveChatEnabled, true);
    assert.equal(window.proactiveVisionChatEnabled, true);
    assert.equal(window.appState.proactiveVisionChatEnabled, true);
    assert.equal(window.proactiveNewsChatEnabled, false);
    assert.equal(window.appState.proactiveNewsChatEnabled, false);
    assert.equal(window.scheduleCalls, 1);
    assert.equal(calls.filter((call) => call.type === 'reload').length, 2);
});

test('tutorial avatar reload snapshots proactive chat when override starts, not when constructed', async () => {
    const window = loadReloadControllerWindow();
    window.proactiveChatEnabled = false;
    window.appState.proactiveChatEnabled = false;
    window.proactiveVisionChatEnabled = false;
    window.appState.proactiveVisionChatEnabled = false;

    const host = {
        constructor: {
            detectModelPrefix() {
                return 'live2d';
            }
        }
    };
    const controller = window.TutorialAvatarReloadController.createController({
        host,
        timeoutMs: 200,
        resolveCurrentName: () => {
            window.proactiveChatEnabled = true;
            window.appState.proactiveChatEnabled = true;
            window.proactiveVisionChatEnabled = true;
            window.appState.proactiveVisionChatEnabled = true;
            return Promise.resolve('LanLan');
        },
        fetchCharacters: () => Promise.resolve({
            '猫娘': {
                LanLan: {
                    model_type: 'live2d',
                    live2d: 'lanlan'
                }
            }
        }),
        buildSnapshotPayload: () => ({ model_type: 'live2d', live2d: 'lanlan' }),
        reloadModel: () => Promise.resolve(),
        setPreparing: () => {},
        revealPrepared: () => {},
        applyIdentityOverride: () => {},
        clearViewportWatcher: () => {}
    });

    await controller.beginOverride();
    await controller.restoreOverride();

    assert.equal(window.proactiveChatEnabled, true);
    assert.equal(window.appState.proactiveChatEnabled, true);
    assert.equal(window.proactiveVisionChatEnabled, true);
    assert.equal(window.appState.proactiveVisionChatEnabled, true);
    assert.equal(window.scheduleCalls, 1);
});

test('tutorial avatar reload snapshots persisted user truth when memory is already suppressed', async () => {
    const window = loadReloadControllerWindow();
    // 另一层抑制（或历史污染）已把内存关死；持久化设置仍保留用户真值。
    window.proactiveChatEnabled = false;
    window.appState.proactiveChatEnabled = false;
    window.proactiveVisionChatEnabled = false;
    window.appState.proactiveVisionChatEnabled = false;
    window.localStorage = {
        getItem(key) {
            if (key !== 'project_neko_settings') return null;
            return JSON.stringify({
                proactiveChatEnabled: true,
                proactiveVisionEnabled: true,
                proactiveVisionChatEnabled: true,
                proactiveNewsChatEnabled: false,
                proactiveVideoChatEnabled: true,
                proactivePersonalChatEnabled: false,
                proactiveMusicEnabled: true,
                proactiveMemeEnabled: false,
                proactiveMiniGameInviteEnabled: true
            });
        }
    };
    const saveCalls = [];
    window.appSettings = {
        saveSettings(options) {
            saveCalls.push(options || null);
        }
    };

    const host = {
        constructor: {
            detectModelPrefix() {
                return 'live2d';
            }
        }
    };
    const controller = window.TutorialAvatarReloadController.createController({
        host,
        timeoutMs: 200,
        resolveCurrentName: () => Promise.resolve('LanLan'),
        fetchCharacters: () => Promise.resolve({
            '猫娘': {
                LanLan: {
                    model_type: 'live2d',
                    live2d: 'lanlan'
                }
            }
        }),
        buildSnapshotPayload: () => ({ model_type: 'live2d', live2d: 'lanlan' }),
        reloadModel: () => Promise.resolve(),
        setPreparing: () => {},
        revealPrepared: () => {},
        applyIdentityOverride: () => {},
        clearViewportWatcher: () => {}
    });

    await controller.beginOverride();

    assert.equal(window.proactiveChatEnabled, false);
    assert.equal(window.appState.proactiveChatEnabled, false);
    assert.deepEqual(saveCalls, []);

    await controller.restoreOverride();

    // 恢复的是持久化用户真值（开），而不是 beginOverride 时的内存抑制态（关）。
    assert.equal(window.proactiveChatEnabled, true);
    assert.equal(window.appState.proactiveChatEnabled, true);
    assert.equal(window.proactiveVisionChatEnabled, true);
    assert.equal(window.appState.proactiveVisionChatEnabled, true);
    assert.equal(window.scheduleCalls, 1);
    // 恢复后立即回写一次，纠正抑制期间可能被写盘的关闭态。
    // （saveSettings 的参数对象诞生于 vm 上下文，prototype 与本上下文不同，
    // deepStrictEqual 会误报，故按属性断言。）
    assert.equal(saveCalls.length, 1);
    assert.equal(saveCalls[0] && saveCalls[0].skipServerSync, true);
    assert.equal(saveCalls[0] && saveCalls[0].tutorialProactiveRestore, true);
});

test('tutorial avatar reload does not overwrite proactive state restored by the tutorial lifecycle', async () => {
    const window = loadReloadControllerWindow();
    window.proactiveChatEnabled = false;
    window.appState.proactiveChatEnabled = false;
    window.proactiveVisionChatEnabled = false;
    window.appState.proactiveVisionChatEnabled = false;
    window.NekoHomeTutorialFeatureController = {
        isActive() {
            return true;
        }
    };

    const host = {
        constructor: {
            detectModelPrefix() {
                return 'live2d';
            }
        }
    };
    const controller = window.TutorialAvatarReloadController.createController({
        host,
        timeoutMs: 200,
        resolveCurrentName: () => Promise.resolve('LanLan'),
        fetchCharacters: () => Promise.resolve({
            '猫娘': {
                LanLan: {
                    model_type: 'live2d',
                    live2d: 'lanlan'
                }
            }
        }),
        buildSnapshotPayload: () => ({ model_type: 'live2d', live2d: 'lanlan' }),
        reloadModel: () => Promise.resolve(),
        setPreparing: () => {},
        revealPrepared: () => {},
        applyIdentityOverride: () => {},
        clearViewportWatcher: () => {}
    });

    await controller.beginOverride();

    // Skip/angry-exit tears down the feature controller before the model restore.
    window.proactiveChatEnabled = true;
    window.appState.proactiveChatEnabled = true;
    window.proactiveVisionChatEnabled = true;
    window.appState.proactiveVisionChatEnabled = true;
    window.NekoHomeTutorialFeatureController = null;

    await controller.restoreOverride();

    assert.equal(window.proactiveChatEnabled, true);
    assert.equal(window.appState.proactiveChatEnabled, true);
    assert.equal(window.proactiveVisionChatEnabled, true);
    assert.equal(window.appState.proactiveVisionChatEnabled, true);
});

test('tutorial avatar reload can keep prepared model hidden for intro performance reveal', async () => {
    const window = loadReloadControllerWindow();
    const reloadCalls = [];
    const revealCalls = [];
    const host = {
        constructor: {
            detectModelPrefix() {
                return 'live2d';
            }
        }
    };
    const controller = window.TutorialAvatarReloadController.createController({
        host,
        timeoutMs: 200,
        resolveCurrentName: () => Promise.resolve('LanLan'),
        fetchCharacters: () => Promise.resolve({
            '猫娘': {
                LanLan: {
                    model_type: 'live2d',
                    live2d: 'lanlan'
                }
            }
        }),
        buildSnapshotPayload: () => ({ model_type: 'live2d', live2d: 'lanlan' }),
        reloadModel: (name, payload, options) => {
            reloadCalls.push({ name, payload, options });
            return Promise.resolve();
        },
        setPreparing: () => {},
        revealPrepared: () => revealCalls.push('reveal'),
        applyIdentityOverride: () => {},
        clearViewportWatcher: () => {}
    });

    await controller.beginOverride({ deferRevealPrepared: true });

    assert.equal(reloadCalls.length, 1);
    assert.equal(reloadCalls[0].options.deferRevealPrepared, true);
    assert.deepEqual(revealCalls, []);
});

test('tutorial avatar reload fades out current model before preparing hide', async () => {
    const window = loadReloadControllerWindow();
    const calls = [];
    const host = {
        constructor: {
            detectModelPrefix() {
                return 'live2d';
            }
        }
    };
    const controller = window.TutorialAvatarReloadController.createController({
        host,
        timeoutMs: 200,
        resolveCurrentName: () => Promise.resolve('LanLan'),
        fetchCharacters: () => Promise.resolve({
            '猫娘': {
                LanLan: {
                    model_type: 'live2d',
                    live2d: 'lanlan'
                }
            }
        }),
        buildSnapshotPayload: () => ({ model_type: 'live2d', live2d: 'lanlan' }),
        fadeOutCurrentModel: () => {
            calls.push({ type: 'fadeOut' });
            return Promise.resolve();
        },
        reloadModel: () => {
            calls.push({ type: 'reload' });
            return Promise.resolve();
        },
        setPreparing: (value) => calls.push({ type: 'preparing', value }),
        revealPrepared: () => {},
        applyIdentityOverride: () => {},
        clearViewportWatcher: () => {}
    });

    await controller.beginOverride({ deferRevealPrepared: true });

    assert.deepEqual(calls.slice(0, 3), [
        { type: 'fadeOut' },
        { type: 'preparing', value: true },
        { type: 'reload' }
    ]);
});
