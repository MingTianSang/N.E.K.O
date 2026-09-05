const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(predicate, message, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await wait(2);
  }
}

async function flushController(controller) {
  await wait(0);
  await controller.operationChain;
  await wait(0);
  await controller.operationChain;
}

class CustomEventMock {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
    this.persisted = options.persisted;
  }
}

class EventWindow {
  constructor() {
    this.listeners = new Map();
    this.CustomEvent = CustomEventMock;
    this.navigator = { language: 'zh-CN' };
    this.crypto = { getRandomValues(values) { values.fill(17); return values; } };
    this.setTimeout = setTimeout;
    this.clearTimeout = clearTimeout;
    this.setInterval = setInterval;
    this.clearInterval = clearInterval;
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  dispatchEvent(event) {
    for (const handler of [...(this.listeners.get(event.type) || [])]) {
      handler.call(this, event);
    }
    return true;
  }
}

class StorageMock {
  constructor() {
    this.values = new Map();
    this.writes = [];
  }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) {
    this.values.set(String(key), String(value));
    this.writes.push({ key: String(key), value: String(value) });
  }
  removeItem(key) { this.values.delete(String(key)); }
}

class BroadcastChannelMock {
  static instances = [];
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.closed = false;
    this.onmessage = null;
    BroadcastChannelMock.instances.push(this);
  }
  postMessage(message) { this.messages.push(message); }
  emit(message) { this.onmessage?.({ data: message }); }
  close() { this.closed = true; }
}

class RecognitionMock {
  static instances = [];
  constructor() {
    this.startCalls = 0;
    this.stopCalls = 0;
    this.abortCalls = 0;
    RecognitionMock.instances.push(this);
  }
  start() {
    this.startCalls += 1;
    this.onstart?.({ type: 'start' });
  }
  stop() { this.stopCalls += 1; this.onend?.({ type: 'end' }); }
  abort() { this.abortCalls += 1; this.onend?.({ type: 'end' }); }
  emitError(error) { this.onerror?.({ error }); }
  emitEnd() { this.onend?.({ type: 'end' }); }
  emitFinal(text) {
    const result = [{ transcript: text }];
    result.isFinal = true;
    this.onresult?.({ resultIndex: 0, results: [result] });
  }
}

class ManualStartRecognitionMock extends RecognitionMock {
  static instances = [];
  constructor(order = null) {
    super();
    this.order = order;
    ManualStartRecognitionMock.instances.push(this);
  }
  start() {
    this.startCalls += 1;
    this.order?.push('recognition:start');
  }
  emitStart() {
    this.order?.push('recognition:onstart');
    this.onstart?.({ type: 'start' });
  }
}

class ThrowingStartRecognitionMock extends RecognitionMock {
  static instances = [];
  constructor(order = null) {
    super();
    this.order = order;
    ThrowingStartRecognitionMock.instances.push(this);
  }
  start() {
    this.startCalls += 1;
    this.order?.push('recognition:start');
    throw new Error('recognition start failed');
  }
}

function request(id, action, generation = 'route-A') {
  return {
    type: 'game_voice_control_request',
    message_id: `message-${id}`,
    storage_nonce: `message-${id}`,
    sender_id: 'drawing-game-host',
    request_id: id,
    action,
    game_type: 'drawing_guess',
    session_id: 'drawing-session',
    sdk_route_instance_id: generation,
  };
}

function activeRoute(generation = 'route-A') {
  return {
    ok: true,
    active: true,
    game_type: 'drawing_guess',
    session_id: 'drawing-session',
    sdk_route_instance_id: generation,
  };
}

async function main() {
  const sourcePath = path.resolve(
    __dirname,
    '../../static/app/app-minigame-voice-controller.js',
  );
  const source = fs.readFileSync(sourcePath, 'utf8');
  const sandbox = new EventWindow();
  sandbox.window = sandbox;
  sandbox.__NEKO_MINIGAME_VOICE_CONTROLLER_DISABLE_AUTO_INIT__ = true;
  sandbox.console = { log() {}, warn() {}, error() {} };
  vm.runInNewContext(source, sandbox, { filename: sourcePath, timeout: 5000 });

  assert(sandbox.NekoMiniGameVoiceController.instance === null,
    'test hook did not suppress automatic controller ownership');
  assert(sandbox.NekoMiniGameVoiceController.channelName === 'neko_game_voice_control_channel',
    'controller used a channel different from the SDK host');

  const storage = new StorageMock();
  const delivered = [];
  sandbox.addEventListener('neko-game-voice-control-message', (event) => {
    if (event.detail?.type !== 'game_voice_control_request') delivered.push(event.detail);
  });
  let route = activeRoute('route-A');
  let failRouteRead = false;
  let routeReadGate = null;
  const fetchCalls = [];
  const fetchImpl = async (url, options) => {
    fetchCalls.push({ url, options });
    if (failRouteRead) throw new Error('temporary route read failure');
    if (routeReadGate) {
      const gate = routeReadGate;
      routeReadGate = null;
      await gate;
    }
    return { ok: true, async json() { return { ...route }; } };
  };
  let suspendCalls = 0;
  let restoreCalls = 0;
  const controller = sandbox.NekoMiniGameVoiceController.create({
    windowImpl: sandbox,
    fetchImpl,
    storageImpl: storage,
    BroadcastChannelImpl: BroadcastChannelMock,
    RecognitionImpl: RecognitionMock,
    watchdogIntervalMs: 1000,
    restartDelayMs: 0,
    suspendOrdinaryMic: async () => { suspendCalls += 1; },
    restoreOrdinaryMic: async () => { restoreCalls += 1; },
  }).start();
  const channel = BroadcastChannelMock.instances.at(-1);
  assert(channel.name === 'neko_game_voice_control_channel',
    'controller opened the wrong BroadcastChannel');

  const startA = request('start-A', 'start', 'route-A');
  channel.emit(startA);
  sandbox.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', { detail: startA }));
  await controller.operationChain;
  assert(fetchCalls.length === 1
    && fetchCalls[0].url === '/api/game/route/active?game_type=drawing_guess'
      + '&session_id=drawing-session&sdk_route_instance_id=route-A',
    'duplicate transports did not collapse to one authoritative route validation');
  assert(fetchCalls[0].options.cache === 'no-store',
    'route ownership validation was allowed to use a cached response');
  assert(RecognitionMock.instances.length === 1
    && RecognitionMock.instances[0].startCalls === 1
    && suspendCalls === 1,
  'validated start did not suspend the ordinary mic and start recognition once');
  assert(delivered.some((message) => message.type === 'game_voice_control_state'
    && message.request_id === 'start-A'
    && message.ok === true
    && message.active === true),
  'start request did not receive an active state response');

  failRouteRead = true;
  sandbox.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('query-read-failed', 'query', 'route-A'),
  }));
  await controller.operationChain;
  failRouteRead = false;
  const failedQueryState = delivered.find((message) => message.type === 'game_voice_control_state'
    && message.request_id === 'query-read-failed');
  assert(failedQueryState?.ok === false
    && failedQueryState.active === true
    && failedQueryState.route_active === true
    && controller.getState().active === true,
  'a transient route read failure made the UI claim the live microphone stopped');

  let releaseFirstTranscriptValidation;
  routeReadGate = new Promise((resolve) => { releaseFirstTranscriptValidation = resolve; });
  const fetchCountBeforeTranscripts = fetchCalls.length;
  RecognitionMock.instances[0].emitFinal('first final words');
  RecognitionMock.instances[0].emitFinal('second final words');
  await wait(5);
  assert(fetchCalls.length === fetchCountBeforeTranscripts + 1,
    'same-slot final transcripts did not serialize their route validation');
  releaseFirstTranscriptValidation();
  await controller.current.transcriptChain;
  const transcripts = delivered.filter((message) => message.type === 'game_voice_transcript');
  assert(transcripts.slice(-2).map((message) => message.text).join('|')
      === 'first final words|second final words'
    && transcripts.at(-1).game_type === 'drawing_guess'
    && transcripts.at(-1).session_id === 'drawing-session'
    && transcripts.at(-1).sdk_route_instance_id === 'route-A',
  'final transcripts were reordered or lost their validated route identity');

  const queryA = request('query-A', 'query', 'route-A');
  sandbox.dispatchEvent({
    type: 'storage',
    key: 'neko_game_voice_control_message',
    newValue: JSON.stringify(queryA),
  });
  await controller.operationChain;
  assert(delivered.some((message) => message.type === 'game_voice_control_state'
    && message.request_id === 'query-A'
    && message.active === true),
  'storage fallback query did not report the current active owner');

  sandbox.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('toggle-A', 'toggle', 'route-A'),
  }));
  await controller.operationChain;
  assert(RecognitionMock.instances[0].stopCalls === 1
    && restoreCalls === 1
    && controller.getState().active === false,
  'toggle-off did not stop recognition and restore the ordinary mic');

  sandbox.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('restart-A', 'start', 'route-A'),
  }));
  await controller.operationChain;
  const recognitionA2 = RecognitionMock.instances.at(-1);
  assert(controller.getState().identity.routeInstanceId === 'route-A',
    'route A did not regain ownership');

  route = activeRoute('route-B');
  sandbox.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('start-B', 'start', 'route-B'),
  }));
  await controller.operationChain;
  const recognitionB = RecognitionMock.instances.at(-1);
  assert(recognitionB !== recognitionA2
    && recognitionA2.abortCalls === 1
    && controller.getState().identity.routeInstanceId === 'route-B',
  'new route generation did not replace the old recognition owner');

  sandbox.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('stale-stop-A', 'stop', 'route-A'),
  }));
  await controller.operationChain;
  assert(controller.getState().active === true
    && controller.getState().identity.routeInstanceId === 'route-B'
    && recognitionB.stopCalls === 0
    && recognitionB.abortCalls === 0,
  'an old-generation stop request closed the new route owner');
  assert(delivered.some((message) => message.type === 'game_voice_control_error'
    && message.request_id === 'stale-stop-A'
    && message.code === 'route_identity_mismatch'),
  'stale generation did not receive a bounded controller error');
  assert(delivered.some((message) => message.type === 'game_voice_control_state'
    && message.request_id === 'stale-stop-A'
    && message.route_active === false),
  'stale generation response incorrectly claimed that its route was active');

  // Heartbeat loss / abnormal game-window exit may leave no final stop
  // request. The watchdog must discover that the owner triple is gone.
  controller.watchdogIntervalMs = 50;
  controller._startWatchdog();
  route = { ok: true, active: false };
  await wait(90);
  assert(controller.getState().active === false
    && recognitionB.abortCalls === 1
    && restoreCalls === 2,
  'watchdog did not release recognition after authoritative route loss');
  assert(delivered.some((message) => message.type === 'game_voice_control_state'
    && message.sdk_route_instance_id === 'route-B'
    && message.reason === 'route_inactive'
    && message.active === false
    && message.route_active === false),
  'watchdog route loss was not published to the SDK host');

  await controller.dispose();
  assert(channel.closed, 'controller disposal did not close its coordination channel');

  // Query exposes the two pieces of host state needed by a game to decide
  // whether it should offer an automatic ordinary-voice handoff. A handoff
  // request is intentionally a no-op when there is no ordinary voice session.
  const handoffQueryWindow = new EventWindow();
  handoffQueryWindow.window = handoffQueryWindow;
  handoffQueryWindow.micMuted = true;
  handoffQueryWindow.isMicMuted = () => handoffQueryWindow.micMuted;
  let handoffQueryOrdinaryActive = true;
  let handoffQuerySuspendCalls = 0;
  let handoffQueryEndCalls = 0;
  const handoffQueryDelivered = [];
  handoffQueryWindow.addEventListener('neko-game-voice-control-message', (event) => {
    if (event.detail?.type !== 'game_voice_control_request') {
      handoffQueryDelivered.push(event.detail);
    }
  });
  const handoffQueryController = sandbox.NekoMiniGameVoiceController.create({
    windowImpl: handoffQueryWindow,
    fetchImpl: async () => ({
      ok: true,
      async json() { return activeRoute('route-handoff-query'); },
    }),
    storageImpl: new StorageMock(),
    BroadcastChannelImpl: null,
    RecognitionImpl: RecognitionMock,
    watchdogIntervalMs: 10000,
    isOrdinaryVoiceActive: () => handoffQueryOrdinaryActive,
    endOrdinaryVoiceSession: async () => { handoffQueryEndCalls += 1; },
    suspendOrdinaryMic: async () => { handoffQuerySuspendCalls += 1; },
    restoreOrdinaryMic: async () => {},
  }).start();
  handoffQueryWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('handoff-query', 'query', 'route-handoff-query'),
  }));
  await handoffQueryController.operationChain;
  const handoffQueryState = handoffQueryDelivered.find((message) => (
    message.type === 'game_voice_control_state' && message.request_id === 'handoff-query'
  ));
  assert(handoffQueryState?.ordinary_voice_active === true
    && handoffQueryState.microphone_muted === true,
  'query state omitted ordinary voice or global microphone state');

  handoffQueryWindow.micMuted = false;
  handoffQueryOrdinaryActive = false;
  const recognitionCountBeforeInactiveHandoff = RecognitionMock.instances.length;
  handoffQueryWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('handoff-inactive', 'handoff', 'route-handoff-query'),
  }));
  await handoffQueryController.operationChain;
  const inactiveHandoffState = handoffQueryDelivered.find((message) => (
    message.type === 'game_voice_control_state' && message.request_id === 'handoff-inactive'
  ));
  assert(inactiveHandoffState?.ok === true
    && inactiveHandoffState.active === false
    && inactiveHandoffState.reason === 'ordinary_voice_inactive'
    && RecognitionMock.instances.length === recognitionCountBeforeInactiveHandoff
    && handoffQuerySuspendCalls === 0
    && handoffQueryEndCalls === 0,
  'inactive ordinary voice handoff created a recognizer or reported a failure');
  await handoffQueryController.dispose();

  // A live handoff must not destroy the ordinary session until browser speech
  // recognition has demonstrably acquired capture. This makes a failed or
  // blocked recognition start recoverable without losing the current chat.
  const handoffOrder = [];
  const sequencedRecognitionInstances = [];
  class SequencedRecognition extends ManualStartRecognitionMock {
    constructor() {
      super(handoffOrder);
      sequencedRecognitionInstances.push(this);
    }
  }
  const sequencedWindow = new EventWindow();
  sequencedWindow.window = sequencedWindow;
  let sequencedOrdinaryActive = true;
  let sequencedRestoreCalls = 0;
  let sequencedFenceReleaseCalls = 0;
  let releaseSequencedOrdinaryEnd = null;
  const sequencedOrdinaryEndGate = new Promise((resolve) => {
    releaseSequencedOrdinaryEnd = resolve;
  });
  const sequencedDelivered = [];
  sequencedWindow.addEventListener('neko-game-voice-control-message', (event) => {
    if (event.detail?.type !== 'game_voice_control_request') sequencedDelivered.push(event.detail);
  });
  const sequencedController = sandbox.NekoMiniGameVoiceController.create({
    windowImpl: sequencedWindow,
    fetchImpl: async () => ({
      ok: true,
      async json() { return activeRoute('route-handoff-sequenced'); },
    }),
    storageImpl: new StorageMock(),
    BroadcastChannelImpl: null,
    RecognitionImpl: SequencedRecognition,
    watchdogIntervalMs: 10000,
    recognitionStartTimeoutMs: 1000,
    isOrdinaryVoiceActive: () => sequencedOrdinaryActive,
    suspendOrdinaryMic: async () => { handoffOrder.push('ordinary:suspend'); },
    restoreOrdinaryMic: async () => {
      sequencedRestoreCalls += 1;
      handoffOrder.push('ordinary:restore');
    },
    completeOrdinaryMicHandoff: async () => { sequencedFenceReleaseCalls += 1; },
    endOrdinaryVoiceSession: async () => {
      handoffOrder.push('ordinary:end');
      await sequencedOrdinaryEndGate;
      sequencedOrdinaryActive = false;
      return { ok: true, ended: true };
    },
  }).start();
  sequencedWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('handoff-sequenced', 'handoff', 'route-handoff-sequenced'),
  }));
  await wait(5);
  assert(sequencedRecognitionInstances.length === 1
    && handoffOrder.join('|') === 'ordinary:suspend|recognition:start',
  'handoff ended ordinary voice before recognition confirmed capture');
  sequencedRecognitionInstances[0].emitStart();
  await wait(5);
  sequencedRecognitionInstances[0].emitFinal('must not cross pending handoff');
  await wait(5);
  assert(sequencedController.getState().active === false
    && !sequencedDelivered.some((message) => message.type === 'game_voice_transcript')
    && !sequencedDelivered.some((message) => message.type === 'game_voice_control_state'
      && message.request_id === 'handoff-sequenced'
      && message.active === true),
  'pending handoff exposed active voice or submitted a transcript before ordinary voice ended');
  releaseSequencedOrdinaryEnd();
  await sequencedController.operationChain;
  assert(handoffOrder.join('|')
      === 'ordinary:suspend|recognition:start|recognition:onstart|ordinary:end'
    && sequencedController.getState().active === true
    && sequencedController.getState().listening === true
    && sequencedFenceReleaseCalls === 0
    && sequencedDelivered.some((message) => message.type === 'game_voice_control_state'
      && message.request_id === 'handoff-sequenced'
      && message.ok === true
      && message.active === true),
  `handoff did not serialize suspend, recognition acquisition, and ordinary-session end: ${handoffOrder.join('|')}`);

  sequencedWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('handoff-stop', 'stop', 'route-handoff-sequenced'),
  }));
  await sequencedController.operationChain;
  assert(sequencedController.getState().active === false
    && sequencedRestoreCalls === 0
    && sequencedFenceReleaseCalls === 1,
  'stopping handed-off game voice did not release capture without reopening the ended session');
  await sequencedController.dispose();

  // Route loss after a successful handoff has the same ownership semantics as
  // an explicit stop: ordinary voice was ended, so cleanup must not restore it.
  const routeLossWindow = new EventWindow();
  routeLossWindow.window = routeLossWindow;
  let handoffRouteLive = true;
  let routeLossOrdinaryActive = true;
  let routeLossRestoreCalls = 0;
  const routeLossController = sandbox.NekoMiniGameVoiceController.create({
    windowImpl: routeLossWindow,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return handoffRouteLive
          ? activeRoute('route-handoff-loss')
          : { ok: true, active: false };
      },
    }),
    storageImpl: new StorageMock(),
    BroadcastChannelImpl: null,
    RecognitionImpl: RecognitionMock,
    watchdogIntervalMs: 10000,
    recognitionStartTimeoutMs: 100,
    isOrdinaryVoiceActive: () => routeLossOrdinaryActive,
    suspendOrdinaryMic: async () => {},
    restoreOrdinaryMic: async () => { routeLossRestoreCalls += 1; },
    endOrdinaryVoiceSession: async () => {
      routeLossOrdinaryActive = false;
      return { ok: true, ended: true };
    },
  }).start();
  routeLossWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('handoff-loss-start', 'handoff', 'route-handoff-loss'),
  }));
  await routeLossController.operationChain;
  handoffRouteLive = false;
  await routeLossController._watchdogTick();
  await flushController(routeLossController);
  assert(routeLossController.getState().active === false
    && routeLossRestoreCalls === 0,
  'route loss reopened ordinary voice after a completed handoff');
  await routeLossController.dispose();

  // If recognition never reports onstart, the handoff times out, restores the
  // still-live ordinary microphone, and never sends end_session.
  const failedHandoffOrder = [];
  class NeverStartingRecognition extends ManualStartRecognitionMock {
    constructor() { super(failedHandoffOrder); }
  }
  const failedHandoffWindow = new EventWindow();
  failedHandoffWindow.window = failedHandoffWindow;
  let failedHandoffEndCalls = 0;
  const failedHandoffDelivered = [];
  failedHandoffWindow.addEventListener('neko-game-voice-control-message', (event) => {
    if (event.detail?.type !== 'game_voice_control_request') failedHandoffDelivered.push(event.detail);
  });
  const failedHandoffController = sandbox.NekoMiniGameVoiceController.create({
    windowImpl: failedHandoffWindow,
    fetchImpl: async () => ({
      ok: true,
      async json() { return activeRoute('route-handoff-failed'); },
    }),
    storageImpl: new StorageMock(),
    BroadcastChannelImpl: null,
    RecognitionImpl: NeverStartingRecognition,
    watchdogIntervalMs: 10000,
    recognitionStartTimeoutMs: 25,
    isOrdinaryVoiceActive: () => true,
    suspendOrdinaryMic: async () => { failedHandoffOrder.push('ordinary:suspend'); },
    restoreOrdinaryMic: async () => { failedHandoffOrder.push('ordinary:restore'); },
    endOrdinaryVoiceSession: async () => { failedHandoffEndCalls += 1; },
  }).start();
  failedHandoffWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('handoff-failed', 'handoff', 'route-handoff-failed'),
  }));
  await failedHandoffController.operationChain;
  const failedHandoffState = failedHandoffDelivered.find((message) => (
    message.type === 'game_voice_control_state' && message.request_id === 'handoff-failed'
  ));
  assert(failedHandoffOrder.join('|')
      === 'ordinary:suspend|recognition:start|ordinary:restore'
    && failedHandoffEndCalls === 0
    && failedHandoffController.getState().active === false
    && failedHandoffState?.ok === false,
  `failed recognition acquisition ended ordinary voice or failed to restore capture: ${failedHandoffOrder.join('|')}`);
  await failedHandoffController.dispose();

  // A stop accepted while the initial handoff route read is pending must
  // invalidate that queued start before it can suspend either microphone.
  let releasePendingRouteValidation;
  const pendingRouteValidationGate = new Promise((resolve) => {
    releasePendingRouteValidation = resolve;
  });
  let pendingRouteFetchCalls = 0;
  let pendingRouteSuspendCalls = 0;
  let pendingRouteEndCalls = 0;
  const pendingRouteWindow = new EventWindow();
  pendingRouteWindow.window = pendingRouteWindow;
  const recognitionCountBeforePendingRoute = RecognitionMock.instances.length;
  const pendingRouteController = sandbox.NekoMiniGameVoiceController.create({
    windowImpl: pendingRouteWindow,
    fetchImpl: async () => {
      pendingRouteFetchCalls += 1;
      if (pendingRouteFetchCalls === 1) await pendingRouteValidationGate;
      return {
        ok: true,
        async json() { return activeRoute('route-handoff-stop-validation'); },
      };
    },
    storageImpl: new StorageMock(),
    BroadcastChannelImpl: null,
    RecognitionImpl: RecognitionMock,
    watchdogIntervalMs: 10000,
    isOrdinaryVoiceActive: () => true,
    suspendOrdinaryMic: async () => { pendingRouteSuspendCalls += 1; },
    restoreOrdinaryMic: async () => {},
    endOrdinaryVoiceSession: async () => { pendingRouteEndCalls += 1; },
  }).start();
  pendingRouteWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request(
      'handoff-stop-validation-start',
      'handoff',
      'route-handoff-stop-validation',
    ),
  }));
  await waitForCondition(
    () => pendingRouteFetchCalls === 1,
    'handoff did not enter its initial route validation',
  );
  pendingRouteWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request(
      'handoff-stop-validation-stop',
      'stop',
      'route-handoff-stop-validation',
    ),
  }));
  releasePendingRouteValidation();
  await pendingRouteController.operationChain;
  assert(pendingRouteController.getState().active === false
    && pendingRouteSuspendCalls === 0
    && pendingRouteEndCalls === 0
    && RecognitionMock.instances.length === recognitionCountBeforePendingRoute,
  'stop during handoff route validation allowed the stale handoff to start');
  await pendingRouteController.dispose();

  // Once a pending slot exists, stop must synchronously settle the onstart
  // wait instead of leaving the serialized stop request behind a 4s timeout.
  const stopWaitingRecognitionInstances = [];
  class StopWaitingRecognition extends ManualStartRecognitionMock {
    constructor() {
      super();
      stopWaitingRecognitionInstances.push(this);
    }
  }
  const stopWaitingWindow = new EventWindow();
  stopWaitingWindow.window = stopWaitingWindow;
  let stopWaitingEndCalls = 0;
  let stopWaitingRestoreCalls = 0;
  const stopWaitingController = sandbox.NekoMiniGameVoiceController.create({
    windowImpl: stopWaitingWindow,
    fetchImpl: async () => ({
      ok: true,
      async json() { return activeRoute('route-handoff-stop-onstart'); },
    }),
    storageImpl: new StorageMock(),
    BroadcastChannelImpl: null,
    RecognitionImpl: StopWaitingRecognition,
    watchdogIntervalMs: 10000,
    recognitionStartTimeoutMs: 4000,
    isOrdinaryVoiceActive: () => true,
    suspendOrdinaryMic: async () => {},
    restoreOrdinaryMic: async () => { stopWaitingRestoreCalls += 1; },
    endOrdinaryVoiceSession: async () => { stopWaitingEndCalls += 1; },
  }).start();
  stopWaitingWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('handoff-stop-onstart-start', 'handoff', 'route-handoff-stop-onstart'),
  }));
  await waitForCondition(
    () => stopWaitingRecognitionInstances.length === 1,
    'handoff did not begin waiting for recognition onstart',
  );
  const stopWaitingStartedAt = Date.now();
  stopWaitingWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('handoff-stop-onstart-stop', 'stop', 'route-handoff-stop-onstart'),
  }));
  await stopWaitingController.operationChain;
  const stopWaitingElapsedMs = Date.now() - stopWaitingStartedAt;
  assert(stopWaitingElapsedMs < 750
    && stopWaitingController.getState().active === false
    && stopWaitingRecognitionInstances[0].abortCalls === 1
    && stopWaitingEndCalls === 0
    && stopWaitingRestoreCalls === 1,
  `stop waited for the handoff recognition timeout or ended ordinary voice (${stopWaitingElapsedMs}ms)`);
  await stopWaitingController.dispose();

  // TTS taking the microphone while handoff recognition is still pending is
  // another cancellation, not a half-duplex pause: ordinary voice is still
  // live and must be restored immediately without waiting four seconds.
  const ttsPendingRecognitionInstances = [];
  class TtsPendingRecognition extends ManualStartRecognitionMock {
    constructor() {
      super();
      ttsPendingRecognitionInstances.push(this);
    }
  }
  const ttsPendingWindow = new EventWindow();
  ttsPendingWindow.window = ttsPendingWindow;
  let ttsPendingEndCalls = 0;
  let ttsPendingRestoreCalls = 0;
  const ttsPendingController = sandbox.NekoMiniGameVoiceController.create({
    windowImpl: ttsPendingWindow,
    fetchImpl: async () => ({
      ok: true,
      async json() { return activeRoute('route-handoff-tts-pending'); },
    }),
    storageImpl: new StorageMock(),
    BroadcastChannelImpl: null,
    RecognitionImpl: TtsPendingRecognition,
    watchdogIntervalMs: 10000,
    recognitionStartTimeoutMs: 4000,
    isOrdinaryVoiceActive: () => true,
    suspendOrdinaryMic: async () => {},
    restoreOrdinaryMic: async () => { ttsPendingRestoreCalls += 1; },
    endOrdinaryVoiceSession: async () => { ttsPendingEndCalls += 1; },
  }).start();
  ttsPendingWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('handoff-tts-pending', 'handoff', 'route-handoff-tts-pending'),
  }));
  await waitForCondition(
    () => ttsPendingRecognitionInstances.length === 1,
    'TTS regression did not reach the recognition onstart wait',
  );
  const ttsPendingStartedAt = Date.now();
  ttsPendingWindow.dispatchEvent(new CustomEventMock('neko-speech-playback-state', {
    detail: { type: 'speech_playback_state', active: true },
  }));
  await ttsPendingController.operationChain;
  const ttsPendingElapsedMs = Date.now() - ttsPendingStartedAt;
  assert(ttsPendingElapsedMs < 750
    && ttsPendingController.getState().active === false
    && ttsPendingRecognitionInstances[0].abortCalls === 1
    && ttsPendingEndCalls === 0
    && ttsPendingRestoreCalls === 1,
  `TTS did not promptly roll back a pending handoff (${ttsPendingElapsedMs}ms)`);
  await ttsPendingController.dispose();

  // A failed response may still mean end_session was committed and only its
  // acknowledgement was lost. In that case restoring ordinary capture would
  // resurrect a session that the backend has already ended.
  const committedFailureWindow = new EventWindow();
  committedFailureWindow.window = committedFailureWindow;
  let committedFailureRestoreCalls = 0;
  let committedFailureCompleteCalls = 0;
  let committedFailureEndCalls = 0;
  const committedFailureDelivered = [];
  committedFailureWindow.addEventListener('neko-game-voice-control-message', (event) => {
    if (event.detail?.type !== 'game_voice_control_request') {
      committedFailureDelivered.push(event.detail);
    }
  });
  const committedFailureController = sandbox.NekoMiniGameVoiceController.create({
    windowImpl: committedFailureWindow,
    fetchImpl: async () => ({
      ok: true,
      async json() { return activeRoute('route-handoff-committed-failure'); },
    }),
    storageImpl: new StorageMock(),
    BroadcastChannelImpl: null,
    RecognitionImpl: RecognitionMock,
    watchdogIntervalMs: 10000,
    recognitionStartTimeoutMs: 100,
    isOrdinaryVoiceActive: () => true,
    suspendOrdinaryMic: async () => {},
    restoreOrdinaryMic: async () => { committedFailureRestoreCalls += 1; },
    completeOrdinaryMicHandoff: async () => { committedFailureCompleteCalls += 1; },
    endOrdinaryVoiceSession: async () => {
      committedFailureEndCalls += 1;
      return {
        ok: false,
        committed: true,
        ended: true,
        reason: 'ordinary_voice_end_unconfirmed',
      };
    },
  }).start();
  committedFailureWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request(
      'handoff-committed-failure',
      'handoff',
      'route-handoff-committed-failure',
    ),
  }));
  await committedFailureController.operationChain;
  const committedFailureRecognition = RecognitionMock.instances.at(-1);
  const committedFailureState = committedFailureDelivered.find((message) => (
    message.type === 'game_voice_control_state'
      && message.request_id === 'handoff-committed-failure'
  ));
  assert(committedFailureEndCalls === 1
    && committedFailureRestoreCalls === 0
    && committedFailureCompleteCalls === 1
    && committedFailureRecognition.abortCalls === 1
    && committedFailureController.getState().active === false
    && committedFailureController.ordinaryMicSuspended === false
    && committedFailureState?.ok === false
    && committedFailureState.reason === 'ordinary_voice_end_unconfirmed',
  'committed ordinary-end failure restored capture or leaked the game voice fence');
  await committedFailureController.dispose();

  // If interruption wins while end_session is in flight, a later committed
  // success still owns the teardown. Release the direct-capture fence without
  // restoring the ended ordinary session, for both stop and TTS interruption.
  for (const interruption of ['sdk-stop', 'tts']) {
    const interruptedWindow = new EventWindow();
    interruptedWindow.window = interruptedWindow;
    let resolveInterruptedEnd;
    const interruptedEndGate = new Promise((resolve) => {
      resolveInterruptedEnd = resolve;
    });
    let interruptedEndCalls = 0;
    let interruptedRestoreCalls = 0;
    let interruptedCompleteCalls = 0;
    const routeId = `route-handoff-end-interrupted-${interruption}`;
    const interruptedController = sandbox.NekoMiniGameVoiceController.create({
      windowImpl: interruptedWindow,
      fetchImpl: async () => ({
        ok: true,
        async json() { return activeRoute(routeId); },
      }),
      storageImpl: new StorageMock(),
      BroadcastChannelImpl: null,
      RecognitionImpl: RecognitionMock,
      watchdogIntervalMs: 10000,
      recognitionStartTimeoutMs: 100,
      isOrdinaryVoiceActive: () => true,
      suspendOrdinaryMic: async () => {},
      restoreOrdinaryMic: async () => { interruptedRestoreCalls += 1; },
      completeOrdinaryMicHandoff: async () => { interruptedCompleteCalls += 1; },
      endOrdinaryVoiceSession: async () => {
        interruptedEndCalls += 1;
        return interruptedEndGate;
      },
    }).start();
    interruptedWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
      detail: request(`handoff-end-interrupted-${interruption}`, 'handoff', routeId),
    }));
    await waitForCondition(
      () => interruptedEndCalls === 1,
      `${interruption} regression did not reach ordinary end`,
    );
    const interruptedRecognition = RecognitionMock.instances.at(-1);
    if (interruption === 'sdk-stop') {
      interruptedWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
        detail: request(`handoff-end-interrupted-stop-${interruption}`, 'stop', routeId),
      }));
    } else {
      interruptedWindow.dispatchEvent(new CustomEventMock('neko-speech-playback-state', {
        detail: { type: 'speech_playback_state', active: true },
      }));
    }
    assert(interruptedController.getState().active === false
      && interruptedRecognition.abortCalls === 1,
    `${interruption} did not fence game voice while ordinary end was pending`);
    resolveInterruptedEnd({ ok: true, committed: true, ended: true });
    await interruptedController.operationChain;
    assert(interruptedController.getState().active === false
      && interruptedEndCalls === 1
      && interruptedRestoreCalls === 0
      && interruptedCompleteCalls === 1
      && interruptedController.ordinaryMicSuspended === false,
    `${interruption} restored ordinary capture or leaked its committed handoff fence`);
    await interruptedController.dispose();
  }

  // Starting ordinary voice explicitly wins microphone ownership. Both the
  // public API and the session-started event must fence game recognition
  // without trying to restore the ordinary pipeline they are yielding to.
  const preemptWindow = new EventWindow();
  preemptWindow.window = preemptWindow;
  let preemptRestoreCalls = 0;
  const preemptController = sandbox.NekoMiniGameVoiceController.create({
    windowImpl: preemptWindow,
    fetchImpl: async () => ({
      ok: true,
      async json() { return activeRoute('route-preempt'); },
    }),
    storageImpl: new StorageMock(),
    BroadcastChannelImpl: null,
    RecognitionImpl: RecognitionMock,
    watchdogIntervalMs: 10000,
    isOrdinaryVoiceActive: () => false,
    suspendOrdinaryMic: async () => {},
    restoreOrdinaryMic: async () => { preemptRestoreCalls += 1; },
  }).start();
  preemptWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('preempt-start-one', 'start', 'route-preempt'),
  }));
  await preemptController.operationChain;
  const publicStopRecognition = RecognitionMock.instances.at(-1);
  assert(typeof preemptController.stopMiniGameVoiceForOrdinaryVoiceSession === 'function',
    'controller did not expose ordinary-voice microphone preemption');
  await preemptController.stopMiniGameVoiceForOrdinaryVoiceSession();
  await flushController(preemptController);
  assert(preemptController.getState().active === false
    && publicStopRecognition.abortCalls === 1
    && preemptRestoreCalls === 0,
  'public ordinary-voice preemption did not fence game capture cleanly');

  preemptWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('preempt-start-two', 'start', 'route-preempt'),
  }));
  await preemptController.operationChain;
  const eventStopRecognition = RecognitionMock.instances.at(-1);
  preemptWindow.dispatchEvent(new CustomEventMock('neko:voice-session-started', {
    detail: { mode: 'audio' },
  }));
  assert(preemptController.getState().active === false
    && eventStopRecognition.abortCalls === 1,
  'ordinary voice session start did not synchronously fence game recognition');
  await flushController(preemptController);
  assert(preemptRestoreCalls === 0,
    'ordinary voice session start raced with a game-triggered ordinary mic restore');
  await preemptController.dispose();

  // A main-mic click can arrive while the game request is still validating,
  // before there is a current slot to fence synchronously. The request's
  // frozen ordinary-voice epoch must reject it before any capture side effect.
  const pendingPreemptWindow = new EventWindow();
  pendingPreemptWindow.window = pendingPreemptWindow;
  let releasePendingPreemptRoute = null;
  const pendingPreemptRoute = new Promise((resolve) => {
    releasePendingPreemptRoute = resolve;
  });
  let pendingPreemptFetchCalls = 0;
  let pendingPreemptOrdinaryActive = false;
  let pendingPreemptSuspendCalls = 0;
  let pendingPreemptEndCalls = 0;
  const recognitionCountBeforePendingPreempt = RecognitionMock.instances.length;
  const pendingPreemptController = sandbox.NekoMiniGameVoiceController.create({
    windowImpl: pendingPreemptWindow,
    fetchImpl: async () => {
      pendingPreemptFetchCalls += 1;
      await pendingPreemptRoute;
      return {
        ok: true,
        async json() { return activeRoute('route-pending-preempt'); },
      };
    },
    storageImpl: new StorageMock(),
    BroadcastChannelImpl: null,
    RecognitionImpl: RecognitionMock,
    watchdogIntervalMs: 10000,
    isOrdinaryVoiceActive: () => pendingPreemptOrdinaryActive,
    suspendOrdinaryMic: async () => { pendingPreemptSuspendCalls += 1; },
    restoreOrdinaryMic: async () => {
      throw new Error('ordinary preemption must not restore old capture');
    },
    endOrdinaryVoiceSession: async () => { pendingPreemptEndCalls += 1; },
  }).start();
  pendingPreemptWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('pending-preempt-start', 'start', 'route-pending-preempt'),
  }));
  await waitForCondition(
    () => pendingPreemptFetchCalls === 1,
    'pending preemption request did not enter route validation',
  );
  pendingPreemptOrdinaryActive = true;
  const pendingPreemption = pendingPreemptController.stopMiniGameVoiceForOrdinaryVoiceSession();
  releasePendingPreemptRoute();
  await pendingPreemption;
  await flushController(pendingPreemptController);
  assert(pendingPreemptController.getState().active === false
    && RecognitionMock.instances.length === recognitionCountBeforePendingPreempt
    && pendingPreemptSuspendCalls === 0
    && pendingPreemptEndCalls === 0,
  'stale game request performed capture side effects after ordinary-voice preemption');
  await pendingPreemptController.dispose();

  // Ordinary voice can also reclaim capture while the post-onstart route
  // validation is pending. Report that as an intentional handoff cancellation,
  // rather than leaking a misleading route-identity error back to the game.
  const latePreemptWindow = new EventWindow();
  latePreemptWindow.window = latePreemptWindow;
  let latePreemptFetchCalls = 0;
  let releaseLatePreemptRoute = null;
  const latePreemptRoute = new Promise((resolve) => {
    releaseLatePreemptRoute = resolve;
  });
  let latePreemptEndCalls = 0;
  const latePreemptDelivered = [];
  const latePreemptRecognitions = [];
  class LatePreemptRecognition extends ManualStartRecognitionMock {
    constructor() {
      super();
      latePreemptRecognitions.push(this);
    }
  }
  latePreemptWindow.addEventListener('neko-game-voice-control-message', (event) => {
    if (event.detail?.type !== 'game_voice_control_request') {
      latePreemptDelivered.push(event.detail);
    }
  });
  const latePreemptController = sandbox.NekoMiniGameVoiceController.create({
    windowImpl: latePreemptWindow,
    fetchImpl: async () => {
      latePreemptFetchCalls += 1;
      if (latePreemptFetchCalls === 2) await latePreemptRoute;
      return {
        ok: true,
        async json() { return activeRoute('route-late-preempt'); },
      };
    },
    storageImpl: new StorageMock(),
    BroadcastChannelImpl: null,
    RecognitionImpl: LatePreemptRecognition,
    watchdogIntervalMs: 10000,
    recognitionStartTimeoutMs: 1000,
    isOrdinaryVoiceActive: () => true,
    suspendOrdinaryMic: async () => {},
    restoreOrdinaryMic: async () => {},
    completeOrdinaryMicHandoff: async () => {},
    endOrdinaryVoiceSession: async () => { latePreemptEndCalls += 1; },
  }).start();
  latePreemptWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('late-preempt-handoff', 'handoff', 'route-late-preempt'),
  }));
  await waitForCondition(
    () => latePreemptRecognitions.length === 1,
    'late preemption handoff did not start recognition',
  );
  latePreemptRecognitions[0].emitStart();
  await waitForCondition(
    () => latePreemptFetchCalls === 2,
    'late preemption handoff did not enter its second route validation',
  );
  const latePreemption = latePreemptController.stopMiniGameVoiceForOrdinaryVoiceSession();
  releaseLatePreemptRoute();
  await latePreemption;
  await flushController(latePreemptController);
  const latePreemptFailure = latePreemptDelivered.find((message) => (
    message.type === 'game_voice_control_state'
      && message.request_id === 'late-preempt-handoff'
  ));
  assert(latePreemptFailure?.ok === false
      && latePreemptFailure.reason === 'ordinary_voice_handoff_cancelled'
      && latePreemptEndCalls === 0,
  'ordinary voice preemption during the second validation was misreported or ended the new session');
  await latePreemptController.dispose();

  // A game may defer retrying a handoff that failed while TTS owned the mic.
  // The failure state carries the accepted ordinary-voice epoch, so a retry
  // cannot end a newer ordinary session after the user has reclaimed capture.
  const deferredIntentWindow = new EventWindow();
  deferredIntentWindow.window = deferredIntentWindow;
  deferredIntentWindow.NekoSpeechPlaybackState = {
    type: 'speech_playback_state',
    active: true,
  };
  let deferredIntentSuspendCalls = 0;
  let deferredIntentEndCalls = 0;
  const deferredIntentDelivered = [];
  deferredIntentWindow.addEventListener('neko-game-voice-control-message', (event) => {
    if (event.detail?.type !== 'game_voice_control_request') {
      deferredIntentDelivered.push(event.detail);
    }
  });
  const recognitionCountBeforeDeferredIntent = RecognitionMock.instances.length;
  const deferredIntentController = sandbox.NekoMiniGameVoiceController.create({
    windowImpl: deferredIntentWindow,
    fetchImpl: async () => ({
      ok: true,
      async json() { return activeRoute('route-deferred-intent'); },
    }),
    storageImpl: new StorageMock(),
    BroadcastChannelImpl: null,
    RecognitionImpl: RecognitionMock,
    watchdogIntervalMs: 10000,
    isOrdinaryVoiceActive: () => true,
    suspendOrdinaryMic: async () => { deferredIntentSuspendCalls += 1; },
    restoreOrdinaryMic: async () => {},
    endOrdinaryVoiceSession: async () => { deferredIntentEndCalls += 1; },
  }).start();
  deferredIntentWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('deferred-intent-playback', 'handoff', 'route-deferred-intent'),
  }));
  await deferredIntentController.operationChain;
  const playbackDeferredState = deferredIntentDelivered.find((message) => (
    message.type === 'game_voice_control_state'
      && message.request_id === 'deferred-intent-playback'
  ));
  assert(playbackDeferredState?.ok === false
    && playbackDeferredState.reason === 'speech_playback_active'
    && Number.isSafeInteger(playbackDeferredState.ordinary_voice_intent_epoch),
  'playback-blocked handoff did not expose its ordinary voice intent epoch');

  await deferredIntentController.stopMiniGameVoiceForOrdinaryVoiceSession();
  deferredIntentWindow.NekoSpeechPlaybackState = {
    type: 'speech_playback_state',
    active: false,
  };
  const staleDeferredHandoff = request(
    'deferred-intent-stale-retry',
    'handoff',
    'route-deferred-intent',
  );
  staleDeferredHandoff.ordinary_voice_intent_epoch = (
    playbackDeferredState.ordinary_voice_intent_epoch
  );
  deferredIntentWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: staleDeferredHandoff,
  }));
  await deferredIntentController.operationChain;
  const staleDeferredState = deferredIntentDelivered.find((message) => (
    message.type === 'game_voice_control_state'
      && message.request_id === 'deferred-intent-stale-retry'
  ));
  assert(staleDeferredState?.ok === false
    && staleDeferredState.reason === 'ordinary_voice_handoff_cancelled'
    && staleDeferredState.ordinary_voice_intent_epoch
      === playbackDeferredState.ordinary_voice_intent_epoch
    && deferredIntentSuspendCalls === 0
    && deferredIntentEndCalls === 0
    && RecognitionMock.instances.length === recognitionCountBeforeDeferredIntent,
  'stale deferred handoff affected the newer ordinary voice intent');
  await deferredIntentController.dispose();

  // Half-duplex playback preserves the user's enabled slot while replacing
  // the aborted recognizer only after playback ends and the route revalidates.
  const mediaWindow = new EventWindow();
  mediaWindow.window = mediaWindow;
  mediaWindow.micMuted = false;
  mediaWindow.isMicMuted = () => mediaWindow.micMuted;
  mediaWindow.NekoSpeechPlaybackState = { type: 'speech_playback_state', active: true };
  let mediaRoute = activeRoute('route-media');
  let mediaRouteFailures = 0;
  let mediaSuspendCalls = 0;
  let mediaRestoreCalls = 0;
  const mediaDelivered = [];
  mediaWindow.addEventListener('neko-game-voice-control-message', (event) => {
    if (event.detail?.type !== 'game_voice_control_request') mediaDelivered.push(event.detail);
  });
  const mediaController = sandbox.NekoMiniGameVoiceController.create({
    windowImpl: mediaWindow,
    fetchImpl: async () => {
      if (mediaRouteFailures > 0) {
        mediaRouteFailures -= 1;
        throw new Error('temporary media route read failure');
      }
      return { ok: true, async json() { return { ...mediaRoute }; } };
    },
    storageImpl: new StorageMock(),
    BroadcastChannelImpl: null,
    RecognitionImpl: RecognitionMock,
    watchdogIntervalMs: 10000,
    restartDelayMs: 0,
    recoveryRetryDelayMs: 25,
    suspendOrdinaryMic: async () => { mediaSuspendCalls += 1; },
    restoreOrdinaryMic: async () => { mediaRestoreCalls += 1; },
  }).start();
  const recognitionCountBeforePausedStart = RecognitionMock.instances.length;
  mediaWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('media-start', 'start', 'route-media'),
  }));
  await mediaController.operationChain;
  assert(mediaController.getState().active === true
    && mediaController.getState().playbackPaused === true
    && mediaController.getState().listening === false
    && RecognitionMock.instances.length === recognitionCountBeforePausedStart
    && mediaSuspendCalls === 1,
  'start during speech playback did not preserve a paused, non-capturing slot');

  mediaWindow.NekoSpeechPlaybackState = { type: 'speech_playback_state', active: false };
  mediaWindow.dispatchEvent(new CustomEventMock('neko-speech-playback-state', {
    detail: mediaWindow.NekoSpeechPlaybackState,
  }));
  await flushController(mediaController);
  const mediaRecognition1 = RecognitionMock.instances.at(-1);
  assert(mediaRecognition1.startCalls === 1
    && mediaController.getState().active === true
    && mediaController.getState().playbackPaused === false,
  'speech playback end did not revalidate and resume the enabled slot');

  mediaWindow.NekoSpeechPlaybackState = { type: 'speech_playback_state', active: true };
  mediaWindow.dispatchEvent(new CustomEventMock('neko-speech-playback-state', {
    detail: mediaWindow.NekoSpeechPlaybackState,
  }));
  assert(mediaRecognition1.abortCalls === 1
    && mediaController.getState().active === true
    && mediaController.getState().listening === false
    && mediaController.getState().playbackPaused === true
    && mediaRestoreCalls === 0,
  'speech playback did not immediately abort capture while preserving voice intent');

  mediaWindow.NekoSpeechPlaybackState = { type: 'speech_playback_state', active: false };
  mediaRouteFailures = 1;
  mediaWindow.dispatchEvent(new CustomEventMock('neko-speech-playback-state', {
    detail: mediaWindow.NekoSpeechPlaybackState,
  }));
  await wait(45);
  await flushController(mediaController);
  const mediaRecognition2 = RecognitionMock.instances.at(-1);
  assert(mediaRecognition2 !== mediaRecognition1 && mediaRecognition2.startCalls === 1,
    'temporary route validation failure left playback-paused voice permanently inactive');

  mediaRouteFailures = 1;
  mediaRecognition2.emitEnd();
  await wait(45);
  await flushController(mediaController);
  assert(mediaRecognition2.startCalls === 2
    && mediaController.getState().active === true
    && mediaController.getState().listening === true,
  'temporary route validation failure left an ended recognizer permanently inactive');

  mediaWindow.micMuted = true;
  mediaWindow.dispatchEvent(new CustomEventMock('mic-mute-state-changed', {
    detail: { muted: true },
  }));
  assert(mediaRecognition2.abortCalls === 1
    && mediaController.getState().active === false
    && mediaRestoreCalls === 0,
  'global mute did not synchronously fence game capture without restoring the ordinary mic');
  await flushController(mediaController);
  const recognitionCountWhileMuted = RecognitionMock.instances.length;
  mediaWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('muted-start', 'start', 'route-media'),
  }));
  await mediaController.operationChain;
  assert(RecognitionMock.instances.length === recognitionCountWhileMuted
    && mediaDelivered.some((message) => message.request_id === 'muted-start'
      && message.type === 'game_voice_control_state'
      && message.ok === false
      && message.reason === 'microphone_muted'),
  'a globally muted start request created a speech recognizer');
  mediaWindow.micMuted = false;
  mediaWindow.dispatchEvent(new CustomEventMock('mic-mute-state-changed', {
    detail: { muted: false },
  }));
  await flushController(mediaController);
  assert(mediaRestoreCalls === 1,
    'unmute did not restore the ordinary microphone suspended by game voice');
  await mediaController.dispose();

  // A fatal recognition callback fences capture synchronously, but its
  // ordinary-mic restore remains serialized ahead of the next start.
  const fatalWindow = new EventWindow();
  fatalWindow.window = fatalWindow;
  let fatalRoute = activeRoute('route-fatal-A');
  let releaseFatalRestore = null;
  let fatalRestoreGate = null;
  const fatalOrder = [];
  const fatalController = sandbox.NekoMiniGameVoiceController.create({
    windowImpl: fatalWindow,
    fetchImpl: async () => ({ ok: true, async json() { return { ...fatalRoute }; } }),
    storageImpl: new StorageMock(),
    BroadcastChannelImpl: null,
    RecognitionImpl: RecognitionMock,
    watchdogIntervalMs: 10000,
    suspendOrdinaryMic: async () => { fatalOrder.push('suspend'); },
    restoreOrdinaryMic: async () => {
      fatalOrder.push('restore:start');
      if (fatalRestoreGate) await fatalRestoreGate;
      fatalOrder.push('restore:end');
    },
  }).start();
  fatalWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('fatal-start-A', 'start', 'route-fatal-A'),
  }));
  await fatalController.operationChain;
  const fatalRecognitionA = RecognitionMock.instances.at(-1);
  fatalRestoreGate = new Promise((resolve) => { releaseFatalRestore = resolve; });
  fatalRoute = activeRoute('route-fatal-B');
  fatalRecognitionA.emitError('not-allowed');
  assert(fatalRecognitionA.abortCalls === 1 && fatalController.getState().active === false,
    'fatal speech recognition error did not immediately abort and fence capture');
  await wait(5);
  fatalWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('fatal-start-B', 'start', 'route-fatal-B'),
  }));
  await wait(5);
  assert(RecognitionMock.instances.at(-1) === fatalRecognitionA
    && fatalOrder.at(-1) === 'restore:start',
  'a new start raced ahead of the serialized fatal-error restore');
  releaseFatalRestore();
  fatalRestoreGate = null;
  await flushController(fatalController);
  const fatalRecognitionB = RecognitionMock.instances.at(-1);
  assert(fatalRecognitionB !== fatalRecognitionA
    && fatalController.getState().identity.routeInstanceId === 'route-fatal-B'
    && fatalOrder.indexOf('restore:end') < fatalOrder.lastIndexOf('suspend'),
  'new generation did not start strictly after fatal-error cleanup');
  await fatalController.dispose();

  // A validated stop releases any stale owner, while a late matching stop can
  // still close its slot after the backend route has already disappeared.
  const stopWindow = new EventWindow();
  stopWindow.window = stopWindow;
  let stopRoute = activeRoute('route-stop-A');
  let stopRouteResolver = null;
  const stopController = sandbox.NekoMiniGameVoiceController.create({
    windowImpl: stopWindow,
    fetchImpl: async (url) => ({
      ok: true,
      async json() {
        return { ...(stopRouteResolver ? stopRouteResolver(url) : stopRoute) };
      },
    }),
    storageImpl: new StorageMock(),
    BroadcastChannelImpl: null,
    RecognitionImpl: RecognitionMock,
    watchdogIntervalMs: 10000,
    suspendOrdinaryMic: async () => {},
    restoreOrdinaryMic: async () => {},
  }).start();
  stopWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('stop-start-A', 'start', 'route-stop-A'),
  }));
  await stopController.operationChain;
  const staleRecognitionA = RecognitionMock.instances.at(-1);
  stopRouteResolver = (url) => (url.includes('sdk_route_instance_id=route-stop-A')
    ? activeRoute('route-stop-A')
    : activeRoute('route-stop-B'));
  stopWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('non-owner-stop-B', 'stop', 'route-stop-B'),
  }));
  await stopController.operationChain;
  assert(stopController.getState().identity.routeInstanceId === 'route-stop-A'
    && staleRecognitionA.abortCalls === 0
    && staleRecognitionA.stopCalls === 0,
  'a valid non-owner stop killed an independently revalidated live owner');

  stopRouteResolver = null;
  stopRoute = activeRoute('route-stop-B');
  stopWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('validated-stop-B', 'stop', 'route-stop-B'),
  }));
  await stopController.operationChain;
  assert(staleRecognitionA.abortCalls === 1 && stopController.getState().active === false,
    'validated generation B stop did not release stale generation A capture');

  stopWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('stop-start-B', 'start', 'route-stop-B'),
  }));
  await stopController.operationChain;
  const lateStopRecognition = RecognitionMock.instances.at(-1);
  stopRoute = { ok: true, active: false };
  stopWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('late-stop-B', 'stop', 'route-stop-B'),
  }));
  await stopController.operationChain;
  assert(lateStopRecognition.abortCalls === 1 && stopController.getState().active === false,
    'matching stop after backend route end left its capture slot alive');

  stopRoute = activeRoute('route-stop-B');
  stopWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('stop-restart-B', 'start', 'route-stop-B'),
  }));
  await stopController.operationChain;
  const incompleteStopRecognition = RecognitionMock.instances.at(-1);
  const incompleteStop = request('incomplete-stop', 'stop', 'route-stop-B');
  delete incompleteStop.sdk_route_instance_id;
  stopWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: incompleteStop,
  }));
  await stopController.operationChain;
  assert(stopController.getState().active === true
    && incompleteStopRecognition.abortCalls === 0
    && incompleteStopRecognition.stopCalls === 0,
  'an incomplete stop identity affected the current capture owner');

  // Route loss discovered while publishing a final result must fence first,
  // then run restore/state cleanup through the serialized operation chain.
  stopRoute = { ok: true, active: false };
  const transcriptLossSlot = stopController.current;
  incompleteStopRecognition.emitFinal('discard after route loss');
  await transcriptLossSlot.transcriptChain;
  await flushController(stopController);
  assert(incompleteStopRecognition.abortCalls === 1
    && stopController.getState().active === false,
  'transcript route invalidation did not immediately fence capture');

  stopRoute = activeRoute('route-stop-B');
  stopWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('restart-loss-start', 'start', 'route-stop-B'),
  }));
  await stopController.operationChain;
  const restartLossRecognition = RecognitionMock.instances.at(-1);
  stopRoute = { ok: true, active: false };
  restartLossRecognition.emitEnd();
  await flushController(stopController);
  assert(restartLossRecognition.abortCalls === 1
    && stopController.getState().active === false,
  'recognition restart route invalidation did not fence capture through the operation chain');
  await stopController.dispose();

  // Unsupported recognition must fail immediately, publish the explicit
  // error type, and also answer the pending SDK request with state(ok=false).
  route = activeRoute('route-C');
  const unsupportedWindow = new EventWindow();
  unsupportedWindow.window = unsupportedWindow;
  const unsupportedDelivered = [];
  unsupportedWindow.addEventListener('neko-game-voice-control-message', (event) => {
    if (event.detail?.type !== 'game_voice_control_request') unsupportedDelivered.push(event.detail);
  });
  const unsupportedController = sandbox.NekoMiniGameVoiceController.create({
    windowImpl: unsupportedWindow,
    fetchImpl,
    storageImpl: new StorageMock(),
    BroadcastChannelImpl: null,
    RecognitionImpl: null,
  }).start();
  unsupportedWindow.dispatchEvent(new CustomEventMock('neko-game-voice-control-message', {
    detail: request('unsupported-C', 'start', 'route-C'),
  }));
  await unsupportedController.operationChain;
  assert(unsupportedDelivered.some((message) => message.type === 'game_voice_control_error'
    && message.request_id === 'unsupported-C'
    && message.code === 'speech_recognition_unsupported'),
  'unsupported speech recognition did not publish game_voice_control_error');
  assert(unsupportedDelivered.some((message) => message.type === 'game_voice_control_state'
    && message.request_id === 'unsupported-C'
    && message.ok === false),
  'unsupported speech recognition left the SDK request pending');
  await unsupportedController.dispose();

  assert(!source.includes('/route/voice-transcript')
    && !source.includes("action: 'start_session'")
    && !source.includes('console.log'),
  'controller reintroduced the old dialogue takeover or raw transcript logging path');
  process.stdout.write('mini-game voice controller runtime test passed\n');
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
