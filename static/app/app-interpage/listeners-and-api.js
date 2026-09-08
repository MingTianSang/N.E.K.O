/**
 * app-interpage/listeners-and-api.js
 * Inter-page / cross-tab communication.
 *
 * Handles BroadcastChannel dispatch, postMessage listeners, model hot-reload, UI commands, and overlay cleanup.
 * Dependencies loaded before these parts:
 * - app-state.js -> window.appState, window.appConst
 * Runtime dependencies available by the time handlers fire:
 * - window.showStatusToast
 * - window.stopMicCapture / window.clearAudioQueue
 * - window.live2dManager / window.vrmManager
 * - initLive2DModel / initVRMModel globals
 * Load all parts in filename order; this is a classic global script (no import/export).
 */
(function () {
    'use strict';

    window.appInterpage = window.appInterpage || {};
    const I = window.__appInterpageParts || (window.__appInterpageParts = {});

    // The former single IIFE could not receive cross-window relay events until
    // all hoisted lifecycle helpers were ready. Bind only in the final part to
    // preserve that ordering across parser-blocking external scripts.
    if (I.nekoBroadcastChannel && typeof I.handleNekoBroadcastMessage === 'function') {
        I.nekoBroadcastChannel.onmessage = I.handleNekoBroadcastMessage;
    }
    I.yuiGuideInterpageResources.addEventListener(
        window,
        'neko:tutorial-overlay-relay',
        I.handleYuiGuideRelayedCustomEvent
    );
    I.yuiGuideInterpageResources.addEventListener(
        window,
        'message',
        I.handleYuiGuideRelayedWindowMessage
    );

    function cleanupAppInterpageTransientResources() {
        var compactSurfaceTerminalPosted = true;
        if (typeof I.isStandaloneChatPage === 'function' && I.isStandaloneChatPage()) {
            compactSurfaceTerminalPosted = I.postIdleChatCompactSurfaceUnavailable('pagehide') !== false;
        }
        I.clearYuiGuideChatFlushTimer();
        I.clearIcebreakerBridgeFlushTimer();
        // A failed terminal deliberately retains the last positive heartbeat so
        // its next tick can retry the unavailable state.
        if (compactSurfaceTerminalPosted) I.stopIdleChatCompactSurfaceHeartbeat();
        I.clearYuiGuideChatSpotlightTracking();
    }

    I.yuiGuideInterpageResources.addEventListener(window, 'pagehide', cleanupAppInterpageTransientResources);

    function restoreIdleChatCompactSurfaceAfterPageShow(evt) {
        if (!evt || evt.persisted !== true || !I.isStandaloneChatPage()) return;
        if (document.hidden || !I.isIdleChatSurfaceAvailable()) return;
        var chatHost = window.reactChatWindowHost;
        if (chatHost && typeof chatHost.republishCompactSurfaceLayoutChange === 'function') {
            chatHost.republishCompactSurfaceLayoutChange('pageshow-persisted');
        }
        if (chatHost && typeof chatHost.scheduleCompactMinimizeBallTracking === 'function') {
            chatHost.scheduleCompactMinimizeBallTracking();
        }
    }

    I.yuiGuideInterpageResources.addEventListener(window, 'pageshow', restoreIdleChatCompactSurfaceAfterPageShow);

    I.yuiGuideInterpageResources.addEventListener(window, 'neko:yui-guide:handoff-sent', function (evt) {
        if (I._isRelayingYuiGuideHandoffSent) return;
        I.postInterpageMessage({
            action: 'handoff_sent',
            detail: evt.detail || {},
            timestamp: Date.now()
        });
    });

    // =====================================================================
    // Cross-window avatar forwarding via BroadcastChannel
    // =====================================================================

    // Pet 窗口（/index）捕获头像后，通过 BC 广播给 Chat 窗口
    I.yuiGuideInterpageResources.addEventListener(window, 'chat-avatar-preview-updated', function (evt) {
        // source === 'ipc' 表示此事件来自 BC 注入（setExternalAvatar），不回传避免循环
        var eventSource = evt.detail && evt.detail.source;
        if (eventSource === 'ipc' || eventSource === 'tutorial_override' || eventSource === 'tutorial_override_clear') return;
        var dataUrl = evt.detail && evt.detail.dataUrl;
        if (!dataUrl) return;
        I.postYuiGuideMessageToChat('avatar_updated', {
            lanlan_name: (window.lanlan_config && window.lanlan_config.lanlan_name) || '',
            dataUrl: dataUrl,
            modelType: (evt.detail && evt.detail.modelType) || ''
        });
    });

    function relayIdleChatMinimizedState(evt) {
        var detail = evt && evt.detail && typeof evt.detail === 'object' ? evt.detail : null;
        if (!detail || detail.via === 'broadcast-channel') return;
        var sourceUpdatedAt = Number(detail.timestamp);
        var lifecycleSequence = Number(detail.lifecycleSequence);
        if (!Number.isFinite(sourceUpdatedAt) || sourceUpdatedAt <= 0 ||
            !Number.isSafeInteger(lifecycleSequence) || lifecycleSequence <= 0) return;
        if (detail.available !== false &&
            typeof I.canResumeIdleChatCompactSurfaceLifecycle === 'function' &&
            !I.canResumeIdleChatCompactSurfaceLifecycle(detail)) return;
        var payload = Object.assign({
            action: 'idle_chat_minimized_state',
            source: 'chat-window',
            lanlan_name: I.getCurrentLanlanName(),
            timestamp: Date.now()
        }, detail);
        if (!I.postInterpageMessage(payload)) return;
        var compactSurfaceWasUnavailable = false;
        if (detail.available !== false && typeof I.resumeIdleChatCompactSurfaceLifecycle === 'function') {
            compactSurfaceWasUnavailable = I.resumeIdleChatCompactSurfaceLifecycle(detail) === true;
        }
        if (compactSurfaceWasUnavailable && detail.minimized !== true) {
            var chatHost = window.reactChatWindowHost;
            if (chatHost && typeof chatHost.republishCompactSurfaceLayoutChange === 'function') {
                chatHost.republishCompactSurfaceLayoutChange('native-availability-restored');
            }
            if (chatHost && typeof chatHost.scheduleCompactMinimizeBallTracking === 'function') {
                chatHost.scheduleCompactMinimizeBallTracking();
            }
        }
    }

    I.yuiGuideInterpageResources.addEventListener(window, 'neko:idle-chat-minimized-state', relayIdleChatMinimizedState);

    I.yuiGuideInterpageResources.addEventListener(window, 'neko:compact-surface-layout-change', function (evt) {
        var detail = evt && evt.detail && typeof evt.detail === 'object' ? evt.detail : null;
        I.postIdleChatCompactSurfaceState(detail);
    });

    // Chat 窗口初始化时，向 Pet 窗口请求当前已缓存的头像
    if (I.isStandaloneChatPage()) {
        I.yuiGuideInterpageResources.addEventListener(document, 'visibilitychange', function () {
            if (document.hidden || !I.isIdleChatSurfaceAvailable()) {
                // hidden 页面仍会被 Electron 的 backgroundThrottling:false 定时唤醒；
                // 先广播终止态，再停掉 compact 顶边坐标心跳。
                I.postIdleChatCompactSurfaceUnavailable('visibility-hidden');
                return;
            }
            var chatHost = window.reactChatWindowHost;
            if (chatHost && typeof chatHost.republishCompactSurfaceLayoutChange === 'function') {
                // 生命周期恢复不是几何变化；显式重发一次，不能让相同 snapshot 的去重吞掉 available:true。
                chatHost.republishCompactSurfaceLayoutChange('visibility-visible');
            }
            if (chatHost && typeof chatHost.scheduleCompactMinimizeBallTracking === 'function') {
                chatHost.scheduleCompactMinimizeBallTracking();
            }
        });
        var GOODBYE_COMPOSER_REQUEST_RETRY_DELAYS_MS = [100, 300, 700, 1500, 3000, 5000];
        var goodbyeComposerRequestRetryIndex = 0;
        var goodbyeComposerRequestTimer = 0;
        var postAvatarRequest = function () {
            I.postYuiGuideMessageToPet('request_avatar', {
                lanlan_name: I.getCurrentLanlanName()
            });
        };
        var scheduleGoodbyeComposerRequest = function (delayMs) {
            I.yuiGuideInterpageResources.clearTimeout(goodbyeComposerRequestTimer);
            goodbyeComposerRequestTimer = I.yuiGuideInterpageResources.setTimeout(function () {
                goodbyeComposerRequestTimer = 0;
                postGoodbyeComposerRequest();
            }, Math.max(0, delayMs || 0));
        };
        var postGoodbyeComposerRequest = function () {
            if (I.requestGoodbyeChatComposerHiddenState('standalone-chat-state-request')) {
                goodbyeComposerRequestRetryIndex = 0;
                return;
            }
            if (goodbyeComposerRequestRetryIndex < GOODBYE_COMPOSER_REQUEST_RETRY_DELAYS_MS.length) {
                scheduleGoodbyeComposerRequest(
                    GOODBYE_COMPOSER_REQUEST_RETRY_DELAYS_MS[goodbyeComposerRequestRetryIndex++]
                );
            }
        };
        var postStandaloneChatStateRequests = function () {
            postAvatarRequest();
            scheduleGoodbyeComposerRequest(0);
        };
        if (I.nekoBroadcastChannel || I.getGoodbyeChatComposerHiddenElectronBridge()) {
            postAvatarRequest();
            postGoodbyeComposerRequest();
            I.postYuiGuideMessageToPet('request_tutorial_chat_identity');
            I.postYuiGuideMessageToPet('yui_guide_chat_ready');
            I.yuiGuideInterpageResources.setTimeout(I.drainPendingYuiGuideChatBridgeQueue, 0);
            // 配置注入后统一重新请求状态（postStandaloneChatStateRequests 内部已含头像与 goodbye composer 隐藏状态请求，避免重复补发）
            I.yuiGuideInterpageResources.addEventListener(window, 'neko:config-injected', postStandaloneChatStateRequests);
            I.yuiGuideInterpageResources.addEventListener(window, 'neko:request-goodbye-chat-composer-hidden-state', function () {
                scheduleGoodbyeComposerRequest(0);
            });
            I.yuiGuideInterpageResources.addEventListener(window, 'focus', function () {
                scheduleGoodbyeComposerRequest(0);
            });
            I.yuiGuideInterpageResources.addEventListener(document, 'visibilitychange', function () {
                if (!document.hidden) {
                    scheduleGoodbyeComposerRequest(0);
                }
            });
        }
    }

    // =====================================================================
    // postMessage listeners (fallback for memory_edited & model_saved)
    // =====================================================================

    // Memory-edited from iframe (postMessage fallback)
    window.addEventListener('message', async function (event) {
        // Security: same-origin check
        if (event.origin !== window.location.origin) {
            console.warn('[Security] 拒绝来自不同源的 memory_edited 消息:', event.origin);
            return;
        }

        if (event.data && event.data.type === 'memory_edited') {
            await I.handleMemoryEdited(event.data.catgirl_name);
        }
    });

    // Model-saved / reload_model / window geometry from model_manager (postMessage fallback)
    window.addEventListener('message', async function (event) {
        // Security: same-origin check
        if (event.origin !== window.location.origin) {
            console.warn('[Security] 拒绝来自不同源的消息:', event.origin);
            return;
        }

        // Verify source is a known window (opener or child)
        if (event.source && event.source !== window.opener && !event.source.parent) {
            console.warn('[Security] 拒绝来自未知窗口的消息');
            return;
        }

        if (event.data && (
            event.data.action === 'model_saved'
            || event.data.action === 'reload_model'
            || event.data.action === 'reload_model_parameters'
            || event.data.action === 'model_manager_window_state'
        )) {
            // Deduplicate: same message arrives via both BC and postMessage
            if (
                !I.shouldBypassYuiGuideMessageDedup(event.data.action, event.data)
                && I.isDuplicateMessage(event.data.action, event.data.timestamp)
            ) {
                console.log('[Model] 跳过重复 postMessage:', event.data.action);
                return;
            }
            if (event.data.action === 'reload_model_parameters') {
                await I.handleReloadModelParametersMessage(event.data);
                return;
            }
            if (event.data.action === 'model_manager_window_state') {
                I.handleModelManagerWindowState(event.data);
                return;
            }
            console.log('[Model] 通过 postMessage 收到模型重载通知');
            await I.handleModelReload(event.data?.lanlan_name, event.data?.reloadOptions);
        }
    });

    // 参数编辑器在 BroadcastChannel 不可用时使用 localStorage 触发跨窗口消息。
    window.addEventListener('storage', async function (event) {
        if (event.key !== 'nekopage_message' || !event.newValue) return;
        var message;
        try {
            message = JSON.parse(event.newValue);
        } catch (_) {
            return;
        }
        if (!message || (
            message.action !== 'reload_model_parameters'
            && message.action !== 'model_manager_window_state'
        )) return;
        if (I.isDuplicateMessage(message.action, message.timestamp)) return;
        if (message.action === 'model_manager_window_state') {
            I.handleModelManagerWindowState(message);
            return;
        }
        await I.handleReloadModelParametersMessage(message);
    });

    // 音色应用页的后备通道：没有 BroadcastChannel 时使用 postMessage 同步准备态
    window.addEventListener('message', function (event) {
        if (event.origin !== window.location.origin) {
            console.warn('[Security] 拒绝来自不同源的音色切换消息:', event.origin);
            return;
        }
        var data = event.data || {};
        if (data.action !== 'voice_config_switching' && data.type !== 'voice_config_switching') {
            return;
        }
        I.handleVoiceConfigSwitchingMessage(data);
    });

    window.addEventListener('neko:electron-goodbye-chat-composer-hidden', function (event) {
        I.handleGoodbyeChatComposerHiddenMessage((event && event.detail) || {}, 'electron-ipc');
    });

    window.addEventListener('neko:electron-voice-chat-composer-hidden', function (event) {
        I.handleVoiceChatComposerHiddenMessage((event && event.detail) || {});
    });

    window.addEventListener('neko:config-injected', function (event) {
        var detail = (event && event.detail) || {};
        var lanlanName = I.getCurrentLanlanName() || detail.lanlan_name || '';
        I.consumePendingVoiceChatComposerHiddenMessage(lanlanName);
        I.consumePendingGoodbyeChatComposerHiddenMessage(lanlanName);
    });

    window.addEventListener('message', function (event) {
        if (event.origin !== window.location.origin) {
            console.warn('[Security] 拒绝来自不同源的 idle_activity 消息:', event.origin);
            return;
        }
        var data = event.data || {};
        if (data.action !== 'idle_activity' && data.type !== 'idle_activity') {
            return;
        }
        if (I.isDuplicateMessage('idle_activity', data.timestamp)) {
            return;
        }
        var idleCurrentName = I.getCurrentLanlanName();
        if (data.lanlan_name && (!idleCurrentName || data.lanlan_name !== idleCurrentName)) {
            return;
        }
        I.dispatchCrossWindowIdleActivity({
            source: data.source || 'interaction',
            kind: data.kind === 'conversation' ? 'conversation' : 'interaction',
            via: 'post-message',
            timestamp: data.timestamp || Date.now()
        });
    });

    // N.E.K.O.-PC 多窗口兜底：由 Electron 主进程广播音色切换准备态
    window.addEventListener('neko:electron-voice-config-switching', function (event) {
        I.handleVoiceConfigSwitchingMessage((event && event.detail) || {});
    });

    // =====================================================================
    // Reset current avatar to the built-in default Live2D model
    //
    // Triggered from the Electron tray "Advanced Settings → Reset to Default
    // Avatar" menu via the `reset-to-default-model` IPC. It first validates the
    // built-in Live2D model through the existing temporary hot-reload path, then
    // persists the choice through PUT /api/characters/catgirl/l2d/<name>.
    // =====================================================================
    var DEFAULT_LIVE2D_MODEL_NAME = 'yui-lolita';
    var DEFAULT_LIVE2D_MODEL_PATH = '/static/yui-lolita/yui-lolita.model3.json';
    var DEFAULT_MODEL_PERSIST_TIMEOUT_MS = 10000;
    var _resetToDefaultModelInFlight = false;

    async function resetToDefaultModel() {
        if (_resetToDefaultModelInFlight) {
            console.log('[Model] resetToDefaultModel 已在执行中，忽略重复请求');
            return { success: false, error: 'already_in_flight' };
        }
        _resetToDefaultModelInFlight = true;

        var lanlanName = (window.lanlan_config && window.lanlan_config.lanlan_name) || '';
        var defaultReloadAttempted = false;
        var defaultPersisted = false;
        var persistenceOutcomeUnknown = false;
        var reloadQueueReleasedBeforePersistenceResult = false;
        var reloadQueueHoldToken = 'reset-default-model-' + Date.now() + '-' + Math.random();
        var reloadQueueHeld = false;
        var reloadModel = typeof I.handleModelReload === 'function'
            ? I.handleModelReload
            : (typeof window.handleModelReload === 'function' ? window.handleModelReload : null);
        try {
            // Fail-fast when there is no character context. This happens if the
            // tray IPC fires before `neko:config-injected`, or on a sub-window
            // that never received the injection. Without lanlan_name we cannot
            // PUT the persistence change, and handleModelReload('') would
            // simply re-fetch the unchanged config — masking a no-op as success.
            if (!lanlanName) {
                console.warn('[Model] resetToDefaultModel: 当前没有 lanlan_name，无法持久化默认模型设置');
                throw new Error('missing_lanlan_name');
            }
            if (!reloadModel) {
                throw new Error('model_reload_unavailable');
            }

            // “恢复默认模型”的目标固定为内置 Live2D。先退出 goodbye 并恢复
            // Electron Pet 的完整 viewport，但不要重新显示即将被替换的旧模型；
            // 后面的 PUT + handleModelReload 会直接加载目标 Live2D。
            // helper 即使当前不在 goodbye 也会立即成功；无条件调用还能加入一个
            // 已清除 manager 标志、但尚未完整结束的现有 return lifecycle。
            if (window.appUi && typeof window.appUi.returnFromGoodbye === 'function') {
                var returnedFromGoodbye = await window.appUi.returnFromGoodbye({
                    source: 'reset-to-default-model',
                    retryViewportRestore: true,
                    restoreCurrentModel: false
                });
                if (!returnedFromGoodbye) {
                    throw new Error('goodbye_return_failed');
                }
            } else {
                var visibleReturnBall = document.querySelector(
                    '[id$="-return-button-container"][data-neko-return-visible="true"]'
                );
                var goodbyeActive = typeof window.isNekoGoodbyeModeActive === 'function'
                    ? window.isNekoGoodbyeModeActive()
                    : false;
                if (goodbyeActive || visibleReturnBall) {
                    throw new Error('goodbye_return_unavailable');
                }
            }

            // 先验证内置 Live2D 能在当前页面成功加载。临时配置不会改写服务端，
            // 因此加载或后续 PUT 失败时，仍可从 page_config 恢复原模型。
            defaultReloadAttempted = true;
            var defaultReloadResult = await reloadModel(lanlanName, {
                temporaryConfig: {
                    success: true,
                    model_type: 'live2d',
                    model_path: DEFAULT_LIVE2D_MODEL_PATH,
                    live3d_sub_type: ''
                },
                skipIdleRestore: true,
                skipPersistentExpressions: true,
                suppressToast: true,
                throwOnError: true,
                queueHoldToken: reloadQueueHoldToken
            });
            if (defaultReloadResult !== true) {
                // A queued reload can be displaced by a newer request and
                // resolve false without throwing. It did not validate the
                // default model, so it must not be persisted or rolled back.
                defaultReloadAttempted = false;
                throw new Error('default_model_reload_not_applied');
            }
            reloadQueueHeld = typeof I.releaseModelReloadQueueHold === 'function';

            // Persist the change so that future reloads keep the default avatar.
            var putUrl = '/api/characters/catgirl/l2d/' + encodeURIComponent(lanlanName);
            var persistenceOperationId = 'default-model-' + Date.now() + '-' + Math.random().toString(36).slice(2);
            var persistenceStatusUrl = '/api/characters/catgirl/l2d/persistence/'
                + encodeURIComponent(persistenceOperationId);
            if (typeof window.AbortController !== 'function') {
                throw new Error('model_persist_abort_unavailable');
            }
            async function waitForPersistenceResult() {
                var statusDeadline = Date.now() + DEFAULT_MODEL_PERSIST_TIMEOUT_MS;
                var observedRunningOperation = false;
                while (observedRunningOperation || Date.now() < statusDeadline) {
                    var statusAbortController = new window.AbortController();
                    var statusTimeoutId = window.setTimeout(function () {
                        statusAbortController.abort();
                    }, Math.min(1000, Math.max(1, statusDeadline - Date.now())));
                    try {
                        var statusResponse = await fetch(persistenceStatusUrl, {
                            signal: statusAbortController.signal
                        });
                        var statusData = null;
                        try {
                            statusData = await statusResponse.json();
                        } catch (_) {}
                        if (statusResponse.ok && statusData && (
                            statusData.state === 'succeeded' || statusData.state === 'failed'
                        )) {
                            return statusData;
                        }
                        if (statusResponse.ok && statusData && statusData.state === 'running') {
                            // Once the server has acknowledged the operation,
                            // keep observing it until the real save reaches a
                            // terminal state. The reload queue is released
                            // separately, so this cannot block model changes.
                            observedRunningOperation = true;
                        }
                    } catch (_) {
                        // The original PUT may still be reaching the server, or
                        // this individual status request may have timed out.
                    } finally {
                        window.clearTimeout(statusTimeoutId);
                    }
                    await new Promise(function (resolve) {
                        window.setTimeout(resolve, 100);
                    });
                }
                return { state: 'unknown' };
            }
            var persistenceAbortController = new window.AbortController();
            var persistenceTimeoutId = window.setTimeout(function () {
                persistenceAbortController.abort();
            }, DEFAULT_MODEL_PERSIST_TIMEOUT_MS);
            var putResp;
            var putData = null;
            try {
                putResp = await fetch(putUrl, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model_type: 'live2d',
                        live2d: DEFAULT_LIVE2D_MODEL_NAME,
                        live2d_idle_animation: null,
                        persistence_operation_id: persistenceOperationId,
                        // The frontend already loaded and validated the target.
                        // Avoid a post-save init_one_catgirl failure being reported
                        // after the persistent binding has already changed.
                        apply_runtime: false
                    }),
                    signal: persistenceAbortController.signal
                });
                putData = await putResp.json();
            } catch (persistenceError) {
                // A browser abort or lost response cannot cancel/undo an
                // already-started ConfigManager save. Release queued model
                // changes, then ask the backend for the authoritative result
                // before deciding whether the previous model may be restored.
                if (reloadQueueHeld && typeof I.releaseModelReloadQueueHold === 'function') {
                    I.releaseModelReloadQueueHold(reloadQueueHoldToken);
                    reloadQueueHeld = false;
                    reloadQueueReleasedBeforePersistenceResult = true;
                }
                var persistenceResult = await waitForPersistenceResult();
                if (persistenceResult.state === 'succeeded') {
                    putResp = { ok: true, status: 200 };
                    putData = { success: true };
                } else if (persistenceResult.state === 'failed') {
                    throw new Error(
                        'default_model_persist_failed'
                        + (persistenceResult.error ? (': ' + persistenceResult.error) : '')
                    );
                } else {
                    persistenceOutcomeUnknown = true;
                    throw new Error(
                        persistenceAbortController.signal.aborted
                            ? 'default_model_persist_pending'
                            : 'default_model_persist_unconfirmed'
                    );
                }
            } finally {
                window.clearTimeout(persistenceTimeoutId);
            }
            if (!putResp.ok || !putData || putData.success !== true) {
                var errorDetail = (putData && putData.error) || '';
                throw new Error('HTTP ' + putResp.status + (errorDetail ? (': ' + errorDetail) : ''));
            }
            defaultPersisted = true;
            if (reloadQueueReleasedBeforePersistenceResult) {
                // A queued reload may have fetched the old page_config while
                // the backend save was still running. Re-fetch after the
                // terminal result; handleModelReload queues this behind any
                // active reload, so the last rendered model is authoritative.
                await reloadModel(lanlanName, {
                    suppressToast: true,
                    throwOnError: true,
                    bypassRecentDedup: true
                });
            }
            if (reloadQueueHeld) {
                I.releaseModelReloadQueueHold(reloadQueueHoldToken);
                reloadQueueHeld = false;
            }

            try {
                if (typeof window.showStatusToast === 'function') {
                    window.showStatusToast(
                        (window.t && window.t('model.resetToDefaultSuccess')) || '已恢复默认模型',
                        3000
                    );
                }
            } catch (_) {}

            return { success: true };
        } catch (e) {
            if (reloadQueueHeld && typeof I.releaseModelReloadQueueHold === 'function') {
                I.releaseModelReloadQueueHold(reloadQueueHoldToken);
                reloadQueueHeld = false;
            }
            // 临时热切换失败，或模型已切换但 PUT 失败时，服务端通常仍保留
            // 原 page_config。重新走标准热重载，避免旧模型容器保持隐藏。
            if (defaultReloadAttempted && !defaultPersisted && !persistenceOutcomeUnknown && reloadModel) {
                try {
                    await reloadModel(lanlanName, {
                        suppressToast: true,
                        throwOnError: true,
                        bypassRecentDedup: true
                    });
                } catch (restoreError) {
                    console.error('[Model] 默认模型恢复失败后回退原模型也失败:', restoreError);
                }
            }
            console.error('[Model] 恢复默认模型失败:', e);
            try {
                if (typeof window.showStatusToast === 'function') {
                    window.showStatusToast(
                        (window.t && window.t('model.resetToDefaultFailed')) || '恢复默认模型失败',
                        4000
                    );
                }
            } catch (_) {}
            return { success: false, error: (e && e.message) || String(e) };
        } finally {
            if (reloadQueueHeld && typeof I.releaseModelReloadQueueHold === 'function') {
                I.releaseModelReloadQueueHold(reloadQueueHoldToken);
            }
            _resetToDefaultModelInFlight = false;
        }
    }

    // =====================================================================
    // Public API
    // =====================================================================

    I.mod.nekoBroadcastChannel = I.nekoBroadcastChannel;
    I.mod.handleModelReload = I.handleModelReload;
    I.mod.releaseModelReloadQueueHold = I.releaseModelReloadQueueHold;
    I.mod.resetToDefaultModel = resetToDefaultModel;
    I.mod.handleHideMainUI = I.handleHideMainUI;
    I.mod.handleShowMainUI = I.handleShowMainUI;
    I.mod.isMainUIHiddenByModelManager = I.isMainUIHiddenByModelManager;
    I.mod.handleMemoryEdited = I.handleMemoryEdited;
    I.mod.cleanupLive2DOverlayUI = I.cleanupLive2DOverlayUI;
    I.mod.cleanupVRMOverlayUI = I.cleanupVRMOverlayUI;
    I.mod.cleanupMMDOverlayUI = I.cleanupMMDOverlayUI;
    I.mod.cleanupPNGTuberOverlayUI = I.cleanupPNGTuberOverlayUI;
    I.mod.syncVoiceChatComposerHidden = I.syncVoiceChatComposerHidden;
    I.mod.shouldKeepVoiceComposerHidden = I.shouldKeepVoiceComposerHidden;
    I.mod.applyVoiceComposerHiddenFromActive = I.applyVoiceComposerHiddenFromActive;
    I.mod.postVoiceChatComposerHiddenElectron = I.postVoiceChatComposerHiddenElectron;
    I.mod.handleVoiceChatComposerHiddenMessage = I.handleVoiceChatComposerHiddenMessage;
    I.mod.consumePendingVoiceChatComposerHiddenMessage = I.consumePendingVoiceChatComposerHiddenMessage;
    I.mod.applyGoodbyeChatComposerHidden = I.applyGoodbyeChatComposerHidden;
    I.mod.postGoodbyeChatComposerHiddenElectron = I.postGoodbyeChatComposerHiddenElectron;
    I.mod.handleGoodbyeChatComposerHiddenMessage = I.handleGoodbyeChatComposerHiddenMessage;
    I.mod.postGoodbyeChatComposerHiddenState = I.postGoodbyeChatComposerHiddenState;
    I.mod.requestGoodbyeChatComposerHiddenState = I.requestGoodbyeChatComposerHiddenState;
    I.mod.postCatLocalTextSubmit = I.postCatLocalTextSubmit;
    I.mod.postIcebreakerBridgeEvent = I.postIcebreakerBridgeEvent;
    I.mod.postIcebreakerChoiceSelected = I.postIcebreakerChoiceSelected;
    I.mod.postIcebreakerFreeTextSubmitted = I.postIcebreakerFreeTextSubmitted;
    I.mod.isVoiceConfigSwitching = I.isVoiceConfigSwitching;
    I.mod.waitForVoiceConfigSwitchReady = I.waitForVoiceConfigSwitchReady;
    I.mod.applyTutorialChatIdentityOverride = I.applyTutorialChatIdentityOverride;

    // Backward-compatible window globals
    window.handleModelReload = I.handleModelReload;
    window.resetToDefaultModel = resetToDefaultModel;
    window.handleHideMainUI = I.handleHideMainUI;
    window.handleShowMainUI = I.handleShowMainUI;
    window.isMainUIHiddenByModelManager = I.isMainUIHiddenByModelManager;
    window.cleanupLive2DOverlayUI = I.cleanupLive2DOverlayUI;
    window.cleanupVRMOverlayUI = I.cleanupVRMOverlayUI;
    window.cleanupMMDOverlayUI = I.cleanupMMDOverlayUI;
    window.cleanupPNGTuberOverlayUI = I.cleanupPNGTuberOverlayUI;
    window.syncVoiceChatComposerHidden = I.syncVoiceChatComposerHidden;
    window.shouldKeepVoiceComposerHidden = I.shouldKeepVoiceComposerHidden;
    window.applyGoodbyeChatComposerHidden = I.applyGoodbyeChatComposerHidden;
    window.postGoodbyeChatComposerHiddenState = I.postGoodbyeChatComposerHiddenState;
    window.requestGoodbyeChatComposerHiddenState = I.requestGoodbyeChatComposerHiddenState;
    window.postCatLocalTextSubmit = I.postCatLocalTextSubmit;
    window.isVoiceConfigSwitching = I.isVoiceConfigSwitching;
    window.waitForVoiceConfigSwitchReady = I.waitForVoiceConfigSwitchReady;

    Object.assign(window.appInterpage, I.mod || {});
    delete window.__appInterpageParts;
})();
