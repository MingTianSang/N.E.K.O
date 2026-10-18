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

    async function pack(files, options = {}) {
        if (!fflate || typeof fflate.zipSync !== 'function') {
            throw new Error('模板打包组件未加载');
        }
        const { entries, externalTextureFiles, modelKey, completeness } = collectDirectory(files);
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
