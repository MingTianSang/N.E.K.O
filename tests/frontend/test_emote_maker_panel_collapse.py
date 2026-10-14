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


def test_hover_reveals_and_click_collapses_and_expands(page: Page, running_server: str) -> None:
    page.goto(f"{running_server}/emote_maker", wait_until="networkidle")
    # 右侧面板在空态下整个不存在（editor-empty 把它藏了），两侧流程都要模板在场
    page.set_input_files("#emotelab-template-file", {
        "name": "first.zip", "mimeType": "application/zip", "buffer": _template(),
    })
    page.wait_for_function("() => document.body.classList.contains('editor-has-template')",
                           timeout=25000)
    page.wait_for_function("() => Boolean(document.querySelector('#panel-toggle-left'))", timeout=15000)

    before = _panel_state(page, "left")
    assert before["visible"] and not before["collapsed"], before
    # 未悬停时按钮隐身
    assert _toggle_state(page, "left")["opacity"] == 0

    page.hover(".asset-panel")
    page.wait_for_function(
        "() => getComputedStyle(document.querySelector('#panel-toggle-left')).opacity === '1'",
        timeout=3000)
    shown = _toggle_state(page, "left")
    assert shown["opacity"] == 1, f"悬停面板后收起钮没浮现: {shown}"

    page.click("#panel-toggle-left")
    page.wait_for_function(
        "() => document.querySelector('.maker-grid').classList.contains('left-collapsed')",
        timeout=10000)
    collapsed_panel = _panel_state(page, "left")
    assert collapsed_panel["collapsed"] and not collapsed_panel["visible"], collapsed_panel
    assert collapsed_panel["width"] == 0, collapsed_panel
    collapsed_btn = _toggle_state(page, "left")
    assert collapsed_btn["left"] == 0, f"展开钮没钉在窗口左缘: {collapsed_btn}"
    assert collapsed_btn["expanded"] == "false"
    # 展开钮默认隐身，靠近才现身（点击后指针还压在钮上，先挪开再量）
    page.mouse.move(600, 300)
    page.wait_for_function(
        "() => getComputedStyle(document.querySelector('#panel-toggle-left')).opacity === '0'",
        timeout=3000)
    page.hover("#panel-toggle-left")
    page.wait_for_function(
        "() => getComputedStyle(document.querySelector('#panel-toggle-left')).opacity === '1'",
        timeout=3000)
    assert _toggle_state(page, "left")["opacity"] == 1

    # 展开还原：宽度回存档值
    page.click("#panel-toggle-left")
    page.wait_for_function(
        "() => !document.querySelector('.maker-grid').classList.contains('left-collapsed')",
        timeout=10000)
    restored = _panel_state(page, "left")
    assert restored["visible"] and restored["width"] > 200, restored

    # 右侧同流程
    page.hover(".inspector-panel")
    page.click("#panel-toggle-right")
    page.wait_for_function(
        "() => document.querySelector('.maker-grid').classList.contains('right-collapsed')",
        timeout=10000)
    right_collapsed = _panel_state(page, "right")
    assert right_collapsed["collapsed"] and right_collapsed["width"] == 0, right_collapsed
    assert _toggle_state(page, "right")["right"] == 0, "右侧展开钮没钉在窗口右缘"
    page.click("#panel-toggle-right")
    page.wait_for_function(
        "() => !document.querySelector('.maker-grid').classList.contains('right-collapsed')",
        timeout=10000)
    assert _panel_state(page, "right")["width"] > 200


def test_collapse_survives_a_reload(page: Page, running_server: str) -> None:
    page.goto(f"{running_server}/emote_maker", wait_until="networkidle")
    page.wait_for_function("() => Boolean(document.querySelector('#panel-toggle-left'))", timeout=15000)
    page.click("#panel-toggle-left")
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
    page.click("#panel-toggle-left")
    page.wait_for_function(
        "() => !document.querySelector('.maker-grid').classList.contains('left-collapsed')",
        timeout=10000)
