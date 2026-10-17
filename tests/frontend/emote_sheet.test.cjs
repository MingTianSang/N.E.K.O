const test = require('node:test');
const assert = require('node:assert/strict');

const sheet = require('../../static/js/emote_sheet.js');
const layered = require('../../static/js/emote_pngtuber_layered.js');

function frames(n, edge = 32) {
    return Array.from({ length: n }, (u, i) => ({
        width: edge, height: edge, delayMs: 50,
        data: new Uint8ClampedArray(edge * edge * 4).fill(i + 1),
    }));
}

test('sliceFrames cuts by seconds at the given fps', () => {
    const all = frames(24);
    const r = sheet.sliceFrames(all, { startAt: 0.5, seconds: 1, fps: 12 });
    assert.equal(r.skipped, 6, '0.5s @12fps 应跳过 6 帧');
    assert.equal(r.frames.length, 12, '1s @12fps 应取 12 帧');
    assert.equal(r.frames[0].data[0], 7, '起点确实是第 7 帧');
});

test('seconds 0 means run to the end', () => {
    const r = sheet.sliceFrames(frames(20), { startAt: 1, seconds: 0, fps: 12 });
    assert.equal(r.skipped, 12);
    assert.equal(r.frames.length, 8, '剩下的帧全部保留');
});

test('a range reaching past the end is clamped, not padded', () => {
    const r = sheet.sliceFrames(frames(10), { startAt: 0.5, seconds: 5, fps: 12 });
    assert.equal(r.skipped, 6);
    assert.equal(r.frames.length, 4);
});

test('degenerate ranges never produce an empty strip', () => {
    // 空切片会让那一层没有帧可画，包能加载但那一格是空的
    assert.equal(sheet.sliceFrames(frames(10), { startAt: 0.9, seconds: 0.01, fps: 12 }).frames.length, 1);
    assert.equal(sheet.sliceFrames(frames(10), { startAt: 99, fps: 12 }).frames.length, 1);
    assert.deepEqual(sheet.sliceFrames([], { fps: 12 }), { frames: [], skipped: 0, totalFrames: 0 });
});

test('garbage numbers fall back instead of slicing everything away', () => {
    const r = sheet.sliceFrames(frames(8), { startAt: 'abc', seconds: null, fps: 'x' });
    assert.equal(r.skipped, 0);
    assert.equal(r.frames.length, 8);
});

test('each state can carry its own scale and rotation', () => {
    const states = [
        { stateKey: 'idle_image', frames: 4, width: 64, height: 64, sheetWidth: 256, fps: 12,
            pngBytes: new Uint8Array([1, 2, 3]) },
        { stateKey: 'happy_image', frames: 2, width: 64, height: 64, sheetWidth: 128, fps: 12,
            pngBytes: new Uint8Array([4, 5, 6]), scale: 1.4, rotation: 0.35, x: -20, y: 12 },
    ];
    const m = layered.buildLayeredPackage({ canvasWidth: 64, canvasHeight: 64, states }).metadata;
    const happy = m.layers[1];
    // layer 1 的"自己位置"是索引 1；索引 0 是占位
    assert.equal(happy.states[0].visible, false, '别的状态的位置应为占位');
    assert.equal(happy.states[0].scale, 1, '占位槽要显式中性，不能留空');
    assert.equal(happy.states[0].rotation, 0);
    assert.equal(happy.states[1].visible, true);
    assert.equal(happy.rotation, 0.35, '层上的静态角度要写进去');
    assert.deepEqual(happy.scale, [1.4, 1.4]);
    assert.equal(happy.x, -20);
    assert.equal(happy.y, 12);
});

test('non-finite scale and rotation do not poison the manifest', () => {
    const m = layered.buildLayeredPackage({
        canvasWidth: 64, canvasHeight: 64,
        states: [{ stateKey: 'idle_image', frames: 1, width: 64, height: 64, sheetWidth: 64,
            fps: 12, pngBytes: new Uint8Array([1]), scale: 'big', rotation: NaN }],
    }).metadata;
    assert.equal(m.layers[0].scale[0], 1);
    assert.equal(m.layers[0].rotation, 0);
});
