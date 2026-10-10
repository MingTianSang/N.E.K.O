const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PAGE_CONTROLLER_JS = path.join(
    PROJECT_ROOT, 'static', 'js', 'model_manager', 'page-controller.js');
const source = fs.readFileSync(PAGE_CONTROLLER_JS, 'utf8');

function extractSlice(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start >= 0, `找不到区块起点: ${startMarker}`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, `找不到区块终点: ${endMarker}`);
    return source.slice(start, end);
}

const previewSlice = extractSlice(
    'async function previewPNGTuberConfig(',
    'async function loadSelectedPNGTuberOption(');
const previewControlsSlice = extractSlice(
    'async function loadPNGTuberPreviewControls(',
    // 注意：函数体内也有 `if (pngtuberTalkPreviewBtn) {`，endMarker 必须锚定到
    // 函数结束后紧跟的 listener 注册，否则会把函数拦腰截断
    `if (pngtuberTalkPreviewBtn) {
        pngtuberTalkPreviewBtn.addEventListener(`);

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
    const records = { clearCalls: 0, renderCalls: [], talkButtonTextCalls: 0 };
    const sandbox = {
        console: { ...console, error() {}, warn() {}, log() {} },
        currentModelType: initialType,
        currentLive3dSubType: '',
        currentModelInfo: null,
        pendingPNGTuberPreview: null,
        savePositionBtn: null,
        pngtuberPreviewGeneration: 0,
        t: (key, fallback) => fallback,
        showStatus: (message) => statusMessages.push(message),
        markModelChangedForCardFacePrompt: () => {},
        live2dContainer: makeContainerStub(),
        vrmContainer: makeContainerStub(),
        mmdContainer: makeContainerStub(),
        pngtuberContainer: makeContainerStub(),
        // 状态预览控件的真实函数会被提取执行，这里桩掉它的外部依赖
        clearPNGTuberPreviewControls: () => { records.clearCalls += 1; },
        renderPNGTuberStatePreviewDropdown: (metadata) => { records.renderCalls.push(metadata); },
        updatePNGTuberTalkPreviewButtonText: () => { records.talkButtonTextCalls += 1; },
        fetchPNGTuberLayeredMetadata: async () => null,
        pngtuberPreviewGroup: { style: {} },
        pngtuberBasicPreviewSection: { style: {} },
        pngtuberTalkPreviewBtn: { disabled: true },
        statusMessages,
        records,
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
    vm.runInContext(previewControlsSlice, sandbox, { filename: 'loadPNGTuberPreviewControls' });
    vm.runInContext(previewSlice, sandbox, { filename: 'previewPNGTuberConfig' });
    return sandbox;
}

function runPreview(sandbox, { name = 'demo', idle = '/user_pngtuber/demo/idle.png', markDirty = true } = {}) {
    const talking = idle.replace('idle.png', 'talking.png');
    return vm.runInContext(
        `previewPNGTuberConfig(
            { idle_image: ${JSON.stringify(idle)}, talking_image: ${JSON.stringify(talking)} },
            { name: ${JSON.stringify(name)}, label: ${JSON.stringify(name)}, folder: ${JSON.stringify(name)} },
            { markDirty: ${JSON.stringify(markDirty)} }
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
    // 提交成功后 currentModelInfo 才落上 pngtuber 条目
    assert.equal(sandbox.currentModelInfo.type, 'pngtuber');
    assert.equal(sandbox.currentModelInfo.name, 'demo');
    assert.equal(sandbox.currentModelInfo.pngtuber.idle_image, '/user_pngtuber/demo/idle.png');
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
    // 取消的预览不得把 pngtuber 条目留在 currentModelInfo 上：
    // showStatus 定时器 / reloadCurrentLive2DModelInModelManager / 保存流程都会读它
    assert.equal(sandbox.currentModelInfo, null);
    // 切走后连状态预览控件都不应再加载
    assert.deepEqual(sandbox.records.renderCalls, []);
    // 取消后 pending 记录必须清空，删除防护恢复到已提交模型
    assert.equal(sandbox.pendingPNGTuberPreview, null);
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
    assert.equal(sandbox.currentModelInfo, null);
});

test('入口即已切走（角色配置加载链被打断）：不启动过期预览、不覆盖 currentModelInfo', async () => {
    const sandbox = makeSandbox({ initialType: 'live2d', typeDuringLoad: 'live2d' });
    const result = await runPreview(sandbox);

    assert.equal(result, false);
    assert.equal(sandbox.avatarLoadCalls, 0);
    assert.equal(sandbox.currentModelInfo, null);
    assert.equal(sandbox.pngtuberContainer.style.display, undefined);
    assert.deepEqual(sandbox.statusMessages, []);
    // 过期入口调用不得自增世代号（否则会作废仍在进行的合法预览）
    assert.equal(sandbox.pngtuberPreviewGeneration, 0);
    // 也不得登记 pending 记录（否则会错误保护与新预览无关的模型）
    assert.equal(sandbox.pendingPNGTuberPreview, null);
});

test('同类型重叠预览：慢的旧预览 A 不得覆盖先完成的新预览 B', async () => {
    const sandbox = makeSandbox();
    // 受控双闸门：A 先进入加载但最后完成，B 后发起先完成
    let resolveA;
    let resolveB;
    const gateA = new Promise((resolve) => { resolveA = resolve; });
    const gateB = new Promise((resolve) => { resolveB = resolve; });
    sandbox.window.loadPNGTuberAvatar = async () => {
        sandbox.avatarLoadCalls += 1;
        await (sandbox.avatarLoadCalls === 1 ? gateA : gateB);
    };

    const previewA = runPreview(sandbox, { name: 'A', idle: '/user_pngtuber/a/idle.png' });
    const previewB = runPreview(sandbox, { name: 'B', idle: '/user_pngtuber/b/idle.png' });
    resolveB();
    const resultB = await previewB;
    resolveA();
    const resultA = await previewA;

    assert.equal(resultB, true);
    assert.equal(resultA, false);
    // 最终提交的是最新选择 B，不是更晚完成的 A
    assert.equal(sandbox.currentModelInfo.name, 'B');
    assert.equal(sandbox.currentModelInfo.pngtuber.idle_image, '/user_pngtuber/b/idle.png');
    // 只有 B 报成功提示；A 迟到后不得再发「已加载PNGTuber模型: A」
    assert.equal(sandbox.statusMessages.length, 1);
    assert.match(sandbox.statusMessages[0], /已加载PNGTuber模型: B/);
    // A 在中间守卫处被拦下，未加载自己的状态预览控件
    assert.deepEqual(sandbox.records.renderCalls, [null]);
});

test('旧预览的状态下拉不得在被取代后渲染（metadata fetch 竞态）', async () => {
    const sandbox = makeSandbox();
    sandbox.window.loadPNGTuberAvatar = async () => { sandbox.avatarLoadCalls += 1; };
    // A 的 metadata fetch 挂起；B 全程快速完成
    let resolveFetchA;
    const gateFetchA = new Promise((resolve) => { resolveFetchA = resolve; });
    const metadataA = { state_count: 2, states: [{ name: 'A1' }, { name: 'A2' }] };
    const metadataB = { state_count: 2, states: [{ name: 'B1' }, { name: 'B2' }] };
    sandbox.fetchPNGTuberLayeredMetadata = async (config) => {
        if (String(config.idle_image).includes('/a/')) {
            await gateFetchA;
            return metadataA;
        }
        return metadataB;
    };

    const previewA = runPreview(sandbox, { name: 'A', idle: '/user_pngtuber/a/idle.png' });
    // 让 A 走到 fetch 挂起点（loadPNGTuberAvatar 与中间守卫均为微任务）
    await new Promise((resolve) => setImmediate(resolve));
    const previewB = runPreview(sandbox, { name: 'B', idle: '/user_pngtuber/b/idle.png' });
    const resultB = await previewB;
    resolveFetchA();
    const resultA = await previewA;

    assert.equal(resultB, true);
    assert.equal(resultA, false);
    assert.equal(sandbox.currentModelInfo.name, 'B');
    // 只渲染了 B 的状态列表；A 的迟到 metadata 被世代号拦下
    assert.deepEqual(sandbox.records.renderCalls, [metadataB]);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('重叠预览乱序退出：旧预览退出不得清掉新预览的 pending 记录', async () => {
    const sandbox = makeSandbox();
    let resolveA;
    let resolveB;
    const gateA = new Promise((resolve) => { resolveA = resolve; });
    const gateB = new Promise((resolve) => { resolveB = resolve; });
    sandbox.window.loadPNGTuberAvatar = async () => {
        sandbox.avatarLoadCalls += 1;
        await (sandbox.avatarLoadCalls === 1 ? gateA : gateB);
    };

    const previewA = runPreview(sandbox, { name: 'A', idle: '/user_pngtuber/a/idle.png' });
    const previewB = runPreview(sandbox, { name: 'B', idle: '/user_pngtuber/b/idle.png' });
    // pending 记录被最新预览 B 覆盖（删除防护跟着最新选择走）
    assert.equal(sandbox.pendingPNGTuberPreview.folder, 'B');
    assert.equal(sandbox.pendingPNGTuberPreview.generation, 2);

    // 被取代的 A 先结束：finally 按世代号判定，不得误清 B 的 pending
    resolveA();
    const resultA = await previewA;
    assert.equal(resultA, false);
    assert.equal(sandbox.pendingPNGTuberPreview.folder, 'B');
    assert.equal(sandbox.currentModelInfo, null);

    // B 随后正常完成：提交并清理自己的 pending
    resolveB();
    const resultB = await previewB;
    assert.equal(resultB, true);
    assert.equal(sandbox.pendingPNGTuberPreview, null);
    assert.equal(sandbox.currentModelInfo.name, 'B');
});

test('头像加载被接受后立即提交模型信息，metadata fetch 期间不再空窗', async () => {
    const sandbox = makeSandbox();
    let resolveAvatar;
    let resolveFetch;
    const gateAvatar = new Promise((resolve) => { resolveAvatar = resolve; });
    const gateFetch = new Promise((resolve) => { resolveFetch = resolve; });
    sandbox.window.loadPNGTuberAvatar = async () => {
        sandbox.avatarLoadCalls += 1;
        await gateAvatar;
    };
    sandbox.fetchPNGTuberLayeredMetadata = async () => {
        await gateFetch;
        return null;
    };

    const preview = runPreview(sandbox);
    await tick();
    // 头像仍在加载：currentModelInfo 未提交，但 pending 记录已就位，
    // deleteSelectedModels 的安全检查据此仍能拦住「删除加载中的模型」
    assert.equal(sandbox.currentModelInfo, null);
    assert.equal(sandbox.pendingPNGTuberPreview.folder, 'demo');
    assert.equal(sandbox.pendingPNGTuberPreview.generation, 1);

    resolveAvatar();
    await tick();
    // 核心断言（Codex P2）：头像已被运行时接受并显示，模型信息在 metadata fetch
    // 之前提交——期间拖拽/缩放 PNG 时 stageModelManagerPNGTuberPlacement
    // 不再因 !currentModelInfo 拒绝暂存摆放
    assert.equal(sandbox.currentModelInfo.name, 'demo');
    assert.equal(sandbox.currentModelInfo.type, 'pngtuber');
    assert.equal(sandbox.currentModelInfo.pngtuber.idle_image, '/user_pngtuber/demo/idle.png');
    // pending 的防护使命随提交结束、不陪跑 metadata fetch（Codex P2 第二轮）：
    // 该 fetch 是无超时的裸请求，若挂起则 finally 永不执行，悬置的 pending
    // 会让该模型被删除安全检查误拦为「绑定中」
    assert.equal(sandbox.pendingPNGTuberPreview, null);

    resolveFetch();
    const result = await preview;
    assert.equal(result, true);
    assert.equal(sandbox.pendingPNGTuberPreview, null);
    assert.equal(sandbox.statusMessages.length, 1);
    assert.match(sandbox.statusMessages[0], /已加载PNGTuber模型: demo/);
});

test('离开 pngtuber：先作废在途预览（世代号+运行时 loadToken），再释放 pending 防护', () => {
    const start = source.indexOf('async function switchModelDisplay(');
    assert.ok(start >= 0, 'switchModelDisplay 不存在');
    const end = source.indexOf('const sidebar =', start);
    assert.ok(end > start, 'switchModelDisplay 序块不存在');
    const block = source.slice(start, end);
    assert.ok(block.includes("if (previousModelType === 'pngtuber' && type !== 'pngtuber') {"));
    assert.ok(block.includes('pendingPNGTuberPreview = null;'));
    // 只清防护不作废的话，「切走→删除在途模型→切回」后旧加载完成会复活已删除模型：
    // 必须同时自增页面世代号（拦截检查点提交）并作废运行时 loadToken（拦截 show()）
    assert.ok(block.includes('pngtuberPreviewGeneration += 1;'));
    assert.ok(block.includes('window.cancelPNGTuberAvatarLoads'));
    // 顺序：两个作废都必须先于释放删除防护
    const clearIdx = block.indexOf('pendingPNGTuberPreview = null;');
    assert.ok(block.indexOf('pngtuberPreviewGeneration += 1;') < clearIdx);
    assert.ok(block.indexOf('window.cancelPNGTuberAvatarLoads') < clearIdx);
    // 作废判定依据 previousModelType，必须先于 currentModelType 改写
    assert.ok(block.indexOf("previousModelType === 'pngtuber'") < block.indexOf('currentModelType = type;'));

    // 跨文件契约：pngtuber-core 必须提供并导出 cancelPNGTuberAvatarLoads，
    // 且其实现确实推进 loadPNGTuberAvatar 使用的序列号
    const coreSource = fs.readFileSync(
        path.join(PROJECT_ROOT, 'static', 'pngtuber-core.js'), 'utf8');
    assert.ok(coreSource.includes('function cancelPNGTuberAvatarLoads() {'));
    assert.ok(coreSource.includes('pngtuberLoadSequence += 1;'));
    assert.ok(coreSource.includes('window.cancelPNGTuberAvatarLoads = cancelPNGTuberAvatarLoads;'));
});

test('预览失败且仍在 pngtuber 类型：照常报错提示', async () => {
    const sandbox = makeSandbox();
    sandbox.window.loadPNGTuberAvatar = async () => { throw new Error('boom'); };
    const result = await runPreview(sandbox);

    assert.equal(result, false);
    assert.equal(sandbox.statusMessages.length, 1);
    assert.match(sandbox.statusMessages[0], /PNGTuber 模型加载失败: boom/);
    assert.equal(sandbox.currentModelInfo, null);
    assert.equal(sandbox.pendingPNGTuberPreview, null);
});

test('切走后旧预览加载失败（如文件已删 404）：静默丢弃，不弹无关报错', async () => {
    const sandbox = makeSandbox();
    sandbox.window.loadPNGTuberAvatar = async () => {
        // 模拟切走：类型改写 + switchModelDisplay 入口的世代号作废
        sandbox.currentModelType = 'live2d';
        sandbox.pngtuberPreviewGeneration += 1;
        throw new Error('404 Not Found');
    };
    const result = await runPreview(sandbox);

    assert.equal(result, false);
    assert.deepEqual(sandbox.statusMessages, []);
    assert.equal(sandbox.currentModelInfo, null);
    assert.equal(sandbox.pendingPNGTuberPreview, null);
});

test('控件加载期间切走类型：撤销本预览已提交的条目，不把 pngtuber 信息留在 live2d 下', async () => {
    const sandbox = makeSandbox();
    let resolveFetch;
    const gateFetch = new Promise((resolve) => { resolveFetch = resolve; });
    sandbox.fetchPNGTuberLayeredMetadata = async () => {
        await gateFetch;
        return null;
    };

    const preview = runPreview(sandbox);
    await tick();
    // 头像立即被接受（默认桩），检查点已提交本预览的 pngtuber 条目
    assert.equal(sandbox.currentModelInfo.name, 'demo');
    // 用户在 metadata fetch 期间切到 live2d
    sandbox.currentModelType = 'live2d';
    resolveFetch();
    const result = await preview;

    assert.equal(result, false);
    // 按对象同一性撤销：清理的只能是本预览自己提交的条目；
    // 若新流程已写入更新信息（对象不同一），不会被触碰（由重叠预览用例覆盖）
    assert.equal(sandbox.currentModelInfo, null);
    assert.deepEqual(sandbox.statusMessages, []);
    assert.equal(sandbox.pngtuberContainer.style.display, undefined);
    assert.equal(sandbox.pendingPNGTuberPreview, null);
});

test('删除防护：已提交模型与加载中预览必须同时护住（Codex P1 单槽 || 回归）', () => {
    // 提取纯函数 helper 验证行为
    const slice = extractSlice(
        'function isBoundPNGTuberDeleteKey(',
        'async function deleteSelectedModels(');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(slice + '\n;globalThis.api = { isBoundPNGTuberDeleteKey };', sandbox, {
        filename: 'isBoundPNGTuberDeleteKey',
    });
    const { isBoundPNGTuberDeleteKey } = sandbox.api;

    // A 已提交显示、B 加载中：两个都必须拦，第三者放行
    assert.equal(isBoundPNGTuberDeleteKey('A', 'A', 'B'), true);
    assert.equal(isBoundPNGTuberDeleteKey('B', 'A', 'B'), true);
    assert.equal(isBoundPNGTuberDeleteKey('C', 'A', 'B'), false);
    // 只有已提交 / 只有 pending
    assert.equal(isBoundPNGTuberDeleteKey('A', 'A', ''), true);
    assert.equal(isBoundPNGTuberDeleteKey('B', '', 'B'), true);
    // 空 key / 空 folder 不参与匹配，避免误拦
    assert.equal(isBoundPNGTuberDeleteKey('', '', ''), false);
    assert.equal(isBoundPNGTuberDeleteKey('', 'A', 'B'), false);
    assert.equal(isBoundPNGTuberDeleteKey('A', '', ''), false);

    // 接线断言：deleteSelectedModels 的安全检查必须分别取两个 folder 并调用 helper，
    // 不得回到 || 单槽折叠（那会让「A 已提交 + B 加载中」时 B 失去防护）
    const start = source.indexOf('async function deleteSelectedModels(');
    const end = source.indexOf('const message = t(', start);
    assert.ok(start >= 0 && end > start, 'deleteSelectedModels 区块不存在');
    const block = source.slice(start, end);
    assert.match(block, /const currentPNGTuberFolder = currentModelInfo && currentModelInfo\.type === 'pngtuber' \? currentModelInfo\.folder : '';/);
    assert.match(block, /const pendingPNGTuberFolder = pendingPNGTuberPreview \? pendingPNGTuberPreview\.folder : '';/);
    assert.ok(block.includes('isBoundPNGTuberDeleteKey(key, currentPNGTuberFolder, pendingPNGTuberFolder)'));
});
