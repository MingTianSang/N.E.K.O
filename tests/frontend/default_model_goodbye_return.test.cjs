const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const surfaceSource = fs.readFileSync(
  path.resolve(__dirname, '../../static/app/app-ui/surface-floating-controls.js'),
  'utf8',
);
const appStateSource = fs.readFileSync(
  path.resolve(__dirname, '../../static/app/app-state.js'),
  'utf8',
);
const resetSource = fs.readFileSync(
  path.resolve(__dirname, '../../static/app/app-interpage/listeners-and-api.js'),
  'utf8',
);
const modelReloadSource = fs.readFileSync(
  path.resolve(__dirname, '../../static/app/app-interpage/bootstrap-resources-and-model-reload.js'),
  'utf8',
);
const goodbyeResourceSource = fs.readFileSync(
  path.resolve(__dirname, '../../static/app/app-ui/bootstrap-goodbye-and-toasts.js'),
  'utf8',
);
const autoGoodbyeSource = fs.readFileSync(
  path.resolve(__dirname, '../../static/app/app-auto-goodbye.js'),
  'utf8',
);
const modelDisplaySource = fs.readFileSync(
  path.resolve(__dirname, '../../static/app/app-ui/model-display.js'),
  'utf8',
);
const returnTransitionsSource = fs.readFileSync(
  path.resolve(__dirname, '../../static/app/app-ui/return-transitions.js'),
  'utf8',
);
const pngtuberSource = fs.readFileSync(
  path.resolve(__dirname, '../../static/pngtuber-core.js'),
  'utf8',
);

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createResetHarness({
  hasReloadHandler = true,
  returnResult = true,
  temporaryReloadFails = false,
  temporaryReloadResult = true,
  putOk = true,
  putData = { success: true },
  putNeverResolves = false,
  putRejects = false,
  persistenceStatusData = { success: true, state: 'succeeded' },
  persistenceTimeoutMs = 10_000,
  hasQueueHoldRelease = false,
} = {}) {
  const functionStart = resetSource.indexOf('async function resetToDefaultModel() {');
  const functionEnd = resetSource.indexOf('    // =====================================================================\n    // Public API', functionStart);
  const resetFunction = resetSource.slice(functionStart, functionEnd);
  const calls = [];
  const parts = {};
  if (hasReloadHandler) {
    parts.handleModelReload = async (name, options = {}) => {
      calls.push({ type: 'reload', name, options });
      if (options.temporaryConfig && temporaryReloadFails) {
        throw new Error('temporary_reload_failed');
      }
      return options.temporaryConfig ? temporaryReloadResult : true;
    };
  }
  if (hasQueueHoldRelease) {
    parts.releaseModelReloadQueueHold = (token) => {
      calls.push({ type: 'release', token });
    };
  }
  const window = {
    lanlan_config: { lanlan_name: 'Test Character' },
    appUi: {
      async returnFromGoodbye(options) {
        calls.push({ type: 'return', options });
        return returnResult;
      },
    },
    showStatusToast(message) {
      calls.push({ type: 'toast', message });
    },
    AbortController,
    setTimeout,
    clearTimeout,
  };
  const document = { querySelector: () => null };
  const fetch = async (url, options) => {
    const isPersistenceStatus = url.includes('/catgirl/l2d/persistence/');
    calls.push({ type: isPersistenceStatus ? 'status' : 'put', url, options });
    if (isPersistenceStatus) {
      return {
        ok: persistenceStatusData.success === true,
        status: persistenceStatusData.success === true ? 200 : 404,
        async json() { return persistenceStatusData; },
      };
    }
    if (putNeverResolves) {
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    if (putRejects) throw new Error('response_lost');
    return {
      ok: putOk,
      status: putOk ? 200 : 500,
      async json() { return putData; },
    };
  };

  vm.runInNewContext(`
    var DEFAULT_LIVE2D_MODEL_NAME = 'yui-lolita';
    var DEFAULT_LIVE2D_MODEL_PATH = '/static/yui-lolita/yui-lolita.model3.json';
    var DEFAULT_MODEL_PERSIST_TIMEOUT_MS = ${persistenceTimeoutMs};
    var _resetToDefaultModelInFlight = false;
    ${resetFunction}
    window.runResetToDefaultModel = resetToDefaultModel;
  `, {
    window,
    document,
    fetch,
    I: parts,
    console,
    JSON,
    String,
    encodeURIComponent,
  }, { filename: 'reset-to-default-model.js' });

  return { window, calls };
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
      cancelled: false,
      source: 'live2d-return-click',
      resolve: returnLifecycle.resolve,
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
    AbortController,
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
    activeTimerIds() {
      return [...timers.keys()];
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

test('an ordinary return has a finite timeout and restores a retryable state', async () => {
  const harness = createReturnHarness();
  const parts = harness.window.__appUiParts;
  const lifecycle = parts.beginNekoCatReturnLifecycle({ source: 'live2d-return-click' });
  let retryRestores = 0;
  lifecycle.restoreRetryState = () => { retryRestores += 1; };

  assert.notEqual(lifecycle.timeoutId, null);
  harness.fireTimer(lifecycle.timeoutId);
  assert.equal(await lifecycle.promise, false);
  assert.equal(retryRestores, 1);
  assert.equal(lifecycle.signal.aborted, true);
  assert.equal(parts.nekoCatReturnLifecycle, null);
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

test('programmatic timeout aborts a joined return lifecycle', async () => {
  const harness = createReturnHarness({ returnInProgress: true });
  const parts = harness.window.__appUiParts;
  const lifecycle = parts.nekoCatReturnLifecycle;
  harness.setGoodbyeActive(false);
  const result = harness.window.appUi.returnFromGoodbye({
    source: 'reset-to-default-model',
    timeoutMs: 1000,
  });
  const helperTimerId = harness.activeTimerIds()[0];

  harness.fireTimer(helperTimerId);
  assert.equal(await result, false);
  assert.equal(await lifecycle.promise, false);
  assert.equal(parts.nekoCatReturnLifecycle, null);
  assert.equal(harness.dispatched.at(-1).detail.reason, 'programmatic-return-timeout');
});

test('the canonical return lifecycle serializes handlers and aborts a blocked viewport', () => {
  const handlerStart = surfaceSource.indexOf('const handleReturnClick = async (event) => {');
  const lifecycleStart = surfaceSource.indexOf('const returnLifecycle = I.beginNekoCatReturnLifecycle({', handlerStart);
  const viewportWait = surfaceSource.indexOf('await I.ensureModelViewportReadyBeforeShowCurrentModel({', handlerStart);
  const handlerEnd = surfaceSource.indexOf("window.addEventListener('live2d-return-click'", handlerStart);
  const handlerSource = surfaceSource.slice(handlerStart, handlerEnd);

  assert.ok(handlerStart < lifecycleStart && lifecycleStart < viewportWait);
  assert.match(handlerSource, /if \(!returnLifecycle\) \{[\s\S]*?return;/);
  assert.match(handlerSource, /while \([\s\S]*?returnDetail\.retryViewportRestore === true[\s\S]*?!returnLifecycle\.cancelled[\s\S]*?\)/);
  assert.match(handlerSource, /returnAbortReason = 'model-viewport-not-ready';/);
  assert.match(handlerSource, /I\.abortNekoCatReturnLifecycle\(returnLifecycle, returnAbortReason\)/);
  assert.match(surfaceSource, /new CustomEvent\('neko:cat-return-abort'/);
});

test('a cancelled committed return restores the complete suspended goodbye state', () => {
  const retryStart = surfaceSource.indexOf('function hideReturnedModelForRetry(goodbyeResourceSnapshot)');
  const retryEnd = surfaceSource.indexOf('function restoreReturnBallAfterBlockedModelViewport', retryStart);
  const retrySource = surfaceSource.slice(retryStart, retryEnd);
  const handlerStart = surfaceSource.indexOf('const handleReturnClick = async (event) => {');
  const handlerEnd = surfaceSource.indexOf("window.addEventListener('live2d-return-click'", handlerStart);
  const handlerSource = surfaceSource.slice(handlerStart, handlerEnd);

  assert.match(retrySource, /live2dManager\.setLocked\(true/);
  assert.match(retrySource, /vrmManager\.core\.setLocked\(true\)/);
  assert.match(retrySource, /mmdManager\.core\.setLocked\(true\)/);
  assert.match(retrySource, /window\.pngtuberManager\]\.forEach/);
  assert.match(retrySource, /I\.reapplyGoodbyeResourceSuspend\(goodbyeResourceSnapshot\)/);
  assert.match(handlerSource, /if \(returnStateCommitted\) \{\s*hideReturnedModelForRetry\(retryGoodbyeResourceSnapshot\)/);
  assert.match(handlerSource, /reason: 'return-abort-rollback'/);
  assert.match(goodbyeResourceSource, /I\.reapplyGoodbyeResourceSuspend = function reapplyGoodbyeResourceSuspend/);
  assert.match(goodbyeResourceSource, /snapshot\.subtitleWindowWasVisible = !!prior\.subtitleWindowWasVisible/);
  assert.match(goodbyeResourceSource, /snapshot\.agentHudWasVisible = !!prior\.agentHudWasVisible/);
  assert.match(autoGoodbyeSource, /window\.addEventListener\('neko:cat-return-abort', handleReturnAbort\)/);
  assert.match(autoGoodbyeSource, /syncGoodbyeSilentState\(true, 'return-abort'\)/);
});

test('PNGTuber retry state participates in the canonical goodbye predicate', () => {
  const window = {
    pngtuberManager: { _goodbyeClicked: true },
  };

  vm.runInNewContext(appStateSource, { window }, { filename: 'app-state.js' });

  assert.equal(window.isNekoGoodbyeModeActive(), true);
  assert.match(surfaceSource, /window\.pngtuberManager\._goodbyeClicked = true;/);
  assert.match(surfaceSource, /window\.pngtuberManager\._goodbyeClicked = false;/);
  assert.match(autoGoodbyeSource, /return window\.isNekoGoodbyeModeActive\(\);/);
});

test('PNGTuber dragged placement is consumed only after return settlement succeeds', () => {
  const completeDispatch = surfaceSource.indexOf("new CustomEvent('neko:cat-return-complete'");
  const pendingClear = surfaceSource.lastIndexOf(
    'I.pendingPngtuberReturnConfig = null;',
    completeDispatch,
  );

  assert.doesNotMatch(modelDisplaySource, /I\.pendingPngtuberReturnConfig = null;/);
  assert.notEqual(pendingClear, -1);
  assert.ok(pendingClear < completeDispatch);
  assert.match(
    surfaceSource.slice(pendingClear - 80, completeDispatch),
    /if \(isReturningToPngtuber\) \{[\s\S]*?I\.pendingPngtuberReturnConfig = null;/,
  );
});

test('default-model return skips restoring the model that is about to be replaced', () => {
  const handlerStart = surfaceSource.indexOf('const handleReturnClick = async (event) => {');
  const handlerEnd = surfaceSource.indexOf("window.addEventListener('live2d-return-click'", handlerStart);
  const handlerSource = surfaceSource.slice(handlerStart, handlerEnd);

  assert.match(handlerSource, /const restoreCurrentModel = returnDetail\.restoreCurrentModel !== false;/);
  assert.match(handlerSource, /if \(restoreCurrentModel\) \{[\s\S]*?await I\.showCurrentModel\(\{ signal: returnLifecycle\.signal \}\);/);
  assert.match(handlerSource, /else \{[\s\S]*?window\._nekoModelReturnEnterRect = null;/);
});

test('return cancellation reaches model lookup and PNGTuber loading', () => {
  assert.match(modelDisplaySource, /async function showCurrentModel\(options = \{\}\)/);
  assert.match(surfaceSource, /ensureModelViewportReadyBeforeShowCurrentModel\(\{[\s\S]*?signal: returnLifecycle\.signal/);
  assert.match(modelDisplaySource, /returnSignal \? \{ signal: returnSignal \} : undefined/);
  assert.match(modelDisplaySource, /await window\.loadPNGTuberAvatar\([\s\S]*?signal: returnSignal/);
  assert.match(pngtuberSource, /async function loadPNGTuberAvatar\(config, options = \{\}\)/);
  assert.match(pngtuberSource, /await this\.setupLayeredAdapter\(\{ config: normalizedConfig, isCurrentLoad, signal \}\)/);
  assert.match(pngtuberSource, /&& !\(signal && signal\.aborted\)/);
});

test('position persistence cannot block return completion', () => {
  assert.doesNotMatch(returnTransitionsSource, /await saveReturnModelPosition\(/);
  assert.match(returnTransitionsSource, /void saveReturnModelPosition\('pngtuber'\)/);
  assert.match(returnTransitionsSource, /void saveReturnModelPosition\('live2d'\)/);
  assert.match(returnTransitionsSource, /async function settleReturnedModelBounds\(shouldSaveWhenUnchanged, options = \{\}\)/);
  assert.match(returnTransitionsSource, /waitForReturnTransitionOperation\([\s\S]*?returnSignal/);
  assert.match(surfaceSource, /settleReturnedModelBounds\(returnModelWasMoved, \{[\s\S]*?signal: returnLifecycle\.signal/);
  assert.match(surfaceSource, /if \(returnStateCommitted\) \{\s*hideReturnedModelForRetry\(retryGoodbyeResourceSnapshot\)/);
  assert.match(surfaceSource, /\['live2d', 'vrm', 'mmd', 'pngtuber'\]\.forEach/);
});

test('default-model reset validates Live2D before persisting and restores on failure', () => {
  const returnCall = resetSource.indexOf('await window.appUi.returnFromGoodbye({');
  const reloadCall = resetSource.indexOf('await reloadModel(lanlanName, {', returnCall);
  const persistenceCall = resetSource.indexOf('putResp = await fetch(putUrl', reloadCall);
  const catchBlock = resetSource.indexOf('} catch (e) {', persistenceCall);
  const restoreCall = resetSource.indexOf('await reloadModel(lanlanName, {', catchBlock);

  assert.notEqual(returnCall, -1);
  assert.ok(returnCall < reloadCall, 'the full return path must restore the Pet viewport before hot reload');
  assert.ok(reloadCall < persistenceCall, 'the default Live2D must load before persistence');
  assert.ok(catchBlock < restoreCall, 'failure must re-fetch and restore the persisted previous model');
  assert.match(resetSource, /retryViewportRestore: true/);
  assert.match(resetSource, /restoreCurrentModel: false/);
  assert.match(resetSource, /if \(!returnedFromGoodbye\)/);
  assert.match(resetSource, /model_path: DEFAULT_LIVE2D_MODEL_PATH/);
  assert.match(resetSource, /skipIdleRestore: true/);
  assert.match(resetSource, /if \(defaultReloadResult !== true\)/);
  assert.match(resetSource, /apply_runtime: false/);
  assert.match(resetSource, /putData\.success !== true/);
  assert.match(resetSource, /persistence_operation_id: persistenceOperationId/);
  assert.match(resetSource, /await waitForPersistenceResult\(\)/);
  assert.match(resetSource, /if \(defaultReloadAttempted && !defaultPersisted && !persistenceOutcomeUnknown && reloadModel\)/);
});

test('default-model reset loads the built-in Live2D before persisting it', async () => {
  const harness = createResetHarness();
  const result = await harness.window.runResetToDefaultModel();
  const operationTypes = harness.calls
    .filter((call) => call.type !== 'toast')
    .map((call) => call.type);

  assert.deepEqual(operationTypes, ['return', 'reload', 'put']);
  assert.equal(result.success, true);
  const reload = harness.calls.find((call) => call.type === 'reload');
  assert.equal(reload.options.temporaryConfig.model_type, 'live2d');
  assert.equal(reload.options.temporaryConfig.model_path, '/static/yui-lolita/yui-lolita.model3.json');
  const put = harness.calls.find((call) => call.type === 'put');
  assert.equal(JSON.parse(put.options.body).apply_runtime, false);
});

test('default-model reset does not persist a superseded temporary reload', async () => {
  const harness = createResetHarness({ temporaryReloadResult: false });
  const result = await harness.window.runResetToDefaultModel();

  assert.equal(result.success, false);
  assert.equal(result.error, 'default_model_reload_not_applied');
  assert.deepEqual(
    harness.calls.filter((call) => call.type !== 'toast').map((call) => call.type),
    ['return', 'reload'],
  );
});

test('direct model reloads publish their final success result to callers', () => {
  const handlerStart = modelReloadSource.indexOf('I.handleModelReload = async function handleModelReload');
  const handlerEnd = modelReloadSource.indexOf('I.handleReloadModelParametersMessage =', handlerStart);
  const handler = modelReloadSource.slice(handlerStart, handlerEnd);

  assert.match(handler, /resolveReload\(window\._lastModelReloadResult\);/);
  assert.match(handler, /return window\._lastModelReloadResult === true;\s*}/);
});

test('default-model persistence keeps queued reloads behind the validated transaction', () => {
  const resetStart = resetSource.indexOf('async function resetToDefaultModel() {');
  const resetEnd = resetSource.indexOf('// Public API', resetStart);
  const reset = resetSource.slice(resetStart, resetEnd);
  const handlerStart = modelReloadSource.indexOf('I.handleModelReload = async function handleModelReload');
  const handlerEnd = modelReloadSource.indexOf('I.handleReloadModelParametersMessage =', handlerStart);
  const handler = modelReloadSource.slice(handlerStart, handlerEnd);

  assert.match(reset, /queueHoldToken: reloadQueueHoldToken/);
  assert.match(reset, /defaultPersisted = true;[\s\S]*?if \(reloadQueueHeld\) \{\s*I\.releaseModelReloadQueueHold/);
  assert.match(modelReloadSource, /I\.releaseModelReloadQueueHold = function releaseModelReloadQueueHold/);
  assert.match(handler, /var keepReloadQueueHeld = reloadSucceeded && !!queueHoldToken;/);
  assert.match(handler, /if \(!keepReloadQueueHeld\) schedulePendingModelReload\(\);/);
});

test('default-model persistence timeout releases the reload queue and reconciles server success', async () => {
  const harness = createResetHarness({
    putNeverResolves: true,
    persistenceTimeoutMs: 5,
    hasQueueHoldRelease: true,
  });
  const result = await harness.window.runResetToDefaultModel();
  const operationTypes = harness.calls
    .filter((call) => call.type !== 'toast')
    .map((call) => call.type);

  assert.equal(result.success, true);
  assert.deepEqual(operationTypes, ['return', 'reload', 'put', 'release', 'status', 'reload']);
  const reloads = harness.calls.filter((call) => call.type === 'reload');
  assert.equal(reloads[1].options.bypassRecentDedup, true);
  assert.equal(harness.calls.find((call) => call.type === 'put').options.signal.aborted, true);
});

test('confirmed persistence failure rolls back with recent reload deduplication bypassed', async () => {
  const harness = createResetHarness({
    putNeverResolves: true,
    persistenceStatusData: { success: true, state: 'failed', error: 'save_failed' },
    persistenceTimeoutMs: 5,
    hasQueueHoldRelease: true,
  });
  const result = await harness.window.runResetToDefaultModel();
  const reloads = harness.calls.filter((call) => call.type === 'reload');

  assert.equal(result.success, false);
  assert.match(result.error, /^default_model_persist_failed/);
  assert.equal(reloads.length, 2);
  assert.equal(reloads[1].options.bypassRecentDedup, true);
});

test('lost persistence response reconciles the server result before rollback', async () => {
  const harness = createResetHarness({
    putRejects: true,
    persistenceStatusData: { success: true, state: 'succeeded' },
    hasQueueHoldRelease: true,
  });
  const result = await harness.window.runResetToDefaultModel();

  assert.equal(result.success, true);
  assert.deepEqual(
    harness.calls.filter((call) => call.type !== 'toast').map((call) => call.type),
    ['return', 'reload', 'put', 'release', 'status', 'reload'],
  );
  assert.equal(harness.calls.filter((call) => call.type === 'reload').length, 2);
});

test('rollback reload bypasses the one-second completed-request deduplication path', () => {
  const handlerStart = modelReloadSource.indexOf('I.handleModelReload = async function handleModelReload');
  const handlerEnd = modelReloadSource.indexOf('I.handleReloadModelParametersMessage =', handlerStart);
  const handler = modelReloadSource.slice(handlerStart, handlerEnd);

  assert.match(handler, /var bypassRecentDedup = !!reloadOptions\.bypassRecentDedup;/);
  assert.match(handler, /if \(!bypassRecentDedup && !queueHoldToken && window\._lastModelReloadKey === reloadKey/);
  assert.match(resetSource, /bypassRecentDedup: true/);
});

test('default-model reset restores the persisted prior model when PUT reports failure', async () => {
  const harness = createResetHarness({ putData: { success: false, error: 'save_failed' } });
  const result = await harness.window.runResetToDefaultModel();
  const reloads = harness.calls.filter((call) => call.type === 'reload');

  assert.equal(result.success, false);
  assert.equal(result.error, 'HTTP 200: save_failed');
  assert.equal(reloads.length, 2);
  assert.ok(reloads[0].options.temporaryConfig);
  assert.equal(reloads[1].options.temporaryConfig, undefined);
});

test('default-model reset fails before leaving goodbye when hot reload is unavailable', async () => {
  const harness = createResetHarness({ hasReloadHandler: false });
  const result = await harness.window.runResetToDefaultModel();

  assert.equal(result.success, false);
  assert.equal(result.error, 'model_reload_unavailable');
  assert.deepEqual(harness.calls.map((call) => call.type), ['toast']);
});
