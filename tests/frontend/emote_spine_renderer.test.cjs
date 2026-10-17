const assert = require('node:assert/strict');
const test = require('node:test');

const {
    SpineRenderer,
    SpineRendererError,
    extractAtlasPageNames,
    normalizePath,
} = require('../../static/js/emote_spine_renderer.js');

function fakeRuntime() {
    const calls = [];
    class ManagedWebGLRenderingContext {
        constructor(canvas, config) {
            calls.push(['context.config', config]);
            this.canvas = canvas;
            this.gl = {
                COLOR_BUFFER_BIT: 0x4000,
                RGBA: 0x1908,
                UNSIGNED_BYTE: 0x1401,
                clearColor: (...args) => calls.push(['clearColor', ...args]),
                clear: (...args) => calls.push(['clear', ...args]),
                viewport: (...args) => calls.push(['viewport', ...args]),
                readPixels: (x, y, width, height, format, type, output) => {
                    assert.equal(format, 0x1908);
                    assert.equal(type, 0x1401);
                    // Bottom row red, top row blue: captureFrame must flip it.
                    for (let row = 0; row < height; row += 1) {
                        for (let column = 0; column < width; column += 1) {
                            const offset = (row * width + column) * 4;
                            output[offset] = row < height / 2 ? 255 : 0;
                            output[offset + 1] = 0;
                            output[offset + 2] = row >= height / 2 ? 255 : 0;
                            output[offset + 3] = 255;
                        }
                    }
                },
            };
            canvas.addEventListener?.('webglcontextlost', () => {});
            canvas.addEventListener?.('webglcontextrestored', () => {});
        }
        dispose() { calls.push(['context.dispose']); }
    }

    class SceneRenderer {
        constructor(canvas, context) {
            this.canvas = canvas;
            this.context = context;
            this.camera = {
                viewportWidth: 0,
                viewportHeight: 0,
                zoom: 1,
                position: {
                    x: 0,
                    y: 0,
                    z: 0,
                    set(x, y, z) { this.x = x; this.y = y; this.z = z; },
                },
                direction: {
                    x: 0,
                    y: 0,
                    z: -1,
                    set(x, y, z) { this.x = x; this.y = y; this.z = z; },
                },
                up: {
                    x: 0,
                    y: 1,
                    z: 0,
                    set(x, y, z) { this.x = x; this.y = y; this.z = z; },
                },
                setViewport(width, height) {
                    this.viewportWidth = width;
                    this.viewportHeight = height;
                },
                update() {},
            };
        }
        begin() { calls.push(['renderer.begin']); }
        drawSkeleton() { calls.push(['renderer.drawSkeleton']); }
        end() { calls.push(['renderer.end']); }
        dispose() { calls.push(['renderer.dispose']); }
    }

    class AssetManager {
        constructor() { this.raw = new Map(); }
        setRawDataURI(path, uri) { this.raw.set(path, uri); }
        async loadTextureAtlasAsync(path) {
            calls.push(['atlas', path, this.raw.size]);
            return { pages: [] };
        }
        dispose() { calls.push(['assets.dispose']); }
    }

    class AtlasAttachmentLoader {
        constructor(atlas) { this.atlas = atlas; }
    }

    class SkeletonBinary {
        constructor(loader) { this.loader = loader; }
        readSkeletonData(bytes) {
            assert.ok(bytes instanceof Uint8Array);
            return skeletonData();
        }
    }

    class SkeletonJson {
        constructor(loader) { this.loader = loader; }
        readSkeletonData() { return skeletonData(); }
    }

    class Skeleton {
        constructor(data) { this.data = data; this.x = 0; this.y = 0; }
        getBounds(offset, size) {
            offset.x = -10;
            offset.y = -20;
            size.x = 100;
            size.y = 200;
        }
        updateWorldTransform() { calls.push(['skeleton.updateWorldTransform']); }
    }

    class AnimationStateData {
        constructor(data) { this.data = data; }
    }

    class AnimationState {
        constructor(data) { this.data = data; this.track = null; }
        clearTracks() { this.track = null; }
        setAnimation(trackIndex, name, loop) {
            assert.equal(trackIndex, 0);
            this.track = {
                animation: this.data.data.findAnimation(name),
                loop,
                trackTime: 0,
            };
            return this.track;
        }
        getTrack() { return this.track; }
        update(delta) {
            if (this.track) this.track.trackTime += delta;
        }
        apply() { calls.push(['state.apply']); }
    }

    class Vector2 {
        constructor(x = 0, y = 0) { this.x = x; this.y = y; }
    }

    function skeletonData() {
        const animations = [
            { name: 'ANIM/Idle', duration: 1.25 },
            { name: 'ANIM/Hello', duration: 2.5 },
        ];
        return {
            animations,
            findAnimation(name) { return animations.find((animation) => animation.name === name) || null; },
        };
    }

    return {
        ManagedWebGLRenderingContext,
        SceneRenderer,
        AssetManager,
        TextureAtlas: class {},
        AtlasAttachmentLoader,
        SkeletonBinary,
        SkeletonJson,
        Skeleton,
        AnimationStateData,
        AnimationState,
        Vector2,
        Physics: { update: 2 },
        version: '4.3.13',
        calls,
    };
}

function manifest() {
    return {
        source: { kind: 'emotelab', spineVersion: '4.3.23' },
        model: {
            skeleton: { path: 'pkg/SpineModels/Demo/Demo.skel.bytes', spineVersion: '4.3.23' },
            atlas: {
                path: 'pkg/SpineModels/Demo/Demo.atlas.txt',
                pages: [{ name: 'Page.png', path: 'pkg/SpineModels/Demo/Page.png' }],
            },
        },
        scenes: [{ animationName: 'ANIM/Idle', trackTime: 0.25 }],
    };
}

function canvas() {
    return {
        width: 320,
        height: 240,
        clientWidth: 320,
        clientHeight: 240,
        getContext() { return {}; },
        addEventListener() {},
        removeEventListener() {},
    };
}

function store() {
    const assets = new Map([
        ['pkg/SpineModels/Demo/Demo.atlas.txt', 'Page.png\nsize: 2, 2\nscale: 1\n'],
        ['pkg/SpineModels/Demo/Page.png', new Uint8Array([137, 80, 78, 71])],
        ['pkg/SpineModels/Demo/Demo.skel.bytes', new Uint8Array([4, 3, 2, 3])],
    ]);
    return {
        async open(path, options = {}) {
            const value = assets.get(path);
            if (value == null) throw new Error(`missing ${path}`);
            if (options.as === 'text') return String(value);
            return value;
        },
        list() { return [...assets.keys()]; },
    };
}

test('renderer exports safe path and atlas helpers', () => {
    assert.equal(normalizePath('pkg\\SpineModels\\Demo\\Demo.skel.bytes'), 'pkg/SpineModels/Demo/Demo.skel.bytes');
    assert.equal(normalizePath('../outside.png'), '');
    assert.deepEqual(
        extractAtlasPageNames('Page.png\nsize: 2, 2\n\nPage.png\nOther.png\n'),
        ['Page.png', 'Other.png'],
    );
});

test('renderer fails clearly when no runtime or loader is available', async () => {
    await assert.rejects(
        () => SpineRenderer.create({ canvas: canvas(), manifest: manifest(), assetStore: store() }),
        (error) => error instanceof SpineRendererError && error.code === 'runtime_unavailable',
    );
});

test('renderer loads atlas/skeleton and starts an autoplay animation tick', async () => {
    const runtime = fakeRuntime();
    const instance = await SpineRenderer.create({
        canvas: canvas(),
        manifest: manifest(),
        assetStore: store(),
        runtime,
        renderOnLoad: false,
    });

    assert.equal(instance.status().loaded, true);
    const contextConfig = runtime.calls.find((call) => call[0] === 'context.config')?.[1];
    assert.equal(contextConfig?.preserveDrawingBuffer, true);
    assert.deepEqual(instance.animationNames(), ['ANIM/Idle', 'ANIM/Hello']);
    assert.equal(instance.status().warnings.length, 0);

    const selected = instance.selectAnimation('ANIM/Hello', {
        loop: true,
        time: 0.5,
        autoplay: true,
        render: false,
    });
    assert.equal(selected.name, 'ANIM/Hello');
    assert.equal(selected.loop, true);
    assert.equal(selected.playing, true);
    assert.equal(instance.status().playing, true);
    const frame = instance.tick(0.25, { render: false });
    assert.equal(frame.animation, 'ANIM/Hello');
    assert.equal(frame.time, 0.75);
    instance.pause();
    assert.equal(instance.status().playing, false);
    instance.play();
    assert.equal(instance.status().playing, true);

    instance.render();
    assert.ok(runtime.calls.some((call) => call[0] === 'renderer.drawSkeleton'));
    const halfTurn = Math.SQRT1_2;
    instance.setScene({
        camera: {
            position: [0, 0, 0],
            rotation: [0, halfTurn, 0, halfTurn],
            orthographicSize: 1,
        },
        model: { visible: true, mirrored: false },
    });
    assert.ok(Math.abs(instance.renderer.camera.direction.x + 1) < 0.01);
    instance.dispose();
    assert.equal(instance.status().disposed, true);

    const exportCanvas = canvas();
    exportCanvas.width = 1024;
    exportCanvas.height = 1024;
    exportCanvas.clientWidth = 528;
    exportCanvas.clientHeight = 236;
    const exportRenderer = await SpineRenderer.create({
        canvas: exportCanvas,
        manifest: manifest(),
        assetStore: store(),
        runtime: fakeRuntime(),
        renderOnLoad: false,
    });
    exportRenderer.render();
    assert.equal(exportCanvas.width, 1024);
    assert.equal(exportCanvas.height, 1024);
    const captured = exportRenderer.captureFrame({ render: false, maxDimension: 2 });
    assert.deepEqual({ width: captured.width, height: captured.height }, { width: 2, height: 2 });
    assert.equal(captured.data[2], 255); // top-left pixel is the flipped blue row
    assert.equal(captured.data[(captured.width * 4) + 0], 255); // bottom-left is red
    exportRenderer.dispose();
});

test('renderer resets Spine setup pose when switching animations', () => {
    const instance = new SpineRenderer({ canvas: canvas(), manifest: {}, assetStore: {} });
    const animations = [
        { name: 'ANIM/Alert-Bits', duration: 1 },
        { name: 'ANIM/Angry', duration: 1 },
    ];
    const calls = [];
    instance.loaded = true;
    instance.skeletonData = {
        findAnimation(name) {
            return animations.find((animation) => animation.name === name) || null;
        },
    };
    instance.skeleton = {
        setupPose() { calls.push('setupPose'); },
    };
    instance.state = {
        clearTracks() { calls.push('clearTracks'); },
        setAnimation(track, name, loop) {
            calls.push(['setAnimation', track, name, loop]);
            return { animation: animations.find((item) => item.name === name), loop, trackTime: 0 };
        },
    };
    instance._applyPose = () => calls.push('applyPose');

    instance.selectAnimation('ANIM/Angry', { loop: true, render: false });

    assert.deepEqual(calls, [
        'clearTracks',
        'setupPose',
        ['setAnimation', 0, 'ANIM/Angry', true],
        'applyPose',
    ]);
    assert.equal(instance.currentAnimation, 'ANIM/Angry');
});

test('renderer applies EmoteLab logical slot tags and Character slider chains', () => {
    const instance = new SpineRenderer({ canvas: canvas(), manifest: {}, assetStore: {} });
    const makeColor = () => ({
        r: 1,
        g: 1,
        b: 1,
        a: 1,
        setFromColor(value) {
            this.r = value.r;
            this.g = value.g;
            this.b = value.b;
            this.a = value.a;
        },
        set(r, g, b, a) {
            this.r = r;
            this.g = g;
            this.b = b;
            this.a = a;
        },
    });
    const taggedSlot = {
        data: {
            name: 'Hair_Front/Hair_Color[HairBangLeft]',
            color: { r: 1, g: 1, b: 1, a: 1 },
            darkColor: { r: 0, g: 0, b: 0, a: 1 },
        },
        color: makeColor(),
        darkColor: makeColor(),
    };
    instance.skeleton = {
        slots: [taggedSlot],
        findSlot() { return taggedSlot; },
    };
    instance._characterSlotStyles = [{
        name: 'HairBangLeft',
        tintColor: { r: 0.2, g: 0.4, b: 0.6, a: 1 },
        tintBlackColor: { r: 0.1, g: 0.1, b: 0.1, a: 1 },
    }];
    instance._applyCharacterSlotStyles();
    assert.equal(taggedSlot.color.r, 0.2);
    assert.equal(taggedSlot.color.g, 0.4);
    assert.equal(taggedSlot.darkColor.r, 0.1);

    const poseColor = makeColor();
    const poseDark = makeColor();
    const spine43Slot = {
        data: {
            name: 'Hair_Front/Hair_Color[HairBangRight]',
            setupPose: {
                color: makeColor(),
                darkColor: makeColor(),
            },
        },
        pose: { color: poseColor, darkColor: poseDark },
        appliedPose: { color: makeColor(), darkColor: makeColor() },
    };
    instance.skeleton.slots.push(spine43Slot);
    instance._characterSlotStyles.push({
        name: 'HairBangRight',
        tintColor: { r: 0.7, g: 0.5, b: 0.3, a: 1 },
        tintBlackColor: { r: 0.2, g: 0.15, b: 0.1, a: 1 },
    });
    instance._applyCharacterSlotStyles();
    assert.equal(poseColor.r, 0.7);
    assert.equal(poseColor.g, 0.5);
    assert.equal(poseDark.r, 0.2);

    const bones = ['PigtailA_Left1', 'PigtailA_Left2', 'PigtailB_Left'].map((name) => ({
        data: {
            name,
            length: 100,
            setupPose: { x: 10, y: 20, scaleX: 1, shearY: 0 },
        },
        pose: { x: 10, y: 20, scaleX: 1, shearY: 0 },
    }));
    instance.skeleton.data = { bones: bones.map((bone) => bone.data) };
    instance.skeleton.findBone = (name) => bones.find((bone) => bone.data.name === name);
    instance._characterSliderValues = [
        { name: 'Character/PigtailLeft_Length', value: 1.25 },
        { name: 'Character/PigtailLeft_Position', value: 0.5 },
    ];
    instance._applyCharacterSliders();
    assert.deepEqual(instance.sliderStatus().applied, [
        { name: 'Character/PigtailLeft_Length', bones: 3, mode: 'heuristic' },
        { name: 'Character/PigtailLeft_Position', bones: 1, mode: 'heuristic' },
    ]);
    assert.equal(bones[0].pose.scaleX, 1.25);
    assert.equal(bones[0].pose.x, 5);
    assert.equal(instance.sliderMapping('Character/PigtailLeft_Length').mode, 'heuristic');
    assert.ok(instance.warnings.some((warning) => warning.includes('使用启发式映射')));
});

test('renderer restores omitted required skin groups such as hands and legs', () => {
    const instance = new SpineRenderer({ canvas: canvas(), manifest: {}, assetStore: {} });
    const available = [
        { name: 'default' },
        { name: 'A_FacialFeatures/Eye[Required]/Eye1' },
        { name: 'A_FacialFeatures/Eye[Required]/Eye2' },
        { name: 'A_FacialFeatures/Ear[DefaultOn]/Ear1' },
        { name: 'G_Outfit/Hand[Required]/Hand1' },
        { name: 'G_Outfit/Hand[Required]/Hand2' },
        { name: 'G_Outfit/Leg[Required]/Leg1' },
    ];
    const added = [];
    class Skin {
        constructor(name) { this.name = name; }
        addSkin(skin) { added.push(skin.name); }
    }
    instance.runtime = { Skin };
    instance.skeletonData = {
        skins: available,
        findSkin(name) { return available.find((skin) => skin.name === name) || null; },
    };
    instance.skeleton = {
        setSkin(value) { this.skin = value; },
        setupPoseSlots() {},
    };

    instance._applyCharacterSkins([{ group: 'Eye', value: 'Eye2' }]);

    assert.deepEqual(added, [
        'default',
        'A_FacialFeatures/Eye[Required]/Eye2',
        'A_FacialFeatures/Ear[DefaultOn]/Ear1',
        'G_Outfit/Hand[Required]/Hand1',
        'G_Outfit/Leg[Required]/Leg1',
    ]);
    assert.equal(instance.status().skinCount, 4);
});

test('renderer does not synthesize rear hair for an explicit paired-pigtail preset', () => {
    const instance = new SpineRenderer({ canvas: canvas(), manifest: {}, assetStore: {} });
    const available = [
        { name: 'default' },
        { name: 'B_HairFront/BaseHair[Required]/BaseHair1' },
        { name: 'C_HairSide/SideHair[DefaultOn]/SideHairA1' },
        { name: 'E_HairBack/BackHair[DefaultOn]/BackHair1' },
        { name: 'E_HairBack/PigtailLeft[DefaultOff]/PigtailLeftA6' },
        { name: 'E_HairBack/PigtailRight[DefaultOff]/PigtailRightA6' },
        { name: 'G_Outfit/Hand[Required]/Hand1' },
        { name: 'G_Outfit/Leg[Required]/Leg1' },
    ];
    const added = [];
    class Skin {
        constructor(name) { this.name = name; }
        addSkin(skin) { added.push(skin.name); }
    }
    instance.runtime = { Skin };
    instance.skeletonData = {
        skins: available,
        findSkin(name) { return available.find((skin) => skin.name === name) || null; },
    };
    instance.skeleton = {
        setSkin(value) { this.skin = value; },
        setupPoseSlots() {},
    };

    instance._applyCharacterSkins([
        { group: 'BaseHair', value: 'BaseHair1' },
        { group: 'PigtailLeft', value: 'PigtailLeftA6' },
        { group: 'PigtailRight', value: 'PigtailRightA6' },
    ]);

    assert.deepEqual(added, [
        'default',
        'B_HairFront/BaseHair[Required]/BaseHair1',
        'E_HairBack/PigtailLeft[DefaultOff]/PigtailLeftA6',
        'E_HairBack/PigtailRight[DefaultOff]/PigtailRightA6',
        'G_Outfit/Hand[Required]/Hand1',
        'G_Outfit/Leg[Required]/Leg1',
    ]);
    assert.equal(added.some((name) => /(?:BackHair|SideHair)/i.test(name)), false);
});

test('renderer keeps WeightTransfer clothing and accessory attachments in the draw list', () => {
    const instance = new SpineRenderer({ canvas: canvas(), manifest: {}, assetStore: {} });
    const weightAttachment = { name: 'WeightTransfer/OutfitInner_WeightTransfer' };
    const weightPose = { attachment: weightAttachment };
    const slot = {
        data: { name: 'Outfit_Front/OutfitOutfitInner_WeightTransfer[Ignore]' },
        appliedPose: weightPose,
        pose: weightPose,
    };
    const drawn = [];
    instance.skeleton = {
        visible: true,
        slots: [slot],
    };
    instance.loaded = true;
    instance.gl = {
        COLOR_BUFFER_BIT: 0x4000,
        clearColor() {},
        clear() {},
    };
    instance.renderer = {
        begin() {},
        drawSkeleton(skeleton) { drawn.push(skeleton.slots[0].appliedPose.attachment); },
        end() {},
    };
    instance._resizeCanvas = () => ({ width: 1, height: 1 });
    instance._applySceneCamera = () => {};

    instance.render({ fit: false });

    assert.deepEqual(drawn, [weightAttachment]);
    assert.equal(weightPose.attachment, weightAttachment);
});

test('renderer prefers native Spine Slider constraints and maps 0..2 to animation time', () => {
    const instance = new SpineRenderer({ canvas: canvas(), manifest: {}, assetStore: {} });
    const nativeConstraint = {
        data: {
            name: 'Character/PigtailLeft_Length',
            setupPose: { time: 2 / 3, mix: 1 },
            animation: { duration: 4 / 3, bones: [455, 460] },
        },
        pose: { time: 2 / 3, mix: 1 },
        constrainedPose: { time: 2 / 3, mix: 1 },
        appliedPose: { time: 2 / 3, mix: 1 },
    };
    const fallbackBone = {
        data: {
            name: 'PigtailA_Left1',
            length: 100,
            setupPose: { x: 10, y: 20, scaleX: 1, shearY: 0 },
        },
        pose: { x: 10, y: 20, scaleX: 1, shearY: 0 },
    };
    let worldTransformObserved = false;
    instance.skeleton = {
        constraints: [nativeConstraint],
        slots: [],
        data: { bones: [fallbackBone.data] },
        findBone() { return fallbackBone; },
        updateWorldTransform() {
            worldTransformObserved = true;
            assert.equal(nativeConstraint.pose.time, 1);
            assert.equal(nativeConstraint.constrainedPose.time, 1);
            assert.equal(nativeConstraint.appliedPose.time, 1);
        },
    };
    instance.runtime = { Physics: { update: 2 } };
    instance.state = {
        apply() {
            // Simulate AnimationState writing a prior slider pose. The native
            // override must run after state.apply and before world update.
            nativeConstraint.pose.time = 0;
            nativeConstraint.constrainedPose.time = 0;
            nativeConstraint.appliedPose.time = 0;
        },
    };
    instance._characterSliderValues = [{ name: 'Character/PigtailLeft_Length', value: 1.5 }];
    instance._applyPose(0);

    assert.equal(worldTransformObserved, true);
    assert.deepEqual(instance.sliderStatus().applied, [
        { name: 'Character/PigtailLeft_Length', bones: 2, mode: 'native' },
    ]);
    assert.deepEqual(instance.sliderMapping('Character/PigtailLeft_Length'), {
        base: 'PigtailLeft',
        property: 'length',
        bones: 2,
        targets: 2,
        supported: true,
        mode: 'native',
    });
    assert.equal(instance.sliderDefaultValue('Character/PigtailLeft_Length'), 1);
    // A native constraint wins over the similarly named heuristic chain.
    assert.equal(fallbackBone.pose.scaleX, 1);
    assert.equal(instance.warnings.length, 0);
});

test('renderer reads Spine 4.3 VIEWPORT bounding boxes and falls back to drawable bounds', () => {
    const runtime = fakeRuntime();
    const instance = new SpineRenderer({
        canvas: canvas(),
        manifest: {},
        assetStore: {},
    });
    instance.runtime = runtime;
    const attachment = {
        worldVerticesLength: 8,
        computeWorldVertices(skeleton, slot, start, count, output, offset, stride) {
            assert.equal(skeleton, instance.skeleton);
            assert.equal(slot, instance.skeleton.slots[0]);
            assert.equal(start, 0);
            assert.equal(count, 8);
            assert.equal(offset, 0);
            assert.equal(stride, 2);
            [
                -4, -3,
                6, -3,
                6, 7,
                -4, 7,
            ].forEach((value, index) => { output[index] = value; });
        },
    };
    instance.skeleton = {
        slots: [{ data: { name: 'VIEWPORT' }, pose: { attachment } }],
        getBounds(offset, size) {
            offset.x = -100;
            offset.y = -50;
            size.x = 200;
            size.y = 100;
        },
    };
    const viewport = instance._readViewportBounds();
    assert.deepEqual(
        {
            minX: viewport.minX,
            minY: viewport.minY,
            maxX: viewport.maxX,
            maxY: viewport.maxY,
            width: viewport.width,
            height: viewport.height,
        },
        { minX: -4, minY: -3, maxX: 6, maxY: 7, width: 10, height: 10 },
    );

    // Older compatible runtimes omit the leading skeleton argument.  The
    // renderer selects that six-argument signature without misaligning the
    // output buffer.
    const legacyAttachment = {
        worldVerticesLength: 8,
        computeWorldVertices(slot, start, count, output, offset, stride) {
            assert.equal(slot, instance.skeleton.slots[0]);
            assert.equal(start, 0);
            assert.equal(count, 8);
            assert.equal(offset, 0);
            assert.equal(stride, 2);
            [-2, -1, 3, -1, 3, 4, -2, 4]
                .forEach((value, index) => { output[index] = value; });
        },
    };
    instance.skeleton.slots[0].pose.attachment = legacyAttachment;
    const legacyViewport = instance._readViewportBounds();
    assert.equal(legacyViewport.width, 5);
    assert.equal(legacyViewport.height, 5);

    // EmoteLab scans all skins, so a template may keep VIEWPORT only in a
    // non-active skin. Spine 4.3 stores skin entries as a slot-indexed map.
    const hiddenSlot = { data: { name: 'HiddenViewportSlot' }, pose: {} };
    const hiddenAttachment = {
        worldVerticesLength: 8,
        computeWorldVertices(skeleton, slot, start, count, output, offset, stride) {
            assert.equal(skeleton, instance.skeleton);
            assert.equal(slot, hiddenSlot);
            assert.equal(start, 0);
            assert.equal(count, 8);
            assert.equal(offset, 0);
            assert.equal(stride, 2);
            [10, 20, 14, 20, 14, 26, 10, 26]
                .forEach((value, index) => { output[index] = value; });
        },
    };
    instance.skeleton.slots = [hiddenSlot];
    instance.skeleton.data = {
        skins: [{ attachments: [{ VIEWPORT: hiddenAttachment }] }],
    };
    const hiddenViewport = instance._readViewportBounds();
    assert.deepEqual(
        {
            minX: hiddenViewport.minX,
            minY: hiddenViewport.minY,
            maxX: hiddenViewport.maxX,
            maxY: hiddenViewport.maxY,
        },
        { minX: 10, minY: 20, maxX: 14, maxY: 26 },
    );

    // Keep compatibility with runtimes exposing SkinEntry records instead of
    // the Spine 4.3 slot-indexed map.
    const legacySkinAttachment = {
        worldVerticesLength: 8,
        computeWorldVertices(slot, start, count, output) {
            assert.equal(slot, hiddenSlot);
            assert.equal(start, 0);
            assert.equal(count, 8);
            [-8, -7, -4, -7, -4, -2, -8, -2]
                .forEach((value, index) => { output[index] = value; });
        },
    };
    instance.skeleton.data = {};
    instance.skeletonData = {
        data: {
            skins: [{ attachments: [{
                slotIndex: 0,
                placeholder: 'VIEWPORT',
                attachment: legacySkinAttachment,
            }] }],
        },
    };
    const legacySkinViewport = instance._readViewportBounds();
    assert.equal(legacySkinViewport.width, 4);
    assert.equal(legacySkinViewport.height, 5);

    // A package without VIEWPORT remains usable: the regular drawable bounds
    // are used for the editor's relative Fit/Reset path.
    instance.skeleton.slots = [];
    instance.runtime = {};
    instance.renderer = {
        camera: {
            viewportWidth: 320,
            viewportHeight: 240,
            zoom: 1,
            position: { set() {} },
            direction: { set() {} },
            up: { set() {} },
            update() {},
        },
    };
    instance._fitSkeleton();
    assert.equal(instance._baseFit.boundsSource, 'skeleton-bounds');
    assert.equal(instance._baseFit.width, 200);
    assert.equal(instance._baseFit.height, 100);
});

test('renderer maps EmoteLab Unity camera units to Spine native pixels', () => {
    const runtime = fakeRuntime();
    const instance = new SpineRenderer({
        canvas: canvas(),
        manifest: {
            scenes: [{
                camera: {
                    position: [2, 3, -10],
                    rotation: [0, 0, 0, 1],
                    orthographicSize: 4,
                },
            }],
        },
        assetStore: {},
    });
    instance.runtime = runtime;
    instance.skeletonData = { referenceScale: 100 };
    instance._referenceScale = 100;
    instance.skeleton = {
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        rotation: 0,
        visible: true,
        slots: [],
        getBounds(offset, size) {
            offset.x = -50;
            offset.y = -25;
            size.x = 100;
            size.y = 50;
        },
    };
    const camera = {
        viewportWidth: 320,
        viewportHeight: 240,
        zoom: 1,
        position: {
            x: 0,
            y: 0,
            z: 0,
            set(x, y, z) { this.x = x; this.y = y; this.z = z; },
        },
        direction: { set() {} },
        up: { set() {} },
        update() {},
    };
    instance.renderer = { camera };
    instance._fitSkeleton();
    assert.equal(instance._baseFit.calibrated, true);
    // OrthoCamera.zoom is native model units per output pixel, and Unity's
    // orthographicSize is the vertical half-height.
    assert.ok(Math.abs(camera.zoom - (4 * 2 * 100 / 240)) < 1e-9);
    assert.equal(camera.position.x, 200);
    assert.equal(camera.position.y, 300);
    assert.equal(camera.position.z, 0);
});
