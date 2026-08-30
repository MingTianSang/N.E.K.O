const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '../../static/app/app-react-chat-window/minimize-and-idle-dock.js'),
  'utf8',
);

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness({
  available = true,
  collapsed = true,
  getBounds = () => Promise.resolve({ x: 100, y: 200, width: 88, height: 88 }),
} = {}) {
  const emitted = [];
  const animationFrames = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  let boundsCalls = 0;
  let nextTimerId = 1;

  const bridge = {
    isCollapsed: () => collapsed,
    isIdleTargetAvailable: () => available,
    getBounds: () => {
      boundsCalls += 1;
      return getBounds();
    },
  };

  const document = {
    hidden: !available,
    addEventListener(type, listener) {
      documentListeners.set(type, listener);
    },
    querySelector() { return null; },
  };
  const parts = {
    isElectronChatWindow: () => true,
    electronChatMinimizedStateSignature: '',
    electronChatMinimizedStatePublishedAt: 0,
    electronChatMinimizedStateFrame: 0,
    electronChatMinimizedStateTimer: 0,
    electronChatMinimizedStateFullRateUntil: 0,
    ELECTRON_CHAT_MINIMIZED_STATE_HEARTBEAT_MS: 1000,
  };
  const window = {
    __appReactChatWindowParts: parts,
    reactChatWindowHost: {},
    nekoChatWindow: bridge,
    innerWidth: 1280,
    innerHeight: 720,
    screen: { availWidth: 1280, availHeight: 720 },
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
    cancelAnimationFrame() {},
    setInterval() { return nextTimerId += 1; },
    clearInterval() {},
    setTimeout() { return nextTimerId += 1; },
    clearTimeout() {},
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    dispatchEvent(event) {
      emitted.push(event);
      return true;
    },
  };

  class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  vm.runInNewContext(source, {
    window,
    document,
    CustomEvent,
    console,
    Promise,
    Date,
    Number,
    Math,
    Object,
    Array,
    String,
    Boolean,
    JSON,
  }, { filename: 'minimize-and-idle-dock.js' });

  return {
    parts,
    emitted,
    get boundsCalls() { return boundsCalls; },
    setAvailable(nextAvailable) {
      available = nextAvailable === true;
      document.hidden = !available;
    },
    setCollapsed(nextCollapsed) {
      collapsed = nextCollapsed === true;
    },
    flushAnimationFrames() {
      while (animationFrames.length) {
        animationFrames.shift()();
      }
    },
    dispatchVisibilityChange() {
      const listener = documentListeners.get('visibilitychange');
      assert.equal(typeof listener, 'function');
      listener();
    },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

test('a visible collapsed Electron chat publishes its minimized yarn target', async () => {
  const harness = createHarness();
  harness.parts.ensureElectronChatMinimizedStateBridge();
  harness.flushAnimationFrames();
  await flushPromises();

  assert.equal(harness.boundsCalls, 1);
  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.emitted[0].type, 'neko:idle-chat-minimized-state');
  assert.equal(harness.emitted[0].detail.available, true);
  assert.equal(harness.emitted[0].detail.minimized, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.emitted[0].detail.screenRect)),
    { left: 119, top: 219, width: 51, height: 51, right: 170, bottom: 270 },
  );
});

test('a hidden Electron chat retires the target without querying stale bounds', () => {
  const harness = createHarness({ available: false });
  harness.parts.ensureElectronChatMinimizedStateBridge();
  harness.flushAnimationFrames();

  assert.equal(harness.boundsCalls, 0);
  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.emitted[0].detail.available, false);
  assert.equal(harness.emitted[0].detail.minimized, false);
  assert.equal(harness.emitted[0].detail.screenRect, null);
});

test('a bounds reply that arrives after tray close cannot resurrect the yarn target', async () => {
  const deferredBounds = createDeferred();
  const harness = createHarness({ getBounds: () => deferredBounds.promise });
  harness.parts.ensureElectronChatMinimizedStateBridge();
  harness.flushAnimationFrames();
  assert.equal(harness.boundsCalls, 1);
  assert.equal(harness.emitted.length, 0);

  harness.setAvailable(false);
  harness.dispatchVisibilityChange();
  assert.equal(harness.emitted.length, 1);
  assert.equal(harness.emitted[0].detail.available, false);

  deferredBounds.resolve({ x: 100, y: 200, width: 88, height: 88 });
  await flushPromises();

  assert.equal(
    harness.emitted.some((event) => event.detail && event.detail.minimized === true),
    false,
  );
  assert.equal(harness.emitted.length, 1);
});
