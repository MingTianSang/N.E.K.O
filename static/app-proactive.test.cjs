const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, 'app/app-proactive.js'), 'utf8');

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
