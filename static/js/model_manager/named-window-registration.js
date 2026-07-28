(function registerModelManagerNamedWindow() {
    'use strict';

    const MODEL_MANAGER_SINGLETON_WINDOW_NAME = 'neko_model_manager_singleton';
    if (window.opener === null || window.name !== MODEL_MANAGER_SINGLETON_WINDOW_NAME) return;

    const registryKey = `neko:named-window:${MODEL_MANAGER_SINGLETON_WINDOW_NAME}`;
    const focusKey = `neko:named-window-focus:${MODEL_MANAGER_SINGLETON_WINDOW_NAME}`;
    const channelName = 'neko:named-window';
    let heartbeat = null;
    let channel = null;

    function markModelManagerNamedWindowActive() {
        try {
            window.localStorage.setItem(registryKey, JSON.stringify({
                url: window.location.href,
                timestamp: Date.now(),
            }));
        } catch (_) {}
    }

    function clearModelManagerNamedWindowActive() {
        try {
            window.localStorage.removeItem(registryKey);
        } catch (_) {}
    }

    function restoreModelManagerNamedWindowIfMinimized() {
        const api = window.nekoWindowControl;
        if (api && typeof api.restoreIfMinimized === 'function') {
            Promise.resolve(api.restoreIfMinimized()).catch(() => {});
            return;
        }
        try {
            if (document.hidden === true) window.focus();
        } catch (_) {}
    }

    function handleModelManagerNamedWindowMessage(data) {
        if (!data || data.windowName !== MODEL_MANAGER_SINGLETON_WINDOW_NAME) return;
        if (data.type === 'neko:named-window-focus' ||
            data.type === 'neko:named-window-message') {
            restoreModelManagerNamedWindowIfMinimized();
        }
    }

    function startModelManagerNamedWindowRegistration() {
        markModelManagerNamedWindowActive();
        if (!heartbeat) {
            heartbeat = setInterval(markModelManagerNamedWindowActive, 1000);
        }
        if (!channel && typeof BroadcastChannel !== 'undefined') {
            try {
                channel = new BroadcastChannel(channelName);
                channel.onmessage = event => handleModelManagerNamedWindowMessage(event.data);
            } catch (_) {
                channel = null;
            }
        }
    }

    function stopModelManagerNamedWindowRegistration() {
        clearModelManagerNamedWindowActive();
        if (heartbeat) {
            clearInterval(heartbeat);
            heartbeat = null;
        }
        if (channel) {
            try {
                channel.close();
            } catch (_) {}
            channel = null;
        }
    }

    window.addEventListener('storage', event => {
        if (event.key !== focusKey || !event.newValue) return;
        try {
            handleModelManagerNamedWindowMessage(JSON.parse(event.newValue));
        } catch (_) {}
    });
    window.addEventListener('pageshow', startModelManagerNamedWindowRegistration);
    window.addEventListener('pagehide', stopModelManagerNamedWindowRegistration);
    startModelManagerNamedWindowRegistration();
})();
