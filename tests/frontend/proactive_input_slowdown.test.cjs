const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../../static/app/app-proactive.js'), 'utf8');
const clock = { now: 1_000_000 };
const channels = [];
const queue = [];

class FakeBroadcastChannel {
    constructor(name) {
        this.name = name;
        this.onmessage = null;
        channels.push(this);
    }
    postMessage(data) {
        const copy = JSON.parse(JSON.stringify(data));
        for (const peer of channels) {
            if (peer !== this && peer.name === this.name) {
                queue.push(() => peer.onmessage && peer.onmessage({ data: copy }));
            }
        }
    }
    close() {}
}

function flush() {
    while (queue.length) queue.shift()();
}

function createWindow(pathname) {
    const timers = new Map();
    let nextTimer = 1;
    const listeners = { document: {}, window: {} };
    const fetches = [];
    const appState = {
        proactiveChatEnabled: true,
        proactiveNewsChatEnabled: true,
        proactiveChatInterval: 10,
        proactiveChatBackoffLevel: 0,
        proactiveChatTimer: null,
        isRecording: false,
        isProactiveChatRunning: false,
        _proactiveStartupDelayApplied: true,
    };
    const input = {
        nodeType: 1,
        id: 'textInputBox',
        disabled: false,
        readOnly: false,
        matches(selector) {
            return String(selector).split(',').some((part) => part.trim() === '#textInputBox');
        },
    };
    const document = {
        activeElement: null,
        hasFocus: () => true,
        body: { classList: { contains: () => false }, getAttribute: () => null },
        addEventListener(type, fn) {
            (listeners.document[type] || (listeners.document[type] = [])).push(fn);
        },
        getElementById: () => null,
        querySelector: () => null,
    };
    const window = {
        console: { log() {}, info() {}, debug() {}, warn() {}, error() {} },
        location: { pathname, origin: 'https://local.test' },
        appState,
        appConst: {},
        lastUserInputTime: 0,
        localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        document,
        navigator: { userAgent: 'node' },
        addEventListener(type, fn) {
            (listeners.window[type] || (listeners.window[type] = [])).push(fn);
        },
        setTimeout(fn, delay) {
            const id = nextTimer++;
            timers.set(id, { fn, delay });
            return id;
        },
        clearTimeout(id) { timers.delete(id); },
        setInterval() { return 0; },
        clearInterval() {},
        fetch(url) {
            fetches.push(url);
            return Promise.resolve({
                ok: true,
                status: 200,
                json: async () => ({ success: false, action: 'pass' }),
            });
        },
        BroadcastChannel: FakeBroadcastChannel,
    };
    window.window = window;
    vm.createContext(window);
    window.__clock = clock;
    vm.runInContext('Date.now = () => globalThis.__clock.now;', window);
    vm.runInContext(source, window, { filename: 'static/app/app-proactive.js' });
    return {
        window, appState, document, input, timers, fetches, listeners,
        emit(type, target) {
            for (const fn of listeners.document[type] || []) fn({ target });
        },
        scheduledDelay() {
            const timer = appState.proactiveChatTimer && timers.get(appState.proactiveChatTimer);
            return timer ? timer.delay : null;
        },
        async fire() {
            const timer = timers.get(appState.proactiveChatTimer);
            assert.ok(timer, '应有待触发的主动搭话定时器');
            timers.delete(appState.proactiveChatTimer);
            await timer.fn();
        },
    };
}

test('持续输入会刷新判定窗口，到点时窗口未结束则不搭话', async () => {
    channels.length = 0;
    queue.length = 0;
    clock.now = 1_000_000;
    const pet = createWindow('/');
    const chat = createWindow('/chat');
    flush();
    assert.equal(pet.window.isProactiveLeader(), true);
    assert.equal(chat.window.isProactiveLeader(), false);

    pet.window.scheduleProactiveChat();
    assert.ok(pet.scheduledDelay() < 20000, '未输入时按基础间隔排定');

    chat.document.activeElement = chat.input;
    chat.emit('focusin', chat.input);
    flush();
    const focusedTimer = pet.appState.proactiveChatTimer;
    assert.ok(pet.scheduledDelay() >= 30000, '聚焦后至少等待 30 秒再判定');

    clock.now += 20000;
    chat.emit('input', chat.input);
    flush();
    assert.notEqual(pet.appState.proactiveChatTimer, focusedTimer, '继续输入必须重新排定');
    assert.ok(pet.scheduledDelay() >= 30000, '输入后从当前时刻再给一个完整输入窗口');

    await pet.fire();
    assert.equal(pet.fetches.length, 0, '输入窗口还没结束时不得发送主动搭话');
    assert.equal(pet.appState.proactiveChatBackoffLevel, 0, '跳过本次不得升级退避');
    assert.ok(pet.scheduledDelay() >= 20000, '跳过后要重新排定下一次判定');

    clock.now += 31000;
    await pet.fire();
    assert.equal(pet.fetches.length, 1, '输入窗口结束后应正常搭话');
});

test('只聚焦不继续输入时，窗口结束后仍会搭话', async () => {
    channels.length = 0;
    queue.length = 0;
    clock.now = 1_000_000;
    const pet = createWindow('/');
    flush();
    pet.document.activeElement = pet.input;
    pet.emit('focusin', pet.input);
    assert.ok(pet.scheduledDelay() >= 30000);

    clock.now += 31000;
    await pet.fire();
    assert.equal(pet.fetches.length, 1, '聚焦本身不能一直关掉主动搭话');
});

test('间隔长于 30 秒时，输入不额外拉长排程', () => {
    channels.length = 0;
    queue.length = 0;
    clock.now = 1_000_000;
    const pet = createWindow('/');
    flush();
    pet.appState.proactiveChatInterval = 60;
    pet.window.scheduleProactiveChat();
    const timer = pet.appState.proactiveChatTimer;
    const delay = pet.scheduledDelay();
    pet.document.activeElement = pet.input;
    pet.emit('focusin', pet.input);
    pet.emit('input', pet.input);
    assert.equal(pet.appState.proactiveChatTimer, timer);
    assert.equal(pet.scheduledDelay(), delay);
});
