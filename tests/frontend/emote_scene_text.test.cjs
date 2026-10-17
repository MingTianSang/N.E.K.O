const assert = require('node:assert/strict');
const test = require('node:test');

const sceneText = require('../../static/js/emote_scene_text.js');

test('maps Unity TextMeshPro enum integers to Canvas-compatible values', () => {
    assert.equal(sceneText.normalizeFontStyle(3), 'Bold Italic');
    assert.equal(sceneText.normalizeHorizontalAlignment(1), 'Left');
    assert.equal(sceneText.normalizeHorizontalAlignment(4), 'Right');
    assert.equal(sceneText.normalizeHorizontalAlignment('4'), 'Right');
    assert.equal(sceneText.normalizeVerticalAlignment(256), 'Top');
    assert.equal(sceneText.normalizeVerticalAlignment(2048), 'Baseline');
    assert.equal(sceneText.normalizeOverflowMode(2), 'Masking');
    assert.equal(sceneText.normalizeSide(1), 'Behind');
    assert.equal(sceneText.normalizeSide(0), 'Front');
});

test('keeps literal markup when rich text is disabled and parses controls', () => {
    assert.equal(
        sceneText.normalizeTextContent('<b>A</b>\\nB', { richText: false, parseCtrlCharacters: true }),
        '<b>A</b>\nB',
    );
    assert.equal(
        sceneText.normalizeTextContent('<b>A</b><br/>B', { richText: true }),
        'AB'.replace('A', 'A\n'),
    );
    assert.equal(
        sceneText.normalizeTextContent('A\\nB', { richText: false, parseCtrlCharacters: false }),
        'A\\nB',
    );
});

test('adds a system fallback after an EmoteLab font asset name', () => {
    const css = sceneText.fontCss({ fontName: 'LiberationSans SDF', fontStyle: 3 }, 24);
    assert.match(css, /^italic 700 24px /);
    assert.match(css, /"LiberationSans SDF"/);
    assert.match(css, /Arial/);
});

test('maps EmoteLab outline points through the active orthographic view', () => {
    assert.equal(sceneText.outlinePixelRadius(8, 5, 1024), 8);
    assert.equal(sceneText.outlinePixelRadius(8, 10, 1024), 4);
    assert.equal(sceneText.outlinePixelRadius(8, 5, 1024, 2), 16);
    assert.equal(sceneText.outlinePixelRadius(48, 0.01, 4096), 128);
});

test('wraps only when an explicit width and TMP wrapping flag are available', () => {
    const measure = (value) => String(value).length * 10;
    assert.deepEqual(
        sceneText.wrapLines('one two three', measure, 50, { enableWordWrapping: true }),
        ['one', 'two', 'three'],
    );
    assert.deepEqual(
        sceneText.wrapLines('one two three', measure, 70, { enableWordWrapping: false }),
        ['one two three'],
    );
    assert.deepEqual(
        sceneText.wrapLines('abcdefgh', measure, 50, { enableWordWrapping: true, overflowMode: 1 }),
        ['abcd…'],
    );
});
