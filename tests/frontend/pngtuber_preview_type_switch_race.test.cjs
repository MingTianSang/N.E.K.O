const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PAGE_CONTROLLER_JS = path.join(
    PROJECT_ROOT, 'static', 'js', 'model_manager', 'page-controller.js');
const source = fs.readFileSync(PAGE_CONTROLLER_JS, 'utf8');

function extractPreviewFunction() {
    const start = source.indexOf('async function previewPNGTuberConfig(');
    const end = source.indexOf('async function loadSelectedPNGTuberOption(', start);
    assert.ok(start >= 0 && end > start, 'previewPNGTuberConfig 区块不存在');
    return source.slice(start, end);
}

function makeContainerStub() {
    const classCalls = [];
    return {
        style: {},
        classList: {
            add(name) { classCalls.push(['add', name]); },
            remove(name) { classCalls.push(['remove', name]); },
        },
        classCalls,
    };
}

// initialType：调用 previewPNGTuberConfig 时的 currentModelType；
// typeDuringLoad：PNG 异步加载完成前用户切到的类型（模拟加载中途切换模型类型）。
function makeSandbox({ initialType = 'pngtuber', typeDuringLoad = 'pngtuber' } = {}) {
    const statusMessages = [];
    const sandbox = {
        console: { ...console, error() {}, warn() {}, log() {} },
        currentModelType: initialType,
        currentLive3dSubType: '',
        currentModelInfo: null,
        savePositionBtn: null,
        t: (key, fallback) => fallback,
        showStatus: (message) => statusMessages.push(message),
        markModelChangedForCardFacePrompt: () => {},
        live2dContainer: makeContainerStub(),
        vrmContainer: makeContainerStub(),
        mmdContainer: makeContainerStub(),
        pngtuberContainer: makeContainerStub(),
        loadPNGTuberPreviewControls: async () => {},
        statusMessages,
        avatarLoadCalls: 0,
        window: {
            hasUnsavedChanges: false,
            loadPNGTuberAvatar: async () => {
                sandbox.avatarLoadCalls += 1;
                // 加载进行中用户在模型类型下拉里切到了别的类型：
                // switchModelDisplay 会同步改写 currentModelType。
                sandbox.currentModelType = typeDuringLoad;
            },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(extractPreviewFunction(), sandbox, { filename: 'previewPNGTuberConfig' });
    return sandbox;
}

function runPreview(sandbox) {
    return vm.runInContext(
        `previewPNGTuberConfig(
            { idle_image: '/user_pngtuber/demo/idle.png', talking_image: '/user_pngtuber/demo/talking.png' },
            { name: 'demo', label: 'demo', folder: 'demo' },
            { markDirty: true }
        )`,
        sandbox);
}

test('对照组：全程停留在 pngtuber 时正常显示 PNG 容器', async () => {
    const sandbox = makeSandbox({ typeDuringLoad: 'pngtuber' });
    const result = await runPreview(sandbox);

    assert.equal(result, true);
    assert.equal(sandbox.avatarLoadCalls, 1);
    assert.equal(sandbox.pngtuberContainer.style.display, 'block');
    assert.deepEqual(sandbox.pngtuberContainer.classCalls, [['remove', 'hidden']]);
    assert.equal(sandbox.live2dContainer.style.display, 'none');
    assert.equal(sandbox.vrmContainer.style.display, 'none');
    assert.equal(sandbox.mmdContainer.style.display, 'none');
    assert.equal(sandbox.window.hasUnsavedChanges, true);
    assert.equal(sandbox.statusMessages.length, 1);
    assert.match(sandbox.statusMessages[0], /已加载PNGTuber模型/);
});

test('加载中途切到 live2d：迟到的续体不得重新显示 PNG 容器/隐藏 live2d 容器', async () => {
    const sandbox = makeSandbox({ typeDuringLoad: 'live2d' });
    const result = await runPreview(sandbox);

    assert.equal(result, false);
    // 核心回归：PNG 容器不能被迟到的续体重新显示
    assert.equal(sandbox.pngtuberContainer.style.display, undefined);
    assert.deepEqual(sandbox.pngtuberContainer.classCalls, []);
    // live2d/vrm/mmd 容器不能被迟到的续体隐藏
    assert.equal(sandbox.live2dContainer.style.display, undefined);
    assert.deepEqual(sandbox.live2dContainer.classCalls, []);
    assert.equal(sandbox.vrmContainer.style.display, undefined);
    assert.equal(sandbox.mmdContainer.style.display, undefined);
    // 不应误报“已加载PNGTuber模型”，也不应把页面标记为有未保存更改
    assert.deepEqual(sandbox.statusMessages, []);
    assert.equal(sandbox.window.hasUnsavedChanges, false);
});

test('加载中途切到 live3d：迟到的续体同样不得接管显示', async () => {
    const sandbox = makeSandbox({ typeDuringLoad: 'live3d' });
    const result = await runPreview(sandbox);

    assert.equal(result, false);
    assert.equal(sandbox.pngtuberContainer.style.display, undefined);
    assert.deepEqual(sandbox.pngtuberContainer.classCalls, []);
    assert.equal(sandbox.vrmContainer.style.display, undefined);
    assert.equal(sandbox.mmdContainer.style.display, undefined);
    assert.deepEqual(sandbox.statusMessages, []);
});

test('入口即已切走（角色配置加载链被打断）：不启动过期预览、不覆盖 currentModelInfo', async () => {
    const sandbox = makeSandbox({ initialType: 'live2d', typeDuringLoad: 'live2d' });
    const result = await runPreview(sandbox);

    assert.equal(result, false);
    assert.equal(sandbox.avatarLoadCalls, 0);
    assert.equal(sandbox.currentModelInfo, null);
    assert.equal(sandbox.pngtuberContainer.style.display, undefined);
    assert.deepEqual(sandbox.statusMessages, []);
});
