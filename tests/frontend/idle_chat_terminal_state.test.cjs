const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DRAG_SOURCE = path.join(
    PROJECT_ROOT,
    'static',
    'avatar',
    'avatar-ui-buttons',
    'idle-drag-and-subactions.js'
);
const JOURNEY_SOURCE = path.join(
    PROJECT_ROOT,
    'static',
    'avatar',
    'avatar-ui-buttons',
    'idle-journey-and-presentation.js'
);

function readFunction(sourcePath, name) {
    const source = fs.readFileSync(sourcePath, 'utf8');
    const start = source.indexOf(`function ${name}`);
    assert.notEqual(start, -1, `missing function ${name}`);
    const bodyStart = source.indexOf('{', start);
    assert.notEqual(bodyStart, -1, `missing function body ${name}`);
    let depth = 0;
    for (let index = bodyStart; index < source.length; index += 1) {
        if (source[index] === '{') depth += 1;
        if (source[index] === '}') depth -= 1;
        if (depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`unterminated function ${name}`);
}

class CustomEventLike {
    constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
    }
}

class WindowLike {
    constructor() {
        this.listeners = new Map();
    }

    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) || [];
        listeners.push(listener);
        this.listeners.set(type, listeners);
    }

    dispatchEvent(event) {
        for (const listener of this.listeners.get(event.type) || []) listener(event);
        return true;
    }
}

function createHarness() {
    let now = 10_000;
    const window = new WindowLike();
    const context = vm.createContext({
        console,
        CustomEvent: CustomEventLike,
        Date: { now: () => now },
        window,
        document: {
            getElementById() { return null; },
            querySelectorAll() { return []; },
        },
        _NEKO_IDLE_RETURN_BUTTON_SELECTOR: '.neko-idle-return-btn',
        _NEKO_IDLE_CAT1_RECHECK_MOVE_DISTANCE_PX: 24,
        _NEKO_IDLE_DESKTOP_CHAT_RECT_STALE_MS: 10_000,
        _NEKO_IDLE_DESKTOP_COMPACT_SURFACE_RECT_STALE_MS: 10_000,
        _NEKO_GOODBYE_IDLE_APPEARANCE_BALL: 'ball',
        _getNekoDesktopVirtualViewportOrigin() { return { x: 0, y: 0 }; },
        _getNekoIdleReactChatCompactSurfaceRect() { return null; },
        _getNekoIdleRectCenterMoveDistance() { return Infinity; },
        _isAnyNekoIdleCat1PlaygroundDropLifecycleActive() { return false; },
        _isNekoIdleCat1PlaygroundPairMoveFeedback() { return false; },
        _handleNekoIdleCompactSurfaceMoveState() {},
        _readNekoAutoGoodbyeVisualTier() { return 'cat1'; },
        _getNekoGoodbyeIdleAppearance() { return 'cat'; },
        _syncNekoIdleSleepSoundForTier() {},
        _syncNekoIdleCat1AmbientSoundForTier() {},
        _syncAllNekoIdleReturnButtons() {},
        _stopNekoGoodbyeIdleBallCatSounds() {},
    });

    const support = [
        '_getNekoIdleDesktopStateSourceUpdatedAt',
        '_isNekoIdleDesktopStateStaleAgainst',
        '_isNekoIdleDesktopStateNewerThan',
        '_makeNekoIdleDesktopChatMinimizedState',
        '_makeNekoIdleDesktopCompactSurfaceState',
    ].map((name) => readFunction(DRAG_SOURCE, name)).join('\n');
    const journey = [
        '_normalizeNekoIdleScreenRect',
        '_getNekoIdleDesktopCompactSurfaceRect',
        '_ensureNekoIdleReturnPresentationBridge',
    ].map((name) => readFunction(JOURNEY_SOURCE, name)).join('\n');

    vm.runInContext(`
        let _nekoIdleDesktopChatMinimizedState = {
            minimized: false,
            screenRect: null,
            updatedAt: 0,
            sourceUpdatedAt: 0,
            expandedRecent: false
        };
        let _nekoIdleDesktopCompactSurfaceState = {
            visible: false,
            screenRect: null,
            updatedAt: 0,
            sourceUpdatedAt: 0
        };
        ${support}
        ${journey}
        window.__getIdleChatTargetState = () => ({
            minimized: JSON.parse(JSON.stringify(_nekoIdleDesktopChatMinimizedState)),
            compact: JSON.parse(JSON.stringify(_nekoIdleDesktopCompactSurfaceState))
        });
        _ensureNekoIdleReturnPresentationBridge();
    `, context);

    function emit(type, detail) {
        window.dispatchEvent(new CustomEventLike(type, { detail }));
    }
    function snapshot() {
        return JSON.parse(JSON.stringify(window.__getIdleChatTargetState()));
    }
    return {
        emit,
        snapshot,
        setNow(value) { now = value; },
    };
}

const MINIMIZED_RECT = { left: 80, top: 120, width: 64, height: 64 };
const COMPACT_RECT = { left: 240, top: 180, width: 320, height: 180 };

test('either unavailable terminal clears minimized and compact targets together', () => {
    for (const terminalType of [
        'neko:idle-chat-minimized-state',
        'neko:idle-chat-compact-surface-state',
    ]) {
        const harness = createHarness();
        harness.emit('neko:idle-chat-compact-surface-state', {
            available: true,
            visible: true,
            screenRect: COMPACT_RECT,
            timestamp: 1_000,
        });
        harness.emit('neko:idle-chat-minimized-state', {
            available: true,
            minimized: true,
            screenRect: MINIMIZED_RECT,
            timestamp: 2_000,
        });
        harness.emit(terminalType, {
            available: false,
            minimized: false,
            visible: false,
            screenRect: null,
            timestamp: 3_000,
        });

        const state = harness.snapshot();
        assert.equal(state.minimized.minimized, false, terminalType);
        assert.equal(state.minimized.screenRect, null, terminalType);
        assert.equal(state.compact.visible, false, terminalType);
        assert.equal(state.compact.screenRect, null, terminalType);
    }
});

test('delayed unavailable terminals cannot overwrite a reopened target', () => {
    const harness = createHarness();
    harness.emit('neko:idle-chat-minimized-state', {
        available: false,
        timestamp: 2_000,
    });
    harness.emit('neko:idle-chat-minimized-state', {
        available: true,
        minimized: true,
        screenRect: MINIMIZED_RECT,
        timestamp: 4_000,
    });
    harness.emit('neko:idle-chat-compact-surface-state', {
        available: false,
        timestamp: 3_000,
    });
    let state = harness.snapshot();
    assert.equal(state.minimized.minimized, true);
    assert.deepEqual(state.minimized.screenRect, {
        ...MINIMIZED_RECT,
        right: MINIMIZED_RECT.left + MINIMIZED_RECT.width,
        bottom: MINIMIZED_RECT.top + MINIMIZED_RECT.height,
    });

    harness.emit('neko:idle-chat-compact-surface-state', {
        available: true,
        visible: true,
        screenRect: COMPACT_RECT,
        timestamp: 6_000,
    });
    harness.emit('neko:idle-chat-minimized-state', {
        available: false,
        timestamp: 5_000,
    });
    state = harness.snapshot();
    assert.equal(state.compact.visible, true);
    assert.deepEqual(state.compact.screenRect, {
        ...COMPACT_RECT,
        right: COMPACT_RECT.left + COMPACT_RECT.width,
        bottom: COMPACT_RECT.top + COMPACT_RECT.height,
    });
});
