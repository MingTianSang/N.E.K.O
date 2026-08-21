const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const SOURCE_PATH = path.join(PROJECT_ROOT, 'static', 'js', 'api_key_settings.js');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

function sourceBetween(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
    assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
    return source.slice(start, end);
}

function createSelect() {
    const select = {
        options: [],
        dataset: {},
        value: '',
        appendChild(option) {
            this.options.push(option);
        },
        addEventListener() {},
    };
    Object.defineProperty(select, 'innerHTML', {
        set(value) {
            assert.equal(value, '');
            this.options.length = 0;
        },
    });
    return select;
}

function createInput(value = '') {
    const attributes = new Map();
    const group = { style: {} };
    return {
        value,
        dataset: {},
        placeholder: '',
        parentElement: group,
        setAttribute(name, attributeValue) {
            attributes.set(name, String(attributeValue));
        },
        removeAttribute(name) {
            attributes.delete(name);
        },
        hasAttribute(name) {
            return attributes.has(name);
        },
        getAttribute(name) {
            return attributes.get(name) ?? null;
        },
        closest() {
            return group;
        },
    };
}

function createContext() {
    const rememberedProviderUrls = [];
    const mimoTokenPlanState = { active: false };
    const selects = {
        coreApiSelect: createSelect(),
        assistApiSelect: createSelect(),
        conversationModelProvider: createSelect(),
        omniModelProvider: createSelect(),
        ttsModelProvider: createSelect(),
    };
    const document = {
        getElementById(id) {
            return selects[id] || null;
        },
        createElement(tagName) {
            assert.equal(tagName, 'option');
            return {
                value: '',
                textContent: '',
                dataset: {},
                setAttribute(name, value) {
                    if (name.startsWith('data-')) {
                        const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
                        this.dataset[key] = value;
                    } else {
                        this[name] = value;
                    }
                },
            };
        },
    };
    const context = vm.createContext({
        console,
        document,
        window: {},
        AbortController,
        setTimeout,
        clearTimeout,
        MODEL_TYPES: ['conversation', 'omni', 'tts'],
        MODEL_DEFAULT_PROVIDER: {
            conversation: 'follow_assist',
            omni: 'follow_core',
            tts: 'follow_assist',
        },
        MODEL_PROVIDER_FIELD_BY_TYPE: {
            conversation: 'conversation_model',
            omni: 'core_model',
        },
        _coreApiProviders: {
            free: { name: 'Free', core_model: 'free-model' },
            qwen: {
                name: 'Qwen Core',
                core_url: 'wss://core-qwen.example/realtime',
                core_model: 'qwen-omni-turbo-realtime-latest',
            },
            gemini: { name: 'Gemini Core', core_url: '', core_model: 'gemini-2.5-flash-native-audio-preview' },
            openai: {
                name: 'OpenAI Core',
                core_url: 'wss://api.openai.com/v1/realtime',
                core_model: 'gpt-realtime',
            },
        },
        _assistApiProviders: {
            qwen: {
                name: 'Qwen Assist',
                openrouter_url: 'https://chat-qwen.example/v1',
                conversation_model: 'qwen-plus',
            },
            gemini: { name: 'Gemini Assist', conversation_model: 'gemini-flash' },
            openai: { name: 'OpenAI Assist', conversation_model: 'gpt-5-mini' },
            claude: {
                name: 'Claude',
                openrouter_url: 'https://chat-claude.example/v1',
                conversation_model: 'claude-sonnet',
            },
            mimo: {
                name: 'MiMo',
                openrouter_url: 'https://api.xiaomimimo.com/v1',
                conversation_model: 'mimo-v2',
                tts_default_model: 'mimo-v2.5-tts',
                tts_default_voice: 'mimo_default',
            },
            vllm_omni: { name: 'vLLM-Omni', tts_default_model: 'Qwen3-TTS' },
            minimax: { name: 'MiniMax', conversation_model: 'MiniMax-M2.1' },
        },
        _keyBookApiProviders: {},
        _ttsProviders: {
            qwen: {
                capabilities: ['preset'],
                default_url: 'https://tts-qwen.example/v1',
                default_model: 'qwen3-tts-flash-realtime',
                default_voice: 'Momo',
            },
            gemini: {
                capabilities: ['preset'],
                default_url: 'https://generativelanguage.googleapis.com/v1beta',
                default_model: 'gemini-2.5-flash-preview-tts',
                default_voice: 'Leda',
            },
            openai: {
                capabilities: ['preset'],
                default_url: 'https://api.openai.com/v1',
                default_model: 'gpt-4o-mini-tts',
                default_voice: 'marin',
                probe_sub_type: 'openai_tts',
            },
            mimo: {
                capabilities: ['preset', 'clone'],
                tts_config_visible: true,
                default_url: 'https://api.xiaomimimo.com/v1',
                default_model: 'mimo-v2.5-tts',
                default_voice: 'mimo_default',
            },
            vllm_omni: {
                capabilities: ['preset', 'clone'],
                tts_dropdown_only: true,
                tts_config_visible: true,
                editable_endpoint: true,
            },
            minimax: { capabilities: ['clone', 'design'], tts_config_visible: true },
            gptsovits: { capabilities: ['clone'], tts_dropdown_only: true, tts_config_visible: true },
        },
        isProviderRestricted() { return false; },
        getProviderCoreUrl(providerKey, profile) { return profile.core_url || ''; },
        getProviderOpenrouterUrl(providerKey, profile) { return profile.openrouter_url || ''; },
        getEffectiveAssistUrl(providerKey, profile, { useTokenPlan = true } = {}) {
            if (useTokenPlan && providerKey === 'mimo' && mimoTokenPlanState.active) {
                return 'https://token-plan-cn.xiaomimimo.com/v1';
            }
            return profile.openrouter_url || '';
        },
        getEffectiveAssistKey(providerKey, _fallbackInput = null, { useTokenPlan = true } = {}) {
            if (useTokenPlan && providerKey === 'mimo' && mimoTokenPlanState.active) {
                return 'tp-mimo-secret';
            }
            return `sk-${providerKey}`;
        },
        getEffectiveAssistProviderKey(providerKey) {
            return providerKey === 'mimo' && mimoTokenPlanState.active
                ? 'mimo_token_plan'
                : providerKey;
        },
        getRealKey(input) { return input ? (input.secret || input.value || '') : ''; },
        syncKeyFromBook(providerKey) { return `sk-${providerKey}`; },
        isFreeVersionText() { return false; },
        isMimoTokenPlanActive() { return mimoTokenPlanState.active; },
        isMaskedSecretValue() { return false; },
        rememberResolvedProviderUrl(...args) { rememberedProviderUrls.push(args); },
        syncProviderSelectDropdowns() {},
        setMaskedInput(input, value) { if (input) input.value = value || ''; },
        ensureKeyBookLink() {},
        removeKeyBookLink() {},
        updateTtsProviderFieldVisibility() {},
        fetchGptSovitsVoices() {},
        _isLoadingSavedConfig: false,
        _coreApiKeyInputDirty: false,
    });
    const helperSource = [
        sourceBetween(
            'function getDefaultProviderForModelType(',
            'function onCustomModelProviderChange(',
        ),
        sourceBetween(
            'function onCustomModelProviderChange(',
            'function updateTtsProviderFieldVisibility(',
        ),
        sourceBetween(
            'function refreshAutoResolvedModelUrlsForSave(',
            'async function saveApiKey(',
        ),
        sourceBetween(
            'function buildConnectivityCacheId(',
            'const ConnectivityManager = {',
        ),
        sourceBetween(
            'const ConnectivityManager = {',
            '// ==================== 连通性测试：集成初始化',
        ),
        'globalThis.populateModelProviderDropdowns = populateModelProviderDropdowns;',
        'globalThis.getNamedTtsProbeSubType = getNamedTtsProbeSubType;',
        'globalThis.onCustomModelProviderChange = onCustomModelProviderChange;',
        'globalThis.refreshAutoResolvedModelUrlsForSave = refreshAutoResolvedModelUrlsForSave;',
        'globalThis.ConnectivityManagerForTest = ConnectivityManager;',
    ].join('\n');
    vm.runInContext(helperSource, context, { filename: SOURCE_PATH });
    return { context, selects, rememberedProviderUrls, mimoTokenPlanState };
}

test('TTS dropdown only offers providers with a real selectable TTS route', () => {
    const { context, selects } = createContext();

    context.populateModelProviderDropdowns();

    assert.deepEqual(
        selects.ttsModelProvider.options.map(option => option.value),
        [
            'follow_core',
            'follow_assist',
            'qwen',
            'gemini',
            'openai',
            'mimo',
            'vllm_omni',
            'gptsovits',
            'custom',
        ],
    );
});

test('named Qwen TTS connectivity keeps TTS identity and forwards model/voice/protocol family', () => {
    const { context, selects } = createContext();
    const elements = {
        ttsModelId: { value: 'Qwen3-TTS-12Hz-1.7B-VoiceDesign-Realtime' },
        ttsModelUrl: { value: '' },
        ttsModelApiKey: { value: '' },
        ttsVoiceId: { value: 'Cherry' },
    };
    const originalGetElementById = context.document.getElementById.bind(context.document);
    context.document.getElementById = id => elements[id] || originalGetElementById(id);
    selects.ttsModelProvider.value = 'qwen';

    const realtime = context.ConnectivityManagerForTest.resolveEffectiveKey({
        type: 'custom',
        modelType: 'tts',
    });
    assert.equal(realtime.providerKey, 'qwen');
    assert.equal(realtime.providerScope, 'tts');
    assert.equal(realtime.providerType, 'tts');
    assert.equal(realtime.key, 'sk-qwen');
    assert.equal(realtime.url, 'https://tts-qwen.example/v1');
    assert.equal(realtime.model, 'Qwen3-TTS-12Hz-1.7B-VoiceDesign-Realtime');
    assert.equal(realtime.voiceId, 'Cherry');
    assert.equal(realtime.subType, 'qwen_realtime_tts');
    assert.match(realtime.cacheId, /qwen_realtime_tts.*Qwen3-TTS.*Cherry/);

    elements.ttsModelId.value = 'cosyvoice-v3-plus';
    const cosyvoice = context.ConnectivityManagerForTest.resolveEffectiveKey({
        type: 'custom',
        modelType: 'tts',
    });
    assert.equal(cosyvoice.providerScope, 'tts');
    assert.equal(cosyvoice.subType, 'cosyvoice_tts');

    elements.ttsModelId.value = 'qwen-unknown-chat-model';
    const unsupported = context.ConnectivityManagerForTest.resolveEffectiveKey({
        type: 'custom',
        modelType: 'tts',
    });
    assert.equal(unsupported.providerScope, 'tts');
    assert.equal(unsupported.subType, '');
});

test('follow_core TTS probes the followed provider speech contract, not its Core model', () => {
    const { context, selects } = createContext();
    const elements = {
        ttsModelId: { value: 'stale-slot-model' },
        ttsModelUrl: { value: '' },
        ttsModelApiKey: { value: '' },
        ttsVoiceId: { value: 'longanyang' },
    };
    const originalGetElementById = context.document.getElementById.bind(context.document);
    context.document.getElementById = id => elements[id] || originalGetElementById(id);
    selects.coreApiSelect.value = 'qwen';
    selects.ttsModelProvider.value = 'follow_core';

    const resolved = context.ConnectivityManagerForTest.resolveEffectiveKey({
        type: 'custom',
        modelType: 'tts',
    });

    assert.equal(resolved.providerKey, 'qwen');
    assert.equal(resolved.providerScope, 'tts');
    assert.equal(resolved.providerType, 'tts');
    assert.equal(resolved.key, 'sk-qwen');
    assert.equal(resolved.url, 'https://tts-qwen.example/v1');
    assert.equal(resolved.model, 'qwen3-tts-flash-realtime');
    assert.equal(resolved.voiceId, 'longanyang');
    assert.equal(resolved.subType, 'qwen_realtime_tts');
    assert.doesNotMatch(resolved.cacheId, /qwen-omni-turbo/);
});

test('follow_core OpenAI TTS uses the HTTP speech endpoint instead of its Realtime WebSocket', () => {
    const { context, selects } = createContext();
    const elements = {
        ttsModelId: { value: 'stale-slot-model' },
        ttsModelUrl: { value: '' },
        ttsModelApiKey: { value: '' },
        ttsVoiceId: { value: '' },
    };
    const originalGetElementById = context.document.getElementById.bind(context.document);
    context.document.getElementById = id => elements[id] || originalGetElementById(id);
    selects.coreApiSelect.value = 'openai';
    selects.ttsModelProvider.value = 'follow_core';

    const resolved = context.ConnectivityManagerForTest.resolveEffectiveKey({
        type: 'custom',
        modelType: 'tts',
    });

    assert.equal(resolved.providerKey, 'openai');
    assert.equal(resolved.providerScope, 'tts');
    assert.equal(resolved.url, 'https://api.openai.com/v1');
    assert.equal(resolved.model, 'gpt-4o-mini-tts');
    assert.equal(resolved.voiceId, 'marin');
    assert.equal(resolved.subType, 'openai_tts');
});

test('TTS provider change prefers registry speech URLs and falls back for MiMo Token Plan', () => {
    const { context, selects, mimoTokenPlanState } = createContext();
    const elements = {
        ttsModelUrl: createInput('https://stale-chat.example/v1'),
        ttsModelApiKey: createInput(''),
        ttsModelId: createInput('stale-slot-model'),
        ttsVoiceId: createInput(''),
    };
    const originalGetElementById = context.document.getElementById.bind(context.document);
    context.document.getElementById = id => elements[id] || originalGetElementById(id);

    selects.coreApiSelect.value = 'openai';
    selects.ttsModelProvider.value = 'follow_core';
    context.onCustomModelProviderChange('tts');
    assert.equal(elements.ttsModelUrl.value, 'https://api.openai.com/v1');
    assert.notEqual(elements.ttsModelUrl.value, 'wss://api.openai.com/v1/realtime');

    elements.ttsModelUrl.value = 'https://stale-chat.example/v1';
    selects.assistApiSelect.value = 'qwen';
    selects.ttsModelProvider.value = 'follow_assist';
    context.onCustomModelProviderChange('tts');
    assert.equal(elements.ttsModelUrl.value, 'https://tts-qwen.example/v1');
    assert.notEqual(elements.ttsModelUrl.value, 'https://chat-qwen.example/v1');

    elements.ttsModelUrl.value = 'https://stale-chat.example/v1';
    mimoTokenPlanState.active = true;
    selects.assistApiSelect.value = 'mimo';
    selects.ttsModelProvider.value = 'follow_assist';
    context.onCustomModelProviderChange('tts');
    assert.equal(elements.ttsModelUrl.value, 'https://token-plan-cn.xiaomimimo.com/v1');

    elements.ttsModelUrl.value = '';
    elements.ttsModelId.value = '';
    elements.ttsVoiceId.value = '';
    selects.ttsModelProvider.value = 'mimo';
    context.onCustomModelProviderChange('tts');
    assert.equal(elements.ttsModelUrl.value, 'https://token-plan-cn.xiaomimimo.com/v1');
    assert.equal(elements.ttsModelId.value, 'mimo-v2.5-tts');
    assert.equal(elements.ttsVoiceId.value, 'mimo_default');
});

test('followed TTS provider change drops a voice owned by the previous provider', () => {
    const { context, selects } = createContext();
    context._ttsProviders.free = {
        capabilities: ['preset'],
        default_url: '',
        default_model: 'free-model',
        default_voice: '',
    };
    const elements = {
        ttsModelUrl: createInput(''),
        ttsModelApiKey: createInput(''),
        ttsModelId: createInput(''),
        ttsVoiceId: createInput('Cherry'),
    };
    const originalGetElementById = context.document.getElementById.bind(context.document);
    context.document.getElementById = id => elements[id] || originalGetElementById(id);

    selects.coreApiSelect.value = 'qwen';
    selects.ttsModelProvider.value = 'follow_core';
    context.onCustomModelProviderChange('tts');
    // Initial hydration has no previous effective provider, so a legitimate
    // saved Qwen voice remains intact.
    assert.equal(elements.ttsVoiceId.value, 'Cherry');

    selects.coreApiSelect.value = 'free';
    context.onCustomModelProviderChange('tts');
    assert.equal(elements.ttsModelId.value, 'free-model');
    assert.equal(elements.ttsVoiceId.value, '');
});

test('save-time followed TTS URLs mirror registry-first runtime resolution', () => {
    const { context, mimoTokenPlanState } = createContext();
    const params = {
        coreApi: 'openai',
        assistApi: 'qwen',
        conversationModelProvider: 'follow_assist',
        conversationModelUrl: '',
        conversationModelId: '',
        omniModelProvider: 'follow_core',
        omniModelUrl: '',
        omniModelId: '',
        ttsModelProvider: 'follow_core',
        ttsModelUrl: 'wss://api.openai.com/v1/realtime',
        ttsModelId: '',
    };

    context.refreshAutoResolvedModelUrlsForSave(params);
    assert.equal(params.ttsModelUrl, 'https://api.openai.com/v1');

    params.coreApi = 'qwen';
    params.ttsModelUrl = 'wss://core-qwen.example/realtime';
    context.refreshAutoResolvedModelUrlsForSave(params);
    assert.equal(params.ttsModelUrl, 'https://tts-qwen.example/v1');

    mimoTokenPlanState.active = true;
    params.assistApi = 'mimo';
    params.ttsModelProvider = 'follow_assist';
    params.ttsModelUrl = 'https://api.xiaomimimo.com/v1';
    context.refreshAutoResolvedModelUrlsForSave(params);
    assert.equal(params.ttsModelUrl, 'https://token-plan-cn.xiaomimimo.com/v1');
});

test('follow_assist TTS stays in TTS scope even when the followed provider is unsupported', () => {
    const { context, selects } = createContext();
    const elements = {
        ttsModelId: { value: 'stale-slot-model' },
        ttsModelUrl: { value: '' },
        ttsModelApiKey: { value: '' },
        ttsVoiceId: { value: '' },
    };
    const originalGetElementById = context.document.getElementById.bind(context.document);
    context.document.getElementById = id => elements[id] || originalGetElementById(id);
    selects.assistApiSelect.value = 'claude';
    selects.ttsModelProvider.value = 'follow_assist';

    const resolved = context.ConnectivityManagerForTest.resolveEffectiveKey({
        type: 'custom',
        modelType: 'tts',
    });

    assert.equal(resolved.providerKey, 'claude');
    assert.equal(resolved.providerScope, 'tts');
    assert.equal(resolved.providerType, 'tts');
    assert.equal(resolved.url, 'https://chat-claude.example/v1');
    assert.equal(resolved.model, '');
    assert.equal(resolved.voiceId, '');
    assert.notEqual(resolved.providerScope, 'assist');
});

test('named TTS connectivity sends model/voice/subtype and never writes a TTS URL into core/assist cache', async () => {
    const { context, rememberedProviderUrls } = createContext();
    const requestBodies = [];
    context.fetch = async (_url, options) => {
        requestBodies.push(JSON.parse(options.body));
        return {
            ok: true,
            async json() {
                return { success: true, resolved_url: 'https://resolved.example/tts' };
            },
        };
    };

    const result = await context.ConnectivityManagerForTest.testKey({
        provider_key: 'qwen',
        provider_scope: 'tts',
        api_key: 'sk-qwen',
        model: 'Qwen3-TTS-12Hz-1.7B-VoiceDesign-Realtime',
        voice_id: 'Cherry',
        provider_type: 'tts',
        sub_type: 'qwen_realtime_tts',
        cache_id: 'tts|qwen|sk-qwen|qwen_realtime_tts|model|Cherry',
    });

    assert.equal(result.success, true);
    assert.deepEqual(requestBodies, [{
        api_key: 'sk-qwen',
        provider_key: 'qwen',
        provider_scope: 'tts',
        url: '',
        model: 'Qwen3-TTS-12Hz-1.7B-VoiceDesign-Realtime',
        voice_id: 'Cherry',
        sub_type: 'qwen_realtime_tts',
    }]);
    assert.deepEqual(rememberedProviderUrls, []);
});

test('explicit MiMo TTS uses the active Token Plan key and URL', () => {
    const { context, selects, mimoTokenPlanState } = createContext();
    const elements = {
        ttsModelId: { value: 'mimo-v2.5-tts' },
        ttsModelUrl: { value: 'https://api.xiaomimimo.com/v1' },
        ttsModelApiKey: { value: '' },
        ttsVoiceId: { value: 'mimo_default' },
    };
    const originalGetElementById = context.document.getElementById.bind(context.document);
    context.document.getElementById = id => elements[id] || originalGetElementById(id);
    mimoTokenPlanState.active = true;

    selects.ttsModelProvider.value = 'mimo';
    const tts = context.ConnectivityManagerForTest.resolveEffectiveKey({
        type: 'custom',
        modelType: 'tts',
    });
    assert.equal(tts.providerScope, 'tts');
    assert.equal(tts.providerKey, 'mimo');
    assert.equal(tts.key, 'tp-mimo-secret');
    assert.equal(tts.url, 'https://token-plan-cn.xiaomimimo.com/v1');
    assert.equal(tts.model, 'mimo-v2.5-tts');
    assert.equal(tts.voiceId, 'mimo_default');
});

test('save-time named MiMo URLs stay paired with the active Token Plan credential', () => {
    const { context, mimoTokenPlanState } = createContext();
    mimoTokenPlanState.active = true;
    const params = {
        coreApi: 'qwen',
        assistApi: 'mimo',
        omniModelProvider: 'follow_core',
        omniModelUrl: '',
        omniModelId: '',
        ttsModelProvider: 'mimo',
        ttsModelUrl: 'https://api.xiaomimimo.com/v1',
        ttsModelId: 'mimo-v2.5-tts',
    };

    context.refreshAutoResolvedModelUrlsForSave(params);

    assert.equal(params.ttsModelUrl, 'https://token-plan-cn.xiaomimimo.com/v1');
});
