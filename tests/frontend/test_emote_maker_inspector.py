"""右侧检视栏「调整」页 + 导出提示环的行为。

两条都是真故障换来的：
1. 拖动滑杆时整块 DOM 被重建 —— 滚动容器内容瞬间变矮，scrollTop 被夹小，
   于是"一拖就跳回最上面"。
2. 「覆盖默认值」关着时四条滑杆根本不参与绘制，但导入了模板就永远不禁用，
   看上去就是"滑杆坏了 / 重置没有作用"。
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest
from playwright.sync_api import Page


def _synthetic_template() -> bytes:
    """和 tests/unit/test_emote_template_adapter.py 同一形状的元数据模板。

    骨骼/贴图是假的，所以 Spine 运行时起不来 —— 这正是要的状态：模板已导入、
    catalogs.sliders 有内容，但没有原生渲染器。
    """
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        root = "wrapper/EmoteLab"
        archive.writestr(f"{root}/SpineModels/Demo/model.meta.json",
                         json.dumps({"DisplayName": "Demo", "SharedModelKey": "Demo"}))
        archive.writestr(f"{root}/SpineModels/Demo/Demo.skel.bytes", b"4.3.23")
        archive.writestr(f"{root}/SpineModels/Demo/Demo.atlas.txt", "Page.png\nsize: 2, 3\n")
        archive.writestr(f"{root}/SpineModels/Demo/Page.png", b"not-a-png")
        archive.writestr(f"{root}/SpineModels/Demo/DisplayInfo/Animations.csv",
                         "AnimationName,DisplayName,en\nANIM/Demo,Demo,Demo\n")
        archive.writestr(f"{root}/SpineModels/Demo/DisplayInfo/SkinGroups.csv",
                         "GroupName,DisplayName,en\nHair,Hair,Hair\n")
        archive.writestr(f"{root}/SpineModels/Demo/DisplayInfo/Sliders.csv",
                         "SliderName,DisplayName,en\nCharacter/X,X,X\n")
        archive.writestr(f"{root}/SpineModels/Demo/DisplayInfo/SlotGroups.csv",
                         "GroupName,DisplayName,en\nBody,Body,Body\n")
        archive.writestr(f"{root}/Characters/Demo/Demo.json", json.dumps({
            "SharedModelKey": "Demo",
            "ActiveSkins": {"Items": [{"Key": "Hair", "Value": "A"}]},
            "SliderConstraints": [],
            "SlotGroups": [],
        }))
        archive.writestr(f"{root}/SceneLists/Demo/Demo.json", json.dumps({
            "sharedModelKey": "Demo",
            "scenes": [{
                "name": "One",
                "animationName": "ANIM/Demo",
                "cameraPosition": {"x": 1, "y": 2, "z": 3},
                "model": {},
                "texts": [],
            }],
        }))
    return stream.getvalue()


@pytest.fixture()
def adjust_page(page: Page, running_server: str) -> Page:
    page.goto(f"{running_server}/emote_maker", wait_until="networkidle")
    page.wait_for_function("() => Boolean(document.querySelector('#adjust-x'))", timeout=15000)
    page.set_input_files("#emotelab-template-file", {
        "name": "demo.zip",
        "mimeType": "application/zip",
        "buffer": _synthetic_template(),
    })
    page.wait_for_function(
        "() => document.body.classList.contains('editor-has-template')", timeout=25000)
    page.evaluate("() => document.querySelector('#inspector-tab-adjust').click()")
    return page


def test_template_loaded_and_has_its_own_sliders(adjust_page: Page) -> None:
    """前置：合成模板真的把滑块区填上了 —— 后面两条断言才有意义。"""
    rows = adjust_page.evaluate(
        "() => document.querySelectorAll('#template-slider-controls .template-slider-row').length")
    assert rows >= 1, "模板滑块区没内容，后面的\"不重建\"断言会是空断言"


def test_dragging_a_slider_does_not_rebuild_the_panel(adjust_page: Page) -> None:
    """拖动滑杆只许改读数：一个节点都不许被换掉（换掉就会把滚动位置夹回去）。"""
    outcome = adjust_page.evaluate(r"""() => {
        const host = document.querySelector('#template-slider-controls');
        const keepAlive = host.querySelector('.template-slider-row');
        let rebuilds = 0;
        const observer = new MutationObserver((records) => {
            records.forEach((r) => { rebuilds += r.addedNodes.length + r.removedNodes.length; });
        });
        observer.observe(host, { childList: true, subtree: true });
        const input = document.querySelector('#adjust-x');
        input.value = '40';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        observer.takeRecords();
        observer.disconnect();
        return {
            rebuilds,
            readout: document.querySelector('#adjust-x-value').textContent,
            sameRow: keepAlive === host.querySelector('.template-slider-row'),
            inputValue: document.querySelector('#adjust-x').value,
        };
    }""")
    assert outcome["rebuilds"] == 0, f"拖动滑杆重建了滑块区（{outcome['rebuilds']} 个节点）：滚动会被夹回顶部"
    assert outcome["sameRow"] is True, "滑块行被换成了新节点"
    assert outcome["readout"] == "40", outcome
    assert outcome["inputValue"] == "40", "读数改了却把滑杆本身弹回去了"


def test_reset_is_only_offered_when_there_is_something_to_reset(adjust_page: Page) -> None:
    """重置：有东西可复位才可点，复位完自己灰回去（不再是个按了没反应的按钮）。"""
    adjust_page.evaluate("""() => {
        const input = document.querySelector('#adjust-x');
        input.value = '40';
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }""")
    assert adjust_page.evaluate("() => document.querySelector('#reset-adjustments-btn').disabled") is False
    adjust_page.evaluate("() => document.querySelector('#reset-adjustments-btn').click()")
    assert adjust_page.evaluate("() => document.querySelector('#adjust-x-value').textContent") == "0"
    assert adjust_page.evaluate("() => document.querySelector('#reset-adjustments-btn').disabled") is True, \
        "已经全是默认值，重置还留着可点 —— 按下去什么都不动就是\"没作用\"的观感"


def test_unchecking_overwrite_greys_out_the_inert_sliders(adjust_page: Page) -> None:
    """「覆盖默认值」关着时四条滑杆不参与绘制，就必须禁用 —— 而不是让人拖一条不动的滑杆。"""
    adjust_page.evaluate("""() => {
        const box = document.querySelector('#adjust-overwrite');
        box.checked = false;
        box.dispatchEvent(new Event('change', { bubbles: true }));
    }""")
    states = adjust_page.evaluate(
        "() => ['x','y','rotation','scale'].map(k => document.querySelector(`#adjust-${k}`).disabled)")
    assert states == [True, True, True, True], f"关掉覆盖默认值后滑杆还能拖: {states}"
    # 就算绕过禁用直接派发（Alt+滚轮就是这么改的），也不该偷偷改到值
    changed = adjust_page.evaluate("""() => {
        const input = document.querySelector('#adjust-x');
        input.value = '70';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return { readout: document.querySelector('#adjust-x-value').textContent };
    }""")
    assert changed["readout"] == "0", f"开关关着时仍在改调整值: {changed}"


def test_drop_hint_ring_is_gone_once_the_breathe_finishes(page: Page, running_server: str) -> None:
    """呼吸完就该消失：`.is-drop-hint` 上不能再留静态 border-color。

    这条查的是**已生效的样式表**而不是屏幕：形象包面板要求 Spine 运行时可用才渲染
    （`renderPackPanel` 里的 `available`），合成模板没有可用的骨骼，用元素断言会
    变成悄悄跳过。故障本身就是那条静态值 —— 动画跑完两下之后它还在，于是虚线一直
    亮到松手。查 CSSOM 同样能抓住，而且带上这份文件里"同名规则后面那条才算"的坑。
    """
    page.goto(f"{running_server}/emote_maker", wait_until="networkidle")
    seen = page.evaluate(r"""() => {
        const alphaOf = (value) => {
            const parts = String(value || '').match(/[\d.]+/g);
            if (!parts) return null;
            return parts.length >= 4 ? Number(parts[3]) : 1;
        };
        let hint = null, base = null, keyframes = null;
        for (const sheet of document.styleSheets) {
            let rules;
            try { rules = sheet.cssRules; } catch (_) { continue; }
            for (const rule of rules || []) {
                const sel = String(rule.selectorText || '');
                if (sel === '#pack-basic-rows.is-drop-hint') {
                    // 后写的同名规则才算数：取最后一条
                    hint = { border: rule.style.getPropertyValue('border-color')
                        || rule.style.getPropertyValue('border-top-color'),
                        name: rule.style.getPropertyValue('animation-name') };
                } else if (sel === '#pack-basic-rows') {
                    base = rule.style.getPropertyValue('border-color')
                        || rule.style.getPropertyValue('border-top-color');
                } else if (rule.type === CSSRule.KEYFRAMES_RULE && rule.name === 'pack-drop-hint-breathe') {
                    // 关键帧按声明顺序排，"0%, 100%" 会在第一条 —— 要找的是含 100% 的那条
                    const end = [...rule.cssRules]
                        .find((k) => k.keyText.split(',').map((t) => t.trim()).includes('100%'));
                    keyframes = { steps: rule.cssRules.length,
                        lastSelector: end ? end.keyText : '',
                        lastColor: end ? end.style.getPropertyValue('border-color') : '' };
                }
            }
        }
        return { hint, base, keyframes };
    }""")
    assert seen["hint"], "没找到 .is-drop-hint 规则，这条会空过"
    assert seen["hint"]["name"] == "pack-drop-hint-breathe", seen["hint"]
    assert seen["hint"]["border"] == "", \
        f"呼吸结束后静态 border-color 会让虚线留在原地: {seen['hint']}"
    assert seen["base"] and alpha_of_seen(seen["base"]) == 0, f"默认态就该透明: {seen['base']}"
    assert seen["keyframes"]["lastSelector"] in ("100%", "0%, 100%"), seen["keyframes"]
    assert alpha_of_seen(seen["keyframes"]["lastColor"]) == 0, \
        f"动画的收尾键不是透明，播完会留下可见的边框: {seen['keyframes']}"


def alpha_of_seen(value: str) -> float:
    parts = [p for p in __import__("re").findall(r"[\d.]+", str(value or ""))]
    if not parts:
        return -1
    return float(parts[3]) if len(parts) >= 4 else 1.0
