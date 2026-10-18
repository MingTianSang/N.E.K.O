import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const fflate = require('../../static/libs/fflate.umd.js');
const {
    ClientZipAssetStore,
    ClientFileOverlayStore,
    ClientZipAssetStoreError,
} = require('../../static/js/emote_template_client_store.js');

const encoder = new TextEncoder();

function fixtureZip() {
    return fflate.zipSync({
        'pkg/SpineModels/Test/model.skel.bytes': new Uint8Array([1, 2, 3]),
        'pkg/SpineModels/Test/model.atlas.txt': encoder.encode('page.png\nsize: 2, 2\nscale: 1\n'),
        'pkg/SpineModels/Test/page.png': new Uint8Array([137, 80, 78, 71]),
        'pkg/history/old.png': new Uint8Array([4]),
        'pkg/ignored.js': new Uint8Array([5]),
    });
}

test('client ZIP store keeps active resources in memory and releases them', async () => {
    const store = await ClientZipAssetStore.fromBytes(fixtureZip());
    assert.equal(store.has('pkg/SpineModels/Test/model.skel.bytes'), true);
    assert.equal(store.has('乱码包根/SpineModels/Test/model.skel.bytes'), true);
    assert.equal(store.has('pkg/history/old.png'), false);
    assert.deepEqual(
        [...new Uint8Array(await store.open('pkg/SpineModels/Test/model.skel.bytes'))],
        [1, 2, 3],
    );
    const objectUrl = store.url('pkg/SpineModels/Test/page.png');
    assert.match(objectUrl, /^blob:/);
    assert.equal(store.stats().objectUrls, 1);
    store.release();
    assert.equal(store.stats().released, true);
    assert.throws(() => store.get('pkg/SpineModels/Test/page.png'), /已释放/);
});

test('client ZIP store rejects traversal paths before exposing assets', async () => {
    const archive = fflate.zipSync({ '../outside.png': new Uint8Array([1]) });
    await assert.rejects(
        () => ClientZipAssetStore.fromBytes(archive),
        (error) => error instanceof ClientZipAssetStoreError && error.code === 'unsafe_path',
    );
});

test('real EmoteLab ZIP smoke test when EMOTELAB_TEST_ZIP is provided', async (t) => {
    const filename = process.env.EMOTELAB_TEST_ZIP;
    if (!filename) {
        t.skip('set EMOTELAB_TEST_ZIP to run against a local EmoteLab archive');
        return;
    }
    const store = await ClientZipAssetStore.fromBytes(fs.readFileSync(filename));
    assert.ok(store.list().some((path) => path.endsWith('.skel.bytes')));
    assert.ok(store.list().some((path) => path.endsWith('.atlas.txt')));
    store.release();
});

test('file overlay prefers an external Texture Cache page and releases with its ZIP base', async () => {
    const base = await ClientZipAssetStore.fromBytes(fflate.zipSync({
        'pkg/SpineModels/Test/page.png': new Uint8Array([1, 2, 3]),
    }));
    const overlayBytes = new Uint8Array([9, 8, 7]);
    const file = {
        name: 'page.png',
        webkitRelativePath: 'Custom Textures/page.png',
        size: overlayBytes.byteLength,
        async arrayBuffer() { return overlayBytes.buffer; },
    };
    const store = new ClientFileOverlayStore(base, [file]);
    assert.deepEqual([...new Uint8Array(await store.open('pkg/SpineModels/Test/page.png', { as: 'bytes' }))], [9, 8, 7]);
    assert.equal(store.stats().overlayFiles, 1);
    store.release();
    assert.equal(store.stats().released, true);
    assert.throws(() => base.get('pkg/SpineModels/Test/page.png'), /已释放/);
});
