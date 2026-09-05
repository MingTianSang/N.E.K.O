/**
 * Temporary trusted same-origin N.E.K.O mini-game host boundary.
 *
 * This is an internal migration adapter, not the public mini-game SDK. It is
 * intentionally allowed to know the current mini-game REST endpoints while
 * games are moved away from direct host requests. Game rules, state and UI
 * must stay outside this file and be supplied as plain payloads/callbacks.
 * Fixed same-origin BroadcastChannels are trusted delivery fallbacks, not an
 * isolation boundary. Untrusted games require a future private iframe/Electron
 * transport and must not be loaded into this phase-one host.
 */
(() => {
  'use strict';

  const FACTORY_PROPERTY = 'createNekoMiniGameSameOriginHost';
  const existingFactory = Object.getOwnPropertyDescriptor(window, FACTORY_PROPERTY);
  if (existingFactory && existingFactory.configurable === false) return;

  const DEFAULT_GAME_VERSION = '1.0.0';
  const SDK_PROTOCOL_VERSION = '1';
  const TRUSTED_HOST_VERSION = 'neko-trusted-same-origin-v1';
  const DEFAULT_HEARTBEAT_TIMEOUT_MS = 4500;
  const DEFAULT_LOG_ENABLE_TIMEOUT_MS = 3500;
  const DEFAULT_ROUTE_END_LOG_FLUSH_TIMEOUT_MS = 1500;
  const DEFAULT_LOG_QUEUE_LIMIT = 256;
  const DEFAULT_LOG_CONCURRENCY = 2;
  const DEFAULT_LOG_PUMP_INTERVAL_MS = 25;
  const DEFAULT_LOG_REQUEST_TIMEOUT_MS = 8000;
  const DEFAULT_LOG_AGGREGATE_LIMIT = 128;
  const DEFAULT_LOG_SUMMARY_INTERVAL_MS = 5000;
  const DEFAULT_LOG_RECOVERY_QUIET_MS = 5000;
  const DEFAULT_LOG_FLUSH_WAITER_LIMIT = 8;
  const DEFAULT_LOG_OVERFLOW_SIGNATURE_LIMIT = 64;
  // `details` is already truncated leaf by leaf, but `message` was verbatim.
  // The global console.warn/error capture joins every argument into it, so one
  // accidental data URL or serialized snapshot becomes a multi-megabyte body --
  // and the queue holds up to 256 of them before anything is sent.
  const LOG_MESSAGE_MAX_CHARS = 4096;
  const LOG_MESSAGE_PRESERVED_MAX_CHARS = 64 * 1024;
  // The Fetch keepalive body quota is 64 KiB and it is SHARED across every
  // in-flight keepalive request from this context -- the diagnostic logger uses
  // keepalive too. A body past this threshold makes fetch reject before the
  // request leaves the page, so leave headroom rather than sitting on the cap.
  const KEEPALIVE_BODY_BYTES = 60 * 1024;
  // Cumulative budget for one log payload's `details`, across the whole walk.
  const LOG_DETAILS_MAX_CHARS = 32 * 1024;
  // The only caller-sized field a shed page-exit body keeps.
  const ROUTE_END_ESSENTIAL_REASON_CHARS = 512;
  const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
  const DEFAULT_PENDING_REQUEST_LIMIT = 64;
  const DEFAULT_PROTOCOL_QUEUE_LIMIT = 64;
  const HOST_COMMAND_ROUTE_LIMIT = 64;
  const DEFAULT_COMMAND_REQUEST_BYTES = 256 * 1024;
  const MAX_COMMAND_REQUEST_BYTES = 2 * 1024 * 1024;
  const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
  const MAX_COMMAND_TIMEOUT_MS = 6 * 60 * 1000;
  const DEFAULT_SPEECH_RESTART_DELAY_MS = 350;
  const DEFAULT_SPEECH_SLOT_LIMIT = 4;
  const DEFAULT_SPEECH_TAP_RECONNECT_LIMIT = 4;
  const DEFAULT_SPEECH_TAP_RECONNECT_DELAY_MS = 400;
  const DEFAULT_SPEECH_TAP_READY_TIMEOUT_MS = 5000;
  const DEFAULT_SPEECH_TAP_REQUEST_READY_TIMEOUT_MS = 5000;
  const DEFAULT_SPEECH_TAP_PING_INTERVAL_MS = 15000;
  // Leave headroom above the host's 12s microphone start/stop confirmation so
  // its explicit failure state wins instead of racing the transport timeout.
  const DEFAULT_VOICE_CONTROL_TIMEOUT_MS = 15000;
  const DEFAULT_VOICE_CONTROL_PENDING_LIMIT = 4;
  const DEFAULT_STORAGE_LOCK_TIMEOUT_MS = 8000;
  const DEFAULT_STORAGE_LOCK_PENDING_LIMIT = 16;
  const VOICE_CONTROL_WINDOW_EVENT = 'neko-game-voice-control-message';
  const GAME_STORAGE_KEY_LIMIT = 256;
  const GAME_STORAGE_VALUE_BYTES = 64 * 1024;
  const GAME_STORAGE_TOTAL_BYTES = 1024 * 1024;
  const HOST_LAUNCH_REGISTRY_LIMIT = 64;
  const HOST_REGISTRATION_CAPABILITY_LIMIT = 32;
  const HOST_LOCALE_LISTENER_LIMIT = 32;
  const HOST_LOCALE_STORAGE_KEYS = Object.freeze(['neko_i18n_language', 'i18nextLng']);
  const HOST_LOCALE_IDENTITY_FIELDS = Object.freeze([
    'i18n_language', 'i18nLanguage',
    'language', 'lang', 'locale',
    'user_language', 'userLanguage',
    'current_language', 'currentLanguage',
  ]);
  const AVATAR_CHARACTER_LIMIT = 256;
  const AVATAR_CHARACTER_NAME_CHARS = 128;
  const AVATAR_MODEL_PATH_CHARS = 2048;
  const AVATAR_MODEL_TYPES = Object.freeze(['live2d', 'vrm', 'mmd', 'pngtuber']);
  const GLOBAL_CONSOLE_CAPTURE_REGISTRIES = new WeakMap();
  const MEMORY_POLICY_NORMALIZED_SUFFIXES = Object.freeze([
    'gamememoryenabled',
    'gameplayerinteractionmemoryenabled',
    'gamememoryplayerinteractionenabled',
    'gameeventreplymemoryenabled',
    'gamememoryeventreplyenabled',
    'gamearchivememoryenabled',
    'gamememoryarchiveenabled',
    'gamepostgamecontextmemoryenabled',
    'gamememorypostgamecontextenabled',
  ]);
  // The route-end response carries the host's internal archive, which includes
  // captured dialogue, the in-session summary and the pregame context. Game
  // code is the untrusted party here, so the archive is projected against the
  // capabilities the game was actually granted before it leaves this adapter.
  // Allow-list, never deny-list: a new archive field must be classified on
  // purpose rather than leak by default.
  const ROUTE_END_ARCHIVE_BASE_FIELDS = Object.freeze([
    'game_type',
    'session_id',
    'lanlan_name',
    'created_at',
    'ended_at',
    'game_started',
    'game_started_elapsed_ms',
    'dialog_count',
    'finalScore',
    'last_state',
    'nekoInitiated',
    'user_language',
    'user_language_source',
    'game_context_degraded',
  ]);
  // Exactly what the capability-gated context endpoint already exposes.
  const ROUTE_END_ARCHIVE_CONTEXT_FIELDS = Object.freeze([
    'preGameContext',
    'pre_game_context_source',
    'pre_game_context_error',
    'game_context_summary',
  ]);
  // The game's own submissions, handed back to the game that made them.
  const ROUTE_END_ARCHIVE_MEMORY_FIELDS = Object.freeze(['sdk_memory_submissions']);
  const ROUTE_END_RESULT_FIELDS = Object.freeze([
    'ok',
    'closed',
    'route_closed',
    'session_id',
    'reason',
  ]);
  const ROUTE_END_POSTGAME_FIELDS = Object.freeze(['ok', 'action', 'reason', 'mode']);
  // The one thing a launch registration actually gates that same-origin script
  // cannot reach some other way: the host-supplied capability provider closures.
  // Namespaced storage keys and /api/game/<type>/... routes are reachable by any
  // same-origin script regardless, and the adapter deliberately accepts a
  // caller-supplied windowImpl/fetchImpl, so it was never an isolation boundary.
  // Keeping the closures off a public `_`-prefixed property at least means they
  // require a completed connectGame() and a granted capability rather than a
  // bare read off a freshly constructed host.
  const HOST_CAPABILITY_PROVIDERS = new WeakMap();
  const HOST_AVATAR_PROVIDERS = new WeakMap();
  const HOST_COMMAND_ROUTES = new WeakMap();
  const HOST_DECLARED_COMMANDS = new WeakMap();

  const TRUSTED_PAYLOAD_MAX_DEPTH = 24;
  const TRUSTED_PAYLOAD_MAX_NODES = 4096;
  // Depth and node counts measure structure only: a string is one node however
  // many bytes it holds, and keys are not measured at all. The SDK bounds every
  // other egress path at 256 KiB, but the runtime lifecycle payload -- what
  // configure({payload}) returns, and the runtime.start/end arguments -- had no
  // byte bound anywhere, so an honest mistake (stuffing a replay buffer or a
  // base64 frame into it) became multi-megabyte POSTs at the heartbeat and
  // drain cadence. Deliberately the same 256 KiB the SDK already uses: a
  // smaller round number here would reject payloads the SDK has just accepted,
  // and cumulative content bytes are always <= the serialised size the SDK
  // measures on the same object, so this cannot reject what the SDK admitted.
  const TRUSTED_PAYLOAD_MAX_CONTENT_BYTES = 256 * 1024;
  const TRUSTED_PAYLOAD_OMIT = Symbol('trusted-payload-omit');

  function normalizeHostLocaleLanguage(value) {
    if (typeof value !== 'string') return null;
    const raw = value.trim();
    if (!raw || raw.length > 64) return null;
    const normalized = raw.replace(/_/g, '-').toLowerCase();
    if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(normalized)) return null;
    if (normalized === 'zh' || normalized === 'cn'
      || normalized === 'zh-cn' || normalized === 'zh-sg'
      || normalized.startsWith('zh-hans')) return 'zh-CN';
    if (normalized === 'tw' || normalized === 'zh-tw'
      || normalized === 'zh-hk' || normalized === 'zh-mo'
      || normalized.startsWith('zh-hant')) return 'zh-TW';
    if (normalized === 'jp' || normalized === 'ja' || normalized.startsWith('ja-')) return 'ja';
    if (normalized === 'kr' || normalized === 'ko' || normalized.startsWith('ko-')) return 'ko';
    for (const language of ['en', 'ru', 'pt', 'es']) {
      if (normalized === language || normalized.startsWith(`${language}-`)) return language;
    }
    return null;
  }

  function resolveTrustedHostLocale(windowImpl) {
    const candidates = [];
    try { candidates.push(windowImpl?.i18next?.language); } catch (_) { /* hostile getter */ }
    try { candidates.push(windowImpl?.__nekoI18nLanguage); } catch (_) { /* hostile getter */ }
    try { candidates.push(windowImpl?.NEKO_I18N_LANGUAGE); } catch (_) { /* hostile getter */ }
    try { candidates.push(windowImpl?.document?.documentElement?.lang); } catch (_) { /* hostile getter */ }
    try {
      const storage = windowImpl?.localStorage;
      if (storage && typeof storage.getItem === 'function') {
        for (const key of HOST_LOCALE_STORAGE_KEYS) candidates.push(storage.getItem(key));
      }
    } catch (_) { /* unavailable host storage */ }
    for (const candidate of candidates) {
      const language = normalizeHostLocaleLanguage(candidate);
      if (language) return language;
    }
    return 'en';
  }

  function removeLocaleIdentityPayloadKeys(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of HOST_LOCALE_IDENTITY_FIELDS) delete value[key];
  }

  function isMemoryPolicyPayloadKey(key) {
    const normalized = String(key || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    if (normalized === 'memoryenabled' || normalized === 'enablegamememory') return true;
    return MEMORY_POLICY_NORMALIZED_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
  }

  function removeMemoryPolicyPayloadKeys(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    for (const key of Object.keys(value)) {
      if (isMemoryPolicyPayloadKey(key)) delete value[key];
    }
  }

  function cloneTrustedJsonData(
    value,
    state = {
      nodes: 0,
      bytes: 0,
      seen: new Set(),
      maxBytes: TRUSTED_PAYLOAD_MAX_CONTENT_BYTES,
    },
    depth = 0,
  ) {
    if (depth > TRUSTED_PAYLOAD_MAX_DEPTH || state.nodes >= TRUSTED_PAYLOAD_MAX_NODES) {
      throw new TypeError('invalid_payload');
    }
    state.nodes += 1;
    if (typeof value === 'string') {
      state.bytes = (state.bytes || 0) + utf8ByteLength(value);
      if (state.bytes > state.maxBytes) throw new TypeError('invalid_payload');
      return value;
    }
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (['undefined', 'function', 'symbol'].includes(typeof value)) return TRUSTED_PAYLOAD_OMIT;
    if (typeof value === 'bigint') throw new TypeError('invalid_payload');
    if (state.seen.has(value)) throw new TypeError('invalid_payload');
    state.seen.add(value);
    try {
      if (Array.isArray(value)) {
        return value.map((item) => {
          const cloned = cloneTrustedJsonData(item, state, depth + 1);
          return cloned === TRUSTED_PAYLOAD_OMIT ? null : cloned;
        });
      }
      const result = {};
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) continue;
        if (key === 'toJSON') continue;
        // Keys carry bytes too, and a payload can be all keys and no values.
        state.bytes = (state.bytes || 0) + utf8ByteLength(key);
        if (state.bytes > state.maxBytes) throw new TypeError('invalid_payload');
        const cloned = cloneTrustedJsonData(descriptor.value, state, depth + 1);
        if (cloned !== TRUSTED_PAYLOAD_OMIT) result[key] = cloned;
      }
      return result;
    } finally {
      state.seen.delete(value);
    }
  }

  class NekoMiniGameHostError extends Error {
    constructor(code, message, details = {}) {
      super(message);
      this.name = 'NekoMiniGameHostError';
      this.code = String(code || 'request_failed');
      this.status = Number(details.status || 0);
      this.operation = String(details.operation || 'request');
      this.requestId = String(details.requestId || '');
      if (details.cause !== undefined) this.cause = details.cause;
    }
  }

  function csrfTokenFromHeaders(headers = {}) {
    return headers['X-CSRF-Token'] || headers['x-csrf-token'] || '';
  }

  function jsonBody(payload, mutationHeaders = {}) {
    const token = csrfTokenFromHeaders(mutationHeaders);
    const bodyPayload = token ? { ...payload, _csrf_token: token } : payload;
    return JSON.stringify(bodyPayload);
  }

  function boundedPositiveInteger(value, fallback, maximum) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
    return Math.max(1, Math.min(Math.floor(numeric), maximum));
  }

  function utf8ByteLength(value) {
    const text = String(value || '');
    const TextEncoderImpl = globalThis.TextEncoder;
    return typeof TextEncoderImpl === 'function'
      ? new TextEncoderImpl().encode(text).byteLength
      : unescape(encodeURIComponent(text)).length;
  }

  function normalizeCommandRoutes(value) {
    if (value === undefined) return Object.freeze({});
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    if (entries.length > HOST_COMMAND_ROUTE_LIMIT) return null;
    const routes = Object.create(null);
    for (const [name, rawPolicy] of entries) {
      if (!/^[a-z][a-z0-9:-]{0,63}$/.test(name)) return null;
      if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) return null;
      if (Object.keys(rawPolicy).some((key) => !['path', 'maxRequestBytes', 'maxTimeoutMs'].includes(key))) {
        return null;
      }
      const path = rawPolicy.path;
      if (
        typeof path !== 'string'
        || !/^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*$/.test(path)
      ) return null;
      const maxRequestBytes = rawPolicy.maxRequestBytes === undefined
        ? DEFAULT_COMMAND_REQUEST_BYTES
        : rawPolicy.maxRequestBytes;
      const maxTimeoutMs = rawPolicy.maxTimeoutMs === undefined
        ? DEFAULT_COMMAND_TIMEOUT_MS
        : rawPolicy.maxTimeoutMs;
      if (
        !Number.isInteger(maxRequestBytes)
        || maxRequestBytes < 1
        || maxRequestBytes > MAX_COMMAND_REQUEST_BYTES
        || !Number.isInteger(maxTimeoutMs)
        || maxTimeoutMs < 250
        || maxTimeoutMs > MAX_COMMAND_TIMEOUT_MS
      ) return null;
      routes[name] = Object.freeze({ path, maxRequestBytes, maxTimeoutMs });
    }
    return Object.freeze(routes);
  }

  function normalizeAvatarCharacterDescriptor(value) {
    if (value == null) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('invalid_avatar_descriptor');
    }
    if (typeof value.name !== 'string') throw new TypeError('invalid_avatar_descriptor');
    const name = value.name.trim();
    if (!name || name.length > AVATAR_CHARACTER_NAME_CHARS) {
      throw new TypeError('invalid_avatar_descriptor');
    }
    let model = null;
    if (value.model != null) {
      if (!value.model || typeof value.model !== 'object' || Array.isArray(value.model)) {
        throw new TypeError('invalid_avatar_descriptor');
      }
      if (typeof value.model.type !== 'string' || typeof value.model.path !== 'string') {
        throw new TypeError('invalid_avatar_descriptor');
      }
      const type = value.model.type.trim().toLowerCase();
      const path = value.model.path.trim();
      if (!AVATAR_MODEL_TYPES.includes(type) || !path || path.length > AVATAR_MODEL_PATH_CHARS) {
        throw new TypeError('invalid_avatar_descriptor');
      }
      model = Object.freeze({ type, path });
    }
    return Object.freeze({
      name,
      model,
      rendererAvailable: Boolean(model && value.rendererAvailable !== false),
    });
  }

  function normalizeAvatarCharacterNames(value) {
    if (!Array.isArray(value) || value.length > AVATAR_CHARACTER_LIMIT) {
      throw new TypeError('invalid_avatar_character_list');
    }
    const names = [];
    const seen = new Set();
    for (const rawName of value) {
      if (typeof rawName !== 'string') throw new TypeError('invalid_avatar_character_list');
      const name = rawName.trim();
      if (!name || name.length > AVATAR_CHARACTER_NAME_CHARS || seen.has(name)) continue;
      seen.add(name);
      names.push(name);
    }
    return Object.freeze(names);
  }

  function normalizeLaunchRegistration(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const gameId = String(value.gameId || '').trim();
    const routeGameType = String(value.routeGameType || gameId).trim();
    const version = String(value.version || '').trim();
    const mode = String(value.mode || '').trim();
    if (
      !gameId
      || gameId.length > 128
      || !/^[a-z][a-z0-9_-]{0,127}$/.test(routeGameType)
      || !version
      || version.length > 64
      || !['registered', 'development'].includes(mode)
    ) return null;
    const commandRoutes = normalizeCommandRoutes(value.commandRoutes);
    if (!commandRoutes) return null;
    const allowedCapabilities = Object.freeze([
      ...new Set(
        (Array.isArray(value.allowedCapabilities) ? value.allowedCapabilities : [])
          .map((name) => String(name || '').trim())
          .filter((name) => Boolean(name) && name.length <= 64),
      ),
    ].slice(0, HOST_REGISTRATION_CAPABILITY_LIMIT));
    return Object.freeze({
      mode,
      gameId,
      routeGameType,
      publisherId: (
        String(value.publisherId || '').trim().slice(0, 128)
        || (mode === 'development' ? 'local-development' : 'unknown-publisher')
      ),
      version,
      allowedCapabilities,
      commandRoutes,
    });
  }

  function consumeHostLaunchRegistry() {
    const adapterScript = window.document?.currentScript;
    const rawRegistry = adapterScript?.nekoHostLaunchRegistry;
    try { delete adapterScript?.nekoHostLaunchRegistry; }
    catch (_) { /* the bootstrap also clears the script-scoped binding on load */ }
    const registrations = new Map();
    const capabilityProviders = new Map();
    if (!rawRegistry || typeof rawRegistry !== 'object' || Array.isArray(rawRegistry)) {
      return { registrations, capabilityProviders };
    }
    for (const [key, rawRegistration] of Object.entries(rawRegistry)) {
      if (registrations.size >= HOST_LAUNCH_REGISTRY_LIMIT) break;
      const registration = normalizeLaunchRegistration(rawRegistration);
      if (!registration || registration.gameId !== String(key || '').trim()) continue;
      registrations.set(registration.gameId, registration);
      const rawProviders = rawRegistration.capabilityProviders;
      capabilityProviders.set(registration.gameId, Object.freeze({
        quickLines: typeof rawProviders?.quickLines === 'function'
          ? rawProviders.quickLines
          : null,
        avatarHostFactory: typeof rawProviders?.avatarHostFactory === 'function'
          ? rawProviders.avatarHostFactory
          : null,
        windowClose: typeof rawProviders?.windowClose === 'function'
          ? rawProviders.windowClose
          : null,
      }));
    }
    return { registrations, capabilityProviders };
  }

  // Consumed exactly once before game code can connect. The exported factory
  // can select host-owned records/providers but cannot add, replace, or mutate
  // them.
  const HOST_BOOTSTRAP = consumeHostLaunchRegistry();

  function randomIdSuffix(windowImpl) {
    const cryptoImpl = windowImpl?.crypto || globalThis.crypto;
    const values = cryptoImpl?.getRandomValues?.(new Uint32Array(2));
    if (values) return `${values[0].toString(36)}${values[1].toString(36)}`;
    return `${Math.floor(Math.random() * 0xffffffff).toString(36)}`
      + `${Math.floor(Math.random() * 0xffffffff).toString(36)}`;
  }

  class NekoMiniGameSameOriginHost {
    constructor(options = {}) {
      // The internal host bootstrap owns this immutable record. A game manifest
      // may request an identity/capability, but cannot mint a registered result
      // from its own values. A future marketplace can replace the bootstrap's
      // resolver without changing the public game handshake.
      const normalizedLaunchRegistration = normalizeLaunchRegistration(options.launchRegistration);
      if (!normalizedLaunchRegistration) {
        throw new NekoMiniGameHostError(
          'game_unregistered',
          'A host-issued launchRegistration is required',
          { operation: 'construct' },
        );
      }
      HOST_COMMAND_ROUTES.set(this, normalizedLaunchRegistration.commandRoutes);
      HOST_DECLARED_COMMANDS.set(this, new Set());
      // Route policies remain in the bootstrap-owned WeakMap. Even the
      // transport object handed to public game code cannot enumerate endpoint
      // mappings from its registration record.
      this._launchRegistration = Object.freeze({
        mode: normalizedLaunchRegistration.mode,
        gameId: normalizedLaunchRegistration.gameId,
        routeGameType: normalizedLaunchRegistration.routeGameType,
        publisherId: normalizedLaunchRegistration.publisherId,
        version: normalizedLaunchRegistration.version,
        allowedCapabilities: normalizedLaunchRegistration.allowedCapabilities,
      });
      const requestedGameType = String(options.gameType || '').trim();
      const requestedGameVersion = String(options.gameVersion || '').trim();
      if (
        (requestedGameType && requestedGameType !== this._launchRegistration.gameId)
        || (requestedGameVersion && requestedGameVersion !== this._launchRegistration.version)
      ) {
        throw new NekoMiniGameHostError(
          'game_unregistered',
          'The requested game identity does not match the host launch registration',
          { operation: 'construct' },
        );
      }
      this.gameType = this._launchRegistration.gameId;
      // Public SDK identifiers intentionally use the portable hyphenated
      // manifest grammar. Existing built-in routes may still have a legacy
      // underscore slug; only the trusted launch registration can provide
      // that host-internal mapping.
      Object.defineProperty(this, 'routeGameType', {
        value: this._launchRegistration.routeGameType,
        enumerable: true,
        configurable: false,
        writable: false,
      });
      this.gameVersion = this._launchRegistration.version || DEFAULT_GAME_VERSION;
      this.source = String(options.source || '').trim() || `${this.gameType}_demo`;
      this.displayName = String(options.displayName || '').trim() || this.gameType || 'Mini-game';
      if (!this.gameType) {
        throw new NekoMiniGameHostError('invalid_request', 'gameType is required', {
          operation: 'construct',
        });
      }
      this._session = {
        // The generated fallback used to be timestamp-only, so two hosts for the
        // same game constructed in the same millisecond started life with the
        // SAME client session id -- and every endpoint keys route identity on
        // session_id, so one window's requests answer for the other's route.
        id: String(options.sessionId || '').trim()
          || `${this.gameType}_${Date.now().toString(36)}_${randomIdSuffix(options.windowImpl || window)}`,
        lanlanName: '',
      };
      this._fetchImpl = options.fetchImpl || window.fetch.bind(window);
      this._navigator = options.navigatorImpl || window.navigator;
      this._window = options.windowImpl || window;
      this._console = this._window.console || console;
      this._grantedCapabilities = new Set();
      // Renderer providers are selected from the bootstrap-owned registry.
      // A same-origin game may pass an `avatarHost` option to the factory, but
      // it must never be able to mint or replace this privileged capability.
      HOST_AVATAR_PROVIDERS.set(this, options.trustedAvatarHost || null);
      this._audioHost = options.audioHost || null;
      const capabilityProviders = options.capabilityProviders && typeof options.capabilityProviders === 'object'
        ? options.capabilityProviders
        : {};
      HOST_CAPABILITY_PROVIDERS.set(this, Object.freeze({
        quickLines: typeof capabilityProviders.quickLines === 'function'
          ? capabilityProviders.quickLines
          : null,
        windowClose: typeof capabilityProviders.windowClose === 'function'
          ? capabilityProviders.windowClose
          : null,
      }));
      this._disposed = false;
      this._hostLocale = {
        language: resolveTrustedHostLocale(this._window),
        revision: 1,
        listeners: new Set(),
        windowHandler: null,
      };
      this._hostLocale.windowHandler = () => this._refreshHostLocale();
      this._memoryConsentEnabled = false;
      this._controlBridge = {
        active: false,
        sequence: 0,
        onControl: null,
        onError: null,
      };
      this._nextRequestId = 0;
      this._pendingRequestLimit = boundedPositiveInteger(
        options.pendingRequestLimit,
        DEFAULT_PENDING_REQUEST_LIMIT,
        1024,
      );
      this._pendingRequests = new Map();
      this._pendingStorageLockLimit = boundedPositiveInteger(
        options.storageLockPendingLimit,
        DEFAULT_STORAGE_LOCK_PENDING_LIMIT,
        64,
      );
      this._pendingStorageLockControllers = new Set();
      this._protocolQueueLimit = boundedPositiveInteger(
        options.protocolQueueLimit,
        DEFAULT_PROTOCOL_QUEUE_LIMIT,
        256,
      );
      this._protocolQueueDepth = 0;
      this._protocolQueueTail = Promise.resolve();
      this._logTransport = {
        queue: [],
        queueLimit: boundedPositiveInteger(options.logQueueLimit, DEFAULT_LOG_QUEUE_LIMIT, 4096),
        concurrency: boundedPositiveInteger(options.logConcurrency, DEFAULT_LOG_CONCURRENCY, 16),
        pumpIntervalMs: boundedPositiveInteger(
          options.logPumpIntervalMs,
          DEFAULT_LOG_PUMP_INTERVAL_MS,
          60000,
        ),
        requestTimeoutMs: boundedPositiveInteger(
          options.logRequestTimeoutMs,
          DEFAULT_LOG_REQUEST_TIMEOUT_MS,
          60000,
        ),
        pumpTimer: null,
        inFlight: new Map(),
        nextRequestId: 0,
        flushWaiters: [],
        overflowDropped: 0,
        overflowReasons: {},
        overflowSignatures: new Set(),
        overflowContext: null,
        overflowNotified: false,
        disposed: false,
      };
      this._speechSlotLimit = boundedPositiveInteger(options.speechSlotLimit, DEFAULT_SPEECH_SLOT_LIMIT, 16);
      this._speechRecognitionSlots = new Map();
      this._speechPlaybackBridge = {
        channel: null,
        storageHandler: null,
        windowEventHandler: null,
        windowEventName: '',
        acceptState: null,
        lastStateFingerprint: '',
        onState: null,
        onError: null,
      };
      this._speechOutputBridgeActive = false;
      this._activeRouteIdentity = null;
      this._speechAudioTap = {
        socket: null,
        route: null,
        routeToken: 0,
        socketToken: 0,
        ready: false,
        manualClose: false,
        permanentFailure: false,
        reconnectAttempts: 0,
        reconnectLimit: boundedPositiveInteger(
          options.speechTapReconnectLimit,
          DEFAULT_SPEECH_TAP_RECONNECT_LIMIT,
          16,
        ),
        reconnectDelayMs: boundedPositiveInteger(
          options.speechTapReconnectDelayMs,
          DEFAULT_SPEECH_TAP_RECONNECT_DELAY_MS,
          30000,
        ),
        readyTimeoutMs: boundedPositiveInteger(
          options.speechTapReadyTimeoutMs,
          DEFAULT_SPEECH_TAP_READY_TIMEOUT_MS,
          60000,
        ),
        requestReadyTimeoutMs: boundedPositiveInteger(
          options.speechTapRequestReadyTimeoutMs,
          DEFAULT_SPEECH_TAP_REQUEST_READY_TIMEOUT_MS,
          15000,
        ),
        pingIntervalMs: boundedPositiveInteger(
          options.speechTapPingIntervalMs,
          DEFAULT_SPEECH_TAP_PING_INTERVAL_MS,
          60000,
        ),
        reconnectTimer: null,
        readyTimer: null,
        pingTimer: null,
        messageTail: Promise.resolve(),
        blobQueue: [],
        blobDrainPromise: null,
        readyWaiters: new Set(),
        ownerId: `speech-tap-${Date.now().toString(36)}-${randomIdSuffix(options.windowImpl || window)}`,
        WebSocketImpl: options.WebSocketImpl || null,
      };
      this._voiceControlBridge = {
        channel: null,
        storageHandler: null,
        windowEventHandler: null,
        storageKey: '',
        senderId: `game-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
        nextRequestId: 0,
        pending: new Map(),
        pendingLimit: boundedPositiveInteger(
          options.voiceControlPendingLimit,
          DEFAULT_VOICE_CONTROL_PENDING_LIMIT,
          16,
        ),
        onState: null,
        onTranscript: null,
        onError: null,
        lastState: null,
        seenMessageIds: new Set(),
        seenMessageOrder: [],
      };
      this._logger = {
        enabled: false,
        enabledSessionId: '',
        enableInFlight: false,
        enablePromise: null,
        enableController: null,
        enableGeneration: 0,
        enableTimeoutId: null,
        enableTimeoutResolve: null,
        mutationHeaders: null,
        contextProvider: null,
        enableTimeoutMs: DEFAULT_LOG_ENABLE_TIMEOUT_MS,
        aggregateLimit: DEFAULT_LOG_AGGREGATE_LIMIT,
        summaryIntervalMs: DEFAULT_LOG_SUMMARY_INTERVAL_MS,
        recoveryQuietMs: DEFAULT_LOG_RECOVERY_QUIET_MS,
        maintenanceTimer: null,
        aggregates: new Map(),
        originalWarn: null,
        originalError: null,
        consoleWarnHandler: null,
        consoleErrorHandler: null,
        windowErrorHandler: null,
        rejectionHandler: null,
        consoleCaptureRegistry: null,
      };
      this.logger = Object.freeze({
        log: this.log.bind(this),
        info: (category, event, message, details = {}, sensitivePossible = false, logOptions = {}) => (
          this.log('info', category, event, message, details, sensitivePossible, logOptions)
        ),
        warn: (category, event, message, details = {}, sensitivePossible = false, logOptions = {}) => (
          this.log('warning', category, event, message, details, sensitivePossible, logOptions)
        ),
        error: (category, event, message, details = {}, sensitivePossible = false, logOptions = {}) => (
          this.log('error', category, event, message, details, sensitivePossible, logOptions)
        ),
        enable: this.enableLogger.bind(this),
        enableAfterRouteStart: this.enableLoggerAfterRouteStart.bind(this),
        flush: this.flushLogger.bind(this),
        reset: this.resetLogger.bind(this),
      });
      this._window.addEventListener?.('localechange', this._hostLocale.windowHandler);
    }

    _hostLocaleSnapshot() {
      return Object.freeze({
        language: this._hostLocale.language,
        revision: this._hostLocale.revision,
      });
    }

    _refreshHostLocale() {
      if (this._disposed) return;
      const language = resolveTrustedHostLocale(this._window);
      if (language === this._hostLocale.language) return;
      if (this._hostLocale.revision >= Number.MAX_SAFE_INTEGER) return;
      this._hostLocale.language = language;
      this._hostLocale.revision += 1;
      const snapshot = this._hostLocaleSnapshot();
      for (const listener of Array.from(this._hostLocale.listeners)) {
        try { listener(snapshot); }
        catch (error) {
          this._console.error?.(`[${this.displayName}Host] locale listener failed:`, error);
        }
      }
    }

    subscribeHostLocale(listener) {
      if (this._disposed) {
        throw this._hostError('disposed', `${this.displayName} host adapter has been disposed`, {
          operation: 'host_locale_subscribe',
        });
      }
      if (typeof listener !== 'function') {
        throw this._hostError('invalid_request', 'Host locale listener must be a function', {
          operation: 'host_locale_subscribe',
        });
      }
      if (this._hostLocale.listeners.size >= HOST_LOCALE_LISTENER_LIMIT) {
        throw this._hostError('busy', 'Host locale listener limit reached', {
          operation: 'host_locale_subscribe',
        });
      }
      this._hostLocale.listeners.add(listener);
      try { listener(this._hostLocaleSnapshot()); }
      catch (error) {
        this._console.error?.(`[${this.displayName}Host] locale listener failed:`, error);
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        this._hostLocale.listeners.delete(listener);
      };
    }

    connectGame(request = {}) {
      if (this._disposed) {
        throw this._hostError('disposed', `${this.displayName} host adapter has been disposed`, {
          operation: 'connect',
        });
      }
      const manifest = request.manifest && typeof request.manifest === 'object'
        ? request.manifest
        : {};
      const protocolVersions = Array.isArray(request.protocolVersions)
        ? request.protocolVersions.map((value) => String(value || ''))
        : [];
      if (!protocolVersions.includes(SDK_PROTOCOL_VERSION)) {
        return {
          accepted: false,
          code: 'incompatible_version',
          message: `The ${this.displayName} host does not support the requested SDK protocol`,
        };
      }
      const registration = this._launchRegistration;
      if (String(manifest.id || '') !== registration.gameId || String(manifest.version || '') !== registration.version) {
        return {
          accepted: false,
          code: 'game_unregistered',
          message: `The requested ${this.displayName} game identity is not registered by this host`,
        };
      }
      const commandRoutes = HOST_COMMAND_ROUTES.get(this) || {};
      const declaredCommands = manifest.contracts?.commands;
      const commandNames = declaredCommands && typeof declaredCommands === 'object'
        && !Array.isArray(declaredCommands)
        ? Object.keys(declaredCommands)
        : [];
      const missingCommandRoutes = commandNames.filter(
        (name) => !Object.prototype.hasOwnProperty.call(commandRoutes, name),
      );
      if (missingCommandRoutes.length) {
        return {
          accepted: false,
          code: 'capability_unavailable',
          message: `The ${this.displayName} host does not provide every declared game command`,
        };
      }
      HOST_DECLARED_COMMANDS.set(this, new Set(commandNames));
      const requested = [
        ...(Array.isArray(manifest.requiredCapabilities) ? manifest.requiredCapabilities : []),
        ...(Array.isArray(manifest.optionalCapabilities) ? manifest.optionalCapabilities : []),
      ];
      const avatarProvider = HOST_AVATAR_PROVIDERS.get(this);
      const locallyAvailable = new Set([
        'runtime',
        'dialogue',
        ...(HOST_CAPABILITY_PROVIDERS.get(this)?.quickLines ? ['quick-lines'] : []),
        'logging',
        'voice-input',
        'speech-output',
        'context-read',
        'memory',
        ...(HOST_CAPABILITY_PROVIDERS.get(this)?.windowClose ? ['window-control'] : []),
        ...(this._canUseGameStorage() ? ['storage'] : []),
        ...(this._canUseGameStorage() && this._canUseGameStorageLock() ? ['leaderboard-local'] : []),
        ...(
          avatarProvider
          && typeof avatarProvider.mount === 'function'
          && typeof avatarProvider.listCharacters === 'function'
          && (
            typeof avatarProvider.getCharacter === 'function'
            || typeof avatarProvider.getCurrentCharacter === 'function'
          )
            ? ['avatar-renderer']
            : []
        ),
        ...(this._audioHost ? ['audio'] : []),
      ]);
      const allowedCapabilities = new Set(registration.allowedCapabilities);
      const grantedCapabilities = [...new Set(requested)].filter((name) => (
        locallyAvailable.has(name)
        && allowedCapabilities.has(name)
      ));
      this._grantedCapabilities = new Set(grantedCapabilities);
      return {
        accepted: true,
        protocolVersion: SDK_PROTOCOL_VERSION,
        hostVersion: TRUSTED_HOST_VERSION,
        registration: {
          mode: registration.mode,
          gameId: registration.gameId,
          publisherId: registration.publisherId,
          version: registration.version,
        },
        grantedCapabilities,
        locale: this._hostLocaleSnapshot(),
      };
    }

    _requireGrantedCapability(name, operation) {
      if (!this._grantedCapabilities.has(String(name || ''))) {
        throw this._hostError(
          'capability_denied',
          `${String(name || 'Unknown')} capability was not granted to this launch`,
          { operation: String(operation || name || 'capability') },
        );
      }
    }

    _requireAnyGrantedCapability(names, operation) {
      const requested = Array.isArray(names) ? names : [names];
      if (requested.some((name) => this._grantedCapabilities.has(String(name || '')))) return;
      throw this._hostError(
        'capability_denied',
        `${requested.map((name) => String(name || '')).join(' or ')} capability was not granted to this launch`,
        { operation: String(operation || 'capability') },
      );
    }

    _canUseGameStorage() {
      try {
        const storage = this._window.localStorage;
        return !!storage
          && typeof storage.getItem === 'function'
          && typeof storage.setItem === 'function'
          && typeof storage.removeItem === 'function';
      } catch (_) {
        return false;
      }
    }

    _gameStoragePrefix() {
      return `neko:minigame-storage:v1:${encodeURIComponent(this.gameType)}:${encodeURIComponent(this.gameVersion)}:`;
    }

    _canUseGameStorageLock() {
      return typeof this._navigator?.locks?.request === 'function';
    }

    _withGameStorageNamespaceLock(callback) {
      // Ordinary storage writes read the whole namespace to compute the quota
      // and then commit, so two windows for the same game could each scan the
      // same pre-write total, both pass, and both write -- pushing the
      // documented per-game bounds past what either one checked. Same
      // origin-wide primitive the leaderboard mutations already use, under one
      // name for the whole namespace because the bound itself is namespace-wide.
      //
      // Returns the callback's value UNCHANGED when the Web Locks API is
      // missing, so a browser without it behaves exactly as before rather than
      // suddenly handing callers a promise they never had to await.
      if (!this._canUseGameStorageLock()) return callback();
      return this._navigator.locks.request(
        `${this._gameStoragePrefix()}lock:__namespace__`,
        { mode: 'exclusive' },
        callback,
      );
    }

    async runGameStorageExclusive(lockNameInput, callback, options = {}) {
      this._requireGrantedCapability('leaderboard-local', 'game_storage_lock');
      if (this._disposed) {
        throw this._hostError('disposed', `${this.displayName} host adapter has been disposed`, {
          operation: 'game_storage_lock',
        });
      }
      if (!this._canUseGameStorageLock()) {
        throw this._hostError('capability_unavailable', 'Cross-window game storage locking is unavailable', {
          operation: 'game_storage_lock',
        });
      }
      if (typeof callback !== 'function') {
        throw this._hostError('invalid_request', 'Game storage lock callback is required', {
          operation: 'game_storage_lock',
        });
      }
      const lockName = String(lockNameInput || '').trim();
      if (!lockName || lockName.length > 128) {
        throw this._hostError('invalid_request', 'Game storage lock name is invalid', {
          operation: 'game_storage_lock',
        });
      }
      if (this._pendingStorageLockControllers.size >= this._pendingStorageLockLimit) {
        throw this._hostError('busy', 'Game storage lock request limit reached', {
          operation: 'game_storage_lock',
        });
      }
      const AbortControllerImpl = this._window.AbortController || globalThis.AbortController;
      const controller = new AbortControllerImpl();
      this._pendingStorageLockControllers.add(controller);
      const externalSignal = options.signal;
      const abortFromExternal = () => controller.abort(externalSignal?.reason);
      if (externalSignal?.aborted) abortFromExternal();
      else externalSignal?.addEventListener?.('abort', abortFromExternal, { once: true });
      const timeoutMs = boundedPositiveInteger(
        options.timeoutMs,
        DEFAULT_STORAGE_LOCK_TIMEOUT_MS,
        60000,
      );
      let acquired = false;
      let timeoutId = this._window.setTimeout(() => controller.abort(), timeoutMs);
      const qualifiedName = `${this._gameStoragePrefix()}lock:${lockName}`;
      try {
        return await this._navigator.locks.request(
          qualifiedName,
          { mode: 'exclusive', signal: controller.signal },
          async () => {
            acquired = true;
            this._pendingStorageLockControllers.delete(controller);
            this._window.clearTimeout(timeoutId);
            timeoutId = null;
            if (this._disposed) {
              throw this._hostError('disposed', `${this.displayName} host adapter has been disposed`, {
                operation: 'game_storage_lock',
              });
            }
            return callback();
          },
        );
      } catch (error) {
        if (!acquired && controller.signal.aborted) {
          const reason = this._disposed ? 'disposed' : (externalSignal?.aborted ? 'cancelled' : 'timeout');
          throw this._hostError(reason, 'Game storage lock was not acquired', {
            operation: 'game_storage_lock',
            cause: error,
          });
        }
        throw error;
      } finally {
        this._pendingStorageLockControllers.delete(controller);
        if (timeoutId != null) this._window.clearTimeout(timeoutId);
        externalSignal?.removeEventListener?.('abort', abortFromExternal);
      }
    }

    requestGameStorage(operationInput, payload = {}, options = {}) {
      this._requireAnyGrantedCapability(['storage', 'leaderboard-local'], 'game_storage');
      if (options.signal?.aborted) {
        throw this._hostError('cancelled', 'Game storage request was cancelled', {
          operation: 'game_storage',
        });
      }
      if (this._disposed) {
        throw this._hostError('disposed', `${this.displayName} host adapter has been disposed`, {
          operation: 'game_storage',
        });
      }
      if (!this._canUseGameStorage()) {
        throw this._hostError('capability_unavailable', 'Local game storage is unavailable', {
          operation: 'game_storage',
        });
      }
      const operation = String(operationInput || '').trim();
      const key = String(payload.key || '').trim();
      if (!['get', 'set', 'delete', 'list', 'clear'].includes(operation)) {
        throw this._hostError('unsupported', 'Game storage operation is unsupported', {
          operation: 'game_storage',
        });
      }
      if (operation !== 'clear' && operation !== 'list'
          && (!key || key.length > 128 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(key))) {
        throw this._hostError('invalid_request', 'Game storage key is invalid', {
          operation: 'game_storage',
        });
      }
      const storage = this._window.localStorage;
      const namespace = this._gameStoragePrefix();
      const storageKey = `${namespace}${key}`;
      if (operation === 'get') {
        const raw = storage.getItem(storageKey);
        if (raw == null) return { ok: true, found: false };
        if (utf8ByteLength(raw) > GAME_STORAGE_VALUE_BYTES) {
          return { ok: true, found: false, corrupted: true };
        }
        try { return { ok: true, found: true, value: JSON.parse(raw) }; }
        catch (_) { return { ok: true, found: false, corrupted: true }; }
      }
      if (operation === 'delete') {
        storage.removeItem(storageKey);
        return { ok: true, deleted: true };
      }
      if (operation === 'list') {
        const prefix = String(payload.prefix || '');
        const limit = Math.max(1, Math.min(Number(payload.limit || 100) || 100, GAME_STORAGE_KEY_LIMIT));
        const keys = [];
        for (let index = 0; index < storage.length && keys.length < limit; index += 1) {
          const candidate = storage.key(index);
          if (!candidate || !candidate.startsWith(namespace)) continue;
          const publicKey = candidate.slice(namespace.length);
          if (publicKey.startsWith(prefix)) keys.push(publicKey);
        }
        keys.sort();
        return { ok: true, keys };
      }
      if (operation === 'clear') {
        if (payload.confirm !== true) {
          throw this._hostError('invalid_request', 'Game storage clear requires confirmation', {
            operation: 'game_storage',
          });
        }
        const keys = [];
        for (let index = 0; index < storage.length; index += 1) {
          const candidate = storage.key(index);
          if (candidate?.startsWith(namespace)) keys.push(candidate);
        }
        for (const candidate of keys) storage.removeItem(candidate);
        return { ok: true, cleared: keys.length };
      }

      let serialized;
      try { serialized = JSON.stringify(payload.value); }
      catch (_) {
        throw this._hostError('invalid_request', 'Game storage value must be JSON-compatible', {
          operation: 'game_storage',
        });
      }
      if (serialized === undefined) {
        throw this._hostError('invalid_request', 'Game storage value must be JSON-compatible', {
          operation: 'game_storage',
        });
      }
      const valueBytes = utf8ByteLength(serialized);
      if (valueBytes > GAME_STORAGE_VALUE_BYTES) {
        throw this._hostError('quota_exceeded', 'Game storage value exceeds its size limit', {
          operation: 'game_storage',
        });
      }
      // Scan and commit are one critical section: a total measured before
      // another window's write is not the total this write is bounded by.
      return this._withGameStorageNamespaceLock(() => {
        let keyCount = 0;
        let totalBytes = 0;
        let existingBytes = 0;
        for (let index = 0; index < storage.length; index += 1) {
          const candidate = storage.key(index);
          if (!candidate || !candidate.startsWith(namespace)) continue;
          keyCount += 1;
          const candidateValue = storage.getItem(candidate) || '';
          const candidateBytes = utf8ByteLength(candidateValue);
          totalBytes += candidateBytes;
          if (candidate === storageKey) existingBytes = candidateBytes;
        }
        if (!existingBytes && keyCount >= GAME_STORAGE_KEY_LIMIT) {
          throw this._hostError('quota_exceeded', 'Game storage key limit reached', {
            operation: 'game_storage',
          });
        }
        if (totalBytes - existingBytes + valueBytes > GAME_STORAGE_TOTAL_BYTES) {
          throw this._hostError('quota_exceeded', 'Game storage quota reached', {
            operation: 'game_storage',
          });
        }
        try { storage.setItem(storageKey, serialized); }
        catch (error) {
          throw this._hostError('quota_exceeded', 'Game storage write failed', {
            operation: 'game_storage',
            cause: error,
          });
        }
        return { ok: true, stored: true };
      });
    }

    async mountAvatar(config) {
      this._requireGrantedCapability('avatar-renderer', 'avatar.mount');
      if (this._disposed) {
        throw this._hostError('disposed', `${this.displayName} host adapter has been disposed`, {
          operation: 'avatar.mount',
        });
      }
      const provider = HOST_AVATAR_PROVIDERS.get(this);
      if (!provider || typeof provider.mount !== 'function') {
        throw this._hostError('capability_unavailable', 'Avatar renderer host is unavailable', {
          operation: 'avatar.mount',
        });
      }
      return provider.mount(config);
    }

    async getAvatarCharacter(name = '') {
      this._requireGrantedCapability('avatar-renderer', 'avatar.getCharacter');
      if (this._disposed) {
        throw this._hostError('disposed', `${this.displayName} host adapter has been disposed`, {
          operation: 'avatar.getCharacter',
        });
      }
      if (typeof name !== 'string') {
        throw this._hostError('invalid_request', 'Avatar character name must be a string', {
          operation: 'avatar.getCharacter',
        });
      }
      const requestedName = name.trim();
      if (requestedName.length > AVATAR_CHARACTER_NAME_CHARS) {
        throw this._hostError('invalid_request', 'Avatar character name is too long', {
          operation: 'avatar.getCharacter',
        });
      }
      const provider = HOST_AVATAR_PROVIDERS.get(this);
      if (!provider || (
        typeof provider.getCharacter !== 'function'
        && typeof provider.getCurrentCharacter !== 'function'
      )) {
        throw this._hostError('capability_unavailable', 'Avatar character provider is unavailable', {
          operation: 'avatar.getCharacter',
        });
      }
      try {
        const value = requestedName
          ? await provider.getCharacter(requestedName)
          : await (provider.getCurrentCharacter?.() ?? provider.getCharacter(''));
        return normalizeAvatarCharacterDescriptor(value);
      } catch (error) {
        if (error instanceof NekoMiniGameHostError) throw error;
        throw this._hostError(
          error?.code || 'request_failed',
          'Avatar character lookup failed',
          { operation: 'avatar.getCharacter', cause: error },
        );
      }
    }

    async listAvatarCharacters() {
      this._requireGrantedCapability('avatar-renderer', 'avatar.listCharacters');
      if (this._disposed) {
        throw this._hostError('disposed', `${this.displayName} host adapter has been disposed`, {
          operation: 'avatar.listCharacters',
        });
      }
      const provider = HOST_AVATAR_PROVIDERS.get(this);
      if (!provider || typeof provider.listCharacters !== 'function') {
        throw this._hostError('capability_unavailable', 'Avatar character provider is unavailable', {
          operation: 'avatar.listCharacters',
        });
      }
      try {
        return normalizeAvatarCharacterNames(await provider.listCharacters());
      } catch (error) {
        if (error instanceof NekoMiniGameHostError) throw error;
        throw this._hostError(
          error?.code || 'request_failed',
          'Avatar character listing failed',
          { operation: 'avatar.listCharacters', cause: error },
        );
      }
    }

    mountAudio(config) {
      this._requireGrantedCapability('audio', 'audio.mount');
      if (this._disposed) {
        throw this._hostError('disposed', `${this.displayName} host adapter has been disposed`, {
          operation: 'audio.mount',
        });
      }
      if (!this._audioHost || typeof this._audioHost.mount !== 'function') {
        throw this._hostError('capability_unavailable', 'Audio host is unavailable', {
          operation: 'audio.mount',
        });
      }
      return this._audioHost.mount(config);
    }

    _gameEndpoint(path) {
      return `/api/game/${encodeURIComponent(this.routeGameType)}/${path}`;
    }

    _hostError(code, message, details = {}) {
      return new NekoMiniGameHostError(code, message, details);
    }

    _requestId(operation = 'request') {
      this._nextRequestId = (this._nextRequestId + 1) % Number.MAX_SAFE_INTEGER;
      return `${operation}-${Date.now().toString(36)}-${this._nextRequestId.toString(36)}`;
    }

    async _request(url, init = {}, options = {}) {
      const operation = String(options.operation || 'request');
      if (this._disposed) {
        throw this._hostError('disposed', `${this.displayName} host adapter has been disposed`, { operation });
      }
      if (this._pendingRequests.size >= this._pendingRequestLimit) {
        throw this._hostError('busy', `${this.displayName} host pending request limit reached`, { operation });
      }

      const requestId = this._requestId(operation);
      const AbortControllerImpl = this._window.AbortController || globalThis.AbortController;
      if (typeof AbortControllerImpl !== 'function') {
        throw this._hostError('unsupported', 'AbortController is unavailable', { operation, requestId });
      }
      const controller = new AbortControllerImpl();
      const externalSignal = options.signal || init.signal || null;
      const timeoutMs = Math.max(1, Number(options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS));
      const entry = {
        operation,
        controller,
        timeoutId: null,
        externalSignal,
        externalAbortHandler: null,
        cancelReason: '',
      };

      if (externalSignal?.aborted) {
        throw this._hostError('cancelled', `${this.displayName} host request was cancelled`, { operation, requestId });
      }
      if (externalSignal && typeof externalSignal.addEventListener === 'function') {
        entry.externalAbortHandler = () => {
          if (!entry.cancelReason) entry.cancelReason = 'cancelled';
          try { controller.abort(); } catch (_) { /* already aborted */ }
        };
        externalSignal.addEventListener('abort', entry.externalAbortHandler, { once: true });
      }
      entry.timeoutId = this._window.setTimeout(() => {
        if (!entry.cancelReason) entry.cancelReason = 'timeout';
        try { controller.abort(); } catch (_) { /* already aborted */ }
      }, timeoutMs);
      this._pendingRequests.set(requestId, entry);

      try {
        return await this._fetchImpl(url, { ...init, signal: controller.signal });
      } catch (error) {
        const code = entry.cancelReason || (error?.name === 'AbortError' ? 'cancelled' : 'network_error');
        const message = code === 'timeout'
          ? `${this.displayName} host request timed out after ${timeoutMs}ms`
          : code === 'disposed'
            ? `${this.displayName} host adapter was disposed during request`
            : code === 'cancelled'
              ? `${this.displayName} host request was cancelled`
              : `${this.displayName} host request failed`;
        throw this._hostError(code, message, { operation, requestId, cause: error });
      } finally {
        if (entry.timeoutId != null) this._window.clearTimeout(entry.timeoutId);
        if (entry.externalSignal && entry.externalAbortHandler) {
          entry.externalSignal.removeEventListener?.('abort', entry.externalAbortHandler);
        }
        this._pendingRequests.delete(requestId);
      }
    }

    cancelPendingRequests(reason = 'cancelled', options = {}) {
      const normalizedReason = reason === 'disposed' ? 'disposed' : 'cancelled';
      const preserveOperations = options.preserveOperations instanceof Set
        ? options.preserveOperations
        : new Set(options.preserveOperations || []);
      for (const entry of this._pendingRequests.values()) {
        if (preserveOperations.has(entry.operation)) continue;
        entry.cancelReason = normalizedReason;
        try { entry.controller.abort(); } catch (_) { /* already aborted */ }
      }
    }

    get sessionId() {
      return this._session.id;
    }

    get routeLanlanName() {
      return this._session.lanlanName;
    }

    getRuntimeState() {
      return {
        sessionId: this.sessionId,
        characterName: this.routeLanlanName,
      };
    }

    resetRuntime(options = {}) {
      const state = this.resetSession(options);
      return {
        sessionId: state.sessionId,
        characterName: state.lanlanName,
      };
    }

    applyRuntimeState(state = {}) {
      const applied = this.applyRouteState(state);
      return {
        sessionId: applied.sessionId,
        characterName: applied.lanlanName,
      };
    }

    resetSession({ newSession = false } = {}) {
      this._retireActiveSpeechRoute('runtime_reset');
      if (newSession || !this._session.id) {
        this._cancelVoiceControlRequests('cancelled');
        // Same entropy as the constructor's generator: a reset that mints a
        // timestamp-only id can hand a "new" session the identity another
        // window is already using, or -- within the same millisecond -- hand
        // back the identity it just claimed to replace.
        this._session.id = `${this.gameType}_${Date.now().toString(36)}_${randomIdSuffix(this._window)}`;
      }
      this._memoryConsentEnabled = false;
      this._session.lanlanName = '';
      return { sessionId: this.sessionId, lanlanName: this.routeLanlanName };
    }

    applyRouteState(state = {}) {
      const previousSessionId = this.sessionId;
      const previousLanlanName = this.routeLanlanName;
      const sessionId = String(state?.session_id || state?.sessionId || '').trim();
      const lanlanName = String(state?.lanlan_name || '').trim();
      if (sessionId) this._session.id = sessionId;
      if (lanlanName) this._session.lanlanName = lanlanName;
      if (
        this._activeRouteIdentity
        && (
          (sessionId && sessionId !== this._activeRouteIdentity.sessionId)
          || (lanlanName && lanlanName !== this._activeRouteIdentity.lanlanName)
          || (previousSessionId !== this.sessionId && this.sessionId !== this._activeRouteIdentity.sessionId)
          || (previousLanlanName !== this.routeLanlanName
            && this.routeLanlanName !== this._activeRouteIdentity.lanlanName)
        )
      ) {
        this._retireActiveSpeechRoute('route_identity_changed');
      }
      return { sessionId: this.sessionId, lanlanName: this.routeLanlanName };
    }

    _trustedRuntimePayload(payload = {}, options = {}) {
      const source = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload
        : {};
      let trusted;
      try {
        trusted = cloneTrustedJsonData(source, {
          nodes: 0,
          bytes: 0,
          seen: new Set(),
          maxBytes: boundedPositiveInteger(
            options.maxContentBytes,
            TRUSTED_PAYLOAD_MAX_CONTENT_BYTES,
            MAX_COMMAND_REQUEST_BYTES,
          ),
        });
      } catch (cause) {
        throw this._hostError('invalid_payload', `${this.displayName} host payload is invalid`, {
          operation: 'trusted_runtime_payload',
          cause,
        });
      }
      removeMemoryPolicyPayloadKeys(trusted);
      removeLocaleIdentityPayloadKeys(trusted);
      for (const nestedKey of ['event', 'currentState', 'current_state']) {
        const nested = trusted[nestedKey];
        if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
          removeMemoryPolicyPayloadKeys(nested);
          removeLocaleIdentityPayloadKeys(nested);
        }
      }
      this._refreshHostLocale();
      const memoryEnabled = (
        this._grantedCapabilities.has('memory')
        && this._memoryConsentEnabled === true
      );
      return {
        ...trusted,
        session_id: this.sessionId,
        // The backend route identity is host-owned just like the session. A
        // game may use a portable manifest id while the built-in endpoint
        // still has a legacy slug, but it must not be able to redirect a
        // trusted runtime request by supplying its own game_type field.
        game_type: this.routeGameType,
        ...(this.routeLanlanName ? { lanlan_name: this.routeLanlanName } : {}),
        i18n_language: this._hostLocale.language,
        game_memory_enabled: memoryEnabled,
        game_memory_player_interaction_enabled: memoryEnabled,
        game_memory_event_reply_enabled: memoryEnabled,
        game_memory_archive_enabled: memoryEnabled,
        game_memory_postgame_context_enabled: memoryEnabled,
      };
    }

    _post(path, payload, options = {}) {
      return this._request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        body: typeof payload === 'string' ? payload : JSON.stringify(payload),
        ...(options.credentials ? { credentials: options.credentials } : {}),
        ...(options.keepalive ? { keepalive: true } : {}),
      }, {
        operation: options.operation || 'post',
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
    }

    _postWithCsrf(path, payload, options = {}) {
      return this.withCsrfRetry((headers) => this._post(path, jsonBody(payload, headers), {
        ...options,
        headers: { ...headers, ...(options.headers || {}) },
        credentials: options.credentials || 'same-origin',
      }));
    }

    async getCharacter(lanlanName = '') {
      this._requireGrantedCapability('avatar-renderer', 'character');
      const url = new URL(this._gameEndpoint('character'), this._window.location.origin);
      if (lanlanName && lanlanName !== this.source) {
        url.searchParams.set('lanlan_name', lanlanName);
      }
      const response = await this._request(url.toString(), {}, {
        operation: 'character',
        timeoutMs: 10000,
      });
      if (response.ok) {
        try {
          const payload = await response.clone().json();
          const resolvedName = String(payload?.lanlan_name || '').trim();
          if (resolvedName) this._session.lanlanName = resolvedName;
        } catch (_) { /* character metadata remains available to the caller */ }
      }
      return response;
    }

    getQuickLines(payload, options = {}) {
      this._requireGrantedCapability('quick-lines', 'quick_lines');
      if (this._disposed) {
        return Promise.reject(this._hostError(
          'disposed',
          `${this.displayName} host adapter has been disposed`,
          { operation: 'quick_lines' },
        ));
      }
      if (options.signal?.aborted) {
        return Promise.reject(this._hostError(
          'cancelled',
          'The quick-lines request was cancelled',
          { operation: 'quick_lines' },
        ));
      }
      const providers = HOST_CAPABILITY_PROVIDERS.get(this);
      if (!providers?.quickLines) {
        return Promise.reject(this._hostError(
          'capability_unavailable',
          'The host did not register a quick-lines provider for this game',
          { operation: 'quick_lines' },
        ));
      }
      return Promise.resolve(providers.quickLines(
        this._trustedRuntimePayload(payload),
        options,
        Object.freeze({
          gameId: this.gameType,
          version: this.gameVersion,
          sessionId: this.sessionId,
        }),
      ));
    }

    requestWindowClose(options = {}) {
      this._requireGrantedCapability('window-control', 'window_close');
      if (this._disposed) {
        return Promise.reject(this._hostError(
          'disposed',
          `${this.displayName} host adapter has been disposed`,
          { operation: 'window_close' },
        ));
      }
      if (options.signal?.aborted) {
        return Promise.reject(this._hostError(
          'cancelled',
          'The window-close request was cancelled',
          { operation: 'window_close' },
        ));
      }
      const providers = HOST_CAPABILITY_PROVIDERS.get(this);
      if (!providers?.windowClose) {
        return Promise.reject(this._hostError(
          'capability_unavailable',
          'The trusted host window-control provider is unavailable',
          { operation: 'window_close' },
        ));
      }
      try {
        // The bootstrap captured and bound this function before game code ran.
        // Do not pass caller-controlled values across the privileged boundary.
        return Promise.resolve(providers.windowClose());
      } catch (error) {
        return Promise.reject(error);
      }
    }

    requestDialogue(payload, options = {}) {
      this._requireGrantedCapability('dialogue', 'dialogue');
      return this._post(this._gameEndpoint('chat'), this._trustedRuntimePayload(payload), {
        timeoutMs: 60000,
        operation: 'dialogue',
        ...options,
      });
    }

    async start(payload, options = {}) {
      this._requireGrantedCapability('runtime', 'route_start');
      const trustedPayload = this._trustedRuntimePayload(payload);
      const requestedRouteInstanceId = String(trustedPayload.sdk_route_instance_id || '').trim();
      if (
        this._activeRouteIdentity
        && requestedRouteInstanceId
        && requestedRouteInstanceId !== this._activeRouteIdentity.routeInstanceId
      ) {
        this._stopSpeechAudioTap('route_generation_changed');
      }
      const response = await this._post(this._gameEndpoint('route/start'), trustedPayload, {
        timeoutMs: 60000,
        operation: 'route_start',
        ...options,
      });
      let data = null;
      try { data = await response.clone().json(); }
      catch (_) { /* the public SDK still owns response validation */ }
      const routeState = data?.state && typeof data.state === 'object' ? data.state : null;
      const routeActive = routeState?.game_route_active === true || data?.active === true;
      if (response.ok && data?.ok !== false && routeActive) {
        const route = {
          gameType: this.routeGameType,
          sessionId: String(routeState?.session_id || trustedPayload.session_id || '').trim(),
          lanlanName: String(routeState?.lanlan_name || trustedPayload.lanlan_name || '').trim(),
          routeInstanceId: requestedRouteInstanceId,
        };
        this._activeRouteIdentity = Object.freeze(route);
        if (this._speechOutputBridgeActive) this._bindSpeechAudioTap(route);
      } else if (response.ok && data?.ok !== false) {
        this._retireActiveSpeechRoute('route_start_inactive');
      }
      return response;
    }

    _retireSpeechRouteIfRuntimeInactive(data, routeInstanceId, source) {
      const state = data?.state && typeof data.state === 'object' ? data.state : null;
      const explicitlyInactive = data?.active === false || state?.game_route_active === false;
      if (!explicitlyInactive || !this._activeRouteIdentity) return false;
      const requestedGeneration = String(routeInstanceId || '').trim();
      if (
        requestedGeneration
        && requestedGeneration !== this._activeRouteIdentity.routeInstanceId
      ) return false;
      this._retireActiveSpeechRoute(source || 'runtime_inactive');
      return true;
    }

    async heartbeat(payload, options = {}) {
      this._requireGrantedCapability('runtime', 'route_heartbeat');
      const trustedPayload = this._trustedRuntimePayload(payload);
      const response = await this._post(this._gameEndpoint('route/heartbeat'), trustedPayload, {
        timeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
        operation: 'route_heartbeat',
        ...options,
      });
      try {
        const data = await response.clone().json();
        this._retireSpeechRouteIfRuntimeInactive(
          data,
          trustedPayload.sdk_route_instance_id,
          'route_heartbeat_inactive',
        );
      } catch (_) { /* the public SDK still owns response validation */ }
      return response;
    }

    async drain(payload, options = {}) {
      this._requireGrantedCapability('runtime', 'route_drain');
      const trustedPayload = this._trustedRuntimePayload(payload);
      const sourceRoute = Object.freeze({
        sessionId: String(trustedPayload.session_id || ''),
        routeInstanceId: String(trustedPayload.sdk_route_instance_id || ''),
      });
      const response = await this._post(
        this._gameEndpoint('route/drain'),
        trustedPayload,
        {
          timeoutMs: 8000,
          operation: 'route_drain',
          ...options,
        },
      );
      try {
        const data = await response.clone().json();
        this._retireSpeechRouteIfRuntimeInactive(
          data,
          sourceRoute.routeInstanceId,
          'route_drain_inactive',
        );
        this._dispatchGameControls(data?.outputs, sourceRoute);
      } catch (_) { /* the SDK still owns response validation */ }
      return response;
    }

    publishGameProtocol(kind, envelope = {}, options = {}) {
      this._requireGrantedCapability('runtime', 'game_protocol');
      if (this._disposed) {
        return Promise.reject(this._hostError(
          'disposed',
          `${this.displayName} host adapter has been disposed`,
          { operation: 'game_protocol' },
        ));
      }
      if (this._protocolQueueDepth >= this._protocolQueueLimit) {
        return Promise.reject(this._hostError(
          'busy',
          `${this.displayName} host protocol queue limit reached`,
          { operation: 'game_protocol' },
        ));
      }

      this._protocolQueueDepth += 1;
      const run = () => {
        if (this._disposed) {
          throw this._hostError(
            'disposed',
            `${this.displayName} host adapter has been disposed`,
            { operation: 'game_protocol' },
          );
        }
        return this._postWithCsrf(this._gameEndpoint('protocol'), this._trustedRuntimePayload({
          ...envelope,
          kind: String(kind || envelope.kind || ''),
        }), {
          timeoutMs: 8000,
          operation: 'game_protocol',
          ...options,
        });
      };
      const result = this._protocolQueueTail.then(run, run);
      this._protocolQueueTail = result.then(() => undefined, () => undefined);
      return result.finally(() => {
        this._protocolQueueDepth = Math.max(0, this._protocolQueueDepth - 1);
      });
    }

    async executeGameCommand(nameInput, envelope = {}, options = {}) {
      this._requireGrantedCapability('runtime', 'game_command');
      const name = String(nameInput || '').trim();
      const commandRoutes = HOST_COMMAND_ROUTES.get(this) || {};
      const policy = Object.prototype.hasOwnProperty.call(commandRoutes, name)
        ? commandRoutes[name]
        : null;
      if (!policy || !HOST_DECLARED_COMMANDS.get(this)?.has(name)) {
        throw this._hostError(
          'capability_denied',
          `The ${this.displayName} command is not declared for this launch`,
          { operation: 'game_command' },
        );
      }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
        throw this._hostError(
          'invalid_payload',
          `${this.displayName} command envelope must be an object`,
          { operation: 'game_command' },
        );
      }
      const protocolVersion = String(envelope.protocolVersion || envelope.protocol_version || '');
      const envelopeType = String(envelope.type || '').trim();
      const sequence = Number(envelope.sequence);
      const requestedSessionId = String(envelope.sessionId || envelope.session_id || '').trim();
      const routeInstanceId = String(
        envelope.routeInstanceId || envelope.sdk_route_instance_id || '',
      ).trim();
      if (
        protocolVersion !== SDK_PROTOCOL_VERSION
        || envelopeType !== name
        || !Number.isSafeInteger(sequence)
        || sequence <= 0
      ) {
        throw this._hostError(
          'invalid_payload',
          `${this.displayName} command envelope is invalid`,
          { operation: 'game_command' },
        );
      }
      const activeRouteIdentity = this._activeRouteIdentity;
      const routeIdentityIsCurrent = () => (
        !!activeRouteIdentity
        && this._activeRouteIdentity === activeRouteIdentity
        && activeRouteIdentity.gameType === this.routeGameType
        && activeRouteIdentity.sessionId === this.sessionId
        && activeRouteIdentity.lanlanName === this.routeLanlanName
        && activeRouteIdentity.routeInstanceId === routeInstanceId
        && requestedSessionId === activeRouteIdentity.sessionId
      );
      if (!requestedSessionId || !routeInstanceId || !routeIdentityIsCurrent()) {
        throw this._hostError(
          'session_invalid',
          `${this.displayName} command does not match the active runtime identity`,
          { operation: 'game_command' },
        );
      }
      if (!envelope.payload || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) {
        throw this._hostError(
          'invalid_payload',
          `${this.displayName} same-origin command payload must be an object`,
          { operation: 'game_command' },
        );
      }
      let payload;
      try {
        const commandPayload = cloneTrustedJsonData(envelope.payload, {
          nodes: 0,
          bytes: 0,
          seen: new Set(),
          maxBytes: policy.maxRequestBytes,
        });
        for (const key of [
          'session_id', 'sessionId', 'game_type', 'gameType',
          'lanlan_name', 'lanlanName', 'character_name', 'characterName',
          'window_lanlan_name', 'windowLanlanName',
          'sdk_route_instance_id', 'sdkRouteInstanceId',
          'sdk_route_instance_ids', 'routeInstanceId',
        ]) delete commandPayload[key];
        if (utf8ByteLength(JSON.stringify(commandPayload)) > policy.maxRequestBytes) {
          throw new TypeError('invalid_payload');
        }
        payload = this._trustedRuntimePayload({
          ...commandPayload,
          sdk_route_instance_id: routeInstanceId,
        }, { maxContentBytes: policy.maxRequestBytes });
      } catch (cause) {
        if (cause instanceof NekoMiniGameHostError) throw cause;
        throw this._hostError(
          'invalid_payload',
          `${this.displayName} command payload is invalid`,
          { operation: 'game_command', cause },
        );
      }
      const requestedTimeoutMs = boundedPositiveInteger(
        options.timeoutMs,
        DEFAULT_COMMAND_TIMEOUT_MS,
        MAX_COMMAND_TIMEOUT_MS,
      );
      const response = await this._postWithCsrf(
        this._gameEndpoint(policy.path),
        payload,
        {
          timeoutMs: Math.min(requestedTimeoutMs, policy.maxTimeoutMs),
          signal: options.signal,
          operation: 'game_command',
        },
      );
      if (!routeIdentityIsCurrent()) {
        throw this._hostError(
          'session_invalid',
          `${this.displayName} command response belongs to a retired runtime identity`,
          { operation: 'game_command' },
        );
      }
      return response;
    }

    startGameControlBridge(options = {}) {
      this._requireGrantedCapability('runtime', 'game_control_bridge');
      if (this._disposed) return false;
      this._controlBridge.active = true;
      this._controlBridge.onControl = typeof options.onControl === 'function'
        ? options.onControl
        : null;
      this._controlBridge.onError = typeof options.onError === 'function'
        ? options.onError
        : null;
      return true;
    }

    stopGameControlBridge() {
      this._controlBridge.active = false;
      this._controlBridge.onControl = null;
      this._controlBridge.onError = null;
    }

    _dispatchGameControls(outputs, sourceRoute = null) {
      const bridge = this._controlBridge;
      if (!bridge.active || !bridge.onControl || !Array.isArray(outputs)) return;
      const sessionId = String(sourceRoute?.sessionId || this.sessionId || '');
      const routeInstanceId = String(sourceRoute?.routeInstanceId || '');
      for (const output of outputs) {
        const control = output?.control || output?.result?.control;
        if (!control || typeof control !== 'object' || Array.isArray(control)) continue;
        for (const [type, payload] of Object.entries(control).slice(0, 64)) {
          bridge.sequence = (bridge.sequence % Number.MAX_SAFE_INTEGER) + 1;
          try {
            bridge.onControl({
              protocolVersion: SDK_PROTOCOL_VERSION,
              sequence: bridge.sequence,
              type,
              timestamp: (() => {
                const value = Number(output?.ts);
                if (!Number.isFinite(value) || value <= 0) return Date.now();
                return value < 100000000000 ? value * 1000 : value;
              })(),
              sessionId,
              ...(routeInstanceId ? { routeInstanceId } : {}),
              payload,
            });
          } catch (error) {
            try { bridge.onError?.(error, 'runtime_output'); }
            catch (_) { /* consumer error reporting must not break drain */ }
          }
        }
      }
    }

    readGameContext(payload, options = {}) {
      this._requireGrantedCapability('context-read', 'context_read');
      return this._postWithCsrf(
        this._gameEndpoint('context/read'),
        this._trustedRuntimePayload(payload),
        { timeoutMs: 15000, operation: 'context_read', ...options },
      );
    }

    configureGameMemoryConsent(payload = {}, options = {}) {
      this._requireGrantedCapability('memory', 'memory_consent');
      if (options.signal?.aborted) {
        throw this._hostError('cancelled', 'Memory consent request was cancelled', {
          operation: 'memory_consent',
        });
      }
      const requestedSession = String(payload.session_id || payload.sessionId || '');
      if (requestedSession && requestedSession !== this.sessionId) {
        throw this._hostError('session_invalid', 'Memory consent belongs to another session', {
          operation: 'memory_consent',
        });
      }
      this._memoryConsentEnabled = payload.enabled === true;
      return Promise.resolve({
        ok: true,
        enabled: this._memoryConsentEnabled,
        session_id: this.sessionId,
      });
    }

    submitGameMemory(payload, options = {}) {
      this._requireGrantedCapability('memory', 'memory_submit');
      return this._postWithCsrf(
        this._gameEndpoint('memory/submit'),
        this._trustedRuntimePayload(payload),
        { timeoutMs: 15000, operation: 'memory_submit', ...options },
      );
    }

    submitVoiceTranscript(payload, options = {}) {
      this._requireGrantedCapability('voice-input', 'voice_transcript');
      return this._post(this._gameEndpoint('route/voice-transcript'), this._trustedRuntimePayload(payload), {
        timeoutMs: 15000,
        operation: 'voice_transcript',
        ...options,
      });
    }

    sendRealtimeContext(payload, options = {}) {
      this._requireGrantedCapability('runtime', 'realtime_context');
      return this._post(this._gameEndpoint('realtime-context'), this._trustedRuntimePayload(payload), {
        timeoutMs: 15000,
        operation: 'realtime_context',
        ...options,
        credentials: 'same-origin',
      });
    }

    mirrorAssistant(payload, options = {}) {
      this._requireGrantedCapability('dialogue', 'mirror_assistant');
      return this._post(this._gameEndpoint('mirror-assistant'), this._trustedRuntimePayload(payload), {
        timeoutMs: 15000,
        operation: 'mirror_assistant',
        ...options,
      });
    }

    async speak(payload, options = {}) {
      this._requireGrantedCapability('speech-output', 'speech_speak');
      const trustedPayload = this._trustedRuntimePayload(payload);
      const requestRouteInstanceId = String(trustedPayload.sdk_route_instance_id || '').trim();
      if (requestRouteInstanceId) {
        await this._awaitSpeechAudioTapReady(trustedPayload, options);
        if (!this._speechAudioTapCanSuppress(trustedPayload)) {
          throw this._hostError(
            'capability_unavailable',
            'The route-bound speech audio tap became unavailable before dispatch',
            { operation: 'speech_output' },
          );
        }
        trustedPayload.suppress_primary_audio = true;
      } else {
        // Opening-screen speech has no route generation and retains the public
        // pre-route behavior. It must never suppress the primary project stream.
        trustedPayload.suppress_primary_audio = false;
      }
      const requestSessionId = this.sessionId;
      const response = await this._post(this._gameEndpoint('speak'), trustedPayload, {
        timeoutMs: 60000,
        operation: 'speak',
        ...options,
      });
      let data = null;
      try { data = await response.clone().json(); }
      catch (_) { /* the public SDK still owns response validation */ }
      const requestIsCurrent = !this._disposed
        && this.sessionId === requestSessionId
        && (
          !requestRouteInstanceId
          || this._activeRouteIdentity?.routeInstanceId === requestRouteInstanceId
        );
      if (requestIsCurrent && data?.turn_end_emitted === true) {
        this._dispatchSpeechTurnEnd(data);
      }
      return response;
    }

    requestSpeechOutput(payload, options = {}) {
      this._requireGrantedCapability('speech-output', 'speech_output');
      return this.speak(payload, options);
    }

    mirrorSpeechOutput(payload, options = {}) {
      this._requireGrantedCapability('speech-output', 'speech_mirror');
      return this._post(this._gameEndpoint('mirror-assistant'), this._trustedRuntimePayload(payload), {
        timeoutMs: 15000,
        operation: 'speech_mirror',
        ...options,
      });
    }

    preloadSpeechOutput(payload, options = {}) {
      this._requireGrantedCapability('speech-output', 'speech_preload');
      return this._postWithCsrf(this._gameEndpoint('speech/preload'), this._trustedRuntimePayload(payload), {
        timeoutMs: 180000,
        operation: 'speech_preload',
        ...options,
      });
    }

    getPageConfig(lanlanName = '') {
      const suffix = lanlanName ? `?lanlan_name=${encodeURIComponent(lanlanName)}` : '';
      return this._request(`/api/config/page_config${suffix}`, {
        credentials: 'same-origin',
        cache: 'no-store',
      }, {
        operation: 'page_config',
        timeoutMs: 10000,
      });
    }

    getMutationHeaders() {
      const headers = { 'Content-Type': 'application/json' };
      const loadFromPageConfig = () => {
        const lanlanName = this._window.lanlan_config?.lanlan_name || '';
        return this.getPageConfig(lanlanName)
          .then((response) => response.ok ? response.json() : null)
          .then((config) => {
            if (config && typeof config.autostart_csrf_token === 'string' && config.autostart_csrf_token) {
              headers['X-CSRF-Token'] = config.autostart_csrf_token;
            }
            return headers;
          })
          .catch(() => headers);
      };
      const security = this._window.nekoLocalMutationSecurity;
      if (security && typeof security.getMutationHeaders === 'function') {
        return Promise.resolve(security.getMutationHeaders())
          .then((mutationHeaders) => {
            Object.assign(headers, mutationHeaders || {});
            return csrfTokenFromHeaders(headers) ? headers : loadFromPageConfig();
          })
          .catch(loadFromPageConfig);
      }
      return loadFromPageConfig();
    }

    refreshMutationHeaders() {
      const security = this._window.nekoLocalMutationSecurity;
      if (security && typeof security.refreshToken === 'function') {
        return Promise.resolve(security.refreshToken())
          .then(() => this.getMutationHeaders())
          .catch(() => this.getMutationHeaders());
      }
      return this.getMutationHeaders();
    }

    async withCsrfRetry(requestWithHeaders) {
      let response = await requestWithHeaders(await this.getMutationHeaders());
      if (response.status !== 403) return response;
      const errorPayload = await response.clone().json().catch(() => ({}));
      if (errorPayload?.error_code !== 'csrf_validation_failed') return response;
      response = await requestWithHeaders(await this.refreshMutationHeaders());
      return response;
    }

    sendRealtimeContextWithCsrf(payload) {
      return this.withCsrfRetry((headers) => this.sendRealtimeContext(payload, { headers }));
    }

    _speechAudioSink() {
      const appState = this._window.appState;
      const playback = this._window.appAudioPlayback;
      const enqueue = typeof playback?.enqueueIncomingAudioBlob === 'function'
        ? playback.enqueueIncomingAudioBlob
        : this._window.enqueueIncomingAudioBlob;
      if (!appState || !Array.isArray(appState.pendingAudioChunkMetaQueue) || typeof enqueue !== 'function') {
        return null;
      }
      return {
        appState,
        enqueue: (blob) => enqueue.call(playback || this._window, blob),
        scheduleMetaCheck: typeof playback?.schedulePendingAudioMetaStallCheck === 'function'
          ? () => playback.schedulePendingAudioMetaStallCheck()
          : (typeof this._window.schedulePendingAudioMetaStallCheck === 'function'
            ? () => this._window.schedulePendingAudioMetaStallCheck()
            : null),
        resetDecoder: typeof this._window.resetOggOpusDecoder === 'function'
          ? () => this._window.resetOggOpusDecoder()
          : null,
      };
    }

    _isSpeechAudioBlob(value) {
      const BlobImpl = this._window.Blob || globalThis.Blob;
      return typeof BlobImpl === 'function' && value instanceof BlobImpl;
    }

    _reportSpeechAudioTapError(error, source) {
      try { this._speechPlaybackBridge.onError?.(error, source); }
      catch (_) { /* a consumer error must not break host audio cleanup */ }
    }

    _settleSpeechAudioTapReadyWaiters(ok, reason = 'speech_audio_tap_unavailable', routeToken = null) {
      const tap = this._speechAudioTap;
      for (const waiter of Array.from(tap.readyWaiters)) {
        if (routeToken != null && waiter.routeToken !== routeToken) continue;
        tap.readyWaiters.delete(waiter);
        if (waiter.timeoutId != null) this._window.clearTimeout(waiter.timeoutId);
        waiter.signal?.removeEventListener?.('abort', waiter.abortHandler);
        if (ok) {
          waiter.resolve(true);
          continue;
        }
        const code = reason === 'disposed'
          ? 'disposed'
          : (['route_end', 'runtime_reset', 'route_generation_changed', 'route_identity_changed']
            .includes(reason) ? 'cancelled' : 'capability_unavailable');
        waiter.reject(this._hostError(code, 'The route-bound speech audio tap is unavailable', {
          operation: 'speech_output',
        }));
      }
    }

    _awaitSpeechAudioTapReady(payload = {}, options = {}) {
      const tap = this._speechAudioTap;
      const routeInstanceId = String(payload.sdk_route_instance_id || '').trim();
      if (!routeInstanceId) return Promise.resolve(false);
      const route = tap.route;
      const routeMatches = !!(
        this._activeRouteIdentity
        && route
        && route.routeInstanceId === routeInstanceId
        && route.sessionId === this.sessionId
        && route.lanlanName === this.routeLanlanName
      );
      if (!routeMatches || !this._speechOutputBridgeActive || !this._speechAudioSink()) {
        return Promise.reject(this._hostError(
          'capability_unavailable',
          'The route-bound speech audio tap is unavailable',
          { operation: 'speech_output' },
        ));
      }
      if (this._speechAudioTapCanSuppress(payload)) return Promise.resolve(true);
      if (tap.permanentFailure || (!tap.socket && tap.reconnectAttempts >= tap.reconnectLimit)) {
        return Promise.reject(this._hostError(
          'capability_unavailable',
          'The route-bound speech audio tap failed to become ready',
          { operation: 'speech_output' },
        ));
      }
      const signal = options.signal || null;
      if (signal?.aborted) {
        return Promise.reject(this._hostError('cancelled', 'The speech request was cancelled', {
          operation: 'speech_output',
        }));
      }
      const routeToken = tap.routeToken;
      return new Promise((resolve, reject) => {
        const waiter = {
          routeToken,
          signal,
          abortHandler: null,
          timeoutId: null,
          resolve,
          reject,
        };
        waiter.abortHandler = () => {
          if (!tap.readyWaiters.delete(waiter)) return;
          if (waiter.timeoutId != null) this._window.clearTimeout(waiter.timeoutId);
          reject(this._hostError('cancelled', 'The speech request was cancelled', {
            operation: 'speech_output',
          }));
        };
        signal?.addEventListener?.('abort', waiter.abortHandler, { once: true });
        waiter.timeoutId = this._window.setTimeout(() => {
          if (!tap.readyWaiters.delete(waiter)) return;
          signal?.removeEventListener?.('abort', waiter.abortHandler);
          reject(this._hostError(
            'capability_unavailable',
            'The route-bound speech audio tap did not become ready in time',
            { operation: 'speech_output' },
          ));
        }, tap.requestReadyTimeoutMs);
        tap.readyWaiters.add(waiter);
        // The ready frame may have landed between the synchronous check above and
        // waiter registration. Recheck after insertion so that edge cannot wait
        // until timeout despite an already usable tap.
        if (tap.routeToken === routeToken && this._speechAudioTapCanSuppress(payload)) {
          this._settleSpeechAudioTapReadyWaiters(true, 'ready', routeToken);
        }
      });
    }

    _clearSpeechAudioTapTimers() {
      const tap = this._speechAudioTap;
      if (tap.reconnectTimer != null) this._window.clearTimeout(tap.reconnectTimer);
      if (tap.readyTimer != null) this._window.clearTimeout(tap.readyTimer);
      if (tap.pingTimer != null) this._window.clearInterval(tap.pingTimer);
      tap.reconnectTimer = null;
      tap.readyTimer = null;
      tap.pingTimer = null;
    }

    _discardSpeechAudioTapHeaders({ socketToken = null } = {}) {
      const queue = this._window.appState?.pendingAudioChunkMetaQueue;
      if (!Array.isArray(queue)) return;
      const ownerId = this._speechAudioTap.ownerId;
      this._window.appState.pendingAudioChunkMetaQueue = queue.filter((entry) => !(
        entry?.sdkSpeechTapOwner === ownerId
        && (socketToken == null || entry.sdkSpeechTapSocketToken === socketToken)
      ));
    }

    _stopSpeechAudioTap(reason = 'stopped') {
      const tap = this._speechAudioTap;
      this._settleSpeechAudioTapReadyWaiters(false, reason);
      tap.routeToken += 1;
      tap.ready = false;
      tap.manualClose = true;
      tap.permanentFailure = false;
      this._clearSpeechAudioTapTimers();
      const socket = tap.socket;
      tap.socket = null;
      tap.route = null;
      tap.blobQueue = [];
      tap.blobDrainPromise = null;
      tap.messageTail = Promise.resolve();
      this._discardSpeechAudioTapHeaders();
      if (socket) {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        try { socket.close(1000, String(reason || 'stopped').slice(0, 120)); }
        catch (_) { /* already closed */ }
      }
    }

    _retireActiveSpeechRoute(reason = 'retired') {
      this._activeRouteIdentity = null;
      this._stopSpeechAudioTap(reason);
    }

    _speechAudioTapCanSuppress(payload = {}) {
      const tap = this._speechAudioTap;
      const route = tap.route;
      const sinkAvailable = !!this._speechAudioSink();
      if (!sinkAvailable) tap.ready = false;
      return !!(
        this._speechOutputBridgeActive
        && tap.ready
        && tap.socket
        && tap.socket.readyState === 1
        && route
        && sinkAvailable
        && route.gameType === this.routeGameType
        && route.sessionId === this.sessionId
        && route.lanlanName === this.routeLanlanName
        && route.routeInstanceId
        && route.routeInstanceId === String(payload.sdk_route_instance_id || '').trim()
      );
    }

    _bindSpeechAudioTap(routeInput) {
      const route = {
        gameType: this.routeGameType,
        sessionId: String(routeInput?.sessionId || '').trim(),
        lanlanName: String(routeInput?.lanlanName || '').trim(),
        routeInstanceId: String(routeInput?.routeInstanceId || '').trim(),
      };
      if (
        !this._speechOutputBridgeActive
        || !this._grantedCapabilities.has('speech-output')
        || this._disposed
        || !route.sessionId
        || !route.lanlanName
        || !route.routeInstanceId
        || !this._speechAudioSink()
      ) {
        this._stopSpeechAudioTap('speech_tap_unavailable');
        return false;
      }
      const WebSocketImpl = this._speechAudioTap.WebSocketImpl || this._window.WebSocket;
      if (typeof WebSocketImpl !== 'function') {
        this._stopSpeechAudioTap('speech_tap_websocket_unavailable');
        return false;
      }
      const current = this._speechAudioTap.route;
      if (
        current
        && current.gameType === route.gameType
        && current.sessionId === route.sessionId
        && current.lanlanName === route.lanlanName
        && current.routeInstanceId === route.routeInstanceId
        && this._speechAudioTap.socket
      ) return true;

      this._stopSpeechAudioTap('speech_tap_rebind');
      const tap = this._speechAudioTap;
      tap.route = Object.freeze(route);
      tap.manualClose = false;
      tap.permanentFailure = false;
      tap.reconnectAttempts = 0;
      return this._connectSpeechAudioTap();
    }

    _speechAudioTapUrl(route) {
      const URLImpl = this._window.URL || globalThis.URL;
      const url = new URLImpl(this._gameEndpoint('speech/ws'), this._window.location.origin);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('lanlan_name', route.lanlanName);
      url.searchParams.set('session_id', route.sessionId);
      url.searchParams.set('sdk_route_instance_id', route.routeInstanceId);
      return url.toString();
    }

    _scheduleSpeechAudioTapReconnect(routeToken) {
      const tap = this._speechAudioTap;
      if (
        tap.routeToken !== routeToken
        || tap.manualClose
        || tap.permanentFailure
        || !tap.route
        || tap.reconnectTimer != null
        || tap.reconnectAttempts >= tap.reconnectLimit
      ) {
        if (
          tap.routeToken === routeToken
          && !tap.manualClose
          && !tap.permanentFailure
          && tap.reconnectAttempts >= tap.reconnectLimit
        ) {
          this._settleSpeechAudioTapReadyWaiters(
            false,
            'speech_audio_tap_reconnect_exhausted',
            routeToken,
          );
        }
        return false;
      }
      tap.reconnectAttempts += 1;
      const delayMs = Math.min(
        5000,
        tap.reconnectDelayMs * Math.pow(2, Math.max(0, tap.reconnectAttempts - 1)),
      );
      tap.reconnectTimer = this._window.setTimeout(() => {
        tap.reconnectTimer = null;
        if (tap.routeToken === routeToken && !tap.manualClose && !tap.permanentFailure) {
          this._connectSpeechAudioTap();
        }
      }, delayMs);
      return true;
    }

    _connectSpeechAudioTap() {
      const tap = this._speechAudioTap;
      const route = tap.route;
      const WebSocketImpl = tap.WebSocketImpl || this._window.WebSocket;
      if (
        this._disposed
        || !this._speechOutputBridgeActive
        || tap.manualClose
        || tap.permanentFailure
        || !route
        || typeof WebSocketImpl !== 'function'
        || !this._speechAudioSink()
      ) return false;
      if (tap.socket && (tap.socket.readyState === 0 || tap.socket.readyState === 1)) return true;

      const routeToken = tap.routeToken;
      const socketToken = ++tap.socketToken;
      let socket;
      try {
        socket = new WebSocketImpl(this._speechAudioTapUrl(route));
      } catch (error) {
        this._reportSpeechAudioTapError(error, 'speech_audio_tap_connect');
        this._scheduleSpeechAudioTapReconnect(routeToken);
        return false;
      }
      tap.socket = socket;
      tap.ready = false;
      try { socket.binaryType = 'blob'; } catch (_) { /* optional in test/legacy sockets */ }
      tap.readyTimer = this._window.setTimeout(() => {
        if (tap.routeToken !== routeToken || tap.socket !== socket || tap.ready) return;
        try { socket.close(1013, 'speech_tap_ready_timeout'); }
        catch (_) { /* onclose or the next route transition performs cleanup */ }
      }, tap.readyTimeoutMs);

      socket.onopen = () => {
        if (tap.routeToken !== routeToken || tap.socket !== socket) return;
        if (tap.pingTimer != null) this._window.clearInterval(tap.pingTimer);
        tap.pingTimer = this._window.setInterval(() => {
          if (tap.routeToken !== routeToken || tap.socket !== socket || socket.readyState !== 1) return;
          try { socket.send(JSON.stringify({ type: 'ping', session_id: route.sessionId })); }
          catch (_) { /* socket close owns reconnect */ }
        }, tap.pingIntervalMs);
      };
      socket.onmessage = (event) => {
        if (tap.routeToken !== routeToken || tap.socket !== socket) return;
        const acceptedWhileReady = tap.ready;
        tap.messageTail = tap.messageTail
          .catch(() => undefined)
          .then(() => this._handleSpeechAudioTapMessage(
            event?.data,
            { routeToken, socketToken, acceptedWhileReady },
          ))
          .catch((error) => this._reportSpeechAudioTapError(error, 'speech_audio_tap_message'));
      };
      socket.onerror = (error) => {
        if (tap.routeToken === routeToken && tap.socket === socket) {
          this._reportSpeechAudioTapError(error, 'speech_audio_tap_socket');
        }
      };
      socket.onclose = () => {
        if (tap.routeToken !== routeToken || tap.socket !== socket) return;
        tap.socket = null;
        tap.ready = false;
        if (tap.readyTimer != null) this._window.clearTimeout(tap.readyTimer);
        if (tap.pingTimer != null) this._window.clearInterval(tap.pingTimer);
        tap.readyTimer = null;
        tap.pingTimer = null;
        tap.messageTail = tap.messageTail
          .catch(() => undefined)
          .then(() => {
            this._discardSpeechAudioTapHeaders({ socketToken });
            this._scheduleSpeechAudioTapReconnect(routeToken);
          });
      };
      return true;
    }

    async _handleSpeechAudioTapMessage(rawData, context) {
      const tap = this._speechAudioTap;
      if (tap.routeToken !== context.routeToken || !tap.route) return;
      if (this._isSpeechAudioBlob(rawData)) {
        // WebSocket callbacks can enqueue tap_ready, header and the first Blob in
        // one task before messageTail handles the ready frame. The current ready
        // state is therefore authoritative in addition to the enqueue-time bit.
        if (!(context.acceptedWhileReady || tap.ready)) return;
        tap.blobQueue.push({ blob: rawData, routeToken: context.routeToken });
        await this._drainSpeechAudioTapBlobs();
        return;
      }
      let data;
      try { data = JSON.parse(String(rawData || '{}')); }
      catch (_) { return; }
      if (data?.type === 'speech_tap_ready') {
        const identityMatches = data.ok === true
          && String(data.game_type || '') === tap.route.gameType
          && String(data.session_id || '') === tap.route.sessionId
          && !!this._speechAudioSink();
        if (tap.readyTimer != null) this._window.clearTimeout(tap.readyTimer);
        tap.readyTimer = null;
        tap.ready = identityMatches;
        if (!identityMatches) {
          tap.permanentFailure = true;
          this._settleSpeechAudioTapReadyWaiters(
            false,
            'speech_audio_tap_rejected',
            context.routeToken,
          );
          const socket = tap.socket;
          try { socket?.close(1008, 'speech_tap_rejected'); }
          catch (_) { /* no suppression is safer than a partially bound tap */ }
        } else {
          this._settleSpeechAudioTapReadyWaiters(true, 'ready', context.routeToken);
        }
        return;
      }
      if (data?.type === 'audio_chunk' && (context.acceptedWhileReady || tap.ready)) {
        this._pushSpeechAudioTapHeader(data, context.socketToken);
      }
    }

    _pushSpeechAudioTapHeader(response, socketToken) {
      const sink = this._speechAudioSink();
      if (!sink) return false;
      const speechId = String(response?.speech_id || response?.speechId || '').trim();
      if (!speechId) return false;
      const appState = sink.appState;
      let shouldSkip = false;
      if (appState.interruptedSpeechId && speechId === appState.interruptedSpeechId) {
        shouldSkip = true;
      } else if (speechId !== appState.currentPlayingSpeechId) {
        if (appState.pendingDecoderReset && sink.resetDecoder) {
          appState.decoderResetPromise = Promise.resolve(sink.resetDecoder())
            .catch(() => undefined)
            .then(() => { appState.pendingDecoderReset = false; });
        } else {
          appState.pendingDecoderReset = false;
        }
        appState.currentPlayingSpeechId = speechId;
        appState.interruptedSpeechId = null;
      }
      appState.pendingAudioChunkMetaQueue.push({
        speechId,
        turnId: String(response?.turn_id || response?.turnId || speechId),
        shouldSkip,
        epoch: appState.incomingAudioEpoch || 0,
        receivedAt: Date.now(),
        sdkSpeechTapOwner: this._speechAudioTap.ownerId,
        sdkSpeechTapSocketToken: socketToken,
      });
      try { sink.scheduleMetaCheck?.(); }
      catch (_) { /* playback queue processing remains authoritative */ }
      return true;
    }

    _drainSpeechAudioTapBlobs() {
      const tap = this._speechAudioTap;
      if (tap.blobDrainPromise) return tap.blobDrainPromise;
      // A sink may settle after reset/rebind. Capture both the route token and
      // queue object so that an old asynchronous drain can finish its already
      // handed-off Blob, but can never resume against a newer generation's
      // replacement queue and race that generation's FIFO consumer.
      const drainRouteToken = tap.routeToken;
      const drainQueue = tap.blobQueue;
      const drain = (async () => {
        while (
          tap.routeToken === drainRouteToken
          && tap.blobQueue === drainQueue
          && drainQueue.length
        ) {
          const entry = drainQueue.shift();
          if (!entry || entry.routeToken !== drainRouteToken || !tap.route) continue;
          const sink = this._speechAudioSink();
          if (!sink) {
            tap.ready = false;
            continue;
          }
          try {
            await Promise.resolve(sink.enqueue(entry.blob));
          } catch (error) {
            tap.ready = false;
            tap.permanentFailure = true;
            this._reportSpeechAudioTapError(error, 'speech_audio_sink');
            try { tap.socket?.close(1011, 'speech_audio_sink_failed'); }
            catch (_) { /* a later lifecycle transition clears the socket */ }
          }
        }
      })();
      const trackedDrain = drain.finally(() => {
        if (tap.blobDrainPromise === trackedDrain) tap.blobDrainPromise = null;
      });
      tap.blobDrainPromise = trackedDrain;
      return trackedDrain;
    }

    _dispatchSpeechTurnEnd(response) {
      const turnId = String(response?.turn_id || response?.turnId || response?.speech_id || response?.speechId || '').trim();
      if (!turnId || typeof this._window.CustomEvent !== 'function') return false;
      try {
        this._window.dispatchEvent(new this._window.CustomEvent('neko-assistant-turn-end', {
          detail: {
            turnId,
            speechId: String(response?.speech_id || response?.speechId || turnId),
            source: 'minigame_sdk_speech',
          },
        }));
        return true;
      } catch (_) {
        return false;
      }
    }

    startSpeechPlaybackBridge(options = {}) {
      this._requireGrantedCapability('speech-output', 'speech_playback_bridge');
      this.stopSpeechPlaybackBridge();
      const bridge = this._speechPlaybackBridge;
      const storageKey = String(options.storageKey || 'neko_speech_playback_state');
      const channelName = String(options.channelName || 'neko_speech_playback_channel');
      const eventName = String(options.eventName || 'neko-speech-playback-state');
      const messageType = String(options.messageType || 'speech_playback_state');
      bridge.onState = typeof options.onState === 'function' ? options.onState : null;
      bridge.onError = typeof options.onError === 'function' ? options.onError : null;

      const acceptState = (data, source) => {
        if (data?.type !== messageType || !bridge.onState) return;
        let fingerprint = '';
        try { fingerprint = JSON.stringify(data); } catch (_) { /* skip dedupe for non-serializable legacy payloads */ }
        if (fingerprint && fingerprint === bridge.lastStateFingerprint) return;
        if (fingerprint) bridge.lastStateFingerprint = fingerprint;
        try {
          bridge.onState(data, source);
        } catch (error) {
          bridge.onError?.(error, source);
        }
      };
      bridge.acceptState = acceptState;
      const BroadcastChannelImpl = options.BroadcastChannelImpl || this._window.BroadcastChannel;
      if (typeof BroadcastChannelImpl === 'function') {
        try {
          bridge.channel = new BroadcastChannelImpl(channelName);
          bridge.channel.onmessage = (event) => acceptState(event?.data, 'broadcast_channel');
        } catch (error) {
          bridge.channel = null;
          bridge.onError?.(error, 'broadcast_channel');
        }
      }

      bridge.storageHandler = (event) => {
        if (event.key !== storageKey || !event.newValue) return;
        try {
          acceptState(JSON.parse(event.newValue), 'local_storage');
        } catch (_) { /* ignore malformed state from unrelated/older writers */ }
      };
      bridge.windowEventHandler = (event) => acceptState(event?.detail, 'window_event');
      bridge.windowEventName = eventName;
      this._window.addEventListener('storage', bridge.storageHandler);
      this._window.addEventListener(eventName, bridge.windowEventHandler);
    }

    stopSpeechPlaybackBridge() {
      const bridge = this._speechPlaybackBridge;
      if (bridge.storageHandler) {
        this._window.removeEventListener('storage', bridge.storageHandler);
        bridge.storageHandler = null;
      }
      if (bridge.windowEventHandler) {
        this._window.removeEventListener(bridge.windowEventName, bridge.windowEventHandler);
        bridge.windowEventHandler = null;
        bridge.windowEventName = '';
      }
      if (bridge.channel) {
        bridge.channel.onmessage = null;
        try { bridge.channel.close(); } catch (_) { /* already closed */ }
        bridge.channel = null;
      }
      bridge.onState = null;
      bridge.onError = null;
      bridge.acceptState = null;
      bridge.lastStateFingerprint = '';
    }

    startSpeechOutputBridge(options = {}) {
      this._requireGrantedCapability('speech-output', 'speech_output_bridge');
      if (this._disposed) {
        throw this._hostError('disposed', `${this.displayName} host adapter has been disposed`, {
          operation: 'speech_output_bridge',
        });
      }
      this._speechOutputBridgeActive = true;
      this.startSpeechPlaybackBridge(options);
      const storageKey = String(options.storageKey || 'neko_speech_playback_state');
      const messageType = String(options.messageType || 'speech_playback_state');
      try {
        const stored = JSON.parse(this._window.localStorage?.getItem(storageKey) || 'null');
        if (stored && typeof stored === 'object' && stored.type === messageType) {
          this._speechPlaybackBridge.acceptState?.(stored, 'local_storage_initial');
        }
      } catch (_) { /* ignore malformed state from unrelated/older writers */ }
      if (this._activeRouteIdentity) this._bindSpeechAudioTap(this._activeRouteIdentity);
      return true;
    }

    stopSpeechOutputBridge() {
      this._speechOutputBridgeActive = false;
      this._stopSpeechAudioTap('speech_output_bridge_stopped');
      this.stopSpeechPlaybackBridge();
    }

    startVoiceControlBridge(options = {}) {
      this._requireGrantedCapability('voice-input', 'voice_control_bridge');
      this.stopVoiceControlBridge('restarted');
      if (this._disposed) throw this._hostError('disposed', `${this.displayName} host adapter has been disposed`);
      const bridge = this._voiceControlBridge;
      const channelName = String(options.channelName || 'neko_game_voice_control_channel');
      bridge.storageKey = String(options.storageKey || 'neko_game_voice_control_message');
      bridge.onState = typeof options.onState === 'function' ? options.onState : null;
      bridge.onTranscript = typeof options.onTranscript === 'function' ? options.onTranscript : null;
      bridge.onError = typeof options.onError === 'function' ? options.onError : null;

      const acceptMessage = (data, source) => {
        if (!data || ![
          'game_voice_control_state',
          'game_voice_transcript',
          'game_voice_control_error',
        ].includes(data.type)) return;
        const messageId = String(data.message_id || data.storage_nonce || '');
        if (messageId) {
          if (bridge.seenMessageIds.has(messageId)) return;
          bridge.seenMessageIds.add(messageId);
          bridge.seenMessageOrder.push(messageId);
          while (bridge.seenMessageOrder.length > 128) {
            bridge.seenMessageIds.delete(bridge.seenMessageOrder.shift());
          }
        }
        if (String(data.game_type || '') !== this.routeGameType) return;
        if (data.session_id && String(data.session_id) !== this.sessionId) return;
        const messageRouteInstanceId = String(data.sdk_route_instance_id || '').trim();
        const activeRouteInstanceId = String(this._activeRouteIdentity?.routeInstanceId || '').trim();
        if (
          messageRouteInstanceId
          && activeRouteInstanceId
          && messageRouteInstanceId !== activeRouteInstanceId
        ) return;
        const requestId = String(data.request_id || '');
        const pending = requestId ? bridge.pending.get(requestId) : null;
        if (
          pending?.routeInstanceId
          && messageRouteInstanceId !== pending.routeInstanceId
        ) return;
        if (data.type === 'game_voice_control_error') {
          try {
            bridge.onError?.(Object.freeze({ ...data }), source);
          } catch (error) {
            this._window.console?.error?.('[NekoMiniGameHost] voice error listener failed', error);
          }
          return;
        }
        if (data.type === 'game_voice_transcript') {
          const text = String(data.text || '').trim();
          if (!text) return;
          try {
            bridge.onTranscript?.({ ...data, text }, source);
          } catch (error) {
            bridge.onError?.(error, source);
          }
          return;
        }
        bridge.lastState = data;
        if (pending && data.reason !== 'working') {
          this._window.clearTimeout(pending.timeoutId);
          bridge.pending.delete(requestId);
          pending.signal?.removeEventListener?.('abort', pending.abortHandler);
          pending.resolve(data);
        }
        try {
          bridge.onState?.(data, source);
        } catch (error) {
          bridge.onError?.(error, source);
        }
      };

      const BroadcastChannelImpl = options.BroadcastChannelImpl || this._window.BroadcastChannel;
      if (typeof BroadcastChannelImpl === 'function') {
        try {
          bridge.channel = new BroadcastChannelImpl(channelName);
          bridge.channel.onmessage = (event) => acceptMessage(event?.data, 'broadcast_channel');
        } catch (error) {
          bridge.channel = null;
          bridge.onError?.(error, 'broadcast_channel');
        }
      }

      bridge.storageHandler = (event) => {
        if (!event || event.key !== bridge.storageKey || !event.newValue) return;
        try {
          acceptMessage(JSON.parse(event.newValue), 'local_storage');
        } catch (_) { /* ignore malformed coordination messages */ }
      };
      this._window.addEventListener('storage', bridge.storageHandler);
      bridge.windowEventHandler = (event) => acceptMessage(event?.detail, 'same_document');
      this._window.addEventListener(VOICE_CONTROL_WINDOW_EVENT, bridge.windowEventHandler);
      let storageAvailable = false;
      try { storageAvailable = typeof this._window.localStorage !== 'undefined'; }
      catch (_) { storageAvailable = false; }
      const sameDocumentAvailable = typeof this._window.dispatchEvent === 'function'
        && typeof (this._window.CustomEvent || globalThis.CustomEvent) === 'function';
      return !!bridge.channel || storageAvailable || sameDocumentAvailable;
    }

    _postVoiceControlMessage(payload) {
      const bridge = this._voiceControlBridge;
      const messageId = String(payload?.message_id || (
        `voice-message-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
      ));
      const message = { ...payload, message_id: messageId, storage_nonce: messageId };
      let posted = false;
      if (bridge.channel) {
        try {
          bridge.channel.postMessage(message);
          posted = true;
        } catch (error) {
          bridge.onError?.(error, 'broadcast_channel');
          try { bridge.channel.close(); } catch (_) { /* unusable channel */ }
          bridge.channel = null;
        }
      }
      let serialized = '';
      try {
        serialized = JSON.stringify(message);
        this._window.localStorage.setItem(bridge.storageKey, serialized);
        this._window.setTimeout(() => {
          try {
            if (this._window.localStorage.getItem(bridge.storageKey) === serialized) {
              this._window.localStorage.removeItem(bridge.storageKey);
            }
          } catch (_) { /* best-effort transient message cleanup */ }
        }, 0);
        posted = true;
      } catch (error) {
        if (!posted) bridge.onError?.(error, 'local_storage');
      }
      try {
        const CustomEventImpl = this._window.CustomEvent || globalThis.CustomEvent;
        if (typeof this._window.dispatchEvent === 'function' && typeof CustomEventImpl === 'function') {
          this._window.dispatchEvent(new CustomEventImpl(VOICE_CONTROL_WINDOW_EVENT, {
            detail: serialized ? JSON.parse(serialized) : { ...message },
          }));
          posted = true;
        }
      } catch (error) {
        if (!posted) bridge.onError?.(error, 'same_document');
      }
      return posted;
    }

    requestVoiceControl(action = 'query', options = {}) {
      const bridge = this._voiceControlBridge;
      if (this._disposed) {
        return Promise.reject(this._hostError('disposed', `${this.displayName} host adapter has been disposed`, {
          operation: 'voice_control',
        }));
      }
      if (!bridge.channel && !bridge.storageHandler) {
        return Promise.reject(this._hostError('unsupported', 'Voice control bridge is not started', {
          operation: 'voice_control',
        }));
      }
      if (!this._grantedCapabilities.has('voice-input')) {
        return Promise.reject(this._hostError('capability_denied', 'Voice input was not granted to this launch', {
          operation: 'voice_control',
        }));
      }
      if (bridge.pending.size >= bridge.pendingLimit) {
        return Promise.reject(this._hostError('busy', 'Voice control request limit reached', {
          operation: 'voice_control',
        }));
      }
      const normalizedAction = String(action || 'query');
      if (!['query', 'start', 'stop', 'toggle', 'handoff'].includes(normalizedAction)) {
        return Promise.reject(this._hostError('invalid_request', 'Unknown voice control action', {
          operation: 'voice_control',
        }));
      }
      const signal = options.signal || null;
      const routeInstanceId = String(options.sdkRouteInstanceId || '').trim();
      const handoffIntentEpoch = Number(options.handoffIntentEpoch);
      const hasHandoffIntentEpoch = normalizedAction === 'handoff'
        && Object.prototype.hasOwnProperty.call(options, 'handoffIntentEpoch')
        && Number.isSafeInteger(handoffIntentEpoch)
        && handoffIntentEpoch >= 0;
      if (signal?.aborted) {
        return Promise.reject(this._hostError('cancelled', 'Voice control request was cancelled', {
          operation: 'voice_control',
        }));
      }

      bridge.nextRequestId = (bridge.nextRequestId + 1) % Number.MAX_SAFE_INTEGER;
      // Per-client entropy: two host adapters in the same session that issue
      // their first voice command in the same millisecond both mint
      // `voice-<ms>-1`, and the shared BroadcastChannel then routes one
      // adapter's reply into the other's pending map.
      const requestId = `voice-${Date.now().toString(36)}-${bridge.nextRequestId.toString(36)}`
        + `-${randomIdSuffix(this._window)}`;
      const timeoutMs = Math.max(500, Number(options.timeoutMs || DEFAULT_VOICE_CONTROL_TIMEOUT_MS));
      return new Promise((resolve, reject) => {
        const abortHandler = () => {
          const pending = bridge.pending.get(requestId);
          if (!pending) return;
          bridge.pending.delete(requestId);
          this._window.clearTimeout(pending.timeoutId);
          signal?.removeEventListener?.('abort', abortHandler);
          reject(this._hostError('cancelled', 'Voice control request was cancelled', {
            operation: 'voice_control',
            requestId,
          }));
        };
        const timeoutId = this._window.setTimeout(() => {
          bridge.pending.delete(requestId);
          signal?.removeEventListener?.('abort', abortHandler);
          reject(this._hostError('timeout', 'Voice control request timed out', {
            operation: 'voice_control',
            requestId,
          }));
        }, timeoutMs);
        bridge.pending.set(requestId, {
          resolve,
          reject,
          timeoutId,
          signal,
          abortHandler,
          routeInstanceId,
        });
        signal?.addEventListener?.('abort', abortHandler, { once: true });
        const posted = this._postVoiceControlMessage({
          type: 'game_voice_control_request',
          sender_id: bridge.senderId,
          request_id: requestId,
          timestamp: Date.now(),
          action: normalizedAction,
          game_type: this.routeGameType,
          session_id: this.sessionId,
          ...(routeInstanceId ? { sdk_route_instance_id: routeInstanceId } : {}),
          ...(hasHandoffIntentEpoch ? { ordinary_voice_intent_epoch: handoffIntentEpoch } : {}),
        });
        if (!posted) {
          this._window.clearTimeout(timeoutId);
          bridge.pending.delete(requestId);
          signal?.removeEventListener?.('abort', abortHandler);
          reject(this._hostError('unsupported', 'Voice control transport is unavailable', {
            operation: 'voice_control',
            requestId,
          }));
        }
      });
    }

    _cancelVoiceControlRequests(reason = 'cancelled') {
      const bridge = this._voiceControlBridge;
      for (const [requestId, pending] of bridge.pending.entries()) {
        this._window.clearTimeout(pending.timeoutId);
        pending.signal?.removeEventListener?.('abort', pending.abortHandler);
        pending.reject(this._hostError(reason === 'disposed' ? 'disposed' : 'cancelled', 'Voice control request was cancelled', {
          operation: 'voice_control',
          requestId,
        }));
      }
      bridge.pending.clear();
    }

    stopVoiceControlBridge(reason = 'cancelled') {
      const bridge = this._voiceControlBridge;
      if (bridge.storageHandler) {
        this._window.removeEventListener('storage', bridge.storageHandler);
        bridge.storageHandler = null;
      }
      if (bridge.windowEventHandler) {
        this._window.removeEventListener(VOICE_CONTROL_WINDOW_EVENT, bridge.windowEventHandler);
        bridge.windowEventHandler = null;
      }
      if (bridge.channel) {
        bridge.channel.onmessage = null;
        try { bridge.channel.close(); } catch (_) { /* already closed */ }
        bridge.channel = null;
      }
      this._cancelVoiceControlRequests(reason);
      bridge.storageKey = '';
      bridge.onState = null;
      bridge.onTranscript = null;
      bridge.onError = null;
      bridge.lastState = null;
      bridge.seenMessageIds.clear();
      bridge.seenMessageOrder.length = 0;
    }

    isSpeechRecognitionSupported(options = {}) {
      this._requireGrantedCapability('voice-input', 'speech_recognition');
      const RecognitionImpl = options.RecognitionImpl ||
        this._window.SpeechRecognition ||
        this._window.webkitSpeechRecognition;
      return typeof RecognitionImpl === 'function';
    }

    startSpeechRecognition(name, options = {}) {
      this._requireGrantedCapability('voice-input', 'speech_recognition');
      const slotName = String(name || '').trim();
      if (!slotName) throw this._hostError('invalid_request', 'Speech recognition slot name is required');
      if (this._disposed) throw this._hostError('disposed', `${this.displayName} host adapter has been disposed`);

      let slot = this._speechRecognitionSlots.get(slotName);
      if (!slot) {
        if (this._speechRecognitionSlots.size >= this._speechSlotLimit) {
          throw this._hostError('busy', `${this.displayName} host speech recognition slot limit reached`, {
            operation: 'speech_recognition',
          });
        }
        const RecognitionImpl = options.RecognitionImpl ||
          this._window.SpeechRecognition ||
          this._window.webkitSpeechRecognition;
        if (typeof RecognitionImpl !== 'function') {
          options.onUnsupported?.();
          return false;
        }
        const recognition = new RecognitionImpl();
        slot = {
          recognition,
          options: {},
          active: false,
          listening: false,
          stopping: false,
          restartTimer: null,
        };
        this._speechRecognitionSlots.set(slotName, slot);

        recognition.onstart = (event) => {
          slot.listening = true;
          slot.stopping = false;
          slot.options.onStart?.(event);
        };
        for (const eventName of ['audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend']) {
          recognition[`on${eventName}`] = (event) => slot.options.onLifecycle?.(eventName, event);
        }
        recognition.onnomatch = (event) => slot.options.onNoMatch?.(event);
        recognition.onresult = (event) => {
          const results = event?.results || [];
          const startIndex = slot.options.finalOnly === false
            ? 0
            : (typeof event?.resultIndex === 'number' ? event.resultIndex : 0);
          let transcript = '';
          for (let i = startIndex; i < results.length; i++) {
            const result = results[i];
            if (!result || (slot.options.finalOnly !== false && result.isFinal === false)) continue;
            transcript += result[0]?.transcript || '';
          }
          transcript = transcript.trim();
          slot.options.onResult?.(event, transcript);
          if (transcript) slot.options.onTranscript?.(transcript, event);
        };
        recognition.onerror = (event) => {
          const errorCode = String(event?.error || 'unknown');
          if (errorCode === 'not-allowed' || errorCode === 'service-not-allowed') {
            slot.active = false;
            slot.stopping = true;
          }
          slot.options.onError?.(errorCode, event);
        };
        recognition.onend = (event) => {
          slot.listening = false;
          if (slot.restartTimer != null) {
            this._window.clearTimeout(slot.restartTimer);
            slot.restartTimer = null;
          }
          slot.options.onEnd?.(event);
          const autoRestart = typeof slot.options.autoRestart === 'function'
            ? !!slot.options.autoRestart()
            : !!slot.options.autoRestart;
          if (slot.active && !this._disposed && !slot.stopping && autoRestart) {
            const delayMs = Math.max(
              0,
              Number(slot.options.restartDelayMs ?? DEFAULT_SPEECH_RESTART_DELAY_MS),
            );
            slot.restartTimer = this._window.setTimeout(() => {
              slot.restartTimer = null;
              if (slot.active && !this._disposed && !slot.stopping) {
                this.startSpeechRecognition(slotName, slot.options);
              }
            }, delayMs);
          }
          slot.stopping = false;
        };
      }

      slot.options = { ...slot.options, ...options };
      slot.active = true;
      const recognition = slot.recognition;
      recognition.lang = String(slot.options.lang || recognition.lang || '');
      recognition.continuous = slot.options.continuous !== false;
      recognition.interimResults = !!slot.options.interimResults;
      recognition.maxAlternatives = Math.max(1, Number(slot.options.maxAlternatives || 1));
      if (slot.listening) {
        slot.options.onAlreadyRunning?.();
        return true;
      }

      try {
        slot.stopping = false;
        recognition.start();
        slot.listening = true;
        slot.options.onStartRequest?.();
        return true;
      } catch (error) {
        if (error?.name === 'InvalidStateError') {
          slot.listening = true;
          slot.options.onAlreadyRunning?.();
          return true;
        }
        slot.listening = false;
        slot.active = false;
        slot.options.onStartError?.(error);
        return false;
      }
    }

    stopSpeechRecognition(name, options = {}) {
      const slotName = String(name || '').trim();
      const slot = this._speechRecognitionSlots.get(slotName);
      if (!slot) return;
      slot.active = false;
      slot.stopping = true;
      if (slot.restartTimer != null) {
        this._window.clearTimeout(slot.restartTimer);
        slot.restartTimer = null;
      }
      if (slot.recognition) {
        try {
          if (options.abort) slot.recognition.abort();
          else slot.recognition.stop();
        } catch (_) {
          try { slot.recognition.abort(); } catch (_) { /* already stopped */ }
        }
      }
      slot.listening = false;
      if (options.release) this.releaseSpeechRecognition(slotName);
    }

    releaseSpeechRecognition(name) {
      const slotName = String(name || '').trim();
      const slot = this._speechRecognitionSlots.get(slotName);
      if (!slot) return;
      const shouldAbort = slot.active || slot.listening || !slot.stopping;
      slot.active = false;
      slot.stopping = true;
      slot.listening = false;
      if (slot.restartTimer != null) {
        this._window.clearTimeout(slot.restartTimer);
        slot.restartTimer = null;
      }
      const recognition = slot.recognition;
      if (recognition) {
        if (shouldAbort) {
          try { recognition.abort(); } catch (_) { /* already stopped */ }
        }
        for (const eventName of [
          'start', 'audiostart', 'soundstart', 'speechstart', 'speechend',
          'soundend', 'audioend', 'nomatch', 'result', 'error', 'end',
        ]) {
          recognition[`on${eventName}`] = null;
        }
      }
      slot.options = {};
      slot.recognition = null;
      this._speechRecognitionSlots.delete(slotName);
    }

    stopAllSpeechRecognition() {
      for (const slotName of Array.from(this._speechRecognitionSlots.keys())) {
        this.stopSpeechRecognition(slotName, { abort: true, release: true });
      }
    }

    postLog(payload, mutationHeaders = {}) {
      this._requireGrantedCapability('logging', 'logging');
      return this._enqueueLogPayload(payload, mutationHeaders);
    }

    _enqueueLogPayload(payload, mutationHeaders = {}) {
      let body = '';
      try {
        body = jsonBody(payload, mutationHeaders);
      } catch (error) {
        this._recordLogTransportOverflow(payload, 'serialization_failed');
        return Promise.resolve({ ok: false, reason: 'serialization_failed', error });
      }
      return this._enqueueLogRequest({ payload, body, headers: { ...mutationHeaders } });
    }

    _enqueueLogRequest(item) {
      const transport = this._logTransport;
      if (transport.disposed) return Promise.resolve({ ok: false, reason: 'disposed' });
      if (transport.queue.length + transport.inFlight.size >= transport.queueLimit) {
        this._recordLogTransportOverflow(item.payload, 'queue_capacity');
        return Promise.resolve({ ok: false, reason: 'queue_overflow' });
      }
      return new Promise((resolve) => {
        transport.queue.push({ ...item, resolve });
        this._scheduleLogPump();
      });
    }

    _scheduleLogPump(delayMs = this._logTransport.pumpIntervalMs) {
      const transport = this._logTransport;
      if (transport.disposed || transport.pumpTimer != null || !transport.queue.length) return;
      transport.pumpTimer = this._window.setTimeout(() => {
        transport.pumpTimer = null;
        this._pumpLogQueue();
      }, Math.max(0, Number(delayMs || 0)));
    }

    _tryLogBeacon(item) {
      try {
        if (!this._navigator.sendBeacon) return false;
        return !!this._navigator.sendBeacon(
          '/api/game/logs',
          new Blob([item.body], { type: 'application/json' }),
        );
      } catch (_) {
        return false;
      }
    }

    _startLogFetch(item) {
      const transport = this._logTransport;
      transport.nextRequestId = (transport.nextRequestId + 1) % Number.MAX_SAFE_INTEGER;
      const requestId = `log-${Date.now().toString(36)}-${transport.nextRequestId.toString(36)}`;
      const AbortControllerImpl = this._window.AbortController || globalThis.AbortController;
      if (typeof AbortControllerImpl !== 'function') {
        item.resolve({ ok: false, reason: 'unsupported' });
        this._recordLogTransportOverflow(item.payload, 'abort_controller_unavailable');
        this._queueLogOverflowSummary();
        this._resolveLogFlushWaiters();
        return false;
      }
      const controller = new AbortControllerImpl();
      const timeoutId = this._window.setTimeout(() => {
        try { controller.abort(); } catch (_) { /* already aborted */ }
      }, transport.requestTimeoutMs);
      transport.inFlight.set(requestId, { controller, timeoutId, resolve: item.resolve });
      Promise.resolve()
        .then(() => this._fetchImpl('/api/game/logs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(item.headers || {}) },
          body: item.body,
          keepalive: true,
          signal: controller.signal,
        }))
        .then((response) => item.resolve(response))
        .catch((error) => item.resolve({ ok: false, reason: 'request_failed', error }))
        .finally(() => {
          this._window.clearTimeout(timeoutId);
          transport.inFlight.delete(requestId);
          this._queueLogOverflowSummary();
          this._pumpLogQueue({ force: true });
        });
      return true;
    }

    _pumpLogQueue({ force = false } = {}) {
      const transport = this._logTransport;
      if (transport.disposed) return;
      if (transport.pumpTimer != null) {
        this._window.clearTimeout(transport.pumpTimer);
        transport.pumpTimer = null;
      }
      this._queueLogOverflowSummary();
      let sent = 0;
      const budget = force ? transport.queueLimit : 1;
      while (
        transport.queue.length
        && transport.inFlight.size < transport.concurrency
        && sent < budget
      ) {
        const item = transport.queue.shift();
        sent += 1;
        if (this._tryLogBeacon(item)) {
          item.resolve({ ok: true, beacon: true });
          this._queueLogOverflowSummary();
          continue;
        }
        if (!this._startLogFetch(item)) continue;
      }
      if (transport.queue.length) this._scheduleLogPump();
      this._resolveLogFlushWaiters();
    }

    _recordLogTransportOverflow(payload, reason) {
      const transport = this._logTransport;
      transport.overflowDropped = Math.min(Number.MAX_SAFE_INTEGER, transport.overflowDropped + 1);
      transport.overflowReasons[reason] = Math.min(
        Number.MAX_SAFE_INTEGER,
        Number(transport.overflowReasons[reason] || 0) + 1,
      );
      if (!transport.overflowContext && payload && typeof payload === 'object') {
        transport.overflowContext = {
          session_id: String(payload.session_id || this.sessionId || ''),
          game_type: String(payload.game_type || this.routeGameType),
          lanlan_name: String(payload.lanlan_name || this.routeLanlanName || ''),
          source: String(payload.source || this.source),
        };
      }
      if (transport.overflowSignatures.size < DEFAULT_LOG_OVERFLOW_SIGNATURE_LIMIT) {
        transport.overflowSignatures.add(this._logSignature(payload || {}));
      }
      if (!transport.overflowNotified) {
        transport.overflowNotified = true;
        this._logger.originalWarn?.call(
          this._console,
          `[${this.displayName}] [SessionLog] 联合调试日志队列已满，后续数量将通过 overflow 汇总上报`,
        );
      }
    }

    _queueLogOverflowSummary() {
      const transport = this._logTransport;
      if (!transport.overflowDropped || transport.disposed) return;
      if (transport.queue.length + transport.inFlight.size >= transport.queueLimit) return;
      const context = transport.overflowContext || {};
      const droppedCount = transport.overflowDropped;
      const reasons = { ...transport.overflowReasons };
      const distinctSignatureCount = transport.overflowSignatures.size;
      transport.overflowDropped = 0;
      transport.overflowReasons = {};
      transport.overflowSignatures.clear();
      transport.overflowContext = null;
      transport.overflowNotified = false;
      const payload = {
        session_id: context.session_id || this.sessionId,
        game_type: context.game_type || this.routeGameType,
        lanlan_name: context.lanlan_name || this.routeLanlanName,
        source: context.source || this.source,
        level: 'warning',
        category: 'logger',
        event: 'log_queue_overflow',
        message: `联合调试日志发送队列已满，${droppedCount} 条日志未逐条发送`,
        details: {
          dropped_count: droppedCount,
          distinct_signature_count: distinctSignatureCount,
          reasons,
        },
        sensitive_possible: false,
        preserve_message: false,
        preserve_details: false,
      };
      // This is host-owned transport bookkeeping, not a new game API call.
      // During page-exit preservation the public grants are intentionally
      // cleared before an already-started log drain settles. Routing this
      // summary back through postLog() would then throw capability_denied from
      // a fetch-finally callback, preventing the pump/flush waiters from ever
      // completing and leaking the preserved transport.
      void this._enqueueLogPayload(payload, this._logger.mutationHeaders || {});
    }

    _resolveLogFlushWaiters() {
      const transport = this._logTransport;
      if (transport.queue.length || transport.inFlight.size) return;
      const waiters = transport.flushWaiters.splice(0);
      for (const resolve of waiters) resolve({ ok: true });
    }

    flushLogger(options = {}) {
      this._flushLoggerAggregates({ final: !!options.final });
      this._queueLogOverflowSummary();
      const transport = this._logTransport;
      if (transport.disposed) return Promise.resolve({ ok: false, reason: 'disposed' });
      if (!transport.queue.length && !transport.inFlight.size) return Promise.resolve({ ok: true });
      if (transport.flushWaiters.length >= DEFAULT_LOG_FLUSH_WAITER_LIMIT) {
        return Promise.resolve({ ok: false, reason: 'flush_busy' });
      }
      const promise = new Promise((resolve) => transport.flushWaiters.push(resolve));
      this._pumpLogQueue({ force: true });
      return promise;
    }

    _disposeLogTransport() {
      const transport = this._logTransport;
      if (transport.disposed) return;
      transport.disposed = true;
      if (transport.pumpTimer != null) {
        this._window.clearTimeout(transport.pumpTimer);
        transport.pumpTimer = null;
      }
      for (const pending of transport.inFlight.values()) {
        this._window.clearTimeout(pending.timeoutId);
        try { pending.controller.abort(); } catch (_) { /* already aborted */ }
        pending.resolve({ ok: false, reason: 'disposed' });
      }
      transport.inFlight.clear();
      for (const item of transport.queue.splice(0)) {
        item.resolve({ ok: false, reason: 'disposed' });
      }
      const waiters = transport.flushWaiters.splice(0);
      for (const resolve of waiters) resolve({ ok: false, reason: 'disposed' });
      transport.overflowDropped = 0;
      transport.overflowReasons = {};
      transport.overflowSignatures.clear();
      transport.overflowContext = null;
    }

    enableLog(payload, mutationHeaders = {}, options = {}) {
      this._requireGrantedCapability('logging', 'logging');
      return this._post('/api/game/logs/enable', jsonBody(payload, mutationHeaders), {
        headers: mutationHeaders,
        keepalive: true,
        operation: 'log_enable',
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
    }

    configureLogger(options = {}) {
      const logger = this._logger;
      logger.contextProvider = typeof options.contextProvider === 'function' ? options.contextProvider : null;
      logger.enableTimeoutMs = Math.max(1, Number(options.enableTimeoutMs || DEFAULT_LOG_ENABLE_TIMEOUT_MS));
      logger.aggregateLimit = boundedPositiveInteger(options.aggregateLimit, DEFAULT_LOG_AGGREGATE_LIMIT, 1024);
      logger.summaryIntervalMs = Math.max(
        250,
        boundedPositiveInteger(options.summaryIntervalMs, DEFAULT_LOG_SUMMARY_INTERVAL_MS, 60000),
      );
      logger.recoveryQuietMs = Math.max(
        logger.summaryIntervalMs,
        boundedPositiveInteger(options.recoveryQuietMs, DEFAULT_LOG_RECOVERY_QUIET_MS, 300000),
      );
      if (options.captureGlobalErrors !== false) this._installLoggerCapture();
      return this.logger;
    }

    _loggerContext() {
      try {
        const context = this._logger.contextProvider?.() || {};
        return {
          sessionId: String(context.sessionId || context.session_id || this.sessionId || ''),
          lanlanName: String(context.lanlanName || context.lanlan_name || this.routeLanlanName || ''),
        };
      } catch (_) {
        return { sessionId: this.sessionId, lanlanName: this.routeLanlanName };
      }
    }

    _safeLogValue(value, depth = 0, preserve = false, budget = null) {
      if (preserve) return value;
      // Per-leaf truncation alone does not bound the RESULT: three object levels
      // of 30 keys each keeps 27,000 leaves of up to 1,200 characters, i.e. tens
      // of megabytes -- and the send queue holds up to 256 bodies. Carry one
      // cumulative character budget across the whole walk so the shape of the
      // input cannot multiply its way past the per-leaf caps.
      const account = budget || { remaining: LOG_DETAILS_MAX_CHARS };
      const spend = (text) => {
        const bounded = text.length > account.remaining
          ? `${text.slice(0, Math.max(0, account.remaining))}...<truncated>`
          : text;
        account.remaining = Math.max(0, account.remaining - text.length);
        return bounded;
      };
      if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
      if (typeof value === 'string') {
        return spend(value.length > 1200 ? `${value.slice(0, 1200)}...<truncated>` : value);
      }
      if (depth >= 3) return spend(String(value).slice(0, 240));
      if (account.remaining <= 0) return '...<truncated>';
      if (Array.isArray(value)) {
        const result = [];
        for (const item of value.slice(0, 20)) {
          if (account.remaining <= 0) { result.push('...<truncated>'); break; }
          result.push(this._safeLogValue(item, depth + 1, false, account));
        }
        if (value.length > 20) result.push({ _truncated: `+${value.length - 20} items` });
        return result;
      }
      if (typeof value === 'object') {
        const result = {};
        const keys = Object.keys(value);
        for (const key of keys.slice(0, 30)) {
          if (account.remaining <= 0) { result._truncated = 'budget'; break; }
          // Keys carry characters too, and a payload can be all keys.
          account.remaining = Math.max(0, account.remaining - key.length);
          result[key] = this._safeLogValue(value[key], depth + 1, false, account);
        }
        if (keys.length > 30) result._truncated = `+${keys.length - 30} keys`;
        return result;
      }
      return spend(String(value).slice(0, 1200));
    }

    log(level, category, event, message, details = {}, sensitivePossible = false, options = {}) {
      const logger = this._logger;
      if (!logger.enabled) return;
      const preserveDetails = !!(options.preserveDetails || options.noTruncate);
      const preserveMessage = !!(options.preserveMessage || options.noTruncate);
      const context = this._loggerContext();
      const payload = {
        session_id: context.sessionId,
        game_type: this.routeGameType,
        lanlan_name: context.lanlanName,
        source: this.source,
        level,
        category,
        event,
        message: String(message || '').slice(
          0,
          preserveMessage ? LOG_MESSAGE_PRESERVED_MAX_CHARS : LOG_MESSAGE_MAX_CHARS,
        ),
        details: this._safeLogValue(details, 0, preserveDetails),
        sensitive_possible: !!sensitivePossible,
        preserve_message: preserveMessage,
        preserve_details: preserveDetails,
      };
      this._recordOrSendLogPayload(payload);
    }

    _logSignature(payload = {}) {
      const details = payload.details && typeof payload.details === 'object' ? payload.details : {};
      let detailHint = details.error || details.reason || details.error_type || details.code || '';
      if (!detailHint) {
        try {
          detailHint = JSON.stringify(details).slice(0, 800);
        } catch (_) {
          detailHint = String(details).slice(0, 800);
        }
      }
      const raw = [
        payload.level || '',
        payload.category || '',
        payload.event || '',
        String(payload.message || '').slice(0, 600),
        String(detailHint || '').slice(0, 400),
      ].join('|');
      let hash = 2166136261;
      for (let index = 0; index < raw.length; index += 1) {
        hash ^= raw.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return `${String(payload.event || 'log').slice(0, 80)}:${(hash >>> 0).toString(16)}`;
    }

    _shouldAggregateLog(payload) {
      const level = String(payload?.level || '').toLowerCase();
      return level === 'warning' || level === 'warn' || level === 'error';
    }

    _recordOrSendLogPayload(payload) {
      if (!this._shouldAggregateLog(payload)) {
        this._sendLogPayload(payload);
        return;
      }
      const logger = this._logger;
      const signature = this._logSignature(payload);
      const now = Date.now();
      const existing = logger.aggregates.get(signature);
      if (existing) {
        existing.count = Math.min(Number.MAX_SAFE_INTEGER, existing.count + 1);
        existing.lastSeen = now;
        if (!existing.stormNotified) {
          existing.stormNotified = true;
          logger.originalWarn?.call(
            this._console,
            `[${this.displayName}] [SessionLog] 检测到重复日志，开始聚合 signature=${signature}`,
          );
        }
        return;
      }
      if (logger.aggregates.size >= logger.aggregateLimit) {
        let oldestKey = '';
        let oldestEntry = null;
        for (const [key, entry] of logger.aggregates.entries()) {
          if (!oldestEntry || entry.lastSeen < oldestEntry.lastSeen) {
            oldestKey = key;
            oldestEntry = entry;
          }
        }
        if (oldestEntry) {
          this._emitLogAggregateSummary(oldestEntry, { final: true, reason: 'aggregate_capacity' });
          logger.aggregates.delete(oldestKey);
        }
      }
      logger.aggregates.set(signature, {
        signature,
        payload,
        count: 1,
        reportedCount: 1,
        firstSeen: now,
        lastSeen: now,
        lastSummaryAt: now,
        stormNotified: false,
      });
      this._sendLogPayload(payload);
      this._startLoggerMaintenance();
    }

    _aggregateLogPayload(entry, event, message, details = {}) {
      const original = entry.payload || {};
      return {
        session_id: original.session_id || this.sessionId,
        game_type: original.game_type || this.routeGameType,
        lanlan_name: original.lanlan_name || this.routeLanlanName,
        source: original.source || this.source,
        level: event === 'repeated_log_recovered' ? 'info' : 'warning',
        category: 'logger',
        event,
        message,
        details: {
          signature: entry.signature,
          original_level: original.level || '',
          original_category: original.category || '',
          original_event: original.event || '',
          sample_message: String(original.message || '').slice(0, 1200),
          total_count: entry.count,
          first_seen_ms: entry.firstSeen,
          last_seen_ms: entry.lastSeen,
          ...details,
        },
        sensitive_possible: !!original.sensitive_possible,
        preserve_message: false,
        preserve_details: false,
      };
    }

    _emitLogAggregateSummary(entry, options = {}) {
      if (!entry || entry.count <= entry.reportedCount) return false;
      const repeatedSinceLastSummary = entry.count - entry.reportedCount;
      this._sendLogPayload(this._aggregateLogPayload(
        entry,
        'repeated_log_summary',
        `重复日志已聚合：${entry.count} 次`,
        {
          repeated_since_last_summary: repeatedSinceLastSummary,
          final: !!options.final,
          reason: options.reason || 'periodic',
        },
      ));
      entry.reportedCount = entry.count;
      entry.lastSummaryAt = Date.now();
      return true;
    }

    _maintainLoggerAggregates() {
      const logger = this._logger;
      const now = Date.now();
      for (const [signature, entry] of Array.from(logger.aggregates.entries())) {
        const quietMs = Math.max(0, now - entry.lastSeen);
        const summaryAgeMs = Math.max(0, now - entry.lastSummaryAt);
        if (entry.count > entry.reportedCount && summaryAgeMs >= logger.summaryIntervalMs) {
          this._emitLogAggregateSummary(entry);
        }
        if (quietMs < logger.recoveryQuietMs) continue;
        if (entry.count > 1) {
          this._sendLogPayload(this._aggregateLogPayload(
            entry,
            'repeated_log_recovered',
            `重复日志已停止：共 ${entry.count} 次`,
            { quiet_ms: quietMs },
          ));
        }
        logger.aggregates.delete(signature);
      }
      if (!logger.aggregates.size) this._stopLoggerMaintenance();
    }

    _startLoggerMaintenance() {
      const logger = this._logger;
      if (logger.maintenanceTimer != null || !logger.aggregates.size) return;
      logger.maintenanceTimer = this._window.setInterval(
        () => this._maintainLoggerAggregates(),
        logger.summaryIntervalMs,
      );
    }

    _stopLoggerMaintenance() {
      const logger = this._logger;
      if (logger.maintenanceTimer != null) {
        this._window.clearInterval(logger.maintenanceTimer);
        logger.maintenanceTimer = null;
      }
    }

    _flushLoggerAggregates({ final = false } = {}) {
      const logger = this._logger;
      for (const entry of logger.aggregates.values()) {
        this._emitLogAggregateSummary(entry, { final, reason: final ? 'session_flush' : 'manual_flush' });
      }
      if (final) {
        logger.aggregates.clear();
        this._stopLoggerMaintenance();
      }
    }

    _sendLogPayload(payload) {
      const logger = this._logger;
      const security = this._window.nekoLocalMutationSecurity;
      try {
        if (security && typeof security.peekCachedToken === 'function') {
          const token = security.peekCachedToken();
          if (token) {
            void this.postLog(payload, { 'X-CSRF-Token': token });
            return;
          }
        }
      } catch (_) { /* continue with asynchronous credential lookup */ }
      if (security && typeof security.getMutationHeaders === 'function') {
        this.getMutationHeaders()
          .then((headers) => {
            if (!csrfTokenFromHeaders(headers)) {
              this._recordLogTransportOverflow(payload, 'missing_csrf_token');
              return { ok: false, reason: 'missing_csrf_token' };
            }
            logger.mutationHeaders = { ...headers };
            return this.postLog(payload, headers);
          })
          .catch((error) => {
            this._recordLogTransportOverflow(payload, 'credential_lookup_failed');
            return { ok: false, reason: 'credential_lookup_failed', error };
          });
        return;
      }
      if (logger.mutationHeaders) {
        void this.postLog(payload, logger.mutationHeaders);
        return;
      }
      this.getMutationHeaders()
        .then((headers) => {
          if (!csrfTokenFromHeaders(headers)) {
            this._recordLogTransportOverflow(payload, 'missing_csrf_token');
            return { ok: false, reason: 'missing_csrf_token' };
          }
          logger.mutationHeaders = { ...headers };
          return this.postLog(payload, headers);
        })
        .catch((error) => {
          this._recordLogTransportOverflow(payload, 'credential_lookup_failed');
          return { ok: false, reason: 'credential_lookup_failed', error };
        });
    }

    _enableLogWithHeaders(reason, mutationHeaders = {}, options = {}) {
      const logger = this._logger;
      const context = this._loggerContext();
      const enableSessionId = context.sessionId;
      const debugLogMutationHeaders = { ...mutationHeaders };
      const payload = {
        session_id: context.sessionId,
        game_type: this.routeGameType,
        lanlan_name: context.lanlanName,
        source: this.source,
        reason,
      };
      return this.enableLog(payload, mutationHeaders, options)
        .then((response) => response.json().catch(() => ({ ok: false, reason: 'bad_json' })))
        .then((result) => {
          if (result?.ok) logger.mutationHeaders = debugLogMutationHeaders;
          return { ...(result || {}), enabledSessionId: enableSessionId };
        });
    }

    _cancelLoggerEnableTimeout(reason = 'stale_enable_result') {
      const logger = this._logger;
      if (logger.enableTimeoutId != null) {
        this._window.clearTimeout(logger.enableTimeoutId);
        logger.enableTimeoutId = null;
      }
      if (logger.enableTimeoutResolve) {
        const resolve = logger.enableTimeoutResolve;
        logger.enableTimeoutResolve = null;
        resolve({ ok: false, reason });
      }
    }

    resetLogger() {
      const logger = this._logger;
      if (logger.enableController) {
        try { logger.enableController.abort(); } catch (_) { /* already aborted */ }
        logger.enableController = null;
      }
      this._stopLoggerMaintenance();
      logger.aggregates.clear();
      logger.enableGeneration += 1;
      logger.enabled = false;
      logger.enabledSessionId = '';
      logger.enableInFlight = false;
      logger.enablePromise = null;
      logger.mutationHeaders = null;
      this._cancelLoggerEnableTimeout();
    }

    _hasLoggerSendCredentials() {
      const logger = this._logger;
      const security = this._window.nekoLocalMutationSecurity;
      if (csrfTokenFromHeaders(logger.mutationHeaders || {})) return true;
      if (!security || typeof security.peekCachedToken !== 'function') return false;
      try { return !!security.peekCachedToken(); }
      catch (_) { return false; }
    }

    enableLoggerAfterRouteStart() {
      const logger = this._logger;
      if (logger.enabled && logger.enabledSessionId === this.sessionId) {
        return Promise.resolve({ ok: true, skipped: 'already_enabled' });
      }
      if (logger.enabledSessionId !== this.sessionId) logger.enabled = false;
      if (logger.enableInFlight && logger.enablePromise) return logger.enablePromise;
      const generation = logger.enableGeneration;
      let readyHeaders = csrfTokenFromHeaders(logger.mutationHeaders || {})
        ? { ...logger.mutationHeaders }
        : null;
      const security = this._window.nekoLocalMutationSecurity;
      if (!readyHeaders && security && typeof security.peekCachedToken === 'function') {
        try {
          const token = security.peekCachedToken();
          if (token) {
            readyHeaders = { 'Content-Type': 'application/json', 'X-CSRF-Token': token };
          }
        } catch (_) { /* continue with asynchronous credential lookup */ }
      }
      logger.enableInFlight = true;
      const AbortControllerImpl = this._window.AbortController || globalThis.AbortController;
      const enableController = typeof AbortControllerImpl === 'function' ? new AbortControllerImpl() : null;
      const headersPromise = readyHeaders
        ? Promise.resolve(readyHeaders)
        : this.getMutationHeaders();
      return this._startLoggerEnablePromise(
        headersPromise.then((headers) => {
          if (logger.enableGeneration !== generation) return { ok: false, reason: 'stale_enable_result' };
          const debugLogMutationHeaders = { ...(headers || {}) };
          if (!csrfTokenFromHeaders(debugLogMutationHeaders)) {
            return { ok: false, reason: 'missing_csrf_token' };
          }
          // Credentials only prove that logs *can* be sent. The backend still
          // needs an active session entry before /api/game/logs accepts them.
          // Route-start logging therefore uses the same explicit enable
          // endpoint as manual logging instead of toggling the local gate only.
          return this._enableLogWithHeaders('route_start', debugLogMutationHeaders, {
            signal: enableController?.signal,
            timeoutMs: logger.enableTimeoutMs,
          })
            .then((result) => ({ ...(result || {}), enableReason: 'route_start' }));
        }),
        generation,
        enableController,
      );
    }

    _startLoggerEnablePromise(workPromise, generation, enableController = null) {
      const logger = this._logger;
      logger.enableController = enableController;
      const isCurrentGeneration = () => logger.enableGeneration === generation;
      // The generation only tracks TEARDOWN (resetLogger/dispose bump it), but an
      // attempt can stop being the live one in two further ways: its own timeout
      // fires, or a retry supersedes it. The request is aborted on teardown and
      // timeout, while this token also prevents any already-settled continuation
      // from flipping logger.enabled or clobbering the replacement attempt.
      const attemptToken = {};
      logger.enableAttempt = attemptToken;
      const isCurrentAttempt = () => isCurrentGeneration() && logger.enableAttempt === attemptToken;
      const retireAttempt = () => {
        if (logger.enableAttempt === attemptToken) logger.enableAttempt = null;
      };
      this._cancelLoggerEnableTimeout();
      let timeoutId = null;
      const timeoutPromise = new Promise((resolve) => {
        logger.enableTimeoutResolve = resolve;
        timeoutId = this._window.setTimeout(() => {
          if (logger.enableTimeoutId === timeoutId) {
            logger.enableTimeoutId = null;
            logger.enableTimeoutResolve = null;
          }
          retireAttempt();
          try { enableController?.abort(); } catch (_) { /* already aborted */ }
          resolve({ ok: false, reason: 'enable_timeout' });
        }, logger.enableTimeoutMs);
        logger.enableTimeoutId = timeoutId;
      });
      const guardedWork = Promise.resolve(workPromise)
        .then((result) => {
          if (!isCurrentAttempt()) return { ok: false, reason: 'stale_enable_result' };
          return this._onLoggerEnabled(result);
        })
        .catch((error) => {
          // Symmetric on purpose: a late rejection must not overwrite the state
          // of whatever replaced this attempt either.
          if (!isCurrentAttempt()) return { ok: false, reason: 'stale_enable_error' };
          return this._onLoggerEnableFailed(error);
        });
      const enablePromise = Promise.race([guardedWork, timeoutPromise])
        .then((result) => {
          if (!isCurrentGeneration()) return { ok: false, reason: 'stale_enable_result' };
          if (result?.reason === 'enable_timeout') {
            logger.originalWarn?.call(this._console, `[${this.displayName}] [SessionLog] 小游戏场次诊断日志启用超时，稍后可重试`);
          }
          return result;
        })
        .finally(() => {
          if (isCurrentGeneration()) {
            logger.enableInFlight = false;
            if (logger.enablePromise === enablePromise) logger.enablePromise = null;
          }
          if (logger.enableTimeoutId === timeoutId) {
            this._window.clearTimeout(timeoutId);
            logger.enableTimeoutId = null;
            logger.enableTimeoutResolve = null;
          }
          if (logger.enableController === enableController) logger.enableController = null;
        });
      logger.enablePromise = enablePromise;
      return enablePromise;
    }

    _onLoggerEnabled(result) {
      const logger = this._logger;
      if (result?.ok && String(result.enabledSessionId || '') !== this.sessionId) {
        return { ok: false, reason: 'stale_enable_session' };
      }
      if (result?.ok) {
        logger.enabled = true;
        const context = this._loggerContext();
        logger.enabledSessionId = String(result.enabledSessionId || context.sessionId);
        this._console.log(`[${this.displayName}] [SessionLog] 小游戏场次诊断日志已启用`, {
          sessionId: context.sessionId,
          reason: result.enableReason || result.reason || 'unknown',
        });
      } else {
        logger.originalWarn?.call(this._console, `[${this.displayName}] [SessionLog] 小游戏场次诊断日志启用失败`, result || {});
      }
      return result;
    }

    _onLoggerEnableFailed(error) {
      this._logger.originalWarn?.call(
        this._console,
        `[${this.displayName}] [SessionLog] 小游戏场次诊断日志启用请求失败`,
        error,
      );
      return { ok: false, reason: 'request_failed' };
    }

    enableLogger(reason = 'keyboard') {
      const logger = this._logger;
      if (logger.enabled && logger.enabledSessionId === this.sessionId) {
        return Promise.resolve({ ok: true, skipped: 'already_enabled' });
      }
      if (logger.enabledSessionId !== this.sessionId) logger.enabled = false;
      if (logger.enableInFlight && logger.enablePromise) return logger.enablePromise;
      logger.enableInFlight = true;
      const generation = logger.enableGeneration;
      const AbortControllerImpl = this._window.AbortController || globalThis.AbortController;
      const enableController = typeof AbortControllerImpl === 'function' ? new AbortControllerImpl() : null;
      const withEnableReason = (result) => ({ ...(result || {}), enableReason: reason });
      return this._startLoggerEnablePromise(
        this.getMutationHeaders()
          .then((headers) => this._enableLogWithHeaders(reason, headers || {}, {
            signal: enableController?.signal,
            timeoutMs: logger.enableTimeoutMs,
          }))
          .then(withEnableReason),
        generation,
        enableController,
      );
    }

    _installLoggerCapture() {
      const logger = this._logger;
      if (logger.windowErrorHandler || logger.rejectionHandler) return;
      let captureRegistry = GLOBAL_CONSOLE_CAPTURE_REGISTRIES.get(this._console);
      if (!captureRegistry) {
        const consoleObject = this._console;
        captureRegistry = {
          originalWarn: consoleObject.warn,
          originalError: consoleObject.error,
          hosts: new Set(),
          warnWrapper: null,
          errorWrapper: null,
        };
        captureRegistry.warnWrapper = (...args) => {
          captureRegistry.originalWarn?.apply(consoleObject, args);
          for (const host of Array.from(captureRegistry.hosts)) {
            try {
              const message = args.map((item) => {
                try { return String(item); } catch (_) { return '[unprintable]'; }
              }).join(' ');
              host.log('warning', 'frontend', 'console_warn', message, { args }, true);
            } catch (_) { /* global console capture must never change caller control flow */ }
          }
        };
        captureRegistry.errorWrapper = (...args) => {
          captureRegistry.originalError?.apply(consoleObject, args);
          for (const host of Array.from(captureRegistry.hosts)) {
            try {
              const message = args.map((item) => {
                try { return String(item); } catch (_) { return '[unprintable]'; }
              }).join(' ');
              host.log('error', 'frontend', 'console_error', message, { args }, true);
            } catch (_) { /* global console capture must never change caller control flow */ }
          }
        };
        GLOBAL_CONSOLE_CAPTURE_REGISTRIES.set(consoleObject, captureRegistry);
        consoleObject.warn = captureRegistry.warnWrapper;
        consoleObject.error = captureRegistry.errorWrapper;
      }
      captureRegistry.hosts.add(this);
      logger.consoleCaptureRegistry = captureRegistry;
      logger.originalWarn = captureRegistry.originalWarn;
      logger.originalError = captureRegistry.originalError;
      logger.windowErrorHandler = (event) => {
        this.log('error', 'frontend', 'window_error', event.message || '前端脚本错误', {
          filename: event.filename || '',
          lineno: event.lineno || 0,
          colno: event.colno || 0,
          error: event.error && (event.error.stack || event.error.message || String(event.error)),
        });
      };
      logger.rejectionHandler = (event) => {
        const reason = event.reason;
        this.log('error', 'frontend', 'unhandled_rejection', '前端 Promise 未处理异常', {
          reason: reason && (reason.stack || reason.message || String(reason)),
        });
      };
      logger.consoleWarnHandler = captureRegistry.warnWrapper;
      logger.consoleErrorHandler = captureRegistry.errorWrapper;
      this._window.addEventListener('error', logger.windowErrorHandler);
      this._window.addEventListener('unhandledrejection', logger.rejectionHandler);
    }

    _disposeLogger() {
      const logger = this._logger;
      if (logger.windowErrorHandler) {
        this._window.removeEventListener('error', logger.windowErrorHandler);
        logger.windowErrorHandler = null;
      }
      if (logger.rejectionHandler) {
        this._window.removeEventListener('unhandledrejection', logger.rejectionHandler);
        logger.rejectionHandler = null;
      }
      const captureRegistry = logger.consoleCaptureRegistry;
      if (captureRegistry) {
        captureRegistry.hosts.delete(this);
        if (!captureRegistry.hosts.size) {
          if (this._console.warn === captureRegistry.warnWrapper && captureRegistry.originalWarn) {
            this._console.warn = captureRegistry.originalWarn;
          }
          if (this._console.error === captureRegistry.errorWrapper && captureRegistry.originalError) {
            this._console.error = captureRegistry.originalError;
          }
          GLOBAL_CONSOLE_CAPTURE_REGISTRIES.delete(this._console);
        }
      }
      logger.consoleWarnHandler = null;
      logger.consoleErrorHandler = null;
      logger.originalWarn = null;
      logger.originalError = null;
      logger.consoleCaptureRegistry = null;
      logger.contextProvider = null;
      this.resetLogger();
    }

    _pickFields(source, fields, target) {
      if (!source || typeof source !== 'object') return target;
      for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(source, field)) target[field] = source[field];
      }
      return target;
    }

    _projectRouteEndResponse(data) {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
      const projected = this._pickFields(data, ROUTE_END_RESULT_FIELDS, {});
      if (data.archive && typeof data.archive === 'object' && !Array.isArray(data.archive)) {
        const archive = this._pickFields(data.archive, ROUTE_END_ARCHIVE_BASE_FIELDS, {});
        if (this._grantedCapabilities.has('context-read')) {
          this._pickFields(data.archive, ROUTE_END_ARCHIVE_CONTEXT_FIELDS, archive);
        }
        if (this._grantedCapabilities.has('memory')) {
          this._pickFields(data.archive, ROUTE_END_ARCHIVE_MEMORY_FIELDS, archive);
        }
        projected.archive = archive;
      }
      // ``archive_memory`` is the host's own memory-write result and
      // ``postgame.line`` is assistant speech the host owns; neither is game
      // material, so only the postgame outcome survives.
      if (data.postgame && typeof data.postgame === 'object' && !Array.isArray(data.postgame)) {
        projected.postgame = this._pickFields(data.postgame, ROUTE_END_POSTGAME_FIELDS, {});
      }
      return projected;
    }

    async end(payload, options = {}) {
      this._requireGrantedCapability('runtime', 'route_end');
      let parsedPayload = payload;
      if (typeof payload === 'string') {
        try {
          parsedPayload = JSON.parse(payload);
        } catch (cause) {
          throw this._hostError('invalid_payload', `${this.displayName} route end payload is invalid`, {
            operation: 'route_end',
            cause,
          });
        }
      }
      if (!parsedPayload || typeof parsedPayload !== 'object' || Array.isArray(parsedPayload)) {
        throw this._hostError('invalid_payload', `${this.displayName} route end payload must be an object`, {
          operation: 'route_end',
        });
      }
      const requestTimeoutMs = boundedPositiveInteger(options.timeoutMs, 8000, 30000);
      const requestStartedAt = Date.now();
      if (options.signal?.aborted) {
        throw this._hostError('cancelled', `${this.displayName} host request was cancelled`, {
          operation: 'route_end',
        });
      }
      const endingSpeechRoute = this._activeRouteIdentity;
      // An unloading document cannot safely keep accepting route audio while its
      // end beacon races page teardown. Explicit end is different: the backend
      // can reject or time out and the SDK then keeps the route in degraded state,
      // so its tap remains usable until acceptance is known.
      if (options.useBeacon) this._retireActiveSpeechRoute('route_end');
      let body = JSON.stringify(this._trustedRuntimePayload(parsedPayload));
      const finalLogFlush = this.flushLogger({ final: true });
      if (options.useBeacon) {
        // Unload cannot wait for a continuation. flushLogger has already tried
        // sendBeacon synchronously and otherwise started its keepalive fetch.
        void finalLogFlush;
      } else {
        // For an explicit end, give queued logs a bounded head start before the
        // backend marks the diagnostic session ended. Never make route cleanup
        // depend on a slow or unavailable logging endpoint.
        let flushTimeoutId = null;
        let flushAbortHandler = null;
        try {
          const flushRace = [
            finalLogFlush,
            new Promise((resolve) => {
              flushTimeoutId = this._window.setTimeout(
                () => resolve({ ok: false, reason: 'route_end_flush_timeout' }),
                Math.min(DEFAULT_ROUTE_END_LOG_FLUSH_TIMEOUT_MS, requestTimeoutMs),
              );
            }),
          ];
          if (options.signal && typeof options.signal.addEventListener === 'function') {
            flushRace.push(new Promise((resolve) => {
              flushAbortHandler = () => resolve({ ok: false, reason: 'route_end_cancelled' });
              if (options.signal.aborted) flushAbortHandler();
              else options.signal.addEventListener('abort', flushAbortHandler, { once: true });
            }));
          }
          await Promise.race(flushRace);
        } finally {
          if (flushTimeoutId != null) this._window.clearTimeout(flushTimeoutId);
          if (flushAbortHandler) options.signal?.removeEventListener?.('abort', flushAbortHandler);
        }
      }
      if (options.signal?.aborted) {
        throw this._hostError('cancelled', `${this.displayName} host request was cancelled`, {
          operation: 'route_end',
        });
      }
      const elapsedMs = Math.max(0, Date.now() - requestStartedAt);
      const remainingRequestTimeoutMs = requestTimeoutMs - elapsedMs;
      if (remainingRequestTimeoutMs <= 0) {
        throw this._hostError(
          'timeout',
          `${this.displayName} host request timed out after ${requestTimeoutMs}ms`,
          { operation: 'route_end' },
        );
      }
      const sendEndBeacon = () => {
        if (!options.useBeacon || !this._navigator.sendBeacon) return false;
        try {
          return this._navigator.sendBeacon(
            this._gameEndpoint('end'),
            new Blob([body], { type: 'application/json' }),
          ) === true;
        } catch (error) {
          options.onBeaconError?.(error);
          return false;
        }
      };
      if (sendEndBeacon()) return { ok: true, beacon: true };
      if (options.useBeacon && utf8ByteLength(body) > KEEPALIVE_BODY_BYTES) {
        // On unload, keepalive is the only delivery with any chance at all, so
        // shed the CALLER's payload rather than the delivery guarantee. What the
        // backend needs to finalize the route -- identity, generation, reason --
        // is tiny; what makes the body oversized is game-supplied. Losing that is
        // strictly better than losing route cleanup and postgame until the
        // heartbeat sweep expires the route.
        const essential = {};
        for (const key of [
          'reason', 'session_id', 'lanlan_name',
          'sdk_route_instance_id', 'sdk_route_instance_ids',
        ]) {
          if (parsedPayload[key] !== undefined) essential[key] = parsedPayload[key];
        }
        // `reason` is the one retained field a caller controls the size of, so
        // shedding the rest is not enough on its own: an oversized reason would
        // leave the body over quota and `keepalive` then guarantees the failure
        // it was kept for. Trim in decreasing order of usefulness, and verify --
        // never hand `_post` a keepalive body that is still too large.
        if (typeof essential.reason === 'string') {
          essential.reason = essential.reason.slice(0, ROUTE_END_ESSENTIAL_REASON_CHARS);
        }
        const shed = () => {
          body = JSON.stringify(this._trustedRuntimePayload(essential));
          return utf8ByteLength(body) <= KEEPALIVE_BODY_BYTES;
        };
        if (!shed()) {
          delete essential.sdk_route_instance_ids;
          if (!shed()) {
            delete essential.reason;
            shed();
          }
        }
        if (sendEndBeacon()) return { ok: true, beacon: true, truncated: true };
      }
      // Keepalive only while the body fits the shared quota. Past it, fetch
      // rejects before the request is sent, which turned an oversized-but-valid
      // end payload (the SDK admits up to 256 KiB) into a guaranteed failure:
      // explicit end degraded, and an unloading page -- where sendBeacon has
      // already declined the same body above -- skipped route cleanup and
      // postgame entirely until server-side expiry. Dropping keepalive costs
      // nothing on the awaited path and is strictly better than certain failure
      // on the unload path.
      const response = await this._post(this._gameEndpoint('end'), body, {
        // Page-exit keeps keepalive unconditionally: the body was already shed
        // above if it was oversized, and without keepalive an unloading document
        // cancels the request outright. The awaited path drops keepalive instead,
        // where the caller is still there to see the result and an oversized body
        // would otherwise reject before leaving the page.
        // Page exit keeps keepalive only once the body actually fits: the shed
        // above guarantees that, and a keepalive request over the shared 64 KiB
        // quota fails before it leaves the page -- the exact loss keepalive is
        // there to prevent. The awaited path drops keepalive instead, where the
        // caller is still around to see the result.
        keepalive: utf8ByteLength(body) <= KEEPALIVE_BODY_BYTES,
        operation: 'route_end',
        // Honour a caller-supplied deadline, the way every other networked
        // method here does via `...options`. This one enumerates explicitly on
        // purpose (so `operation`/`keepalive`/`headers` cannot be overridden),
        // which silently dropped the `timeoutMs` the SDK does forward and the
        // .d.ts does advertise. Clamped rather than passed through: end carries
        // keepalive and is deliberately preserved across dispose, so a game must
        // not be able to stretch it to minutes. Any invalid value starts from
        // today's 8000ms budget, less time already spent on the final-log flush.
        timeoutMs: remainingRequestTimeoutMs,
        signal: options.signal,
      });
      const data = await response.json().catch(() => ({ ok: response.ok, status: response.status }));
      const projected = this._projectRouteEndResponse(data);
      if (response.ok) {
        if (
          projected?.ok !== false
          && endingSpeechRoute
          && this._activeRouteIdentity === endingSpeechRoute
        ) {
          this._retireActiveSpeechRoute('route_end');
        }
        return projected;
      }
      // A non-2xx body is usually FastAPI's `{"detail": ...}`: it parses fine,
      // carries no `ok`, and no field the projection keeps -- so it arrived as
      // `{}`, and the SDK reads a plain object without `ok` as SUCCESS. The
      // client then retired its route generation and entered `ended` while the
      // backend had refused to close the route.
      return {
        ...(projected && typeof projected === 'object' && !Array.isArray(projected)
          ? projected
          : {}),
        ok: false,
        status: response.status,
      };
    }

    dispose(options = {}) {
      if (this._disposed) return;
      this._disposed = true;
      if (this._hostLocale.windowHandler) {
        this._window.removeEventListener?.('localechange', this._hostLocale.windowHandler);
        this._hostLocale.windowHandler = null;
      }
      this._hostLocale.listeners.clear();
      const preserveLogTransport = options.preserveLogTransport === true;
      // Capture the drain promise before capabilities/logger state are reset.
      // It resolves when every already-queued keepalive log has settled, then
      // performs the normal transport teardown so preservation cannot leak.
      const preservedLogDrain = preserveLogTransport ? this.flushLogger() : null;
      for (const controller of this._pendingStorageLockControllers) {
        try { controller.abort(); } catch (_) { /* already aborted */ }
      }
      this._pendingStorageLockControllers.clear();
      const preserveOperations = new Set(options.preservePendingOperations || []);
      this.cancelPendingRequests('disposed', { preserveOperations });
      this.stopAllSpeechRecognition();
      this._activeRouteIdentity = null;
      this.stopSpeechOutputBridge();
      this.stopVoiceControlBridge('disposed');
      this._grantedCapabilities.clear();
      HOST_DECLARED_COMMANDS.set(this, new Set());
      this.stopGameControlBridge();
      const avatarProvider = HOST_AVATAR_PROVIDERS.get(this);
      HOST_AVATAR_PROVIDERS.delete(this);
      try { avatarProvider?.dispose?.(); }
      catch (error) { this._console.warn(`[${this.displayName}Host] avatar host dispose failed:`, error); }
      try { this._audioHost?.dispose?.(); }
      catch (error) { this._console.warn(`[${this.displayName}Host] audio host dispose failed:`, error); }
      this._disposeLogger();
      if (preservedLogDrain) {
        void preservedLogDrain.finally(() => this._disposeLogTransport());
      } else {
        this._disposeLogTransport();
      }
    }
  }

  const createNekoMiniGameSameOriginHost = function createNekoMiniGameSameOriginHost(options = {}) {
    const gameType = String(options.gameType || '').trim();
    const capabilityProviders = HOST_BOOTSTRAP.capabilityProviders.get(gameType) || null;
    let trustedAvatarHost = null;
    if (typeof capabilityProviders?.avatarHostFactory === 'function') {
      trustedAvatarHost = capabilityProviders.avatarHostFactory(Object.freeze({
        windowImpl: options.windowImpl || window,
        documentImpl: (options.windowImpl || window).document,
        fetchImpl: options.fetchImpl || (options.windowImpl || window).fetch?.bind(options.windowImpl || window),
      }));
    }
    return new NekoMiniGameSameOriginHost({
      ...options,
      // Deliberately overwrite any caller-provided values after the spread.
      avatarHost: undefined,
      trustedAvatarHost,
      launchRegistration: HOST_BOOTSTRAP.registrations.get(gameType) || null,
      capabilityProviders,
    });
  };
  Object.defineProperty(window, FACTORY_PROPERTY, {
    value: createNekoMiniGameSameOriginHost,
    configurable: false,
    enumerable: true,
    writable: false,
  });
  Object.defineProperty(window, 'NekoMiniGameHostError', {
    value: NekoMiniGameHostError,
    configurable: false,
    enumerable: true,
    writable: false,
  });
})();
