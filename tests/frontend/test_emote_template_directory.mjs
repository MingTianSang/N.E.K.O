import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const fflate = require('../../static/libs/fflate.umd.js');
const directoryApi = require('../../static/js/emote_template_directory.js');

function fakeFile(path, bytes) {
    const data = Uint8Array.from(bytes);
    return {
        name: path.split('/').at(-1),
        webkitRelativePath: path,
        size: data.byteLength,
        async arrayBuffer() {
            return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        },
    };
}

function filesFromDirectory(root) {
    const base = path.dirname(root);
    const result = [];
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const fullPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                visit(fullPath);
                continue;
            }
            if (!entry.isFile()) continue;
            const stat = fs.statSync(fullPath);
            result.push({
                name: entry.name,
                webkitRelativePath: path.relative(base, fullPath).replaceAll('\\', '/'),
                size: stat.size,
                async arrayBuffer() {
                    const data = await fs.promises.readFile(fullPath);
                    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
                },
            });
        }
    };
    visit(root);
    return result;
}

test('normalizes a selected model folder into a compatible model root', () => {
    const entries = directoryApi.collectFiles([
        fakeFile('YUI_PropsV1/YUI_PropsV1.skel.bytes', [1]),
        fakeFile('YUI_PropsV1/YUI_PropsV1.atlas.txt', [2]),
        fakeFile('YUI_PropsV1/YUI_PropsV1.png', [3]),
    ]);
    assert.deepEqual(entries.map((entry) => entry.path), [
        'SpineModels/YUI_PropsV1/YUI_PropsV1.skel.bytes',
        'SpineModels/YUI_PropsV1/YUI_PropsV1.atlas.txt',
        'SpineModels/YUI_PropsV1/YUI_PropsV1.png',
    ]);
    const report = directoryApi.inspect([
        fakeFile('YUI_PropsV1/YUI_PropsV1.skel.bytes', [1]),
        fakeFile('YUI_PropsV1/YUI_PropsV1.atlas.txt', [2]),
    ]);
    assert.equal(report.completeness.complete, false);
    assert.deepEqual(report.completeness.missing, ['scenes', 'characters']);
});

test('keeps a selected data root and omits backup/script files', () => {
    const entries = directoryApi.collectFiles([
        fakeFile('EmoteLab/SpineModels/Demo/Demo.skel.bytes', [1]),
        fakeFile('EmoteLab/SceneLists/Demo/list.json', [2]),
        fakeFile('EmoteLab/历史版本/old.png', [3]),
        fakeFile('EmoteLab/Restore.ps1', [4]),
    ]);
    assert.deepEqual(entries.map((entry) => entry.path), [
        'EmoteLab/SpineModels/Demo/Demo.skel.bytes',
        'EmoteLab/SceneLists/Demo/list.json',
    ]);
});

test('scopes sibling characters, scenes, and textures to the detected model', async () => {
    const result = await directoryApi.pack([
        fakeFile('EmoteLab/SpineModels/Demo/Demo.skel.bytes', [1]),
        fakeFile('EmoteLab/SpineModels/Demo/Demo.atlas.txt', [2]),
        fakeFile('EmoteLab/Characters/Demo/Demo.json', [3]),
        fakeFile('EmoteLab/Characters/Other/Other.json', [4]),
        fakeFile('EmoteLab/SceneLists/Demo/list.json', [5]),
        fakeFile('EmoteLab/SceneLists/Other/list.json', [6]),
        fakeFile('EmoteLab/Texture Cache/Demo/Custom Textures/page.png', [7]),
        fakeFile('EmoteLab/Texture Cache/Other/Custom Textures/page.png', [8]),
    ]);
    assert.ok(result.paths.includes('EmoteLab/Characters/Demo/Demo.json'));
    assert.ok(result.paths.includes('EmoteLab/SceneLists/Demo/list.json'));
    assert.ok(!result.paths.some((path) => path.includes('/Other/')));
    assert.equal(result.textureFiles.length, 1);
    assert.equal(result.completeness.complete, true);
});

test('keeps a large external texture cache out of the temporary package', async () => {
    const texture = fakeFile('EmoteLab/Texture Cache/Demo/Custom Textures/page.png', [9, 8, 7]);
    const result = await directoryApi.pack([
        fakeFile('EmoteLab/SpineModels/Demo/Demo.skel.bytes', [1]),
        fakeFile('EmoteLab/SpineModels/Demo/Demo.atlas.txt', [2]),
        texture,
    ]);
    assert.equal(result.textureFiles.length, 1);
    assert.deepEqual(result.paths, [
        'EmoteLab/SpineModels/Demo/Demo.skel.bytes',
        'EmoteLab/SpineModels/Demo/Demo.atlas.txt',
    ]);
});

test('packs selected directory files into a ZIP accepted by the client store', async () => {
    const result = await directoryApi.pack([
        fakeFile('SpineModels/Demo/Demo.skel.bytes', [1, 2]),
        fakeFile('SpineModels/Demo/Demo.atlas.txt', [3, 4]),
    ], { filename: 'demo' });
    assert.equal(result.filename, 'demo.zip');
    const unpacked = fflate.unzipSync(result.bytes);
    assert.deepEqual([...unpacked['SpineModels/Demo/Demo.skel.bytes']], [1, 2]);
    assert.deepEqual([...unpacked['SpineModels/Demo/Demo.atlas.txt']], [3, 4]);
});

test('rejects traversal paths before reading a selected file', () => {
    assert.throws(
        () => directoryApi.collectFiles([fakeFile('../outside.png', [1])]),
        /不安全|穿越|traversal|path/i,
    );
});

test('real template directory smoke test when TEMPLATE_MODEL_DIR is provided', async (t) => {
    const root = process.env.TEMPLATE_MODEL_DIR;
    if (!root) {
        t.skip('set TEMPLATE_MODEL_DIR to test a local template directory');
        return;
    }
    const result = await directoryApi.pack(filesFromDirectory(root), {
        filename: `${path.basename(root)}.zip`,
    });
    const unpacked = fflate.unzipSync(result.bytes);
    assert.ok(Object.keys(unpacked).some((entry) => entry.toLowerCase().endsWith('.skel.bytes')));
    assert.ok(Object.keys(unpacked).some((entry) => entry.toLowerCase().endsWith('.atlas.txt')));

    const importUrl = process.env.TEMPLATE_IMPORT_URL;
    if (!importUrl) return;
    const form = new FormData();
    form.append('file', new Blob([result.bytes], { type: 'application/zip' }), result.filename);
    const response = await fetch(importUrl, { method: 'POST', body: form });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.ok(payload.package?.model?.skeleton?.path);
});

function elpack(manifest, entries) {
    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
    const zipped = fflate.zipSync(entries);
    const out = new Uint8Array(24 + manifestBytes.length + zipped.length);
    out.set([0x45, 0x4c, 0x50, 0x4b], 0);
    const view = new DataView(out.buffer);
    view.setUint32(4, 1, true);
    view.setUint32(8, manifestBytes.length, true);
    view.setUint32(12, zipped.length, true);
    out.set(manifestBytes, 24);
    out.set(zipped, 24 + manifestBytes.length);
    return out;
}

test('a workshop model package is unpacked into a template directory', async () => {
    const packed = elpack({
        SchemaVersion: 1,
        ContentType: 'model',
        SharedModelKey: 'Demo',
        DisplayName: '示例模型',
    }, {
        'Demo.skel.bytes': new Uint8Array([1]),
        'Demo.atlas.txt': new Uint8Array([2]),
        'Page.png': new Uint8Array([3]),
        'DisplayInfo/Animations.csv': new TextEncoder().encode('AnimationName,DisplayName\nidle,站立\n'),
    });
    const result = await directoryApi.pack([
        fakeFile('3822048285/model.elpack', packed),
        fakeFile('3822048285/preview.png', [9]),
        fakeFile('3822048285/workshop.meta.json', new TextEncoder().encode('{"Title":"工坊标题"}')),
    ]);
    assert.equal(result.completeness.complete, true);
    assert.equal(result.sourceName, '示例模型');
    assert.ok(result.paths.includes('SpineModels/Demo/Demo.skel.bytes'));
    assert.ok(result.paths.includes('SceneLists/Demo/Workshop.json'));
    assert.ok(!result.paths.some((path) => path.endsWith('preview.png')));
    const scenes = JSON.parse(new TextDecoder().decode(
        fflate.unzipSync(result.bytes)['SceneLists/Demo/Workshop.json'],
    ));
    assert.equal(scenes.scenes[0].animationName, 'idle');
    assert.equal(scenes.scenes[0].name, '站立');
});

test('a workshop character package stays a preset for its base model', async () => {
    const packed = elpack({
        SchemaVersion: 1,
        ContentType: 'character',
        SharedModelKey: 'CoffeeBean',
        DisplayName: '酒狐 Wine Fox',
        PresetEntry: '酒狐 Wine Fox.json',
    }, {
        '酒狐 Wine Fox.json': new TextEncoder().encode(JSON.stringify({
            SharedModelKey: 'CoffeeBean',
            ActiveSkins: { Items: [{ Key: 'Brows', Value: 'Brows_Custom' }] },
            SliderConstraints: [],
            SlotGroups: [],
        })),
        'Regions/Asset/Brows.png': new Uint8Array([4, 5]),
    });
    const result = await directoryApi.pack([
        fakeFile('3822048285/character.elpack', packed),
        fakeFile('3822048285/preview.png', [9]),
    ]);
    assert.equal(result.completeness.complete, false);
    assert.deepEqual(result.completeness.missing, ['model']);
    assert.equal(result.workshopCharacter.displayName, '酒狐 Wine Fox');
    assert.equal(result.workshopCharacter.sharedModelKey, 'CoffeeBean');
    assert.deepEqual(result.workshopCharacter.skins, [{ group: 'Brows', value: 'Brows_Custom' }]);
    assert.equal(result.textureFiles.length, 1);
    assert.equal(
        result.textureFiles[0].webkitRelativePath,
        'Texture Cache/CoffeeBean/Custom Textures/Brows.png',
    );
});
