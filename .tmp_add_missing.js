
// ===================== 云存档同步与生命周期 =====================

function getCurrentUiLanguage() {
    if (window.i18n && typeof window.i18n.language === 'string' && window.i18n.language.trim()) {
        return window.i18n.language.trim();
    }
    const saved = localStorage.getItem('i18nextLng');
    if (typeof saved === 'string' && saved.trim()) return saved.trim();
    return '';
}

function hasUnsavedNewCatgirlDraft() {
    const form = document.getElementById('catgirl-form-new');
    if (!form) return false;
    const nameInput = form.querySelector('input[name="档案名"]');
    return !!(nameInput && nameInput.value && nameInput.value.trim());
}

const CLOUDSAVE_CHARACTER_SYNC_EVENT_KEY = 'neko_cloudsave_character_sync';
const CLOUDSAVE_CHARACTER_SYNC_MESSAGE_TYPE = 'cloudsave_character_changed';
const CLOUDSAVE_CHARACTER_SYNC_CHANNEL_NAME = 'neko_cloudsave_character_sync';

function handleCloudsaveCharacterSync(data) {
    if (!data || data.type !== CLOUDSAVE_CHARACTER_SYNC_MESSAGE_TYPE) return;
    console.log('[CharacterCardManager] Received cloudsave sync:', data.action);
    loadCharacterCards().catch(e => console.warn('Cloudsave sync refresh failed:', e));
}

(function initCloudsaveSync() {
    if (typeof BroadcastChannel === 'function') {
        try {
            const channel = new BroadcastChannel(CLOUDSAVE_CHARACTER_SYNC_CHANNEL_NAME);
            channel.onmessage = function (event) {
                handleCloudsaveCharacterSync(event.data);
            };
        } catch (e) {
            console.warn('BroadcastChannel init failed:', e);
        }
    }

    window.addEventListener('storage', function (event) {
        if (event.key !== CLOUDSAVE_CHARACTER_SYNC_EVENT_KEY) return;
        try {
            const data = JSON.parse(event.newValue);
            handleCloudsaveCharacterSync(data);
        } catch (e) {
            console.warn('localStorage sync parse failed:', e);
        }
    });
})();

// sendBeacon 生命周期
window.addEventListener('beforeunload', function () {
    try {
        navigator.sendBeacon('/api/beacon/shutdown');
    } catch (e) { /* ignore */ }
});

window.addEventListener('unload', function () {
    try {
        navigator.sendBeacon('/api/beacon/shutdown');
    } catch (e) { /* ignore */ }
});
