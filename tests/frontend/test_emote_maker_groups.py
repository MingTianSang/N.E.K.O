"""分组导出：组住在导出设置里，预览下方只剩一份动画列表。

断言一律看渲染结果（getComputedStyle / 屏幕上真有哪几个选项 / 点得到点不到），
不看内部属性或模块变量 —— 上一轮我因为查 `el.hidden` 写了条假通过的测试。
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest
from playwright.sync_api import Page

SESSION_KEY = "neko-emote-maker-last-template"


def _template(display_name: str, slot: str, scenes: int = 2) -> bytes:
    """元数据形状的 EmoteLab 包：骨骼/贴图是假的，所以 Spine 渲染器起不来。

    这正好够用 —— 组的建立/加入/存取景都不依赖渲染器，而"整组导出"必须被护栏拦住，
    这条护栏也就顺带验掉了。
    """
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        root = "wrapper/EmoteLab"
        model = f"Model{slot}"
        archive.writestr(f"{root}/SpineModels/{model}/model.meta.json",
                         json.dumps({"DisplayName": display_name, "SharedModelKey": model}))
        archive.writestr(f"{root}/SpineModels/{model}/{model}.skel.bytes", b"4.3.23")
        archive.writestr(f"{root}/SpineModels/{model}/{model}.atlas.txt", "Page.png\nsize: 2, 3\n")
        archive.writestr(f"{root}/SpineModels/{model}/Page.png", b"not-a-png")
        archive.writestr(f"{root}/SpineModels/{model}/DisplayInfo/Animations.csv",
                         "AnimationName,DisplayName,en\nANIM/Demo,Demo,Demo\n")
        archive.writestr(f"{root}/SpineModels/{model}/DisplayInfo/SkinGroups.csv",
                         "GroupName,DisplayName,en\nHair,Hair,Hair\n")
        archive.writestr(f"{root}/SpineModels/{model}/DisplayInfo/Sliders.csv",
                         "SliderName,DisplayName,en\nCharacter/X,X,X\n")
        archive.writestr(f"{root}/SpineModels/{model}/DisplayInfo/SlotGroups.csv",
                         "GroupName,DisplayName,en\nBody,Body,Body\n")
        archive.writestr(f"{root}/Characters/{model}/{model}.json", json.dumps({
            "SharedModelKey": model,
            "ActiveSkins": {"Items": [{"Key": "Hair", "Value": "A"}]},
            "SliderConstraints": [],
            "SlotGroups": [],
        }))
        archive.writestr(f"{root}/SceneLists/{model}/{model}.json", json.dumps({
            "sharedModelKey": model,
            "scenes": [{
                "name": f"{display_name}-{i}",
                "animationName": "ANIM/Demo",
                "cameraPosition": {"x": i, "y": 2, "z": 3},
                "model": {},
                "texts": [],
            } for i in range(scenes)],
        }))
    return stream.getvalue()


def _open_export_tab(page: Page) -> None:
    page.evaluate("() => document.querySelector('#inspector-tab-export').click()")


def _import(page: Page, file_name: str, display_name: str, slot: str, scenes: int = 2) -> None:
    page.set_input_files("#emotelab-template-file", {
        "name": file_name,
        "mimeType": "application/zip",
        "buffer": _template(display_name, slot, scenes),
    })
    page.wait_for_function("() => document.body.classList.contains('editor-has-template')",
                           timeout=25000)
    _open_export_tab(page)
    page.wait_for_function(
        "() => getComputedStyle(document.querySelector('#group-section')).display !== 'none'",
        timeout=15000)


@pytest.fixture()
def group_page(page: Page, running_server: str) -> Page:
    page.goto(f"{running_server}/emote_maker", wait_until="networkidle")
    page.wait_for_function("() => Boolean(document.querySelector('#group-section'))", timeout=15000)
    _import(page, "first.zip", "第一个", "A", scenes=3)
    return page


def _shown(page: Page, selector: str) -> bool:
    return page.evaluate(
        """(sel) => {
            const el = document.querySelector(sel);
            return Boolean(el) && getComputedStyle(el).display !== 'none';
        }""", selector)


def _options(page: Page) -> list[str]:
    return page.evaluate(
        """() => [...document.querySelectorAll('#template-scene-list-select option')]
            .map((o) => o.textContent.trim())""")


def test_dock_is_one_list_now_that_group_moved(page: Page, running_server: str) -> None:
    """预览下方只留一份列表：以前两栏印的是同一批名字，差别看不出来。"""
    page.goto(f"{running_server}/emote_maker", wait_until="networkidle")
    _import(page, "first.zip", "第一个", "A", scenes=3)
    assert _shown(page, '.list-segment') is False, "场景/动画 两栏开关还在"
    assert _shown(page, '#anim-seg-scenes') is False
    assert page.evaluate("() => document.querySelector('#anim-dock-title').textContent.trim()") == "动作"
    # 组那一块不该在预览下方
    assert page.evaluate(
        """() => {
            const dock = document.querySelector('.animation-dock');
            return Boolean(dock.querySelector('.group-bar') || dock.querySelector('#new-group-btn'));
        }""") is False, "组的操作还留在预览下方"


def test_group_section_lives_in_export_settings(group_page: Page) -> None:
    assert _shown(group_page, '#group-section') is True
    assert _shown(group_page, '#new-group-btn') is True
    options = _options(group_page)
    # 下拉里没有"全部场景"这一项了：它不是组，只是以前的过滤器默认值
    assert "全部场景" not in options, options
    assert any(option.startswith("ModelA") for option in options), \
        f"导入模板自带的 SceneList 没作为一个组出现: {options}"
    # 没选组时自动选上第一组：空值的下拉会渲染成一片空白
    selected = group_page.evaluate(
        "() => document.querySelector('#template-scene-list-select').value")
    assert selected.startswith("list:"), f"首组没有自动选中: {selected!r}"
    state = group_page.evaluate("""() => {
        const shown = (sel) => {
            const el = document.querySelector(sel);
            return Boolean(el) && getComputedStyle(el).display !== 'none';
        };
        return {
            save: shown('#save-shot-btn'),
            // 导出入口已经搬到底部那排按钮里，组这一栏里不该再有一颗
            oldExport: Boolean(document.querySelector('#export-group-btn')),
            current: shown('#export-png-btn'),
            batch: shown('#export-group-open-btn'),
        };
    }""")
    # 还没选组时两个写动作照样给：按下去会顺手建一个组，比"先别按"少一步
    assert state["oldExport"] is False, "「导出本组」还留在批量导出里"
    assert state["current"] and state["batch"], "底部两颗导出按钮没并排出现"
    # 首组是导入的只读组：存为取景无处可写就该收着；
    # 加号（顶替「加入本组」的那颗）只住在空组提示里，此刻不该有
    assert group_page.evaluate(
        "() => Boolean(document.querySelector('#add-scene-to-group-btn'))") is False

def test_current_framing_line_is_gone(group_page: Page) -> None:
    """「当前画面：xxx」删了：它复述的是列表里已经选中的那一条，白占一行。"""
    assert group_page.evaluate("() => Boolean(document.querySelector('#group-current'))") is False
    assert "当前画面" not in group_page.evaluate(
        "() => document.querySelector('#group-section').textContent")


def test_export_entry_is_two_buttons_on_one_row(group_page: Page) -> None:
    """一行两个：导出当前 / 批量导出，宽度相当、等高。"""
    box = group_page.evaluate("""() => {
        const a = document.querySelector('#export-png-btn').getBoundingClientRect();
        const b = document.querySelector('#export-group-open-btn').getBoundingClientRect();
        return { ay: Math.round(a.y), by: Math.round(b.y), aw: Math.round(a.width), bw: Math.round(b.width),
                 ah: Math.round(a.height), bh: Math.round(b.height),
                 label: document.querySelector('#export-png-btn span').textContent.trim(),
                 key: document.querySelector('#export-png-btn span').dataset.i18n,
                 batch: document.querySelector('#export-group-open-btn').textContent.trim() };
    }""")
    assert box["ay"] == box["by"], f"两颗按钮没在同一行: {box}"
    assert abs(box["aw"] - box["bw"]) <= 2, f"宽度不相当: {box}"
    assert abs(box["ah"] - box["bh"]) <= 2, f"高度不齐: {box}"
    assert box["batch"] == "批量导出", box
    # 导哪一张由这两颗说，出什么格式由上面的「格式」下拉说 —— 按钮上不再印 PNG/GIF。
    # 这份合成模板起不来渲染器，所以此刻按钮说的是"为什么不能导"，不是格式。
    assert box["key"] == "emoteMaker.exportCurrent", box
    assert box["label"] in ("导出当前", "预览暂不可用"), box
    assert "GIF" not in box["label"] and "PNG" not in box["label"], box


def test_batch_button_opens_a_group_picker_above_it(group_page: Page) -> None:
    """点「批量导出」在按钮上方长出气泡，一行一个组；点外面收起。"""
    group_page.evaluate("() => document.querySelector('#export-group-open-btn').click()")
    opened = group_page.evaluate("""() => {
        const picker = document.querySelector('#group-export-picker');
        const trigger = document.querySelector('#export-group-open-btn').getBoundingClientRect();
        const box = picker.getBoundingClientRect();
        return {
            hidden: picker.hidden, display: getComputedStyle(picker).display,
            expanded: document.querySelector('#export-group-open-btn').getAttribute('aria-expanded'),
            above: box.bottom <= trigger.top + 1,
            rows: [...picker.querySelectorAll('.group-picker-item')].map((r) => r.textContent),
            title: picker.querySelector('.group-picker-title').textContent.trim(),
        };
    }""")
    assert opened["display"] != "none" and opened["hidden"] is False, f"气泡没开: {opened}"
    assert opened["expanded"] == "true", opened
    assert opened["above"] is True, f"气泡没长在按钮上方: {opened}"
    assert opened["title"] == "选择要导出的组", opened
    assert len(opened["rows"]) >= 1, f"气泡里没有组: {opened}"
    assert any("ModelA" in row for row in opened["rows"]), opened
    assert any("张" in row for row in opened["rows"]), f"每一行要说清几张: {opened}"

    group_page.mouse.click(200, 300)
    group_page.wait_for_function(
        "() => document.querySelector('#group-export-picker').hidden", timeout=10000)


def test_picker_rows_are_blocked_with_a_reason_without_a_renderer(group_page: Page) -> None:
    """跑不起预览时整组导出保证不了每张不同：行要灰，而且要当场说明原因。"""
    group_page.evaluate("() => document.querySelector('#export-group-open-btn').click()")
    state = group_page.evaluate("""() => {
        const picker = document.querySelector('#group-export-picker');
        const note = picker.querySelector('.group-picker-note');
        const shown = (el) => Boolean(el) && getComputedStyle(el).display !== 'none';
        return {
            allDisabled: [...picker.querySelectorAll('.group-picker-item')].every((r) => r.disabled),
            note: note ? note.textContent.trim() : '',
            noteShown: shown(note),
        };
    }""")
    assert state["allDisabled"] is True, "没有运行时却还能按整组导出"
    assert "预览没跑起来" in state["note"], f"灰掉却没说为什么: {state}"
    assert state["noteShown"] is True


def test_create_group_from_current_keeps_the_setup(group_page: Page) -> None:
    """「按当前配置创建组」：建组的同时要把当前画面（含大小/角度）作为第一条存进去。"""
    # 先把缩放/旋转调开默认值，再看它们有没有被带走
    group_page.evaluate("""() => {
        const set = (key, value) => {
            const el = document.querySelector(`#adjust-${key}`);
            el.disabled = false;
            el.value = String(value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        document.querySelector('#adjust-overwrite').checked = true;
        document.querySelector('#adjust-overwrite').dispatchEvent(new Event('change', { bubbles: true }));
        set('scale', 118);
        set('rotation', -12);
    }""")
    group_page.evaluate("() => document.querySelector('#new-group-btn').click()")
    group_page.wait_for_function(
        "() => document.querySelectorAll('#group-members .group-member').length === 1",
        timeout=10000)
    row = group_page.evaluate("""() => {
        const el = document.querySelector('#group-members .group-member');
        return {
            kind: el.querySelector('.group-member-kind').textContent,
            removable: Boolean(el.querySelector('.group-member-remove')),
        };
    }""")
    assert row["kind"] == "取景", f"建组时没把当前画面存成第一条: {row}"
    assert row["removable"] is True

    stored = json.loads(group_page.evaluate("(k) => localStorage.getItem(k)", SESSION_KEY) or "{}")
    shot = (stored.get("shots") or [{}])[0]
    transform = (shot.get("look") or {}).get("transform") or {}
    assert abs(float(transform.get("scale") or 0) - 1.18) < 0.01,         f"当前缩放没被带进组: {transform}"
    assert abs(float(transform.get("rotation") or 0) + 12) < 0.01,         f"当前旋转角度没被带进组: {transform}"

    # 再加入当前场景：组里应该多一条"场景"成员。
    # （这条组已有一条取景，不是空组——加号只住在空组提示里，这里走右键菜单加。）
    group_page.evaluate("""() => {
        const card = document.querySelectorAll('#animation-list [data-animation-id]')[0];
        const rect = card.getBoundingClientRect();
        card.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true, cancelable: true,
            clientX: Math.round(rect.left + 10), clientY: Math.round(rect.top + 10), button: 2,
        }));
    }""")
    group_page.evaluate("() => document.querySelector('#context-add-btn').click()")
    group_page.wait_for_function(
        "() => document.querySelectorAll('#group-members .group-member').length === 2",
        timeout=10000)
    kinds = group_page.evaluate(
        "() => [...document.querySelectorAll('#group-members .group-member-kind')].map(e => e.textContent)")
    assert kinds == ["取景", "动作"], kinds

    # 移出第一条，剩下的那条还在（移的是行，不是整个组）
    group_page.evaluate("() => document.querySelector('.group-member-remove').click()")
    group_page.wait_for_function(
        "() => document.querySelectorAll('#group-members .group-member').length === 1",
        timeout=10000)


def test_saving_the_current_framing_shows_up_as_a_member(group_page: Page) -> None:
    group_page.evaluate("() => document.querySelector('#new-group-btn').click()")
    group_page.wait_for_function("() => !document.querySelector('#save-shot-btn').hidden", timeout=10000)
    group_page.evaluate("() => document.querySelector('#save-shot-btn').click()")
    # 建组自带 1 条取景，再存一次应当变成 2 条
    group_page.wait_for_function(
        "() => document.querySelectorAll('#group-members .group-member').length === 2", timeout=10000)
    kind = group_page.evaluate(
        "() => document.querySelector('#group-members .group-member-kind').textContent")
    assert kind == "取景", kind
    stored = json.loads(group_page.evaluate("(k) => localStorage.getItem(k)", SESSION_KEY))
    shot = stored["shots"][-1]
    assert shot["sourceSceneId"], f"取景必须记住来源场景，否则导出时烘不出来: {shot}"
    assert "skins" in (shot.get("look") or {}), shot
    # 取景那条要能认出是哪个场景存的（名字里带场景名），别只有"取景"两个字
    assert "第一个" in group_page.evaluate(
        "() => document.querySelector('#group-members .group-member').textContent")


def test_groups_are_scoped_to_the_template(group_page: Page) -> None:
    """换一个模板，不该看见上一个模板的组，也不该把上一个模板的多选带过去。"""
    group_page.evaluate("() => document.querySelector('#new-group-btn').click()")
    group_page.wait_for_function(
        """() => {
            const stored = JSON.parse(localStorage.getItem('neko-emote-maker-last-template') || '{}');
            return (stored.groups || []).length === 1;
        }""", timeout=10000)
    group_page.evaluate("() => document.querySelector('#select-all-btn').click()")
    group_page.wait_for_function(
        "() => document.querySelectorAll('#animation-list .animation-card.is-picked').length > 0",
        timeout=10000)
    _import(group_page, "second.zip", "第二个", "B", scenes=2)
    after = json.loads(group_page.evaluate("(k) => localStorage.getItem(k)", SESSION_KEY) or "{}")
    assert not after.get("groups"), f"新模板继承了旧模板的组: {after.get('groups')}"
    assert not any("未命名组" in option for option in _options(group_page))
    picks = group_page.evaluate("""() => ({
        picked: document.querySelectorAll('#animation-list .animation-card.is-picked').length,
        count: document.querySelector('#list-select-count').textContent,
    })""")
    assert picks["picked"] == 0 and picks["count"] == "", \
        f"旧模板的多选还留在新模板上: {picks}"


def test_group_controls_are_not_flush_against_the_clip_edge(group_page: Page) -> None:
    """下拉以前总被削掉最左一像素：面板是滚动容器而左内边距是 0，控件正好压在裁剪边上。
    量的是屏幕上真有的间距，不是 outline-offset 那种代理值 —— 上一版就是查属性自证通过的。
    """
    box = group_page.evaluate("""() => {
        const select = document.querySelector('#template-scene-list-select');
        const panel = document.querySelector('#inspector-panel-export');
        const s = select.getBoundingClientRect();
        const p = panel.getBoundingClientRect();
        select.focus();
        return {
            slack: +(s.left - p.left).toFixed(2),
            outlineOffset: getComputedStyle(select).outlineOffset,
            overflowX: panel.scrollWidth > panel.clientWidth,
        };
    }""")
    assert box["slack"] >= 3, f"组下拉还贴着面板的裁剪边，左边那一条会被削掉: {box}"
    assert box["overflowX"] is False, f"组控件的焦点环把面板撑出横向滚动: {box}"
    # 内侧环（负 offset）才不会被 overflow:auto 切掉
    assert box["outlineOffset"].startswith('-'), f"焦点环画在盒子外面，会被面板裁掉: {box}"


def test_help_bubble_anchors_above_the_control(group_page: Page) -> None:
    """问号：悬停即出、钉在控件上方带尖角的气泡里——不是等半秒的 title，
    不跟鼠标乱飘，更不是点一下甩到页面底部。"""
    anchor = group_page.evaluate("""() => {
        const el = document.querySelector('#new-group-help');
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                 tip: el.dataset.tip || '' };
    }""")
    assert "旋转角度" in anchor["tip"], f"说明没挂到 ? 上: {anchor}"
    group_page.mouse.move(20, 20)
    group_page.mouse.move(anchor["x"], anchor["y"])
    shown = group_page.evaluate("""() => {
        const tip = document.querySelector('#emote-cursor-tip');
        const box = tip.getBoundingClientRect();
        return {
            display: getComputedStyle(tip).display, text: tip.textContent,
            top: box.top, left: box.left,
            viewH: document.documentElement.clientHeight,
            described: document.querySelector('#new-group-help').getAttribute('aria-describedby'),
        };
    }""")
    assert shown["display"] != "none" and shown["text"], f"悬停没出说明: {shown}"
    assert shown["top"] < shown["viewH"] - 120, f"说明跑到页面底部去了: {shown}"
    assert abs(shown["top"] - anchor["y"]) < 120, f"说明离控件太远: {shown}"
    # 钉在控件上方，不跟鼠标：气泡的位置只由控件决定
    group_page.mouse.move(anchor["x"] + 3, anchor["y"] + 2)
    again = group_page.evaluate("""() => {
        const box = document.querySelector('#emote-cursor-tip').getBoundingClientRect();
        return { top: box.top, left: box.left };
    }""")
    assert abs(again["top"] - shown["top"]) < 1 and abs(again["left"] - shown["left"]) < 1,         f"气泡跟着鼠标动了: {shown} → {again}"
    assert shown["described"] == "emote-cursor-tip", "读屏拿不到这条说明"
    # 点击不该再产生第二条 toast（眼睛在问号上，字却出现在脚边）
    group_page.evaluate("() => document.querySelector('#new-group-help').click()")
    group_page.wait_for_timeout(250)
    assert "旋转角度" not in group_page.evaluate(
        "() => document.querySelector('#emote-toast').textContent"), \
        "点一下又把说明甩到页面底部了"


def test_collapse_caret_is_a_graphic_that_turns_in_place(group_page: Page) -> None:
    """收起箭头：用字符 \203A 时墨迹不在行盒正中，转 90° 看着像在晃。改成居中的图形。"""
    caret_style = """() => {
        const cs = getComputedStyle(document.querySelector('.group-summary'), '::before');
        return { content: cs.content, mask: cs.maskImage || cs.webkitMaskImage,
                 origin: cs.transformOrigin, w: cs.width, h: cs.height, transform: cs.transform };
    }"""
    group_page.evaluate("() => { document.querySelector('#group-section').open = false; }")
    # 140ms 的旋转过渡：不等落地就量，读到的是"还在 90°"的中间值
    group_page.wait_for_timeout(260)
    closed = group_page.evaluate(caret_style)
    group_page.evaluate("() => { document.querySelector('#group-section').open = true; }")
    group_page.wait_for_timeout(260)
    opened = group_page.evaluate(caret_style)

    caret = closed
    assert "url(" in caret["mask"], f"箭头不是图形，还是拿字符顶的: {caret}"
    assert caret["content"] in ('""', 'none'), f"字符还留在 content 里: {caret}"
    assert caret["w"] == caret["h"], f"包围盒不是正方形，绕中心转就会歪: {caret}"
    # Chromium 会把 center 解析成 px：钉的是"原点落在盒子正中"，不是写法
    origin = [float(v[:-2]) for v in caret["origin"].split()[:2]]
    assert origin == [float(caret["w"][:-2]) / 2, float(caret["h"][:-2]) / 2], \
        f"旋转原点不在箭头正中: {caret}"
    assert caret["transform"] == "none", caret
    matrix = opened["transform"]
    assert matrix.startswith("matrix("), f"展开没转过来: {matrix}"
    parts = [float(x) for x in matrix[matrix.index("(") + 1:matrix.index(")")].split(",")]
    assert abs(parts[4]) < 0.01 and abs(parts[5]) < 0.01, f"旋转时发生了位移（看起来在晃）: {matrix}"


def test_create_group_button_does_not_look_like_a_link(group_page: Page) -> None:
    """「按当前配置创建组」以前是 .text-button：透明底、悬停下划线 —— 那是链接的样子，
    可它会真的建出一个组。得有按钮的体积。"""
    style = group_page.evaluate("""() => {
        const el = document.querySelector('#new-group-btn');
        const cs = getComputedStyle(el);
        return {
            borderWidth: cs.borderTopWidth, borderStyle: cs.borderTopStyle,
            background: cs.backgroundColor, radius: cs.borderTopLeftRadius,
            height: Math.round(el.getBoundingClientRect().height),
        };
    }""")
    assert float(style["borderWidth"][:-2]) >= 1 and style["borderStyle"] == "solid", style
    assert style["background"] not in ("rgba(0, 0, 0, 0)", "transparent"), \
        f"还是透明底，看着像链接: {style}"
    assert style["height"] >= 26, f"没有可点的体积: {style}"


def test_select_tools_share_the_heading_and_only_show_when_used(group_page: Page) -> None:
    """全选/取消全选：不再常驻、也不再自己占一行把列表压矮。"""
    place = group_page.evaluate("""() => {
        const tools = document.querySelector('#list-select-tools');
        const heading = document.querySelector('.quick-preview-heading');
        const hb = heading.getBoundingClientRect();
        const tb = tools.getBoundingClientRect();
        const list = document.querySelector('#animation-list').getBoundingClientRect();
        return {
            inHeading: heading.contains(tools),
            insideRow: tb.top >= hb.top - 1 && tb.bottom <= hb.bottom + 1,
            listBelowTools: list.top >= hb.bottom - 1,
            noneHidden: document.querySelector('#select-none-btn').hidden,
            toolsHidden: tools.hidden,
        };
    }""")
    assert place["inHeading"] and place["insideRow"], f"多选工具还自己占着一行: {place}"
    assert place["listBelowTools"], f"多选工具混进了列表区: {place}"
    assert place["toolsHidden"] is False, "有模板时不该整排藏掉"
    assert place["noneHidden"] is True, "一条都没选，就先别挂「取消全选」"

    group_page.evaluate("() => document.querySelector('#select-all-btn').click()")
    picked = group_page.evaluate("""() => {
        const tools = document.querySelector('#list-select-tools');
        return { visible: getComputedStyle(tools).display !== 'none',
                 noneHidden: document.querySelector('#select-none-btn').hidden,
                 count: document.querySelector('#list-select-count').textContent };
    }""")
    assert picked["visible"] is True and picked["noneHidden"] is False, picked
    assert "已选" in picked["count"], picked

    group_page.evaluate("() => document.querySelector('#select-none-btn').click()")
    group_page.wait_for_function(
        "() => document.querySelector('#select-none-btn').hidden", timeout=10000)
    assert group_page.evaluate(
        "() => document.querySelector('#list-select-count').textContent") == ""



def test_group_section_collapses_and_reopens(group_page: Page) -> None:
    """收起时整块内容让位，摘要上仍要看得见"攒的是哪一组、几张"。"""
    group_page.evaluate("() => document.querySelector('#new-group-btn').click()")
    group_page.wait_for_function(
        "() => document.querySelectorAll('#group-members .group-member').length === 1",
        timeout=10000)
    summary = group_page.evaluate(
        "() => document.querySelector('#group-summary-state').textContent")
    assert "未命名组" in summary and "1" in summary, summary

    state = group_page.evaluate("""() => {
        const details = document.querySelector('#group-section');
        const openH = Math.round(details.getBoundingClientRect().height);
        details.open = false;
        const closedH = Math.round(details.getBoundingClientRect().height);
        details.open = true;
        return { openH, closedH };
    }""")
    # 看高度而不是子元素的 display：details 收起时后代的 computed display 并不会变成 none
    assert state["closedH"] < state["openH"] - 40, f"收起没让出位置: {state}"
    # 折叠状态要活到下次打开页面
    group_page.evaluate("""() => {
        const details = document.querySelector('#group-section');
        details.open = false;
        details.dispatchEvent(new Event('toggle'));
    }""")
    group_page.wait_for_timeout(200)
    saved = group_page.evaluate(
        "() => JSON.parse(localStorage.getItem('neko-emote-maker-layout') || '{}').groupPanelOpen")
    assert saved is False, f"收起状态没存下来: {saved}"


def _open_context_menu(page: Page, index: int) -> None:
    """在没有 Spine 运行时的那张卡上，卡片本身是 disabled 的：真右键浏览器不会派事件。
    这里直接派发同一个 contextmenu 事件，走的是同一条处理函数 —— 真鼠标右键要拿
    能渲染的模板人肉验一次，这条用例覆盖不到那半步。
    """
    page.evaluate(
        """(i) => {
            const card = document.querySelectorAll('#animation-list [data-animation-id]')[i];
            const rect = card.getBoundingClientRect();
            card.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true, cancelable: true,
                clientX: Math.round(rect.left + 10), clientY: Math.round(rect.top + 10),
                button: 2,
            }));
        }""", index)




def test_gif_format_hides_1024_and_the_removed_notes_stay_gone(group_page: Page) -> None:
    """GIF 时 1024 直接不可见；这轮清掉的几处提示不许还魂。"""
    group_page.evaluate("""() => {
        const format = document.querySelector('#export-format');
        format.value = 'gif';
        format.dispatchEvent(new Event('change', { bubbles: true }));
    }""")
    state = group_page.evaluate("""() => ({
        hidden1024: document.querySelector('#export-resolution-1024').hidden,
        warnGone: !document.querySelector('#export-gif-size-warn'),
        groupHintGone: !document.body.innerText.includes('要导出的那几张'),
        usageGone: !document.querySelector('.template-lib-usage'),
        mouthOffGone: !document.body.innerText.includes('不做口型交替'),
    })""")
    assert state["hidden1024"] is True, state
    assert state["warnGone"] and state["groupHintGone"] and state["usageGone"]         and state["mouthOffGone"], state

def test_right_click_menu_adds_and_removes_selected_actions(group_page: Page) -> None:
    """右键动作 → 加入/移出当前批量导出组；已在组里时菜单要反过来说。"""
    group_page.evaluate("() => document.querySelector('#new-group-btn').click()")
    group_page.wait_for_function(
        "() => document.querySelectorAll('#group-members .group-member').length === 1",
        timeout=10000)
    before = group_page.evaluate(
        "() => document.querySelectorAll('#group-members .group-member').length")

    _open_context_menu(group_page, 0)
    menu = group_page.evaluate("""() => {
        const m = document.querySelector('#group-context-menu');
        const shown = (sel) => {
            const el = document.querySelector(sel);
            return !el.hidden && getComputedStyle(el).display !== 'none';
        };
        return { open: !m.hidden, add: shown('#context-add-btn'), remove: shown('#context-remove-btn'),
                 groupLabel: document.querySelector('#context-group-name').textContent };
    }""")
    assert menu["open"] is True, "右键没弹出菜单"
    assert menu["add"] is True and menu["remove"] is False, f"不在组里时该只给「加入」: {menu}"
    assert "未命名组" in menu["groupLabel"], menu

    group_page.evaluate("() => document.querySelector('#context-add-btn').click()")
    group_page.wait_for_function(
        """(before) => document.querySelectorAll('#group-members .group-member').length > before""",
        arg=before, timeout=10000)
    kinds = group_page.evaluate(
        "() => [...document.querySelectorAll('#group-members .group-member-kind')].map(e => e.textContent)")
    assert "动作" in kinds, f"右键加入的该是一个动作: {kinds}"

    # 再右键同一个：已经在组里，菜单要改成「移出」
    group_page.evaluate("() => document.querySelector('#select-all-btn').click()")
    counted = group_page.evaluate("""() => ({
        cards: document.querySelectorAll('#animation-list [data-animation-id]').length,
        picked: document.querySelectorAll('#animation-list .animation-card.is-picked').length,
        label: document.querySelector('#list-select-count').textContent,
    })""")
    assert counted["picked"] == counted["cards"] > 0, f"全选没把列表里的动作都选上: {counted}"
    assert str(counted["cards"]) in counted["label"], f"计数条没报出选了几条: {counted}"
    _open_context_menu(group_page, 0)
    again = group_page.evaluate("""() => {
        const shown = (sel) => {
            const el = document.querySelector(sel);
            return !el.hidden && getComputedStyle(el).display !== 'none';
        };
        return { add: shown('#context-add-btn'), remove: shown('#context-remove-btn') };
    }""")
    assert again["remove"] is True, f"已在组里却还只给「加入」: {again}"
    group_page.evaluate("() => document.querySelector('#context-remove-btn').click()")
    after = group_page.evaluate(
        "() => document.querySelectorAll('#group-members .group-member').length")
    assert after == before + 1 - 1 or after < before + 2, f"移出没生效: {before} → {after}"


def test_tip_help_buttons_sit_next_to_their_label_text(group_page: Page) -> None:
    """问号要接在所属文字后面，不能被 .select-row 的两列 grid 排到下一行。"""
    places = group_page.evaluate("""() => {
        const rows = ['#pack-name', '#pack-priority'].map((id) => {
            const control = document.querySelector(id);
            const label = control.closest('label');
            const wrap = label.querySelector('.select-row-label');
            const help = label.querySelector('.tip-help');
            // 量的是纯文字那层（data-i18n 的 span），wrapper 的右缘已经是问号右缘
            const text = wrap && wrap.querySelector('[data-i18n]');
            if (!text || !help) return { id, ok: false };
            const t = text.getBoundingClientRect();
            const b = help.getBoundingClientRect();
            // 同一行 + 紧跟在文字右侧（间距不超过一个字符位）
            return { id, ok: Math.abs(b.top - t.top) < 3 && (b.left - t.right) < 14
                     && (b.left - t.right) >= -2 };
        });
        return rows;
    }""")
    assert all(row["ok"] for row in places), f"问号没接在文字后面: {places}"
