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

function storage() {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(String(key), String(value)); },
    removeItem(key) { values.delete(String(key)); },
  };
}

// Shape of the server's /route/end response: the full internal archive.
const RAW_END_RESPONSE = {
  ok: true,
  closed: true,
  route_closed: true,
  session_id: 'server-session',
  should_resume_external_on_exit: true,
  before_game_external_mode: 'audio',
  archive: {
    game_type: 'generic-game',
    session_id: 'server-session',
    finalScore: { player: 2, ai: 1 },
    last_state: { round: 4 },
    dialog_count: 7,
    full_dialogues: [{ role: 'user', text: 'private speech' }],
    last_full_dialogues: [{ role: 'user', text: 'private speech' }],
    key_events: ['private event'],
    summary: 'private summary',
    game_context_summary: 'private rolling summary',
    game_context_signals: { private: true },
    game_context_recent_ids: ['id-1'],
    route_activations: [{ kind: 'internal' }],
    nekoInviteText: 'private invite',
    preGameContext: { stance: 'private' },
    pre_game_context_source: 'ai',
    sdk_memory_submissions: [{ summary: 'game submitted this itself' }],
  },
  archive_memory: { text: 'private memory write' },
  postgame: { ok: true, action: 'chat', line: 'assistant postgame line', llm_source: { p: 1 } },
};

const LEAKY_ARCHIVE_FIELDS = [
  'full_dialogues', 'last_full_dialogues', 'key_events', 'summary',
  'game_context_signals', 'game_context_recent_ids', 'route_activations',
  'nekoInviteText',
];

async function main() {
  const sourcePath = path.resolve(
    __dirname,
    '../../static/game/sdk/neko-minigame-same-origin-host.js',
  );
  const calls = [];
  const listeners = new Map();
  let releaseProtocolTwo;
  let markProtocolTwoStarted;
  let releaseDelayedDrain;
  let markDelayedDrainStarted;
  let releaseDelayedCommand;
  let markDelayedCommandStarted;
  let slowLogEnableGate = null;
  let releaseSlowLogEnable = null;
  let slowLogEnableAborted = false;
  let forceHeartbeatInactive = false;
  let forceDrainInactive = false;
  const protocolTwoGate = new Promise((resolve) => { releaseProtocolTwo = resolve; });
  const protocolTwoStarted = new Promise((resolve) => { markProtocolTwoStarted = resolve; });
  const delayedDrainGate = new Promise((resolve) => { releaseDelayedDrain = resolve; });
  const delayedDrainStarted = new Promise((resolve) => { markDelayedDrainStarted = resolve; });
  const delayedCommandGate = new Promise((resolve) => { releaseDelayedCommand = resolve; });
  const delayedCommandStarted = new Promise((resolve) => { markDelayedCommandStarted = resolve; });
  const fetchImpl = async (url, init = {}) => {
    const pathName = String(url);
    if (pathName.startsWith('/api/config/page_config')) {
      return jsonResponse({ autostart_csrf_token: 'test-token' });
    }
    if (pathName === '/api/game/logs/enable') {
      if (slowLogEnableGate) {
        init.signal?.addEventListener('abort', () => { slowLogEnableAborted = true; }, { once: true });
        await slowLogEnableGate;
      }
      return jsonResponse({ ok: true, enabled: true });
    }
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ url: pathName, init, body });
    if (pathName.endsWith('/protocol') && body.sequence === 2) {
      markProtocolTwoStarted();
      await protocolTwoGate;
    }
    if (pathName === '/api/game/example-game/round/input' && body.defer_response === true) {
      markDelayedCommandStarted();
      await delayedCommandGate;
    }
    if (/\/api\/game\/[^/]+\/end$/.test(pathName)) {
      // FastAPI and common proxies answer a rejected close with a non-2xx
      // `{"detail": ...}` body: it parses fine and carries no `ok`.
      if (body.force_end_http_error === true) {
        return jsonResponse({ detail: 'route is not closable' }, 409);
      }
      return jsonResponse(RAW_END_RESPONSE);
    }
    if (pathName.endsWith('/route/start')) {
      return jsonResponse({
        ok: true,
        state: {
          game_route_active: true,
          session_id: 'server-session',
          lanlan_name: 'Server Neko',
        },
      });
    }
    if (pathName.endsWith('/route/heartbeat') && forceHeartbeatInactive) {
      return jsonResponse({
        ok: true,
        active: false,
        state: { game_route_active: false },
      });
    }
    if (pathName.endsWith('/route/drain')) {
      if (forceDrainInactive) {
        return jsonResponse({
          ok: true,
          active: false,
          state: { game_route_active: false },
          outputs: [],
        });
      }
      const responseData = {
        ok: true,
        outputs: [{
          ts: 123,
          result: { control: { stance: 'ready' } },
        }],
      };
      if (body.delay_control_parse === true) {
        return {
          ok: true,
          status: 200,
          async json() { return responseData; },
          clone() {
            return {
              async json() {
                markDelayedDrainStarted();
                await delayedDrainGate;
                return responseData;
              },
            };
          },
        };
      }
      return jsonResponse(responseData);
    }
    if (pathName.endsWith('/speak')) {
      return jsonResponse({
        ok: true,
        speech_id: String(body.request_id || 'speech-response'),
        turn_end_emitted: body.emit_turn_end !== false,
      });
    }
    return jsonResponse({ ok: true, accepted: true });
  };
  const windowMock = {
    AbortController,
    i18next: { language: 'zh_Hant-TW' },
    __nekoI18nLanguage: 'pt_BR',
    NEKO_I18N_LANGUAGE: 'ko-KR',
    console: { warn() {}, error() {}, log() {} },
    fetch: fetchImpl,
    navigator: {
      sendBeacon: () => false,
      locks: { request: async (_name, _options, callback) => callback() },
    },
    location: { origin: 'http://127.0.0.1:48911' },
    localStorage: storage(),
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
      if (!listeners.get(type)?.size) listeners.delete(type);
    },
    dispatchEvent(event) {
      for (const handler of Array.from(listeners.get(event.type) || [])) handler(event);
    },
    CustomEvent: class CustomEventMock {
      constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
    },
    crypto: {
      getRandomValues(values) {
        values.fill(7);
        return values;
      },
    },
  };
  const defaultCapabilities = [
    'runtime', 'dialogue', 'logging', 'voice-input', 'speech-output',
    'context-read', 'memory', 'window-control', 'storage', 'leaderboard-local', 'quick-lines',
  ];
  const hostLaunchRegistrations = Object.fromEntries(
    [...[
      'example-game',
      'waiting-lock-game',
      'third-party-game',
      'speech-only-game',
      'no-lock-game',
      'logger-one',
      'logger-two',
      'log-timeout-game',
      'drawing-guess',
      'invalid-alias-game',
      'invalid-command-game',
    ], ...Array.from({ length: 70 }, (_unused, index) => `overflow-game-${index}`)]
      .map((gameId) => [gameId, {
      mode: gameId === 'example-game' ? 'registered' : 'development',
      gameId,
      ...(gameId === 'drawing-guess' ? { routeGameType: 'drawing_guess' } : {}),
      ...(gameId === 'invalid-alias-game' ? { routeGameType: '../invalid' } : {}),
      ...(gameId === 'example-game' ? {
        commandRoutes: {
          'round:input': {
            path: 'round/input',
            maxRequestBytes: 2 * 1024 * 1024,
            maxTimeoutMs: 330000,
          },
        },
      } : {}),
      ...(gameId === 'invalid-command-game' ? {
        commandRoutes: {
          'round:escape': {
            path: '../escape',
            maxRequestBytes: 1024,
            maxTimeoutMs: 1000,
          },
        },
      } : {}),
      publisherId: 'test-host',
      version: '1.0.0',
      allowedCapabilities: defaultCapabilities,
      capabilityProviders: gameId === 'example-game' ? {
        quickLines: async () => jsonResponse({ ok: true, lines: ['ready'] }),
      } : {},
    }]),
  );
  const launchNode = {
    textContent: JSON.stringify({ registrations: hostLaunchRegistrations }),
    nekoCapabilityProviders: {
      'example-game': {
        quickLines: async () => jsonResponse({ ok: true, lines: ['ready'] }),
      },
    },
    remove() { this.removed = true; },
  };
  let adapterScript = null;
  let launchBindingWasImmutable = false;
  windowMock.document = {
    currentScript: null,
    documentElement: { lang: 'es-MX' },
    getElementById(id) { return id === 'neko-minigame-host-launch' ? launchNode : null; },
    createElement() {
      return { remove() { this.removed = true; } };
    },
    head: {
      appendChild(script) {
        adapterScript = script;
        const descriptor = Object.getOwnPropertyDescriptor(script, 'nekoHostLaunchRegistry');
        try {
          Object.defineProperty(script, 'nekoHostLaunchRegistry', {
            value: { forged: true },
          });
        } catch (_) {
          launchBindingWasImmutable = descriptor?.configurable === false
            && descriptor?.writable === false;
        }
        windowMock.document.currentScript = script;
        try {
          vm.runInThisContext(fs.readFileSync(sourcePath, 'utf8'), { filename: sourcePath });
        } finally {
          windowMock.document.currentScript = null;
        }
        script.onload?.();
      },
    },
  };
  windowMock.localStorage.setItem('neko_i18n_language', 'ru-RU');
  global.window = windowMock;

  const bootstrapPath = path.resolve(
    __dirname,
    '../../static/game/sdk/neko-minigame-same-origin-bootstrap.js',
  );
  vm.runInThisContext(fs.readFileSync(bootstrapPath, 'utf8'), { filename: bootstrapPath });
  await windowMock.nekoMiniGameSameOriginHostReady;
  assert(launchNode.removed === true, 'trusted launch node was not consumed before game code');
  assert(launchBindingWasImmutable === true && adapterScript?.removed === true,
    'adapter launch binding was mutable or its script node remained resident after consumption');
  assert(windowMock.bootstrapNekoMiniGameSameOriginHost === undefined,
    'game code received a public registration producer');
  const trustedFactory = windowMock.createNekoMiniGameSameOriginHost;
  const factoryDescriptor = Object.getOwnPropertyDescriptor(
    windowMock,
    'createNekoMiniGameSameOriginHost',
  );
  assert(factoryDescriptor?.configurable === false && factoryDescriptor?.writable === false,
    'trusted host factory remained replaceable after adapter bootstrap');
  windowMock.document.currentScript = {
    nekoHostLaunchRegistry: {
      'forged-game': {
        mode: 'registered',
        gameId: 'forged-game',
        version: '1.0.0',
        allowedCapabilities: defaultCapabilities,
      },
    },
  };
  vm.runInThisContext(fs.readFileSync(sourcePath, 'utf8'), { filename: sourcePath });
  windowMock.document.currentScript = null;
  assert(windowMock.createNekoMiniGameSameOriginHost === trustedFactory,
    'a later game-loaded adapter replaced the trusted host factory');

  const createHost = (options = {}) => window.createNekoMiniGameSameOriginHost(options);
  let missingRegistrationError = null;
  try {
    window.createNekoMiniGameSameOriginHost({
      gameType: 'forged-game',
      fetchImpl,
      windowImpl: windowMock,
      navigatorImpl: windowMock.navigator,
    });
  } catch (error) { missingRegistrationError = error; }
  assert(missingRegistrationError?.code === 'game_unregistered',
    'a game minted a registered host identity without a launch registration');
  let invalidAliasRegistrationError = null;
  try {
    window.createNekoMiniGameSameOriginHost({
      gameType: 'invalid-alias-game',
      fetchImpl,
      windowImpl: windowMock,
      navigatorImpl: windowMock.navigator,
    });
  } catch (error) { invalidAliasRegistrationError = error; }
  assert(invalidAliasRegistrationError?.code === 'game_unregistered',
    'a launch registration with an invalid backend route alias was accepted');
  let invalidCommandRegistrationError = null;
  try {
    window.createNekoMiniGameSameOriginHost({
      gameType: 'invalid-command-game',
      fetchImpl,
      windowImpl: windowMock,
      navigatorImpl: windowMock.navigator,
    });
  } catch (error) { invalidCommandRegistrationError = error; }
  assert(invalidCommandRegistrationError?.code === 'game_unregistered',
    'a launch registration with a traversing command route was accepted');
  let overflowRegistrationError = null;
  try {
    window.createNekoMiniGameSameOriginHost({
      gameType: 'overflow-game-69',
      fetchImpl,
      windowImpl: windowMock,
      navigatorImpl: windowMock.navigator,
    });
  } catch (error) { overflowRegistrationError = error; }
  assert(overflowRegistrationError?.code === 'game_unregistered',
    'the host launch registry exceeded its page-lifetime capacity bound');

  const host = createHost({
    gameType: 'example-game',
    sessionId: 'client-session',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
    capabilityProviders: {
      quickLines: async () => jsonResponse({ ok: true, lines: ['forged'] }),
    },
  });
  const handshake = host.connectGame({
    protocolVersions: ['1'],
    manifest: {
      id: 'example-game',
      version: '1.0.0',
      requiredCapabilities: ['runtime', 'logging'],
      optionalCapabilities: [
        'dialogue', 'quick-lines', 'context-read', 'memory', 'window-control', 'storage',
        'leaderboard-local', 'speech-output', 'voice-input',
      ],
      contracts: {
        commands: {
          'round:input': {
            request: { type: 'object' },
            response: { type: 'object' },
          },
        },
      },
    },
  });
  assert(Object.isFrozen(handshake.locale)
    && handshake.locale.language === 'zh-TW'
    && handshake.locale.revision === 1,
  'same-origin host did not normalize and freeze the trusted initial locale');
  const hostLocaleEvents = [];
  const unsubscribeHostLocale = host.subscribeHostLocale((value) => hostLocaleEvents.push(value));
  assert(hostLocaleEvents.length === 1
    && hostLocaleEvents[0].language === handshake.locale.language
    && hostLocaleEvents[0].revision === handshake.locale.revision,
    'host locale subscription did not start from the negotiated snapshot');
  windowMock.dispatchEvent(new windowMock.CustomEvent('localechange', {
    detail: { language: 'ru', revision: 999 },
  }));
  assert(hostLocaleEvents.length === 1 && hostLocaleEvents[0].language === 'zh-TW',
    'host locale trusted localechange event.detail instead of reading host state');
  windowMock.i18next.language = 'ja_JP';
  windowMock.dispatchEvent(new windowMock.CustomEvent('localechange', {
    detail: { language: 'ru' },
  }));
  assert(hostLocaleEvents.length === 2
    && hostLocaleEvents.at(-1).language === 'ja'
    && hostLocaleEvents.at(-1).revision === 2
    && Object.isFrozen(hostLocaleEvents.at(-1)),
  'a late i18next locale was not normalized into a frozen monotonic update');
  windowMock.dispatchEvent(new windowMock.CustomEvent('localechange'));
  assert(hostLocaleEvents.length === 2, 'an unchanged host locale emitted a duplicate update');
  windowMock.i18next.language = 'unsupported';
  windowMock.dispatchEvent(new windowMock.CustomEvent('localechange'));
  assert(hostLocaleEvents.at(-1).language === 'pt',
    'the host did not fall back from i18next to __nekoI18nLanguage');
  windowMock.__nekoI18nLanguage = '';
  windowMock.dispatchEvent(new windowMock.CustomEvent('localechange'));
  assert(hostLocaleEvents.at(-1).language === 'ko',
    'the host did not fall back to NEKO_I18N_LANGUAGE');
  windowMock.NEKO_I18N_LANGUAGE = '';
  windowMock.dispatchEvent(new windowMock.CustomEvent('localechange'));
  assert(hostLocaleEvents.at(-1).language === 'es',
    'the host did not fall back to document.documentElement.lang');
  windowMock.document.documentElement.lang = 'unsupported';
  windowMock.dispatchEvent(new windowMock.CustomEvent('localechange'));
  assert(hostLocaleEvents.at(-1).language === 'ru',
    'the host did not fall back to its persisted locale');
  windowMock.localStorage.removeItem('neko_i18n_language');
  windowMock.dispatchEvent(new windowMock.CustomEvent('localechange'));
  assert(hostLocaleEvents.at(-1).language === 'en',
    'the host did not use the bounded English fallback when every locale source was invalid');
  windowMock.i18next.language = 'zh-CN';
  windowMock.dispatchEvent(new windowMock.CustomEvent('localechange'));
  assert(hostLocaleEvents.at(-1).language === 'zh-CN'
    && hostLocaleEvents.at(-1).revision === 8,
  'host locale revisions were not monotonic across trusted source changes');
  unsubscribeHostLocale();
  const boundedHostLocaleListeners = Array.from(
    { length: 32 },
    () => host.subscribeHostLocale(() => {}),
  );
  let hostLocaleListenerLimitError = null;
  try { host.subscribeHostLocale(() => {}); }
  catch (error) { hostLocaleListenerLimitError = error; }
  assert(hostLocaleListenerLimitError?.code === 'busy',
    'same-origin host locale listener growth was not bounded');
  boundedHostLocaleListeners.forEach((unsubscribe) => unsubscribe());
  assert(handshake.grantedCapabilities.includes('context-read'),
    'same-origin host did not grant its context adapter');
  assert(handshake.grantedCapabilities.includes('memory'),
    'same-origin host did not grant its memory adapter');
  assert(handshake.grantedCapabilities.includes('quick-lines'),
    'host-provided quick-lines were not granted');
  assert(handshake.grantedCapabilities.includes('storage')
    && handshake.grantedCapabilities.includes('leaderboard-local'),
  'cross-window-safe local leaderboard capability was not granted');
  assert(!handshake.grantedCapabilities.includes('window-control'),
    'window-control was granted without a host API captured before game code');
  let unavailableWindowCloseError = null;
  try { await host.requestWindowClose(); }
  catch (error) { unavailableWindowCloseError = error; }
  assert(unavailableWindowCloseError?.code === 'capability_denied',
    'a normal browser host served window control without a trusted provider');
  assert(host.routeGameType === 'example-game',
    'a registration without routeGameType did not default to its public game id');
  assert(host.commandRoutes === undefined && host._launchRegistration.commandRoutes === undefined,
    'trusted command route policies were exposed on the game transport');

  const noCommandHost = createHost({
    gameType: 'third-party-game',
    sessionId: 'no-command-session',
    commandRoutes: {
      'round:missing': { path: 'attacker/owned' },
    },
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
  });
  const noCommandHandshake = noCommandHost.connectGame({
    protocolVersions: ['1'],
    manifest: {
      id: 'third-party-game',
      version: '1.0.0',
      requiredCapabilities: ['runtime', 'logging'],
      contracts: {
        commands: {
          'round:missing': {
            request: { type: 'object' },
            response: { type: 'object' },
          },
        },
      },
    },
  });
  assert(noCommandHandshake.accepted === false
    && noCommandHandshake.code === 'capability_unavailable',
  'a manifest command without a trusted route mapping passed the handshake');
  noCommandHost.dispose();

  const aliasedRouteHost = createHost({
    gameType: 'drawing-guess',
    routeGameType: 'forged-game',
    sessionId: 'drawing-session',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
  });
  const aliasedHandshake = aliasedRouteHost.connectGame({
    protocolVersions: ['1'],
    manifest: {
      id: 'drawing-guess',
      version: '1.0.0',
      requiredCapabilities: ['runtime', 'logging'],
      optionalCapabilities: ['voice-input'],
    },
  });
  assert(aliasedHandshake.accepted === true
    && aliasedHandshake.registration.gameId === 'drawing-guess',
  'the public SDK identity did not remain canonical across the route alias');
  const routeAliasDescriptor = Object.getOwnPropertyDescriptor(aliasedRouteHost, 'routeGameType');
  const routeAliasMutated = Reflect.set(aliasedRouteHost, 'routeGameType', 'forged-game');
  assert(routeAliasDescriptor?.writable === false
    && routeAliasDescriptor?.configurable === false
    && routeAliasMutated === false
    && aliasedRouteHost.routeGameType === 'drawing_guess',
  'game code could mutate the host-owned backend route alias');
  await aliasedRouteHost.start({ lanlan_name: 'Alias Neko', game_type: 'forged-game' });
  const aliasedStart = calls.filter(
    (call) => call.url === '/api/game/drawing_guess/route/start',
  ).at(-1);
  assert(aliasedStart?.body?.session_id === 'drawing-session'
    && aliasedStart.body.game_type === 'drawing_guess',
  'the trusted host did not own the registered legacy route identity');
  await aliasedRouteHost.heartbeat({ game_type: 'forged-game' });
  await aliasedRouteHost.drain({ game_type: 'forged-game' });
  const aliasedHeartbeat = calls.filter(
    (call) => call.url === '/api/game/drawing_guess/route/heartbeat',
  ).at(-1);
  const aliasedDrain = calls.filter(
    (call) => call.url === '/api/game/drawing_guess/route/drain',
  ).at(-1);
  assert(aliasedHeartbeat?.body?.game_type === 'drawing_guess'
    && aliasedDrain?.body?.game_type === 'drawing_guess',
  'heartbeat or drain escaped the registered backend route alias');

  let aliasedLogPayload = null;
  aliasedRouteHost.configureLogger({ captureGlobalErrors: false });
  aliasedRouteHost._logger.enabled = true;
  aliasedRouteHost._recordOrSendLogPayload = (payload) => { aliasedLogPayload = payload; };
  aliasedRouteHost.log('info', 'runtime', 'alias_probe', 'alias probe');
  assert(aliasedLogPayload?.game_type === 'drawing_guess',
    'logging escaped the registered backend route alias');

  let aliasedVoiceRequest = null;
  const aliasedVoiceController = (event) => {
    if (event?.detail?.type !== 'game_voice_control_request') return;
    aliasedVoiceRequest = event.detail;
    windowMock.dispatchEvent(new windowMock.CustomEvent('neko-game-voice-control-message', {
      detail: {
        type: 'game_voice_control_state',
        game_type: 'drawing_guess',
        session_id: 'drawing-session',
        request_id: event.detail.request_id,
        ok: true,
        reason: 'alias-probe',
      },
    }));
  };
  windowMock.addEventListener('neko-game-voice-control-message', aliasedVoiceController);
  aliasedRouteHost.startVoiceControlBridge({ BroadcastChannelImpl: null, onState() {} });
  for (const action of ['query', 'start', 'stop', 'toggle']) {
    const aliasedVoiceResponse = await aliasedRouteHost.requestVoiceControl(action, {
      timeoutMs: 500,
      handoffIntentEpoch: 17,
    });
    assert(aliasedVoiceRequest?.action === action
      && aliasedVoiceRequest.game_type === 'drawing_guess'
      && !Object.hasOwn(aliasedVoiceRequest, 'ordinary_voice_intent_epoch')
      && aliasedVoiceResponse.reason === 'alias-probe',
    `voice ${action} leaked the handoff-only intent fence or escaped the route alias`);
  }
  const aliasedHandoffResponse = await aliasedRouteHost.requestVoiceControl('handoff', {
    timeoutMs: 500,
    handoffIntentEpoch: 17,
  });
  assert(aliasedVoiceRequest?.action === 'handoff'
    && aliasedVoiceRequest.game_type === 'drawing_guess'
    && aliasedVoiceRequest.ordinary_voice_intent_epoch === 17
    && aliasedHandoffResponse.reason === 'alias-probe',
  'the trusted host rejected or rewrote the voice handoff action/intent fence');
  aliasedRouteHost.stopVoiceControlBridge();
  windowMock.removeEventListener('neko-game-voice-control-message', aliasedVoiceController);

  await aliasedRouteHost.end({ game_type: 'forged-game' });
  const aliasedEnd = calls.filter(
    (call) => call.url === '/api/game/drawing_guess/end',
  ).at(-1);
  assert(aliasedEnd?.body?.game_type === 'drawing_guess',
    'route end escaped the registered backend route alias');
  aliasedRouteHost.dispose();

  let storageLockEntered = false;
  await host.runGameStorageExclusive('leaderboards/main', async () => {
    storageLockEntered = true;
  });
  assert(storageLockEntered, 'trusted host did not enter its origin-wide storage lock');

  let initialSpeechError = null;
  windowMock.localStorage.setItem('neko_speech_playback_state', JSON.stringify({
    type: 'speech_playback_state',
    active: true,
    speech_id: 'initial-speech',
  }));
  host.startSpeechOutputBridge({
    onState() { throw new Error('consumer failed'); },
    onError(error, source) { initialSpeechError = { error, source }; },
  });
  assert(initialSpeechError?.error?.message === 'consumer failed'
    && initialSpeechError.source === 'local_storage_initial',
  'initial speech state callback failures did not reach the host error bridge');
  host.stopSpeechOutputBridge();

  await host.configureGameMemoryConsent({ enabled: true, session_id: 'client-session' });
  const cancelledDirectRequest = new AbortController();
  cancelledDirectRequest.abort();
  let cancelledStorageError = null;
  try {
    host.requestGameStorage(
      'set',
      { key: 'cancelled-direct', value: true },
      { signal: cancelledDirectRequest.signal },
    );
  } catch (error) { cancelledStorageError = error; }
  const cancelledStorageKey = `${host._gameStoragePrefix()}cancelled-direct`;
  assert(cancelledStorageError?.code === 'cancelled'
    && windowMock.localStorage.getItem(cancelledStorageKey) == null,
  'already-cancelled direct storage request mutated localStorage');
  let cancelledConsentError = null;
  try {
    host.configureGameMemoryConsent(
      { enabled: false, session_id: 'client-session' },
      { signal: cancelledDirectRequest.signal },
    );
  } catch (error) { cancelledConsentError = error; }
  assert(cancelledConsentError?.code === 'cancelled' && host._memoryConsentEnabled === true,
    'already-cancelled direct memory consent request changed host state');
  const startResponse = await host.start({
    session_id: 'attacker-session',
    sdk_route_instance_id: 'route-generation-1',
    lanlan_name: 'Attacker Neko',
    i18n_language: 'ru',
    i18nLanguage: 'ru',
    language: 'ru',
    lang: 'ru',
    locale: 'ru',
    user_language: 'ru',
    currentLanguage: 'ru',
    event: { kind: 'locale-forge', language: 'ru', locale: 'ru' },
    currentState: { marker: 'kept', i18nLanguage: 'ru', lang: 'ru' },
    current_state: { marker: 'also-kept', user_language: 'ru' },
    game_memory_archive_enabled: false,
    legacyGameMemoryEnabled: false,
    legacy_game_memory_event_reply_enabled: false,
  });
  const startData = await startResponse.clone().json();
  host.applyRouteState(startData.state);
  const startCall = calls.find((call) => call.url === '/api/game/example-game/route/start');
  assert(startCall.body.session_id === 'client-session',
    'route start trusted an application-supplied session id');
  assert(startCall.body.game_memory_enabled === true,
    'opening-screen memory consent was not attached to route start');
  assert(startCall.body.game_memory_player_interaction_enabled === true
    && startCall.body.game_memory_event_reply_enabled === true
    && startCall.body.game_memory_archive_enabled === true
    && startCall.body.game_memory_postgame_context_enabled === true,
  'trusted host did not derive the complete memory policy from consent');
  assert(!Object.hasOwn(startCall.body, 'legacyGameMemoryEnabled')
    && !Object.hasOwn(startCall.body, 'legacy_game_memory_event_reply_enabled'),
  'caller-controlled legacy memory aliases survived the trusted host boundary');
  assert(startCall.body.i18n_language === 'zh-CN'
    && !Object.hasOwn(startCall.body, 'i18nLanguage')
    && !Object.hasOwn(startCall.body, 'language')
    && !Object.hasOwn(startCall.body, 'lang')
    && !Object.hasOwn(startCall.body, 'locale')
    && !Object.hasOwn(startCall.body, 'user_language')
    && !Object.hasOwn(startCall.body, 'currentLanguage'),
  'route start trusted caller-controlled locale identity aliases');
  assert(startCall.body.event.kind === 'locale-forge'
    && !Object.hasOwn(startCall.body.event, 'language')
    && !Object.hasOwn(startCall.body.event, 'locale')
    && startCall.body.currentState.marker === 'kept'
    && !Object.hasOwn(startCall.body.currentState, 'i18nLanguage')
    && !Object.hasOwn(startCall.body.currentState, 'lang')
    && startCall.body.current_state.marker === 'also-kept'
    && !Object.hasOwn(startCall.body.current_state, 'user_language'),
  'nested runtime locale aliases crossed the host boundary or ordinary state fields were lost');

  const commandEnvelope = (payload, routeInstanceId = 'route-generation-1') => ({
    protocolVersion: '1',
    sequence: 1,
    type: 'round:input',
    sessionId: 'server-session',
    routeInstanceId,
    payload,
  });
  const validCommandResponse = await host.executeGameCommand(
    'round:input',
    commandEnvelope({
      text: 'hello',
      session_id: 'attacker-session',
      sessionId: 'attacker-session',
      game_type: 'attacker-game',
      gameType: 'attacker-game',
      lanlan_name: 'Attacker Neko',
      lanlanName: 'Attacker Neko',
      character_name: 'Attacker Neko',
      characterName: 'Attacker Neko',
      window_lanlan_name: 'Attacker Neko',
      windowLanlanName: 'Attacker Neko',
      sdk_route_instance_id: 'attacker-generation',
      sdkRouteInstanceId: 'attacker-generation',
      sdk_route_instance_ids: ['attacker-generation'],
      routeInstanceId: 'attacker-generation',
      i18n_language: 'ru',
      i18nLanguage: 'ru',
      language: 'ru',
      locale: 'ru',
      event: { marker: 'kept', lang: 'ru' },
      currentState: { marker: 'kept', current_language: 'ru' },
    }),
    { timeoutMs: 310000 },
  );
  assert((await validCommandResponse.json()).accepted === true,
    'a declared command did not receive its endpoint response');
  const validCommandCall = calls.filter(
    (call) => call.url === '/api/game/example-game/round/input',
  ).at(-1);
  assert(validCommandCall?.body?.text === 'hello'
    && validCommandCall.body.session_id === 'server-session'
    && validCommandCall.body.game_type === 'example-game'
    && validCommandCall.body.lanlan_name === 'Server Neko'
    && validCommandCall.body.sdk_route_instance_id === 'route-generation-1'
    && validCommandCall.body.i18n_language === 'zh-CN'
    && validCommandCall.body._csrf_token === 'test-token'
    && validCommandCall.init.headers['X-CSRF-Token'] === 'test-token',
  'the command route, CSRF contract, or trusted runtime identity was not host-owned');
  assert(!Object.hasOwn(validCommandCall.body, 'sessionId')
    && !Object.hasOwn(validCommandCall.body, 'gameType')
    && !Object.hasOwn(validCommandCall.body, 'lanlanName')
    && !Object.hasOwn(validCommandCall.body, 'character_name')
    && !Object.hasOwn(validCommandCall.body, 'characterName')
    && !Object.hasOwn(validCommandCall.body, 'window_lanlan_name')
    && !Object.hasOwn(validCommandCall.body, 'windowLanlanName')
    && !Object.hasOwn(validCommandCall.body, 'sdkRouteInstanceId')
    && !Object.hasOwn(validCommandCall.body, 'sdk_route_instance_ids')
    && !Object.hasOwn(validCommandCall.body, 'routeInstanceId'),
  'caller-controlled command identity aliases crossed the host boundary');
  assert(!Object.hasOwn(validCommandCall.body, 'i18nLanguage')
    && !Object.hasOwn(validCommandCall.body, 'language')
    && !Object.hasOwn(validCommandCall.body, 'locale')
    && validCommandCall.body.event.marker === 'kept'
    && !Object.hasOwn(validCommandCall.body.event, 'lang')
    && validCommandCall.body.currentState.marker === 'kept'
    && !Object.hasOwn(validCommandCall.body.currentState, 'current_language'),
  'a command forged its locale identity or lost non-locale nested fields');

  const wideCommandCallsBefore = calls.filter(
    (call) => call.url === '/api/game/example-game/round/input',
  ).length;
  await host.executeGameCommand(
    'round:input',
    commandEnvelope({ image_data_url: `data:image/png;base64,${'a'.repeat(300 * 1024)}` }),
  );
  assert(calls.filter(
    (call) => call.url === '/api/game/example-game/round/input',
  ).length === wideCommandCallsBefore + 1,
  'the independent command payload budget did not admit a payload above 256 KiB');

  const commandCallsBeforeRejectedPayloads = calls.filter(
    (call) => call.url === '/api/game/example-game/round/input',
  ).length;
  let oversizedCommandError = null;
  try {
    await host.executeGameCommand(
      'round:input',
      commandEnvelope({ image_data_url: 'a'.repeat((2 * 1024 * 1024) + 1) }),
    );
  } catch (error) { oversizedCommandError = error; }
  assert(oversizedCommandError?.code === 'invalid_payload'
    && calls.filter(
      (call) => call.url === '/api/game/example-game/round/input',
    ).length === commandCallsBeforeRejectedPayloads,
  'a command above its host-owned request policy reached the backend');

  let forgedGenerationError = null;
  try {
    await host.executeGameCommand(
      'round:input',
      commandEnvelope({ text: 'forged generation' }, 'attacker-generation'),
    );
  } catch (error) { forgedGenerationError = error; }
  assert(forgedGenerationError?.code === 'session_invalid'
    && calls.filter(
      (call) => call.url === '/api/game/example-game/round/input',
    ).length === commandCallsBeforeRejectedPayloads,
  'a directly forged command generation crossed the transport boundary');

  let undeclaredCommandError = null;
  try {
    await host.executeGameCommand('round:undeclared', {
      ...commandEnvelope({ text: 'undeclared' }),
      type: 'round:undeclared',
    });
  } catch (error) { undeclaredCommandError = error; }
  assert(undeclaredCommandError?.code === 'capability_denied',
    'a command outside the manifest and host route intersection was accepted');

  const delayedCommand = host.executeGameCommand(
    'round:input',
    commandEnvelope({ defer_response: true }),
  );
  await delayedCommandStarted;
  host.applyRouteState({ session_id: 'replacement-session' });
  releaseDelayedCommand();
  let retiredCommandResponseError = null;
  try { await delayedCommand; } catch (error) { retiredCommandResponseError = error; }
  assert(retiredCommandResponseError?.code === 'session_invalid',
    'a command response was accepted after its runtime identity retired');
  const restartedResponse = await host.start({
    sdk_route_instance_id: 'route-generation-2',
  });
  host.applyRouteState((await restartedResponse.clone().json()).state);
  const ungrantedHost = createHost({
    gameType: 'third-party-game',
    sessionId: 'ungranted-session',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
  });
  const ungrantedHandshake = ungrantedHost.connectGame({
    protocolVersions: ['1'],
    manifest: {
      id: 'third-party-game',
      version: '1.0.0',
      requiredCapabilities: ['runtime'],
      optionalCapabilities: [],
    },
  });
  assert(!ungrantedHandshake.grantedCapabilities.includes('voice-input'),
    'an unrequested voice capability was granted');
  const callsBeforeDeniedCapabilities = calls.length;
  const deniedCapabilityOperations = [
    () => ungrantedHost.readGameContext({ scopes: ['character-public'] }),
    () => ungrantedHost.configureGameMemoryConsent({ enabled: true }),
    () => ungrantedHost.requestGameStorage('set', { key: 'denied', value: true }),
    () => ungrantedHost.requestDialogue({ event: { kind: 'denied' } }),
    () => ungrantedHost.getQuickLines({ event: { kind: 'denied' } }),
    () => ungrantedHost.speak({ line: 'denied' }),
    () => ungrantedHost.submitVoiceTranscript({ transcript: 'denied' }),
    () => ungrantedHost.mountAvatar({}),
    () => ungrantedHost.getAvatarCharacter(''),
    () => ungrantedHost.listAvatarCharacters(),
    () => ungrantedHost.mountAudio({}),
    () => ungrantedHost.postLog({ event: 'denied' }),
  ];
  for (const invoke of deniedCapabilityOperations) {
    let deniedError = null;
    try { await invoke(); } catch (error) { deniedError = error; }
    assert(deniedError?.code === 'capability_denied',
      'direct host transport bypassed a negotiated capability');
  }
  assert(calls.length === callsBeforeDeniedCapabilities
    && windowMock.localStorage.getItem(`${ungrantedHost._gameStoragePrefix()}denied`) == null,
  'a denied direct host operation produced a fetch or storage side effect');
  await ungrantedHost.start({
    gameMemoryEnabled: true,
    game_archive_memory_enabled: true,
    legacy_game_memory_enabled: true,
    legacyGameMemoryArchiveEnabled: true,
    event: {
      kind: 'nested-memory-bypass',
      game_memory_enabled: true,
      legacyGameMemoryArchiveEnabled: true,
      legacy_game_memory_event_reply_enabled: true,
    },
  });
  const ungrantedStart = calls.filter((call) => call.url.endsWith('/route/start')).at(-1);
  assert(ungrantedStart.body.game_memory_enabled === false
    && ungrantedStart.body.game_memory_player_interaction_enabled === false
    && ungrantedStart.body.game_memory_event_reply_enabled === false
    && ungrantedStart.body.game_memory_archive_enabled === false
    && ungrantedStart.body.game_memory_postgame_context_enabled === false,
  'a game without memory grant overrode the host-owned memory policy');
  assert(!Object.hasOwn(ungrantedStart.body, 'gameMemoryEnabled')
    && !Object.hasOwn(ungrantedStart.body, 'game_archive_memory_enabled')
    && !Object.hasOwn(ungrantedStart.body, 'legacy_game_memory_enabled')
    && !Object.hasOwn(ungrantedStart.body, 'legacyGameMemoryArchiveEnabled'),
  'ungranted legacy memory aliases were forwarded to the backend');
  assert(ungrantedStart.body.event.kind === 'nested-memory-bypass'
    && !Object.hasOwn(ungrantedStart.body.event, 'game_memory_enabled')
    && !Object.hasOwn(ungrantedStart.body.event, 'legacyGameMemoryArchiveEnabled')
    && !Object.hasOwn(ungrantedStart.body.event, 'legacy_game_memory_event_reply_enabled'),
  'nested legacy memory aliases bypassed the host-owned memory policy');
  await ungrantedHost.heartbeat({
    game_memory_enabled: true,
    legacy_game_memory_archive_enabled: true,
  });
  const ungrantedHeartbeat = calls.filter((call) => call.url.endsWith('/route/heartbeat')).at(-1);
  assert(ungrantedHeartbeat.body.game_memory_enabled === false
    && ungrantedHeartbeat.body.game_memory_archive_enabled === false
    && !Object.hasOwn(ungrantedHeartbeat.body, 'legacy_game_memory_archive_enabled'),
  'a heartbeat bypassed the host-owned memory opt-out policy');
  let eventToJsonCalls = 0;
  await ungrantedHost.heartbeat({
    event: {
      kind: 'serialization-hook-bypass',
      toJSON() {
        eventToJsonCalls += 1;
        return { kind: 'forged', game_memory_enabled: true };
      },
    },
  });
  const safeSerializationHeartbeat = calls.filter(
    (call) => call.url.endsWith('/route/heartbeat'),
  ).at(-1);
  assert(eventToJsonCalls === 0
    && safeSerializationHeartbeat.body.event.kind === 'serialization-hook-bypass'
    && !Object.hasOwn(safeSerializationHeartbeat.body.event, 'toJSON')
    && !Object.hasOwn(safeSerializationHeartbeat.body.event, 'game_memory_enabled'),
  'an event serialization hook reintroduced caller-controlled memory policy');
  const heartbeatCallsBeforeWidePayload = calls.filter(
    (call) => call.url.endsWith('/route/heartbeat'),
  ).length;
  let widePayloadError = null;
  try {
    await ungrantedHost.heartbeat({
      event: Object.fromEntries(
        Array.from({ length: 4100 }, (_, index) => [`field_${index}`, index]),
      ),
    });
  } catch (error) {
    widePayloadError = error;
  }
  assert(widePayloadError?.code === 'invalid_payload'
    && calls.filter(
      (call) => call.url.endsWith('/route/heartbeat'),
    ).length === heartbeatCallsBeforeWidePayload,
  'a payload wider than the trusted clone bound reached the backend');
  // Depth and node counts measure structure only -- a string is one node
  // however many bytes it holds, and keys were not measured at all -- so the
  // runtime lifecycle payload had no byte bound anywhere. Every other SDK
  // egress path is capped at 256 KiB; this one shipped whatever
  // configure({payload}) returned, at the heartbeat and drain cadence.
  const heartbeatCallsBeforeHeavyPayload = calls.filter(
    (call) => call.url.endsWith('/route/heartbeat'),
  ).length;
  let heavyPayloadError = null;
  try { await ungrantedHost.heartbeat({ replay: 'x'.repeat(300 * 1024) }); }
  catch (error) { heavyPayloadError = error; }
  assert(heavyPayloadError?.code === 'invalid_payload'
    && calls.filter(
      (call) => call.url.endsWith('/route/heartbeat'),
    ).length === heartbeatCallsBeforeHeavyPayload,
  'a multi-hundred-KiB runtime payload reached the backend unbounded');
  let heavyKeyError = null;
  try {
    await ungrantedHost.heartbeat({
      [`k${'y'.repeat(300 * 1024)}`]: 1,
    });
  } catch (error) { heavyKeyError = error; }
  assert(heavyKeyError?.code === 'invalid_payload',
    'payload bytes hidden in a key bypassed the trusted payload budget');
  // The bound is the SDK's own 256 KiB, so it can never reject a payload the
  // SDK has already accepted.
  const heartbeatCallsBeforeAdmittedPayload = calls.filter(
    (call) => call.url.endsWith('/route/heartbeat'),
  ).length;
  await ungrantedHost.heartbeat({ replay: 'x'.repeat(200 * 1024) });
  assert(calls.filter(
    (call) => call.url.endsWith('/route/heartbeat'),
  ).length === heartbeatCallsBeforeAdmittedPayload + 1,
  'a payload within the shared 256 KiB budget was rejected by the host');
  ungrantedHost.dispose();

  const speechOnlyHost = createHost({
    gameType: 'speech-only-game',
    sessionId: 'speech-only-session',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
  });
  const speechOnlyHandshake = speechOnlyHost.connectGame({
    protocolVersions: ['1'],
    manifest: {
      id: 'speech-only-game',
      version: '1.0.0',
      requiredCapabilities: ['runtime', 'logging', 'speech-output'],
      optionalCapabilities: [],
    },
  });
  assert(speechOnlyHandshake.grantedCapabilities.includes('speech-output')
    && !speechOnlyHandshake.grantedCapabilities.includes('dialogue'),
  'speech-only fixture unexpectedly received dialogue');
  await speechOnlyHost.mirrorSpeechOutput({ line: 'speech-only mirror' });
  const speechOnlyMirror = calls.filter((call) => call.url.endsWith('/mirror-assistant')).at(-1);
  assert(speechOnlyMirror.body.line === 'speech-only mirror',
    'speech-output mirroring was incorrectly gated by dialogue');
  speechOnlyHost.dispose();

  const disconnectedHost = createHost({
    gameType: 'third-party-game',
    sessionId: 'disconnected-session',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
  });
  const callsBeforeDisconnectedStart = calls.length;
  let disconnectedStartError = null;
  try { await disconnectedHost.start({}); }
  catch (error) { disconnectedStartError = error; }
  assert(disconnectedStartError?.code === 'capability_denied'
    && calls.length === callsBeforeDisconnectedStart,
  'a host operation was usable before capability negotiation');
  disconnectedHost.dispose();
  assert(host.sessionId === 'server-session' && host.routeLanlanName === 'Server Neko',
    'authoritative route identity did not replace the provisional host identity');
  assert(typeof host.evaluatePassiveGuard === 'undefined',
    'the game-specific PassiveGuard leaked into the public same-origin host');
  const quickLinesResponse = await host.getQuickLines({ event: { kind: 'prepare' } });
  assert((await quickLinesResponse.json()).lines[0] === 'ready',
    'quick-lines did not use the host-owned provider');
  const endCallsBeforeInvalidPayload = calls.filter(
    (call) => call.url.endsWith('/end'),
  ).length;
  let invalidEndError = null;
  try { await host.end('{not-json'); } catch (error) { invalidEndError = error; }
  assert(invalidEndError?.code === 'invalid_payload'
    && calls.filter((call) => call.url.endsWith('/end')).length === endCallsBeforeInvalidPayload,
  'an invalid string end payload reached the backend');
  await host.end(JSON.stringify({
    session_id: 'forged-session',
    lanlan_name: 'Forged Neko',
    game_memory_enabled: false,
  }));
  const trustedStringEnd = calls.filter((call) => call.url.endsWith('/end')).at(-1);
  assert(trustedStringEnd.body.session_id === 'server-session'
    && trustedStringEnd.body.lanlan_name === 'Server Neko'
    && trustedStringEnd.body.game_memory_enabled === true,
  'a JSON string end payload bypassed trusted runtime ownership');

  await host.publishGameProtocol('event', {
    protocolVersion: '1',
    sequence: 1,
    type: 'round-started',
    sessionId: 'attacker-session',
    payload: { round: 1 },
  });
  const protocolCall = calls.find((call) => call.url.endsWith('/protocol'));
  assert(protocolCall.body.session_id === 'server-session',
    'protocol messages did not use the authoritative route session');
  assert(protocolCall.body._csrf_token === 'test-token'
    && protocolCall.init.headers['X-CSRF-Token'] === 'test-token',
  'protocol mutation did not carry the host CSRF contract');

  const protocolTwo = host.publishGameProtocol('event', {
    protocolVersion: '1', sequence: 2, type: 'second', payload: {},
  });
  const protocolThree = host.publishGameProtocol('state', {
    protocolVersion: '1', sequence: 3, type: 'third', payload: {},
  });
  await protocolTwoStarted;
  assert(!calls.some((call) => call.url.endsWith('/protocol') && call.body.sequence === 3),
    'protocol transport allowed a later sequence to overtake an active request');
  releaseProtocolTwo();
  await Promise.all([protocolTwo, protocolThree]);
  assert(calls.filter((call) => call.url.endsWith('/protocol')).map((call) => call.body.sequence).join(',') === '1,2,3',
    'protocol transport did not preserve SDK call order');

  await host.readGameContext({
    session_id: 'attacker-session',
    scopes: ['character-public'],
  });
  await host.submitGameMemory({
    session_id: 'attacker-session',
    submission: { summary: 'visible result' },
  });
  await host.preloadSpeechOutput({
    session_id: 'attacker-session',
    lines: ['预载台词'],
  });
  const contextCall = calls.find((call) => call.url.endsWith('/context/read'));
  const memoryCall = calls.find((call) => call.url.endsWith('/memory/submit'));
  const speechPreloadCall = calls.find((call) => call.url.endsWith('/speech/preload'));
  assert(contextCall.body.session_id === 'server-session',
    'context read did not bind the authoritative route session');
  assert(contextCall.body._csrf_token === 'test-token'
    && contextCall.init.headers['X-CSRF-Token'] === 'test-token',
  'context read did not carry the host CSRF contract');
  assert(memoryCall.body.session_id === 'server-session'
    && memoryCall.body._csrf_token === 'test-token',
  'memory submission did not bind the authoritative session and CSRF token');
  assert(speechPreloadCall.body.session_id === 'server-session'
    && speechPreloadCall.body._csrf_token === 'test-token'
    && speechPreloadCall.init.headers['X-CSRF-Token'] === 'test-token',
  'speech preload did not bind the authoritative session and CSRF token');

  let speechChannel = null;
  class SpeechChannelMock {
    constructor() { speechChannel = this; this.onmessage = null; }
    close() {}
  }
  const playbackStates = [];
  host.startSpeechPlaybackBridge({
    BroadcastChannelImpl: SpeechChannelMock,
    onState: (state, source) => playbackStates.push({ state, source }),
  });
  const sharedPlaybackState = {
    type: 'speech_playback_state',
    active: true,
    speechId: 'dedupe-speech',
    remainingSeconds: 2,
    updatedAt: 1700000000000,
  };
  speechChannel.onmessage({ data: sharedPlaybackState });
  windowMock.dispatchEvent(new windowMock.CustomEvent('neko-speech-playback-state', {
    detail: sharedPlaybackState,
  }));
  windowMock.dispatchEvent({
    type: 'storage',
    key: 'neko_speech_playback_state',
    newValue: JSON.stringify(sharedPlaybackState),
  });
  assert(playbackStates.length === 1,
    'identical speech playback state was delivered once per active transport');
  windowMock.dispatchEvent(new windowMock.CustomEvent('neko-speech-playback-state', {
    detail: { ...sharedPlaybackState, updatedAt: sharedPlaybackState.updatedAt + 1 },
  }));
  assert(playbackStates.length === 2,
    'a newer speech playback state was incorrectly deduplicated');
  host.stopSpeechPlaybackBridge();

  // Route-bound project speech is tapped by the trusted host itself. The game
  // receives neither the raw WebSocket nor audio chunks, and the host must not
  // suppress the primary stream until the route-specific tap says it is ready.
  const speechTapSockets = [];
  class SpeechTapWebSocketMock {
    constructor(url) {
      this.url = String(url);
      this.readyState = 0;
      this.sent = [];
      this.closed = false;
      speechTapSockets.push(this);
    }
    open() {
      this.readyState = 1;
      this.onopen?.({ type: 'open' });
    }
    receive(data) { this.onmessage?.({ data }); }
    send(data) { this.sent.push(data); }
    close(code = 1000, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason;
      this.onclose?.({ code, reason });
    }
  }
  const blobLabels = new WeakMap();
  const deliveredSpeechBlobs = [];
  let releaseFirstSpeechBlob;
  const firstSpeechBlobGate = new Promise((resolve) => { releaseFirstSpeechBlob = resolve; });
  let releaseOldGenerationBlob;
  const oldGenerationBlobGate = new Promise((resolve) => { releaseOldGenerationBlob = resolve; });
  let releaseNewGenerationFirstBlob;
  const newGenerationFirstBlobGate = new Promise((resolve) => {
    releaseNewGenerationFirstBlob = resolve;
  });
  windowMock.appState = {
    interruptedSpeechId: null,
    currentPlayingSpeechId: null,
    pendingDecoderReset: false,
    decoderResetPromise: null,
    incomingAudioEpoch: 0,
    pendingAudioChunkMetaQueue: [],
  };
  windowMock.appAudioPlayback = {
    schedulePendingAudioMetaStallCheck() {},
    async enqueueIncomingAudioBlob(blob) {
      const meta = windowMock.appState.pendingAudioChunkMetaQueue.shift();
      const label = blobLabels.get(blob) || 'unknown';
      deliveredSpeechBlobs.push(`start:${meta?.speechId || 'missing'}:${label}`);
      if (label === 'blob-1') await firstSpeechBlobGate;
      if (label === 'old-generation-blocked') await oldGenerationBlobGate;
      if (label === 'new-generation-first') await newGenerationFirstBlobGate;
      deliveredSpeechBlobs.push(`end:${meta?.speechId || 'missing'}:${label}`);
    },
  };
  const speechTurnEnds = [];
  const speechTurnEndHandler = (event) => speechTurnEnds.push(event.detail);
  windowMock.addEventListener('neko-assistant-turn-end', speechTurnEndHandler);
  const speechTapErrors = [];
  const speechTapHost = createHost({
    gameType: 'drawing-guess',
    sessionId: 'speech-tap-client-session',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
    WebSocketImpl: SpeechTapWebSocketMock,
    speechTapReconnectLimit: 2,
    speechTapReconnectDelayMs: 1,
    speechTapReadyTimeoutMs: 100,
    speechTapRequestReadyTimeoutMs: 100,
    speechTapPingIntervalMs: 100,
  });
  speechTapHost.connectGame({
    protocolVersions: ['1'],
    manifest: {
      id: 'drawing-guess',
      version: '1.0.0',
      requiredCapabilities: ['runtime', 'logging', 'speech-output'],
      optionalCapabilities: [],
    },
  });
  speechTapHost.startSpeechOutputBridge({
    BroadcastChannelImpl: null,
    onState() {},
    onError(error, source) { speechTapErrors.push({ error, source }); },
  });

  await speechTapHost.requestSpeechOutput({
    line: 'opening line',
    request_id: 'pre-route-speech',
    emit_turn_end: true,
  });
  const preRouteSpeechCall = calls.filter((call) => call.url.endsWith('/speak')).at(-1);
  assert(preRouteSpeechCall.body.suppress_primary_audio === false,
    'pre-route speech incorrectly suppressed the primary project stream');

  async function startSpeechTapRoute(routeInstanceId) {
    const response = await speechTapHost.start({
      lanlan_name: 'Requested Neko',
      sdk_route_instance_id: routeInstanceId,
    });
    const data = await response.clone().json();
    speechTapHost.applyRuntimeState(data.state);
    return speechTapSockets.at(-1);
  }
  async function settleSpeechTapMessages() {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  function readySpeechTapSocket(socket) {
    socket.open();
    socket.receive(JSON.stringify({
      type: 'speech_tap_ready',
      ok: true,
      game_type: 'drawing_guess',
      session_id: 'server-session',
    }));
  }

  const firstSpeechTapSocket = await startSpeechTapRoute('speech-generation-A');
  assert(firstSpeechTapSocket.url.startsWith(
    'ws://127.0.0.1:48911/api/game/drawing_guess/speech/ws?',
  ) && firstSpeechTapSocket.url.includes('lanlan_name=Server+Neko')
    && firstSpeechTapSocket.url.includes('session_id=server-session')
    && firstSpeechTapSocket.url.includes('sdk_route_instance_id=speech-generation-A'),
  'speech tap did not bind the trusted route alias, session, character, and generation');

  const speakCallsBeforeReady = calls.filter((call) => call.url.endsWith('/speak')).length;
  const firstRouteSpeech = speechTapHost.requestSpeechOutput({
    line: 'first route line',
    request_id: 'route-speech-A',
    emit_turn_end: true,
    sdk_route_instance_id: 'speech-generation-A',
  });
  await settleSpeechTapMessages();
  assert(calls.filter((call) => call.url.endsWith('/speak')).length === speakCallsBeforeReady,
    'route-bound speech was dispatched before tap_ready');

  const firstBlob = new Blob(['first']);
  const secondBlob = new Blob(['second']);
  blobLabels.set(firstBlob, 'blob-1');
  blobLabels.set(secondBlob, 'blob-2');
  // All four messages intentionally arrive in the same task. The Blob callbacks
  // capture ready=false before messageTail processes the ready frame, so the
  // handler must also consult the then-current ready state.
  readySpeechTapSocket(firstSpeechTapSocket);
  firstSpeechTapSocket.receive(JSON.stringify({
    type: 'audio_chunk', speech_id: 'chunk-A1', turn_id: 'turn-A',
  }));
  firstSpeechTapSocket.receive(firstBlob);
  firstSpeechTapSocket.receive(JSON.stringify({
    type: 'audio_chunk', speech_id: 'chunk-A2', turn_id: 'turn-A',
  }));
  firstSpeechTapSocket.receive(secondBlob);
  await firstRouteSpeech;
  const firstRouteSpeechCall = calls.filter((call) => call.url.endsWith('/speak')).at(-1);
  assert(firstRouteSpeechCall.body.suppress_primary_audio === true,
    'tap-ready route speech did not suppress the duplicate primary stream');
  await settleSpeechTapMessages();
  assert(deliveredSpeechBlobs.join(',') === 'start:chunk-A1:blob-1',
    `speech Blob FIFO advanced before the first sink settled: ${deliveredSpeechBlobs.join(',')}`);
  releaseFirstSpeechBlob();
  await speechTapHost._speechAudioTap.messageTail;
  assert(deliveredSpeechBlobs.join(',') === [
    'start:chunk-A1:blob-1', 'end:chunk-A1:blob-1',
    'start:chunk-A2:blob-2', 'end:chunk-A2:blob-2',
  ].join(','), `speech Blob/header FIFO was reordered: ${deliveredSpeechBlobs.join(',')}`);
  assert(speechTurnEnds.some((event) => event.turnId === 'route-speech-A'
    && event.source === 'minigame_sdk_speech'),
  'the trusted host did not dispatch turn-end for an acknowledged speech response');

  const oldGenerationBlob = new Blob(['old-generation']);
  blobLabels.set(oldGenerationBlob, 'old-generation-blocked');
  firstSpeechTapSocket.receive(JSON.stringify({
    type: 'audio_chunk', speech_id: 'chunk-A-blocked', turn_id: 'turn-A',
  }));
  firstSpeechTapSocket.receive(oldGenerationBlob);
  await settleSpeechTapMessages();
  assert(deliveredSpeechBlobs.at(-1) === 'start:chunk-A-blocked:old-generation-blocked',
    'the old-generation sink gate was not reached before route replacement');

  const staleSocketMessage = firstSpeechTapSocket.onmessage;
  const secondSpeechTapSocket = await startSpeechTapRoute('speech-generation-B');
  assert(firstSpeechTapSocket.closed && secondSpeechTapSocket !== firstSpeechTapSocket,
    'a new route generation did not replace the old speech tap');
  const deliveredBeforeStale = deliveredSpeechBlobs.length;
  staleSocketMessage?.({ data: JSON.stringify({ type: 'audio_chunk', speech_id: 'stale-chunk' }) });
  staleSocketMessage?.({ data: new Blob(['stale']) });
  await settleSpeechTapMessages();
  assert(deliveredSpeechBlobs.length === deliveredBeforeStale,
    'a retired route generation delivered late raw speech data');

  readySpeechTapSocket(secondSpeechTapSocket);
  await settleSpeechTapMessages();
  const newGenerationFirstBlob = new Blob(['new-generation-first']);
  const newGenerationSecondBlob = new Blob(['new-generation-second']);
  blobLabels.set(newGenerationFirstBlob, 'new-generation-first');
  blobLabels.set(newGenerationSecondBlob, 'new-generation-second');
  secondSpeechTapSocket.receive(JSON.stringify({
    type: 'audio_chunk', speech_id: 'chunk-B1', turn_id: 'turn-B',
  }));
  secondSpeechTapSocket.receive(newGenerationFirstBlob);
  secondSpeechTapSocket.receive(JSON.stringify({
    type: 'audio_chunk', speech_id: 'chunk-B2', turn_id: 'turn-B',
  }));
  secondSpeechTapSocket.receive(newGenerationSecondBlob);
  await settleSpeechTapMessages();
  assert(deliveredSpeechBlobs.at(-1) === 'start:chunk-B1:new-generation-first',
    'the new-generation FIFO did not pause at its first sink item');
  releaseOldGenerationBlob();
  await settleSpeechTapMessages();
  assert(!deliveredSpeechBlobs.some((item) => item.includes('new-generation-second')),
    'a retired asynchronous drain consumed data from the replacement generation');
  releaseNewGenerationFirstBlob();
  await speechTapHost._speechAudioTap.messageTail;
  assert(deliveredSpeechBlobs.slice(-3).join(',') === [
    'end:chunk-B1:new-generation-first',
    'start:chunk-B2:new-generation-second',
    'end:chunk-B2:new-generation-second',
  ].join(','), 'the replacement generation did not retain its own Blob FIFO');
  secondSpeechTapSocket.close(1006, 'transient-1');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const reconnectOne = speechTapSockets.at(-1);
  assert(reconnectOne !== secondSpeechTapSocket,
    'speech tap did not perform its first bounded reconnect');
  reconnectOne.close(1006, 'transient-2');
  await new Promise((resolve) => setTimeout(resolve, 10));
  const reconnectTwo = speechTapSockets.at(-1);
  assert(reconnectTwo !== reconnectOne,
    'speech tap did not perform its second bounded reconnect');
  reconnectTwo.close(1006, 'transient-3');
  const socketCountAtReconnectLimit = speechTapSockets.length;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert(speechTapSockets.length === socketCountAtReconnectLimit,
    'speech tap exceeded its per-route reconnect limit');

  const heartbeatSocket = await startSpeechTapRoute('speech-generation-heartbeat');
  readySpeechTapSocket(heartbeatSocket);
  await settleSpeechTapMessages();
  forceHeartbeatInactive = true;
  await speechTapHost.heartbeat({ sdk_route_instance_id: 'speech-generation-heartbeat' });
  forceHeartbeatInactive = false;
  const heartbeatSocketCount = speechTapSockets.length;
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert(heartbeatSocket.closed
    && speechTapHost._activeRouteIdentity === null
    && speechTapSockets.length === heartbeatSocketCount,
  'an inactive heartbeat left the speech tap alive or reconnecting');

  const drainSocket = await startSpeechTapRoute('speech-generation-drain');
  readySpeechTapSocket(drainSocket);
  await settleSpeechTapMessages();
  forceDrainInactive = true;
  await speechTapHost.drain({ sdk_route_instance_id: 'speech-generation-drain' });
  forceDrainInactive = false;
  assert(drainSocket.closed && speechTapHost._activeRouteIdentity === null,
    'an inactive drain response did not retire the speech tap');

  const unavailableSocket = await startSpeechTapRoute('speech-generation-no-sink');
  readySpeechTapSocket(unavailableSocket);
  await settleSpeechTapMessages();
  const savedAudioPlayback = windowMock.appAudioPlayback;
  delete windowMock.appAudioPlayback;
  const speakCallsBeforeMissingSink = calls.filter((call) => call.url.endsWith('/speak')).length;
  let missingTapError = null;
  try {
    await speechTapHost.requestSpeechOutput({
      line: 'must not disappear',
      request_id: 'missing-tap',
      sdk_route_instance_id: 'speech-generation-no-sink',
    });
  } catch (error) { missingTapError = error; }
  windowMock.appAudioPlayback = savedAudioPlayback;
  assert(missingTapError?.code === 'capability_unavailable'
    && calls.filter((call) => call.url.endsWith('/speak')).length === speakCallsBeforeMissingSink,
  'missing route audio tap did not fail stably before suppressing the primary stream');

  const endSocket = await startSpeechTapRoute('speech-generation-end');
  readySpeechTapSocket(endSocket);
  await settleSpeechTapMessages();
  const speakCallsBeforeRejectedEnd = calls.filter((call) => call.url.endsWith('/speak')).length;
  const rejectedTapEnd = await speechTapHost.end({
    sdk_route_instance_id: 'speech-generation-end',
    force_end_http_error: true,
  });
  assert(rejectedTapEnd.ok === false && rejectedTapEnd.status === 409,
    'a rejected route end was not surfaced to the speech host caller');
  assert(!endSocket.closed
    && speechTapHost._activeRouteIdentity?.routeInstanceId === 'speech-generation-end',
  'a rejected route end retired the still-active speech tap');
  await speechTapHost.requestSpeechOutput({
    line: 'the original route is still active',
    request_id: 'speech-after-rejected-end',
    sdk_route_instance_id: 'speech-generation-end',
  });
  const speechAfterRejectedEnd = calls
    .filter((call) => call.url.endsWith('/speak'))
    .slice(speakCallsBeforeRejectedEnd)
    .find((call) => call.body.request_id === 'speech-after-rejected-end');
  assert(speechAfterRejectedEnd?.body.suppress_primary_audio === true,
    'the speech tap was not reusable after a rejected route end');
  await speechTapHost.end({ sdk_route_instance_id: 'speech-generation-end' });
  assert(endSocket.closed && speechTapHost._activeRouteIdentity === null,
    'route end did not close and retire the speech tap');
  const resetSocket = await startSpeechTapRoute('speech-generation-reset');
  speechTapHost.resetRuntime({ newSession: true });
  assert(resetSocket.closed && speechTapHost._activeRouteIdentity === null,
    'runtime reset did not close and retire the speech tap');
  const disposeSocket = await startSpeechTapRoute('speech-generation-dispose');
  speechTapHost.dispose();
  assert(disposeSocket.closed && speechTapHost._speechAudioTap.blobQueue.length === 0,
    'host disposal did not close the speech tap and discard queued raw data');
  assert(speechTapErrors.length === 0,
    `speech tap emitted unexpected host bridge errors: ${speechTapErrors.map((item) => item.source).join(',')}`);
  windowMock.removeEventListener('neko-assistant-turn-end', speechTurnEndHandler);
  delete windowMock.appState;
  delete windowMock.appAudioPlayback;

  const controls = [];
  host.startGameControlBridge({ onControl: (control) => controls.push(control) });
  const delayedDrain = host.drain({
    session_id: 'attacker-session',
    sdk_route_instance_id: 'route-instance-A',
    delay_control_parse: true,
  });
  await delayedDrainStarted;
  host.applyRuntimeState({
    session_id: 'replacement-session',
    lanlan_name: 'Server Neko',
  });
  releaseDelayedDrain();
  await delayedDrain;
  assert(controls.length === 1 && controls[0].type === 'stance'
    && controls[0].payload === 'ready',
  'route outputs were not converted into SDK control envelopes');
  assert(controls[0].sessionId === 'server-session',
    'control envelope did not preserve the drain request session');
  assert(controls[0].routeInstanceId === 'route-instance-A',
    'control envelope did not preserve the drain request route generation');
  assert(controls[0].timestamp === 123000,
    'second-based backend control timestamps were not normalized to milliseconds');
  host.applyRuntimeState({
    session_id: 'server-session',
    lanlan_name: 'Server Neko',
  });

  const millisecondControls = [];
  host.stopGameControlBridge();
  host.startGameControlBridge({ onControl: (control) => millisecondControls.push(control) });
  host._dispatchGameControls([{ ts: 1700000000123, control: { stance: 'ready' } }]);
  assert(millisecondControls[0].timestamp === 1700000000123,
    'millisecond control timestamps were changed during normalization');

  let sameDocumentState = null;
  let sameDocumentVoiceError = null;
  host.startVoiceControlBridge({
    BroadcastChannelImpl: null,
    onState: (state, source) => { sameDocumentState = { state, source }; },
    onError: (error, source) => { sameDocumentVoiceError = { error, source }; },
  });
  windowMock.dispatchEvent(new windowMock.CustomEvent('neko-game-voice-control-message', {
    detail: {
      type: 'game_voice_control_state',
      game_type: 'example-game',
      session_id: 'server-session',
      reason: 'state-sync',
    },
  }));
  assert(sameDocumentState?.source === 'same_document'
    && sameDocumentState.state.reason === 'state-sync',
  'same-document voice fallback state was not received');
  windowMock.dispatchEvent(new windowMock.CustomEvent('neko-game-voice-control-message', {
    detail: {
      type: 'game_voice_control_state',
      game_type: 'example-game',
      session_id: 'server-session',
      route_active: false,
      active: false,
      reason: 'route_closed',
    },
  }));
  assert(sameDocumentState?.state.route_active === false
    && sameDocumentState.state.reason === 'route_closed',
  'the trusted host dropped the closing route inactive voice state');
  windowMock.dispatchEvent(new windowMock.CustomEvent('neko-game-voice-control-message', {
    detail: {
      type: 'game_voice_control_error',
      game_type: 'example-game',
      session_id: 'server-session',
      code: 'not-allowed',
      reason: 'not-allowed',
    },
  }));
  assert(sameDocumentVoiceError?.source === 'same_document'
    && sameDocumentVoiceError.error.code === 'not-allowed',
  'same-document voice control errors were not delivered to the SDK bridge');
  const sameDocumentController = (event) => {
    if (event?.detail?.type !== 'game_voice_control_request') return;
    windowMock.dispatchEvent(new windowMock.CustomEvent('neko-game-voice-control-message', {
      detail: {
        type: 'game_voice_control_state',
        game_type: 'example-game',
        session_id: 'server-session',
        sdk_route_instance_id: event.detail.sdk_route_instance_id,
        request_id: event.detail.request_id,
        reason: 'queried',
        ok: true,
      },
    }));
  };
  windowMock.addEventListener('neko-game-voice-control-message', sameDocumentController);
  // Two adapters sharing a session and a millisecond both minted `voice-<ms>-1`,
  // and the shared channel then routed one adapter's reply into the other's
  // pending map. Capture the ids the requests actually carry.
  const observedVoiceRequestIds = [];
  const voiceRequestIdObserver = (event) => {
    if (event?.detail?.type === 'game_voice_control_request') {
      observedVoiceRequestIds.push(event.detail.request_id);
    }
  };
  windowMock.addEventListener('neko-game-voice-control-message', voiceRequestIdObserver);
  const sameDocumentResponse = await host.requestVoiceControl('query', {
    timeoutMs: 500,
    sdkRouteInstanceId: 'route-instance-a',
  });
  assert(sameDocumentResponse.reason === 'queried',
    'same-document voice fallback request did not complete without BroadcastChannel');
  assert(sameDocumentResponse.sdk_route_instance_id === 'route-instance-a',
    'same-document voice request did not preserve the route generation');
  const originalStorageSetItem = windowMock.localStorage.setItem;
  windowMock.localStorage.setItem = () => { throw new Error('storage blocked'); };
  const storageBlockedResponse = await host.requestVoiceControl('query', {
    timeoutMs: 500,
    sdkRouteInstanceId: 'route-instance-a',
  });
  windowMock.localStorage.setItem = originalStorageSetItem;
  assert(storageBlockedResponse.reason === 'queried',
    'same-document voice fallback was skipped when localStorage failed');
  const realVoiceDateNow = Date.now;
  let voiceEntropyCounter = 0;
  try {
    Date.now = () => 1700000000000;
    // TWO FRESH adapters: both per-bridge counters start at 0, which is the
    // collision. Reusing the long-lived `host` here would not reproduce it --
    // its counter has already advanced past 1 in the assertions above, so the
    // ids would differ for the wrong reason.
    const peerIds = [];
    for (const peerIndex of [0, 1]) {
      // windowMock.crypto is a deterministic `values.fill(7)` stub, which
      // would make both ids equal for the wrong reason. Counter source, so
      // "distinct" really means the entropy reached the id.
      const peerWindow = {
        ...windowMock,
        BroadcastChannel: undefined,
        crypto: {
          getRandomValues(values) {
            for (let index = 0; index < values.length; index += 1) {
              voiceEntropyCounter += 1;
              values[index] = voiceEntropyCounter;
            }
            return values;
          },
        },
      };
      const peerVoiceHost = createHost({
        gameType: 'example-game',
        sessionId: 'server-session',
        fetchImpl,
        windowImpl: peerWindow,
        navigatorImpl: windowMock.navigator,
      });
      peerVoiceHost.connectGame({
        protocolVersions: ['1'],
        manifest: {
          id: 'example-game', version: '1.0.0',
          requiredCapabilities: ['runtime', 'logging'],
          optionalCapabilities: ['voice-input'],
        },
      });
      peerVoiceHost.applyRouteState({
        game_route_active: true,
        session_id: 'server-session',
        lanlan_name: 'Server Neko',
      });
      peerVoiceHost.startVoiceControlBridge({ onState() {} });
      const before = observedVoiceRequestIds.length;
      await peerVoiceHost.requestVoiceControl('query', {
        timeoutMs: 500,
        sdkRouteInstanceId: 'route-instance-a',
      }).catch(() => { /* answered by the shared controller above */ });
      assert(observedVoiceRequestIds.length === before + 1,
        `peer adapter ${peerIndex} did not dispatch a voice request`);
      peerIds.push(observedVoiceRequestIds.at(-1));
      peerVoiceHost.dispose();
    }
    assert(peerIds[0] !== peerIds[1],
      `two same-session adapters minted the same voice request id in one millisecond: ${JSON.stringify(peerIds)}`);
  } finally {
    Date.now = realVoiceDateNow;
  }
  windowMock.removeEventListener('neko-game-voice-control-message', voiceRequestIdObserver);
  windowMock.removeEventListener('neko-game-voice-control-message', sameDocumentController);
  const voiceAbortController = new AbortController();
  const cancelledVoiceRequest = host.requestVoiceControl('query', {
    timeoutMs: 500,
    signal: voiceAbortController.signal,
  }).catch((error) => error);
  voiceAbortController.abort();
  const cancelledVoiceError = await cancelledVoiceRequest;
  assert(cancelledVoiceError?.code === 'cancelled' && host._voiceControlBridge.pending.size === 0,
    'aborted voice control request remained pending in the trusted host');
  host.stopVoiceControlBridge();
  assert(!listeners.has('neko-game-voice-control-message'),
    'same-document voice fallback listener was not released');

  const dualChannelMessages = [];
  let dualChannel = null;
  class DualVoiceChannelMock {
    constructor() { dualChannel = this; this.onmessage = null; }
    postMessage(message) { dualChannelMessages.push(message); }
    close() {}
  }
  let dualFallbackRequests = 0;
  let dualStateDeliveries = 0;
  const dualController = (event) => {
    if (event?.detail?.type !== 'game_voice_control_request') return;
    dualFallbackRequests += 1;
    const response = {
      type: 'game_voice_control_state',
      message_id: 'dual-response-1',
      game_type: 'example-game',
      session_id: 'server-session',
      sdk_route_instance_id: event.detail.sdk_route_instance_id,
      request_id: event.detail.request_id,
      reason: 'dual-queried',
      ok: true,
    };
    windowMock.dispatchEvent(new windowMock.CustomEvent('neko-game-voice-control-message', {
      detail: response,
    }));
    dualChannel.onmessage({ data: response });
  };
  windowMock.addEventListener('neko-game-voice-control-message', dualController);
  host.startVoiceControlBridge({
    BroadcastChannelImpl: DualVoiceChannelMock,
    onState: () => { dualStateDeliveries += 1; },
  });
  const dualResponse = await host.requestVoiceControl('query', {
    timeoutMs: 500,
    sdkRouteInstanceId: 'route-instance-b',
  });
  assert(dualResponse.reason === 'dual-queried'
    && dualChannelMessages.some((message) => message.type === 'game_voice_control_request')
    && dualFallbackRequests === 1,
  'voice control did not publish the same request over channel and fallback paths');
  assert(dualChannelMessages.some((message) => message.sdk_route_instance_id === 'route-instance-b'),
    'voice control transport omitted the active route generation');
  assert(dualStateDeliveries === 1,
    'voice control delivered one response more than once across dual transports');
  host.stopVoiceControlBridge();
  windowMock.removeEventListener('neko-game-voice-control-message', dualController);

  let recognitionAbortCalls = 0;
  class RecognitionMock {
    start() {}
    stop() {}
    abort() { recognitionAbortCalls += 1; }
  }
  host.startSpeechRecognition('release-test', { RecognitionImpl: RecognitionMock });
  host.releaseSpeechRecognition('release-test');
  assert(recognitionAbortCalls === 1 && host._speechRecognitionSlots.size === 0,
    'speech recognition release did not abort and remove its browser recognizer');

  let releaseLimitedProtocol;
  let markLimitedProtocolStarted;
  const limitedProtocolGate = new Promise((resolve) => { releaseLimitedProtocol = resolve; });
  const limitedProtocolStarted = new Promise((resolve) => { markLimitedProtocolStarted = resolve; });
  const limitedFetch = async (url, init = {}) => {
    if (String(url).startsWith('/api/config/page_config')) {
      return jsonResponse({ autostart_csrf_token: 'test-token' });
    }
    if (String(url).endsWith('/protocol')) {
      markLimitedProtocolStarted();
      await limitedProtocolGate;
    }
    return jsonResponse({ ok: true });
  };
  const limitedHost = createHost({
    gameType: 'example-game',
    protocolQueueLimit: 2,
    fetchImpl: limitedFetch,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
  });
  limitedHost.connectGame({
    protocolVersions: ['1'],
    manifest: {
      id: 'example-game', version: '1.0.0', requiredCapabilities: ['runtime'], optionalCapabilities: [],
    },
  });
  const limitedFirst = limitedHost.publishGameProtocol('event', {
    protocolVersion: '1', sequence: 1, type: 'first', payload: {},
  });
  await limitedProtocolStarted;
  const limitedQueued = limitedHost.publishGameProtocol('event', {
    protocolVersion: '1', sequence: 2, type: 'second', payload: {},
  });
  let queueLimitError = null;
  try {
    await limitedHost.publishGameProtocol('event', {
      protocolVersion: '1', sequence: 3, type: 'third', payload: {},
    });
  } catch (error) {
    queueLimitError = error;
  }
  assert(queueLimitError?.code === 'busy', 'protocol queue did not enforce its hard capacity');
  limitedHost.dispose({ preservePendingOperations: ['game_protocol'] });
  releaseLimitedProtocol();
  await limitedFirst;
  let disposedQueueError = null;
  try { await limitedQueued; } catch (error) { disposedQueueError = error; }
  assert(disposedQueueError?.code === 'disposed',
    'queued protocol work survived host disposal');

  const waitingLockNavigator = {
    sendBeacon: () => false,
    locks: {
      request(_name, options) {
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }, { once: true });
        });
      },
    },
  };
  const waitingLockHost = createHost({
    gameType: 'waiting-lock-game',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: waitingLockNavigator,
  });
  waitingLockHost.connectGame({
    protocolVersions: ['1'],
    manifest: {
      id: 'waiting-lock-game', version: '1.0.0', requiredCapabilities: ['leaderboard-local'], optionalCapabilities: [],
    },
  });
  const waitingLock = waitingLockHost.runGameStorageExclusive('leaderboards/main', async () => true)
    .catch((error) => error);
  await Promise.resolve();
  assert(waitingLockHost._pendingStorageLockControllers.size === 1,
    'trusted host did not track the pending Web Lock request');
  waitingLockHost.dispose();
  const waitingLockError = await waitingLock;
  assert(waitingLockError?.code === 'disposed'
    && waitingLockHost._pendingStorageLockControllers.size === 0,
  'trusted host disposal did not abort and release its pending Web Lock request');

  const genericHost = createHost({
    gameType: 'third-party-game',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
  });
  const genericHandshake = genericHost.connectGame({
    protocolVersions: ['1'],
    manifest: {
      id: 'third-party-game',
      version: '1.0.0',
      requiredCapabilities: ['logging'],
      optionalCapabilities: ['dialogue', 'quick-lines'],
    },
  });
  assert(genericHandshake.grantedCapabilities.includes('dialogue')
    && !genericHandshake.grantedCapabilities.includes('quick-lines'),
  'generic games received a quick-lines route without a registered dictionary');

  const noLockHost = createHost({
    gameType: 'no-lock-game',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: { sendBeacon: () => false },
  });
  const noLockHandshake = noLockHost.connectGame({
    protocolVersions: ['1'],
    manifest: {
      id: 'no-lock-game',
      version: '1.0.0',
      requiredCapabilities: ['logging'],
      optionalCapabilities: ['storage', 'leaderboard-local'],
    },
  });
  assert(noLockHandshake.grantedCapabilities.includes('storage')
    && !noLockHandshake.grantedCapabilities.includes('leaderboard-local'),
  'host granted cross-window leaderboard mutations without an origin-wide lock');

  const originalConsoleWarn = windowMock.console.warn;
  const originalConsoleError = windowMock.console.error;
  const loggerHostOne = createHost({
    gameType: 'logger-one',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
  });
  const loggerHostTwo = createHost({
    gameType: 'logger-two',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
  });
  for (const loggerHost of [loggerHostOne, loggerHostTwo]) {
    loggerHost.connectGame({
      protocolVersions: ['1'],
      manifest: {
        id: loggerHost.gameType, version: '1.0.0', requiredCapabilities: ['logging'], optionalCapabilities: [],
      },
    });
  }
  loggerHostOne.configureLogger();
  loggerHostTwo.configureLogger();
  const sharedCaptureRegistry = loggerHostOne._logger.consoleCaptureRegistry;
  assert(sharedCaptureRegistry === loggerHostTwo._logger.consoleCaptureRegistry
    && sharedCaptureRegistry.hosts.size === 2,
  'same-document hosts did not share one bounded console capture registry');
  const throwingValue = new Proxy({}, {
    get(_target, property) {
      if (property === Symbol.toPrimitive || property === 'toString') {
        return () => { throw new Error('cannot stringify'); };
      }
      return undefined;
    },
  });
  let consoleCaptureError = null;
  try {
    windowMock.console.warn(Object.create(null), throwingValue);
    windowMock.console.error(throwingValue);
  } catch (error) { consoleCaptureError = error; }
  assert(consoleCaptureError === null,
    'global console capture changed caller control flow for unprintable values');
  // `details` is truncated leaf by leaf, but `message` was kept verbatim -- and
  // the global console capture joins every argument into it. One accidental
  // data URL or serialized snapshot therefore became a multi-megabyte body, and
  // the send queue holds up to 256 of them before anything leaves the page.
  const capturedLogPayloads = [];
  const realRecordLogPayload = loggerHostOne._recordOrSendLogPayload.bind(loggerHostOne);
  loggerHostOne._recordOrSendLogPayload = (payload) => { capturedLogPayloads.push(payload); };
  loggerHostOne._logger.enabled = true;
  windowMock.console.warn('y'.repeat(50000));
  loggerHostOne._logger.enabled = false;
  loggerHostOne._recordOrSendLogPayload = realRecordLogPayload;
  assert(capturedLogPayloads.length === 1 && capturedLogPayloads[0].message.length === 4096,
    'an oversized console message was queued verbatim');

  // Per-leaf truncation does not bound the RESULT: three object levels of 30
  // keys each keeps 27,000 leaves of up to 1,200 characters. One cumulative
  // budget across the whole walk is what actually bounds the body.
  const wideDetails = {};
  for (let outer = 0; outer < 30; outer += 1) {
    const level2 = {};
    for (let middle = 0; middle < 30; middle += 1) {
      const level3 = {};
      for (let inner = 0; inner < 30; inner += 1) {
        level3[`k${inner}`] = 'z'.repeat(1200);
      }
      level2[`m${middle}`] = level3;
    }
    wideDetails[`o${outer}`] = level2;
  }
  const wideLogPayloads = [];
  const realWideRecord = loggerHostOne._recordOrSendLogPayload.bind(loggerHostOne);
  loggerHostOne._recordOrSendLogPayload = (payload) => { wideLogPayloads.push(payload); };
  loggerHostOne._logger.enabled = true;
  loggerHostOne.log('warning', 'frontend', 'wide_details', 'wide', wideDetails);
  loggerHostOne._logger.enabled = false;
  loggerHostOne._recordOrSendLogPayload = realWideRecord;
  assert(wideLogPayloads.length === 1, 'the wide-details probe did not queue a payload');
  const wideDetailsChars = JSON.stringify(wideLogPayloads[0].details).length;
  assert(wideDetailsChars < 200 * 1024,
    `nested log details were not bounded in aggregate: ${wideDetailsChars} chars`);

  loggerHostOne.dispose();
  windowMock.console.warn('capture remains after first dispose');
  windowMock.console.error('capture remains after first dispose');
  assert(sharedCaptureRegistry.hosts.size === 1
    && windowMock.console.warn === sharedCaptureRegistry.warnWrapper,
  'disposing the first host corrupted the shared console wrapper');
  loggerHostTwo.dispose();
  windowMock.console.warn('original warn restored');
  windowMock.console.error('original error restored');
  assert(sharedCaptureRegistry.hosts.size === 0
    && windowMock.console.warn === originalConsoleWarn
    && windowMock.console.error === originalConsoleError,
  'disposing the final host did not restore and release global console capture');

  // --- route-end archive is projected against granted capabilities ---
  // The server returns its full internal archive on /route/end. Game code is
  // the untrusted party, so captured dialogue, the in-session summary and the
  // pregame context must not reach it just because it holds `runtime`.
  // Drive the real transport boundary first: projecting correctly is useless if
  // end() stops calling the projection.
  // The SDK forwards runtime.end(payload, { timeoutMs }) and the .d.ts
  // advertises it, but this method enumerates _post options explicitly (so
  // operation/keepalive/headers cannot be overridden) and used to drop it.
  const endOptionCalls = [];
  const realPost = host._post.bind(host);
  host._post = (url, body, options) => {
    endOptionCalls.push({ url: String(url), timeoutMs: options?.timeoutMs });
    return realPost(url, body, options);
  };
  await host.end({ session_id: 'server-session' }, { timeoutMs: 1234 });
  assert(endOptionCalls.some((call) => /\/end$/.test(call.url)
    && call.timeoutMs > 0 && call.timeoutMs <= 1234),
    'runtime end ignored the caller-supplied timeout');
  endOptionCalls.length = 0;
  await host.end({ session_id: 'server-session' }, { timeoutMs: 999999 });
  assert(endOptionCalls.some((call) => /\/end$/.test(call.url)
    && call.timeoutMs > 0 && call.timeoutMs <= 30000),
    'runtime end did not clamp an oversized caller timeout');
  endOptionCalls.length = 0;
  await host.end({ session_id: 'server-session' }, { timeoutMs: 'nonsense' });
  assert(endOptionCalls.some((call) => /\/end$/.test(call.url)
    && call.timeoutMs > 0 && call.timeoutMs <= 8000),
    'an invalid caller timeout did not degrade to the existing default');
  host._post = realPost;

  // Final-log ordering consumes the same advertised deadline as route end;
  // otherwise a 1s end could spend 1.5s flushing and then start a fresh 1s
  // request. Use a deterministic clock to prove the remaining budget is sent.
  {
    const budgetHost = createHost({
      gameType: 'example-game',
      fetchImpl,
      windowImpl: windowMock,
      navigatorImpl: windowMock.navigator,
    });
    budgetHost.connectGame({
      protocolVersions: ['1'],
      manifest: {
        id: 'example-game', version: '1.0.0',
        requiredCapabilities: ['runtime', 'logging'], optionalCapabilities: [],
      },
    });
    const realDateNow = Date.now;
    let budgetNow = 10000;
    let routedEndBudget = null;
    Date.now = () => budgetNow;
    budgetHost.flushLogger = async () => {
      budgetNow += 400;
      return { ok: true };
    };
    budgetHost._post = async (_url, _body, options) => {
      routedEndBudget = options.timeoutMs;
      return jsonResponse(RAW_END_RESPONSE);
    };
    try {
      await budgetHost.end({ reason: 'budgeted-end' }, { timeoutMs: 1000 });
    } finally {
      Date.now = realDateNow;
      budgetHost.dispose();
    }
    assert(routedEndBudget === 600,
      'final-log flush time was not deducted from the route-end deadline');
  }

  {
    const abortHost = createHost({
      gameType: 'example-game',
      fetchImpl,
      windowImpl: windowMock,
      navigatorImpl: windowMock.navigator,
    });
    abortHost.connectGame({
      protocolVersions: ['1'],
      manifest: {
        id: 'example-game', version: '1.0.0',
        requiredCapabilities: ['runtime', 'logging'], optionalCapabilities: [],
      },
    });
    abortHost.flushLogger = () => new Promise(() => {});
    let abortedEndReachedPost = false;
    abortHost._post = async () => {
      abortedEndReachedPost = true;
      return jsonResponse(RAW_END_RESPONSE);
    };
    const endController = new AbortController();
    const abortedEnd = abortHost.end(
      { reason: 'cancel-during-flush' },
      { timeoutMs: 1000, signal: endController.signal },
    );
    endController.abort();
    const abortedEndError = await abortedEnd.then(() => null, (error) => error);
    assert(abortedEndError?.code === 'cancelled' && abortedEndReachedPost === false,
      'route end ignored cancellation while waiting for its final-log flush');
    abortHost.dispose();
  }

  const endResult = await host.end({ session_id: 'server-session' });
  for (const field of LEAKY_ARCHIVE_FIELDS) {
    assert(!(field in endResult.archive),
      `end() returned ${field} from the raw server archive`);
  }
  assert(!('archive_memory' in endResult),
    'end() returned the host memory-write result to game code');
  assert(!('line' in endResult.postgame),
    'end() returned the assistant postgame line to game code');
  assert(endResult.archive.finalScore.player === 2 && endResult.ok === true,
    'end() dropped fields the game legitimately needs');

  const rawEndResponse = RAW_END_RESPONSE;
  // The host-supplied provider closures are the one thing a launch registration
  // actually gates that same-origin script cannot obtain some other way, so they
  // must not be readable off a host that has not completed a handshake. Assert
  // on a FRESHLY CONSTRUCTED host: checking the already-connected `host` would
  // not test the claim, since that one has been granted `quick-lines` anyway.
  const bareHost = createHost({
    gameType: 'example-game',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
  });
  assert(bareHost._capabilityProviders === undefined,
    'capability provider closures were readable off a host with no handshake');
  assert(!Object.values(bareHost).some((value) => typeof value === 'function'
    && value !== bareHost.dispose && String(value).includes('lines')),
  'a provider closure leaked onto a public property of an unconnected host');
  let bareQuickLinesError = null;
  try { await bareHost.getQuickLines({ event: { kind: 'prepare' } }); }
  catch (error) { bareQuickLinesError = error; }
  assert(bareQuickLinesError?.code === 'capability_denied',
    'an unconnected host served quick-lines without a granted capability');
  bareHost.dispose();
  assert(host._capabilityProviders === undefined,
    'capability provider closures were exposed on a public host property');

  const grantedProjection = host._projectRouteEndResponse(rawEndResponse);
  for (const field of LEAKY_ARCHIVE_FIELDS) {
    assert(!(field in grantedProjection.archive),
      `route-end archive leaked ${field} to game code`);
  }
  assert(!('archive_memory' in grantedProjection),
    'route-end response leaked the host memory-write result to game code');
  assert(!('line' in grantedProjection.postgame),
    'route-end response leaked the assistant postgame line to game code');
  assert(!('should_resume_external_on_exit' in grantedProjection),
    'route-end response leaked host-internal session state to game code');
  assert(grantedProjection.archive.finalScore.player === 2
    && grantedProjection.archive.last_state.round === 4
    && grantedProjection.ok === true
    && grantedProjection.postgame.action === 'chat',
  'route-end projection dropped fields the game legitimately needs');
  // This host holds context-read and memory, so those scopes survive.
  assert(grantedProjection.archive.preGameContext?.stance === 'private'
    && grantedProjection.archive.game_context_summary === 'private rolling summary'
    && Array.isArray(grantedProjection.archive.sdk_memory_submissions),
  'route-end projection withheld scopes the game was actually granted');

  const restoreGrants = host._grantedCapabilities;
  host._grantedCapabilities = new Set(['logging', 'runtime']);
  const runtimeOnlyProjection = host._projectRouteEndResponse(rawEndResponse);
  host._grantedCapabilities = restoreGrants;
  for (const field of [...LEAKY_ARCHIVE_FIELDS,
    'preGameContext', 'pre_game_context_source', 'game_context_summary',
    'sdk_memory_submissions']) {
    assert(!(field in runtimeOnlyProjection.archive),
      `a runtime-only game received ${field} without the capability granting it`);
  }
  assert(runtimeOnlyProjection.archive.finalScore.player === 2,
    'a runtime-only game lost its own outcome fields');

  // --- a timed-out logger enable must not commit when it finally lands ---
  // The generation guard only tracks teardown, so without an attempt token a
  // slow POST (30s default) landing after the 3.5s enable timeout would flip
  // logger.enabled AFTER the caller was told enabling failed, and console
  // output would start being transmitted unexpectedly.
  slowLogEnableGate = new Promise((resolve) => { releaseSlowLogEnable = resolve; });
  const timeoutLogHost = createHost({
    gameType: 'log-timeout-game',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
  });
  await timeoutLogHost.connectGame({
    protocolVersions: ['1'],
    manifest: {
      id: 'log-timeout-game', version: '1.0.0',
      requiredCapabilities: ['logging'], optionalCapabilities: [],
    },
  });
  timeoutLogHost.configureLogger({ enableTimeoutMs: 5 });
  const timedOutEnable = await timeoutLogHost.enableLogger('test');
  assert(timedOutEnable?.ok === false && timedOutEnable.reason === 'enable_timeout',
    'the slow logger enable did not time out as set up: ' + JSON.stringify(timedOutEnable));
  assert(timeoutLogHost._logger.enabled !== true,
    'logging was enabled even though the caller was told it timed out');
  assert(slowLogEnableAborted === true,
    'timed-out logger enable left its backend request running');

  releaseSlowLogEnable();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert(timeoutLogHost._logger.enabled !== true,
    'a timed-out logger enable committed after it finally settled');
  timeoutLogHost.dispose();
  slowLogEnableGate = null;

  noLockHost.dispose();
  genericHost.dispose();
  let disposedHostLocaleEvents = 0;
  host.subscribeHostLocale(() => { disposedHostLocaleEvents += 1; });
  const localeWindowListenersBeforeHostDispose = listeners.get('localechange')?.size || 0;
  host.dispose();
  assert((listeners.get('localechange')?.size || 0)
    === Math.max(0, localeWindowListenersBeforeHostDispose - 1),
  'host disposal did not remove its localechange listener');
  windowMock.i18next.language = 'ru';
  windowMock.dispatchEvent(new windowMock.CustomEvent('localechange', {
    detail: { language: 'ru', revision: 999 },
  }));
  assert(disposedHostLocaleEvents === 1 && host._hostLocale.listeners.size === 0,
    'host disposal did not clear locale subscribers or accepted a late locale update');
  const endHost = createHost({
    gameType: 'example-game',
    sessionId: 'end-projection-session',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: windowMock.navigator,
  });
  endHost.connectGame({
    protocolVersions: ['1'],
    manifest: {
      id: 'example-game',
      version: '1.0.0',
      requiredCapabilities: ['runtime', 'logging'],
      optionalCapabilities: [],
    },
  });

  // A rejected close must not read as success. `/end` answering non-2xx with a
  // FastAPI-shaped `{"detail": ...}` parses fine, carries no `ok`, and keeps no
  // field the projection preserves -- so it used to arrive as `{}`, which the
  // SDK reads as SUCCESS. The client then retired its route generation and
  // entered `ended` while the backend had refused to close the route.
  const rejectedEnd = await endHost.end({ force_end_http_error: true });
  assert(rejectedEnd.ok === false && rejectedEnd.status === 409,
    `a non-2xx route end was projected as success: ${JSON.stringify(rejectedEnd)}`);
  const acceptedEnd = await endHost.end({});
  assert(acceptedEnd.ok !== false,
    'a successful route end was projected as a failure');

  // Fetch caps keepalive bodies at 64 KiB and the quota is SHARED with the
  // diagnostic logger, so an oversized-but-valid end payload (the SDK admits up
  // to 256 KiB) used to reject before the request left the page: explicit end
  // degraded, and an unloading page skipped cleanup and postgame entirely.
  const endCallsBefore = calls.filter((call) => /\/end$/.test(call.url)).length;
  await endHost.end({ small: 'x'.repeat(1024) });
  const smallEndCall = calls.filter((call) => /\/end$/.test(call.url)).at(-1);
  assert(smallEndCall.init.keepalive === true,
    'a small route end payload lost its keepalive guarantee');
  await endHost.end({ big: 'x'.repeat(100 * 1024) });
  const bigEndCall = calls.filter((call) => /\/end$/.test(call.url)).at(-1);
  // `_post` omits the key entirely rather than sending `keepalive: false`.
  assert(bigEndCall.init.keepalive !== true,
    'an end payload past the keepalive quota was still sent with keepalive');
  assert(calls.filter((call) => /\/end$/.test(call.url)).length === endCallsBefore + 2,
    'the keepalive probe did not reach the backend');
  endHost.dispose();

  // The generated session id used to be timestamp-only, so two hosts for the same
  // game constructed in the same millisecond started life with the SAME client
  // session id -- and every game endpoint keys route identity on session_id, so
  // one window's requests would answer for the other's route. resetSession
  // ({newSession:true}) mints through the same generator, so an immediate reset
  // could also claim a new session while keeping the old identity.
  const realSessionDateNow = Date.now;
  const generatedSessionIds = new Set();
  const probeIds = [];
  // windowMock.crypto is deliberately deterministic (`values.fill(7)`), which
  // would make every id here identical for the wrong reason. Give the probe a
  // counter-based source: distinct ids then prove the entropy is actually mixed
  // into the id, not that the clock moved.
  let sessionEntropyCounter = 0;
  const sessionEntropyWindow = {
    ...windowMock,
    crypto: {
      getRandomValues(values) {
        for (let index = 0; index < values.length; index += 1) {
          sessionEntropyCounter += 1;
          values[index] = sessionEntropyCounter;
        }
        return values;
      },
    },
  };
  try {
    Date.now = () => 1700000000000;
    for (let index = 0; index < 4; index += 1) {
      const idHost = createHost({
        gameType: 'example-game',
        fetchImpl,
        windowImpl: sessionEntropyWindow,
        navigatorImpl: windowMock.navigator,
      });
      const constructed = idHost.sessionId;
      const reset = idHost.resetRuntime({ newSession: true }).sessionId;
      probeIds.push([constructed, reset]);
      generatedSessionIds.add(constructed);
      generatedSessionIds.add(reset);
      idHost.dispose();
    }
  } finally {
    Date.now = realSessionDateNow;
  }
  assert(generatedSessionIds.size === 8,
    `same-millisecond hosts minted colliding session ids: ${JSON.stringify(probeIds)}`);

  // On unload, keepalive is the only delivery with any chance, so an oversized
  // page-exit body must shed the CALLER's payload rather than the delivery
  // guarantee -- dropping keepalive there lets the unloading document cancel the
  // request outright, and route cleanup plus postgame are lost until expiry.
  const exitHost = createHost({
    gameType: 'example-game',
    sessionId: 'page-exit-session',
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: { ...windowMock.navigator, sendBeacon: () => false },
  });
  exitHost.connectGame({
    protocolVersions: ['1'],
    manifest: {
      id: 'example-game', version: '1.0.0',
      requiredCapabilities: ['runtime', 'logging'], optionalCapabilities: [],
    },
  });
  await exitHost.end(
    { reason: 'pagehide', bulk: 'x'.repeat(100 * 1024) },
    { useBeacon: true },
  );
  const exitCall = calls.filter((call) => /\/end$/.test(call.url)).at(-1);
  assert(exitCall.init.keepalive === true,
    'an oversized page-exit end lost its keepalive guarantee');
  assert(exitCall.body.reason === 'pagehide',
    'the shed page-exit payload dropped the reason the backend finalizes on');
  assert(exitCall.body.bulk === undefined,
    'the oversized caller payload was not shed from the page-exit body');
  assert(exitCall.init.body.length < 60 * 1024,
    'the page-exit body still exceeds the keepalive quota after shedding');
  // Shedding the caller's payload is not enough on its own: `reason` is kept
  // (the backend finalizes on it) and is caller-sized, so an oversized reason
  // would leave the body over quota -- and keepalive on an over-quota body
  // fails BEFORE the request leaves the page, i.e. it guarantees exactly the
  // loss it was kept for. Trim what is kept until the body actually fits.
  await exitHost.end(
    { reason: `pagehide-${'r'.repeat(100 * 1024)}` },
    { useBeacon: true },
  );
  const unshrinkableExitCall = calls.filter((call) => /\/end$/.test(call.url)).at(-1);
  assert(unshrinkableExitCall.init.body.length <= 60 * 1024,
    'an oversized page-exit reason left the body over the keepalive quota');
  assert(unshrinkableExitCall.init.keepalive === true,
    'a page-exit end whose reason had to be trimmed lost keepalive');
  assert(typeof unshrinkableExitCall.body.reason === 'string'
    && unshrinkableExitCall.body.reason.startsWith('pagehide-')
    && unshrinkableExitCall.body.reason.length <= 512,
  'the trimmed page-exit reason was dropped instead of shortened');

  // A direct host caller is not bound by the SDK's four-generation cap, so the
  // retained candidate list is the next thing that can hold the body over quota.
  await exitHost.end({
    reason: 'pagehide',
    sdk_route_instance_ids: Array.from({ length: 900 }, (_unused, index) => (
      `route-${index}-${'i'.repeat(120)}`
    )),
  }, { useBeacon: true });
  const bulkIdsExitCall = calls.filter((call) => /\/end$/.test(call.url)).at(-1);
  assert(bulkIdsExitCall.init.body.length <= 60 * 1024,
    'an oversized retained candidate list left the page-exit body over quota');
  assert(bulkIdsExitCall.init.keepalive === true,
    'trimming the candidate list lost keepalive on the unload path');
  assert(bulkIdsExitCall.body.reason === 'pagehide',
    'the candidate-list trim dropped the reason before the list');
  exitHost.dispose();

  // And when nothing CAN be shed -- the host's own stamped session id is over
  // quota by itself -- keepalive must be dropped rather than kept: a keepalive
  // request over the shared budget fails before it leaves the page, which is
  // exactly the loss it was kept for. A plain request at least has a chance.
  const hugeSessionHost = createHost({
    gameType: 'example-game',
    sessionId: `s${'q'.repeat(80 * 1024)}`,
    fetchImpl,
    windowImpl: windowMock,
    navigatorImpl: { ...windowMock.navigator, sendBeacon: () => false },
  });
  hugeSessionHost.connectGame({
    protocolVersions: ['1'],
    manifest: {
      id: 'example-game', version: '1.0.0',
      requiredCapabilities: ['runtime', 'logging'], optionalCapabilities: [],
    },
  });
  await hugeSessionHost.end({ reason: 'pagehide' }, { useBeacon: true });
  const unshedableExitCall = calls.filter((call) => /\/end$/.test(call.url)).at(-1);
  assert(unshedableExitCall.init.body.length > 60 * 1024,
    'the unshedable probe did not actually exceed the keepalive quota');
  assert(unshedableExitCall.init.keepalive !== true,
    'a page-exit body that cannot be shed under the quota still used keepalive, '
    + 'which fails before the request leaves the page');
  hugeSessionHost.dispose();

  // Explicit route end gives queued logs a bounded head start, so the backend
  // cannot mark the session ended before a healthy log transport completes.
  {
    let releaseOrderedLog;
    let markOrderedLogStarted;
    const orderedLogGate = new Promise((resolve) => { releaseOrderedLog = resolve; });
    const orderedLogStarted = new Promise((resolve) => { markOrderedLogStarted = resolve; });
    const orderedCalls = [];
    const orderedFetch = async (url, init = {}) => {
      const pathName = String(url);
      orderedCalls.push(pathName);
      if (pathName === '/api/game/logs') {
        markOrderedLogStarted();
        await orderedLogGate;
        return jsonResponse({ ok: true });
      }
      if (/\/end$/.test(pathName)) return jsonResponse(RAW_END_RESPONSE);
      return jsonResponse({ ok: true });
    };
    const orderedHost = createHost({
      gameType: 'example-game',
      sessionId: 'ordered-log-session',
      fetchImpl: orderedFetch,
      windowImpl: windowMock,
      navigatorImpl: { ...windowMock.navigator, sendBeacon: () => false },
    });
    orderedHost.connectGame({
      protocolVersions: ['1'],
      manifest: {
        id: 'example-game', version: '1.0.0',
        requiredCapabilities: ['runtime', 'logging'], optionalCapabilities: [],
      },
    });
    const orderedLog = orderedHost.postLog({
      session_id: 'ordered-log-session', game_type: 'example-game',
      level: 'info', category: 'runtime', event: 'before_end', message: 'before end',
    }, { 'X-CSRF-Token': 'test-token' });
    const orderedEnd = orderedHost.end({ reason: 'ordered-end' });
    await orderedLogStarted;
    assert(!orderedCalls.some((pathName) => /\/end$/.test(pathName)),
      'explicit route end overtook a healthy final-log flush');
    releaseOrderedLog();
    await orderedLog;
    await orderedEnd;
    assert(orderedCalls.indexOf('/api/game/logs') < orderedCalls.findIndex((pathName) => /\/end$/.test(pathName)),
      'explicit route end was sent before its queued log');
    orderedHost.dispose();
  }

  // Page exit cannot await, but SDK disposal must not abort the keepalive log
  // fallback that flushLogger started after sendBeacon declined it.
  {
    let releaseExitLog;
    let markExitLogStarted;
    let exitLogAborted = false;
    const exitLogGate = new Promise((resolve) => { releaseExitLog = resolve; });
    const exitLogStarted = new Promise((resolve) => { markExitLogStarted = resolve; });
    const preservedFetch = async (url, init = {}) => {
      const pathName = String(url);
      if (pathName === '/api/game/logs') {
        init.signal?.addEventListener('abort', () => { exitLogAborted = true; }, { once: true });
        markExitLogStarted();
        await exitLogGate;
        return jsonResponse({ ok: true });
      }
      if (/\/end$/.test(pathName)) return jsonResponse(RAW_END_RESPONSE);
      return jsonResponse({ ok: true });
    };
    const preservedHost = createHost({
      gameType: 'example-game',
      sessionId: 'preserved-log-session',
      fetchImpl: preservedFetch,
      windowImpl: windowMock,
      navigatorImpl: { ...windowMock.navigator, sendBeacon: () => false },
    });
    preservedHost.connectGame({
      protocolVersions: ['1'],
      manifest: {
        id: 'example-game', version: '1.0.0',
        requiredCapabilities: ['runtime', 'logging'], optionalCapabilities: [],
      },
    });
    const preservedLog = preservedHost.postLog({
      session_id: 'preserved-log-session', game_type: 'example-game',
      level: 'info', category: 'runtime', event: 'page_exit', message: 'page exit',
    }, { 'X-CSRF-Token': 'test-token' });
    await preservedHost.end({ reason: 'pagehide' }, { useBeacon: true });
    await exitLogStarted;
    preservedHost.dispose({
      preservePendingOperations: ['route_end'],
      preserveLogTransport: true,
    });
    await Promise.resolve();
    assert(exitLogAborted === false,
      'page-exit disposal aborted the keepalive final-log fallback');
    releaseExitLog();
    const preservedResult = await preservedLog;
    assert(preservedResult?.ok === true && exitLogAborted === false,
      'the preserved page-exit log did not settle successfully');
  }

  // Preservation must also drain the host-owned overflow summary. When the
  // queue was full at dispose time, that summary is created only after an
  // in-flight request settles -- after public capabilities have been cleared.
  // Sending it through postLog() used to throw capability_denied inside the
  // fetch-finally callback, leaving flush waiters and the transport resident.
  {
    let releaseOverflowLog;
    let markOverflowLogStarted;
    let overflowLogCalls = 0;
    const overflowLogGate = new Promise((resolve) => { releaseOverflowLog = resolve; });
    const overflowLogStarted = new Promise((resolve) => { markOverflowLogStarted = resolve; });
    const overflowBodies = [];
    const overflowFetch = async (url, init = {}) => {
      const pathName = String(url);
      if (pathName === '/api/game/logs') {
        overflowLogCalls += 1;
        overflowBodies.push(JSON.parse(init.body));
        if (overflowLogCalls === 1) {
          markOverflowLogStarted();
          await overflowLogGate;
        }
        return jsonResponse({ ok: true });
      }
      if (/\/end$/.test(pathName)) return jsonResponse(RAW_END_RESPONSE);
      return jsonResponse({ ok: true });
    };
    const overflowHost = createHost({
      gameType: 'example-game',
      sessionId: 'preserved-overflow-session',
      fetchImpl: overflowFetch,
      windowImpl: windowMock,
      navigatorImpl: { ...windowMock.navigator, sendBeacon: () => false },
      logQueueLimit: 1,
      logConcurrency: 1,
      logPumpIntervalMs: 1,
    });
    overflowHost.connectGame({
      protocolVersions: ['1'],
      manifest: {
        id: 'example-game', version: '1.0.0',
        requiredCapabilities: ['runtime', 'logging'], optionalCapabilities: [],
      },
    });
    const firstOverflowLog = overflowHost.postLog({
      session_id: 'preserved-overflow-session', game_type: 'example-game',
      level: 'info', category: 'runtime', event: 'before_overflow', message: 'before overflow',
    }, { 'X-CSRF-Token': 'test-token' });
    overflowHost._pumpLogQueue({ force: true });
    await overflowLogStarted;
    const droppedOverflowLog = await overflowHost.postLog({
      session_id: 'preserved-overflow-session', game_type: 'example-game',
      level: 'info', category: 'runtime', event: 'overflow', message: 'overflow',
    }, { 'X-CSRF-Token': 'test-token' });
    assert(droppedOverflowLog?.reason === 'queue_overflow',
      'the page-exit overflow probe did not fill the log queue');
    await overflowHost.end({ reason: 'pagehide' }, { useBeacon: true });
    overflowHost.dispose({
      preservePendingOperations: ['route_end'],
      preserveLogTransport: true,
    });
    releaseOverflowLog();
    await firstOverflowLog;
    for (let turn = 0; turn < 5 && !overflowHost._logTransport.disposed; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert(overflowLogCalls === 2
      && overflowBodies[1]?.event === 'log_queue_overflow',
    'page-exit preservation dropped the delayed overflow summary');
    assert(overflowHost._logTransport.disposed === true
      && overflowHost._logTransport.flushWaiters.length === 0,
    'page-exit overflow left the preserved log drain resident');
  }

  // Two windows for the same game each scanned the namespace, each saw the
  // same pre-write key count, and each committed -- so the documented per-game
  // bounds could be pushed past what either write checked. Scan and commit are
  // one critical section now.
  {
    const sharedStorage = storage();
    // A Web Locks stand-in that actually queues per name, which the default
    // fixture mock does not: `request(name, opts, cb) => cb()` runs both
    // callbacks concurrently and would make this probe pass without the fix.
    const heldLocks = new Map();
    const lockCalls = [];
    let insideNamespaceLock = 0;
    let sawConcurrentCriticalSections = false;
    const serializingNavigator = {
      sendBeacon: () => false,
      locks: {
        request: async (name, _options, callback) => {
          lockCalls.push(name);
          const previous = heldLocks.get(name) || Promise.resolve();
          let release;
          const mine = new Promise((resolve) => { release = resolve; });
          heldLocks.set(name, previous.then(() => mine));
          await previous;
          insideNamespaceLock += 1;
          if (insideNamespaceLock > 1) sawConcurrentCriticalSections = true;
          try { return await callback(); } finally {
            insideNamespaceLock -= 1;
            release();
          }
        },
      },
    };
    const quotaWindow = {
      ...windowMock,
      navigator: serializingNavigator,
      localStorage: sharedStorage,
    };
    const quotaPeers = [];
    for (const peerIndex of [0, 1]) {
      const peer = createHost({
        gameType: 'example-game',
        sessionId: `quota-peer-${peerIndex}`,
        fetchImpl,
        windowImpl: quotaWindow,
        navigatorImpl: serializingNavigator,
      });
      peer.connectGame({
        protocolVersions: ['1'],
        manifest: {
          id: 'example-game',
          version: '1.0.0',
          requiredCapabilities: ['runtime', 'logging'],
          optionalCapabilities: ['storage'],
        },
      });
      quotaPeers.push(peer);
    }
    // One key short of the documented limit, so exactly one of the two
    // concurrent writes below can legitimately land.
    const quotaPrefix = quotaPeers[0]._gameStoragePrefix();
    for (let index = 0; index < 255; index += 1) {
      sharedStorage.setItem(`${quotaPrefix}seed-${index}`, '"x"');
    }
    // Instrumented only AFTER seeding: from here on, every namespace scan and
    // every commit must be observed with the namespace lock held. Asserting
    // that `locks.request` was called is not enough -- an implementation that
    // scanned and wrote first and only then requested an empty lock would
    // satisfy that, and localStorage here is synchronous so nothing else would
    // notice.
    const observedOutsideLock = [];
    let scannedInsideLock = 0;
    let wroteInsideLock = 0;
    const rawSetItem = sharedStorage.setItem.bind(sharedStorage);
    const rawKey = sharedStorage.key.bind(sharedStorage);
    sharedStorage.setItem = (key, value) => {
      if (insideNamespaceLock) wroteInsideLock += 1;
      else observedOutsideLock.push(`setItem:${key}`);
      return rawSetItem(key, value);
    };
    sharedStorage.key = (index) => {
      if (insideNamespaceLock) scannedInsideLock += 1;
      else observedOutsideLock.push(`key:${index}`);
      return rawKey(index);
    };
    const quotaResults = await Promise.allSettled([
      Promise.resolve().then(() => quotaPeers[0].requestGameStorage(
        'set', { key: 'peer-a', value: 'a' },
      )),
      Promise.resolve().then(() => quotaPeers[1].requestGameStorage(
        'set', { key: 'peer-b', value: 'b' },
      )),
    ]);
    const quotaAccepted = quotaResults.filter((entry) => entry.status === 'fulfilled');
    const quotaRejected = quotaResults.filter((entry) => entry.status === 'rejected');
    assert(quotaAccepted.length === 1 && quotaRejected.length === 1,
      `concurrent writes from two windows both passed the key limit: ${
        quotaResults.map((entry) => entry.status).join(',')}`);
    assert(quotaRejected[0].reason?.code === 'quota_exceeded',
      'the losing concurrent write failed for a reason other than the quota');
    // rawKey, not the instrumented wrapper: this loop is the test counting for
    // itself, and routing it through the probe would report the harness as an
    // out-of-lock namespace scan.
    let quotaKeyCount = 0;
    for (let index = 0; index < sharedStorage.length; index += 1) {
      if (String(rawKey(index) || '').startsWith(quotaPrefix)) quotaKeyCount += 1;
    }
    assert(quotaKeyCount === 256,
      `the namespace ended up with ${quotaKeyCount} keys past its 256 bound`);
    // The two assertions above hold with or without the lock: both hosts live
    // in ONE JS context here, so their synchronous scan+commit cannot actually
    // interleave. The real race is across windows, which this harness cannot
    // stage -- so what is pinned here is the mechanism that closes it: each
    // write ran inside the namespace-wide Web Lock, and no two critical
    // sections were ever open at once.
    const namespaceLockName = `${quotaPrefix}lock:__namespace__`;
    assert(lockCalls.filter((name) => name === namespaceLockName).length === 2,
      `storage writes did not take the namespace lock: ${JSON.stringify(lockCalls)}`);
    assert(!sawConcurrentCriticalSections,
      'two storage critical sections were open at the same time');
    assert(observedOutsideLock.length === 0,
      `the quota scan or the commit ran outside the namespace lock: ${
        JSON.stringify(observedOutsideLock.slice(0, 8))}`);
    // The probe really did touch storage, so the assertion above cannot pass
    // by observing nothing at all.
    assert(scannedInsideLock > 0 && wroteInsideLock > 0,
      `the probe observed no scan/commit at all: scans=${scannedInsideLock} writes=${wroteInsideLock}`);
    sharedStorage.setItem = rawSetItem;
    sharedStorage.key = rawKey;
    for (const peer of quotaPeers) peer.dispose();
  }

  process.stdout.write('mini-game same-origin host runtime test passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
