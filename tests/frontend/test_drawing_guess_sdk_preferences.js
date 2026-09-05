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
    submitPlayerText: submitPlayerText,
    handleSdkVoiceState: handleSdkVoiceState,
    handleSpeechPlaybackState: handleSpeechPlaybackState,
    handleSdkPageExit: handleSdkPageExit,
    querySdkVoiceRouteState: querySdkVoiceRouteState,
    handoffOrdinaryVoiceToSdk: handoffOrdinaryVoiceToSdk,
    schedulePendingVoiceHandoffRetry: schedulePendingVoiceHandoffRetry,
    handleVoiceRouteButton: handleVoiceRouteButton,
    cleanupRouteResources: cleanupRouteResources,
    startRoute: startRoute,
    installPlayerTextSpies: function (handler) {
      addUserMessage = function () {};
      submitUserGuess = function (value, metadata) { return handler('user_guessing', value, metadata); };
      submitGameChat = function (value, options) { return handler('game_chat', value, options); };
      submitFeedbackInput = function (value, metadata) { return handler('feedback', value, metadata); };
    },
    installPageExitCleanupSpy: function (events) {
      cleanupRouteResources = function () { events.push('cleanup'); };
    },
    installVoiceUiSpy: function (events) {
      els.chatMessages = {};
      addEventMessage = function (key) {
        if (events) events.push(key);
      };
      updateControls = function () {};
    },
    installRouteUiSpies: function () {
      setStatus = function () {};
      addMessage = function () {};
      stopThinkingEventMessage = function () {};
      updateControls = function () {};
    },
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

async function testPlayerTextCommandsStaySerialized() {
  const harness = loadHarness();
  const api = harness.api;
  const first = deferred();
  const calls = [];
  api.installPlayerTextSpies((kind, value, metadata) => {
    calls.push({ kind, value, metadata });
    return value === 'first' ? first.promise : Promise.resolve();
  });
  api.state.routeActive = true;
  api.state.routeEnding = false;
  api.state.phase = 'user_guessing';

  assertEqual(api.submitPlayerText('first', { inputMetadata: { source: 'voice' } }), true,
    'the first player input should be accepted');
  assertEqual(api.submitPlayerText('second', { inputMetadata: { source: 'voice' } }), true,
    'the second player input should be queued');
  await Promise.resolve();
  await Promise.resolve();
  assertDeepEqual(calls.map((call) => call.value), ['first'],
    'a later voice transcript must not start while the first command is in flight');

  first.resolve();
  await api.state.playerTextChain;
  assertDeepEqual(calls.map((call) => call.value), ['first', 'second'],
    'queued player inputs must preserve recognition order');
}

async function testQueuedPlayerTextDoesNotCrossPhaseBoundary() {
  const harness = loadHarness();
  const api = harness.api;
  const first = deferred();
  const calls = [];
  api.installPlayerTextSpies((_kind, value) => {
    calls.push(value);
    return value === 'first' ? first.promise : Promise.resolve();
  });
  api.state.routeActive = true;
  api.state.routeEnding = false;
  api.state.phase = 'user_guessing';

  api.submitPlayerText('first');
  api.submitPlayerText('second');
  await Promise.resolve();
  await Promise.resolve();
  api.state.phase = 'ai_guess_feedback';
  first.resolve();
  await api.state.playerTextChain;

  assertDeepEqual(calls, ['first'],
    'queued text from an earlier phase must not be reinterpreted after the phase changes');
}

async function testVoiceStateCannotClearAnActiveControlRequest() {
  const harness = loadHarness();
  const api = harness.api;
  api.installVoiceUiSpy();
  api.state.voiceControlPending = true;

  api.handleSdkVoiceState({ active: true, reason: 'recognition_started' });

  assertEqual(api.state.voiceControlPending, true,
    'unsolicited recognition state must not clear the current toggle request fence');
}

async function testBackgroundVoiceQueryCannotClearANewerToggle() {
  const harness = loadHarness();
  const api = harness.api;
  const query = deferred();
  const client = {
    disposed: false,
    runtime: { state: 'running' },
    capabilities: { has(name) { return name === 'voice-input'; } },
    voice: { query() { return query.promise; } },
  };
  api.installVoiceUiSpy();
  api.state.sdkClient = client;
  api.state.routeActive = true;
  api.state.routeEnding = false;
  api.state.voiceControlRequestSequence = 3;
  const pendingQuery = api.querySdkVoiceRouteState(client);
  api.state.voiceControlRequestSequence = 4;
  api.state.voiceControlPending = true;
  api.state.voiceRouteActive = true;
  query.reject(new Error('query timeout'));
  await pendingQuery;

  assertEqual(api.state.voiceControlPending, true,
    'a stale background query must not clear the newer toggle pending fence');
  assertEqual(api.state.voiceRouteActive, true,
    'a stale background query must not overwrite the newer voice state');
}

async function testAutomaticVoiceHandoffUsesPendingFence() {
  const harness = loadHarness();
  const api = harness.api;
  const handoff = deferred();
  const calls = [];
  const client = {
    disposed: false,
    runtime: { state: 'running' },
    capabilities: { has(name) { return name === 'voice-input'; } },
    voice: {
      handoff(options) {
        calls.push(options);
        return handoff.promise;
      },
    },
  };
  api.installVoiceUiSpy();
  api.state.sdkClient = client;
  api.state.routeActive = true;
  api.state.routeEnding = false;
  api.state.voiceControlRequestSequence = 7;

  const pendingHandoff = api.handoffOrdinaryVoiceToSdk(client);
  api.handoffOrdinaryVoiceToSdk(client);

  assertEqual(calls.length, 1,
    'an automatic handoff already in flight must not dispatch a duplicate request');
  assertEqual(calls[0].timeoutMs, 12000,
    'automatic handoff must use the bounded voice-control timeout');
  assertEqual(api.state.voiceControlRequestSequence, 8,
    'automatic handoff must claim the next voice-control request sequence');
  assertEqual(api.state.voiceControlPending, true,
    'automatic handoff must hold the shared voice-control pending fence');

  handoff.resolve({ ok: true, active: true, reason: 'ordinary_voice_handed_off' });
  await pendingHandoff;
  assertEqual(api.state.voiceRouteActive, true,
    'a successful automatic handoff must publish the SDK voice state');
  assertEqual(api.state.voiceControlPending, false,
    'the owning automatic handoff must release the shared pending fence');
}

async function testStaleAutomaticVoiceHandoffCannotOverwriteNewerRequest() {
  const harness = loadHarness();
  const api = harness.api;
  const handoff = deferred();
  const client = {
    disposed: false,
    runtime: { state: 'running' },
    capabilities: { has(name) { return name === 'voice-input'; } },
    voice: { handoff() { return handoff.promise; } },
  };
  api.installVoiceUiSpy();
  api.state.sdkClient = client;
  api.state.routeActive = true;
  api.state.routeEnding = false;
  api.state.voiceControlRequestSequence = 12;

  const staleHandoff = api.handoffOrdinaryVoiceToSdk(client);
  api.state.voiceControlRequestSequence = 14;
  api.state.voiceControlPending = true;
  api.state.voiceRouteActive = false;
  handoff.resolve({ ok: true, active: true, reason: 'ordinary_voice_handed_off' });
  await staleHandoff;

  assertEqual(api.state.voiceRouteActive, false,
    'a stale handoff completion must not overwrite a newer voice request state');
  assertEqual(api.state.voiceControlPending, true,
    'a stale handoff completion must not release a newer request pending fence');
}

async function waitForCondition(predicate, message) {
  const deadline = Date.now() + 500;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function testPlaybackBlockedHandoffRetriesAfterPlaybackStops() {
  for (const failureMode of ['speech_playback_active', 'speech_playback_started']) {
    const harness = loadHarness();
    const api = harness.api;
    const events = [];
    let handoffCalls = 0;
    const handoffOptions = [];
    const intentEpoch = failureMode === 'speech_playback_active' ? 31 : 32;
    const client = {
      disposed: false,
      runtime: { state: 'running', session: { id: `tts-${intentEpoch}` } },
      capabilities: { has(name) { return name === 'voice-input'; } },
      voice: {
        handoff(options) {
          handoffCalls += 1;
          handoffOptions.push(options);
          if (handoffCalls === 1) {
            return Promise.resolve({
              ok: false,
              active: false,
              reason: failureMode,
              ordinary_voice_intent_epoch: intentEpoch,
            });
          }
          return Promise.resolve({ ok: true, active: true, reason: 'ordinary_voice_handed_off' });
        },
      },
    };
    api.installVoiceUiSpy(events);
    api.state.sdkClient = client;
    api.state.routeActive = true;
    api.state.routeEnding = false;
    api.state.speechPlaybackActive = true;

    const firstResult = await api.handoffOrdinaryVoiceToSdk(client);

    assertEqual(firstResult, false,
      `${failureMode} should defer rather than complete automatic handoff`);
    assertEqual(api.state.voiceHandoffRetryPending, true,
      `${failureMode} did not mark automatic handoff for retry`);
    assertEqual(api.state.voiceHandoffIntentEpoch, intentEpoch,
      `${failureMode} did not retain the ordinary-voice intent fence`);
    assertEqual(handoffCalls, 1,
      `${failureMode} retried while TTS was still active`);
    assert(!events.includes('drawingGuess.voice.controlFailed'),
      `${failureMode} surfaced as a user-visible voice failure`);

    api.handleSpeechPlaybackState({ active: false });
    await waitForCondition(
      () => handoffCalls === 2 && api.state.voiceControlPending === false,
      `${failureMode} was not retried after TTS became inactive`,
    );

    assertEqual(api.state.voiceRouteActive, true,
      `${failureMode} retry did not activate SDK voice`);
    assertEqual(handoffOptions[1].handoffIntentEpoch, intentEpoch,
      `${failureMode} retry did not bind the original ordinary-voice intent epoch`);
    assertEqual(api.state.voiceHandoffRetryPending, false,
      `${failureMode} retry state survived a successful handoff`);
    assertEqual(api.state.voiceHandoffRetryAttempts, 0,
      `${failureMode} retry attempt count survived a successful handoff`);
    assertEqual(api.state.voiceHandoffIntentEpoch, null,
      `${failureMode} retry retained the completed ordinary-voice intent fence`);
    assert(!events.includes('drawingGuess.voice.controlFailed'),
      `${failureMode} retry emitted a stale failure notice`);
  }
}

async function testPendingAudioWorkDoesNotRetryHandoffEarly() {
  const harness = loadHarness();
  const api = harness.api;
  let handoffCalls = 0;
  const client = {
    disposed: false,
    runtime: { state: 'running', session: { id: 'pending-audio-route' } },
    capabilities: { has(name) { return name === 'voice-input'; } },
    voice: {
      handoff() {
        handoffCalls += 1;
        return Promise.resolve({ ok: true, active: true });
      },
    },
  };
  api.installVoiceUiSpy([]);
  api.state.sdkClient = client;
  api.state.routeActive = true;
  api.state.routeEnding = false;
  api.state.voiceHandoffRetryPending = true;
  api.state.voiceHandoffIntentEpoch = 41;

  api.handleSpeechPlaybackState({
    active: true,
    pendingAudioWork: true,
    remainingSeconds: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assertEqual(api.state.speechPlaybackActive, true,
    'queued TTS audio work was not treated as active playback');
  assertEqual(handoffCalls, 0,
    'queued TTS audio work triggered an early voice handoff retry');
  assertEqual(api.state.voiceHandoffRetryAttempts, 0,
    'queued TTS audio work consumed a retry attempt without dispatching');
  assertEqual(api.state.voiceHandoffRetryPending, true,
    'queued TTS audio work discarded the pending handoff retry');
}

async function testPlaybackResumingBeforeRetryTimerDoesNotConsumeAttempt() {
  const harness = loadHarness();
  const api = harness.api;
  let handoffCalls = 0;
  const client = {
    disposed: false,
    runtime: { state: 'running', session: { id: 'playback-race-route' } },
    capabilities: { has(name) { return name === 'voice-input'; } },
    voice: {
      handoff() {
        handoffCalls += 1;
        return Promise.resolve({ ok: true, active: true });
      },
    },
  };
  api.installVoiceUiSpy([]);
  api.state.sdkClient = client;
  api.state.routeActive = true;
  api.state.routeEnding = false;
  api.state.speechPlaybackActive = true;
  api.state.voiceHandoffRetryPending = true;
  api.state.voiceHandoffIntentEpoch = 42;

  api.handleSpeechPlaybackState({ active: false });
  api.handleSpeechPlaybackState({ active: true, pendingAudioWork: true });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assertEqual(handoffCalls, 0,
    'a false-to-true playback race dispatched the retry while TTS was active');
  assertEqual(api.state.voiceHandoffRetryAttempts, 0,
    'a fenced retry timer consumed an attempt before dispatch');
  assertEqual(api.state.voiceHandoffRetryPending, true,
    'a fenced retry timer lost the retry needed after playback ends');
}

async function testNewOrdinaryVoiceIntentCancelsDeferredRetryQuietly() {
  const harness = loadHarness();
  const api = harness.api;
  const events = [];
  const handoffOptions = [];
  const client = {
    disposed: false,
    runtime: { state: 'running', session: { id: 'intent-change-route' } },
    capabilities: { has(name) { return name === 'voice-input'; } },
    voice: {
      handoff(options) {
        handoffOptions.push(options);
        if (handoffOptions.length === 1) {
          return Promise.resolve({
            ok: false,
            active: false,
            reason: 'speech_playback_active',
            ordinary_voice_intent_epoch: 77,
          });
        }
        return Promise.resolve({
          ok: false,
          active: false,
          reason: 'ordinary_voice_handoff_cancelled',
          ordinary_voice_intent_epoch: 78,
        });
      },
    },
  };
  api.installVoiceUiSpy(events);
  api.state.sdkClient = client;
  api.state.routeActive = true;
  api.state.routeEnding = false;
  api.state.speechPlaybackActive = true;

  await api.handoffOrdinaryVoiceToSdk(client);
  api.handleSpeechPlaybackState({ active: false });
  await waitForCondition(
    () => handoffOptions.length === 2 && api.state.voiceControlPending === false,
    'deferred handoff did not reach the ordinary-intent cancellation response',
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  assertEqual(handoffOptions[1].handoffIntentEpoch, 77,
    'deferred handoff was not fenced to the original ordinary-voice intent');
  assertEqual(handoffOptions.length, 2,
    'ordinary_voice_handoff_cancelled started another takeover attempt');
  assertEqual(api.state.voiceHandoffRetryPending, false,
    'ordinary intent cancellation left a retry armed');
  assertEqual(api.state.voiceHandoffRetryAttempts, 0,
    'ordinary intent cancellation did not clear retry attempts');
  assertEqual(api.state.voiceHandoffIntentEpoch, null,
    'ordinary intent cancellation retained the stale intent epoch');
  assert(!events.includes('drawingGuess.voice.controlFailed'),
    'ordinary intent cancellation surfaced as a voice failure');
}

async function testInitialPlaybackTransportFailureWithoutIntentDoesNotRetry() {
  const harness = loadHarness();
  const api = harness.api;
  const events = [];
  let handoffCalls = 0;
  const client = {
    disposed: false,
    runtime: { state: 'running', session: { id: 'transport-failure-route' } },
    capabilities: { has(name) { return name === 'voice-input'; } },
    voice: {
      handoff() {
        handoffCalls += 1;
        return Promise.reject(Object.assign(
          new Error('speech_playback_active'),
          { code: 'speech_playback_active' },
        ));
      },
    },
  };
  api.installVoiceUiSpy(events);
  api.state.sdkClient = client;
  api.state.routeActive = true;
  api.state.routeEnding = false;
  api.state.speechPlaybackActive = true;

  await api.handoffOrdinaryVoiceToSdk(client);
  api.handleSpeechPlaybackState({ active: false });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assertEqual(handoffCalls, 1,
    'a transport failure without an intent epoch started an unfenced retry');
  assertEqual(api.state.voiceHandoffRetryPending, false,
    'a transport failure without an intent epoch armed a retry');
  assertEqual(api.state.voiceHandoffRetryAttempts, 0,
    'a transport failure without an intent epoch consumed retry attempts');
  assert(!events.includes('drawingGuess.voice.controlFailed'),
    'playback transport rejection surfaced as a user-visible failure');
}

async function testHandoffRetryMaxExhaustionClearsState() {
  const harness = loadHarness();
  const api = harness.api;
  let handoffCalls = 0;
  const client = {
    disposed: false,
    runtime: { state: 'running', session: { id: 'retry-max-route' } },
    capabilities: { has(name) { return name === 'voice-input'; } },
    voice: {
      handoff() {
        handoffCalls += 1;
        return Promise.resolve({ ok: true, active: true });
      },
    },
  };
  api.installVoiceUiSpy([]);
  api.state.sdkClient = client;
  api.state.routeActive = true;
  api.state.routeEnding = false;
  api.state.speechPlaybackActive = false;
  api.state.voiceControlPending = false;
  api.state.voiceHandoffRetryPending = true;
  api.state.voiceHandoffRetryAttempts = 2;
  api.state.voiceHandoffIntentEpoch = 91;

  assertEqual(api.schedulePendingVoiceHandoffRetry(), false,
    'an exhausted handoff retry unexpectedly scheduled more work');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assertEqual(handoffCalls, 0,
    'an exhausted handoff retry dispatched another SDK request');
  assertEqual(api.state.voiceHandoffRetryPending, false,
    'max retry exhaustion left a retry pending');
  assertEqual(api.state.voiceHandoffRetryAttempts, 0,
    'max retry exhaustion retained the terminal attempt count');
  assertEqual(api.state.voiceHandoffIntentEpoch, null,
    'max retry exhaustion retained a stale ordinary-voice intent epoch');
}

async function testHandoffRetryWithoutRouteClearsState() {
  const harness = loadHarness();
  const api = harness.api;
  let handoffCalls = 0;
  const client = {
    disposed: false,
    runtime: { state: 'running', session: { id: 'missing-retry-route' } },
    capabilities: { has(name) { return name === 'voice-input'; } },
    voice: {
      handoff() {
        handoffCalls += 1;
        return Promise.resolve({ ok: true, active: true });
      },
    },
  };
  api.installVoiceUiSpy([]);
  api.state.sdkClient = client;
  api.state.routeActive = false;
  api.state.routeEnding = false;
  api.state.speechPlaybackActive = false;
  api.state.voiceControlPending = false;
  api.state.voiceHandoffRetryPending = true;
  api.state.voiceHandoffRetryAttempts = 1;
  api.state.voiceHandoffIntentEpoch = 92;

  assertEqual(api.schedulePendingVoiceHandoffRetry(), false,
    'a handoff retry without a live route unexpectedly scheduled work');
  await new Promise((resolve) => setTimeout(resolve, 20));

  assertEqual(handoffCalls, 0,
    'a handoff retry ran after its SDK route disappeared');
  assertEqual(api.state.voiceHandoffRetryPending, false,
    'missing route left a handoff retry pending');
  assertEqual(api.state.voiceHandoffRetryAttempts, 0,
    'missing route retained a handoff retry attempt count');
  assertEqual(api.state.voiceHandoffIntentEpoch, null,
    'missing route retained a stale ordinary-voice intent epoch');
}

async function testManualVoiceControlCancelsPendingHandoffRetry() {
  const harness = loadHarness();
  const api = harness.api;
  let handoffCalls = 0;
  const client = {
    disposed: false,
    runtime: { state: 'running' },
    capabilities: { has(name) { return name === 'voice-input'; } },
    voice: {
      connected: true,
      toggle() { return Promise.resolve({ ok: true, active: true }); },
      handoff() {
        handoffCalls += 1;
        return Promise.resolve({ ok: true, active: true });
      },
    },
  };
  api.installVoiceUiSpy([]);
  api.state.sdkClient = client;
  api.state.routeActive = true;
  api.state.routeEnding = false;
  api.state.voiceHandoffRetryPending = true;
  api.state.voiceHandoffRetryAttempts = 1;
  api.state.voiceHandoffIntentEpoch = 55;

  assertEqual(api.schedulePendingVoiceHandoffRetry(), true,
    'test setup did not enqueue the pending automatic handoff retry');
  api.handleVoiceRouteButton();

  assertEqual(api.state.voiceHandoffRetryPending, false,
    'manual voice control did not cancel the pending automatic handoff retry');
  assertEqual(api.state.voiceHandoffRetryAttempts, 0,
    'manual voice control did not reset the automatic retry attempt count');
  assertEqual(api.state.voiceHandoffIntentEpoch, null,
    'manual voice control retained the automatic retry intent fence');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEqual(handoffCalls, 0,
    'an already-scheduled automatic handoff ran after manual voice control took ownership');
}

async function testRouteCleanupCancelsPendingHandoffRetry() {
  const harness = loadHarness();
  const api = harness.api;
  let handoffCalls = 0;
  const client = {
    disposed: false,
    runtime: { state: 'running' },
    capabilities: { has(name) { return name === 'voice-input'; } },
    voice: {
      handoff() {
        handoffCalls += 1;
        return Promise.resolve({ ok: true, active: true });
      },
    },
  };
  api.installVoiceUiSpy([]);
  api.state.sdkClient = client;
  api.state.routeActive = true;
  api.state.routeEnding = false;
  api.state.voiceHandoffRetryPending = true;
  api.state.voiceHandoffRetryAttempts = 1;
  api.state.voiceHandoffIntentEpoch = 56;

  assertEqual(api.schedulePendingVoiceHandoffRetry(), true,
    'test setup did not enqueue the route-owned automatic handoff retry');
  api.cleanupRouteResources();

  assertEqual(api.state.voiceHandoffRetryPending, false,
    'route cleanup did not cancel the pending automatic handoff retry');
  assertEqual(api.state.voiceHandoffRetryAttempts, 0,
    'route cleanup did not reset the automatic retry attempt count');
  assertEqual(api.state.voiceHandoffIntentEpoch, null,
    'route cleanup retained the automatic retry intent fence');
  assertEqual(api.state.voiceControlPending, false,
    'route cleanup left the voice-control fence pending');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertEqual(handoffCalls, 0,
    'an already-scheduled automatic handoff ran after route cleanup');
}

async function testRouteStartDoesNotWaitForAutomaticVoiceHandoff() {
  const harness = loadHarness();
  const api = harness.api;
  const handoff = deferred();
  let handoffCalls = 0;
  const client = {
    disposed: false,
    runtime: {
      state: 'idle',
      session: { id: 'drawing-handoff-session', routeInstanceId: 'drawing-handoff-route' },
      start() {
        this.state = 'running';
        return Promise.resolve({ ok: true, data: { ok: true } });
      },
    },
    memory: {
      consent: { configured: true, enabled: false, locked: true },
    },
    capabilities: {
      granted: ['voice-input'],
      has(name) { return name === 'voice-input'; },
    },
    logger: {
      enableAfterRuntimeStart() { return Promise.resolve({ ok: false }); },
      info() {},
    },
    voice: {
      handoff(options) {
        handoffCalls += 1;
        assertEqual(options.timeoutMs, 12000,
          'route-start automatic handoff must use the bounded timeout');
        return handoff.promise;
      },
    },
  };
  api.installRouteUiSpies();
  api.state.lanlanName = 'SDK Neko';
  api.state.sessionId = 'drawing-handoff-session';
  api.state.sdkClient = client;

  let routeStartTimeout = null;
  const routeStarted = await Promise.race([
    api.startRoute(),
    new Promise((_resolve, reject) => {
      routeStartTimeout = setTimeout(() => {
        reject(new Error('route start waited for the optional voice handoff'));
      }, 1000);
    }),
  ]);
  clearTimeout(routeStartTimeout);

  assertEqual(routeStarted, true,
    'route start must resolve without awaiting the optional voice handoff Promise');
  assertEqual(handoffCalls, 1,
    'a successful route start must dispatch exactly one automatic voice handoff');
  assertEqual(api.state.voiceControlPending, true,
    'the still-pending background handoff must remain fenced after route start resolves');

  handoff.resolve({ ok: true, active: false, reason: 'ordinary_voice_inactive' });
  await Promise.resolve();
  await Promise.resolve();
}

async function testPageExitPostsVoiceStopBeforeCleanup() {
  const harness = loadHarness();
  const api = harness.api;
  const events = [];
  api.installPageExitCleanupSpy(events);
  api.state.sdkClient = {
    disposed: false,
    capabilities: { has(name) { return name === 'voice-input'; } },
    voice: {
      stop(options) {
        events.push(`stop:${options.timeoutMs}`);
        return Promise.resolve({ ok: true });
      },
    },
  };

  api.handleSdkPageExit();

  assertDeepEqual(events, ['stop:6500', 'cleanup'],
    'page exit must synchronously post the voice stop before local route cleanup');
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
  await testPlayerTextCommandsStaySerialized();
  await testQueuedPlayerTextDoesNotCrossPhaseBoundary();
  await testVoiceStateCannotClearAnActiveControlRequest();
  await testBackgroundVoiceQueryCannotClearANewerToggle();
  await testAutomaticVoiceHandoffUsesPendingFence();
  await testStaleAutomaticVoiceHandoffCannotOverwriteNewerRequest();
  await testPlaybackBlockedHandoffRetriesAfterPlaybackStops();
  await testPendingAudioWorkDoesNotRetryHandoffEarly();
  await testPlaybackResumingBeforeRetryTimerDoesNotConsumeAttempt();
  await testNewOrdinaryVoiceIntentCancelsDeferredRetryQuietly();
  await testInitialPlaybackTransportFailureWithoutIntentDoesNotRetry();
  await testHandoffRetryMaxExhaustionClearsState();
  await testHandoffRetryWithoutRouteClearsState();
  await testRouteCleanupCancelsPendingHandoffRetry();
  await testManualVoiceControlCancelsPendingHandoffRetry();
  await testRouteStartDoesNotWaitForAutomaticVoiceHandoff();
  await testPageExitPostsVoiceStopBeforeCleanup();
  process.stdout.write('drawing guess SDK preference tests passed\n');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
