/*
 * Small, renderer-neutral compatibility helpers for EmoteLab SceneTextData.
 *
 * EmoteLab serializes TextMeshPro enums as integers.  Keeping the conversion
 * here (rather than in the DOM renderer) lets the metadata adapter and the
 * Canvas2D preview agree on the same semantics, while still accepting the
 * human-readable values produced by hand-authored fixtures.
 */
(function (root, factory) {
    'use strict';

    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
        return;
    }

    root.NekoEmoteSceneText = factory();
}(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const FONT_STYLE_BITS = Object.freeze([
        [1, 'Bold'],
        [2, 'Italic'],
        [4, 'Underline'],
        [8, 'LowerCase'],
        [16, 'UpperCase'],
        [32, 'SmallCaps'],
        [64, 'Strikethrough'],
        [128, 'Superscript'],
        [256, 'Subscript'],
        [512, 'Highlight'],
    ]);

    const HORIZONTAL_ALIGNMENT = Object.freeze({
        1: 'Left',
        2: 'Center',
        4: 'Right',
        8: 'Justified',
        16: 'Flush',
        32: 'Geometry',
    });
    const VERTICAL_ALIGNMENT = Object.freeze({
        256: 'Top',
        512: 'Middle',
        1024: 'Bottom',
        2048: 'Baseline',
        4096: 'Geometry',
        8192: 'Capline',
    });
    const OVERFLOW_MODE = Object.freeze({
        0: 'Overflow',
        1: 'Ellipsis',
        2: 'Masking',
        3: 'Truncate',
        4: 'ScrollRect',
        5: 'Page',
        6: 'Linked',
    });

    function numericValue(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value !== 'string' || !value.trim()) return null;
        const number = Number(value.trim());
        return Number.isFinite(number) ? number : null;
    }

    function normalizeFontStyle(value) {
        const number = numericValue(value);
        if (number !== null && Number.isInteger(number)) {
            if (number === 0) return 'Normal';
            const names = FONT_STYLE_BITS
                .filter(([bit]) => (number & bit) === bit)
                .map(([, name]) => name);
            return names.length ? names.join(' ') : String(value);
        }
        const text = String(value ?? '').trim();
        return text || 'Normal';
    }

    function normalizeEnum(value, table, fallback) {
        const number = numericValue(value);
        if (number !== null && Number.isInteger(number)) {
            return table[number] || String(value);
        }
        const text = String(value ?? '').trim();
        return text || fallback;
    }

    function normalizeHorizontalAlignment(value) {
        return normalizeEnum(value, HORIZONTAL_ALIGNMENT, 'Left');
    }

    function normalizeVerticalAlignment(value) {
        return normalizeEnum(value, VERTICAL_ALIGNMENT, 'Top');
    }

    function normalizeOverflowMode(value) {
        return normalizeEnum(value, OVERFLOW_MODE, 'Overflow');
    }

    function normalizeSide(value) {
        const number = numericValue(value);
        if (number !== null && Number.isInteger(number)) {
            return number === 1 ? 'Behind' : 'Front';
        }
        return String(value ?? '').trim().toLocaleLowerCase() === 'behind'
            ? 'Behind'
            : 'Front';
    }

    function alignmentToken(value) {
        const number = numericValue(value);
        if (number !== null && Number.isInteger(number)) {
            if (number === 1) return 'left';
            if (number === 2 || number === 32) return 'center';
            if (number === 4) return 'right';
            // Canvas has no justified/flush text primitive.  Left is the
            // least surprising approximation until a width-aware layout is
            // available.
            if (number === 8 || number === 16) return 'left';
        }
        const token = String(value ?? '').toLocaleLowerCase();
        if (token.includes('left') || token.includes('start') || token.includes('flush')) return 'left';
        if (token.includes('right') || token.includes('end')) return 'right';
        if (token.includes('justif')) return 'left';
        return 'center';
    }

    function baselineToken(value) {
        const number = numericValue(value);
        if (number !== null && Number.isInteger(number)) {
            if (number === 256) return 'top';
            if (number === 512 || number === 4096) return 'middle';
            if (number === 1024) return 'bottom';
            if (number === 2048) return 'alphabetic';
            if (number === 8192) return 'hanging';
        }
        const token = String(value ?? '').toLocaleLowerCase();
        if (token.includes('top')) return 'top';
        if (token.includes('bottom')) return 'bottom';
        if (token.includes('baseline')) return 'alphabetic';
        if (token.includes('cap')) return 'hanging';
        return 'middle';
    }

    function normalizeTextContent(value, options = {}) {
        let text = String(value ?? '');
        if (options.parseCtrlCharacters !== false) {
            // TMP's parseCtrlCharacters accepts escaped control sequences in
            // addition to actual newline characters from JSON.
            text = text
                .replace(/\\r\\n/g, '\n')
                .replace(/\\n/g, '\n')
                .replace(/\\r/g, '\r')
                .replace(/\\t/g, '\t');
        }
        if (options.richText !== false) {
            return text
                .replace(/<br\s*\/?\s*>/gi, '\n')
                .replace(/<[^>]+>/g, '');
        }
        // With richText disabled TMP displays markup literally.  Do not strip
        // tags here; doing so silently changes user-authored copy.
        return text;
    }

    function wrapLines(text, measure, maxWidth, options = {}) {
        const sourceLines = String(text ?? '').split(/\r?\n/);
        if (options.enableWordWrapping !== true
            || typeof measure !== 'function'
            || !Number.isFinite(maxWidth)
            || maxWidth <= 0) {
            return sourceLines;
        }
        const overflow = normalizeOverflowMode(options.overflowMode);
        const output = [];
        const clipLine = (line, marker) => {
            if (measure(line) <= maxWidth) return line;
            const markerWidth = marker ? measure(marker) : 0;
            let result = '';
            for (const character of [...line]) {
                if (measure(result + character) + markerWidth > maxWidth) break;
                result += character;
            }
            return `${result.trimEnd()}${marker}`;
        };
        const fitLine = (line) => {
            if (measure(line) <= maxWidth) return [line];
            const words = line.split(/(\s+)/);
            const wrapped = [];
            let current = '';
            for (const word of words) {
                const candidate = current + word;
                if (!current || measure(candidate) <= maxWidth) {
                    current = candidate;
                    continue;
                }
                wrapped.push(current.trimEnd());
                current = word.trimStart();
                if (measure(current) > maxWidth) {
                    let chunk = '';
                    for (const character of [...current]) {
                        if (chunk && measure(chunk + character) > maxWidth) {
                            wrapped.push(chunk);
                            chunk = character;
                        } else {
                            chunk += character;
                        }
                    }
                    current = chunk;
                }
            }
            if (current || !wrapped.length) wrapped.push(current.trimEnd());
            return wrapped;
        };
        for (const line of sourceLines) {
            const wrapped = fitLine(line);
            if (overflow === 'Ellipsis' || overflow === 'Truncate') {
                output.push(clipLine(wrapped[0] || '', overflow === 'Ellipsis' ? '…' : ''));
            } else {
                output.push(...wrapped);
            }
        }
        return output;
    }

    function outlinePixelRadius(outlineWidth, cameraOrthoSize, targetHeight, editorScale = 1) {
        const width = numericValue(outlineWidth);
        const ortho = numericValue(cameraOrthoSize);
        const height = numericValue(targetHeight);
        const scale = numericValue(editorScale);
        if (width === null || height === null || height <= 0) return 0;
        const safeOrtho = Math.max(0.0001, ortho === null ? 5 : ortho);
        const safeScale = Math.max(0.01, scale === null ? 1 : scale);
        // Mirrors EmoteLab's reference profile: 10/1024 world units per
        // outline point, then convert through the active orthographic view.
        const radius = width * 10 / 1024 * height / (2 * safeOrtho) * safeScale;
        return Math.max(0, Math.min(128, radius));
    }

    function fontCss(style, pixelSize) {
        const fontStyle = normalizeFontStyle(style?.fontStyle);
        const italic = fontStyle.toLocaleLowerCase().includes('italic') ? 'italic ' : '';
        const bold = /bold|heavy/i.test(fontStyle) ? '700 ' : '';
        const requested = String(style?.fontName ?? '').replace(/["']/g, '').trim();
        const family = requested
            ? `"${requested.replace(/\\/g, '\\\\')}", Arial, "Microsoft YaHei", sans-serif`
            : 'Arial, "Microsoft YaHei", sans-serif';
        return `${italic}${bold}${Math.max(1, pixelSize)}px ${family}`;
    }

    return Object.freeze({
        alignmentToken,
        baselineToken,
        fontCss,
        normalizeFontStyle,
        normalizeHorizontalAlignment,
        normalizeOverflowMode,
        normalizeSide,
        normalizeTextContent,
        normalizeVerticalAlignment,
        outlinePixelRadius,
        wrapLines,
    });
}));
