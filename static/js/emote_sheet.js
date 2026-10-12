// 由 emote_maker.js 使用：把逐帧结果拼成分层包需要的横条雪碧图，并产出 PNG 字节。
// 单独成文件是为了能在 Node 里被测到（只依赖注入进来的 canvas 工厂，不碰 DOM 全局）。
(function (root, factory) {
    'use strict';

    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
        return;
    }

    root.NekoEmoteSheet = factory();
}(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const MAX_SHEET_EDGE = 4096;   // 与 layered 模块的上限保持一致，超了要分块

    /**
     * 按秒切出要烘进雪碧图的帧。
     * 运行时在会动的状态下会把 `layerState.frame` 基准丢掉
     * （frame = elapsed * speed * 4 % frames），所以起止**只能**靠只烘那几帧来实现。
     * seconds <= 0 表示演到结尾。
     */
    function sliceFrames(frames, { startAt = 0, seconds = 0, fps = 12 } = {}) {
        const list = Array.isArray(frames) ? frames : [];
        if (!list.length) return { frames: [], skipped: 0, totalFrames: 0 };
        const rate = Math.max(1, Math.round(Number(fps) || 12));
        const from = Math.max(0, Math.min(list.length - 1, Math.round((Number(startAt) || 0) * rate)));
        const wanted = Number(seconds) || 0;
        const count = wanted > 0
            ? Math.max(1, Math.min(list.length - from, Math.round(wanted * rate)))
            : list.length - from;
        return {
            frames: list.slice(from, from + Math.max(1, count)),
            skipped: from,
            totalFrames: list.length,
        };
    }

    // 格子尺寸取整批帧的最大值：按"第一帧"定的话，后面任何一帧更大都会溢到自己
    // 的邻居格里（运行时按同一网格取格，于是两个动作各缺一条）。
    function frameSize(frames) {
        let width = 0;
        let height = 0;
        (Array.isArray(frames) ? frames : []).forEach((frame) => {
            width = Math.max(width, Math.round(Number(frame?.width) || 0));
            height = Math.max(height, Math.round(Number(frame?.height) || 0));
        });
        return { width: Math.max(1, width), height: Math.max(1, height) };
    }

    // 一行的帧数：受雪碧图上限约束，超出就换行（vframes > 1）
    function gridFor(count, frameWidth) {
        const perRow = Math.max(1, Math.min(count, Math.floor(MAX_SHEET_EDGE / Math.max(1, frameWidth))));
        const rows = Math.max(1, Math.ceil(count / perRow));
        return { hframes: perRow, vframes: rows };
    }

    /**
     * 把 frames 画进一个 canvas（横向优先，超宽自动换行），返回该 canvas。
     * makeCanvas(w,h) 由调用方注入，方便测试与替换实现。
     */
    function composeSheetCanvas(frames, makeCanvas) {
        const list = Array.isArray(frames) ? frames : [];
        if (!list.length) throw new Error('没有可用的帧');
        const { width, height } = frameSize(list);
        const { hframes, vframes } = gridFor(list.length, width);
        const canvas = makeCanvas(hframes * width, vframes * height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('无法取得 2D 上下文');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        list.forEach((frame, index) => {
            const data = frame && frame.data;
            if (!data) return;
            const image = new ImageData(new Uint8ClampedArray(data), frame.width || width, frame.height || height);
            const off = document.createElement('canvas');
            off.width = image.width;
            off.height = image.height;
            off.getContext('2d').putImageData(image, 0, 0);
            ctx.drawImage(off, (index % hframes) * width, Math.floor(index / hframes) * height);
        });
        return { canvas, hframes, vframes, frameWidth: width, frameHeight: height };
    }

    /** 取合成结果里的第 0 帧，作为分层包的平铺回落图。 */
    function firstFrameCanvas(frame) {
        const width = Math.max(1, Math.round(Number(frame.width) || 1));
        const height = Math.max(1, Math.round(Number(frame.height) || 1));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(new ImageData(new Uint8ClampedArray(frame.data), width, height), 0, 0);
        return canvas;
    }

    function canvasToPngBytes(canvas) {
        return new Promise((resolve, reject) => {
            if (!canvas || typeof canvas.toBlob !== 'function') {
                reject(new Error('canvas 不支持 toBlob'));
                return;
            }
            canvas.toBlob((blob) => {
                if (!blob) {
                    reject(new Error('PNG 编码失败'));
                    return;
                }
                blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
            }, 'image/png');
        });
    }

    return Object.freeze({
        MAX_SHEET_EDGE,
        sliceFrames,
        composeSheetCanvas,
        firstFrameCanvas,
        canvasToPngBytes,
        gridFor,
    });
}));
