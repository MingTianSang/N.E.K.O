/*
 * emote_template_directory.js
 *
 * Turns a user-selected template directory into the same in-memory ZIP
 * transport used by the package importer.  The UI intentionally does not
 * expose a provider name: a directory is just another template source and
 * the server-side adapter decides which compatible provider can read it.
 */
(function (root, factory) {
    'use strict';

    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('../libs/fflate.umd.js'));
    } else {
        root.NekoEmoteTemplateDirectory = factory(root.fflate);
    }
}(typeof self !== 'undefined' ? self : this, function (fflate) {
    'use strict';

    const MAX_FILES = 5000;
    const MAX_TOTAL_BYTES = 512 * 1024 * 1024;
    const MAX_SINGLE_FILE_BYTES = 128 * 1024 * 1024;
    const IGNORED_SEGMENTS = new Set(['history', 'historical', 'backup', 'backups', 'export', '历史版本']);
    const ALLOWED_SUFFIXES = [
        '.json',
        '.csv',
        '.atlas.txt',
        '.skel.bytes',
        '.png',
    ];

    function normalizePath(value) {
        let path = String(value || '').replace(/\\/g, '/').trim();
        if (!path || path.startsWith('/') || /^[A-Za-z]:\//.test(path)) {
            throw new Error('模板目录包含不安全路径');
        }
        const parts = [];
        for (const part of path.split('/')) {
            if (!part || part === '.') continue;
            if (part === '..') throw new Error('模板目录包含路径穿越');
            parts.push(part);
        }
        return parts.join('/');
    }

    function suffix(path) {
        const lowered = path.toLowerCase();
        if (lowered.endsWith('.atlas.txt')) return '.atlas.txt';
        if (lowered.endsWith('.skel.bytes')) return '.skel.bytes';
        const index = lowered.lastIndexOf('.');
        return index >= 0 ? lowered.slice(index) : '';
    }

    function hasIgnoredSegment(path) {
        return path.split('/').some((part) => IGNORED_SEGMENTS.has(part.toLowerCase()) || IGNORED_SEGMENTS.has(part));
    }

    function isExternalTexture(path) {
        const parts = path.split('/').map((part) => part.toLowerCase());
        return suffix(path) === '.png'
            && parts.includes('texture cache')
            && parts.includes('custom textures');
    }

    function isAllowed(path) {
        return !hasIgnoredSegment(path) && ALLOWED_SUFFIXES.includes(suffix(path));
    }

    function hasKnownRoot(paths) {
        const known = new Set(['emotelab', 'spinemodels', 'characters', 'scenelists', 'texture cache']);
        return paths.some((path) => path.split('/').some((part) => known.has(part.toLowerCase())));
    }

    function rootChild(path, rootName) {
        const parts = path.split('/');
        const index = parts.findIndex((part) => part.toLowerCase() === rootName);
        return index >= 0 ? String(parts[index + 1] || '') : '';
    }

    function inferModelKey(paths) {
        const modelPath = paths.find((path) => {
            const lowered = path.toLowerCase();
            return lowered.endsWith('.skel.bytes') || lowered.endsWith('.atlas.txt');
        });
        if (!modelPath) return '';
        return rootChild(modelPath, 'spinemodels') || modelPath.split('/')[0] || '';
    }

    function belongsToModel(path, modelKey) {
        if (!modelKey) return true;
        const roots = ['spinemodels', 'characters', 'scenelists', 'texture cache'];
        const matchingRoot = roots.find((rootName) => path.split('/').some((part) => part.toLowerCase() === rootName));
        if (!matchingRoot) return true;
        const child = rootChild(path, matchingRoot);
        return !child || child.toLowerCase() === modelKey.toLowerCase();
    }

    function hasPathRoot(paths, rootName) {
        const needle = String(rootName || '').toLowerCase();
        return Boolean(needle) && paths.some((path) => (
            path.split('/').some((part) => part.toLowerCase() === needle)
        ));
    }

    function hasModelAsset(paths) {
        return paths.some((path) => {
            const lowered = path.toLowerCase();
            return lowered.endsWith('.skel.bytes') || lowered.endsWith('.atlas.txt');
        });
    }

    function buildCompleteness(paths, modelKey) {
        const modelAssets = paths.filter((path) => belongsToModel(path, modelKey));
        const hasModel = hasModelAsset(modelAssets);
        const hasScenes = hasPathRoot(modelAssets, 'scenelists') || modelAssets.some((path) => {
            const lowered = path.toLowerCase();
            const basename = lowered.split('/').at(-1) || '';
            return lowered.endsWith('.json') && /(scene|list|animation)/i.test(basename);
        });
        const hasCharacters = hasPathRoot(modelAssets, 'characters');
        const missing = [];
        if (!hasModel) missing.push('model');
        // A model-only folder can still expose animation names, but it cannot
        // produce a trustworthy template preview without a scene description.
        if (!hasScenes) missing.push('scenes');
        if (!hasCharacters) missing.push('characters');
        return {
            complete: hasModel && hasScenes && hasCharacters,
            hasModel,
            hasScenes,
            hasCharacters,
            hasTextures: modelAssets.some((path) => suffix(path) === '.png'),
            missing,
        };
    }

    function modelFolderPrefix(paths) {
        if (hasKnownRoot(paths)) return '';
        const modelFile = paths.find((path) => {
            const lowered = path.toLowerCase();
            return lowered.endsWith('.skel.bytes') || lowered.endsWith('.atlas.txt');
        });
        if (!modelFile) return '';
        const parts = modelFile.split('/');
        if (parts.length > 1 && parts[0]) return 'SpineModels';
        const filename = parts[0] || 'ImportedModel';
        const modelName = filename
            .replace(/\.skel\.bytes$/i, '')
            .replace(/\.atlas\.txt$/i, '')
            .replace(/\.json$/i, '') || 'ImportedModel';
        return `SpineModels/${modelName}`;
    }

    function readRelativePath(file) {
        return file?.webkitRelativePath || file?.name || '';
    }

    function collectDirectory(files) {
        const source = Array.from(files || []).filter((file) => file && typeof file.arrayBuffer === 'function');
        if (!source.length) throw new Error('没有选择模板文件');
        if (source.length > MAX_FILES) throw new Error(`模板文件数量超过上限（最多 ${MAX_FILES} 个）`);

        const candidates = [];
        const externalTextureFiles = [];
        let totalBytes = 0;
        for (const file of source) {
            const path = normalizePath(readRelativePath(file));
            if (!path || !isAllowed(path)) continue;
            const size = Number(file.size) || 0;
            if (size > MAX_SINGLE_FILE_BYTES) throw new Error(`模板文件过大：${path}`);
            totalBytes += size;
            if (totalBytes > MAX_TOTAL_BYTES) throw new Error('模板目录解压前大小超过上限');
            if (isExternalTexture(path)) {
                externalTextureFiles.push(file);
                continue;
            }
            candidates.push({ file, path });
        }
        if (!candidates.length) throw new Error('目录中没有可识别的模板资源');

        const modelKey = inferModelKey(candidates.map((item) => item.path));
        const scopedCandidates = candidates.filter((item) => belongsToModel(item.path, modelKey));
        const scopedTextureFiles = externalTextureFiles.filter((file) => {
            const path = normalizePath(readRelativePath(file));
            return belongsToModel(path, modelKey);
        });
        const prefix = modelFolderPrefix(scopedCandidates.map((item) => item.path));
        const entries = new Map();
        for (const item of scopedCandidates) {
            const path = prefix ? `${prefix}/${item.path}` : item.path;
            const key = path.toLowerCase();
            if (entries.has(key)) throw new Error(`模板目录包含重复路径：${path}`);
            entries.set(key, { path, file: item.file });
        }
        return {
            entries: [...entries.values()],
            externalTextureFiles: scopedTextureFiles,
            modelKey,
            completeness: buildCompleteness(scopedCandidates.map((item) => item.path), modelKey),
        };
    }

    function collectFiles(files) {
        return collectDirectory(files).entries;
    }

    function memoryFile(path, bytes) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        return {
            name: path.split('/').pop() || 'file',
            webkitRelativePath: path,
            size: data.byteLength,
            async arrayBuffer() {
                return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            },
        };
    }

    /**
     * Steam 创意工坊下载下来的是 ELPK：8 字节头之后是清单 JSON，后面是一份 ZIP。
     * 角色包只有预设和自定义贴图，模型包才有骨架。
     */
    function unwrapElpack(bytes) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (data.byteLength < 24) throw new Error('创意工坊包不完整');
        const magic = String.fromCharCode(data[0], data[1], data[2], data[3]);
        if (magic !== 'ELPK') throw new Error('不是创意工坊包');
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const version = view.getUint32(4, true);
        const manifestLength = view.getUint32(8, true);
        const payloadLength = view.getUint32(12, true);
        if (version !== 1) throw new Error('不认识的创意工坊包版本');
        const payloadStart = 24 + manifestLength;
        if (payloadStart + payloadLength > data.byteLength) throw new Error('创意工坊包不完整');
        let manifest = {};
        try {
            manifest = JSON.parse(new TextDecoder().decode(data.subarray(24, payloadStart)));
        } catch (_) {
            throw new Error('创意工坊包的清单读不出来');
        }
        const payload = data.slice(payloadStart, payloadStart + payloadLength);
        if (payload[0] !== 0x50 || payload[1] !== 0x4b) throw new Error('创意工坊包里没有模板数据');
        if (!fflate || typeof fflate.unzipSync !== 'function') throw new Error('模板打包组件未加载');
        return { manifest, entries: fflate.unzipSync(payload) };
    }

    function parseJsonBytes(bytes) {
        try {
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch (_) {
            return null;
        }
    }

    function isCharacterPreset(path, bytes) {
        if (!String(path).toLowerCase().endsWith('.json')) return false;
        if (String(path).toLowerCase().endsWith('model.meta.json')) return false;
        const data = parseJsonBytes(bytes);
        return Boolean(data && typeof data === 'object' && data.ActiveSkins && typeof data.ActiveSkins === 'object');
    }

    function characterView(data, displayName) {
        const items = data?.ActiveSkins?.Items;
        const skins = Array.isArray(items)
            ? items.filter((item) => item && item.Key != null && item.Value != null)
                .map((item) => ({ group: String(item.Key), value: String(item.Value) }))
            : [];
        const sliders = Array.isArray(data?.SliderConstraints)
            ? data.SliderConstraints.filter((item) => item && item.Name != null)
                .map((item) => ({ name: String(item.Name), value: item.Value }))
            : [];
        const slots = Array.isArray(data?.SlotGroups)
            ? data.SlotGroups.filter((item) => item && item.Name != null)
                .map((item) => ({
                    name: String(item.Name),
                    tintColor: item.TintColor || null,
                    tintBlackColor: item.TintBlackColor || null,
                    renderMode: item.RenderMode,
                }))
            : [];
        return {
            displayName: String(displayName || ''),
            sharedModelKey: String(data?.SharedModelKey || ''),
            skins,
            sliders,
            slots,
        };
    }

    function sceneListBytes(key, displayName, entries) {
        const csvPath = Object.keys(entries).find((path) => path.toLowerCase().endsWith('/animations.csv')
            || path.toLowerCase() === 'displayinfo/animations.csv');
        const scenes = [];
        if (csvPath) {
            const text = new TextDecoder().decode(entries[csvPath]);
            text.split(/\r?\n/).slice(1).forEach((line) => {
                const cells = line.split(',');
                const animationName = String(cells[0] || '').trim();
                if (!animationName) return;
                scenes.push({
                    name: String(cells[1] || animationName).trim() || animationName,
                    animationName,
                    cameraPosition: { x: 0, y: 0, z: 0 },
                    model: {},
                    texts: [],
                });
            });
        }
        if (!scenes.length) {
            scenes.push({
                name: displayName || key,
                animationName: '',
                cameraPosition: { x: 0, y: 0, z: 0 },
                model: {},
                texts: [],
            });
        }
        return new TextEncoder().encode(JSON.stringify({ sharedModelKey: key, scenes }));
    }

    function filesFromElpack(fileBytes) {
        const { manifest, entries } = unwrapElpack(fileBytes);
        const key = String(manifest.SharedModelKey || 'ImportedModel').replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '-').trim() || 'ImportedModel';
        const displayName = String(manifest.DisplayName || key);
        const hasSkeleton = Object.keys(entries).some((path) => {
            const lowered = path.toLowerCase();
            return lowered.endsWith('.skel.bytes') || lowered.endsWith('.atlas.txt');
        });
        const presetPath = Object.keys(entries).find((path) => isCharacterPreset(path, entries[path]));
        const preset = presetPath ? parseJsonBytes(entries[presetPath]) : null;
        if (!hasSkeleton) {
            const textureFiles = [];
            Object.entries(entries).forEach(([path, bytes]) => {
                if (!String(path).toLowerCase().endsWith('.png')) return;
                const base = path.split('/').pop();
                if (!base) return;
                textureFiles.push(memoryFile(`Texture Cache/${key}/Custom Textures/${base}`, bytes));
            });
            return {
                files: [],
                displayName,
                character: {
                    ...characterView(preset || {}, displayName),
                    sharedModelKey: String(preset?.SharedModelKey || manifest.SharedModelKey || ''),
                    textureFiles,
                },
            };
        }
        const files = [];
        let placedCharacter = false;
        Object.entries(entries).forEach(([path, bytes]) => {
            if (isCharacterPreset(path, bytes)) {
                const base = path.split('/').pop() || `${key}.json`;
                files.push(memoryFile(`Characters/${key}/${base}`, bytes));
                placedCharacter = true;
                return;
            }
            const loweredParts = path.split('/').map((part) => part.toLowerCase());
            if (loweredParts.includes('regions') && path.toLowerCase().endsWith('.png')) {
                const base = path.split('/').pop();
                files.push(memoryFile(`Texture Cache/${key}/Custom Textures/${base}`, bytes));
                return;
            }
            const rooted = loweredParts.some((part) => (
                part === 'spinemodels' || part === 'characters' || part === 'scenelists' || part === 'texture cache'
            ));
            files.push(memoryFile(rooted ? path : `SpineModels/${key}/${path}`, bytes));
        });
        if (!placedCharacter) {
            const empty = {
                SharedModelKey: key,
                ActiveSkins: { Items: [] },
                SliderConstraints: [],
                SlotGroups: [],
            };
            files.push(memoryFile(
                `Characters/${key}/${key}.json`,
                new TextEncoder().encode(JSON.stringify(empty)),
            ));
        }
        const hasScenes = files.some((item) => item.webkitRelativePath.toLowerCase().includes('scenelists/'));
        if (!hasScenes) {
            files.push(memoryFile(`SceneLists/${key}/Workshop.json`, sceneListBytes(key, displayName, entries)));
        }
        return { files, displayName, character: null };
    }

    async function expandWorkshop(files) {
        const list = Array.from(files || []);
        const hasElpack = list.some((file) => /\.elpack$/i.test(readRelativePath(file)));
        if (!hasElpack) return { files: list, sourceName: '', workshopCharacter: null };
        const kept = [];
        const synthetic = [];
        let sourceName = '';
        let workshopCharacter = null;
        for (const file of list) {
            const relative = readRelativePath(file);
            const base = relative.split('/').pop().toLowerCase();
            if (base === 'workshop.meta.json') {
                const title = parseJsonBytes(new Uint8Array(await file.arrayBuffer()))?.Title;
                if (title && !sourceName) sourceName = String(title);
                continue;
            }
            if (/\.elpack$/i.test(relative)) {
                const absorbed = filesFromElpack(new Uint8Array(await file.arrayBuffer()));
                synthetic.push(...absorbed.files);
                if (absorbed.character) workshopCharacter = absorbed.character;
                if (absorbed.displayName) sourceName = absorbed.displayName;
                continue;
            }
            if (base === 'preview.png') continue;
            kept.push(file);
        }
        return { files: [...kept, ...synthetic], sourceName, workshopCharacter };
    }

    async function pack(files, options = {}) {
        if (!fflate || typeof fflate.zipSync !== 'function') {
            throw new Error('模板打包组件未加载');
        }
        const expanded = await expandWorkshop(files);
        if (expanded.workshopCharacter && !expanded.files.some((file) => {
            const path = readRelativePath(file).toLowerCase();
            return path.endsWith('.skel.bytes') || path.endsWith('.atlas.txt');
        })) {
            return {
                bytes: new Uint8Array(),
                filename: 'template-directory.zip',
                paths: [],
                textureFiles: expanded.workshopCharacter.textureFiles || [],
                modelKey: expanded.workshopCharacter.sharedModelKey || '',
                completeness: {
                    complete: false,
                    hasModel: false,
                    hasScenes: false,
                    hasCharacters: true,
                    missing: ['model'],
                },
                sourceName: expanded.sourceName,
                workshopCharacter: expanded.workshopCharacter,
            };
        }
        const { entries, externalTextureFiles, modelKey, completeness } = collectDirectory(expanded.files);
        const archiveEntries = {};
        for (const entry of entries) {
            const bytes = new Uint8Array(await entry.file.arrayBuffer());
            archiveEntries[entry.path] = bytes;
        }
        const bytes = fflate.zipSync(archiveEntries, { level: 6 });
        const filename = String(options.filename || 'template-directory.zip')
            .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '-')
            .trim() || 'template-directory.zip';
        return {
            bytes,
            filename: filename.toLowerCase().endsWith('.zip') ? filename : `${filename}.zip`,
            paths: entries.map((entry) => entry.path),
            textureFiles: externalTextureFiles,
            modelKey,
            completeness,
            sourceName: expanded.sourceName || '',
            workshopCharacter: null,
        };
    }

    function toFile(result) {
        if (!result || !(result.bytes instanceof Uint8Array)) {
            throw new TypeError('无效的模板压缩结果');
        }
        if (typeof File === 'function') {
            return new File([result.bytes], result.filename, { type: 'application/zip' });
        }
        if (typeof Blob === 'function') {
            const blob = new Blob([result.bytes], { type: 'application/zip' });
            Object.defineProperty(blob, 'name', { value: result.filename });
            return blob;
        }
        throw new Error('当前环境不支持模板文件读取');
    }

    return Object.freeze({
        collectFiles,
        inspect: (files) => {
            const collected = collectDirectory(files);
            return Object.freeze({
                modelKey: collected.modelKey,
                completeness: collected.completeness,
                paths: collected.entries.map((entry) => entry.path),
                textureFiles: collected.externalTextureFiles,
            });
        },
        pack,
        toFile,
        constants: Object.freeze({ MAX_FILES, MAX_TOTAL_BYTES, MAX_SINGLE_FILE_BYTES }),
    });
}));
