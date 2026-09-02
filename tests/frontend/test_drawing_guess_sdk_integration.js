const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
    clone() { return jsonResponse(data, status); },
  };
}

async function main() {
  const sdkDir = path.resolve(__dirname, '../../static/game/sdk');
  const hostPath = path.join(sdkDir, 'neko-minigame-same-origin-host.js');
  const bootstrapPath = path.join(sdkDir, 'neko-minigame-same-origin-bootstrap.js');
  const sdkPath = path.join(sdkDir, 'neko-minigame-sdk.js');
  const calls = [];
  let speechTapReadyDelivered = false;
  let speechDispatchedBeforeTapReady = false;
  let trustedAvatarFactoryCalls = 0;
  let trustedAvatarMounts = 0;
  let forgedAvatarMounts = 0;
  let trustedWindowCloseCalls = 0;
  let forgedWindowCloseCalls = 0;
  const trustedNekoHost = {
    closeWindow() {
      assert(this === trustedNekoHost,
        'the captured window-close provider lost its trusted receiver');
      trustedWindowCloseCalls += 1;
      return { ok: true };
    },
  };
  const localStorageValues = new Map();
  const localStorageMock = {
    get length() { return localStorageValues.size; },
    key(index) { return [...localStorageValues.keys()][index] ?? null; },
    getItem(key) {
      const normalized = String(key);
      return localStorageValues.has(normalized) ? localStorageValues.get(normalized) : null;
    },
    setItem(key, value) {
      localStorageValues.set(String(key), String(value));
    },
    removeItem(key) {
      localStorageValues.delete(String(key));
    },
  };
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), body });
    if (String(url).startsWith('/api/config/page_config')) {
      return jsonResponse({ autostart_csrf_token: 'drawing-sdk-token' });
    }
    if (String(url).endsWith('/route/start')) {
      return jsonResponse({
        ok: true,
        state: {
          game_route_active: true,
          session_id: body.session_id,
          lanlan_name: 'SDK Neko',
        },
      });
    }
    if (String(url).endsWith('/round/start')) {
      return jsonResponse({
        ok: true,
        command: 'round:start',
        accepted_marker: body.marker,
      });
    }
    if (String(url).endsWith('/speak')) {
      if (!speechTapReadyDelivered) speechDispatchedBeforeTapReady = true;
      return jsonResponse({
        ok: true,
        audio_sent: true,
        speech_id: 'drawing-sdk-speech',
      });
    }
    if (String(url).endsWith('/end')) {
      return jsonResponse({
        ok: true,
        closed: true,
        route_closed: true,
        session_id: 'drawing-sdk-session',
      });
    }
    return jsonResponse({ ok: true });
  };

  const speechTapSockets = [];
  class SpeechTapWebSocketMock {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      this.closed = false;
      this.sent = [];
      speechTapSockets.push(this);
      // The host installs handlers after construction. Deliver readiness on a
      // later task so the integration exercises its bounded first-speech wait.
      setTimeout(() => {
        if (this.closed) return;
        this.readyState = 1;
        this.onopen?.({ type: 'open' });
        const parsed = new URL(this.url);
        speechTapReadyDelivered = true;
        this.onmessage?.({
          data: JSON.stringify({
            type: 'speech_tap_ready',
            ok: true,
            game_type: 'drawing_guess',
            session_id: parsed.searchParams.get('session_id'),
          }),
        });
      }, 0);
    }
    send(data) { this.sent.push(data); }
    close(code = 1000, reason = '') {
      if (this.closed) return;
      this.closed = true;
      this.readyState = 3;
      this.closeCode = code;
      this.closeReason = reason;
      this.onclose?.({ code, reason });
    }
  }

  const launchNode = {
    textContent: JSON.stringify({
      registrations: {
        'drawing-guess': {
          mode: 'development',
          gameId: 'drawing-guess',
          routeGameType: 'drawing_guess',
          publisherId: 'project-neko',
          version: '0.1.0',
          allowedCapabilities: [
            'runtime', 'logging', 'speech-output', 'avatar-renderer', 'memory',
            'window-control', 'storage',
          ],
          commandRoutes: {
            'round:start': {
              path: 'round/start',
              maxRequestBytes: 65536,
              maxTimeoutMs: 30000,
            },
            'round:ai-draw': {
              path: 'ai-draw',
              maxRequestBytes: 65536,
              maxTimeoutMs: 90000,
            },
            'round:input': {
              path: 'input',
              maxRequestBytes: 65536,
              maxTimeoutMs: 30000,
            },
            'round:feedback': {
              path: 'input',
              maxRequestBytes: 2097152,
              maxTimeoutMs: 330000,
            },
            'round:choose-word': {
              path: 'choose-word',
              maxRequestBytes: 65536,
              maxTimeoutMs: 30000,
            },
            'round:timeout': {
              path: 'timeout',
              maxRequestBytes: 65536,
              maxTimeoutMs: 30000,
            },
            'round:vision-guess': {
              path: 'vision-guess',
              maxRequestBytes: 2097152,
              maxTimeoutMs: 330000,
            },
          },
        },
      },
    }),
    remove() { this.removed = true; },
  };
  Object.defineProperty(launchNode, 'nekoCapabilityProviders', {
    value: {
      'drawing-guess': {
        avatarHostFactory() {
          trustedAvatarFactoryCalls += 1;
          return {
            async getCurrentCharacter() {
              return {
                name: 'SDK Neko',
                model: { type: 'mmd', path: '/models/sdk-neko.pmx' },
                rendererAvailable: true,
                system_prompt: 'must-not-cross-the-boundary',
              };
            },
            async getCharacter(name) {
              return {
                name,
                model: { type: 'pngtuber', path: '/models/sdk-neko.png' },
                rendererAvailable: true,
              };
            },
            async listCharacters() { return ['SDK Neko', 'PNG Neko']; },
            async mount(config) {
              trustedAvatarMounts += 1;
              return {
                async setModel() {},
                setView(view) { calls.push({ url: 'avatar:view', body: view }); },
                setSpeaking(active) { calls.push({ url: 'avatar:speaking', body: { active } }); },
                focus() {},
                setEmotion() {},
                pause() {},
                resume() {},
                getState() { return { ready: true, type: config.model.type }; },
                dispose() {},
              };
            },
            dispose() {},
          };
        },
      },
    },
  });
  const listeners = new Map();
  const windowMock = {
    AbortController,
    console: { log() {}, warn() {}, error() {} },
    fetch: fetchImpl,
    location: { origin: 'http://127.0.0.1:48911' },
    i18next: { language: 'zh-CN' },
    navigator: { sendBeacon: () => false },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event?.type) || []) handler.call(windowMock, event);
      return true;
    },
    localStorage: localStorageMock,
    crypto: {
      getRandomValues(values) {
        values.fill(11);
        return values;
      },
    },
    WebSocket: SpeechTapWebSocketMock,
    nekoHost: trustedNekoHost,
    appState: {
      pendingAudioChunkMetaQueue: [],
    },
    appAudioPlayback: {
      enqueueIncomingAudioBlob() {},
      schedulePendingAudioMetaStallCheck() {},
    },
  };
  windowMock.document = {
    currentScript: null,
    documentElement: { lang: 'zh-CN' },
    hidden: false,
    visibilityState: 'visible',
    getElementById(id) {
      return id === 'neko-minigame-host-launch' ? launchNode : null;
    },
    createElement() {
      return { remove() { this.removed = true; } };
    },
    head: {
      appendChild(script) {
        windowMock.document.currentScript = script;
        try {
          vm.runInThisContext(fs.readFileSync(hostPath, 'utf8'), { filename: hostPath });
        } finally {
          windowMock.document.currentScript = null;
        }
        script.onload?.();
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  global.window = windowMock;

  vm.runInThisContext(fs.readFileSync(bootstrapPath, 'utf8'), { filename: bootstrapPath });
  await windowMock.nekoMiniGameSameOriginHostReady;
  trustedNekoHost.closeWindow = () => {
    forgedWindowCloseCalls += 1;
    return { ok: true };
  };
  windowMock.nekoHost = {
    closeWindow() {
      forgedWindowCloseCalls += 1;
      return { ok: true };
    },
  };
  vm.runInThisContext(fs.readFileSync(sdkPath, 'utf8'), { filename: sdkPath });

  const createHost = await windowMock.nekoMiniGameSameOriginHostReady;
  const transport = createHost({
    gameType: 'drawing-guess',
    routeGameType: 'forged-route',
    sessionId: 'drawing-sdk-session',
    source: 'drawing_guess',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
    avatarHost: {
      mount() { forgedAvatarMounts += 1; },
      getCharacter() { return null; },
      listCharacters() { return []; },
    },
    trustedAvatarHost: {
      mount() { forgedAvatarMounts += 1; },
      getCharacter() { return null; },
      listCharacters() { return []; },
    },
    capabilityProviders: {
      windowClose() {
        forgedWindowCloseCalls += 1;
        return { ok: true };
      },
    },
  });
  const game = await windowMock.NekoMiniGame.connect({
    id: 'drawing-guess',
    version: '0.1.0',
    protocolVersion: '1',
    requiredCapabilities: [
      'runtime', 'logging', 'speech-output', 'avatar-renderer', 'memory',
    ],
    optionalCapabilities: ['window-control', 'storage'],
    contracts: {
      commands: {
        'round:start': {
          request: {
            type: 'object',
            additionalProperties: true,
          },
          response: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              command: { type: 'string' },
              accepted_marker: { type: 'string' },
            },
            required: ['ok', 'command', 'accepted_marker'],
            additionalProperties: true,
          },
        },
      },
    },
  }, { transport, windowImpl: windowMock, documentImpl: windowMock.document });

  assert(game.capabilities.granted.join(',')
    === 'runtime,logging,speech-output,avatar-renderer,memory,window-control,storage',
    `unexpected drawing capability grant: ${game.capabilities.granted.join(',')}`);
  assert(trustedAvatarFactoryCalls === 1 && forgedAvatarMounts === 0,
    'the game replaced the bootstrap-owned Avatar provider');
  assert(transport._avatarHost === undefined && transport.trustedAvatarHost === undefined,
    'the trusted Avatar provider leaked through the game transport object');
  assert(game.speech.connected === true,
    'the drawing SDK did not establish the host speech-output state bridge');
  assert(game.host.registration.gameId === 'drawing-guess'
    && game.host.registration.mode === 'development',
  'the public handshake exposed the wrong drawing identity');
  assert(Object.isFrozen(game.locale)
    && Object.isFrozen(game.locale.current)
    && game.locale.current.language === 'zh-CN',
  'the drawing client did not expose the trusted zh-CN host locale');

  const windowClose = await game.window.close({ timeoutMs: 1000 });
  assert(windowClose.ok === true
    && windowClose.data.closed === true
    && Object.isFrozen(game.window)
    && Object.isFrozen(windowClose.data)
    && trustedWindowCloseCalls === 1
    && forgedWindowCloseCalls === 0,
  'drawing window.close did not use the provider captured before game code');

  const storageKey = 'settings/integration-probe';
  const storageValue = { colorHistory: ['#112233', '#abcdef'] };
  const storageSet = await game.storage.set(storageKey, storageValue);
  const storageGet = await game.storage.get(storageKey);
  const storageList = await game.storage.list({ prefix: 'settings/' });
  const qualifiedStorageKey = 'neko:minigame-storage:v1:drawing-guess:0.1.0:settings/integration-probe';
  assert(storageSet.ok === true
    && storageSet.data.stored === true
    && storageGet.ok === true
    && storageGet.data.found === true
    && storageGet.data.value.colorHistory.join(',') === '#112233,#abcdef',
  'drawing SDK storage did not round-trip a bounded preference payload');
  assert(localStorageValues.get(qualifiedStorageKey) === JSON.stringify(storageValue)
    && !localStorageValues.has(storageKey)
    && storageList.data.keys.join(',') === storageKey
    && !storageList.data.keys.includes(qualifiedStorageKey),
  'drawing storage was not namespaced or exposed its raw host key to the game');

  game.runtime.configure({ heartbeat: false, outputs: false, pageExit: false });
  const firstConsent = await game.memory.configureConsent(true, { timeoutMs: 1000 });
  assert(firstConsent.ok === true
    && firstConsent.data.enabled === true
    && game.memory.consent.configured === true
    && game.memory.consent.enabled === true
    && game.memory.consent.locked === false,
  'drawing SDK did not configure memory consent before its first runtime start');
  const started = await game.runtime.start({
    lanlan_name: 'SDK Neko',
    game_memory_enabled: false,
    game_memory_archive_enabled: false,
    event: {
      kind: 'forged-memory-policy',
      game_memory_enabled: false,
      i18n_language: 'ru',
    },
  }, { timeoutMs: 1000 });
  assert(started.ok && game.runtime.state === 'running',
    'the integrated drawing SDK runtime did not start');
  assert(game.memory.consent.enabled === true && game.memory.consent.locked === true,
    'runtime start did not lock the configured memory consent');
  const startCall = calls.find((call) => call.url.endsWith('/route/start'));
  assert(startCall?.url === '/api/game/drawing_guess/route/start',
    `the public id did not use the trusted route alias: ${startCall?.url}`);
  assert(startCall.body.session_id === 'drawing-sdk-session'
    && startCall.body.sdk_route_instance_id
    && startCall.body.game_memory_enabled === true
    && startCall.body.game_memory_archive_enabled === true
    && startCall.body.i18n_language === 'zh-CN'
    && startCall.body.event.kind === 'forged-memory-policy'
    && !Object.hasOwn(startCall.body.event, 'game_memory_enabled')
    && !Object.hasOwn(startCall.body.event, 'i18n_language'),
  'the integrated host did not inject trusted route identity');

  const currentCharacter = await game.avatar.getCurrentCharacter();
  const characterNames = await game.avatar.listCharacters();
  const avatarController = await game.avatar.mount({
    slot: 'drawing-guess-character',
    model: currentCharacter.model,
    viewport: { mode: 'container' },
    resize: { mode: 'container' },
  });
  avatarController.setView({ scale: 190, x: 0, y: 28 });
  avatarController.setSpeaking(true);
  assert(currentCharacter.name === 'SDK Neko'
    && currentCharacter.model.type === 'mmd'
    && currentCharacter.system_prompt === undefined
    && Object.isFrozen(currentCharacter)
    && Object.isFrozen(currentCharacter.model)
    && Object.isFrozen(characterNames)
    && characterNames.join(',') === 'SDK Neko,PNG Neko'
    && trustedAvatarMounts === 1
    && forgedAvatarMounts === 0,
  'drawing Avatar facade did not use the projected bootstrap-owned provider');
  avatarController.dispose();

  const commandResult = await game.commands.execute('round:start', {
    marker: 'drawing-command-round-trip',
    game_type: 'forged_game_type',
    session_id: 'forged-session',
    lanlan_name: 'Forged Neko',
    sdk_route_instance_id: 'forged-generation',
    game_memory_enabled: false,
    game_memory_archive_enabled: false,
    i18n_language: 'ru',
    language: 'ru',
    event: {
      kind: 'forged-command-policy',
      game_memory_enabled: false,
      i18n_language: 'ru',
    },
  }, { timeoutMs: 1200 });
  assert(commandResult.ok === true
    && commandResult.status === 200
    && commandResult.data.command === 'round:start'
    && commandResult.data.accepted_marker === 'drawing-command-round-trip',
  'drawing commands.execute did not return the validated host response');
  const commandCall = calls.find((call) => call.url.endsWith('/round/start'));
  assert(commandCall?.url === '/api/game/drawing_guess/round/start',
    `the trusted command alias/path was not used: ${commandCall?.url}`);
  assert(commandCall.body.marker === 'drawing-command-round-trip'
    && commandCall.body.game_type === 'drawing_guess'
    && commandCall.body.session_id === 'drawing-sdk-session'
    && commandCall.body.lanlan_name === 'SDK Neko'
    && commandCall.body.sdk_route_instance_id === startCall.body.sdk_route_instance_id
    && commandCall.body.sdk_route_instance_id !== 'forged-generation'
    && commandCall.body.game_memory_enabled === true
    && commandCall.body.game_memory_archive_enabled === true
    && commandCall.body.i18n_language === 'zh-CN'
    && !Object.hasOwn(commandCall.body, 'language')
    && commandCall.body.event.kind === 'forged-command-policy'
    && !Object.hasOwn(commandCall.body.event, 'game_memory_enabled')
    && !Object.hasOwn(commandCall.body.event, 'i18n_language'),
  'the host did not overwrite forged command identity, memory policy, or locale');

  const speechStates = [];
  const unsubscribeSpeech = game.speech.onState((playbackState) => {
    speechStates.push(playbackState);
  });
  const speechResult = await game.speech.speak({
    text: 'SDK speech bridge integration line',
    source: 'game-llm-result',
    requestId: 'drawing-sdk-speech-request',
    mirrorText: false,
    emitTurnEnd: true,
    interruptExisting: false,
  }, { timeoutMs: 1200 });
  assert(speechResult.ok === true && speechResult.data.speech_id === 'drawing-sdk-speech',
    'drawing speech.speak did not use the granted host capability');
  const speakCall = calls.find((call) => call.url.endsWith('/speak'));
  assert(speakCall?.url === '/api/game/drawing_guess/speak'
    && speakCall.body.session_id === 'drawing-sdk-session'
    && speakCall.body.game_type === 'drawing_guess'
    && speakCall.body.sdk_route_instance_id === startCall.body.sdk_route_instance_id
    && speakCall.body.suppress_primary_audio === true
    && speakCall.body.wait_for_audio_completion === true,
  'speech output did not retain the trusted active route identity');
  assert(!speechDispatchedBeforeTapReady
    && speechTapSockets[0]?.url.includes('/api/game/drawing_guess/speech/ws?')
    && speechTapSockets[0]?.url.includes(`sdk_route_instance_id=${startCall.body.sdk_route_instance_id}`),
  'drawing speech was dispatched before its trusted route-bound audio tap was ready');
  windowMock.dispatchEvent({
    type: 'neko-speech-playback-state',
    detail: {
      type: 'speech_playback_state',
      active: true,
      speech_id: 'drawing-sdk-speech',
      remaining_seconds: 0.5,
      audio_context_state: 'running',
      updated_at: Date.now(),
    },
  });
  assert(speechStates.length === 1
    && speechStates[0].active === true
    && speechStates[0].speechId === 'drawing-sdk-speech',
  'speech.onState did not receive playback state through the host bridge');
  unsubscribeSpeech();

  const logEnabled = await game.logger.enableAfterRuntimeStart();
  assert(logEnabled?.ok === true, 'route-start logging did not create a backend log session');
  game.logger.info('runtime', 'integration_started', 'drawing SDK integration started', {
    phase: 'running',
  });
  await game.logger.flush();
  const firstLogEnable = calls.find((call) => call.url === '/api/game/logs/enable');
  const firstLog = calls.find((call) => call.url === '/api/game/logs');
  assert(firstLogEnable?.body.session_id === 'drawing-sdk-session'
    && firstLogEnable.body.game_type === 'drawing_guess'
    && firstLog?.body.event === 'integration_started',
  'drawing logging did not use the trusted route alias or enabled backend session');

  const ended = await game.runtime.end({ reason: 'integration-test' }, { timeoutMs: 1000 });
  assert(ended.ok && game.runtime.state === 'ended',
    'the integrated drawing SDK runtime did not end');
  const endCall = calls.find((call) => call.url.endsWith('/end'));
  assert(endCall?.url === '/api/game/drawing_guess/end'
    && endCall.body.sdk_route_instance_id === startCall.body.sdk_route_instance_id,
  'the trusted route alias or SDK route generation was lost at end');

  const sameSessionRestart = await game.runtime.start(
    { lanlan_name: 'SDK Neko' },
    { timeoutMs: 1000 },
  );
  assert(sameSessionRestart.ok && game.runtime.session.id === 'drawing-sdk-session',
    'same-session runtime restart did not preserve its identity');
  const sameSessionLogEnabled = await game.logger.enableAfterRuntimeStart();
  const sameSessionLogEnableCalls = calls.filter((call) => call.url === '/api/game/logs/enable');
  assert(sameSessionLogEnabled?.ok === true
    && sameSessionLogEnableCalls.length === 2
    && sameSessionLogEnableCalls[1].body.session_id === 'drawing-sdk-session',
  'runtime end left the same-session backend logging gate incorrectly enabled');
  await game.runtime.end({ reason: 'integration-same-session-restart' }, { timeoutMs: 1000 });

  const resetSession = game.runtime.reset({ newSession: true });
  assert(resetSession.id && resetSession.id !== 'drawing-sdk-session',
    'runtime reset did not rotate the drawing logging session');
  const resetConsent = await game.memory.configureConsent(false, { timeoutMs: 1000 });
  assert(resetConsent.ok === true
    && resetConsent.data.enabled === false
    && game.memory.consent.configured === true
    && game.memory.consent.enabled === false
    && game.memory.consent.locked === false,
  'runtime reset did not unlock memory consent for the new session');
  const restarted = await game.runtime.start({
    lanlan_name: 'SDK Neko',
    game_memory_enabled: true,
    game_memory_archive_enabled: true,
  }, { timeoutMs: 1000 });
  assert(restarted.ok && game.runtime.state === 'running',
    'the integrated drawing SDK runtime did not restart');
  const routeStartCalls = calls.filter((call) => call.url.endsWith('/route/start'));
  const resetStartCall = routeStartCalls[routeStartCalls.length - 1];
  assert(resetStartCall.body.session_id === resetSession.id
    && resetStartCall.body.game_memory_enabled === false
    && resetStartCall.body.game_memory_archive_enabled === false
    && resetStartCall.body.i18n_language === 'zh-CN',
  'the reset runtime accepted forged memory enablement or lost the trusted locale');
  const secondLogEnabled = await game.logger.enableAfterRuntimeStart();
  assert(secondLogEnabled?.ok === true, 'new runtime session reused the old local logging gate');
  const logEnableCalls = calls.filter((call) => call.url === '/api/game/logs/enable');
  assert(logEnableCalls.length === 3
    && logEnableCalls[2].body.session_id === resetSession.id
    && logEnableCalls[2].body.session_id !== logEnableCalls[0].body.session_id,
  'new runtime session did not create its own backend logging session');
  await game.runtime.end({ reason: 'integration-restart-test' }, { timeoutMs: 1000 });
  game.dispose();
  assert(launchNode.removed === true, 'the trusted drawing launch registration was not consumed');

  process.stdout.write('drawing-guess SDK integration test passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
