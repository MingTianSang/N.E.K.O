const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'app/app-proactive.js'), 'utf8');

test('tutorial suppression rejects late vision acquisition at every async boundary', async () => {
    for (const stage of ['prepare', 'backend', 'stream', 'manual-stream']) {
        const acquiresStream = stage === 'stream' || stage === 'manual-stream';
        const listeners = new Map();
        let settle;
        let enterStage;
        const entered = new Promise((resolve) => { enterStage = resolve; });
        const gate = new Promise((resolve) => { settle = resolve; });
        let stopped = 0;
        let promptCalls = 0;
        const stream = { getTracks() { return [{ stop() { stopped += 1; } }]; } };
        const state = { isRecording: true, proactiveVisionEnabled: true };
        const window = {
            appState: state, appConst: {},
            addEventListener(type, listener) { listeners.set(type, listener); },
            prepareRememberedWindowCapture: async () => {
                if (stage === 'prepare') { enterStage(); await gate; }
                return { required: false, allowed: true };
            },
            appScreen: {
                fetchBackendScreenshot: async () => {
                    if (stage === 'backend') { enterStage(); await gate; }
                    return { dataUrl: null };
                },
                acquireOrReuseCachedStream: async () => {
                    promptCalls += 1;
                    enterStage();
                    await gate;
                    state.screenCaptureStream = stream;
                    return stream;
                }
            }
        };
        vm.runInNewContext(source, {
            window,
            document: {
                addEventListener() {},
                getElementById() {
                    return stage === 'manual-stream' ? { classList: { contains() { return true; } } } : null;
                }
            },
            localStorage: { getItem() { return null; } },
            console, clearTimeout() {}, clearInterval() {}
        });
        const pending = window.acquireProactiveVisionStream();
        await entered;
        listeners.get('neko:home-tutorial-features-suppressed')({ detail: { active: true, source: 'director' } });
        window.releaseProactiveVisionStream(); // Begin-time release has no late stream yet.
        settle();
        assert.equal(await pending, false, stage);
        assert.equal(promptCalls, acquiresStream ? 1 : 0, 'no prompt after earlier suppression');
        assert.equal(stopped, stage === 'stream' ? 1 : 0, 'release the late cached track');
        assert.equal(state.screenCaptureStream == null, stage !== 'manual-stream', 'manual sharing remains protected');
        await window.acquireProactiveVisionStream();
        assert.equal(promptCalls, acquiresStream ? 1 : 0, 'already suppressed calls never acquire');
    }
});

test('click-guide activation stops vision and releases only automatic capture', () => {
    for (const manualSharing of [false, true]) {
        const listeners = new Map();
        let stopped = 0;
        let cleared = 0;
        const stream = { getTracks() { return [{ stop() { stopped += 1; } }]; } };
        const state = {
            isRecording: true, proactiveVisionEnabled: true,
            screenCaptureStream: stream, proactiveVisionFrameTimer: 1
        };
        const window = {
            appState: state, appConst: {},
            addEventListener(type, listener) { listeners.set(type, listener); }
        };
        vm.runInNewContext(source, {
            window,
            document: {
                addEventListener() {},
                getElementById() { return { classList: { contains() { return manualSharing; } } }; }
            },
            localStorage: { getItem() { return null; } },
            console, clearTimeout() {}, clearInterval() { cleared += 1; }
        });
        window.isNekoClickGuideActive = true;
        listeners.get('neko:click-guide-active')({ detail: { active: true } });
        assert.equal(state.proactiveVisionFrameTimer, null);
        assert.equal(cleared, 1);
        assert.equal(stopped, manualSharing ? 0 : 1);
        assert.equal(state.screenCaptureStream == null, !manualSharing);
    }
});

test('click-guide release restores chat after its timer expires while suppressed', async () => {
    const listeners = new Map();
    const timers = new Map();
    let nextTimer = 0;
    const state = {
        isRecording: true,
        proactiveChatEnabled: true,
        proactiveNewsChatEnabled: true,
        proactiveVisionEnabled: false,
        proactiveChatInterval: 15
    };
    const window = {
        appState: state, appConst: {},
        addEventListener(type, listener) { listeners.set(type, listener); }
    };
    vm.runInNewContext(source, {
        window,
        document: { addEventListener() {}, getElementById() { return null; } },
        localStorage: { getItem() { return null; } },
        console,
        setTimeout(fn) { timers.set(++nextTimer, fn); return nextTimer; },
        clearTimeout(id) { timers.delete(id); },
        clearInterval() {}
    });
    const release = () => listeners.get('neko:click-guide-active')({ detail: { active: false } });
    release();
    assert.equal(timers.size, 0, 'release must not initialize the scheduler early');
    state._proactiveSchedulerInitialized = true;
    window.scheduleProactiveChat();
    assert.equal(timers.size, 1);
    window.isNekoClickGuideActive = true;
    const timer = timers.get(state.proactiveChatTimer);
    timers.delete(state.proactiveChatTimer);
    await timer();
    assert.equal(state.proactiveChatTimer, null);
    assert.equal(timers.size, 0, 'the guide blocks rearming the expired timer');
    window.isNekoClickGuideActive = false;
    release();
    assert.equal(timers.size, 1, 'release must restore the chat timer');

    listeners.get('neko:home-tutorial-features-suppressed')({ detail: { active: true, source: 'director' } });
    release();
    assert.equal(timers.size, 0, 'other tutorial sources must still block rearming');
});

test('overlapping tutorial sources keep vision stopped until the final release', () => {
    const listeners = new Map();
    let intervalCount = 0;
    const window = {
        appState: { isRecording: true, proactiveVisionEnabled: true, proactiveChatEnabled: false },
        appConst: {},
        addEventListener(type, listener) { listeners.set(type, listener); }
    };
    vm.runInNewContext(source, {
        window,
        document: { addEventListener() {}, getElementById() { return null; } },
        localStorage: { getItem() { return null; } },
        console,
        setInterval() { intervalCount += 1; return intervalCount; },
        clearInterval() {},
        clearTimeout() {}
    });
    const emit = (active, source) => listeners.get('neko:home-tutorial-features-suppressed')({
        detail: { active, source }
    });
    emit(true, 'yui-guide-director');
    emit(true, 'avatar-reload-override');
    emit(true, 'yui-guide-director'); // Enforce repeats must not create extra holds.
    emit(false, 'avatar-reload-override');
    assert.equal(window.appProactive.isHomeTutorialFeatureSuppressed(), true);
    assert.equal(intervalCount, 0);
    emit(false, 'yui-guide-director');
    assert.equal(window.appProactive.isHomeTutorialFeatureSuppressed(), false);
    assert.equal(intervalCount, 1);

    emit(true); // Feature controller's begin/end have no source field.
    emit(true, 'avatar-reload-override');
    emit(false);
    assert.equal(window.appProactive.isHomeTutorialFeatureSuppressed(), true);
    assert.equal(intervalCount, 1);
    emit(false, 'avatar-reload-override');
    assert.equal(window.appProactive.isHomeTutorialFeatureSuppressed(), false);
    assert.equal(intervalCount, 2);
});

test('proactive scheduler re-arms after new-user icebreaker suppression', () => {
    assert.match(source, /function getNewUserIcebreakerRetryDelayMs\(\)/);
    assert.match(source, /function getNewUserIcebreakerBlockingRetryMs\(\)/);

    const blockingStart = source.indexOf('function getNewUserIcebreakerBlockingRetryMs()');
    assert.notEqual(blockingStart, -1, 'missing blocking retry helper');
    const blockingEnd = source.indexOf('const store = readNewUserIcebreakerStore();', blockingStart);
    assert.notEqual(blockingEnd, -1, 'missing blocking retry persisted-store branch');
    const activeSessionBlock = source.slice(blockingStart, blockingEnd);
    assert.match(activeSessionBlock, /return getNewUserIcebreakerRetryDelayMs\(\);/);
    assert.doesNotMatch(activeSessionBlock, /return NEW_USER_ICEBREAKER_BLOCKING_WINDOW_MS;/);

    const scheduleStart = source.indexOf('function scheduleProactiveChat()');
    assert.notEqual(scheduleStart, -1, 'missing proactive scheduler function');

    const preconditionStart = source.indexOf('if (!canTriggerProactively()) {', scheduleStart);
    assert.notEqual(preconditionStart, -1, 'missing proactive precondition guard block');
    const preconditionEnd = source.indexOf('return;', preconditionStart);
    assert.notEqual(preconditionEnd, -1, 'missing proactive return in precondition block');
    const preconditionBlock = source.slice(preconditionStart, preconditionEnd);

    assert.match(preconditionBlock, /var icebreakerRetryMs = getNewUserIcebreakerBlockingRetryMs\(\);/);
    assert.match(preconditionBlock, /S\.proactiveChatTimer = setTimeout\(scheduleProactiveChat, icebreakerRetryMs \+ 250\);/);

    const activeStart = source.indexOf('if (isNewUserIcebreakerPeriodActive()) {', scheduleStart);
    assert.notEqual(activeStart, -1, 'missing active icebreaker suppression block');
    const activeEnd = source.indexOf('return;', activeStart);
    assert.notEqual(activeEnd, -1, 'missing active icebreaker return');
    const activeBlock = source.slice(activeStart, activeEnd);
    assert.match(activeBlock, /getNewUserIcebreakerBlockingRetryMs\(\) \|\| getNewUserIcebreakerRetryDelayMs\(\)/);
});

test('youtube login does not enable the unrelated personal dynamics mode', () => {
    assert.match(
        source,
        /new Set\(\['bilibili', 'douyin', 'kuaishou', 'weibo', 'reddit', 'twitter'\]\)/
    );
    const personalPlatformStart = source.indexOf('async function getAvailablePersonalPlatforms()');
    const personalPlatformEnd = source.indexOf('mod.getAvailablePersonalPlatforms', personalPlatformStart);
    const personalPlatformBlock = source.slice(personalPlatformStart, personalPlatformEnd);
    assert.match(personalPlatformBlock, /personalFeedPlatforms\.has\(platform\) && info\.has_cookies/);
    assert.doesNotMatch(personalPlatformBlock, /personalFeedPlatforms[^;]*youtube/);
});
