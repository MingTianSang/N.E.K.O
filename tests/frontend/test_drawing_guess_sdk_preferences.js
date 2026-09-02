const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message}: expected ${expectedJson}, got ${actualJson}`);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function storageResult(value, found = true) {
  return {
    ok: true,
    data: {
      ok: true,
      found,
      value,
    },
  };
}

function storedResult() {
  return {
    ok: true,
    data: {
      ok: true,
      stored: true,
    },
  };
}

function makeStorageClient(storage, enabled = true) {
  return {
    disposed: false,
    capabilities: {
      has(name) { return enabled && name === 'storage'; },
    },
    storage,
  };
}

function loadHarness() {
  const sourcePath = path.resolve(
    __dirname,
    '../../static/game/games/drawing_guess/drawing-guess.js',
  );
  const source = fs.readFileSync(sourcePath, 'utf8');
  const closingMarker = '\n})();';
  const closingIndex = source.lastIndexOf(closingMarker);
  assert(closingIndex >= 0, 'drawing-guess IIFE closing marker must exist');

  let localStorageReads = 0;
  const sandbox = {
    console,
    Promise,
    Set,
    Map,
    WeakMap,
    Date,
    Math,
    JSON,
    Number,
    String,
    Object,
    Array,
    RegExp,
    Error,
    TypeError,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame(callback) { return setTimeout(callback, 0); },
    cancelAnimationFrame(timer) { clearTimeout(timer); },
    document: {
      readyState: 'loading',
      addEventListener() {},
      getElementById() { return null; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      createElement() {
        return {
          addEventListener() {},
          appendChild() {},
          classList: { add() {}, remove() {}, toggle() {} },
          dataset: {},
          style: { setProperty() {} },
        };
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.__DRAWING_GUESS_BOOT__ = {};
  Object.defineProperty(sandbox, 'localStorage', {
    configurable: true,
    get() {
      localStorageReads += 1;
      throw new Error('raw_local_storage_access');
    },
  });

  const testExport = `
  window.__DRAWING_GUESS_PREFERENCE_TEST__ = {
    state: state,
    ensureSdkPreferenceChannels: ensureSdkPreferenceChannels,
    queueSdkPreferenceWrite: queueSdkPreferenceWrite,
    flushSdkPreferenceChannel: flushSdkPreferenceChannel,
    hydrateSdkPreferenceChannel: hydrateSdkPreferenceChannel,
    hydrateSdkPreferences: hydrateSdkPreferences,
    saveModelViewSettings: saveModelViewSettings,
    saveColorHistory: saveColorHistory,
    configureSdkMemoryConsent: configureSdkMemoryConsent,
    applySdkLocale: applySdkLocale,
    currentLanguage: currentLanguage,
    installLocaleUiSpies: function () {
      var calls = { updateControls: 0, setPhase: 0, syncBrushToolButton: 0 };
      updateControls = function () { calls.updateControls += 1; };
      setPhase = function () { calls.setPhase += 1; };
      syncBrushToolButton = function () { calls.syncBrushToolButton += 1; };
      return calls;
    }
  };
`;
  const instrumented = source.slice(0, closingIndex) + testExport + source.slice(closingIndex);
  vm.runInNewContext(instrumented, sandbox, {
    filename: sourcePath,
    timeout: 5000,
  });

  return {
    api: sandbox.__DRAWING_GUESS_PREFERENCE_TEST__,
    source,
    localStorageReads: () => localStorageReads,
  };
}

async function testLateHydrationKeepsLocalSideAndColorChanges() {
  const harness = loadHarness();
  const api = harness.api;
  const pendingReads = new Map();
  const writes = [];
  const storage = {
    get(key) {
      const read = deferred();
      pendingReads.set(key, read);
      return read.promise;
    },
    set(key, value) {
      writes.push({ key, value });
      return Promise.resolve(storedResult());
    },
  };
  const client = makeStorageClient(storage);
  api.state.sdkClient = client;

  const hydration = api.hydrateSdkPreferences(client);
  assertEqual(pendingReads.size, 3, 'all preference channels should begin hydration');

  api.state.sideSplitRatio = 0.77;
  api.queueSdkPreferenceWrite('sideSplit');
  api.state.colorHistory = ['#123456', '#abcdef'];
  api.saveColorHistory();

  pendingReads.get('settings/model-views').resolve(storageResult(undefined, false));
  pendingReads.get('settings/side-split-ratio').resolve(storageResult(0.31));
  pendingReads.get('settings/color-history').resolve(storageResult(['#fedcba']));
  await hydration;

  assertEqual(api.state.sideSplitRatio, 0.77, 'late side split hydration must not overwrite a local edit');
  assertDeepEqual(
    api.state.colorHistory,
    ['#123456', '#abcdef'],
    'late color hydration must not overwrite a local edit',
  );
  const sideWrite = writes.find((entry) => entry.key === 'settings/side-split-ratio');
  const colorWrite = writes.find((entry) => entry.key === 'settings/color-history');
  assert(sideWrite, 'dirty side split should be persisted after hydration');
  assert(colorWrite, 'dirty color history should be persisted after hydration');
  assertEqual(sideWrite.value, 0.77, 'persisted side split should use the local value');
  assertDeepEqual(colorWrite.value, ['#123456', '#abcdef'], 'persisted colors should use local values');
}

async function testLateModelViewHydrationMergesWithLocalPriority() {
  const harness = loadHarness();
  const api = harness.api;
  const read = deferred();
  const writes = [];
  const client = makeStorageClient({
    get() { return read.promise; },
    set(key, value) {
      writes.push({ key, value });
      return Promise.resolve(storedResult());
    },
  });
  api.state.sdkClient = client;
  api.state.lanlanName = 'Local Neko';
  api.state.modelViewSettings = [];

  const channel = api.ensureSdkPreferenceChannels().modelViews;
  const hydration = api.hydrateSdkPreferenceChannel(client, channel);
  api.state.modelView = { scale: 245, x: 12, y: -8 };
  api.saveModelViewSettings();

  read.resolve(storageResult([
    { character: 'Local Neko', view: { scale: 90, x: 1, y: 2 } },
    { character: 'Remote Neko', view: { scale: 175, x: -4, y: 9 } },
  ]));
  await hydration;

  const local = api.state.modelViewSettings.find((entry) => entry.character === 'Local Neko');
  const remote = api.state.modelViewSettings.find((entry) => entry.character === 'Remote Neko');
  assertDeepEqual(local.view, { scale: 245, x: 12, y: -8 }, 'current local model view must win the merge');
  assertDeepEqual(remote.view, { scale: 175, x: -4, y: 9 }, 'other remote character views must be retained');
  assertDeepEqual(api.state.modelView, local.view, 'the active model view should remain the local value');
  assertEqual(writes.length, 1, 'the merged model-view snapshot should be persisted once');
  assertEqual(writes[0].value.length, 2, 'the persisted model-view snapshot should contain both characters');
}

async function testCommittedWriteWaitsForHydrationBeforePersisting() {
  const harness = loadHarness();
  const api = harness.api;
  const read = deferred();
  const writes = [];
  let backingValue = [
    { character: 'Remote Neko', view: { scale: 175, x: -4, y: 9 } },
  ];
  const client = makeStorageClient({
    get() { return read.promise; },
    set(key, value) {
      backingValue = value;
      writes.push({ key, value });
      return Promise.resolve(storedResult());
    },
  });
  api.state.sdkClient = client;
  api.state.lanlanName = 'Local Neko';
  api.state.modelViewSettings = [];

  const channel = api.ensureSdkPreferenceChannels().modelViews;
  const hydration = api.hydrateSdkPreferenceChannel(client, channel);
  api.state.modelView = { scale: 245, x: 12, y: -8 };
  api.saveModelViewSettings();

  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(writes.length, 0, 'an immediate commit must not write before initial hydration settles');

  read.resolve(storageResult(backingValue));
  await hydration;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertEqual(writes.length, 1, 'hydration settlement should release one merged write');
  assertDeepEqual(
    writes[0].value.map((entry) => entry.character),
    ['Local Neko', 'Remote Neko'],
    'the first write must preserve local priority and untouched remote characters',
  );
}

async function testFailedHydrationRetriesBeforeMergingAndWriting() {
  const harness = loadHarness();
  const api = harness.api;
  const writes = [];
  let reads = 0;
  let backingValue = [
    { character: 'Remote Neko', view: { scale: 175, x: -4, y: 9 } },
  ];
  const client = makeStorageClient({
    get() {
      reads += 1;
      if (reads === 1) return Promise.reject(new Error('temporary_read_failure'));
      return Promise.resolve(storageResult(backingValue));
    },
    set(key, value) {
      backingValue = value;
      writes.push({ key, value });
      return Promise.resolve(storedResult());
    },
  });
  api.state.sdkClient = client;
  api.state.lanlanName = 'Local Neko';
  api.state.modelViewSettings = [];

  const channel = api.ensureSdkPreferenceChannels().modelViews;
  const firstHydration = api.hydrateSdkPreferenceChannel(client, channel);
  api.state.modelView = { scale: 245, x: 12, y: -8 };
  api.saveModelViewSettings();

  assertEqual(await firstHydration, false, 'the failed read should remain an unhydrated result');
  assertEqual(writes.length, 0, 'a failed read must not be treated as an absent storage key');
  assertDeepEqual(
    backingValue.map((entry) => entry.character),
    ['Remote Neko'],
    'the failed read path must not overwrite the existing remote snapshot',
  );

  await new Promise((resolve) => setTimeout(resolve, 240));
  assertEqual(reads, 2, 'a failed hydration should perform one bounded retry');
  assertEqual(writes.length, 1, 'the successful retry should release one merged write');
  assertDeepEqual(
    writes[0].value.map((entry) => entry.character),
    ['Local Neko', 'Remote Neko'],
    'the retry must merge dirty local state with the authoritative remote snapshot',
  );
}

async function testPreferenceWritesAreSerializedAndCoalesceFinalSnapshot() {
  const harness = loadHarness();
  const api = harness.api;
  const writes = [];
  let activeWrites = 0;
  let maxActiveWrites = 0;
  const client = makeStorageClient({
    get() { return Promise.resolve(storageResult(undefined, false)); },
    set(key, value) {
      const completion = deferred();
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      writes.push({ key, value, completion });
      return completion.promise.finally(() => { activeWrites -= 1; });
    },
  });
  api.state.sdkClient = client;
  const channel = api.ensureSdkPreferenceChannels().colorHistory;
  channel.hydrated = true;

  api.state.colorHistory = ['#111111'];
  api.saveColorHistory();
  assertEqual(writes.length, 1, 'the first dirty snapshot should start one write');

  api.state.colorHistory = ['#222222', '#111111'];
  api.saveColorHistory();
  api.state.colorHistory = ['#333333', '#222222', '#111111'];
  api.saveColorHistory();
  assertEqual(writes.length, 1, 'a write in flight must block overlapping storage.set calls');

  writes[0].completion.resolve(storedResult());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(writes.length, 2, 'a changed revision should trigger one follow-up write');
  assertEqual(maxActiveWrites, 1, 'preference writes must remain serialized');
  assertDeepEqual(
    writes[1].value,
    ['#333333', '#222222', '#111111'],
    'the follow-up write should persist the final coalesced snapshot',
  );

  writes[1].completion.resolve(storedResult());
  await new Promise((resolve) => setTimeout(resolve, 0));
  assertEqual(activeWrites, 0, 'the final write should settle cleanly');
  assertEqual(writes.length, 2, 'intermediate snapshots should not create extra writes');
}

async function testUnavailableStorageNeverFallsBackToRawLocalStorage() {
  const harness = loadHarness();
  const api = harness.api;
  assert(!/\blocalStorage\b/.test(harness.source), 'game source must not contain a raw localStorage dependency');

  let storagePropertyReads = 0;
  const client = {
    disposed: false,
    capabilities: { has() { return false; } },
  };
  Object.defineProperty(client, 'storage', {
    get() {
      storagePropertyReads += 1;
      throw new Error('storage_capability_was_not_granted');
    },
  });
  api.state.sdkClient = client;

  const hydrated = await api.hydrateSdkPreferences(client);
  api.state.colorHistory = ['#445566'];
  api.saveColorHistory();
  const flushed = await api.flushSdkPreferenceChannel(api.ensureSdkPreferenceChannels().colorHistory);

  assertEqual(hydrated, false, 'hydration should be a no-op without storage capability');
  assertEqual(flushed, false, 'flush should be a no-op without storage capability');
  assertEqual(storagePropertyReads, 0, 'client.storage must not be touched without capability');
  assertEqual(harness.localStorageReads(), 0, 'raw localStorage must never be read');
}

async function testMemoryConsentUsesSdkAndRejectsLockedMismatch() {
  const enabledHarness = loadHarness();
  const enabledCalls = [];
  enabledHarness.api.state.memoryConsent = 'summary';
  const enabled = await enabledHarness.api.configureSdkMemoryConsent({
    memory: {
      consent: { locked: false, configured: false, enabled: false },
      configureConsent(value, options) {
        enabledCalls.push({ value, options });
        return Promise.resolve({ ok: true, data: { ok: true, enabled: value } });
      },
    },
  });
  assertEqual(enabled, true, 'summary consent should be accepted');
  assertEqual(enabledCalls.length, 1, 'summary consent should call the SDK once');
  assertEqual(enabledCalls[0].value, true, 'summary consent should configure true');

  const disabledHarness = loadHarness();
  const disabledCalls = [];
  disabledHarness.api.state.memoryConsent = 'none';
  const disabled = await disabledHarness.api.configureSdkMemoryConsent({
    memory: {
      consent: { locked: false, configured: false, enabled: false },
      configureConsent(value, options) {
        disabledCalls.push({ value, options });
        return Promise.resolve({ ok: true, data: { ok: true, enabled: value } });
      },
    },
  });
  assertEqual(disabled, true, 'none consent should be accepted');
  assertEqual(disabledCalls.length, 1, 'none consent should call the SDK once');
  assertEqual(disabledCalls[0].value, false, 'none consent should configure false');

  const lockedHarness = loadHarness();
  let lockedConfigureCalls = 0;
  lockedHarness.api.state.memoryConsent = 'summary';
  let lockedError = null;
  try {
    await lockedHarness.api.configureSdkMemoryConsent({
      memory: {
        consent: { locked: true, configured: true, enabled: false },
        configureConsent() {
          lockedConfigureCalls += 1;
          return Promise.resolve(storedResult());
        },
      },
    });
  } catch (error) {
    lockedError = error;
  }
  assert(lockedError, 'a locked consent mismatch must reject');
  assertEqual(lockedError.code, 'memory_consent_locked', 'locked mismatch should use a stable error code');
  assertEqual(lockedConfigureCalls, 0, 'locked mismatch must not call configureConsent');
}

async function testSdkLocaleUpdatesCachedLanguage() {
  const harness = loadHarness();
  const api = harness.api;
  const uiCalls = api.installLocaleUiSpies();
  api.state.locale = 'zh-CN';

  api.applySdkLocale({ language: ' ja ' });

  assertEqual(api.state.locale, 'ja', 'SDK locale should update the cached language');
  assertEqual(api.currentLanguage(), 'ja', 'localized helpers should read the SDK locale cache');
  assertEqual(uiCalls.updateControls, 1, 'locale change should refresh controls');
  assertEqual(uiCalls.setPhase, 1, 'locale change should refresh phase copy');
  assertEqual(uiCalls.syncBrushToolButton, 1, 'locale change should refresh brush labels');

  api.applySdkLocale({ language: 'ja' });
  assertEqual(uiCalls.updateControls, 1, 'an unchanged locale should not trigger another UI refresh');
}

async function main() {
  await testLateHydrationKeepsLocalSideAndColorChanges();
  await testLateModelViewHydrationMergesWithLocalPriority();
  await testCommittedWriteWaitsForHydrationBeforePersisting();
  await testFailedHydrationRetriesBeforeMergingAndWriting();
  await testPreferenceWritesAreSerializedAndCoalesceFinalSnapshot();
  await testUnavailableStorageNeverFallsBackToRawLocalStorage();
  await testMemoryConsentUsesSdkAndRejectsLockedMismatch();
  await testSdkLocaleUpdatesCachedLanguage();
  process.stdout.write('drawing guess SDK preference tests passed\n');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
