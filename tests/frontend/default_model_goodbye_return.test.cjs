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

function createReturnHarness({ modelType = 'live2d', subType = '', visibleReturnType = '' } = {}) {
  const listeners = new Map();
  const dispatched = [];
  let goodbyeActive = true;
  let nextTimerId = 1;

  const parts = { mod: {} };
  if (visibleReturnType) {
    parts.getVisibleIdleReturnBallContainer = () => ({
      id: `${visibleReturnType}-return-button-container`,
    });
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
    setTimeout() {
      nextTimerId += 1;
      return nextTimerId;
    },
    clearTimeout() {},
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
  };
}

test('programmatic goodbye return is a no-op when the model is already present', async () => {
  const harness = createReturnHarness();
  harness.setGoodbyeActive(false);
  assert.equal(await harness.window.appUi.returnFromGoodbye(), true);
  assert.equal(harness.dispatched.length, 0);
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

test('default-model reset returns from goodbye before persisting or hot-reloading', () => {
  const returnCall = resetSource.indexOf('await window.appUi.returnFromGoodbye({');
  const persistenceCall = resetSource.indexOf("var putResp = await fetch(putUrl", returnCall);
  const reloadCall = resetSource.indexOf('await I.handleModelReload(lanlanName, reloadOpts)', persistenceCall);

  assert.notEqual(returnCall, -1);
  assert.ok(returnCall < persistenceCall, 'the full return path must restore the Pet viewport before persistence');
  assert.ok(persistenceCall < reloadCall, 'the saved default must be visible to the hot reload');
  assert.match(resetSource, /if \(!returnedFromGoodbye \|\| goodbyeStillActive\)/);
});
