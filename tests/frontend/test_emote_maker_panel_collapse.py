"""两侧面板贴边与悬停收起/展开。

断言一律看渲染结果（computed style / 屏幕矩形 / 网格类名），
不看内部属性——这条纪律已经救过三次假绿。
"""

from __future__ import annotations

import io
import json
import zipfile

from playwright.sync_api import Page

SESSION_KEY = "neko-emote-maker-layout"


def _template(display_name: str = "演示", slot: str = "A", scenes: int = 2) -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        root, model = "wrapper/EmoteLab", f"Model{slot}"
        archive.writestr(f"{root}/SpineModels/{model}/model.meta.json",
                         json.dumps({"DisplayName": display_name, "SharedModelKey": model}))
        archive.writestr(f"{root}/SpineModels/{model}/{model}.skel.bytes", b"4.3.23")
        archive.writestr(f"{root}/SpineModels/{model}/{model}.atlas.txt", "Page.png\nsize: 2, 3\n")
        archive.writestr(f"{root}/SpineModels/{model}/Page.png", b"not-a-png")
        archive.writestr(f"{root}/SpineModels/{model}/DisplayInfo/Animations.csv",
                         "AnimationName,DisplayName,en\nANIM/A,Demo,Demo\n")
        archive.writestr(f"{root}/Characters/{model}/{model}.json", json.dumps({
            "SharedModelKey": model, "ActiveSkins": {"Items": []},
            "SliderConstraints": [], "SlotGroups": [],
        }))
        archive.writestr(f"{root}/SceneLists/{model}/{model}.json", json.dumps({
            "sharedModelKey": model,
            "scenes": [{"name": f"场景{i}", "animationName": "ANIM/A",
                        "cameraPosition": {"x": i, "y": 2, "z": 3}, "model": {}, "texts": []}
                       for i in range(scenes)],
        }))
    return stream.getvalue()


def _panel_state(page: Page, side: str) -> dict:
    sel = ".asset-panel" if side == "left" else ".inspector-panel"
    return page.evaluate("""([sel]) => {
        const panel = document.querySelector(sel);
        const grid = document.querySelector('.maker-grid');
        const r = panel.getBoundingClientRect();
        return {
            width: Math.round(r.width),
            visible: getComputedStyle(panel).visibility !== 'hidden',
            radius: getComputedStyle(panel).borderTopLeftRadius,
            collapsed: grid.classList.contains(sel === '.asset-panel' ? 'left-collapsed' : 'right-collapsed'),
        };
    }""", [sel])


def _toggle_state(page: Page, side: str) -> dict:
    sel = "#panel-toggle-left" if side == "left" else "#panel-toggle-right"
    return page.evaluate("""([sel]) => {
        const btn = document.querySelector(sel);
        const r = btn.getBoundingClientRect();
        const cs = getComputedStyle(btn);
        return { left: Math.round(r.left), right: Math.round(window.innerWidth - r.right),
                 opacity: Number(cs.opacity), expanded: btn.getAttribute('aria-expanded') };
    }""", [sel])


def test_panels_are_flush_with_square_corners(page: Page, running_server: str) -> None:
    page.goto(f"{running_server}/emote_maker", wait_until="networkidle")
    page.set_input_files("#emotelab-template-file", {
        "name": "first.zip", "mimeType": "application/zip", "buffer": _template(),
    })
    page.wait_for_function("() => document.body.classList.contains('editor-has-template')",
                           timeout=25000)
    edges = page.evaluate("""() => {
        const page0 = document.querySelector('.emote-maker-page').getBoundingClientRect();
        const asset = document.querySelector('.asset-panel').getBoundingClientRect();
        const inspector = document.querySelector('.inspector-panel').getBoundingClientRect();
        return {
            leftGap: Math.round(asset.left - page0.left),
            rightGap: Math.round(page0.right - inspector.right),
            assetRadius: getComputedStyle(document.querySelector('.asset-panel')).borderTopLeftRadius,
            inspectorRadius: getComputedStyle(document.querySelector('.inspector-panel')).borderTopRightRadius,
        };
    }""")
    assert edges["leftGap"] == 0 and edges["rightGap"] == 0, f"面板没贴到窗口边缘: {edges}"
    assert edges["assetRadius"] == "0px" and edges["inspectorRadius"] == "0px", edges
    # 只有贴窗那侧是直角，内侧保持圆角
    corners = page.evaluate("""() => ({
        assetOuter: getComputedStyle(document.querySelector('.asset-panel')).borderTopLeftRadius,
        assetInner: getComputedStyle(document.querySelector('.asset-panel')).borderTopRightRadius,
        inspectorOuter: getComputedStyle(document.querySelector('.inspector-panel')).borderTopRightRadius,
        inspectorInner: getComputedStyle(document.querySelector('.inspector-panel')).borderTopLeftRadius,
    })""")
    assert corners == {"assetOuter": "0px", "assetInner": "16px",
                       "inspectorOuter": "0px", "inspectorInner": "16px"}, corners


def test_hover_reveals_and_click_collapses_and_expands(page: Page, running_server: str) -> None:
    page.goto(f"{running_server}/emote_maker", wait_until="networkidle")
    # 右侧面板在空态下不存在（editor-empty 藏了它），两侧流程都要模板在场
    page.set_input_files("#emotelab-template-file", {
        "name": "first.zip", "mimeType": "application/zip", "buffer": _template(),
    })
    page.wait_for_function("() => document.body.classList.contains('editor-has-template')",
                           timeout=25000)

    def handle(side: str):
        sel = "#panel-toggle-left" if side == "left" else "#panel-toggle-right"
        return f"document.querySelector('{sel}')"

    def wait_state(side: str, collapsed: bool) -> None:
        cls = "left-collapsed" if side == "left" else "right-collapsed"
        want = "true" if collapsed else "false"
        page.wait_for_function(
            f"() => document.querySelector('.maker-grid').classList.contains('{cls}')"
            f"        === {want}", timeout=10000)

    before = _panel_state(page, "left")
    assert before["visible"] and not before["collapsed"], before

    # 把手默认缩着：只露一点（左把手缩进后右缘在面板右缘内），钉在面板顶部
    tucked = page.evaluate("""() => {
        const btn = document.querySelector('#panel-toggle-left');
        const panel = document.querySelector('.asset-panel').getBoundingClientRect();
        return { btnLeft: btn.getBoundingClientRect().left,
                 panelRight: panel.right,
                 top: Math.round(btn.getBoundingClientRect().top - panel.top) };
    }""")
    assert tucked["btnLeft"] < tucked["panelRight"], f"把手默认该缩着: {tucked}"
    assert tucked["top"] < 30, f"把手该在面板顶部: {tucked}"

    for side, panel_sel in (("left", ".asset-panel"), ("right", ".inspector-panel")):
        # 折叠：真实鼠标悬停面板 → :hover 生效 → 把手滑出（transform 归零）；
        # 点击用 el.click() 直派——locator.click 的可操作性循环会与把手回缩互相追逐，
        # 那是工具层问题；这里验证的是"悬停滑出"和"点击切换"两件事各自成立。
        center = page.evaluate(
            """(sel) => { const r = document.querySelector(sel).getBoundingClientRect();
                         return { x: Math.round(r.left + r.width / 2),
                                  y: Math.round(r.top + r.height / 2) }; }""", panel_sel)
        page.mouse.move(center["x"], center["y"])
        sel_js = handle(side)
        page.wait_for_function(
            f"() => getComputedStyle({sel_js}).transform === 'matrix(1, 0, 0, 1, 0, 0)'",
            timeout=3000)
        page.evaluate(f"{sel_js}.click()")
        wait_state(side, True)
        state = _panel_state(page, side)
        assert state["collapsed"] and state["width"] == 0, state
        # 折叠后把手缩回窗口边缘只露一点（左侧缩到视口外，右侧贴缘露头）
        if side == "left":
            page.wait_for_function(
                "() => document.querySelector('#panel-toggle-left').getBoundingClientRect().left < 0",
                timeout=3000)
        else:
            page.wait_for_function(
                "() => { const r = document.querySelector('#panel-toggle-right').getBoundingClientRect();"
                "          return window.innerWidth - r.right <= 30 && r.left >= window.innerWidth - 30; }",
                timeout=3000)
        # 展开：把手滑出（把鼠标挪到露出条上，真实 :hover）后直派点击
        # 露出条坐标：左钮取裁剪条左缘内 3px，右钮取右缘内 3px（在 Python 里算好）
        edge = "c.left + 3" if side == "left" else "c.right - 3"
        sliver = page.evaluate(
            f"""() => {{ const c = {handle(side)}.parentElement.getBoundingClientRect();
                     return {{ x: Math.min(window.innerWidth - 1, Math.max(1, Math.round({edge}))),
                              y: Math.round(c.top + c.height / 2) }}; }}""")
        page.mouse.move(sliver["x"], sliver["y"])
        page.wait_for_function(
            f"() => getComputedStyle({handle(side)}).transform === 'matrix(1, 0, 0, 1, 0, 0)'",
            timeout=3000)
        page.evaluate(f"{handle(side)}.click()")
        wait_state(side, False)
        assert _panel_state(page, side)["width"] > 200
def _slide_out_helper_unused():
    pass
def test_collapse_survives_a_reload(page: Page, running_server: str) -> None:
    """折叠状态进布局存档，跨重启保持。交互细节由上一条用例管，这里只管持久化。"""
    page.goto(f"{running_server}/emote_maker", wait_until="networkidle")
    page.wait_for_function("() => Boolean(document.querySelector('#panel-toggle-left'))", timeout=15000)
    page.evaluate("document.querySelector('#panel-toggle-left').click()")
    page.wait_for_function(
        "() => document.querySelector('.maker-grid').classList.contains('left-collapsed')",
        timeout=10000)
    page.reload(wait_until="networkidle")
    page.wait_for_function(
        "() => document.querySelector('.maker-grid').classList.contains('left-collapsed')",
        timeout=15000)
    stored = json.loads(page.evaluate("(k) => localStorage.getItem(k)", SESSION_KEY) or "{}")
    assert stored.get("panelLeftCollapsed") is True, stored
    # 还原，别把别的用例带进折叠态
    page.evaluate("document.querySelector('#panel-toggle-left').click()")
    page.wait_for_function(
        "() => !document.querySelector('.maker-grid').classList.contains('left-collapsed')",
        timeout=10000)