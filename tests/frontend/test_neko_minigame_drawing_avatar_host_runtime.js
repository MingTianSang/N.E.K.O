const fs = require('fs');
const path = require('path');
const vm = require('vm');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function rejection(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; },
  };
}

function element(width = 420, height = 360) {
  return {
    clientWidth: width,
    clientHeight: height,
    hidden: false,
    classList: { toggle() {}, add() {}, remove() {} },
    style: { display: '', setProperty() {} },
    getBoundingClientRect() { return { width, height }; },
  };
}

async function main() {
  const sdkDir = path.resolve(__dirname, '../../static/game/sdk');
  const genericPath = path.join(sdkDir, 'neko-minigame-avatar-host.js');
  const drawingPath = path.join(sdkDir, 'neko-minigame-drawing-avatar-host.js');
  const elements = {
    'model-stage': element(),
    'live2d-container': element(),
    'live2d-canvas': element(),
    'vrm-container': element(),
    'vrm-canvas': element(),
    'mmd-container': element(),
    'mmd-canvas': element(),
    'pngtuber-container': element(),
  };
  const calls = [];
  const analyser = {
    fftSize: 8,
    getByteTimeDomainData(data) { data.fill(144); },
  };
  let nextFrame = 1;
  const frames = new Map();
  const listeners = new Map();
  const activeIntervals = new Set();
  const activeTimeouts = new Set();
  const disposeGates = { vrm: null, mmd: null, pngtuber: null };
  let live2dManagersCreated = 0;

  async function recordRendererDispose(kind) {
    calls.push([`${kind}-dispose-start`]);
    if (disposeGates[kind]) await disposeGates[kind];
    await Promise.resolve();
    calls.push([`${kind}-dispose-end`]);
  }

  class ResizeObserverMock {
    constructor(callback) { this.callback = callback; }
    observe(target) { this.target = target; }
    disconnect() { this.target = null; }
  }

  function live2dModel() {
    const parameters = new Map([['ParamMouthOpenY', 0]]);
    let destroyed = false;
    return {
      width: 1200,
      height: 1800,
      x: 0,
      y: 0,
      anchor: { set() {} },
      scale: { set(value) { this.value = value; } },
      getLocalBounds() { return { width: 1200, height: 1800 }; },
      getBounds() { return { x: 0, y: 0, width: 120, height: 180 }; },
      removeAllListeners() { calls.push(['live2d-model-remove-listeners']); },
      destroy() {
        if (destroyed) throw new Error('Live2D model was destroyed twice');
        destroyed = true;
        calls.push(['live2d-model-dispose']);
      },
      internalModel: {
        coreModel: {
          getParameterIndex(id) { return parameters.has(id) ? 0 : -1; },
          setParameterValueById(id, value) {
            parameters.set(id, value);
            calls.push(['live2d-mouth', id, value]);
          },
        },
      },
    };
  }

  class Live2DManagerMock {
    constructor() {
      this.instanceId = ++live2dManagersCreated;
      this.currentModel = null;
      this._screenChangeHandler = () => {};
      this._displayChangeHandler = () => {};
      this._idleFpsGovernorTimer = `governor-${this.instanceId}`;
      this._savedParamsTimer = `saved-params-${this.instanceId}`;
      this._idleFpsRestoreTimer = `restore-${this.instanceId}`;
      this._idleMotionLoopTimers = new Set([`idle-loop-${this.instanceId}`]);
      this._popupTimers = { popup: `popup-${this.instanceId}` };
      activeIntervals.add(this._idleFpsGovernorTimer);
      activeIntervals.add(this._savedParamsTimer);
      activeTimeouts.add(this._idleFpsRestoreTimer);
      activeTimeouts.add(`idle-loop-${this.instanceId}`);
      activeTimeouts.add(`popup-${this.instanceId}`);
      windowMock.addEventListener('resize', this._screenChangeHandler);
      windowMock.addEventListener('electron-display-changed', this._displayChangeHandler);
      this.pixi_app = {
        renderer: { resize: (width, height) => calls.push(['live2d-resize', width, height]) },
        view: { style: { setProperty() {} } },
        ticker: {
          start() { calls.push(['live2d-resume']); },
          stop() { calls.push(['live2d-pause']); },
        },
        destroy(removeView) { calls.push(['live2d-pixi-dispose', removeView]); },
      };
    }
    async ensurePIXIReady() { calls.push(['live2d-init']); }
    async loadModel(config) {
      calls.push(['live2d-model', config.url]);
      this.currentModel = live2dModel();
    }
    async removeModel() {
      calls.push(['live2d-remove-model']);
      this.currentModel?.destroy?.({ children: true });
      this.currentModel = null;
    }
    cleanupEventListeners() { calls.push(['live2d-cleanup-listeners']); }
    _stopIdleFpsGovernor() { calls.push(['live2d-stop-governor']); }
    setEmotion(name) { calls.push(['live2d-emotion', name]); }
  }

  class VRMManagerMock {
    constructor() {
      this.currentModel = null;
      this.animation = {
        startLipSync(value) { calls.push(['vrm-speaking', value === analyser]); },
        stopLipSync() { calls.push(['vrm-stop-speaking']); },
      };
      this.expression = { setMood(mood) { calls.push(['vrm-emotion', mood]); } };
    }
    async initThreeJS(_canvas, _container, lighting) {
      calls.push(['vrm-init', lighting?.ambient]);
      return true;
    }
    async loadModel(model) { this.currentModel = {}; calls.push(['vrm-model', model]); }
    onWindowResize() { calls.push(['vrm-resize']); }
    pauseRendering() { calls.push(['vrm-pause']); }
    resumeRendering() { calls.push(['vrm-resume']); }
    async dispose() { await recordRendererDispose('vrm'); }
  }

  class MMDManagerMock {
    constructor() {
      this.currentModel = null;
      this.animationModule = {
        startLipSync(value) { calls.push(['mmd-speaking', value === analyser]); },
        stopLipSync() { calls.push(['mmd-stop-speaking']); },
      };
    }
    async init() { calls.push(['mmd-init']); }
    async loadModel(model) { this.currentModel = {}; calls.push(['mmd-model', model]); }
    onWindowResize() { calls.push(['mmd-resize']); }
    setEmotion(mood) { calls.push(['mmd-emotion', mood]); }
    pauseRendering() { calls.push(['mmd-pause']); }
    resumeRendering() { calls.push(['mmd-resume']); }
    async dispose() { await recordRendererDispose('mmd'); }
  }

  class PNGTuberManagerMock {
    async load(config) { calls.push(['pngtuber-model', config.idle_image]); }
    setSpeaking(active) { calls.push(['pngtuber-speaking', active]); }
    setState(name) { calls.push(['pngtuber-emotion', name]); }
    pauseRendering() { calls.push(['pngtuber-pause']); }
    resumeRendering() { calls.push(['pngtuber-resume']); }
    show() {}
    async dispose() { await recordRendererDispose('pngtuber'); }
  }

  const characters = {
    'Live Neko': {
      api_key: 'secret-key',
      system_prompt: 'secret prompt',
      _reserved: { avatar: { model_type: 'live2d', live2d: { model_path: 'unresolved.json' } } },
    },
    'VRM Neko': {
      lighting: { ambient: 0.7 },
      _reserved: { avatar: { model_type: 'live3d', live3d_sub_type: 'vrm', vrm: { model_path: 'avatar.vrm' } } },
    },
    'MMD Neko': {
      _reserved: { avatar: { model_type: 'live3d', live3d_sub_type: 'mmd', mmd: { model_path: 'avatar.pmx' } } },
    },
    'PNG Neko': {
      _reserved: {
        avatar: {
          model_type: 'pngtuber',
          pngtuber: { idle_image: '/avatars/idle.png', talking_image: '/avatars/talk.png' },
        },
      },
    },
  };
  let liveModelFetchGate = null;
  let onLiveModelFetch = null;

  const fetchImpl = async (url) => {
    const target = String(url);
    if (target === '/api/characters') return jsonResponse({ 猫娘: characters, 当前猫娘: 'Live Neko' });
    if (target === '/api/characters/current_catgirl') return jsonResponse({ current_catgirl: 'Live Neko' });
    if (target.includes('/api/characters/current_live2d_model?')) {
      return jsonResponse({ success: true, model_info: { path: '/resolved/live.model3.json' } });
    }
    if (target === '/resolved/live.model3.json') {
      onLiveModelFetch?.();
      if (liveModelFetchGate) await liveModelFetchGate;
      return jsonResponse({ Version: 3, FileReferences: {} });
    }
    throw new Error(`unexpected fetch: ${target}`);
  };

  const windowMock = {
    console: { warn() {}, error() {} },
    document: { getElementById: (id) => elements[id] || null },
    fetch: fetchImpl,
    AbortController,
    appState: { globalAnalyser: analyser },
    PIXI: { live2d: {} },
    Live2DManager: Live2DManagerMock,
    VRMManager: VRMManagerMock,
    MMDManager: MMDManagerMock,
    PNGTuberManager: PNGTuberManagerMock,
    vrmModuleLoaded: true,
    mmdModuleLoaded: true,
    convertVRMModelPath: (value) => `/vrm-resolved/${value}`,
    _mmdConvertPath: (value) => `/mmd-resolved/${value}`,
    fetchMMDConfig: async () => true,
    ResizeObserver: ResizeObserverMock,
    setTimeout(callback, delay) { return setTimeout(callback, delay); },
    clearTimeout(timer) { activeTimeouts.delete(timer); clearTimeout(timer); },
    clearInterval(timer) { activeIntervals.delete(timer); clearInterval(timer); },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) { listeners.get(type)?.delete(handler); },
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const context = vm.createContext({
    window: windowMock,
    console: windowMock.console,
    setTimeout,
    clearTimeout,
    AbortController,
    URL,
    encodeURIComponent,
  });
  vm.runInContext(fs.readFileSync(genericPath, 'utf8'), context, { filename: genericPath });
  vm.runInContext(fs.readFileSync(drawingPath, 'utf8'), context, { filename: drawingPath });

  const host = windowMock.NekoMiniGameDrawingAvatarHost.create({
    windowImpl: windowMock,
    documentImpl: windowMock.document,
    fetchImpl,
    avatarRuntime: windowMock.NekoMiniGameAvatarHost,
  });
  const names = await host.listCharacters();
  const current = await host.getCurrentCharacter();
  assert(Object.isFrozen(names) && names.length === 4, 'character names were not bounded and frozen');
  assert(Object.isFrozen(current) && Object.isFrozen(current.model),
    'current character descriptor was not deeply frozen');
  assert(current.name === 'Live Neko'
    && current.model.type === 'live2d'
    && current.model.path === '/resolved/live.model3.json',
  'Live2D descriptor did not use the resolved character model path');
  assert(current.api_key === undefined && current.system_prompt === undefined
    && JSON.stringify(current).includes('secret') === false,
  'character secrets crossed the trusted Avatar boundary');

  const descriptors = new Map();
  for (const [name, expectedType] of [
    ['Live Neko', 'live2d'],
    ['VRM Neko', 'vrm'],
    ['MMD Neko', 'mmd'],
    ['PNG Neko', 'pngtuber'],
  ]) {
    const descriptor = name === 'Live Neko' ? current : await host.getCharacter(name);
    assert(descriptor?.model?.type === expectedType, `${expectedType} descriptor was not normalized`);
    descriptors.set(name, descriptor);
  }

  function mountConfig(characterName, model) {
    return {
      slot: 'drawing-guess-character',
      ...(characterName ? { characterName } : {}),
      model,
      viewport: { mode: 'container' },
      fit: { mode: 'contain', align: 'center', padding: 0, scaleMultiplier: 1 },
      resize: { mode: 'container' },
    };
  }

  const rendererCallsBeforeAttacks = calls.length;
  const forgedNameError = await rejection(host.mount(mountConfig('Forged Neko', current.model)));
  const forgedPathError = await rejection(host.mount(mountConfig(
    'Live Neko', { type: 'live2d', path: '/attacker/model.model3.json' },
  )));
  const implicitCurrentPathError = await rejection(host.mount(mountConfig(
    '', { type: 'live2d', path: '/attacker/current.model3.json' },
  )));
  assert(forgedNameError?.code === 'model_not_allowed'
    && forgedPathError?.code === 'model_not_allowed'
    && implicitCurrentPathError?.code === 'model_not_allowed',
  'forged character names or arbitrary Avatar paths crossed the trusted catalog boundary');
  assert(calls.length === rendererCallsBeforeAttacks,
    'a rejected Avatar model reached a renderer constructor or loader');

  for (const [name, expectedType] of [
    ['Live Neko', 'live2d'],
    ['VRM Neko', 'vrm'],
    ['MMD Neko', 'mmd'],
    ['PNG Neko', 'pngtuber'],
  ]) {
    const descriptor = descriptors.get(name);
    const controller = await host.mount({
      ...mountConfig(name, descriptor.model),
    });
    if (name === 'Live Neko') {
      const replacementError = await rejection(controller.setModel({
        type: 'live2d', path: '/attacker/replacement.model3.json',
      }));
      assert(replacementError?.code === 'model_not_allowed',
        'controller.setModel accepted a model outside its trusted character binding');
    }
    const initialView = controller.getState().view;
    assert(initialView.scale === 325.63 && initialView.x === -0.96 && initialView.y === 66.41,
      `${expectedType} controller did not use the drawing game's configured default view`);
    await controller.setView({ scale: 190, x: 2, y: 28 });
    await controller.setSpeaking(true);
    await controller.setEmotion('happy');
    await controller.pause();
    assert(controller.getState().paused === true, `${expectedType} controller did not enter paused state`);
    await controller.resume();
    assert(controller.getState().paused === false, `${expectedType} controller did not resume`);
    await controller.setSpeaking(false);
    await controller.dispose();
  }

  assert(calls.some((entry) => entry[0] === 'live2d-model' && entry[1] === '/resolved/live.model3.json')
    && calls.some((entry) => entry[0] === 'vrm-model')
    && calls.some((entry) => entry[0] === 'mmd-model')
    && calls.some((entry) => entry[0] === 'pngtuber-model'),
  'the four Avatar renderer types did not follow symmetric host-owned loading paths');
  assert(calls.some((entry) => entry[0] === 'live2d-mouth')
    && calls.some((entry) => entry[0] === 'vrm-speaking' && entry[1] === true)
    && calls.some((entry) => entry[0] === 'mmd-speaking' && entry[1] === true)
    && calls.some((entry) => entry[0] === 'pngtuber-speaking' && entry[1] === true),
  'the four Avatar renderer types did not follow symmetric host-owned speaking paths');
  assert(calls.some((entry) => entry[0] === 'live2d-emotion' && entry[1] === 'happy')
    && calls.some((entry) => entry[0] === 'vrm-emotion' && entry[1] === 'happy')
    && calls.some((entry) => entry[0] === 'mmd-emotion' && entry[1] === 'happy')
    && calls.some((entry) => entry[0] === 'pngtuber-emotion' && entry[1] === 'happy'),
  'the four Avatar renderer types did not follow symmetric host-owned mood paths');
  assert(calls.some((entry) => entry[0] === 'live2d-pause')
    && calls.some((entry) => entry[0] === 'live2d-resume')
    && calls.some((entry) => entry[0] === 'vrm-pause')
    && calls.some((entry) => entry[0] === 'vrm-resume')
    && calls.some((entry) => entry[0] === 'mmd-pause')
    && calls.some((entry) => entry[0] === 'mmd-resume')
    && calls.some((entry) => entry[0] === 'pngtuber-pause')
    && calls.some((entry) => entry[0] === 'pngtuber-resume'),
  'the four Avatar renderer types did not follow symmetric host-owned pause/resume paths');
  assert(calls.some((entry) => entry[0] === 'vrm-dispose-end')
    && calls.some((entry) => entry[0] === 'mmd-dispose-end')
    && calls.some((entry) => entry[0] === 'pngtuber-dispose-end'),
  'the non-Live2D renderers did not complete their asynchronous disposal paths');
  assert(activeIntervals.size === 0 && activeTimeouts.size === 0
    && (listeners.get('resize')?.size || 0) === 0
    && (listeners.get('electron-display-changed')?.size || 0) === 0,
  `Live2D disposal leaked resources: intervals=${[...activeIntervals]}, `
    + `timeouts=${[...activeTimeouts]}, resize=${listeners.get('resize')?.size || 0}, `
    + `display=${listeners.get('electron-display-changed')?.size || 0}`);
  assert(calls.some((entry) => entry[0] === 'live2d-remove-model')
    && calls.some((entry) => entry[0] === 'live2d-model-dispose')
    && calls.some((entry) => entry[0] === 'live2d-pixi-dispose' && entry[1] === false),
  'Live2D disposal did not retire the model and PIXI runtime while preserving the host canvas');

  const replacementSequenceStart = calls.length;
  let releaseVrmDisposal;
  disposeGates.vrm = new Promise((resolve) => { releaseVrmDisposal = resolve; });
  const gatedVrm = await host.mount(mountConfig('VRM Neko', descriptors.get('VRM Neko').model));
  const mmdLoadsBeforeReplacement = calls.filter((entry) => entry[0] === 'mmd-model').length;
  const gatedVrmDisposal = gatedVrm.dispose();
  const replacementMount = host.mount(mountConfig('MMD Neko', descriptors.get('MMD Neko').model));
  await new Promise((resolve) => setImmediate(resolve));
  assert(calls.some((entry) => entry[0] === 'vrm-dispose-start')
    && calls.filter((entry) => entry[0] === 'mmd-model').length === mmdLoadsBeforeReplacement,
  'rapid character replacement started before the previous renderer disposal completed');
  releaseVrmDisposal();
  await gatedVrmDisposal;
  disposeGates.vrm = null;
  const replacementController = await replacementMount;
  const replacementSequence = calls.slice(replacementSequenceStart).map((entry) => entry[0]);
  assert(replacementSequence.indexOf('vrm-dispose-end')
    < replacementSequence.indexOf('mmd-model'),
  'the replacement renderer crossed the per-slot asynchronous cleanup barrier');
  await replacementController.dispose();

  assert(host.activeCount === 0, 'debug-style Avatar replacement leaked a controller');

  let releaseLiveModelFetch;
  liveModelFetchGate = new Promise((resolve) => { releaseLiveModelFetch = resolve; });
  const liveModelFetchStarted = new Promise((resolve) => {
    onLiveModelFetch = () => { onLiveModelFetch = null; resolve(); };
  });
  const liveManagersBeforeCancellation = live2dManagersCreated;
  const cancelledMount = host.mount(mountConfig('Live Neko', current.model));
  await liveModelFetchStarted;
  const hostDisposal = host.dispose();
  const cancelledMountError = await rejection(cancelledMount);
  assert(cancelledMountError?.code === 'disposed',
    'host disposal did not cancel a pending Avatar model load');
  assert(live2dManagersCreated === liveManagersBeforeCancellation,
    'a cancelled pending loader constructed a late Live2D manager');
  releaseLiveModelFetch();
  liveModelFetchGate = null;
  await hostDisposal;
  await new Promise((resolve) => setImmediate(resolve));
  assert(live2dManagersCreated === liveManagersBeforeCancellation
    && host.pendingCount === 0 && host.activeCount === 0
    && activeIntervals.size === 0 && activeTimeouts.size === 0
    && (listeners.get('resize')?.size || 0) === 0
    && (listeners.get('electron-display-changed')?.size || 0) === 0,
  `cancelled loader leaked resources: managers=${live2dManagersCreated}/${liveManagersBeforeCancellation}, `
    + `pending=${host.pendingCount}, active=${host.activeCount}, intervals=${[...activeIntervals]}, `
    + `timeouts=${[...activeTimeouts]}, resize=${listeners.get('resize')?.size || 0}, `
    + `display=${listeners.get('electron-display-changed')?.size || 0}`);

  process.stdout.write('mini-game Drawing Avatar host runtime test passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
