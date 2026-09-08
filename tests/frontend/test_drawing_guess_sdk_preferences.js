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

function sampleDrawingPlan(accent = '#f4cf45') {
  return {
    version: 1,
    width: 800,
    height: 600,
    background: '#fffdfa',
    elements: [
      {
        type: 'ellipse',
        cx: 400,
        cy: 310,
        rx: 190,
        ry: 125,
        fill: accent,
        stroke: '#2f3b45',
        stroke_width: 10,
      },
      {
        type: 'polyline',
        points: [[270, 310], [345, 365], [455, 365], [530, 310]],
        fill: 'none',
        stroke: '#2f3b45',
        stroke_width: 8,
        line_cap: 'round',
        line_join: 'round',
      },
    ],
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
  const createdCanvases = [];
  function makeCanvas() {
    const operations = [];
    const context = { operations };
    [
      'save', 'restore', 'beginPath', 'closePath', 'fill', 'stroke',
      'clearRect', 'fillRect', 'moveTo', 'lineTo', 'quadraticCurveTo',
      'arc', 'ellipse', 'rect', 'drawImage', 'setTransform',
    ].forEach((name) => {
      context[name] = (...args) => { operations.push({ name, args }); };
    });
    const canvas = {
      tagName: 'CANVAS',
      width: 0,
      height: 0,
      className: '',
      dataset: {},
      style: { setProperty() {}, removeProperty() {} },
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      addEventListener() {},
      getContext(kind) { return kind === '2d' ? context : null; },
      toDataURL(type, quality) {
        operations.push({ name: 'toDataURL', args: [type, quality] });
        return `data:${type || 'image/png'};base64,${this.width}x${this.height}`;
      },
      __context: context,
    };
    createdCanvases.push(canvas);
    return canvas;
  }
  function escapeXml(value) {
    return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }
  function serializeSvgNode(node) {
    const attrs = Object.entries(node.__attrs || {})
      .map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('');
    const children = (node.children || []).map(serializeSvgNode).join('');
    return children
      ? `<${node.tagName}${attrs}>${children}</${node.tagName}>`
      : `<${node.tagName}${attrs}/>`;
  }
  function makeSvgNode(tagName) {
    return {
      tagName,
      __attrs: {},
      children: [],
      setAttribute(key, value) { this.__attrs[String(key)] = String(value); },
      appendChild(child) { this.children.push(child); return child; },
      get outerHTML() { return serializeSvgNode(this); },
    };
  }
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
    Path2D: class {
      constructor(d) { this.d = d; }
    },
    XMLSerializer: class {
      serializeToString(node) { return serializeSvgNode(node); }
    },
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
      createElement(tagName) {
        if (String(tagName).toLowerCase() === 'canvas') return makeCanvas();
        return {
          addEventListener() {},
          appendChild() {},
          classList: { add() {}, remove() {}, toggle() {} },
          dataset: {},
          style: { setProperty() {} },
        };
      },
      createElementNS(_namespace, tagName) { return makeSvgNode(String(tagName)); },
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
    normalizeAiDrawingPlan: normalizeAiDrawingPlan,
    renderAiDrawingPlanToCanvas: renderAiDrawingPlanToCanvas,
    captureAiDrawingReviewImage: captureAiDrawingReviewImage,
    aiDrawingPlanToSvg: aiDrawingPlanToSvg,
    normalizeAiDrawingSvg: normalizeAiDrawingSvg,
    fitAiDrawingSvgToContent: fitAiDrawingSvgToContent,
    canvasDisplayPixelBounds: canvasDisplayPixelBounds,
    floodFillPixelBuffer: floodFillPixelBuffer,
    prepareAiDrawing: prepareAiDrawing,
    logSdkBestEffort: logSdkBestEffort,
    currentLanguage: currentLanguage,
    submitPlayerText: submitPlayerText,
    handleSdkVoiceState: handleSdkVoiceState,
    handleSpeechPlaybackState: handleSpeechPlaybackState,
    handleSdkPageExit: handleSdkPageExit,
    querySdkVoiceRouteState: querySdkVoiceRouteState,
    stopSdkVoiceBestEffort: stopSdkVoiceBestEffort,
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
    installAiDrawingFitSpies: function (stage, metrics) {
      els.aiDrawing = stage;
      measureSvgContentMetrics = function () { return metrics; };
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
    sandbox,
    createdCanvases,
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

async function testVoiceToggleUsesOfficialSdkControl() {
  const harness = loadHarness();
  const api = harness.api;
  const events = [];
  const toggleCalls = [];
  const client = {
    disposed: false,
    capabilities: { has(name) { return name === 'voice-input'; } },
    voice: {
      connected: true,
      toggle(options) {
        toggleCalls.push(options);
        return Promise.resolve({ ok: true, active: true });
      },
    },
  };
  api.installVoiceUiSpy(events);
  api.state.sdkClient = client;
  api.state.routeActive = true;
  api.state.routeEnding = false;

  api.handleVoiceRouteButton();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertEqual(toggleCalls.length, 1, 'voice toggle did not use the SDK voice facade');
  assertEqual(toggleCalls[0].timeoutMs, 12000, 'voice toggle lost its bounded timeout');
  assertEqual(api.state.voiceRouteActive, true, 'successful SDK toggle did not update route voice state');
  assertEqual(api.state.voiceControlPending, false, 'successful SDK toggle did not release its request fence');
  assert(events.includes('drawingGuess.voice.connectedNotice'),
    'successful SDK toggle did not publish the connected notice');
}

async function testRouteStartQueriesVoiceWithoutTakingOverMicrophone() {
  const harness = loadHarness();
  const api = harness.api;
  let queryCalls = 0;
  const client = {
    disposed: false,
    runtime: {
      state: 'idle',
      session: { id: 'drawing-query-session', routeInstanceId: 'drawing-query-route' },
      start() {
        this.state = 'running';
        return Promise.resolve({ ok: true, data: { ok: true } });
      },
    },
    memory: {
      consent: { locked: true, configured: true, enabled: false },
    },
    capabilities: {
      granted: ['voice-input'],
      has(name) { return name === 'voice-input'; },
    },
    logger: {
      enableAfterRuntimeStart() { return Promise.resolve({ ok: false }); },
    },
    voice: {
      query(options) {
        queryCalls += 1;
        assertEqual(options.timeoutMs, 5000, 'route-start voice query lost its bounded timeout');
        return Promise.resolve({ ok: true, active: false });
      },
    },
  };
  api.installRouteUiSpies();
  api.state.lanlanName = 'SDK Neko';
  api.state.sessionId = 'drawing-query-session';
  api.state.sdkClient = client;

  assertEqual(await api.startRoute(), true, 'route start failed before querying official voice state');
  await Promise.resolve();
  assertEqual(queryCalls, 1, 'route start did not query the official voice owner');
}

async function testCanvasDrawingPlanIsBoundedRenderedAndSerializable() {
  const harness = loadHarness();
  const api = harness.api;
  const normalized = api.normalizeAiDrawingPlan(sampleDrawingPlan());

  assert(normalized, 'a valid backend drawing plan was rejected by the browser renderer');
  assertEqual(normalized.version, 1, 'the drawing plan version changed during normalization');
  assertEqual(normalized.width, 800, 'the drawing plan width changed during normalization');
  assertEqual(normalized.height, 600, 'the drawing plan height changed during normalization');
  assertEqual(normalized.elements.length, 2, 'valid drawing primitives were dropped');

  const canvas = harness.sandbox.document.createElement('canvas');
  assertEqual(api.renderAiDrawingPlanToCanvas(normalized, canvas), true,
    'the normalized plan did not render to local Canvas');
  assertEqual(canvas.width, 800, 'the local drawing canvas used the wrong width');
  assertEqual(canvas.height, 600, 'the local drawing canvas used the wrong height');
  const operationNames = canvas.__context.operations.map((operation) => operation.name);
  assert(operationNames.includes('clearRect') && operationNames.includes('fillRect'),
    'Canvas rendering did not paint an opaque local background');
  assert(operationNames.includes('ellipse') && operationNames.includes('moveTo')
    && operationNames.includes('lineTo'),
  'Canvas rendering did not execute the declared geometry');
  assert(operationNames.includes('fill') && operationNames.includes('stroke'),
    'Canvas rendering lost the declared paint operations');

  const svg = api.aiDrawingPlanToSvg(normalized);
  assert(svg.includes('<svg') && svg.includes('viewBox="0 0 800 600"'),
    'the plan did not produce the SVG compatibility artifact');
  assert(svg.includes('<ellipse') && svg.includes('<polyline'),
    'the SVG compatibility artifact dropped drawing primitives');
  assert(!/<(?:text|script|image|foreignObject)\b/i.test(svg),
    'the local SVG serializer emitted a disallowed semantic or executable element');
  assert(!/url\(|https?:|data:image/i.test(svg),
    'the local SVG serializer emitted an external resource');

  const semanticPlan = sampleDrawingPlan();
  semanticPlan.elements[0].text = 'PRIVATE_ANSWER';
  assertEqual(api.normalizeAiDrawingPlan(semanticPlan), null,
    'the browser accepted an undeclared semantic field in a drawing element');
  const nullablePlan = sampleDrawingPlan();
  nullablePlan.version = null;
  assertEqual(api.normalizeAiDrawingPlan(nullablePlan), null,
    'the browser treated an explicit null plan version as the canonical version');
  const aliasPlan = sampleDrawingPlan();
  aliasPlan.elements[0] = {
    type: 'rect', x: 200, y: 160, width: 400, height: 280, radius: 12,
    fill: '#f4cf45', stroke: '#2f3b45', stroke_width: 8,
  };
  assertEqual(api.normalizeAiDrawingPlan(aliasPlan), null,
    'the browser accepted a rect radius alias outside the backend schema');
  const outOfBoundsPlan = sampleDrawingPlan();
  outOfBoundsPlan.elements[0].cx = 790;
  assertEqual(api.normalizeAiDrawingPlan(outOfBoundsPlan), null,
    'the browser silently changed an out-of-bounds backend drawing plan');
}

async function testRawAiSvgFillsResponsiveStage() {
  const harness = loadHarness();
  const attrs = { viewBox: '0 0 800 600', width: '800', height: '600' };
  const svg = {
    style: {},
    getAttribute(name) { return attrs[name] || null; },
    setAttribute(name, value) { attrs[name] = String(value); },
    removeAttribute(name) { delete attrs[name]; },
  };
  harness.api.normalizeAiDrawingSvg(svg);
  assertEqual(attrs.preserveAspectRatio, 'none',
    'raw AI SVG kept aspect-ratio letterboxing instead of filling the drawing stage');
  assert(!Object.prototype.hasOwnProperty.call(attrs, 'width')
    && !Object.prototype.hasOwnProperty.call(attrs, 'height'),
  'raw AI SVG kept fixed dimensions that can diverge from the player canvas');

  harness.api.installAiDrawingFitSpies({
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 1000, bottom: 500, width: 1000, height: 500 };
    },
  }, {
    bounds: { x1: 200, y1: 200, x2: 600, y2: 400 },
    centerX: 400,
    centerY: 300,
  });
  harness.api.fitAiDrawingSvgToContent(svg);
  const fittedViewBox = attrs.viewBox.split(/\s+/).map(Number);
  assert(Math.abs((fittedViewBox[2] / fittedViewBox[3]) - 2) < 0.001,
    'raw AI SVG content fitting ignored the responsive stage aspect ratio');
}

async function testBucketFillTreatsCanvasDisplayEdgeAsBoundary() {
  const harness = loadHarness();
  const width = 9;
  const height = 9;
  const pixels = new Uint8ClampedArray(width * height * 4);
  const barrier = { r: 36, g: 48, b: 58, a: 255 };
  const fill = { r: 244, g: 207, b: 69, a: 255 };
  const visibleBounds = { minX: 0, minY: 0, maxX: 8, maxY: 6 };
  function setTestPixel(x, y, color) {
    const index = (y * width + x) * 4;
    pixels[index] = color.r;
    pixels[index + 1] = color.g;
    pixels[index + 2] = color.b;
    pixels[index + 3] = color.a;
  }
  function testPixel(x, y) {
    const index = (y * width + x) * 4;
    return Array.from(pixels.slice(index, index + 4));
  }
  for (let y = 1; y < visibleBounds.maxY; y += 1) setTestPixel(4, y, barrier);

  assertEqual(harness.api.floodFillPixelBuffer(
    pixels, width, height, 1, 3, fill, visibleBounds,
  ), true,
    'bucket fill rejected an enclosed edge-bounded region');
  assertDeepEqual(testPixel(1, 3), [244, 207, 69, 255],
    'bucket fill did not color the selected side');
  assertDeepEqual(testPixel(1, 0), [244, 207, 69, 255],
    'bucket fill did not project the selected region onto the canvas edge');
  assertDeepEqual(testPixel(6, 3), [0, 0, 0, 0],
    'bucket fill escaped around a stroke ending at the canvas edge');
  assertDeepEqual(testPixel(6, 0), [0, 0, 0, 0],
    'the canvas edge connected two otherwise separate fill regions');
  assertDeepEqual(testPixel(4, 3), [36, 48, 58, 255],
    'bucket fill overwrote the brush boundary');
  assertDeepEqual(testPixel(1, 7), [0, 0, 0, 0],
    'bucket fill changed pixels clipped outside the visible canvas area');
  const pixelsBeforeHiddenStart = Array.from(pixels);
  assertEqual(harness.api.floodFillPixelBuffer(
    pixels, width, height, 1, 8, fill, visibleBounds,
  ), false, 'bucket fill accepted a start point outside the visible canvas area');
  assertDeepEqual(Array.from(pixels), pixelsBeforeHiddenStart,
    'an out-of-view bucket start changed the pixel buffer');
  assertEqual(harness.api.floodFillPixelBuffer(
    pixels, width, height, 1, 3, fill, null,
  ), false, 'bucket fill treated an explicitly invisible canvas as fully visible');
  assertDeepEqual(Array.from(pixels), pixelsBeforeHiddenStart,
    'an explicitly invisible canvas changed the pixel buffer');

  const mappedBounds = harness.api.canvasDisplayPixelBounds({
    width: 800,
    height: 600,
    getBoundingClientRect() {
      return { left: 0, top: -100, right: 800, bottom: 500, width: 800, height: 600 };
    },
  }, {
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 800, bottom: 400, width: 800, height: 400 };
    },
  });
  assertDeepEqual(mappedBounds, { minX: 0, minY: 100, maxX: 799, maxY: 499 },
    'visible canvas clipping was not mapped back into the pixel buffer');

  const clippingAncestor = {
    parentElement: null,
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 800, bottom: 300, width: 800, height: 300 };
    },
  };
  const stage = {
    parentElement: clippingAncestor,
    getBoundingClientRect() {
      return { left: 0, top: -100, right: 800, bottom: 400, width: 800, height: 500 };
    },
  };
  const clippedCanvas = {
    width: 800,
    height: 600,
    parentElement: stage,
    getBoundingClientRect() {
      return { left: 0, top: -100, right: 800, bottom: 500, width: 800, height: 600 };
    },
  };
  harness.sandbox.getComputedStyle = (element) => (element === clippingAncestor
    ? { overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden' }
    : { overflow: 'visible', overflowX: 'visible', overflowY: 'visible' });
  const ancestorClippedBounds = harness.api.canvasDisplayPixelBounds(clippedCanvas, stage);
  assertDeepEqual(ancestorClippedBounds, { minX: 0, minY: 100, maxX: 799, maxY: 399 },
    'an outer overflow clipping edge was not mapped back into the pixel buffer');

  harness.sandbox.visualViewport = {
    width: 800,
    height: 200,
    offsetLeft: 0,
    offsetTop: 50,
  };
  const viewportClippedBounds = harness.api.canvasDisplayPixelBounds(clippedCanvas, stage);
  assertDeepEqual(viewportClippedBounds, { minX: 0, minY: 150, maxX: 799, maxY: 349 },
    'the visual viewport edge was not mapped back into the pixel buffer');

  harness.sandbox.visualViewport = null;
  harness.sandbox.innerWidth = 2000;
  harness.sandbox.innerHeight = 2000;
  const yClip = {
    parentElement: null,
    __style: { overflow: 'visible', overflowX: 'visible', overflowY: 'hidden' },
    getBoundingClientRect() {
      return { left: -500, top: 0, right: 1000, bottom: 300, width: 1500, height: 300 };
    },
  };
  const visibleNarrowAncestor = {
    parentElement: yClip,
    __style: { overflow: 'visible', overflowX: 'visible', overflowY: 'visible' },
    getBoundingClientRect() {
      return { left: 250, top: 100, right: 300, bottom: 150, width: 50, height: 50 };
    },
  };
  const xClip = {
    parentElement: visibleNarrowAncestor,
    __style: { overflow: 'visible', overflowX: 'hidden', overflowY: 'visible' },
    getBoundingClientRect() {
      return { left: 0, top: -500, right: 600, bottom: 1000, width: 600, height: 1500 };
    },
  };
  const axisStage = {
    parentElement: xClip,
    getBoundingClientRect() {
      return { left: -100, top: -100, right: 700, bottom: 500, width: 800, height: 600 };
    },
  };
  const axisCanvas = {
    width: 800,
    height: 600,
    parentElement: axisStage,
    getBoundingClientRect() {
      return { left: -100, top: -100, right: 700, bottom: 500, width: 800, height: 600 };
    },
  };
  harness.sandbox.getComputedStyle = (element) => element.__style
    || { overflow: 'visible', overflowX: 'visible', overflowY: 'visible' };
  assertDeepEqual(
    harness.api.canvasDisplayPixelBounds(axisCanvas, axisStage),
    { minX: 100, minY: 100, maxX: 699, maxY: 399 },
    'axis-specific overflow clips or an overflow-visible ancestor were handled incorrectly',
  );

  const borderedClip = {
    parentElement: null,
    offsetWidth: 800,
    offsetHeight: 300,
    clientLeft: 1,
    clientTop: 1,
    clientWidth: 798,
    clientHeight: 298,
    __style: { overflow: 'hidden', overflowX: 'hidden', overflowY: 'hidden' },
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 800, bottom: 300, width: 800, height: 300 };
    },
  };
  stage.parentElement = borderedClip;
  assertDeepEqual(
    harness.api.canvasDisplayPixelBounds(clippedCanvas, stage),
    { minX: 1, minY: 101, maxX: 798, maxY: 398 },
    'the overflow client box did not exclude the ancestor border pixels',
  );

  borderedClip.getBoundingClientRect = () => (
    { left: 0, top: 700, right: 800, bottom: 1000, width: 800, height: 300 }
  );
  assertEqual(harness.api.canvasDisplayPixelBounds(clippedCanvas, stage), null,
    'a fully clipped canvas failed open to its entire backing buffer');

  clippedCanvas.getBoundingClientRect = () => (
    { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }
  );
  assertEqual(harness.api.canvasDisplayPixelBounds(clippedCanvas, stage), null,
    'a zero-sized canvas failed open to its entire backing buffer');
}

async function testComplexDrawingPlanSupportsCurvesAndMoreDetail() {
  const harness = loadHarness();
  const api = harness.api;
  const complexPlan = sampleDrawingPlan();
  complexPlan.elements = [
    {
      type: 'path',
      d: 'M 150 320 C 210 90 590 90 650 320 Q 400 540 150 320 Z',
      fill: '#f4cf45',
      stroke: '#2f3b45',
      stroke_width: 8,
    },
  ].concat(Array.from({ length: 80 }, (_value, index) => ({
    type: 'circle',
    cx: 200 + (index % 20) * 20,
    cy: 200 + Math.floor(index / 20) * 20,
    r: 4,
    fill: '#ffffff',
    stroke: 'none',
    stroke_width: 1,
  })));

  const normalized = api.normalizeAiDrawingPlan(complexPlan);
  assert(normalized, 'a detailed plan above the old 70-element cap was rejected');
  assertEqual(normalized.elements.length, 81, 'the detailed plan lost drawing elements');
  assertEqual(normalized.elements[0].type, 'path', 'the curved path was dropped');

  const canvas = harness.sandbox.document.createElement('canvas');
  assertEqual(api.renderAiDrawingPlanToCanvas(normalized, canvas), true,
    'the curved drawing plan did not render to Canvas');
  const pathPaint = canvas.__context.operations.find((operation) => (
    (operation.name === 'fill' || operation.name === 'stroke')
      && operation.args[0] && operation.args[0].d
  ));
  assert(pathPaint && pathPaint.args[0].d.includes('C 210 90'),
    'Canvas rendering did not use the declared curved path');

  const svg = api.aiDrawingPlanToSvg(normalized);
  assert(svg.includes('<path') && svg.includes('C 210 90'),
    'the SVG compatibility artifact dropped the curved path');

  complexPlan.elements[0].d = 'M 20 20 L 40 40<script>';
  assertEqual(api.normalizeAiDrawingPlan(complexPlan), null,
    'the browser accepted executable markup inside path data');
}

async function testDrawingReviewCaptureIsLowResolutionOpaqueJpeg() {
  const harness = loadHarness();
  const image = harness.api.captureAiDrawingReviewImage(sampleDrawingPlan());

  assertEqual(image, 'data:image/jpeg;base64,384x288',
    'the visual review image was not the bounded low-resolution JPEG');
  assertEqual(harness.createdCanvases.length, 2,
    'drawing review should need one full-size source and one review canvas');
  const source = harness.createdCanvases[0];
  const review = harness.createdCanvases[1];
  assertEqual(source.width, 800, 'the review source did not render the canonical plan width');
  assertEqual(source.height, 600, 'the review source did not render the canonical plan height');
  assertEqual(review.width, 384, 'the review image was not downsampled to the expected width');
  assertEqual(review.height, 288, 'the review image was not downsampled to the expected height');
  const reviewOperations = review.__context.operations;
  assert(reviewOperations.some((operation) => operation.name === 'fillRect'),
    'the JPEG review canvas was not given an opaque background');
  const drawImage = reviewOperations.find((operation) => operation.name === 'drawImage');
  assert(drawImage && drawImage.args.slice(1).join(',') === '0,0,384,288',
    'the full drawing was not scaled into the bounded review image');
  const encoded = reviewOperations.find((operation) => operation.name === 'toDataURL');
  assertDeepEqual(encoded.args, ['image/jpeg', 0.78],
    'the visual review image used an unexpected encoding or quality');
}

async function runPrepareAiDrawingReview(responseFactory) {
  const harness = loadHarness();
  const api = harness.api;
  const calls = [];
  api.state.routeActive = true;
  api.state.routeEnding = false;
  api.state.phase = 'ai_drawing';
  api.state.roundFlowToken = 9;
  api.state.activeRoundToken = 9;
  api.state.sessionId = 'drawing-review-session';
  api.state.sdkClient = {
    disposed: false,
    runtime: { state: 'running', session: { id: 'drawing-review-session', routeInstanceId: 'review-route' } },
    commands: {
      execute(command, payload, options) {
        calls.push({ command, payload, options });
        return Promise.resolve().then(() => responseFactory(command, payload, options));
      },
    },
  };
  const original = sampleDrawingPlan();
  const prepared = await api.prepareAiDrawing({ plan: original, svg: '<svg>legacy</svg>' }, 9);
  return { harness, api, calls, original, prepared };
}

async function testDrawingPlanReviewUsesSdkAndAppliesOneReturnedPlan() {
  const corrected = sampleDrawingPlan('#f28c8c');
  const result = await runPrepareAiDrawingReview(() => ({
    ok: true,
    data: {
      ok: true,
      handled: true,
      accepted: false,
      corrected: true,
      drawing: { plan: corrected },
    },
  }));

  assertEqual(result.calls.length, 1, 'one drawing produced more than one visual review command');
  assertEqual(result.calls[0].command, 'round:ai-draw-review',
    'drawing review bypassed the declared SDK command');
  assertEqual(result.calls[0].payload.client_round_token, 9,
    'drawing review lost the active round token');
  assertEqual(result.calls[0].payload.image_data_url, 'data:image/jpeg;base64,384x288',
    'drawing review did not send the bounded local Canvas capture');
  assertDeepEqual(Object.keys(result.calls[0].payload).sort(),
    ['client_round_token', 'image_data_url'],
    'drawing review sent model plans or host-owned identity outside its SDK contract');
  assertEqual(result.calls[0].options.timeoutMs, 90000,
    'drawing review did not use its bounded command timeout');
  assertEqual(result.prepared.plan.elements[0].fill, '#f28c8c',
    'the single reviewed correction was not applied');
  assert(result.prepared.svg.includes('#f28c8c'),
    'the correction did not refresh the local summary/export SVG');
}

async function testDrawingPlanReviewUnavailableKeepsOriginalDrawing() {
  const result = await runPrepareAiDrawingReview(() => Promise.reject(
    Object.assign(new Error('vision unavailable'), { code: 'network_error' }),
  ));

  assertEqual(result.calls.length, 1, 'an unavailable reviewer was retried in a local loop');
  assertEqual(result.prepared.plan.elements[0].fill, '#f4cf45',
    'a review failure discarded the original local drawing plan');
  assert(result.prepared.svg.includes('#f4cf45'),
    'a review failure discarded the original summary/export artifact');
}

async function testStopSdkVoiceBestEffortRejectsResolvedFailureAndSyncThrow() {
  for (const voice of [
    { stop() { return Promise.resolve({ ok: false, active: false, reason: 'stop_failed' }); } },
    { stop() { throw new Error('stop_failed'); } },
  ]) {
    const harness = loadHarness();
    const api = harness.api;
    const client = {
      disposed: false,
      runtime: { state: 'running' },
      capabilities: { has(name) { return name === 'voice-input'; } },
      voice,
    };
    api.installVoiceUiSpy([]);
    api.state.sdkClient = client;
    api.state.voiceRouteActive = true;

    assertEqual(await api.stopSdkVoiceBestEffort(client), false,
      'a failed SDK voice stop was reported as successful');
  }
}

async function testSdkLoggerFailuresAreIsolated() {
  const harness = loadHarness();
  const result = harness.api.logSdkBestEffort({
    logger: {
      warn() { throw new Error('logger failed'); },
    },
  }, 'warn', 'runtime', 'route_inactive', 'safe message', { reason: 'inactive' });

  assertEqual(result, false, 'an SDK logger exception escaped the best-effort boundary');
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
  await testPlayerTextCommandsStaySerialized();
  await testQueuedPlayerTextDoesNotCrossPhaseBoundary();
  await testVoiceStateCannotClearAnActiveControlRequest();
  await testBackgroundVoiceQueryCannotClearANewerToggle();
  await testVoiceToggleUsesOfficialSdkControl();
  await testRouteStartQueriesVoiceWithoutTakingOverMicrophone();
  await testBucketFillTreatsCanvasDisplayEdgeAsBoundary();
  await testCanvasDrawingPlanIsBoundedRenderedAndSerializable();
  await testRawAiSvgFillsResponsiveStage();
  await testComplexDrawingPlanSupportsCurvesAndMoreDetail();
  await testDrawingReviewCaptureIsLowResolutionOpaqueJpeg();
  await testDrawingPlanReviewUsesSdkAndAppliesOneReturnedPlan();
  await testDrawingPlanReviewUnavailableKeepsOriginalDrawing();
  await testStopSdkVoiceBestEffortRejectsResolvedFailureAndSyncThrow();
  await testSdkLoggerFailuresAreIsolated();
  await testPageExitPostsVoiceStopBeforeCleanup();
  process.stdout.write('drawing guess SDK preference tests passed\n');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
