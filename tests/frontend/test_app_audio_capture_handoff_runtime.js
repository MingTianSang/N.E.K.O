const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) throw new Error(message);
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

function createHarness(options = {}) {
  const listeners = new Map();
  const sentMessages = [];
  const realSetTimeout = setTimeout;
  const realClearTimeout = clearTimeout;

  class CustomEventMock {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }

  class MediaStreamMock {
    constructor(streamOptions = {}) {
      this.throwOnGetTracks = streamOptions.throwOnGetTracks === true;
      this.tracks = streamOptions.tracks || [{ stop() {} }];
      this.getTracksCalls = 0;
    }

    getTracks() {
      this.getTracksCalls += 1;
      if (this.throwOnGetTracks) throw new Error('track cleanup failed');
      return this.tracks;
    }

    getAudioTracks() {
      return this.tracks;
    }
  }

  class WebSocketMock {}
  WebSocketMock.OPEN = 1;

  class AudioContextMock {
    constructor() {
      this.state = 'running';
    }

    resume() { return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
  }

  const state = {
    isRecording: false,
    voiceChatActive: false,
    voiceStartPending: false,
    isTextSessionActive: false,
    _pendingSessionStartMode: null,
    isMicMuted: false,
    stream: null,
    audioContext: null,
    audioPlayerContext: { state: 'running', resume() { return Promise.resolve(); } },
    workletNode: null,
    inputAnalyser: null,
    micGainNode: null,
    silenceDetectionTimer: null,
    gameVoiceSttGateActive: false,
    gameVoiceSttRecognition: null,
    gameVoiceSttRestartTimer: null,
    gameVoiceSttListening: false,
    gameVoiceSttStopping: false,
    selectedMicrophoneId: null,
    microphoneGainDb: 0,
    socket: null,
  };

  const documentMock = {
    hidden: false,
    visibilityState: 'visible',
    getElementById() { return null; },
    querySelectorAll() { return []; },
    createElement() {
      return {
        addEventListener() {},
        appendChild() {},
        classList: { add() {}, remove() {}, contains() { return false; } },
        dataset: {},
        style: {},
      };
    },
  };

  const navigatorMock = {
    mediaDevices: {
      addEventListener() {},
      enumerateDevices() { return Promise.resolve([]); },
      getUserMedia: options.getUserMedia || (() => Promise.reject(new Error('unused getUserMedia'))),
    },
  };

  const windowMock = {
    appState: state,
    appConst: {},
    appUtils: {
      isMobile() { return false; },
      dbToLinear() { return 1; },
    },
    AudioContext: AudioContextMock,
    webkitAudioContext: AudioContextMock,
    WebSocket: WebSocketMock,
    CustomEvent: CustomEventMock,
    isRecording: false,
    isMicStarting: false,
    isSecureContext: true,
    location: { protocol: 'https:' },
    t(key) { return key; },
    showStatusToast() {},
    syncVoiceChatComposerHidden() {},
    syncFloatingMicButtonState() {},
    syncFloatingScreenButtonState() {},
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event) {
      for (const handler of Array.from(listeners.get(event.type) || [])) {
        handler.call(windowMock, event);
      }
      return true;
    },
    setTimeout(callback, delay, ...args) {
      const effectiveDelay = options.accelerateCaptureTimeout && delay === 5000 ? 5 : delay;
      return realSetTimeout(callback, effectiveDelay, ...args);
    },
    clearTimeout(timer) { realClearTimeout(timer); },
  };

  state.socket = {
    readyState: WebSocketMock.OPEN,
    send(serialized) {
      const message = JSON.parse(serialized);
      sentMessages.push(message);
      if (message.action === 'end_session') {
        windowMock.dispatchEvent(new CustomEventMock('neko:session-ended-by-server'));
      }
    },
  };

  const quietConsole = {
    log() {},
    info() {},
    warn() {},
    error() {},
    dir() {},
  };
  const sandbox = {
    window: windowMock,
    document: documentMock,
    navigator: navigatorMock,
    console: quietConsole,
    CustomEvent: CustomEventMock,
    MediaStream: MediaStreamMock,
    WebSocket: WebSocketMock,
    AudioContext: AudioContextMock,
    AudioWorkletNode: class {},
    Uint8Array,
    Float32Array,
    Date,
    Math,
    JSON,
    Promise,
    Set,
    Array,
    Object,
    Error,
    requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {},
    // The module's two eager permission/list rendering timers are unrelated to
    // handoff. Suppress only bare global timers; handoff timers use window.*.
    setTimeout() { return 0; },
    clearTimeout() {},
    fetch() { return Promise.reject(new Error('unexpected fetch')); },
  };

  const sourcePath = path.resolve(__dirname, '../../static/app/app-audio-capture.js');
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), sandbox, {
    filename: sourcePath,
    timeout: 5000,
  });

  return {
    api: windowMock.appAudioCapture,
    state,
    windowMock,
    sentMessages,
    MediaStreamMock,
  };
}

async function testCaptureSettleTimeoutForceEndsCommittedSession() {
  const mediaRequest = deferred();
  const harness = createHarness({
    accelerateCaptureTimeout: true,
    getUserMedia() { return mediaRequest.promise; },
  });
  harness.state.voiceStartPending = true;
  harness.state._pendingSessionStartMode = 'audio';
  harness.windowMock.isMicStarting = true;
  harness.windowMock.cancelPendingSessionStart = () => {
    harness.state.voiceStartPending = false;
    harness.state._pendingSessionStartMode = null;
    harness.windowMock.isMicStarting = false;
  };

  const capturePromise = harness.api.startMicCapture().catch((error) => error);
  const suspendError = await harness.api.suspendOrdinaryMicCaptureForMiniGameVoice()
    .then(() => null, (error) => error);

  assert(suspendError?.message === 'ordinary_microphone_suspend_timeout',
    'a stuck getUserMedia did not trigger the capture-settle timeout');
  assert(suspendError.ordinaryVoiceCommitted === true,
    'the timeout error did not preserve the forced ordinary-session commitment');
  const endMessage = harness.sentMessages.find((message) => message.action === 'end_session');
  assert(endMessage?.reason === 'mini_game_voice_suspend_timeout',
    'capture timeout did not force-end the ordinary backend session');
  assert(harness.state.voiceStartPending === false
    && harness.state.voiceChatActive === false
    && harness.windowMock.isMicStarting === false,
  'capture timeout did not finalize ordinary voice state');

  mediaRequest.resolve(new harness.MediaStreamMock());
  const lateCaptureError = await capturePromise;
  assert(lateCaptureError?.miniGameVoiceCaptureBlocked === true,
    'the late getUserMedia result escaped the mini-game ownership epoch fence');
}

async function testCommittedCleanupFailureStillEndsBackendAndFinalizes() {
  const harness = createHarness();
  const brokenStream = new harness.MediaStreamMock({ throwOnGetTracks: true });
  harness.state.isRecording = true;
  harness.state.voiceChatActive = true;
  harness.state.voiceStartPending = true;
  harness.state.isTextSessionActive = true;
  harness.state._pendingSessionStartMode = 'audio';
  harness.state.stream = brokenStream;
  harness.windowMock.isRecording = true;
  harness.windowMock.isMicStarting = true;

  const result = await harness.api.endOrdinaryVoiceSession({
    force: true,
    reason: 'runtime_cleanup_failure',
    timeoutMs: 50,
  });

  assert(brokenStream.getTracksCalls > 0,
    'the runtime fixture did not reach the committed cleanup failure');
  assert(harness.sentMessages.some((message) => (
    message.action === 'end_session' && message.reason === 'runtime_cleanup_failure'
  )), 'a committed local cleanup failure skipped the backend end_session attempt');
  assert(result.ok === false && result.committed === true,
    'a committed cleanup failure did not return its irreversible commitment');
  assert(harness.state.isRecording === false
    && harness.state.voiceChatActive === false
    && harness.state.voiceStartPending === false
    && harness.state.isTextSessionActive === false
    && harness.state._pendingSessionStartMode === null
    && harness.windowMock.isRecording === false
    && harness.windowMock.isMicStarting === false,
  'a committed cleanup failure did not finalize local ordinary voice state');
}

async function main() {
  await testCaptureSettleTimeoutForceEndsCommittedSession();
  await testCommittedCleanupFailureStillEndsBackendAndFinalizes();
  process.stdout.write('app audio capture handoff runtime tests passed\n');
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
