const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const surfaceSource = fs.readFileSync(
  path.resolve(__dirname, '../../static/app/app-ui/surface-floating-controls.js'),
  'utf8',
);
const resetSource = fs.readFileSync(
  path.resolve(__dirname, '../../static/app/app-interpage/listeners-and-api.js'),
  'utf8',
);

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createReturnHarness({
  modelType = 'live2d',
  subType = '',
  visibleReturnType = '',
  transitionDirection = '',
  returnInProgress = false,
} = {}) {
  const listeners = new Map();
  const dispatched = [];
  let goodbyeActive = true;
  let nextTimerId = 1;
  const timers = new Map();

  const parts = { mod: {} };
  if (visibleReturnType) {
    parts.getVisibleIdleReturnBallContainer = () => ({
      id: `${visibleReturnType}-return-button-container`,
    });
  }
  const transition = transitionDirection ? createDeferred() : null;
  const returnLifecycle = returnInProgress ? createDeferred() : null;
  if (returnLifecycle) {
    parts.nekoCatReturnLifecycle = {
      settled: false,
      promise: returnLifecycle.promise,
    };
  }
  if (transition) {
    parts.nekoModelCatTransitionActive = {
      direction: transitionDirection,
      promise: transition.promise,
    };
    parts.isNekoModelCatTransitionActive = (direction = '') => {
      const active = parts.nekoModelCatTransitionActive;
      return !!(active && (!direction || active.direction === direction));
    };
  } else {
    parts.isNekoModelCatTransitionActive = () => false;
  }

  const window = {
    appUi: {},
    __appUiParts: parts,
    lanlan_config: {
      model_type: modelType,
      live3d_sub_type: subType,
    },
    isNekoGoodbyeModeActive: () => goodbyeActive,
    addEventListener(type, listener) {
      const bucket = listeners.get(type) || [];
      bucket.push(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type, listener) {
      const bucket = listeners.get(type) || [];
      listeners.set(type, bucket.filter((entry) => entry !== listener));
    },
    dispatchEvent(event) {
      dispatched.push(event);
      for (const listener of [...(listeners.get(event.type) || [])]) listener(event);
      return true;
    },
    setTimeout(callback) {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, callback);
      return timerId;
    },
    clearTimeout(timerId) {
      timers.delete(timerId);
    },
  };

  class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  vm.runInNewContext(surfaceSource, {
    window,
    document: {},
    CustomEvent,
    console,
    Promise,
    Number,
    String,
    Object,
    Array,
    Math,
  }, { filename: 'surface-floating-controls.js' });

  return {
    window,
    dispatched,
    setGoodbyeActive(value) {
      goodbyeActive = value === true;
    },
    complete() {
      goodbyeActive = false;
      window.dispatchEvent(new CustomEvent('neko:cat-return-complete'));
    },
    abort() {
      window.dispatchEvent(new CustomEvent('neko:cat-return-abort'));
    },
    completeTransition() {
      assert.ok(transition, 'the harness has no active transition');
      parts.nekoModelCatTransitionActive = null;
      transition.resolve({ completed: true, direction: transitionDirection });
    },
    completeReturnLifecycle(restored) {
      assert.ok(returnLifecycle, 'the harness has no active return lifecycle');
      parts.nekoCatReturnLifecycle = null;
      returnLifecycle.resolve(restored === true);
    },
    fireTimer(timerId) {
      const callback = timers.get(timerId);
      assert.equal(typeof callback, 'function', `timer ${timerId} is not active`);
      timers.delete(timerId);
      callback();
    },
  };
}

test('programmatic goodbye return is a no-op when the model is already present', async () => {
  const harness = createReturnHarness();
  harness.setGoodbyeActive(false);
  assert.equal(await harness.window.appUi.returnFromGoodbye(), true);
  assert.equal(harness.dispatched.length, 0);
});

test('canonical return lifecycle admits only one handler until it settles', async () => {
  const harness = createReturnHarness();
  const parts = harness.window.__appUiParts;
  const first = parts.beginNekoCatReturnLifecycle();

  assert.ok(first);
  assert.equal(parts.beginNekoCatReturnLifecycle(), null);
  parts.finishNekoCatReturnLifecycle(first, false);
  assert.equal(await first.promise, false);

  const next = parts.beginNekoCatReturnLifecycle();
  assert.ok(next);
  parts.finishNekoCatReturnLifecycle(next, true);
  assert.equal(await next.promise, true);
});

test('a timed-out return lifecycle aborts and releases the canonical handler lock', async () => {
  const harness = createReturnHarness();
  const parts = harness.window.__appUiParts;
  const lifecycle = parts.beginNekoCatReturnLifecycle({
    source: 'live2d-return-click',
    timeoutMs: 1000,
  });

  harness.fireTimer(lifecycle.timeoutId);
  assert.equal(await lifecycle.promise, false);
  assert.equal(parts.nekoCatReturnLifecycle, null);
  assert.equal(harness.dispatched.at(-1).type, 'neko:cat-return-abort');
  assert.equal(harness.dispatched.at(-1).detail.reason, 'return-lifecycle-timeout');
  assert.ok(parts.beginNekoCatReturnLifecycle());
});

for (const [modelType, subType, expectedEvent] of [
  ['live2d', '', 'live2d-return-click'],
  ['vrm', '', 'vrm-return-click'],
  ['live3d', 'vrm', 'vrm-return-click'],
  ['live3d', 'mmd', 'mmd-return-click'],
  ['mmd', '', 'mmd-return-click'],
  ['pngtuber', '', 'pngtuber-return-click'],
]) {
  test(`programmatic goodbye return follows the ${modelType}/${subType || '-'} model path`, async () => {
    const harness = createReturnHarness({ modelType, subType });
    const result = harness.window.appUi.returnFromGoodbye({ source: 'reset-to-default-model' });

    assert.equal(harness.dispatched[0].type, expectedEvent);
    assert.equal(harness.dispatched[0].detail.source, 'reset-to-default-model');

    harness.complete();
    assert.equal(await result, true);
  });
}

test('programmatic goodbye return reports an aborted canonical return', async () => {
  const harness = createReturnHarness({ modelType: 'live3d', subType: 'mmd' });
  const result = harness.window.appUi.returnFromGoodbye({ source: 'reset-to-default-model' });
  harness.abort();
  assert.equal(await result, false);
});

test('visible return control wins over a stale configured model type', async () => {
  const harness = createReturnHarness({ modelType: 'vrm', visibleReturnType: 'mmd' });
  const result = harness.window.appUi.returnFromGoodbye({ source: 'reset-to-default-model' });
  assert.equal(harness.dispatched[0].type, 'mmd-return-click');
  harness.complete();
  assert.equal(await result, true);
});

test('a visible PNGTuber return control is sufficient to detect goodbye state', async () => {
  const harness = createReturnHarness({ modelType: 'pngtuber', visibleReturnType: 'pngtuber' });
  harness.setGoodbyeActive(false);
  const result = harness.window.appUi.returnFromGoodbye({
    source: 'reset-to-default-model',
    restoreCurrentModel: false,
  });

  assert.equal(harness.dispatched[0].type, 'pngtuber-return-click');
  assert.equal(harness.dispatched[0].detail.restoreCurrentModel, false);
  harness.complete();
  assert.equal(await result, true);
});

test('programmatic return waits for an in-flight model-to-cat transition', async () => {
  const harness = createReturnHarness({
    modelType: 'live3d',
    subType: 'mmd',
    transitionDirection: 'model-to-cat',
  });
  const result = harness.window.appUi.returnFromGoodbye({ source: 'reset-to-default-model' });

  assert.equal(harness.dispatched.length, 0, 'return must not be dropped into the active transition');
  harness.completeTransition();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.dispatched[0].type, 'mmd-return-click');

  harness.complete();
  assert.equal(await result, true);
});

test('programmatic return joins an existing cat-to-model transition without redispatching', async () => {
  const harness = createReturnHarness({ transitionDirection: 'cat-to-model' });
  const result = harness.window.appUi.returnFromGoodbye({ source: 'reset-to-default-model' });
  await Promise.resolve();
  assert.equal(harness.dispatched.length, 0);
  harness.complete();
  assert.equal(await result, true);
});

test('programmatic return joins the active return lifecycle after goodbye flags are cleared', async () => {
  const harness = createReturnHarness({ returnInProgress: true });
  harness.setGoodbyeActive(false);
  const result = harness.window.appUi.returnFromGoodbye({ source: 'reset-to-default-model' });
  await Promise.resolve();

  assert.equal(harness.dispatched.length, 0);
  harness.completeReturnLifecycle(true);
  assert.equal(await result, true);
});

test('the canonical return lifecycle serializes handlers and aborts a blocked viewport', () => {
  const handlerStart = surfaceSource.indexOf('const handleReturnClick = async (event) => {');
  const lifecycleStart = surfaceSource.indexOf('const returnLifecycle = I.beginNekoCatReturnLifecycle({', handlerStart);
  const viewportWait = surfaceSource.indexOf('await I.ensureModelViewportReadyBeforeShowCurrentModel()', handlerStart);
  const handlerEnd = surfaceSource.indexOf("window.addEventListener('live2d-return-click'", handlerStart);
  const handlerSource = surfaceSource.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart < lifecycleStart && lifecycleStart < viewportWait);
  assert.match(handlerSource, /if \(!returnLifecycle\) \{[\s\S]*?return;/);
  assert.match(handlerSource, /while \([\s\S]*?returnDetail\.retryViewportRestore === true[\s\S]*?!returnLifecycle\.cancelled[\s\S]*?\)/);
  assert.match(handlerSource, /returnAbortReason = 'model-viewport-not-ready';/);
  assert.match(handlerSource, /I\.abortNekoCatReturnLifecycle\(returnLifecycle, returnAbortReason\)/);
  assert.match(surfaceSource, /new CustomEvent\('neko:cat-return-abort'/);
});

test('default-model return skips restoring the model that is about to be replaced', () => {
  const handlerStart = surfaceSource.indexOf('const handleReturnClick = async (event) => {');
  const handlerEnd = surfaceSource.indexOf("window.addEventListener('live2d-return-click'", handlerStart);
  const handlerSource = surfaceSource.slice(handlerStart, handlerEnd);

  assert.match(handlerSource, /const restoreCurrentModel = returnDetail\.restoreCurrentModel !== false;/);
  assert.match(handlerSource, /if \(restoreCurrentModel\) \{[\s\S]*?await I\.showCurrentModel\(\);/);
  assert.match(handlerSource, /else \{[\s\S]*?window\._nekoModelReturnEnterRect = null;/);
});

test('default-model reset returns from goodbye before persisting or hot-reloading', () => {
  const returnCall = resetSource.indexOf('await window.appUi.returnFromGoodbye({');
  const persistenceCall = resetSource.indexOf("var putResp = await fetch(putUrl", returnCall);
  const reloadCall = resetSource.indexOf('await I.handleModelReload(lanlanName, reloadOpts)', persistenceCall);

  assert.notEqual(returnCall, -1);
  assert.ok(returnCall < persistenceCall, 'the full return path must restore the Pet viewport before persistence');
  assert.ok(persistenceCall < reloadCall, 'the saved default must be visible to the hot reload');
  assert.match(resetSource, /retryViewportRestore: true/);
  assert.match(resetSource, /restoreCurrentModel: false/);
  assert.match(resetSource, /if \(!returnedFromGoodbye\)/);
});
