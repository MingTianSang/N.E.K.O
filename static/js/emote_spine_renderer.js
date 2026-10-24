/*
 * Minimal, manually-driven Spine renderer for EmoteLab packages.
 *
 * This module intentionally has no UI and does not persist or bundle model
 * assets.  Callers provide a canvas, the renderer-neutral manifest returned by
 * the EmoteLab adapter, and an ephemeral ClientZipAssetStore.  The renderer
 * loads the official Spine WebGL runtime lazily (when a loader is available),
 * creates a TextureAtlas/Skeleton/AnimationState, and exposes explicit
 * select/tick/render methods.  A caller owns the render loop and the asset
 * store, which makes this bridge easy to roll back while native preview is
 * being validated.
 *
 * The bundled runtime is 4.3.13.  Spine 4.3 model packages are accepted by
 * default, but a version mismatch is surfaced in `status().warnings`; callers
 * that need a hard gate can pass `allowVersionMismatch: false`.
 */
(function (root, factory) {
    'use strict';

    if (typeof module === 'object' && module.exports) {
        module.exports = factory(typeof globalThis !== 'undefined' ? globalThis : root);
        return;
    }

    root.NekoEmoteSpineRenderer = factory(root);
}(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    const REQUIRED_RUNTIME_SYMBOLS = Object.freeze([
        'ManagedWebGLRenderingContext',
        'SceneRenderer',
        'AssetManager',
        'TextureAtlas',
        'AtlasAttachmentLoader',
        'SkeletonBinary',
        'SkeletonJson',
        'Skeleton',
        'AnimationStateData',
        'AnimationState',
    ]);
    const DEFAULT_RUNTIME_VERSION = '4.3.13';
    const DEFAULT_BACKGROUND = Object.freeze([0, 0, 0, 0]);

    class SpineRendererError extends Error {
        constructor(message, code = 'renderer_error', details = undefined) {
            super(message);
            this.name = 'SpineRendererError';
            this.code = code;
            if (details !== undefined) this.details = details;
        }
    }

    function asPositiveNumber(value, fallback) {
        const number = Number(value);
        return Number.isFinite(number) && number > 0 ? number : fallback;
    }

    function normalizePath(value) {
        let path = String(value || '').replace(/\\/g, '/').normalize('NFC');
        if (!path || path.startsWith('/') || path.includes('\0')) return '';
        const parts = [];
        for (const part of path.split('/')) {
            if (!part || part === '.') continue;
            if (part === '..') return '';
            parts.push(part);
        }
        return parts.join('/');
    }

    function dirname(path) {
        const normalized = normalizePath(path);
        const index = normalized.lastIndexOf('/');
        return index >= 0 ? normalized.slice(0, index + 1) : '';
    }

    function basename(path) {
        const normalized = normalizePath(path);
        const index = normalized.lastIndexOf('/');
        return index >= 0 ? normalized.slice(index + 1) : normalized;
    }

    function joinPath(prefix, name) {
        const candidate = `${prefix || ''}${name || ''}`;
        return normalizePath(candidate);
    }

    function toBytes(value) {
        if (value instanceof Uint8Array) return value;
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (ArrayBuffer.isView(value)) {
            return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        }
        throw new SpineRendererError('模板资源不是二进制数据', 'invalid_asset');
    }

    function utf8Bytes(value) {
        if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(value));
        // Node versions used by the smoke tests expose Buffer, while older
        // browser embeddings may only expose the global TextEncoder.
        if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(String(value), 'utf8'));
        throw new SpineRendererError('当前环境缺少 UTF-8 编码器', 'encoding_unavailable');
    }

    function base64Encode(bytes) {
        const input = toBytes(bytes);
        if (typeof Buffer !== 'undefined') return Buffer.from(input).toString('base64');
        if (typeof btoa !== 'function') {
            throw new SpineRendererError('当前环境缺少 Base64 编码器', 'encoding_unavailable');
        }
        let binary = '';
        const chunkSize = 0x8000;
        for (let index = 0; index < input.length; index += chunkSize) {
            binary += String.fromCharCode(...input.subarray(index, index + chunkSize));
        }
        return btoa(binary);
    }

    function bytesToDataUri(bytes, mimeType) {
        return `data:${mimeType};base64,${base64Encode(bytes)}`;
    }

    function extractAtlasPageNames(atlasText) {
        const pages = [];
        const seen = new Set();
        const lines = String(atlasText || '').replace(/^\uFEFF/, '').split(/\r?\n/);
        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.includes(':') || !/\.png$/i.test(line)) continue;
            const key = line.toLocaleLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            pages.push(line);
        }
        return pages;
    }

    function runtimeSymbols(runtime) {
        return REQUIRED_RUNTIME_SYMBOLS.filter((name) => typeof runtime?.[name] !== 'function');
    }

    function spineVersionFamily(value) {
        const match = String(value || '').match(/^(\d+)\.(\d+)/);
        return match ? `${match[1]}.${match[2]}` : '';
    }

    function normalizeSkinToken(value) {
        return String(value || '')
            .trim()
            .replace(/\[[^\]]*\]/g, '')
            .replace(/[\s_\-]+/g, '')
            .toLocaleLowerCase();
    }

    function skinDescriptor(name) {
        const parts = String(name || '').split('/').filter(Boolean);
        if (parts.length < 2) return { group: '', value: parts[0] || '' };
        const value = parts[parts.length - 1];
        const group = parts[parts.length - 2];
        return {
            group,
            groupToken: normalizeSkinToken(group),
            value,
            valueToken: normalizeSkinToken(value),
            path: parts.slice(0, -1).join('/'),
        };
    }

    function finiteOr(value, fallback) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function rotateVectorByQuaternion(vector, quaternion) {
        const [vx, vy, vz] = vector.map((value) => finiteOr(value, 0));
        let [qx, qy, qz, qw] = Array.isArray(quaternion)
            ? quaternion.slice(0, 4).map((value) => finiteOr(value, 0))
            : [0, 0, 0, 1];
        const length = Math.hypot(qx, qy, qz, qw);
        if (length > 0.000001) {
            qx /= length;
            qy /= length;
            qz /= length;
            qw /= length;
        } else {
            qx = 0;
            qy = 0;
            qz = 0;
            qw = 1;
        }
        // q * v * inverse(q), expanded without allocating runtime vectors.
        const ix = qw * vx + qy * vz - qz * vy;
        const iy = qw * vy + qz * vx - qx * vz;
        const iz = qw * vz + qx * vy - qy * vx;
        const iw = -qx * vx - qy * vy - qz * vz;
        return [
            ix * qw + iw * -qx + iy * -qz - iz * -qy,
            iy * qw + iw * -qy + iz * -qx - ix * -qz,
            iz * qw + iw * -qz + ix * -qy - iy * -qx,
        ];
    }

    function getRuntime(options = {}) {
        return options.runtime || root?.spine || null;
    }

    async function ensureRuntime(options = {}) {
        let runtime = getRuntime(options);
        const loader = options.runtimeLoader || root?.NekoSpineRuntime;
        if (runtime && runtimeSymbols(runtime).length === 0) return runtime;
        if (!runtime && loader && typeof loader.load === 'function') {
            await loader.load(options.runtimeLoadOptions || {});
            runtime = getRuntime(options);
        }
        const missing = runtimeSymbols(runtime);
        if (missing.length) {
            throw new SpineRendererError(
                `Spine WebGL runtime 不可用：${missing.join(', ')}`,
                'runtime_unavailable',
                { missing },
            );
        }
        return runtime;
    }

    function modelFromManifest(manifest) {
        if (!manifest || typeof manifest !== 'object') {
            throw new SpineRendererError('缺少模板 manifest', 'invalid_manifest');
        }
        const model = manifest.model;
        const skeleton = model?.skeleton;
        const atlas = model?.atlas;
        const skeletonPath = normalizePath(skeleton?.path);
        const atlasPath = normalizePath(atlas?.path);
        if (!skeletonPath || !atlasPath) {
            throw new SpineRendererError(
                'manifest 缺少 model.skeleton.path 或 model.atlas.path',
                'invalid_manifest',
            );
        }
        return { model, skeleton, atlas, skeletonPath, atlasPath };
    }

    async function openStoreAsset(store, requestedPath, mode = 'bytes') {
        if (!store || typeof store !== 'object') {
            throw new SpineRendererError('缺少临时模板资源仓库', 'invalid_asset_store');
        }
        const normalized = normalizePath(requestedPath);
        if (!normalized) throw new SpineRendererError('模板资源路径不安全', 'unsafe_path');

        const candidates = [normalized];
        const requestedBase = basename(normalized).toLocaleLowerCase();
        if (typeof store.list === 'function') {
            let listed = [];
            try { listed = store.list(); } catch (_) { listed = []; }
            const matches = listed.filter((path) => basename(path).toLocaleLowerCase() === requestedBase);
            if (matches.length === 1 && matches[0] !== normalized) candidates.push(matches[0]);
        }

        let lastError = null;
        for (const candidate of candidates) {
            try {
                if (typeof store.open === 'function') {
                    const value = await store.open(candidate, { as: mode });
                    if (mode === 'text') {
                        if (typeof value === 'string') return value;
                        return new TextDecoder().decode(toBytes(value));
                    }
                    return toBytes(value);
                }
                if (typeof store.get === 'function') {
                    const value = store.get(candidate);
                    if (value != null) {
                        return mode === 'text'
                            ? new TextDecoder().decode(toBytes(value))
                            : toBytes(value);
                    }
                }
            } catch (error) {
                lastError = error;
            }
        }
        throw new SpineRendererError(
            `模板资源不存在：${requestedPath}`,
            'asset_not_found',
            { path: requestedPath, cause: lastError },
        );
    }

    function clearColor(gl, color) {
        if (!gl || typeof gl.clearColor !== 'function' || typeof gl.clear !== 'function') return;
        const [r, g, b, a] = Array.isArray(color) ? color : DEFAULT_BACKGROUND;
        gl.clearColor(
            Number.isFinite(Number(r)) ? Number(r) : 0,
            Number.isFinite(Number(g)) ? Number(g) : 0,
            Number.isFinite(Number(b)) ? Number(b) : 0,
            Number.isFinite(Number(a)) ? Number(a) : 0,
        );
        gl.clear(gl.COLOR_BUFFER_BIT);
    }

    class SpineRenderer {
        constructor(options = {}) {
            if (!options.canvas || typeof options.canvas.getContext !== 'function') {
                throw new SpineRendererError('需要可获取 WebGL 上下文的 canvas', 'invalid_canvas');
            }
            this.canvas = options.canvas;
            this.manifest = options.manifest;
            this.assetStore = options.assetStore;
            this.options = { ...options };
            this.runtime = null;
            this.context = null;
            this.gl = null;
            this.renderer = null;
            this.assetManager = null;
            this.atlas = null;
            this.skeletonData = null;
            this.skeleton = null;
            this.stateData = null;
            this.state = null;
            this.currentAnimation = null;
            this.playing = false;
            this.loaded = false;
            this.disposed = false;
            this.warnings = [];
            this._modelInfo = null;
            this._characterSkinSelections = [];
            this._characterSlotStyles = [];
            this._characterSliderValues = [];
            this._sliderApplications = [];
            this._baseFit = null;
            this._referenceScale = 1;
            this._viewportBounds = null;
            this._scene = null;
            this._sceneTransform = { x: 0, y: 0, rotation: 0, scale: 1 };
            // Spine 4.3 的 Skeleton 没有 rotation。编辑器角度加在根骨骼上，
            // 这个数记下动画自己的角度，避免每帧再叠一次。
            this._rootRotationBasis = null;
            this._editorRotationApplied = 0;
            this._colorMode = { mode: 'default', primary: null, secondary: null };
            this._background = [...DEFAULT_BACKGROUND];
        }

        static async create(options = {}) {
            const instance = new SpineRenderer(options);
            await instance.load();
            return instance;
        }

        _assertLive() {
            if (this.disposed) throw new SpineRendererError('Spine renderer 已释放', 'released');
        }

        async load() {
            this._assertLive();
            if (this.loaded) return this;
            this._modelInfo = modelFromManifest(this.manifest);
            this.runtime = await ensureRuntime(this.options);

            const expectedVersion = this.runtime?.version || DEFAULT_RUNTIME_VERSION;
            const packageVersion = this.manifest?.source?.spineVersion
                || this._modelInfo.skeleton?.spineVersion
                || null;
            const sameVersionFamily = packageVersion && expectedVersion
                && spineVersionFamily(packageVersion) === spineVersionFamily(expectedVersion);
            if (packageVersion && expectedVersion && !sameVersionFamily) {
                const warning = `Spine 模型版本 ${packageVersion} 与运行时 ${expectedVersion} 不同`;
                this.warnings.push(warning);
                if (this.options.allowVersionMismatch === false) {
                    throw new SpineRendererError(warning, 'runtime_version_mismatch', {
                        packageVersion,
                        runtimeVersion: expectedVersion,
                    });
                }
            }

            const webglConfig = {
                alpha: true,
                // Spine 4.3 只有一个混合模式：src=ONE, dst=ONE_MINUS_SRC_ALPHA，配合
                // `gl_FragColor = v_color * texture2D(...)` 的 shader，帧缓冲里存的是**预乘**
                // alpha。若声明成 false，浏览器会把这个 canvas 合成到导出用的 2D canvas 时
                // 再乘一次 alpha，半透明像素和柔边被二次压暗 —— 屏幕上预览正常（不走这次
                // 合成），只有导出的文件偏暗，所以别把它"修"回 false。
                premultipliedAlpha: true,
                // The editor exports directly from this canvas.  Without a
                // preserved drawing buffer Chromium is allowed to discard the
                // composited frame before toBlob()/toDataURL() reads it,
                // producing a fully transparent PNG even though the preview
                // is visibly rendered.
                preserveDrawingBuffer: true,
                ...(this.options.webglConfig || {}),
            };
            try {
                this.context = new this.runtime.ManagedWebGLRenderingContext(this.canvas, webglConfig);
                this.gl = this.context.gl;
                if (!this.gl) throw new Error('WebGL context creation failed');
                this.renderer = new this.runtime.SceneRenderer(
                    this.canvas,
                    this.context,
                    this.options.twoColorTint !== false,
                );
                this.assetManager = new this.runtime.AssetManager(this.context);

                const atlasText = await openStoreAsset(this.assetStore, this._modelInfo.atlasPath, 'text');
                const atlasUri = bytesToDataUri(utf8Bytes(atlasText), 'text/plain;charset=utf-8');
                this.assetManager.setRawDataURI(this._modelInfo.atlasPath, atlasUri);

                const manifestPages = Array.isArray(this._modelInfo.atlas.pages)
                    ? this._modelInfo.atlas.pages
                    : [];
                const pageNames = manifestPages.length
                    ? manifestPages.map((page) => String(page?.name || '')).filter(Boolean)
                    : extractAtlasPageNames(atlasText);
                const atlasRoot = dirname(this._modelInfo.atlasPath);
                for (const page of manifestPages) {
                    const pageName = String(page?.name || '');
                    if (!pageName) continue;
                    const pagePath = page?.path || joinPath(atlasRoot, pageName);
                    const bytes = await openStoreAsset(this.assetStore, pagePath, 'bytes');
                    this._registerRawPage(pageName, pagePath, atlasRoot, bytes);
                }
                // A manifest generated by an older adapter may omit pages. In
                // that case derive names from atlas.txt and use basename lookup.
                for (const pageName of pageNames) {
                    const expectedPath = joinPath(atlasRoot, pageName);
                    if (this._hasRawPage(expectedPath)) continue;
                    const bytes = await openStoreAsset(this.assetStore, expectedPath, 'bytes');
                    this._registerRawPage(pageName, expectedPath, atlasRoot, bytes);
                }

                this.atlas = await this.assetManager.loadTextureAtlasAsync(this._modelInfo.atlasPath);
                const attachmentLoader = new this.runtime.AtlasAttachmentLoader(this.atlas);
                const skeletonBytes = await openStoreAsset(
                    this.assetStore,
                    this._modelInfo.skeletonPath,
                    'bytes',
                );
                const parser = /\.json$/i.test(this._modelInfo.skeletonPath)
                    ? new this.runtime.SkeletonJson(attachmentLoader)
                    : new this.runtime.SkeletonBinary(attachmentLoader);
                if ('scale' in parser && this.options.scale != null) {
                    parser.scale = Number(this.options.scale) || 1;
                }
                const parsedInput = parser instanceof this.runtime.SkeletonJson
                    ? new TextDecoder().decode(skeletonBytes)
                    : skeletonBytes;
                this.skeletonData = parser.readSkeletonData(parsedInput);
                this.skeleton = new this.runtime.Skeleton(this.skeletonData);
                this._referenceScale = asPositiveNumber(this.skeletonData?.referenceScale, 1);
                this._characterSkinSelections = this._readCharacterSkinSelections();
                this._characterSlotStyles = this._readCharacterSlotStyles();
                this._characterSliderValues = this._readCharacterSliderValues();
                this._applyCharacterSkins();
                this.stateData = new this.runtime.AnimationStateData(this.skeletonData);
                this.state = new this.runtime.AnimationState(this.stateData);
                this.skeleton.updateWorldTransform(this.runtime.Physics?.update ?? 2);
                this._viewportBounds = this._readViewportBounds();
                this.loaded = true;

                const availableAnimations = this.animationNames();
                const requestedInitialAnimation = this.options.animationName
                    || this.manifest?.scenes?.[0]?.animation?.id
                    || this.manifest?.scenes?.[0]?.animationName
                    || availableAnimations[0];
                // Scene lists can outlive a skeleton revision.  Prefer the
                // requested scene when it exists, but keep the model usable
                // when that metadata points at a removed animation.
                const initialAnimation = availableAnimations.includes(requestedInitialAnimation)
                    ? requestedInitialAnimation
                    : availableAnimations[0];
                if (initialAnimation) {
                    this.selectAnimation(initialAnimation, {
                        loop: this.options.loop === true,
                        time: Number(this.options.time) || 0,
                        render: false,
                    });
                } else {
                    this._fitSkeleton();
                }
                if (this.options.renderOnLoad !== false) this.render();
                return this;
            } catch (error) {
                this.dispose();
                if (error instanceof SpineRendererError) throw error;
                throw new SpineRendererError(
                    `Spine 模板加载失败：${error?.message || error}`,
                    'load_failed',
                    { cause: error },
                );
            }
        }

        _rawPages = new Set();

        _registerRawPage(pageName, actualPath, atlasRoot, bytes) {
            const uri = bytesToDataUri(bytes, 'image/png');
            const expectedPath = joinPath(atlasRoot, pageName);
            this.assetManager.setRawDataURI(expectedPath, uri);
            this.assetManager.setRawDataURI(pageName, uri);
            if (actualPath) this.assetManager.setRawDataURI(actualPath, uri);
            this._rawPages.add(expectedPath);
        }

        _hasRawPage(path) {
            return this._rawPages.has(normalizePath(path));
        }

        animationNames() {
            return this.skeletonData?.animations?.map((animation) => animation.name) || [];
        }

        _readCharacterSkinSelections() {
            return Array.isArray(this.manifest?.character?.skins)
                ? this.manifest.character.skins
                    .filter((item) => item && item.group != null && item.value != null)
                    .map((item) => ({ group: String(item.group), value: String(item.value) }))
                : [];
        }

        _readCharacterSlotStyles() {
            return Array.isArray(this.manifest?.character?.slots)
                ? this.manifest.character.slots.map((item) => ({ ...item }))
                : [];
        }

        _readCharacterSliderValues() {
            return Array.isArray(this.manifest?.character?.sliders)
                ? this.manifest.character.sliders
                    .filter((item) => item && item.name != null)
                    .map((item) => ({ name: String(item.name), value: finiteOr(item.value, 1) }))
                : [];
        }

        _findCharacterSkin(selection, available) {
            const value = String(selection?.value || '').trim();
            if (!value) return null;
            const groupToken = normalizeSkinToken(selection?.group);
            const valueToken = normalizeSkinToken(value);
            const candidates = available
                .map((skin) => ({ skin, descriptor: skinDescriptor(skin?.name) }))
                .filter((item) => item.descriptor.valueToken === valueToken);
            if (!candidates.length) return null;
            candidates.sort((left, right) => {
                const leftGroup = left.descriptor.groupToken === groupToken ? 0 : 1;
                const rightGroup = right.descriptor.groupToken === groupToken ? 0 : 1;
                if (leftGroup !== rightGroup) return leftGroup - rightGroup;
                const leftPath = normalizeSkinToken(left.descriptor.path).includes(groupToken) ? 0 : 1;
                const rightPath = normalizeSkinToken(right.descriptor.path).includes(groupToken) ? 0 : 1;
                if (leftPath !== rightPath) return leftPath - rightPath;
                return String(left.skin?.name || '').length - String(right.skin?.name || '').length;
            });
            return candidates[0].skin || null;
        }

        _withRequiredSkinDefaults(selections, available) {
            const effective = Array.isArray(selections)
                ? selections.map((item) => ({ ...item }))
                : [];
            const selectedGroups = new Set(effective.map((item) => (
                normalizeSkinToken(item?.group)
            )).filter(Boolean));
            const defaults = new Map();

            // Paired-pigtail presets can store both pigtails explicitly while
            // leaving BackHair/SideHair absent. Those omitted groups are
            // intentional: EmoteLab shows the pigtails and front hair without
            // synthesizing a second rear-hair layer. Keep the compatibility
            // fallback for other models, but do not turn these groups back on
            // for this explicit paired-pigtail shape.
            const pairedPigtailsSelected = selectedGroups.has('pigtailleft')
                && selectedGroups.has('pigtailright');
            const suppressPairedPigtailRearHair = pairedPigtailsSelected
                && !selectedGroups.has('backhair')
                && !selectedGroups.has('sidehair');

            // EmoteLab Character files persist the user's choices, but can
            // omit groups that are still supplied by the model defaults.
            // CoffeeBean-derived models do this for Required Hand/Leg and
            // DefaultOn Ear and other model-authored groups: applying only
            // ActiveSkins can leave required attachments empty. Recover the
            // first model-authored option before combining skins, except for
            // the intentional paired-pigtail rear-hair omission above.
            for (const skin of available || []) {
                const descriptor = skinDescriptor(skin?.name);
                if (!/\[\s*(?:required|default\s*on)\s*\]/i.test(descriptor.group || '')) continue;
                const group = String(descriptor.group || '').replace(/\[[^\]]*\]/g, '').trim();
                const groupToken = normalizeSkinToken(group);
                if (!groupToken || !descriptor.value || selectedGroups.has(groupToken)) continue;
                if (suppressPairedPigtailRearHair
                    && (groupToken === 'backhair' || groupToken === 'sidehair')) {
                    continue;
                }
                if (!defaults.has(groupToken)) {
                    defaults.set(groupToken, { group, value: descriptor.value });
                }
            }

            effective.push(...defaults.values());
            return effective;
        }

        _applyCharacterSkins(selections = this._characterSkinSelections) {
            if (typeof this.runtime?.Skin !== 'function' || !this.skeletonData || !this.skeleton) return;
            const available = Array.isArray(this.skeletonData?.skins) ? this.skeletonData.skins : [];
            const characterSkins = this._withRequiredSkinDefaults(selections, available);
            const combined = new this.runtime.Skin('neko-emotelab-active');
            const defaultSkin = this.skeletonData?.findSkin?.('default');
            if (defaultSkin) combined.addSkin(defaultSkin);

            const missing = [];
            for (const selection of characterSkins) {
                const skin = this._findCharacterSkin(selection, available);
                if (!skin) {
                    missing.push(`${selection?.group || '?'}=${selection?.value || ''}`);
                    continue;
                }
                combined.addSkin(skin);
            }

            this.skeleton.setSkin(combined);
            if (typeof this.skeleton.setupPoseSlots === 'function') this.skeleton.setupPoseSlots();
            this.warnings = this.warnings.filter((warning) => !String(warning).startsWith('未找到 Character 皮肤：'));
            if (missing.length) this.warnings.push(`未找到 Character 皮肤：${missing.slice(0, 5).join(', ')}`);
            this._characterSkinCount = characterSkins.length - missing.length;
        }

        _applyCharacterSlotStyles() {
            if (!this.skeleton?.slots || typeof this.skeleton.findSlot !== 'function') return;
            const styles = Array.isArray(this._characterSlotStyles) ? this._characterSlotStyles : [];
            // SlotGroups in EmoteLab are logical tags written in brackets in
            // the Spine slot name (for example, `..._Color[HairBangLeft]`),
            // rather than the complete slot path. Index normalized names so
            // the package's tint defaults actually reach every tagged slot.
            const styleMap = new Map(styles
                .filter((style) => style?.name)
                .map((style) => [normalizeSkinToken(style.name), style]));
            for (const slot of this.skeleton.slots) {
                const setupPose = slot.data?.setupPose || slot.data || {};
                const colorPoses = this._slotColorPoses(slot);
                const setupColor = setupPose.color || slot.data?.color;
                const setupDarkColor = setupPose.darkColor || slot.data?.darkColor;
                for (const pose of colorPoses) {
                    if (setupColor && pose.color?.setFromColor) pose.color.setFromColor(setupColor);
                    if (setupDarkColor && pose.darkColor?.setFromColor) {
                        pose.darkColor.setFromColor(setupDarkColor);
                    }
                }
                const slotName = String(slot.data?.name || slot.name || '');
                const tagNames = [...slotName.matchAll(/\[([^\]]+)\]/g)].map((match) => match[1]);
                const style = [slotName, ...tagNames]
                    .map((name) => styleMap.get(normalizeSkinToken(name)))
                    .find(Boolean);
                if (!style) continue;
                const tint = style.tintColor;
                for (const pose of colorPoses) {
                    if (tint && pose.color?.set) {
                        pose.color.set(
                            finiteOr(tint.r, 0),
                            finiteOr(tint.g, 0),
                            finiteOr(tint.b, 0),
                            finiteOr(tint.a, 1),
                        );
                    }
                }
                const dark = style.tintBlackColor;
                for (const pose of colorPoses) {
                    if (dark && pose.darkColor?.set) {
                        pose.darkColor.set(
                            finiteOr(dark.r, 0),
                            finiteOr(dark.g, 0),
                            finiteOr(dark.b, 0),
                            finiteOr(dark.a, 1),
                        );
                    }
                }
            }
            this._applyGlobalColorMode();
        }

        _slotColorPoses(slot) {
            const poses = [];
            for (const candidate of [slot?.pose, slot?.appliedPose, slot]) {
                if (!candidate || typeof candidate !== 'object') continue;
                if (!candidate.color && !candidate.darkColor) continue;
                if (!poses.includes(candidate)) poses.push(candidate);
            }
            return poses;
        }

        _matchingSliderBones(name) {
            const raw = String(name || '').split('/').pop() || '';
            const match = raw.match(/^(.*)_(Length|Position|Distance|Height|Shear)$/i);
            if (!match) return { base: raw, property: '', bones: [] };
            const baseToken = normalizeSkinToken(match[1]);
            // EmoteLab's Character slider ids are authored against the
            // logical part name (for example, PigtailLeft), while the Spine
            // skeleton can split that part into named chains such as
            // PigtailA_Left1 and PigtailB_Left. Keep matching conservative,
            // but include the explicit A/B chain variants when a side is
            // present in the slider id.
            const baseVariants = new Set([baseToken]);
            const side = baseToken.match(/(left|right)$/);
            if (side) {
                const prefix = baseToken.slice(0, -side[1].length);
                baseVariants.add(`${prefix}a${side[1]}`);
                baseVariants.add(`${prefix}b${side[1]}`);
            }
            const bones = (this.skeleton?.data?.bones || this.skeletonData?.bones || [])
                .map((boneData) => this.skeleton?.findBone?.(boneData.name))
                .filter(Boolean)
                .filter((bone) => {
                    const token = normalizeSkinToken(bone.data?.name || bone.name);
                    return Array.from(baseVariants).some((variant) => (
                        token.startsWith(variant) || token.includes(variant)
                    ));
                });
            return { base: match[1], property: match[2].toLowerCase(), bones };
        }

        _sliderTargets(mapping) {
            if (!mapping?.property) return [];
            if (mapping.property === 'length') {
                return mapping.bones.filter((bone) => Number(bone.data?.length ?? bone.length) > 0);
            }
            if (mapping.property === 'position') {
                return mapping.bones.filter((bone) => {
                    const boneName = String(bone.data?.name || bone.name || '');
                    return /(?:1|origin)$/i.test(boneName);
                });
            }
            if (mapping.property === 'shear') return mapping.bones;
            // Distance/Height constraints need package-specific formulas; do
            // not claim that a name-only heuristic applied them.
            return [];
        }

        _nativeSliderConstraint(name) {
            const constraints = Array.isArray(this.skeleton?.constraints)
                ? this.skeleton.constraints
                : [];
            const requestedName = String(name || '').trim();
            if (!requestedName || !constraints.length) return null;
            const requestedToken = normalizeSkinToken(requestedName);
            const requestedBaseToken = normalizeSkinToken(requestedName.split('/').pop());
            const candidates = constraints.filter((constraint) => {
                const data = constraint?.data;
                const animation = data?.animation;
                const duration = Number(animation?.duration);
                return Boolean(
                    data?.name
                    && animation
                    && Number.isFinite(duration)
                    && duration >= 0
                    && constraint?.pose
                    && constraint?.appliedPose,
                );
            });
            const exact = candidates.find((constraint) => (
                String(constraint.data.name) === requestedName
                || normalizeSkinToken(constraint.data.name) === requestedToken
            ));
            const basenameMatches = exact ? [] : candidates.filter((constraint) => {
                const constraintBase = String(constraint.data.name).split('/').pop();
                return normalizeSkinToken(constraintBase) === requestedBaseToken;
            });
            const constraint = exact || (basenameMatches.length === 1 ? basenameMatches[0] : null);
            if (!constraint) return null;
            const animation = constraint.data.animation;
            const targetBones = animation?.bones == null ? [] : Array.from(animation.bones);
            return {
                constraint,
                duration: Math.max(0, Number(animation.duration) || 0),
                targetBones,
            };
        }

        _setNativeSliderValue(nativeSlider, value) {
            const constraint = nativeSlider?.constraint;
            if (!constraint) return null;
            // EmoteLab exposes Character sliders as a normalized 0..2 value.
            // Spine stores that range along the Slider constraint's animation
            // timeline.  The authored setup pose can be anywhere in the range;
            // sliderDefaultValue() exposes that authored point to the UI.
            const normalizedValue = Math.max(0, Math.min(2, finiteOr(value, 1)));
            const time = normalizedValue * nativeSlider.duration / 2;
            for (const pose of [constraint.pose, constraint.constrainedPose, constraint.appliedPose]) {
                if (pose && typeof pose === 'object') pose.time = time;
            }
            return time;
        }

        _applyCharacterSliders() {
            if (!this.skeleton || !Array.isArray(this._characterSliderValues)) return;
            const applied = [];
            const unsupported = [];
            const heuristic = [];
            for (const slider of this._characterSliderValues) {
                const nativeSlider = this._nativeSliderConstraint(slider.name);
                if (nativeSlider) {
                    this._setNativeSliderValue(nativeSlider, slider.value);
                    applied.push({
                        name: slider.name,
                        bones: nativeSlider.targetBones.length,
                        mode: 'native',
                    });
                    continue;
                }
                const mapping = this._matchingSliderBones(slider.name);
                const value = finiteOr(slider.value, 1);
                const targets = this._sliderTargets(mapping);
                if (!targets.length) {
                    unsupported.push(slider.name);
                    continue;
                }
                let changed = 0;
                for (const bone of targets) {
                    const pose = bone.pose;
                    // In Spine 4.3, Bone#setupPose is a compatibility getter
                    // with no local values. The authoritative transform is
                    // BoneData#setupPose, so use it as the baseline every
                    // time the animation state is reapplied.
                    const setup = bone.data?.setupPose || bone.setupPose;
                    if (!pose || !setup) continue;
                    if (mapping.property === 'length') {
                        pose.scaleX = finiteOr(setup.scaleX, 1) * value;
                        changed += 1;
                    } else if (mapping.property === 'position') {
                        pose.x = finiteOr(setup.x, 0) * value;
                        pose.y = finiteOr(setup.y, 0) * value;
                        changed += 1;
                    } else if (mapping.property === 'shear') {
                        pose.shearY = finiteOr(setup.shearY, 0) + ((value - 1) * 45);
                        changed += 1;
                    }
                }
                if (changed) {
                    applied.push({ name: slider.name, bones: changed, mode: 'heuristic' });
                    heuristic.push(slider.name);
                }
                else if (!unsupported.includes(slider.name)) unsupported.push(slider.name);
            }
            this._sliderApplications = applied;
            this.warnings = this.warnings.filter((warning) => (
                !String(warning).startsWith('部分 Character 滑杆未映射：')
                && !String(warning).startsWith('部分 Character 滑杆使用启发式映射：')
            ));
            if (heuristic.length) {
                this.warnings.push(`部分 Character 滑杆使用启发式映射：${heuristic.slice(0, 3).join(', ')}`);
            }
            if (unsupported.length) {
                this.warnings.push(`部分 Character 滑杆未映射：${unsupported.slice(0, 3).join(', ')}`);
            }
        }

        _colorObject(value, fallback = { r: 1, g: 1, b: 1, a: 1 }) {
            if (!value || typeof value !== 'object') return fallback;
            return {
                r: Math.max(0, Math.min(1, finiteOr(value.r, fallback.r))),
                g: Math.max(0, Math.min(1, finiteOr(value.g, fallback.g))),
                b: Math.max(0, Math.min(1, finiteOr(value.b, fallback.b))),
                a: Math.max(0, Math.min(1, finiteOr(value.a, fallback.a))),
            };
        }

        _applyGlobalColorMode() {
            const mode = this._colorMode || {};
            if (mode.mode === 'default' || !this.skeleton?.slots) return;
            const primary = this._colorObject(mode.primary);
            const secondary = this._colorObject(mode.secondary, { r: 0, g: 0, b: 0, a: 1 });
            for (const slot of this.skeleton.slots) {
                for (const pose of this._slotColorPoses(slot)) {
                    if (pose.color?.set) {
                        pose.color.set(
                            mode.mode === 'tint' ? primary.r : pose.color.r * primary.r,
                            mode.mode === 'tint' ? primary.g : pose.color.g * primary.g,
                            mode.mode === 'tint' ? primary.b : pose.color.b * primary.b,
                            pose.color.a * primary.a,
                        );
                    }
                    if (mode.mode === 'two-tone' && pose.darkColor?.set) {
                        pose.darkColor.set(secondary.r, secondary.g, secondary.b, secondary.a);
                    }
                }
            }
        }

        skinOptions() {
            const result = {};
            for (const skin of this.skeletonData?.skins || []) {
                const descriptor = skinDescriptor(skin?.name);
                if (!descriptor.group || !descriptor.value || descriptor.value === 'default') continue;
                const key = descriptor.groupToken || normalizeSkinToken(descriptor.group);
                if (!result[key]) result[key] = { group: descriptor.group.replace(/\[[^\]]*\]/g, ''), options: [] };
                if (!result[key].options.some((value) => normalizeSkinToken(value) === descriptor.valueToken)) {
                    result[key].options.push(descriptor.value);
                }
            }
            return result;
        }

        characterSkinSelections() {
            return this._characterSkinSelections.map((item) => ({ ...item }));
        }

        sliderStatus() {
            return Object.freeze({
                applied: this._sliderApplications.map((item) => ({ ...item })),
                configured: this._characterSliderValues.map((item) => ({ ...item })),
            });
        }

        sliderMapping(name) {
            const nativeSlider = this._nativeSliderConstraint(name);
            if (nativeSlider) {
                const raw = String(name || '').split('/').pop() || '';
                const match = raw.match(/^(.*)_(Length|Position|Distance|Height|Shear)$/i);
                return Object.freeze({
                    base: match?.[1] || raw,
                    property: match?.[2]?.toLowerCase() || '',
                    bones: nativeSlider.targetBones.length,
                    targets: nativeSlider.targetBones.length,
                    supported: true,
                mode: 'native',
            });
            }
            const mapping = this._matchingSliderBones(name);
            const targets = this._sliderTargets(mapping);
            return Object.freeze({
                base: mapping.base,
                property: mapping.property,
                bones: mapping.bones.length,
                targets: targets.length,
                supported: targets.length > 0,
                mode: targets.length > 0 ? 'heuristic' : 'unsupported',
            });
        }

        sliderDefaultValue(name) {
            const nativeSlider = this._nativeSliderConstraint(name);
            if (!nativeSlider || !(nativeSlider.duration > 0)) return null;
            const setupTime = finiteOr(nativeSlider.constraint?.data?.setupPose?.time, NaN);
            if (!Number.isFinite(setupTime)) return null;
            return Math.max(0, Math.min(2, setupTime * 2 / nativeSlider.duration));
        }

        setCharacterState(next = {}, options = {}) {
            this._assertLive();
            if (Array.isArray(next.skins)) {
                this._characterSkinSelections = next.skins.map((item) => ({
                    group: String(item?.group || ''),
                    value: String(item?.value || ''),
                })).filter((item) => item.group && item.value);
                this.manifest.character = { ...(this.manifest.character || {}), skins: this._characterSkinSelections };
                this._applyCharacterSkins();
            }
            if (Array.isArray(next.sliders)) {
                this._characterSliderValues = next.sliders.map((item) => ({
                    name: String(item?.name || ''),
                    value: finiteOr(item?.value, 1),
                })).filter((item) => item.name);
                this.manifest.character = { ...(this.manifest.character || {}), sliders: this._characterSliderValues };
            }
            if (Array.isArray(next.slots)) {
                this._characterSlotStyles = next.slots.map((item) => ({ ...item }));
                this.manifest.character = { ...(this.manifest.character || {}), slots: this._characterSlotStyles };
            }
            if (next.colorMode) this._colorMode = { ...this._colorMode, ...next.colorMode };
            this._applyPose(0);
            if (options.render !== false) this.render();
            return this.status();
        }

        animations() {
            return this.skeletonData?.animations?.map((animation) => ({
                name: animation.name,
                duration: Number(animation.duration) || 0,
            })) || [];
        }

        selectAnimation(name, options = {}) {
            this._assertLive();
            if (!this.loaded || !this.state || !this.skeletonData) {
                throw new SpineRendererError('Spine 模板尚未加载', 'not_loaded');
            }
            const animationName = String(name || '');
            const animation = this.skeletonData.findAnimation(animationName);
            if (!animation) {
                throw new SpineRendererError(`找不到 Spine 动画：${animationName}`, 'animation_not_found');
            }
            this.state.clearTracks();
            // EmoteLab treats every scene preview as an independent pose.
            // AnimationState only writes properties keyed by the incoming
            // animation, so attachments/bones keyed by the previous scene
            // can otherwise remain on the skeleton (for example Alert-Bits
            // stickers persisting after switching to Angry). Reset the
            // authored setup pose before applying the new track. Spine 4.3's
            // JavaScript runtime calls this method setupPose(); a few older
            // compatible runtimes expose setToSetupPose() or only the two
            // granular setupPoseBones()/setupPoseSlots() methods, so keep
            // those fallbacks as well.
            if (typeof this.skeleton.setupPose === 'function') {
                this.skeleton.setupPose();
            } else if (typeof this.skeleton.setToSetupPose === 'function') {
                this.skeleton.setToSetupPose();
            } else {
                if (typeof this.skeleton.setupPoseBones === 'function') {
                    this.skeleton.setupPoseBones();
                } else {
                    this.skeleton.setBonesToSetupPose?.();
                }
                if (typeof this.skeleton.setupPoseSlots === 'function') {
                    this.skeleton.setupPoseSlots();
                } else {
                    this.skeleton.setSlotsToSetupPose?.();
                }
            }
            const entry = this.state.setAnimation(0, animationName, options.loop === true);
            const duration = Number(animation.duration) || 0;
            entry.trackTime = Math.max(0, Number(options.time) || 0);
            if (!entry.loop && duration > 0) entry.trackTime = Math.min(entry.trackTime, duration);
            this.currentAnimation = animationName;
            this.playing = options.autoplay === true;
            this._applyPose(0);
            if (options.render !== false) this.render();
            return Object.freeze({
                name: animationName,
                duration,
                loop: Boolean(entry.loop),
                time: entry.trackTime,
                playing: this.playing,
            });
        }

        setTime(time, options = {}) {
            this._assertLive();
            const entry = this.state?.getTrack?.(0);
            if (!entry) throw new SpineRendererError('尚未选择 Spine 动画', 'animation_not_selected');
            const duration = Number(entry.animation?.duration) || 0;
            let nextTime = Math.max(0, Number(time) || 0);
            if (!entry.loop && duration > 0) nextTime = Math.min(nextTime, duration);
            entry.trackTime = nextTime;
            this._applyPose(0);
            if (options.render !== false) this.render();
            return nextTime;
        }

        play(name, options = {}) {
            this._assertLive();
            if (name != null && name !== this.currentAnimation) {
                this.selectAnimation(name, { ...options, autoplay: true });
            } else {
                this.playing = true;
            }
            return this.playing;
        }

        pause() {
            this._assertLive();
            this.playing = false;
            return this.playing;
        }

        _applyPose(deltaSeconds) {
            if (!this.state || !this.skeleton) return;
            // 先把上一帧加上的编辑器旋转拿掉，动画混合才不会拿那个角度当起点。
            this._restoreRootRotationBasis();
            if (deltaSeconds > 0) this.state.update(deltaSeconds);
            this.state.apply(this.skeleton);
            this._applyCharacterSlotStyles();
            this._applyCharacterSliders();
            this.skeleton.updateWorldTransform(this.runtime.Physics?.update ?? 2);
            this._captureRootRotationBasis();
        }

        _rootAppliedPose() {
            const root = this.skeleton?.getRootBone?.();
            if (!root) return null;
            return root.appliedPose || root.pose || null;
        }

        _captureRootRotationBasis() {
            const pose = this._rootAppliedPose();
            if (!pose || typeof pose.rotation !== 'number') return;
            this._rootRotationBasis = pose.rotation;
        }

        _restoreRootRotationBasis() {
            const pose = this._rootAppliedPose();
            if (!pose || typeof this._rootRotationBasis !== 'number') return;
            pose.rotation = this._rootRotationBasis;
        }

        // Skeleton.x / scaleX 会进绘制，rotation 不会。角度加在根骨骼的本地旋转上，
        // 整棵骨架绕根骨转。同一帧里相机会套两次，第二次必须还是同一个角度。
        _applyEditorRotation() {
            const degrees = finiteOr(this._sceneTransform?.rotation, 0);
            if (this.skeleton) this.skeleton.rotation = degrees;
            const pose = this._rootAppliedPose();
            if (!pose || typeof pose.rotation !== 'number'
                || typeof this.skeleton.updateWorldTransform !== 'function') return;
            if (typeof this._rootRotationBasis !== 'number') {
                if (degrees === 0) return;
                this._rootRotationBasis = pose.rotation;
            }
            const next = this._rootRotationBasis + degrees;
            if (pose.rotation === next && this._editorRotationApplied === degrees) return;
            pose.rotation = next;
            this._editorRotationApplied = degrees;
            this.skeleton.updateWorldTransform(this.runtime?.Physics?.update ?? 2);
        }

        tick(deltaSeconds = 1 / 60, options = {}) {
            this._assertLive();
            if (!this.loaded) throw new SpineRendererError('Spine 模板尚未加载', 'not_loaded');
            const delta = Math.max(0, Math.min(Number(deltaSeconds) || 0, 0.25));
            if (this.playing) this._applyPose(delta);
            if (options.render !== false) this.render();
            const entry = this.state?.getTrack?.(0);
            return Object.freeze({
                animation: this.currentAnimation,
                time: Number(entry?.trackTime) || 0,
                playing: this.playing,
                delta,
            });
        }

        _resizeCanvas() {
            // The canvas is responsive through CSS. Do not derive its
            // intrinsic bitmap from clientWidth/clientHeight: the editor's
            // three-column layout is rectangular, while an EmoteLab emote
            // and its PNG export are square. Resizing from CSS dimensions
            // would silently turn a 1024x1024 export into a wide thumbnail.
            const renderWidth = asPositiveNumber(
                this.options.renderWidth,
                asPositiveNumber(this.options.width, asPositiveNumber(this.canvas.width, 1024)),
            );
            const renderHeight = asPositiveNumber(
                this.options.renderHeight,
                asPositiveNumber(this.options.height, asPositiveNumber(this.canvas.height, renderWidth)),
            );
            const dpr = asPositiveNumber(
                this.options.devicePixelRatio,
                1,
            );
            const width = Math.max(1, Math.round(renderWidth * dpr));
            const height = Math.max(1, Math.round(renderHeight * dpr));
            if (this.canvas.width !== width) this.canvas.width = width;
            if (this.canvas.height !== height) this.canvas.height = height;
            // Spine's SceneRenderer.resize() intentionally follows the CSS
            // client rectangle and would undo the square export dimensions
            // above. Drive its camera/viewport directly instead.
            if (this.renderer?.camera?.setViewport) {
                this.renderer.camera.setViewport(width, height);
                this.renderer.camera.update?.();
            } else if (typeof this.renderer?.resize === 'function') {
                // Compatibility fallback for an older runtime without an
                // exposed camera viewport API. Restore our bitmap dimensions
                // after its responsive resize call.
                this.renderer.resize(1);
                if (this.canvas.width !== width) this.canvas.width = width;
                if (this.canvas.height !== height) this.canvas.height = height;
            }
            if (typeof this.gl?.viewport === 'function') this.gl.viewport(0, 0, width, height);
            return { width, height };
        }

        _readViewportBounds() {
            const slots = Array.isArray(this.skeleton?.slots) ? this.skeleton.slots : [];
            const isViewportName = (value) => {
                const name = String(value || '').trim().toLocaleLowerCase();
                return name === 'viewport' || name.endsWith('/viewport') || name.includes('[viewport]');
            };
            const viewportSlot = slots.find((slot) => {
                const name = String(slot?.data?.name || slot?.name || '').trim().toLocaleLowerCase();
                return isViewportName(name);
            });
            const candidates = [];
            const seen = new Set();
            const addCandidate = (slot, attachment) => {
                if (!slot || !attachment || typeof attachment.computeWorldVertices !== 'function') return;
                if (seen.has(attachment)) return;
                seen.add(attachment);
                candidates.push({ slot, attachment });
            };
            const activeAttachment = viewportSlot?.pose?.attachment
                || viewportSlot?.appliedPose?.attachment
                || viewportSlot?.attachment
                || viewportSlot?.getAttachment?.();
            // Prefer the attachment currently posed on the named slot. This
            // preserves the usual path while allowing an inactive skin's
            // VIEWPORT placeholder to be found below when no active one is
            // present.
            addCandidate(viewportSlot, activeAttachment);

            // EmoteLab's Unity loader scans every Skin.SkinEntry rather than
            // only the active skin. Spine 4.3 JS stores those entries as an
            // array indexed by slot, with a placeholder->attachment object;
            // older runtimes expose SkinEntry-like records instead. Mirror
            // both layouts so templates remain compatible when VIEWPORT is
            // hidden behind a skin selection.
            const skinSources = [
                this.skeleton?.data?.skins,
                this.skeletonData?.data?.skins,
                this.skeletonData?.skins,
            ];
            const skins = [];
            const seenSkinLists = new Set();
            for (const source of skinSources) {
                if (!Array.isArray(source) || seenSkinLists.has(source)) continue;
                seenSkinLists.add(source);
                skins.push(...source);
            }
            for (const skin of skins) {
                const attachments = skin?.attachments;
                if (Array.isArray(attachments)) {
                    attachments.forEach((entry, slotIndex) => {
                        if (!entry) return;
                        const slot = slots[slotIndex];
                        const entryAttachment = entry.attachment || entry.Attachment;
                        const entryName = entry.name || entry.placeholder || entry.Name || entry.Placeholder;
                        const entrySlotIndex = Number.isInteger(entry.slotIndex)
                            ? entry.slotIndex
                            : (Number.isInteger(entry.SlotIndex) ? entry.SlotIndex : slotIndex);
                        if (entryAttachment && (entryName || Number.isFinite(entrySlotIndex))) {
                            if (isViewportName(entryName)) {
                                addCandidate(slots[entrySlotIndex], entryAttachment);
                            }
                            return;
                        }
                        const entries = typeof Map !== 'undefined' && entry instanceof Map
                            ? entry.entries()
                            : Object.entries(entry);
                        for (const [name, attachment] of entries) {
                            if (isViewportName(name)) addCandidate(slot, attachment);
                        }
                    });
                } else if (attachments && typeof attachments === 'object') {
                    for (const [slotKey, entry] of Object.entries(attachments)) {
                        const numericSlotIndex = Number(slotKey);
                        const slotIndex = Number.isInteger(numericSlotIndex) ? numericSlotIndex : -1;
                        const slot = slotIndex >= 0 ? slots[slotIndex] : null;
                        const entryAttachment = entry?.attachment || entry?.Attachment;
                        const entryName = entry?.name || entry?.placeholder || entry?.Name || entry?.Placeholder;
                        const entrySlotIndex = Number.isInteger(entry?.slotIndex)
                            ? entry.slotIndex
                            : (Number.isInteger(entry?.SlotIndex) ? entry.SlotIndex : slotIndex);
                        if (entryAttachment && (entryName || Number.isFinite(entrySlotIndex))) {
                            if (isViewportName(entryName)) {
                                addCandidate(slots[entrySlotIndex], entryAttachment);
                            }
                            continue;
                        }
                        const entries = typeof Map !== 'undefined' && entry instanceof Map
                            ? entry.entries()
                            : Object.entries(entry || {});
                        for (const [name, attachment] of entries) {
                            if (isViewportName(name)) addCandidate(slot, attachment);
                        }
                    }
                }
                // Some Spine runtimes only expose getAttachment(). It is
                // cheap to probe the known slot range and avoids depending on
                // their internal Skin.attachments representation.
                if (typeof skin?.getAttachment === 'function') {
                    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
                        try {
                            addCandidate(slots[slotIndex], skin.getAttachment(slotIndex, 'VIEWPORT'));
                        } catch (_) {
                            // A malformed/legacy skin should not prevent a
                            // later skin or drawable-bounds fallback.
                        }
                    }
                }
            }

            for (const { slot, attachment } of candidates) {
                const count = Math.floor(Number(attachment.worldVerticesLength)
                    || (Array.isArray(attachment.vertices) || ArrayBuffer.isView(attachment.vertices)
                        ? attachment.vertices.length
                        : 0));
                if (count < 4 || count % 2 !== 0) continue;
                const vertices = new Float32Array(count);
                const computeWorldVertices = attachment.computeWorldVertices;
                const invokeSpine43 = () => computeWorldVertices.call(
                    attachment,
                    this.skeleton,
                    slot,
                    0,
                    count,
                    vertices,
                    0,
                    2,
                );
                const invokeLegacy = () => computeWorldVertices.call(
                    attachment,
                    slot,
                    0,
                    count,
                    vertices,
                    0,
                    2,
                );
                try {
                    // Spine 4.3: (skeleton, slot, start, count, out,
                    // offset, stride). A few older compatible runtimes omit
                    // the first skeleton argument, so retain a guarded
                    // fallback. Use declared arity when available; an older
                    // six-argument implementation can otherwise accept the
                    // extra argument and silently write invalid coordinates.
                    if (computeWorldVertices.length > 0 && computeWorldVertices.length < 7) {
                        invokeLegacy();
                    } else {
                        invokeSpine43();
                    }
                } catch (_) {
                    try {
                        vertices.fill(0);
                        if (computeWorldVertices.length > 0 && computeWorldVertices.length < 7) {
                            invokeSpine43();
                        } else {
                            invokeLegacy();
                        }
                    } catch (_) {
                        continue;
                    }
                }
                let minX = Infinity;
                let minY = Infinity;
                let maxX = -Infinity;
                let maxY = -Infinity;
                for (let index = 0; index < count; index += 2) {
                    const x = Number(vertices[index]);
                    const y = Number(vertices[index + 1]);
                    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    maxX = Math.max(maxX, x);
                    maxY = Math.max(maxY, y);
                }
                if (!Number.isFinite(minX) || !Number.isFinite(minY)
                    || !Number.isFinite(maxX) || !Number.isFinite(maxY)
                    || maxX <= minX || maxY <= minY) continue;
                return {
                    minX,
                    minY,
                    maxX,
                    maxY,
                    width: maxX - minX,
                    height: maxY - minY,
                    centerX: (minX + maxX) / 2,
                    centerY: (minY + maxY) / 2,
                };
            }
            return null;
        }

        _readDrawableBounds() {
            if (!this.skeleton || typeof this.skeleton.getBounds !== 'function') return null;
            const Vector2 = this.runtime?.Vector2;
            // Spine exposes Vector2, but a few embedders provide a compatible
            // Skeleton without exporting that constructor.  getBounds only
            // needs mutable x/y fields, so plain records are a safe fallback.
            const offset = typeof Vector2 === 'function' ? new Vector2(0, 0) : { x: 0, y: 0 };
            const size = typeof Vector2 === 'function' ? new Vector2(0, 0) : { x: 0, y: 0 };
            try {
                this.skeleton.getBounds(offset, size);
            } catch (_) {
                return null;
            }
            const minX = Number(offset.x);
            const minY = Number(offset.y);
            const width = Number(size.x);
            const height = Number(size.y);
            if (![minX, minY, width, height].every(Number.isFinite)
                || width <= 0 || height <= 0) return null;
            return {
                minX,
                minY,
                maxX: minX + width,
                maxY: minY + height,
                width,
                height,
                centerX: minX + width / 2,
                centerY: minY + height / 2,
                source: 'skeleton-bounds',
            };
        }

        _usesEmoteLabCameraUnits() {
            return this._referenceScale > 1
                && Array.isArray(this.manifest?.scenes)
                && this.manifest.scenes.some((scene) => scene?.camera);
        }

        _fitSkeleton() {
            if (!this.skeleton || !this.renderer?.camera || typeof this.skeleton.getBounds !== 'function') return;
            const viewportWidth = asPositiveNumber(this.renderer.camera.viewportWidth, 1);
            const viewportHeight = asPositiveNumber(this.renderer.camera.viewportHeight, 1);
            if (this._usesEmoteLabCameraUnits()) {
                // EmoteLab's Unity scene is authored in model units while
                // Spine keeps the authored coordinates at referenceScale
                // (YUI uses 100). OrthoCamera.zoom is world-units per output
                // pixel, so the scene's vertical span maps directly here.
                this.skeleton.x = 0;
                this.skeleton.y = 0;
                this.skeleton.scaleX = 1;
                this.skeleton.scaleY = 1;
                this.skeleton.rotation = 0;
                const bounds = this._viewportBounds || this._readDrawableBounds();
                this._baseFit = {
                    viewportWidth,
                    viewportHeight,
                    x: 0,
                    y: 0,
                    scaleX: 1,
                    scaleY: 1,
                    rotation: 0,
                    zoom: 1,
                    width: bounds?.width || 0,
                    height: bounds?.height || 0,
                    boundsSource: this._viewportBounds
                        ? 'viewport-bounding-box'
                        : (bounds ? 'skeleton-bounds' : 'none'),
                    calibrated: true,
                };
                this._applySceneCamera();
                return;
            }
            if (this._baseFit
                && this._baseFit.viewportWidth === viewportWidth
                && this._baseFit.viewportHeight === viewportHeight) {
                this.skeleton.x = this._baseFit.x;
                this.skeleton.y = this._baseFit.y;
                this.skeleton.scaleX = this._baseFit.scaleX;
                this.skeleton.scaleY = this._baseFit.scaleY;
                this.skeleton.rotation = this._baseFit.rotation;
                this.renderer.camera.zoom = this._baseFit.zoom;
                this._applySceneCamera();
                return;
            }
            // Measure the untransformed skeleton. Scene transforms and the
            // editor's adjustment controls are applied after this baseline.
            this.skeleton.x = 0;
            this.skeleton.y = 0;
            this.skeleton.scaleX = 1;
            this.skeleton.scaleY = 1;
            this.skeleton.rotation = 0;
            const bounds = this._viewportBounds || this._readDrawableBounds();
            const width = asPositiveNumber(bounds?.width, 1);
            const height = asPositiveNumber(bounds?.height, 1);
            const padding = asPositiveNumber(this.options.fitPadding, 1.1);
            const zoom = Math.max(width / viewportWidth, height / viewportHeight) * padding;
            this._baseFit = {
                viewportWidth,
                viewportHeight,
                x: -(Number(bounds?.minX || 0) + width / 2),
                y: -(Number(bounds?.minY || 0) + height / 2),
                scaleX: 1,
                scaleY: 1,
                rotation: 0,
                zoom,
                width,
                height,
                boundsSource: this._viewportBounds
                    ? 'viewport-bounding-box'
                    : (bounds ? 'skeleton-bounds' : 'fallback'),
            };
            this.skeleton.x = this._baseFit.x;
            this.skeleton.y = this._baseFit.y;
            this.renderer.camera.zoom = zoom;
            this._applySceneCamera();
        }

        _sceneCameraBaseline() {
            const first = Array.isArray(this.manifest?.scenes) ? this.manifest.scenes[0] : null;
            const camera = first?.camera || {};
            return {
                position: Array.isArray(camera.position) ? camera.position : [0, 0, 0],
                orthographicSize: Math.max(0.001, finiteOr(camera.orthographicSize, 1)),
            };
        }

        _applySceneCamera() {
            if (!this.renderer?.camera || !this._baseFit) return;
            const scene = this._scene || this.manifest?.scenes?.[0] || null;
            const camera = scene?.camera || {};
            const baseline = this._sceneCameraBaseline();
            const position = Array.isArray(camera.position) ? camera.position : baseline.position;
            const orthographicSize = Math.max(0.001, finiteOr(camera.orthographicSize, baseline.orthographicSize));
            if (this._baseFit.calibrated) {
                const referenceScale = Math.max(0.0001, this._referenceScale);
                const viewportHeight = asPositiveNumber(this.renderer.camera.viewportHeight, 1);
                this.renderer.camera.zoom = (orthographicSize * 2 * referenceScale) / viewportHeight;
                // Keep z on Spine's 2D view plane. Unity's z value selects a
                // depth slice for these scenes; copying it would move the
                // model outside the runtime's default near/far range.
                const editorWorldUnit = this.renderer.camera.zoom * viewportHeight / 1000;
                const editorTransform = this._sceneTransform || {};
                const cameraX = finiteOr(position[0], 0) * referenceScale;
                const cameraY = finiteOr(position[1], 0) * referenceScale;
                const offsetX = finiteOr(editorTransform.x, 0) * editorWorldUnit;
                const offsetY = finiteOr(editorTransform.y, 0) * editorWorldUnit;
                if (this.renderer.camera.position?.set) {
                    this.renderer.camera.position.set(cameraX - offsetX, cameraY + offsetY, 0);
                } else if (this.renderer.camera.position) {
                    this.renderer.camera.position.x = cameraX - offsetX;
                    this.renderer.camera.position.y = cameraY + offsetY;
                    this.renderer.camera.position.z = 0;
                }
                const rotation = Array.isArray(camera.rotation)
                    ? camera.rotation
                    : [0, 0, 0, 1];
                const direction = rotateVectorByQuaternion([0, 0, -1], rotation);
                const up = rotateVectorByQuaternion([0, 1, 0], rotation);
                if (this.renderer.camera.direction?.set) this.renderer.camera.direction.set(...direction);
                if (this.renderer.camera.up?.set) this.renderer.camera.up.set(...up);
                const model = scene?.model || {};
                const transform = this._sceneTransform || {};
                const scale = Math.max(0.01, finiteOr(transform.scale, 1));
                this.skeleton.x = 0;
                this.skeleton.y = 0;
                this.skeleton.scaleX = (model.mirrored ? -1 : 1) * scale;
                this.skeleton.scaleY = scale;
                this.skeleton.visible = model.visible !== false;
                this._applyEditorRotation();
                this.renderer.camera.update();
                return;
            }
            const ratio = orthographicSize / baseline.orthographicSize;
            this.renderer.camera.zoom = this._baseFit.zoom * ratio;
            const modelUnitsPerSceneUnit = this._baseFit.height / Math.max(0.001, baseline.orthographicSize * 2);
            const dx = (finiteOr(position[0], baseline.position[0]) - finiteOr(baseline.position[0], 0)) * modelUnitsPerSceneUnit;
            const dy = (finiteOr(position[1], baseline.position[1]) - finiteOr(baseline.position[1], 0)) * modelUnitsPerSceneUnit;
            if (this.renderer.camera.position?.set) {
                this.renderer.camera.position.set(dx, dy, 0);
            } else if (this.renderer.camera.position) {
                this.renderer.camera.position.x = dx;
                this.renderer.camera.position.y = dy;
                this.renderer.camera.position.z = 0;
            }
            // SceneList stores Unity-style camera quaternions.  OrthoCamera
            // exposes direction/up vectors rather than a rotation property,
            // so apply the quaternion to its canonical -Z/+Y basis when the
            // runtime provides mutable vectors.  Identity (the common YUI
            // case) naturally restores the default orientation.
            const rotation = Array.isArray(camera.rotation)
                ? camera.rotation
                : [0, 0, 0, 1];
            const direction = rotateVectorByQuaternion([0, 0, -1], rotation);
            const up = rotateVectorByQuaternion([0, 1, 0], rotation);
            if (this.renderer.camera.direction?.set) {
                this.renderer.camera.direction.set(...direction);
            }
            if (this.renderer.camera.up?.set) {
                this.renderer.camera.up.set(...up);
            }
            const model = scene?.model || {};
            const transform = this._sceneTransform || {};
            const uiUnit = Math.max(0.001, this._baseFit.height / 1000);
            this.skeleton.x = this._baseFit.x + finiteOr(transform.x, 0) * uiUnit;
            this.skeleton.y = this._baseFit.y + finiteOr(transform.y, 0) * uiUnit;
            const scale = Math.max(0.01, finiteOr(transform.scale, 1));
            const mirror = model.mirrored ? -1 : 1;
            this.skeleton.scaleX = mirror * scale;
            this.skeleton.scaleY = scale;
            this.skeleton.visible = model.visible !== false;
            this._applyEditorRotation();
            this.renderer.camera.update();
        }

        setScene(scene, options = {}) {
            this._assertLive();
            this._scene = scene && typeof scene === 'object' ? scene : null;
            if (options.render !== false && this.loaded) this.render();
            return this._scene;
        }

        setTransform(transform = {}, options = {}) {
            this._assertLive();
            this._sceneTransform = {
                x: finiteOr(transform.x, 0),
                y: finiteOr(transform.y, 0),
                rotation: finiteOr(transform.rotation, 0),
                scale: Math.max(0.01, finiteOr(transform.scale, 1)),
            };
            if (options.render !== false && this.loaded) this.render();
            return { ...this._sceneTransform };
        }

        setColorMode(colorMode = {}, options = {}) {
            this._assertLive();
            this._colorMode = {
                mode: String(colorMode.mode || 'default'),
                primary: colorMode.primary || null,
                secondary: colorMode.secondary || null,
            };
            if (this.loaded) this._applyPose(0);
            if (options.render !== false && this.loaded) this.render();
            return { ...this._colorMode };
        }

        setBackground(color, options = {}) {
            this._assertLive();
            this._background = Array.isArray(color) ? color.slice(0, 4) : [...DEFAULT_BACKGROUND];
            if (options.render !== false && this.loaded) this.render();
            return [...this._background];
        }

        render(options = {}) {
            this._assertLive();
            if (!this.loaded || !this.renderer || !this.gl) {
                throw new SpineRendererError('Spine 模板尚未加载', 'not_loaded');
            }
            const viewport = this._resizeCanvas();
            if (options.fit !== false && this.options.autoFit !== false) this._fitSkeleton();
            this._applySceneCamera();
            clearColor(this.gl, options.background || this._background || this.options.background || DEFAULT_BACKGROUND);
            this.renderer.begin();
            if (this.skeleton.visible !== false) {
                // EmoteLab's WeightTransfer attachments are real custom
                // clothing/accessory artwork (not disposable helpers). They
                // must remain in the draw list; setupPose() on animation
                // switches is what prevents a previous scene from leaving
                // them at a stale/root-offset position.
                this.renderer.drawSkeleton(
                    this.skeleton,
                    Number.isFinite(options.startSlot) ? options.startSlot : -1,
                    Number.isFinite(options.endSlot) ? options.endSlot : -1,
                );
            }
            this.renderer.end();
            return Object.freeze({
                width: viewport.width,
                height: viewport.height,
                animation: this.currentAnimation,
                time: Number(this.state?.getTrack?.(0)?.trackTime) || 0,
                visible: this.skeleton.visible !== false,
            });
        }

        captureFrame(options = {}) {
            this._assertLive();
            if (!this.loaded || !this.gl || !this.canvas) {
                throw new SpineRendererError('Spine 模板尚未加载', 'not_loaded');
            }
            if (options.render !== false) this.render(options.renderOptions || {});
            const width = Math.max(1, Math.round(Number(this.canvas.width) || 0));
            const height = Math.max(1, Math.round(Number(this.canvas.height) || 0));
            if (typeof this.gl.readPixels !== 'function') {
                throw new SpineRendererError('当前 WebGL 运行时不支持读取帧像素', 'pixel_readback_unavailable');
            }
            const raw = new Uint8Array(width * height * 4);
            const rgba = this.gl.RGBA ?? 0x1908;
            const unsignedByte = this.gl.UNSIGNED_BYTE ?? 0x1401;
            this.gl.readPixels(0, 0, width, height, rgba, unsignedByte, raw);
            // WebGL's origin is bottom-left while ImageData/GIF use a
            // top-left origin.  Return a normal ImageData-like object so the
            // caller does not need to know which renderer produced the frame.
            const data = new Uint8ClampedArray(raw.length);
            const rowBytes = width * 4;
            for (let row = 0; row < height; row += 1) {
                const sourceOffset = (height - row - 1) * rowBytes;
                data.set(raw.subarray(sourceOffset, sourceOffset + rowBytes), row * rowBytes);
            }
            const maxDimension = Number(options.maxDimension);
            const requestedWidth = Number(options.width);
            const requestedHeight = Number(options.height);
            let outputWidth = Number.isFinite(requestedWidth) && requestedWidth > 0
                ? Math.round(requestedWidth)
                : width;
            let outputHeight = Number.isFinite(requestedHeight) && requestedHeight > 0
                ? Math.round(requestedHeight)
                : height;
            if (Number.isFinite(maxDimension) && maxDimension > 0) {
                const scale = Math.min(1, maxDimension / Math.max(outputWidth, outputHeight));
                outputWidth = Math.max(1, Math.round(outputWidth * scale));
                outputHeight = Math.max(1, Math.round(outputHeight * scale));
            }
            if (outputWidth === width && outputHeight === height) {
                return Object.freeze({ width, height, data });
            }
            const scaled = new Uint8ClampedArray(outputWidth * outputHeight * 4);
            for (let y = 0; y < outputHeight; y += 1) {
                const sourceY = Math.min(height - 1, Math.floor(y * height / outputHeight));
                for (let x = 0; x < outputWidth; x += 1) {
                    const sourceX = Math.min(width - 1, Math.floor(x * width / outputWidth));
                    const sourceOffset = (sourceY * width + sourceX) * 4;
                    const targetOffset = (y * outputWidth + x) * 4;
                    scaled[targetOffset] = data[sourceOffset];
                    scaled[targetOffset + 1] = data[sourceOffset + 1];
                    scaled[targetOffset + 2] = data[sourceOffset + 2];
                    scaled[targetOffset + 3] = data[sourceOffset + 3];
                }
            }
            return Object.freeze({ width: outputWidth, height: outputHeight, data: scaled });
        }

        status() {
            const runtimeVersion = this.runtime?.version
                || this.options.runtimeVersion
                || DEFAULT_RUNTIME_VERSION;
            return Object.freeze({
                loaded: this.loaded,
                disposed: this.disposed,
                playing: this.playing,
                animation: this.currentAnimation,
                runtimeVersion,
                packageVersion: this.manifest?.source?.spineVersion
                    || this._modelInfo?.skeleton?.spineVersion
                    || null,
                warnings: Object.freeze([...this.warnings]),
                animationCount: this.animationNames().length,
                skinCount: this._characterSkinCount || 0,
                sliderApplications: this._sliderApplications.length,
                cameraMode: this._baseFit?.calibrated ? 'emotelab-reference-scale' : 'fit-to-skeleton',
                referenceScale: this._referenceScale,
                sceneId: this._scene?.id || null,
                sceneVisible: this.skeleton?.visible !== false,
                sceneMirrored: Boolean(this._scene?.model?.mirrored),
            });
        }

        dispose() {
            if (this.disposed) return;
            this.playing = false;
            try { this.assetManager?.dispose?.(); } catch (_) { /* best effort */ }
            try { this.renderer?.dispose?.(); } catch (_) { /* best effort */ }
            try { this.context?.dispose?.(); } catch (_) { /* best effort */ }
            this.assetManager = null;
            this.renderer = null;
            this.context = null;
            this.gl = null;
            this.atlas = null;
            this.skeletonData = null;
            this.skeleton = null;
            this.stateData = null;
            this.state = null;
            this._baseFit = null;
            this._referenceScale = 1;
            this._viewportBounds = null;
            this._scene = null;
            this._sliderApplications = [];
            this.loaded = false;
            this.disposed = true;
        }
    }

    return Object.freeze({
        SpineRenderer,
        SpineRendererError,
        create: (options) => SpineRenderer.create(options),
        ensureRuntime,
        extractAtlasPageNames,
        normalizePath,
        constants: Object.freeze({
            DEFAULT_RUNTIME_VERSION,
            REQUIRED_RUNTIME_SYMBOLS,
        }),
    });
}));
