/**
 * app-minigame-voice-controller.js
 *
 * Main-window owner for the Mini-Game SDK `voice-input` capability.  Games
 * send route-bound control requests over the SDK coordination transports;
 * this controller validates every request against the backend's live route
 * before it starts or stops browser speech recognition.
 *
 * This file is intentionally loaded by index.html only.  chat.html must not
 * create a second microphone owner in Electron's multi-window runtime.
 */
(function (global) {
    'use strict';

    const CHANNEL_NAME = 'neko_game_voice_control_channel';
    const STORAGE_KEY = 'neko_game_voice_control_message';
    const WINDOW_EVENT = 'neko-game-voice-control-message';
    const SPEECH_PLAYBACK_EVENT = 'neko-speech-playback-state';
    const ACTIVE_ROUTE_URL = '/api/game/route/active';
    const ROUTE_VALIDATION_TIMEOUT_MS = 4000;
    const WATCHDOG_INTERVAL_MS = 1500;
    const RECOGNITION_RESTART_DELAY_MS = 250;
    const RECOGNITION_START_TIMEOUT_MS = 4000;
    const ROUTE_RECOVERY_RETRY_DELAY_MS = 500;
    const ROUTE_RECOVERY_RETRY_LIMIT = 3;
    const SEEN_MESSAGE_LIMIT = 256;
    const STOP_EPOCH_ROUTE_LIMIT = 256;
    const TRANSCRIPT_MAX_CHARS = 8192;
    const VALID_ACTIONS = new Set(['query', 'start', 'stop', 'toggle', 'handoff']);

    function stringValue(value) {
        return String(value == null ? '' : value).trim();
    }

    function routeIdentity(value) {
        return Object.freeze({
            gameType: stringValue(value && value.game_type),
            sessionId: stringValue(value && value.session_id),
            routeInstanceId: stringValue(value && value.sdk_route_instance_id)
        });
    }

    function sameRouteIdentity(left, right) {
        return !!left && !!right
            && left.gameType === right.gameType
            && left.sessionId === right.sessionId
            && left.routeInstanceId === right.routeInstanceId;
    }

    function identityIsComplete(identity) {
        return !!identity.gameType && !!identity.sessionId && !!identity.routeInstanceId;
    }

    function routeIdentityKey(identity) {
        if (!identityIsComplete(identity)) return '';
        return `${identity.gameType}\n${identity.sessionId}\n${identity.routeInstanceId}`;
    }

    function activeRouteMatches(payload, identity) {
        return !!payload
            && payload.ok !== false
            && payload.active === true
            && stringValue(payload.game_type) === identity.gameType
            && stringValue(payload.session_id) === identity.sessionId
            && stringValue(payload.sdk_route_instance_id) === identity.routeInstanceId
            && !!identity.routeInstanceId;
    }

    function recognitionLanguage(windowImpl) {
        const raw = (windowImpl.i18next && windowImpl.i18next.language)
            || (windowImpl.navigator && windowImpl.navigator.language)
            || 'zh-CN';
        const tag = String(raw).toLowerCase();
        if (tag.startsWith('zh-tw') || tag === 'zh-hant' || tag.startsWith('zh-hk')) return 'zh-TW';
        if (tag.startsWith('zh')) return 'zh-CN';
        if (tag.startsWith('en')) return 'en-US';
        if (tag.startsWith('ja')) return 'ja-JP';
        if (tag.startsWith('ko')) return 'ko-KR';
        if (tag.startsWith('ru')) return 'ru-RU';
        if (tag.startsWith('es')) return 'es-ES';
        if (tag.startsWith('pt')) return 'pt-BR';
        return String(raw);
    }

    function randomSuffix(windowImpl) {
        try {
            const values = new Uint32Array(2);
            windowImpl.crypto.getRandomValues(values);
            return Array.from(values, function (value) { return value.toString(36); }).join('-');
        } catch (_) {
            return Math.random().toString(36).slice(2, 11);
        }
    }

    class MiniGameVoiceController {
        constructor(options) {
            options = options || {};
            this.window = options.windowImpl || global;
            this.fetchImpl = options.fetchImpl || this.window.fetch;
            this.BroadcastChannelImpl = Object.prototype.hasOwnProperty.call(options, 'BroadcastChannelImpl')
                ? options.BroadcastChannelImpl
                : this.window.BroadcastChannel;
            this.RecognitionImpl = Object.prototype.hasOwnProperty.call(options, 'RecognitionImpl')
                ? options.RecognitionImpl
                : (this.window.SpeechRecognition || this.window.webkitSpeechRecognition);
            if (Object.prototype.hasOwnProperty.call(options, 'storageImpl')) {
                this.storage = options.storageImpl;
            } else {
                try {
                    this.storage = this.window.localStorage;
                } catch (_) {
                    this.storage = null;
                }
            }
            this.watchdogIntervalMs = Math.max(
                50,
                Number(options.watchdogIntervalMs || WATCHDOG_INTERVAL_MS)
            );
            this.restartDelayMs = Math.max(
                0,
                Number(options.restartDelayMs == null
                    ? RECOGNITION_RESTART_DELAY_MS
                    : options.restartDelayMs)
            );
            this.recoveryRetryDelayMs = Math.max(
                25,
                Number(options.recoveryRetryDelayMs || ROUTE_RECOVERY_RETRY_DELAY_MS)
            );
            this.recoveryRetryLimit = Math.max(
                1,
                Number(options.recoveryRetryLimit || ROUTE_RECOVERY_RETRY_LIMIT)
            );
            this.routeValidationTimeoutMs = Math.max(
                250,
                Number(options.routeValidationTimeoutMs || ROUTE_VALIDATION_TIMEOUT_MS)
            );
            this.recognitionStartTimeoutMs = Math.max(
                250,
                Number(options.recognitionStartTimeoutMs || RECOGNITION_START_TIMEOUT_MS)
            );
            this.suspendOrdinaryMic = options.suspendOrdinaryMic
                || this.window.suspendOrdinaryMicCaptureForMiniGameVoice;
            this.restoreOrdinaryMic = options.restoreOrdinaryMic
                || this.window.restoreOrdinaryMicCaptureAfterMiniGameVoice;
            this.completeOrdinaryMicHandoff = options.completeOrdinaryMicHandoff
                || this.window.completeOrdinaryMicCaptureHandoff;
            this.isOrdinaryVoiceActive = options.isOrdinaryVoiceActive
                || this.window.isOrdinaryVoiceSessionActive;
            this.endOrdinaryVoice = options.endOrdinaryVoiceSession
                || this.window.endOrdinaryVoiceSession;
            this.ownerId = `minigame-voice-owner-${Date.now().toString(36)}-${randomSuffix(this.window)}`;
            this.channel = null;
            this.started = false;
            this.disposed = false;
            this.current = null;
            this.ordinaryMicSuspended = false;
            this.ordinaryMicRestoreAllowed = true;
            this.microphoneMuted = false;
            this.speechPlaybackActive = false;
            try {
                this.microphoneMuted = typeof this.window.isMicMuted === 'function'
                    && !!this.window.isMicMuted();
            } catch (_) { /* use the last event-driven value */ }
            try {
                this.speechPlaybackActive = !!(
                    this.window.NekoSpeechPlaybackState
                    && this.window.NekoSpeechPlaybackState.active
                );
            } catch (_) { /* use the last event-driven value */ }
            this.operationChain = Promise.resolve();
            this.watchdogTimer = null;
            this.watchdogInFlight = false;
            this.messageSequence = 0;
            this.transcriptSequence = 0;
            this.seenMessageIds = new Set();
            this.seenMessageOrder = [];
            this.validationControllers = new Set();
            this.stopEpochByRoute = new Map();
            this.ordinaryVoiceIntentEpoch = 0;
            this._storageHandler = this._handleStorageEvent.bind(this);
            this._windowEventHandler = this._handleWindowEvent.bind(this);
            this._micMuteHandler = this._handleMicMute.bind(this);
            this._speechPlaybackHandler = this._handleSpeechPlayback.bind(this);
            this._ordinaryVoiceStartedHandler = this._handleOrdinaryVoiceStarted.bind(this);
            this._unloadHandler = this._handleUnload.bind(this);
        }

        start() {
            if (this.started || this.disposed) return this;
            this.started = true;
            if (typeof this.BroadcastChannelImpl === 'function') {
                try {
                    this.channel = new this.BroadcastChannelImpl(CHANNEL_NAME);
                    this.channel.onmessage = (event) => this._acceptMessage(event && event.data, 'broadcast_channel');
                } catch (_) {
                    this.channel = null;
                }
            }
            this.window.addEventListener('storage', this._storageHandler);
            this.window.addEventListener(WINDOW_EVENT, this._windowEventHandler);
            this.window.addEventListener('mic-mute-state-changed', this._micMuteHandler);
            this.window.addEventListener(SPEECH_PLAYBACK_EVENT, this._speechPlaybackHandler);
            this.window.addEventListener('neko:voice-session-started', this._ordinaryVoiceStartedHandler);
            this.window.addEventListener('pagehide', this._unloadHandler);
            return this;
        }

        getState() {
            const slot = this.current;
            return Object.freeze({
                active: !!(slot && slot.active && !slot.handoffPending),
                listening: !!(slot && slot.listening && !slot.handoffPending),
                muted: this._readMicrophoneMuted(),
                playbackPaused: !!(slot && slot.playbackPaused),
                identity: slot ? slot.identity : null
            });
        }

        _handleStorageEvent(event) {
            if (!event || event.key !== STORAGE_KEY || !event.newValue) return;
            try {
                this._acceptMessage(JSON.parse(event.newValue), 'local_storage');
            } catch (_) {
                // Another/older writer may use this transient key. Ignore it.
            }
        }

        _handleWindowEvent(event) {
            this._acceptMessage(event && event.detail, 'same_document');
        }

        _readMicrophoneMuted() {
            try {
                if (typeof this.window.isMicMuted === 'function') {
                    this.microphoneMuted = !!this.window.isMicMuted();
                }
            } catch (_) { /* retain the last event-driven value */ }
            return this.microphoneMuted;
        }

        _readSpeechPlaybackActive() {
            try {
                if (this.window.NekoSpeechPlaybackState) {
                    this.speechPlaybackActive = !!this.window.NekoSpeechPlaybackState.active;
                }
            } catch (_) { /* retain the last event-driven value */ }
            return this.speechPlaybackActive;
        }

        _readOrdinaryVoiceActive() {
            try {
                return typeof this.isOrdinaryVoiceActive === 'function'
                    && !!this.isOrdinaryVoiceActive();
            } catch (_) {
                return false;
            }
        }

        _stopEpochForIdentity(identity) {
            const key = routeIdentityKey(identity);
            return key ? (this.stopEpochByRoute.get(key) || 0) : 0;
        }

        _stopEpochIsCurrent(identity, expectedEpoch) {
            return this._stopEpochForIdentity(identity) === Number(expectedEpoch || 0);
        }

        async _endOrdinaryVoiceSession() {
            if (typeof this.endOrdinaryVoice !== 'function') {
                return { ok: false, ended: false, reason: 'ordinary_voice_handoff_unavailable' };
            }
            let result;
            try {
                result = await Promise.resolve(this.endOrdinaryVoice({
                    reason: 'mini_game_voice_handoff',
                    cancelReason: 'Voice session handed off to mini-game voice',
                    clearAudio: false,
                    force: true,
                    timeoutMs: 1500
                }));
            } catch (_) {
                return { ok: false, ended: false, reason: 'ordinary_voice_end_failed' };
            }
            if (result === false || (result && result.ok === false)) {
                return Object.assign({
                    ok: false,
                    ended: false,
                    reason: 'ordinary_voice_end_failed'
                }, result && typeof result === 'object' ? result : {});
            }
            return Object.assign({ ok: true, ended: true }, result || {});
        }

        _enqueueOperation(callback) {
            const run = () => Promise.resolve().then(callback);
            this.operationChain = this.operationChain.then(run, run).catch(() => undefined);
            return this.operationChain;
        }

        _handleMicMute(event) {
            const muted = !!(event && event.detail && event.detail.muted);
            this.microphoneMuted = muted;
            if (muted) {
                const slot = this.current;
                if (!slot || !slot.active) return;
                this._scheduleSlotStop(slot, 'microphone_muted', {
                    restoreOrdinaryMic: false,
                    abort: true,
                    routeActive: true
                });
                return;
            }
            // A mute stop deliberately leaves the ordinary pipeline suspended
            // so no browser capture is reopened while the global mute is on.
            // Unmute restores only that original ordinary session; the game
            // microphone remains off until its button is pressed again.
            this._enqueueOperation(() => {
                if (this.disposed || this.current) return undefined;
                return this._restoreOrdinaryMic('microphone_unmuted');
            });
        }

        _handleSpeechPlayback(event) {
            const detail = event && event.detail;
            if (!detail || (detail.type && detail.type !== 'speech_playback_state')) return;
            const active = !!detail.active;
            this.speechPlaybackActive = active;
            const slot = this.current;
            if (!slot || !slot.active) return;
            if (active) {
                // A handoff is not committed until browser recognition is ready
                // and the ordinary session has been ended.  If playback takes
                // the microphone during that window, cancel the transfer
                // immediately; recovery queued on operationChain would be
                // deadlocked behind the in-flight handoff request.
                if (slot.handoffPending) {
                    this._settleRecognitionStart(slot, {
                        ok: false,
                        reason: 'speech_playback_started'
                    });
                    this._fenceSlot(slot, { abort: true });
                    return;
                }
                if (this._pauseSlotForPlayback(slot)) {
                    this._publishState(slot.identity, {
                        ok: true,
                        action: 'query',
                        reason: 'speech_playback_active'
                    });
                }
                return;
            }
            if (!slot.playbackPaused) return;
            this._queueSlotRecovery(slot, 'playback');
        }

        _handleOrdinaryVoiceStarted() {
            void this.stopMiniGameVoiceForOrdinaryVoiceSession();
        }

        _messageDedupKey(message) {
            const messageId = stringValue(message && (message.message_id || message.storage_nonce));
            if (messageId) return `message:${messageId}`;
            const senderId = stringValue(message && message.sender_id);
            const requestId = stringValue(message && message.request_id);
            return requestId ? `request:${senderId}:${requestId}` : '';
        }

        _rememberMessage(message) {
            const key = this._messageDedupKey(message);
            if (!key) return true;
            if (this.seenMessageIds.has(key)) return false;
            this.seenMessageIds.add(key);
            this.seenMessageOrder.push(key);
            while (this.seenMessageOrder.length > SEEN_MESSAGE_LIMIT) {
                this.seenMessageIds.delete(this.seenMessageOrder.shift());
            }
            return true;
        }

        _acceptMessage(message, source) {
            if (this.disposed || !message || message.type !== 'game_voice_control_request') return;
            if (!this._rememberMessage(message)) return;
            const action = stringValue(message.action || 'query').toLowerCase();
            const identity = routeIdentity(message);
            const identityKey = routeIdentityKey(identity);
            const suppliedIntentEpoch = Number(message.ordinary_voice_intent_epoch);
            const hasSuppliedIntentEpoch = action === 'handoff'
                && Object.prototype.hasOwnProperty.call(message, 'ordinary_voice_intent_epoch')
                && Number.isSafeInteger(suppliedIntentEpoch)
                && suppliedIntentEpoch >= 0;
            let stopEpoch = identityKey ? (this.stopEpochByRoute.get(identityKey) || 0) : 0;
            if (action === 'stop' && identityKey) {
                stopEpoch += 1;
                this.stopEpochByRoute.set(identityKey, stopEpoch);
                while (this.stopEpochByRoute.size > STOP_EPOCH_ROUTE_LIMIT) {
                    this.stopEpochByRoute.delete(this.stopEpochByRoute.keys().next().value);
                }
                const slot = this.current;
                if (slot
                        && slot.handoffPending
                        && sameRouteIdentity(slot.identity, identity)) {
                    this._fenceSlot(slot, { abort: true });
                }
            }
            const request = Object.freeze({
                action: action,
                requestId: stringValue(message.request_id),
                identity: identity,
                stopEpoch: stopEpoch,
                ordinaryVoiceIntentEpoch: hasSuppliedIntentEpoch
                    ? suppliedIntentEpoch
                    : this.ordinaryVoiceIntentEpoch,
                source: stringValue(source)
            });
            this.operationChain = this.operationChain
                .then(() => this._handleRequest(request))
                .catch(() => {
                    this._publishRequestFailure(request, 'controller_failed');
                });
        }

        async _fetchActiveRoute(identity) {
            if (typeof this.fetchImpl !== 'function') {
                throw new Error('route_validation_unavailable');
            }
            const activeRouteUrl = `${ACTIVE_ROUTE_URL}?game_type=${encodeURIComponent(identity.gameType)}`
                + `&session_id=${encodeURIComponent(identity.sessionId)}`
                + `&sdk_route_instance_id=${encodeURIComponent(identity.routeInstanceId)}`;
            const AbortControllerImpl = this.window.AbortController;
            const controller = typeof AbortControllerImpl === 'function'
                ? new AbortControllerImpl()
                : null;
            if (controller) this.validationControllers.add(controller);
            let timeoutId = null;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = this.window.setTimeout(() => {
                    try { controller && controller.abort(); } catch (_) { /* already settled */ }
                    reject(new Error('route_validation_timeout'));
                }, this.routeValidationTimeoutMs);
            });
            let response;
            try {
                response = await Promise.race([
                    Promise.resolve().then(() => this.fetchImpl(activeRouteUrl, {
                        method: 'GET',
                        cache: 'no-store',
                        credentials: 'same-origin',
                        headers: { Accept: 'application/json' },
                        ...(controller ? { signal: controller.signal } : {})
                    })),
                    timeoutPromise
                ]);
            } finally {
                if (timeoutId != null) this.window.clearTimeout(timeoutId);
                if (controller) this.validationControllers.delete(controller);
            }
            if (!response || response.ok === false) {
                throw new Error('route_validation_failed');
            }
            const payload = await response.json();
            if (!payload || typeof payload !== 'object') {
                throw new Error('route_validation_failed');
            }
            return payload;
        }

        async _validateIdentity(identity) {
            if (!identityIsComplete(identity)) {
                return { activeRoute: null, matched: false };
            }
            const activeRoute = await this._fetchActiveRoute(identity);
            return {
                activeRoute: activeRoute,
                matched: activeRouteMatches(activeRoute, identity)
            };
        }

        async _handleRequest(request) {
            let validation;
            try {
                validation = await this._validateIdentity(request.identity);
            } catch (_) {
                if (this.disposed) return;
                this._publishRequestFailure(request, 'route_validation_failed');
                return;
            }
            if (this.disposed) return;
            if (!validation.matched) {
                if (request.action === 'stop'
                        && identityIsComplete(request.identity)
                        && this.current
                        && this.current.active
                        && sameRouteIdentity(this.current.identity, request.identity)) {
                    await this._stopForIdentity(request.identity, 'stopped_after_route_end', {
                        abort: true
                    });
                    this._publishState(request.identity, {
                        requestId: request.requestId,
                        action: request.action,
                        ok: true,
                        reason: 'stopped_after_route_end',
                        forceInactive: true,
                        routeActive: false
                    });
                    return;
                }
                this._publishRequestFailure(
                    request,
                    identityIsComplete(request.identity) ? 'route_identity_mismatch' : 'route_identity_required'
                );
                return;
            }
            if (!VALID_ACTIONS.has(request.action)) {
                this._publishRequestFailure(request, 'invalid_action');
                return;
            }
            if (['start', 'toggle', 'handoff'].includes(request.action)
                    && !this._stopEpochIsCurrent(request.identity, request.stopEpoch)) {
                this._publishRequestFailure(request, 'voice_start_cancelled');
                return;
            }
            if (['start', 'toggle', 'handoff'].includes(request.action)
                    && request.ordinaryVoiceIntentEpoch !== this.ordinaryVoiceIntentEpoch) {
                this._publishRequestFailure(request, 'ordinary_voice_handoff_cancelled');
                return;
            }

            if (request.action === 'query') {
                this._publishState(request.identity, {
                    requestId: request.requestId,
                    action: request.action,
                    ok: true,
                    reason: 'queried'
                });
                return;
            }

            if (request.action === 'stop') {
                await this._stopForIdentity(request.identity, 'stopped', {
                    releaseStaleOwner: true
                });
                this._publishState(request.identity, {
                    requestId: request.requestId,
                    action: request.action,
                    ok: true,
                    reason: 'stopped'
                });
                return;
            }

            if (request.action === 'toggle'
                    && this.current
                    && this.current.active
                    && sameRouteIdentity(this.current.identity, request.identity)) {
                await this._stopForIdentity(request.identity, 'toggled_off');
                this._publishState(request.identity, {
                    requestId: request.requestId,
                    action: request.action,
                    ok: true,
                    reason: 'toggled_off'
                });
                return;
            }

            const ownsCurrent = !!this.current
                && this.current.active
                && sameRouteIdentity(this.current.identity, request.identity);
            const ordinaryVoiceActive = this._readOrdinaryVoiceActive();
            if (request.action === 'handoff' && !ownsCurrent && !ordinaryVoiceActive) {
                this._publishState(request.identity, {
                    requestId: request.requestId,
                    action: request.action,
                    ok: true,
                    reason: 'ordinary_voice_inactive',
                    forceInactive: true,
                    ordinaryVoiceIntentEpoch: request.ordinaryVoiceIntentEpoch
                });
                return;
            }

            const started = await this._startForIdentity(request.identity, {
                handoffOrdinaryVoice: ordinaryVoiceActive,
                stopEpoch: request.stopEpoch,
                ordinaryVoiceIntentEpoch: request.ordinaryVoiceIntentEpoch
            });
            if (!started.ok) {
                this._publishRequestFailure(request, started.reason);
                return;
            }
            this._publishState(request.identity, {
                requestId: request.requestId,
                action: request.action,
                ok: true,
                ordinaryVoiceIntentEpoch: request.action === 'handoff'
                    ? request.ordinaryVoiceIntentEpoch
                    : undefined,
                reason: request.action === 'toggle'
                    ? 'toggled_on'
                    : (request.action === 'handoff' ? 'handed_off' : 'started')
            });
        }

        async _suspendOrdinaryMic() {
            if (this.ordinaryMicSuspended) return;
            this.ordinaryMicSuspended = true;
            this.ordinaryMicRestoreAllowed = true;
            if (typeof this.suspendOrdinaryMic === 'function') {
                await Promise.resolve(this.suspendOrdinaryMic());
            }
        }

        async _restoreOrdinaryMic(reason) {
            if (!this.ordinaryMicSuspended) return;
            if (!this.ordinaryMicRestoreAllowed) {
                this.ordinaryMicSuspended = false;
                this.ordinaryMicRestoreAllowed = true;
                if (typeof this.completeOrdinaryMicHandoff === 'function') {
                    await Promise.resolve(this.completeOrdinaryMicHandoff());
                }
                return;
            }
            if (this._readMicrophoneMuted()) return;
            this.ordinaryMicSuspended = false;
            if (typeof this.restoreOrdinaryMic === 'function') {
                await Promise.resolve(this.restoreOrdinaryMic(reason));
            }
        }

        async _startForIdentity(identity, options) {
            options = options || {};
            const handoffOrdinaryVoice = options.handoffOrdinaryVoice === true;
            const stopEpoch = Number(options.stopEpoch || 0);
            const ordinaryVoiceIntentEpoch = Number(options.ordinaryVoiceIntentEpoch || 0);
            if (this.disposed) return { ok: false, reason: 'controller_disposed' };
            if (!this._stopEpochIsCurrent(identity, stopEpoch)) {
                return { ok: false, reason: 'voice_start_cancelled' };
            }
            if (ordinaryVoiceIntentEpoch !== this.ordinaryVoiceIntentEpoch) {
                return { ok: false, reason: 'ordinary_voice_handoff_cancelled' };
            }
            if (this._readMicrophoneMuted()) {
                if (this.current) {
                    await this._stopCurrent('microphone_muted', {
                        restoreOrdinaryMic: false,
                        abort: true
                    });
                }
                return { ok: false, reason: 'microphone_muted' };
            }
            if (this.current && this.current.active && sameRouteIdentity(this.current.identity, identity)) {
                return { ok: true, reason: 'already_started' };
            }
            if (typeof this.RecognitionImpl !== 'function') {
                return { ok: false, reason: 'speech_recognition_unsupported' };
            }
            if (handoffOrdinaryVoice && typeof this.endOrdinaryVoice !== 'function') {
                return { ok: false, reason: 'ordinary_voice_handoff_unavailable' };
            }
            if (handoffOrdinaryVoice && this._readSpeechPlaybackActive()) {
                return { ok: false, reason: 'speech_playback_active' };
            }
            if (this.current) {
                const previousIdentity = this.current.identity;
                await this._stopCurrent('owner_replaced', { restoreOrdinaryMic: false, abort: true });
                this._publishState(previousIdentity, {
                    ok: true,
                    action: 'stop',
                    reason: 'owner_replaced',
                    forceInactive: true,
                    routeActive: false
                });
            }
            if (!this._stopEpochIsCurrent(identity, stopEpoch)) {
                return { ok: false, reason: 'voice_start_cancelled' };
            }
            if (ordinaryVoiceIntentEpoch !== this.ordinaryVoiceIntentEpoch) {
                return { ok: false, reason: 'ordinary_voice_handoff_cancelled' };
            }

            try {
                await this._suspendOrdinaryMic();
            } catch (error) {
                if (error && error.ordinaryVoiceCommitted === true) {
                    this.ordinaryMicRestoreAllowed = false;
                }
                await this._restoreOrdinaryMic('mini-game voice suspend failed');
                return { ok: false, reason: 'ordinary_microphone_suspend_failed' };
            }
            if (!this._stopEpochIsCurrent(identity, stopEpoch)) {
                await this._restoreOrdinaryMic('mini-game voice start cancelled');
                return { ok: false, reason: 'voice_start_cancelled' };
            }
            if (ordinaryVoiceIntentEpoch !== this.ordinaryVoiceIntentEpoch) {
                await this._restoreOrdinaryMic('ordinary voice requested during handoff');
                return { ok: false, reason: 'ordinary_voice_handoff_cancelled' };
            }
            if (this._readMicrophoneMuted()) {
                await this._restoreOrdinaryMic('microphone muted during mini-game voice start');
                return { ok: false, reason: 'microphone_muted' };
            }

            const slot = {
                identity: identity,
                recognition: null,
                active: true,
                listening: false,
                playbackPaused: this._readSpeechPlaybackActive(),
                restartTimer: null,
                recoveryTimer: null,
                recoveryAttempts: 0,
                recoveryQueued: false,
                recognitionStartPromise: null,
                recognitionStartResolve: null,
                handoffPending: handoffOrdinaryVoice,
                handoffCommitted: false,
                transcriptChain: Promise.resolve()
            };
            this.current = slot;
            if (!slot.playbackPaused && !this._startRecognitionForSlot(slot)) {
                await this._stopCurrent('speech_recognition_start_failed', {
                    restoreOrdinaryMic: true,
                    abort: true
                });
                return { ok: false, reason: 'speech_recognition_start_failed' };
            }
            if (handoffOrdinaryVoice) {
                if (!slot.playbackPaused) {
                    const recognitionStart = await this._awaitRecognitionStart(slot);
                    if (!recognitionStart.ok) {
                        await this._stopCurrent(recognitionStart.reason, {
                            restoreOrdinaryMic: true,
                            abort: true
                        });
                        return recognitionStart;
                    }
                }
                if (this.current !== slot
                        || !slot.active
                        || this.disposed
                        || ordinaryVoiceIntentEpoch !== this.ordinaryVoiceIntentEpoch
                        || !this._stopEpochIsCurrent(identity, stopEpoch)) {
                    await this._restoreOrdinaryMic('ordinary voice requested during handoff');
                    return {
                        ok: false,
                        reason: this._stopEpochIsCurrent(identity, stopEpoch)
                            ? 'ordinary_voice_handoff_cancelled'
                            : 'voice_start_cancelled'
                    };
                }
                if (this._readMicrophoneMuted()) {
                    await this._stopCurrent('microphone_muted', {
                        restoreOrdinaryMic: true,
                        abort: true
                    });
                    return { ok: false, reason: 'microphone_muted' };
                }
                if (this._readSpeechPlaybackActive()) {
                    await this._stopCurrent('speech_playback_started', {
                        restoreOrdinaryMic: true,
                        abort: true
                    });
                    return { ok: false, reason: 'speech_playback_started' };
                }
                let validation;
                try {
                    validation = await this._validateIdentity(identity);
                } catch (_) {
                    await this._stopCurrent('route_validation_failed', {
                        restoreOrdinaryMic: true,
                        abort: true
                    });
                    return { ok: false, reason: 'route_validation_failed' };
                }
                const ordinaryVoiceCancelled = ordinaryVoiceIntentEpoch !== this.ordinaryVoiceIntentEpoch;
                const stoppedDuringValidation = !this._stopEpochIsCurrent(identity, stopEpoch);
                if (this.current !== slot
                        || !slot.active
                        || !validation.matched
                        || ordinaryVoiceCancelled
                        || stoppedDuringValidation) {
                    const cancellationReason = ordinaryVoiceCancelled
                        ? 'ordinary_voice_handoff_cancelled'
                        : (stoppedDuringValidation ? 'voice_start_cancelled' : 'route_identity_mismatch');
                    await this._stopCurrent(cancellationReason, {
                        restoreOrdinaryMic: true,
                        abort: true
                    });
                    return {
                        ok: false,
                        reason: cancellationReason
                    };
                }
                if (this._readSpeechPlaybackActive()) {
                    await this._stopCurrent('speech_playback_started', {
                        restoreOrdinaryMic: true,
                        abort: true
                    });
                    return { ok: false, reason: 'speech_playback_started' };
                }
                if (!this._stopEpochIsCurrent(identity, stopEpoch)) {
                    await this._stopCurrent('voice_start_cancelled', {
                        restoreOrdinaryMic: true,
                        abort: true
                    });
                    return { ok: false, reason: 'voice_start_cancelled' };
                }
                if (ordinaryVoiceIntentEpoch !== this.ordinaryVoiceIntentEpoch) {
                    await this._stopCurrent('ordinary_voice_handoff_cancelled', {
                        restoreOrdinaryMic: true,
                        abort: true
                    });
                    return { ok: false, reason: 'ordinary_voice_handoff_cancelled' };
                }
                const handoffResult = await this._endOrdinaryVoiceSession();
                if (!handoffResult.ok) {
                    if (handoffResult.committed === true) {
                        slot.handoffPending = false;
                        slot.handoffCommitted = true;
                        this.ordinaryMicRestoreAllowed = false;
                    }
                    await this._stopCurrent(handoffResult.reason, {
                        restoreOrdinaryMic: true,
                        abort: true
                    });
                    return { ok: false, reason: handoffResult.reason };
                }
                if (this.current !== slot || !slot.active || this.disposed) {
                    slot.handoffPending = false;
                    slot.handoffCommitted = true;
                    this.ordinaryMicRestoreAllowed = false;
                    await this._restoreOrdinaryMic('ordinary voice handoff interrupted after commit');
                    return { ok: false, reason: 'ordinary_voice_handoff_interrupted' };
                }
                slot.handoffPending = false;
                slot.handoffCommitted = true;
                // Keep direct ordinary capture fenced while game voice owns the
                // microphone. Its eventual stop releases the fence but never
                // restores the ordinary session that was explicitly ended.
                this.ordinaryMicRestoreAllowed = false;
            }
            this._startWatchdog();
            return { ok: true, reason: slot.playbackPaused ? 'playback_paused' : 'started' };
        }

        _startRecognitionForSlot(slot) {
            if (this.current !== slot || !slot.active || slot.playbackPaused) return false;
            let recognition = slot.recognition;
            if (!recognition) {
                try {
                    recognition = new this.RecognitionImpl();
                } catch (_) {
                    return false;
                }
                slot.recognition = recognition;
            }
            recognition.lang = recognitionLanguage(this.window);
            recognition.continuous = true;
            recognition.interimResults = false;
            recognition.maxAlternatives = 1;
            slot.recognitionStartPromise = new Promise((resolve) => {
                slot.recognitionStartResolve = resolve;
            });
            recognition.onstart = () => {
                if (this.current !== slot
                        || !slot.active
                        || slot.playbackPaused
                        || slot.recognition !== recognition) return;
                slot.listening = true;
                this._settleRecognitionStart(slot, {
                    ok: true,
                    reason: 'recognition_started'
                });
                if (!slot.handoffPending) {
                    this._publishState(slot.identity, {
                        ok: true,
                        action: 'start',
                        reason: 'recognition_started'
                    });
                }
            };
            recognition.onresult = (event) => {
                if (this.current !== slot
                        || !slot.active
                        || slot.handoffPending
                        || slot.playbackPaused
                        || slot.recognition !== recognition) return;
                let text = '';
                const results = event && event.results ? event.results : [];
                const startIndex = event && typeof event.resultIndex === 'number' ? event.resultIndex : 0;
                for (let index = startIndex; index < results.length; index += 1) {
                    const result = results[index];
                    if (!result || result.isFinal === false) continue;
                    text += (result[0] && result[0].transcript) || '';
                }
                text = String(text).trim().slice(0, TRANSCRIPT_MAX_CHARS);
                if (text) {
                    slot.transcriptChain = slot.transcriptChain
                        .then(() => this._publishTranscriptIfCurrent(slot, text))
                        .catch(() => undefined);
                }
            };
            recognition.onerror = (event) => {
                if (this.current !== slot
                        || !slot.active
                        || slot.playbackPaused
                        || slot.recognition !== recognition) return;
                const code = stringValue(event && event.error) || 'speech_recognition_error';
                if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(code)) {
                    this._settleRecognitionStart(slot, { ok: false, reason: code });
                }
                this._publishError(slot.identity, {
                    code: code,
                    reason: code,
                    action: 'recognition'
                });
                if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(code)) {
                    this._scheduleSlotStop(slot, code, {
                        restoreOrdinaryMic: true,
                        abort: true,
                        routeActive: true
                    });
                }
            };
            recognition.onend = () => {
                if (this.current !== slot
                        || !slot.active
                        || slot.recognition !== recognition) return;
                if (!slot.listening) {
                    this._settleRecognitionStart(slot, {
                        ok: false,
                        reason: 'speech_recognition_start_failed'
                    });
                }
                slot.listening = false;
                if (slot.playbackPaused || this._readSpeechPlaybackActive()) return;
                if (!slot.handoffPending) {
                    this._publishState(slot.identity, {
                        ok: true,
                        action: 'query',
                        reason: 'recognition_ended'
                    });
                }
                this._queueSlotRecovery(slot, 'recognition');
            };

            try {
                recognition.start();
            } catch (error) {
                if (!error || error.name !== 'InvalidStateError') {
                    this._settleRecognitionStart(slot, {
                        ok: false,
                        reason: 'speech_recognition_start_failed'
                    });
                    return false;
                }
                slot.listening = true;
                this._settleRecognitionStart(slot, {
                    ok: true,
                    reason: 'recognition_already_started'
                });
            }
            this._resetSlotRecovery(slot);
            return true;
        }

        _settleRecognitionStart(slot, result) {
            if (!slot || typeof slot.recognitionStartResolve !== 'function') return;
            const resolve = slot.recognitionStartResolve;
            slot.recognitionStartResolve = null;
            resolve(result);
        }

        async _awaitRecognitionStart(slot) {
            if (slot.listening) return { ok: true, reason: 'recognition_started' };
            if (!slot.recognitionStartPromise) {
                return { ok: false, reason: 'speech_recognition_start_failed' };
            }
            let timeoutId = null;
            const timeout = new Promise((resolve) => {
                timeoutId = this.window.setTimeout(() => resolve({
                    ok: false,
                    reason: 'speech_recognition_start_timeout'
                }), this.recognitionStartTimeoutMs);
            });
            try {
                return await Promise.race([slot.recognitionStartPromise, timeout]);
            } finally {
                if (timeoutId != null) this.window.clearTimeout(timeoutId);
            }
        }

        async _publishTranscriptIfCurrent(slot, text) {
            if (this.current !== slot || !slot.active || slot.handoffPending || slot.playbackPaused) return;
            let validation;
            try {
                validation = await this._validateIdentity(slot.identity);
            } catch (_) {
                return;
            }
            if (this.current !== slot || !slot.active || slot.handoffPending || slot.playbackPaused) return;
            if (!validation.matched) {
                this._scheduleSlotStop(slot, 'route_inactive', {
                    restoreOrdinaryMic: true,
                    abort: true,
                    routeActive: false
                });
                return;
            }
            this.transcriptSequence += 1;
            this._postMessage({
                type: 'game_voice_transcript',
                game_type: slot.identity.gameType,
                session_id: slot.identity.sessionId,
                sdk_route_instance_id: slot.identity.routeInstanceId,
                request_id: `game-voice-transcript-${Date.now().toString(36)}-${this.transcriptSequence.toString(36)}`,
                source: 'main_window_speech_recognition',
                timestamp: Date.now(),
                text: text
            });
        }

        async _restartRecognitionIfCurrent(slot) {
            if (this.current !== slot || !slot.active || slot.playbackPaused) return;
            let validation;
            try {
                validation = await this._validateIdentity(slot.identity);
            } catch (_) {
                this._scheduleSlotRecoveryRetry(slot, 'recognition');
                return;
            }
            if (this.current !== slot || !slot.active || slot.playbackPaused) return;
            if (!validation.matched) {
                this._scheduleSlotStop(slot, 'route_inactive', {
                    restoreOrdinaryMic: true,
                    abort: true,
                    routeActive: false
                });
                return;
            }
            if (this._readMicrophoneMuted()) {
                this._scheduleSlotStop(slot, 'microphone_muted', {
                    restoreOrdinaryMic: false,
                    abort: true,
                    routeActive: true
                });
                return;
            }
            if (this._readSpeechPlaybackActive()) {
                this._pauseSlotForPlayback(slot);
                return;
            }
            if (slot.restartTimer != null) this.window.clearTimeout(slot.restartTimer);
            slot.restartTimer = this.window.setTimeout(() => {
                slot.restartTimer = null;
                if (this.current !== slot || !slot.active || slot.playbackPaused) return;
                if (this._readSpeechPlaybackActive()) {
                    this._pauseSlotForPlayback(slot);
                    return;
                }
                if (!this._startRecognitionForSlot(slot)) {
                    this._publishError(slot.identity, {
                        code: 'speech_recognition_restart_failed',
                        reason: 'speech_recognition_restart_failed',
                        action: 'recognition'
                    });
                    this._scheduleSlotStop(slot, 'speech_recognition_restart_failed', {
                        restoreOrdinaryMic: true,
                        abort: true,
                        routeActive: true
                    });
                }
            }, this.restartDelayMs);
        }

        _resetSlotRecovery(slot) {
            if (!slot) return;
            if (slot.recoveryTimer != null) {
                this.window.clearTimeout(slot.recoveryTimer);
                slot.recoveryTimer = null;
            }
            slot.recoveryAttempts = 0;
        }

        _scheduleSlotRecoveryRetry(slot, mode) {
            if (!slot
                    || this.current !== slot
                    || !slot.active
                    || slot.recoveryTimer != null
                    || slot.recoveryAttempts >= this.recoveryRetryLimit) return false;
            slot.recoveryAttempts += 1;
            slot.recoveryTimer = this.window.setTimeout(() => {
                slot.recoveryTimer = null;
                this._queueSlotRecovery(slot, mode);
            }, this.recoveryRetryDelayMs);
            return true;
        }

        _queueSlotRecovery(slot, mode) {
            if (!slot
                    || this.current !== slot
                    || !slot.active
                    || slot.recoveryQueued
                    || slot.recoveryTimer != null) return false;
            slot.recoveryQueued = true;
            this._enqueueOperation(async () => {
                try {
                    if (this.current !== slot || !slot.active) return;
                    if (mode === 'playback') await this._resumeSlotAfterPlayback(slot);
                    else await this._restartRecognitionIfCurrent(slot);
                } finally {
                    slot.recoveryQueued = false;
                }
            });
            return true;
        }

        _pauseSlotForPlayback(slot) {
            if (!slot || this.current !== slot || !slot.active) return false;
            const changed = !slot.playbackPaused || !!slot.listening || !!slot.recognition;
            slot.playbackPaused = true;
            slot.listening = false;
            if (slot.restartTimer != null) {
                this.window.clearTimeout(slot.restartTimer);
                slot.restartTimer = null;
            }
            this._resetSlotRecovery(slot);
            const recognition = slot.recognition;
            slot.recognition = null;
            if (recognition) {
                recognition.onstart = null;
                recognition.onresult = null;
                recognition.onerror = null;
                recognition.onend = null;
                try { recognition.abort(); } catch (_) { /* already stopped */ }
            }
            return changed;
        }

        async _resumeSlotAfterPlayback(slot) {
            if (this.current !== slot || !slot.active || !slot.playbackPaused) return;
            if (this._readSpeechPlaybackActive()) return;
            if (this._readMicrophoneMuted()) {
                await this._stopCurrent('microphone_muted', {
                    restoreOrdinaryMic: false,
                    abort: true
                });
                this._publishState(slot.identity, {
                    ok: false,
                    action: 'stop',
                    reason: 'microphone_muted',
                    forceInactive: true,
                    routeActive: true
                });
                return;
            }
            let validation;
            try {
                validation = await this._validateIdentity(slot.identity);
            } catch (_) {
                this._scheduleSlotRecoveryRetry(slot, 'playback');
                return;
            }
            if (this.current !== slot || !slot.active || this._readSpeechPlaybackActive()) return;
            if (!validation.matched) {
                await this._stopCurrent('route_inactive', {
                    restoreOrdinaryMic: true,
                    abort: true
                });
                this._publishState(slot.identity, {
                    ok: false,
                    action: 'stop',
                    reason: 'route_inactive',
                    forceInactive: true,
                    routeActive: false
                });
                return;
            }
            slot.playbackPaused = false;
            if (!this._startRecognitionForSlot(slot)) {
                await this._stopCurrent('speech_recognition_restart_failed', {
                    restoreOrdinaryMic: true,
                    abort: true
                });
                this._publishError(slot.identity, {
                    code: 'speech_recognition_restart_failed',
                    reason: 'speech_recognition_restart_failed',
                    action: 'recognition'
                });
                this._publishState(slot.identity, {
                    ok: false,
                    action: 'stop',
                    reason: 'speech_recognition_restart_failed',
                    forceInactive: true,
                    routeActive: true
                });
                return;
            }
            this._publishState(slot.identity, {
                ok: true,
                action: 'start',
                reason: 'speech_playback_ended'
            });
        }

        async _stopForIdentity(identity, reason, options) {
            options = options || {};
            const slot = this.current;
            if (!slot) {
                await this._restoreOrdinaryMic(reason);
                return false;
            }
            const sameIdentity = sameRouteIdentity(slot.identity, identity);
            if (!sameIdentity && options.releaseStaleOwner !== true) return false;
            if (!sameIdentity) {
                let ownerValidation;
                try {
                    ownerValidation = await this._validateIdentity(slot.identity);
                } catch (_) {
                    return false;
                }
                if (this.current !== slot || !slot.active || ownerValidation.matched) {
                    return false;
                }
            }
            await this._stopCurrent(reason, {
                restoreOrdinaryMic: true,
                abort: options.abort === true || !sameIdentity
            });
            if (!sameIdentity) {
                this._publishState(slot.identity, {
                    ok: true,
                    action: 'stop',
                    reason: 'stale_owner_released',
                    forceInactive: true,
                    routeActive: false
                });
            }
            return true;
        }

        _fenceSlot(slot, options) {
            options = options || {};
            if (!slot || this.current !== slot || !slot.active) return false;
            this._settleRecognitionStart(slot, {
                ok: false,
                reason: 'speech_recognition_start_cancelled'
            });
            slot.active = false;
            slot.listening = false;
            this.current = null;
            this._stopWatchdog();
            if (slot.restartTimer != null) {
                this.window.clearTimeout(slot.restartTimer);
                slot.restartTimer = null;
            }
            this._resetSlotRecovery(slot);
            const recognition = slot.recognition;
            slot.recognition = null;
            if (recognition) {
                recognition.onstart = null;
                recognition.onresult = null;
                recognition.onerror = null;
                recognition.onend = null;
                try {
                    if (options.abort) recognition.abort();
                    else recognition.stop();
                } catch (_) {
                    try { recognition.abort(); } catch (_) { /* already stopped */ }
                }
            }
            return true;
        }

        _scheduleSlotStop(slot, reason, options) {
            options = options || {};
            if (!this._fenceSlot(slot, { abort: options.abort !== false })) return false;
            this._enqueueOperation(async () => {
                if (options.restoreOrdinaryMic !== false && !this.current) {
                    await this._restoreOrdinaryMic(reason);
                }
                this._publishState(slot.identity, {
                    ok: false,
                    action: 'stop',
                    reason: reason,
                    forceInactive: true,
                    routeActive: options.routeActive !== false
                });
            });
            return true;
        }

        async _stopCurrent(reason, options) {
            options = options || {};
            const slot = this.current;
            if (!slot) {
                if (options.restoreOrdinaryMic !== false) await this._restoreOrdinaryMic(reason);
                return;
            }
            this._fenceSlot(slot, { abort: options.abort === true });
            if (options.restoreOrdinaryMic !== false) {
                await this._restoreOrdinaryMic(reason);
            }
        }

        stopMiniGameVoiceForOrdinaryVoiceSession() {
            this.ordinaryVoiceIntentEpoch += 1;
            const stoppedSlots = [];
            const immediateSlot = this.current;
            if (immediateSlot && this._fenceSlot(immediateSlot, { abort: true })) {
                stoppedSlots.push(immediateSlot);
            }
            return this._enqueueOperation(async () => {
                const queuedSlot = this.current;
                if (queuedSlot && this._fenceSlot(queuedSlot, { abort: true })) {
                    stoppedSlots.push(queuedSlot);
                }
                this.ordinaryMicSuspended = false;
                this.ordinaryMicRestoreAllowed = true;
                if (typeof this.completeOrdinaryMicHandoff === 'function') {
                    await Promise.resolve(this.completeOrdinaryMicHandoff());
                }
                for (const slot of stoppedSlots) {
                    this._publishState(slot.identity, {
                        ok: true,
                        action: 'stop',
                        reason: 'ordinary_voice_started',
                        forceInactive: true,
                        routeActive: true
                    });
                }
                return stoppedSlots.length > 0;
            });
        }

        _startWatchdog() {
            this._stopWatchdog();
            this.watchdogTimer = this.window.setInterval(() => {
                void this._watchdogTick();
            }, this.watchdogIntervalMs);
        }

        _stopWatchdog() {
            if (this.watchdogTimer != null) {
                this.window.clearInterval(this.watchdogTimer);
                this.watchdogTimer = null;
            }
            this.watchdogInFlight = false;
        }

        async _watchdogTick() {
            const slot = this.current;
            if (!slot || !slot.active || this.watchdogInFlight) return;
            this.watchdogInFlight = true;
            try {
                const validation = await this._validateIdentity(slot.identity);
                if (this.current !== slot || !slot.active) return;
                if (!validation.matched) {
                    this._scheduleSlotStop(slot, 'route_inactive', {
                        restoreOrdinaryMic: true,
                        abort: true,
                        routeActive: false
                    });
                    return;
                }
                if (this._readMicrophoneMuted()) {
                    this._scheduleSlotStop(slot, 'microphone_muted', {
                        restoreOrdinaryMic: false,
                        abort: true,
                        routeActive: true
                    });
                    return;
                }
                if (slot.recoveryAttempts >= this.recoveryRetryLimit
                        && slot.recoveryTimer == null) {
                    slot.recoveryAttempts = 0;
                }
                if (slot.playbackPaused) {
                    if (!this._readSpeechPlaybackActive()) {
                        this._queueSlotRecovery(slot, 'playback');
                    }
                    return;
                }
                if (!slot.listening && slot.restartTimer == null) {
                    if (this._readSpeechPlaybackActive()) this._pauseSlotForPlayback(slot);
                    else this._queueSlotRecovery(slot, 'recognition');
                }
            } catch (_) {
                // A transient health/read failure is not proof that the route
                // ended. The next bounded watchdog tick retries.
            } finally {
                this.watchdogInFlight = false;
            }
        }

        _stateForIdentity(identity, forceInactive, routeActive) {
            const ownsCurrent = !!this.current
                && this.current.active
                && !this.current.handoffPending
                && sameRouteIdentity(this.current.identity, identity)
                && !forceInactive;
            return {
                active: ownsCurrent,
                listening: ownsCurrent && !!this.current.listening,
                pending: false,
                route_active: routeActive !== false,
                ordinary_voice_active: this._readOrdinaryVoiceActive(),
                microphone_muted: this._readMicrophoneMuted()
            };
        }

        _publishState(identity, details) {
            details = details || {};
            this._postMessage(Object.assign({
                type: 'game_voice_control_state',
                owner_id: this.ownerId,
                game_type: identity.gameType,
                session_id: identity.sessionId,
                sdk_route_instance_id: identity.routeInstanceId,
                request_id: stringValue(details.requestId),
                action: stringValue(details.action || 'query'),
                ok: details.ok !== false,
                reason: stringValue(details.reason || 'state'),
                timestamp: Date.now(),
                ...(Number.isSafeInteger(details.ordinaryVoiceIntentEpoch)
                    ? { ordinary_voice_intent_epoch: details.ordinaryVoiceIntentEpoch }
                    : {})
            }, this._stateForIdentity(
                identity,
                details.forceInactive === true,
                details.routeActive
            )));
        }

        _publishError(identity, details) {
            details = details || {};
            this._postMessage({
                type: 'game_voice_control_error',
                owner_id: this.ownerId,
                game_type: identity.gameType,
                session_id: identity.sessionId,
                sdk_route_instance_id: identity.routeInstanceId,
                request_id: stringValue(details.requestId),
                action: stringValue(details.action || 'query'),
                ok: false,
                code: stringValue(details.code || details.reason || 'voice_control_failed'),
                reason: stringValue(details.reason || details.code || 'voice_control_failed'),
                timestamp: Date.now()
            });
        }

        _publishRequestFailure(request, reason) {
            const identityRejected = [
                'route_identity_mismatch',
                'route_identity_required'
            ].includes(reason);
            this._publishError(request.identity, {
                requestId: request.requestId,
                action: request.action,
                code: reason,
                reason: reason
            });
            this._publishState(request.identity, {
                requestId: request.requestId,
                action: request.action,
                ok: false,
                reason: reason,
                ordinaryVoiceIntentEpoch: request.action === 'handoff'
                    ? request.ordinaryVoiceIntentEpoch
                    : undefined,
                // A transient validation read failure is not proof that an
                // already-running recognizer stopped. Preserve its active bit
                // so the game button cannot drift to "off" while the mic is
                // still live. Only an incomplete/stale identity is known not
                // to own the authoritative route.
                forceInactive: identityRejected,
                routeActive: !identityRejected
            });
        }

        _nextMessageId() {
            this.messageSequence += 1;
            return `main-game-voice-${Date.now().toString(36)}-${this.messageSequence.toString(36)}-${this.ownerId}`;
        }

        _postMessage(payload) {
            if (this.disposed && payload.type !== 'game_voice_control_state') return false;
            const messageId = stringValue(payload.message_id) || this._nextMessageId();
            const message = Object.assign({}, payload, {
                message_id: messageId,
                storage_nonce: messageId
            });
            let posted = false;
            if (this.channel) {
                try {
                    this.channel.postMessage(message);
                    posted = true;
                } catch (_) {
                    try { this.channel.close(); } catch (_) { /* unusable channel */ }
                    this.channel = null;
                }
            }
            let serialized = '';
            try {
                serialized = JSON.stringify(message);
                if (this.storage && typeof this.storage.setItem === 'function') {
                    this.storage.setItem(STORAGE_KEY, serialized);
                    this.window.setTimeout(() => {
                        try {
                            if (this.storage.getItem(STORAGE_KEY) === serialized) {
                                this.storage.removeItem(STORAGE_KEY);
                            }
                        } catch (_) { /* transient coordination cleanup */ }
                    }, 0);
                    posted = true;
                }
            } catch (_) {
                serialized = '';
            }
            try {
                const CustomEventImpl = this.window.CustomEvent || global.CustomEvent;
                if (typeof this.window.dispatchEvent === 'function' && typeof CustomEventImpl === 'function') {
                    this.window.dispatchEvent(new CustomEventImpl(WINDOW_EVENT, {
                        detail: serialized ? JSON.parse(serialized) : message
                    }));
                    posted = true;
                }
            } catch (_) {
                // BroadcastChannel/localStorage may still have delivered it.
            }
            return posted;
        }

        _handleUnload(event) {
            if (event && event.type === 'pagehide' && event.persisted === true) return;
            void this.dispose({ restoreOrdinaryMic: false, abort: true });
        }

        async dispose(options) {
            if (this.disposed) return;
            options = options || {};
            this.disposed = true;
            this.started = false;
            this.window.removeEventListener('storage', this._storageHandler);
            this.window.removeEventListener(WINDOW_EVENT, this._windowEventHandler);
            this.window.removeEventListener('mic-mute-state-changed', this._micMuteHandler);
            this.window.removeEventListener(SPEECH_PLAYBACK_EVENT, this._speechPlaybackHandler);
            this.window.removeEventListener('neko:voice-session-started', this._ordinaryVoiceStartedHandler);
            this.window.removeEventListener('pagehide', this._unloadHandler);
            if (this.channel) {
                this.channel.onmessage = null;
                try { this.channel.close(); } catch (_) { /* already closed */ }
                this.channel = null;
            }
            this.seenMessageIds.clear();
            this.seenMessageOrder.length = 0;
            this.stopEpochByRoute.clear();
            for (const controller of this.validationControllers) {
                try { controller.abort(); } catch (_) { /* already settled */ }
            }
            this.validationControllers.clear();
            await this._stopCurrent('controller_disposed', {
                restoreOrdinaryMic: options.restoreOrdinaryMic !== false,
                abort: options.abort !== false
            });
        }
    }

    function createMiniGameVoiceController(options) {
        return new MiniGameVoiceController(options);
    }

    let instance = global.__nekoMiniGameVoiceControllerInstance || null;
    if (!instance && global.__NEKO_MINIGAME_VOICE_CONTROLLER_DISABLE_AUTO_INIT__ !== true) {
        instance = createMiniGameVoiceController();
        instance.start();
        global.__nekoMiniGameVoiceControllerInstance = instance;
    }
    global.stopMiniGameVoiceForOrdinaryVoiceSession = function () {
        const owner = global.__nekoMiniGameVoiceControllerInstance || instance;
        if (!owner || typeof owner.stopMiniGameVoiceForOrdinaryVoiceSession !== 'function') {
            return Promise.resolve(false);
        }
        return owner.stopMiniGameVoiceForOrdinaryVoiceSession();
    };

    global.NekoMiniGameVoiceController = Object.freeze({
        channelName: CHANNEL_NAME,
        storageKey: STORAGE_KEY,
        windowEvent: WINDOW_EVENT,
        create: createMiniGameVoiceController,
        instance: instance
    });
})(window);
