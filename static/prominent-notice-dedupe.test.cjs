const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const browserNoticeSource = fs.readFileSync(
    path.join(repoRoot, 'static', 'app', 'app-ui', 'bootstrap-goodbye-and-toasts.js'),
    'utf8',
);
const desktopToastSource = fs.readFileSync(
    path.join(repoRoot, 'templates', 'toast.html'),
    'utf8',
);

function sourceBetween(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
    return source.slice(start, end);
}

test('browser prominent notices merge an active or queued duplicate', () => {
    const showBlock = sourceBetween(
        browserNoticeSource,
        'function showProminentNotice(noticeOrMessage)',
        'I.mod.showProminentNotice = showProminentNotice',
    );
    const drainBlock = sourceBetween(
        browserNoticeSource,
        'function _drainProminentNoticeQueue()',
        'function _renderProminentNotice(',
    );

    assert.match(showBlock, /_prominentNoticeDedupeKey\(notice\)/);
    assert.match(showBlock, /_prominentNoticeQueue\.some/);
    assert.match(showBlock, /_prominentNoticeActiveKey === dedupeKey/);
    assert.match(showBlock, /resolve\(\);\s*return;/);
    assert.match(drainBlock, /_prominentNoticeActiveKey = dedupeKey/);
    assert.match(drainBlock, /_prominentNoticeActiveKey = ''/);
});

test('desktop prominent notices merge an active or queued duplicate', () => {
    const showBlock = sourceBetween(
        desktopToastSource,
        'function showProminentNotice(notice)',
        '// ===== IPC',
    );
    const drainBlock = sourceBetween(
        desktopToastSource,
        'function drainPnQueue()',
        'function renderProminentNotice(',
    );

    assert.match(showBlock, /prominentNoticeDedupeKey\(notice\)/);
    assert.match(showBlock, /pnQueue\.some/);
    assert.match(showBlock, /pnActiveKey === dedupeKey/);
    assert.match(showBlock, /return;/);
    assert.match(drainBlock, /pnActiveKey = item\.dedupeKey/);
    assert.match(drainBlock, /pnActiveKey = ''/);
});
