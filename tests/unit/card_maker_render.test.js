const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const cardMakerSource = fs.readFileSync(
    'static/js/card_maker.js',
    'utf8'
);

function loadDrawModelWithComposition({ layered = true } = {}) {
    const sourceHelpers = cardMakerSource.slice(
        cardMakerSource.indexOf('    function getDrawableSourceSize(source) {'),
        cardMakerSource.indexOf('    function isCrossOriginHttpUrl(value) {')
    );
    const drawStart = cardMakerSource.indexOf('    function drawModelWithComposition(');
    const drawEnd = cardMakerSource.indexOf('    // ====== 预览循环 ======', drawStart);
    const drawFunction = cardMakerSource.slice(drawStart, drawEnd);
    const context = {
        window: {
            cardMakerPNGTuberManager: {
                isLayeredActive: () => layered,
                layeredCanvasLogicalWidth: 1200,
                layeredCanvasLogicalHeight: 1600,
                layeredCanvasPadding: 100
            }
        }
    };
    const source = `(() => {
        let currentModelType = 'pngtuber';
        let pngtuberCardFrame = null;
        const composition = { offsetX: 0, offsetY: 0, scale: 100, rotation: 0 };
        ${sourceHelpers}
        ${drawFunction}
        return drawModelWithComposition;
    })()`;
    return vm.runInNewContext(source, context);
}

function createContext() {
    const calls = [];
    return {
        calls,
        ctx: {
            drawImage(...args) {
                calls.push(args);
            },
            save() {},
            restore() {},
            translate() {},
            rotate() {}
        }
    };
}

function createCanvasWithAlphaBounds(width, height, bounds) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = bounds.y; y < bounds.y + bounds.height; y += 1) {
        for (let x = bounds.x; x < bounds.x + bounds.width; x += 1) {
            data[(y * width + x) * 4 + 3] = 255;
        }
    }
    return {
        width,
        height,
        getContext() {
            return { getImageData: () => ({ data }) };
        }
    };
}

test('contains a wide layered PNGTuber after removing logical canvas padding', () => {
    const draw = loadDrawModelWithComposition();
    const { ctx, calls } = createContext();
    draw(ctx, createCanvasWithAlphaBounds(600, 800, { x: 50, y: 50, width: 500, height: 700 }), 600, 800);

    assert.equal(calls.length, 1);
    const [, sx, sy, sw, sh, dx, dy, dw, dh] = calls[0];
    assert.deepEqual({ sx, sy, sw, sh }, { sx: 50, sy: 50, sw: 500, sh: 700 });
    assert.ok(Math.abs(dx - (600 - 500 * (800 / 700)) / 2) < 1e-9);
    assert.equal(dy, 0);
    assert.ok(Math.abs(dw - 500 * (800 / 700)) < 1e-9);
    assert.equal(dh, 800);
});

test('keeps layered pixels that move into the logical padding area', () => {
    const draw = loadDrawModelWithComposition();
    const { ctx, calls } = createContext();
    draw(ctx, createCanvasWithAlphaBounds(600, 800, { x: 0, y: 30, width: 600, height: 740 }), 600, 800);

    const [, sx, sy, sw, sh, dx, dy, dw, dh] = calls[0];
    assert.deepEqual({ sx, sy, sw, sh }, { sx: 0, sy: 30, sw: 600, sh: 740 });
    assert.equal(dx, 0);
    assert.equal(dy, 30);
    assert.equal(dw, 600);
    assert.equal(dh, 740);
});

test('contains a tall ordinary PNGTuber without cropping its source', () => {
    const draw = loadDrawModelWithComposition({ layered: false });
    const { ctx, calls } = createContext();
    draw(ctx, { width: 600, height: 1200 }, 600, 800);

    const [, sx, sy, sw, sh, dx, dy, dw, dh] = calls[0];
    assert.deepEqual({ sx, sy, sw, sh }, { sx: 0, sy: 0, sw: 600, sh: 1200 });
    assert.equal(dx, 100);
    assert.equal(dy, 0);
    assert.equal(dw, 400);
    assert.equal(dh, 800);
});

test('does not clear a newer model context when an older save completes', async () => {
    const bridge = fs.readFileSync('static/js/model_manager/page-bridge.js', 'utf8');
    const start = bridge.indexOf('function captureModelManagerSaveContext(currentState = {}) {');
    const end = bridge.indexOf('// 仅当本页确实保存过配置时', start);
    const helpers = bridge.slice(start, end);
    const source = `(() => {
        let currentModelType = 'live2d';
        let currentLive3dSubType = '';
        let currentModelInfo = { path: '/models/a.model3.json' };
        function captureSettingsSnapshot() {
            return { modelType: currentModelType, stableSetting: 'unchanged' };
        }
        function snapshotsEqual(a, b) {
            return !!a && !!b && Object.keys(a).length === Object.keys(b).length
                && Object.keys(a).every(key => String(a[key]) === String(b[key]));
        }
        ${helpers}
        return {
            capture: captureModelManagerSaveContext,
            isCurrent: isModelManagerSaveContextCurrent,
            setState(type, subType, path) {
                currentModelType = type;
                currentLive3dSubType = subType;
                currentModelInfo = path ? { path } : null;
            }
        };
    })()`;
    const api = vm.runInNewContext(source, {});
    const oldSave = api.capture();
    let unsaved = true;
    const oldSaveCompletion = Promise.resolve().then(() => {
        if (api.isCurrent(oldSave)) unsaved = false;
    });

    api.setState('pngtuber', '', '/models/b.png');
    await oldSaveCompletion;
    assert.equal(unsaved, true);

    api.setState('live2d', '', '/models/b.model3.json');
    assert.equal(api.isCurrent(oldSave), false);

    api.setState('live2d', '', '/models/a.model3.json');
    assert.equal(api.isCurrent(oldSave), true);
});
