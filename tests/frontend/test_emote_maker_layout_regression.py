"""The emote maker's resizable layout must never let a panel be dragged off-window.

Regression this pins: the two side handles were clamped by *fixed* pixel ceilings
(left 200-520, right 220-560) that ignored the actual container width, while the centre
column had its own minimum. At a 1120px window each side could legally reach its own
maximum and the three minima summed past the container — 52px of horizontal overflow,
with the inspector pushed 36px off-screen and the handle itself outside the viewport, so
the user could no longer grab it to undo the damage. The clamp now works on the *sum* of
both side columns against the measured container, and re-runs when the window shrinks.
"""

from __future__ import annotations

from playwright.sync_api import Page

# Empty-library mode hides the inspector and the list dock; the grid geometry does not
# depend on content, so the probe reveals them to exercise the desktop layout.
REVEAL = """() => {
    document.body.classList.remove('editor-empty');
    document.querySelector('.animation-dock').hidden = false;
    document.querySelector('.inspector-panel').hidden = false;
}"""

GEOMETRY = """() => {
    const grid = document.querySelector('.maker-grid');
    const rect = (sel) => document.querySelector(sel).getBoundingClientRect();
    const shown = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const box = el.getBoundingClientRect();
        return getComputedStyle(el).display !== 'none' && box.width > 0 && box.height > 0;
    };
    const ws = document.querySelector('.workspace-panel');
    const dock = document.querySelector('.animation-dock');
    return {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        tracks: getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length,
        gridOverflowX: grid.scrollWidth - grid.clientWidth,
        documentOverflowX: document.documentElement.scrollWidth - window.innerWidth,
        assetRight: Math.round(rect('.asset-panel').right),
        workspaceLeft: Math.round(rect('.workspace-panel').left),
        inspectorLeft: Math.round(rect('.inspector-panel').left),
        inspectorTop: Math.round(rect('.inspector-panel').top),
        inspectorRight: Math.round(rect('.inspector-panel').right),
        assetTop: Math.round(rect('.asset-panel').top),
        canvasBottom: Math.round(rect('.canvas-stage').bottom),
        dockTop: Math.round(rect('.animation-dock').top),
        handlesShown: ['.resize-handle-col', '#resize-dock'].every(shown),
        // 纵向：播放控件要么在视口内，要么被 .workspace-panel 的面内滚动接住。
        playbackBottom: Math.round(rect('.playback-controls').bottom),
        playbackShown: shown('.playback-controls'),
        workspaceCanScroll: ws.scrollHeight > ws.clientHeight,
        dockClip: dock.scrollHeight - dock.clientHeight,
    };
}"""


def _open(page: Page, server: str, width: int, height: int = 900) -> None:
    page.set_viewport_size({"width": width, "height": height})
    page.goto(f"{server}/emote_maker", wait_until="networkidle")
    page.wait_for_timeout(200)
    page.evaluate(REVEAL)
    page.wait_for_timeout(120)


def _drag_both_sides_past_the_limit(page: Page) -> None:
    # 60 x Shift+Arrow = 1440px per side: far beyond every ceiling.
    page.keyboard.down("Shift")
    page.focus("#resize-left")
    for _ in range(60):
        page.keyboard.press("ArrowRight")
    page.focus("#resize-right")
    for _ in range(60):
        page.keyboard.press("ArrowLeft")
    page.keyboard.up("Shift")
    page.wait_for_timeout(120)


def test_desktop_grid_keeps_three_columns(page: Page, running_server: str) -> None:
    _open(page, running_server, 1400)
    box = page.evaluate(GEOMETRY)
    assert box["tracks"] == 5, "两侧 + 两条手柄轨道"
    assert box["handlesShown"], "桌面布局下手柄应当可见"
    assert box["assetRight"] <= box["workspaceLeft"] + 1, "素材库与画布不重叠"
    assert box["workspaceLeft"] < box["inspectorLeft"], "设置面板在画布右侧"
    assert abs(box["assetTop"] - box["inspectorTop"]) < 4, "三栏在同一行"
    assert box["dockTop"] >= box["canvasBottom"] - 2, "列表在画布下方"


def test_side_handles_cannot_be_dragged_off_the_window(page: Page, running_server: str) -> None:
    for width in (1400, 1200, 1120):
        _open(page, running_server, width)
        _drag_both_sides_past_the_limit(page)
        box = page.evaluate(GEOMETRY)
        assert box["gridOverflowX"] <= 1, f"{width}px: 网格横向溢出 {box['gridOverflowX']}px"
        assert box["documentOverflowX"] <= 1, f"{width}px: 文档横向溢出"
        assert box["inspectorRight"] <= box["viewportWidth"] + 1, (
            f"{width}px: 右栏被推到视口外 ({box['inspectorRight']} > {box['viewportWidth']})"
        )


def test_narrowing_the_window_reclamps_an_existing_layout(page: Page, running_server: str) -> None:
    """A ratio chosen on a wide window must not overflow after the window shrinks —
    and the handle has to stay reachable so the user can undo it."""
    _open(page, running_server, 2000)
    _drag_both_sides_past_the_limit(page)
    page.set_viewport_size({"width": 1120, "height": 900})
    page.wait_for_timeout(250)
    box = page.evaluate(GEOMETRY)
    assert box["gridOverflowX"] <= 1, f"缩小后仍溢出 {box['gridOverflowX']}px"
    assert box["inspectorRight"] <= box["viewportWidth"] + 1, "缩小后右栏跑出视口"


def test_handles_are_hidden_in_the_stacked_layout(page: Page, running_server: str) -> None:
    _open(page, running_server, 1000)
    box = page.evaluate(GEOMETRY)
    assert not box["handlesShown"], "堆叠布局下面板不再并排，手柄应当退出布局"


def _drag_dock_to_the_limit(page: Page) -> None:
    page.keyboard.down("Shift")
    page.focus("#resize-dock")
    for _ in range(40):
        page.keyboard.press("ArrowUp")
    page.keyboard.up("Shift")
    page.wait_for_timeout(200)


def test_default_layout_fits_vertically(page: Page, running_server: str) -> None:
    """不拖任何东西时，播放/进度条必须本来就在窗口里。"""
    for width, height in ((1600, 1024), (1400, 900), (1280, 800)):
        _open(page, running_server, width, height)
        box = page.evaluate(GEOMETRY)
        assert box["playbackShown"], f"{width}x{height}: 播放控件不可见"
        assert box["playbackBottom"] <= box["viewportHeight"] + 1, (
            f"{width}x{height}: 默认布局下播放控件已在窗口外"
        )
        assert box["dockClip"] <= 1, f"{width}x{height}: dock 内容被裁 {box['dockClip']}px"


def test_playback_controls_stay_reachable_when_dock_is_maximised(
    page: Page, running_server: str
) -> None:
    """回归：行手柄的上限曾按 clientHeight 算，而 clientHeight 含上下 padding，
    于是每个窗口都稳定多出一截，把播放/进度条顶到窗口外（且 dock 被 overflow 裁切）。

    这里刻意用**严格**断言：拖到上限意味着"正好放得下"，所以不允许任何溢出，也不许
    拿"面板可以滚动"当逃生条件 —— 上一版这条测试正是加了那句或条件，才在 padY=0 的
    变异下依旧全绿，白给了一份假信心。面内滚动只对默认状态是合法兜底。
    """
    for width, height in ((1600, 1024), (1400, 900), (1280, 800), (1200, 720), (1120, 660)):
        _open(page, running_server, width, height)
        _drag_dock_to_the_limit(page)
        box = page.evaluate(GEOMETRY)
        assert box["playbackShown"], f"{width}x{height}: 播放控件不可见"
        assert box["dockClip"] <= 1, f"{width}x{height}: dock 内容被裁 {box['dockClip']}px"
        assert not box["workspaceCanScroll"], (
            f"{width}x{height}: 拖到上限后仍纵向溢出，说明行手柄上限算多了"
        )
        assert box["playbackBottom"] <= box["viewportHeight"] + 1, (
            f"{width}x{height}: 播放控件被推到窗口外 "
            f"(bottom={box['playbackBottom']} > {box['viewportHeight']})"
        )


def test_stacked_mode_keeps_the_playback_bar_intact(
    page: Page, running_server: str
) -> None:
    """回归：≤1080 堆叠态下面板变成整宽，方形画布跟着长到一千多像素，
    而 .animation-dock 在四代规则里都被写成 min-height:0 —— 于是它能被 flex
    压成十几像素，播放条的控件直接没了（内容本来要 108px）。

    堆叠态允许整页滚动（这是它的设计），所以这里**不**断言"在视口内"，
    只断言 dock 没被裁、有该有的高度，并且画布不再按宽度无限长。
    """
    for width in (1080, 1000, 900, 820):
        _open(page, running_server, width, 760)
        box = page.evaluate(GEOMETRY)
        # 堆叠的判据是"检查器落到了工作台下方"，不是 grid-template —— 那个断言
        # 上一版写了，结果 ≤1080 仍然是 5 列 grid（靠 grid-column 跨列堆的）。
        assert box["inspectorTop"] > box["canvasBottom"], (width, "没有堆叠", box)
        assert box["dockClip"] <= 1, (width, f"dock 内容被裁 {box['dockClip']}px", box)
        sizes = page.evaluate(
            """() => {
                const h = (s) => Math.round(document.querySelector(s).getBoundingClientRect().height);
                return { dock: h('.animation-dock'), frame: h('.canvas-frame'),
                         // 只量渲染出来的按钮：组条里那几个在没有模板时是设计性隐藏的，
                         // 把 0 高度的隐藏控件算进"不该被压扁"会误报
                         buttons: Array.from(document.querySelectorAll('.animation-dock button'))
                             .filter((b) => b.offsetParent !== null)
                             .map((b) => Math.round(b.getBoundingClientRect().height)) };
            }"""
        )
        assert sizes["dock"] >= 60, (width, sizes)
        assert sizes["frame"] <= 760 * 0.62, (width, sizes)
        assert sizes["buttons"] and min(sizes["buttons"]) >= 18, (width, sizes)
