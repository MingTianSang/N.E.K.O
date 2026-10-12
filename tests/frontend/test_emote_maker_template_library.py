"""模板库：左侧那块从"第二份场景列表"换成"最近用过的模板"之后该有的行为。

三条都是这功能的存在理由：
1. 同一个列表不该在左右各摆一份；
2. 每个模板各记各的绑定（切回来不该看到别的形象留下的设置）；
3. 切回去不该重新解析一遍几百个场景。
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest
from playwright.sync_api import Page

LIBRARY_KEY = "neko-emote-maker-template-library"
EXPORT_KEY = "neko-emote-maker-export"


def _synthetic_template(display_name: str = "演示", slot: str = "Demo", scenes: int = 1) -> bytes:
    """元数据模板：骨骼是假的，所以 Spine 起不来 —— 库不依赖渲染器。"""
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        root = "wrapper/EmoteLab"
        model = f"Model{slot}"
        archive.writestr(f"{root}/SpineModels/{model}/model.meta.json",
                         json.dumps({"DisplayName": display_name, "SharedModelKey": display_name}))
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
            "SliderConstraints": [], "SlotGroups": [],
        }))
        archive.writestr(f"{root}/SceneLists/{model}/{model}.json", json.dumps({
            "sharedModelKey": model,
            "scenes": [{
                "name": f"{display_name}-{i}", "animationName": "ANIM/Demo",
                "cameraPosition": {"x": i, "y": 2, "z": 3}, "model": {}, "texts": [],
            } for i in range(scenes)],
        }))
    return stream.getvalue()


@pytest.fixture()
def library_page(page: Page, running_server: str) -> Page:
    page.goto(f"{running_server}/emote_maker", wait_until="networkidle")
    page.wait_for_function("() => Boolean(document.querySelector('#emotelab-template-file'))",
                           timeout=15000)
    return page


def _import(page: Page, file_name: str, display_name: str, slot: str = "Demo",
            scenes: int = 1) -> None:
    page.set_input_files("#emotelab-template-file", {
        "name": file_name, "mimeType": "application/zip",
        "buffer": _synthetic_template(display_name, slot, scenes),
    })
    page.wait_for_function("() => document.body.classList.contains('editor-has-template')",
                           timeout=25000)
    page.wait_for_function("() => document.querySelectorAll('#asset-grid .template-lib-card').length > 0",
                           timeout=15000)


def _keys(page: Page) -> list[str]:
    return page.evaluate(
        """(k) => (JSON.parse(localStorage.getItem(k) || '{}').entries || []).map(e => e.displayName)""",
        LIBRARY_KEY)


def _cards(page: Page):
    return page.evaluate("""() => [...document.querySelectorAll('#asset-grid .template-lib-card')]
        .map(card => ({
            key: card.dataset.templateKey,
            inUse: Boolean(card.querySelector('.template-lib-badge')),
            label: (card.querySelector('.asset-card-label') || {}).textContent || '',
        }))""")


def test_left_panel_is_the_library_and_the_dock_stops_duping_it(library_page: Page) -> None:
    """模板模式下左侧只有模板库；预览下方也不再摆第二份场景清单。"""
    _import(library_page, "first.zip", "第一个")
    counts = library_page.evaluate("""() => ({
        gridScenes: document.querySelectorAll('#asset-grid .template-scene-card').length,
        dockScenes: document.querySelectorAll('#animation-list .scene-card').length,
        dockAnimations: document.querySelectorAll('#animation-list [data-animation-id]').length,
        libraryCards: document.querySelectorAll('#asset-grid .template-lib-card').length,
        tabsVisible: getComputedStyle(document.querySelector('.category-tabs')).display !== 'none',
    })""")
    assert counts["gridScenes"] == 0, f"左侧还在渲染场景列表: {counts}"
    assert counts["dockScenes"] == 0, f"预览下方还摆着一份场景清单: {counts}"
    assert counts["dockAnimations"] >= 1, f"预览下方该只剩动画列表: {counts}"
    assert counts["libraryCards"] == 1, counts
    assert counts["tabsVisible"] is False, "模板模式下四个分类点了都是同一块，该整排收掉"


def test_two_imports_make_two_entries_and_the_newest_is_in_use(library_page: Page) -> None:
    _import(library_page, "first.zip", "第一个")
    _import(library_page, "second.zip", "第二个")
    assert sorted(_keys(library_page)) == ["第一个", "第二个"], _keys(library_page)
    cards = {card["label"]: card["inUse"] for card in _cards(library_page)}
    assert cards == {"第一个": False, "第二个": True}, f"「使用中」标错了: {cards}"
    assert library_page.evaluate("() => document.querySelector('.template-lib-badge').textContent") == "使用中"


def _open_group(page: Page) -> None:
    """导出设置 → 选中导入的那个组：组员清单就是挑取景的地方。"""
    page.evaluate("() => document.querySelector('#inspector-tab-export').click()")
    page.wait_for_function(
        "() => getComputedStyle(document.querySelector('#group-section')).display !== 'none'",
        timeout=10000)
    page.evaluate("""() => {
        const select = document.querySelector('#template-scene-list-select');
        const option = [...select.options].find((o) => o.value.startsWith('list:'));
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }""")
    page.wait_for_function(
        "() => document.querySelectorAll('#group-members .group-member').length > 0",
        timeout=10000)


def _state(page: Page) -> dict:
    """库里给当前模板存的会话 —— 也就是刷新/切回来时真正会读到的那份。

    不走八行那个下拉，也不再看 dock 的场景卡：前者要求 Spine 运行时可用才渲染，
    后者已经并进了组 —— 取景就在组员清单里挑。以前这里还读屏幕上那行「当前画面」，
    那行按要求删了，于是探针改成会话里的 sceneId：它才是"各记各的取景"的落点。
    """
    return page.evaluate(
        """(libKey) => {
            const lib = JSON.parse(localStorage.getItem(libKey) || '{}');
            const current = (lib.entries || []).find((e) => e.key === lib.currentKey);
            return {
                stored: ((current || {}).session || {}).packSceneIds || {},
                storedSceneId: ((current || {}).session || {}).sceneId || '',
                entryCount: (lib.entries || []).length,
            };
        }""", LIBRARY_KEY)


def _pick_member(page: Page, index: int) -> dict:
    """点组里第 index 个成员，等于采用那个取景；返回它的名字与 id。"""
    return page.evaluate(
        """(i) => {
            const rows = [...document.querySelectorAll('#group-members .group-member')];
            const row = rows[i];
            const out = {
                name: row.querySelector('.group-member-name').textContent,
                ref: row.dataset.memberRef,
            };
            row.querySelector('.group-member-pick').click();
            return out;
        }""", index)


def _stored_scene_id(page: Page) -> str:
    return page.evaluate(
        """(libKey) => {
            const lib = JSON.parse(localStorage.getItem(libKey) || '{}');
            const entry = (lib.entries || []).find((e) => e.key === lib.currentKey);
            return ((entry || {}).session || {}).sceneId || '';
        }""", LIBRARY_KEY)


def test_each_template_keeps_its_own_framing(library_page: Page) -> None:
    """切回来要落回自己那个取景，不是"回落到第一个"。

    探针刻意选**多成员里的第 2 个**：只有一个成员时，"恢复原状"和"丢了之后回落到
    第一个"看起来是同一个值，测不出区别（这一点上一版踩过）。
    """
    _import(library_page, "first.zip", "第一个", "A", scenes=3)
    first_key = _cards(library_page)[0]["key"]
    _open_group(library_page)
    picked = _pick_member(library_page, 1)
    library_page.wait_for_function(
        """(ref) => {
            const lib = JSON.parse(localStorage.getItem('neko-emote-maker-template-library') || '{}');
            const entry = (lib.entries || []).find((e) => e.key === lib.currentKey);
            return ((entry || {}).session || {}).sceneId === ref;
        }""", arg=picked["ref"], timeout=10000)
    state = _state(library_page)
    assert state["storedSceneId"], f"当前取景没写进模板会话: {state}"

    _import(library_page, "second.zip", "第二个", "B", scenes=2)
    _open_group(library_page)
    other = _pick_member(library_page, 1)
    library_page.wait_for_function(
        """(ref) => {
            const lib = JSON.parse(localStorage.getItem('neko-emote-maker-template-library') || '{}');
            const entry = (lib.entries || []).find((e) => e.key === lib.currentKey);
            return ((entry || {}).session || {}).sceneId === ref;
        }""", arg=other["ref"], timeout=10000)

    # 从左侧库切回第一个：库里存的必须回到 A 那一格
    library_page.evaluate(
        """(key) => {
            const card = [...document.querySelectorAll('#asset-grid .template-lib-card')]
                .find((c) => c.dataset.templateKey === key);
            card.querySelector('.template-lib-open').click();
        }""", first_key)
    library_page.wait_for_function(
        """(key) => {
            const card = [...document.querySelectorAll('#asset-grid .template-lib-card')]
                .find((c) => c.dataset.templateKey === key);
            return Boolean(card && card.querySelector('.template-lib-badge'));
        }""", arg=first_key, timeout=15000)
    _open_group(library_page)
    back = _state(library_page)
    assert back["storedSceneId"] == picked["ref"], (
        f"切回来没落回原来那个取景（说明当前取景没跟着模板走）:"
        f" 期望 {picked['ref']}（{picked['name']}），实际 {back}")
    assert back["storedSceneId"] != other["ref"], (
        f"切回 A 却还顶着 B 的取景: {back}")


def test_registry_switch_does_not_reparse_or_refetch(library_page: Page) -> None:
    """从内存注册表切回去：不该再打后端，也不该重新读盘。"""
    _import(library_page, "first.zip", "第一个")
    _import(library_page, "second.zip", "第二个")
    calls = library_page.evaluate("""async () => {
        let posted = 0;
        const realFetch = window.fetch;
        window.fetch = (url, init) => {
            if (String(url).includes('/import/emotelab')) posted += 1;
            return realFetch(url, init);
        };
        const card = [...document.querySelectorAll('#asset-grid .template-lib-card')]
            .find((c) => !c.querySelector('.template-lib-badge'));
        card.querySelector('.template-lib-open').click();
        await new Promise((r) => setTimeout(r, 1200));
        window.fetch = realFetch;
        return { posted, current: document.querySelectorAll('.template-lib-badge').length };
    }""")
    assert calls["posted"] == 0, f"切回内存里就有的模板却又去解析了一遍: {calls}"
    assert calls["current"] == 1, f"切换后应当恰好一个「使用中」: {calls}"


def test_remove_takes_the_entry_away(library_page: Page) -> None:
    _import(library_page, "first.zip", "第一个")
    _import(library_page, "second.zip", "第二个")
    library_page.evaluate("""() => {
        const card = [...document.querySelectorAll('#asset-grid .template-lib-card')]
            .find((c) => !c.querySelector('.template-lib-badge'));
        card.querySelector('.template-lib-remove').click();
    }""")
    library_page.wait_for_function(
        "() => document.querySelectorAll('#asset-grid .template-lib-card').length === 1",
        timeout=10000)
    assert _keys(library_page) == ["第二个"], "移除后库里该只剩当前那条"
    # 移除当前这条：编辑器回到空状态，这是设计好的出口，不是卡住
    library_page.evaluate(
        "() => document.querySelector('.template-lib-remove').click()")
    library_page.wait_for_function(
        "() => document.body.classList.contains('editor-empty')", timeout=10000)
    assert _keys(library_page) == []


def test_empty_state_does_not_echo_the_import_button(page: Page, running_server: str) -> None:
    """没模板时别把主按钮的话再说一遍：徽章以前写「选择模板文件」，正下方就是同名按钮。"""
    page.goto(f"{running_server}/emote_maker", wait_until="networkidle")
    page.wait_for_function("() => Boolean(document.querySelector('#template-runtime-badge'))",
                           timeout=15000)
    empty = page.evaluate("""() => {
        const badge = document.querySelector('#template-runtime-badge');
        const button = document.querySelector('#select-emotelab-template-btn');
        return {
            shown: getComputedStyle(badge).display !== 'none',
            sameAsButton: badge.textContent.trim() === button.textContent.trim(),
        };
    }""")
    assert empty["shown"] is False, f"空态还挂着一张重复按钮文案的徽章: {empty}"
    dead = page.evaluate("""() => {
        const visible = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            // 只看渲染结果：[hidden] 会被 display:flex 之类的规则盖过去
            return getComputedStyle(el).display !== 'none';
        };
        return {
            tabs: visible('.category-tabs'),
            search: visible('.asset-search'),
            sectionHeading: visible('.asset-section-heading'),
            grid: visible('#asset-grid'),
            randomize: visible('#randomize-btn'),
            importCard: visible('.template-import-card'),
        };
    }""")
    # 这四个都靠 EXPRESSIONS/ACCESSORIES 供内容，而它们是两处空常量：
    # 分类永远禁用、随机搭配点了直接 return、搜索框筛空列表 → 空态不该摆出来
    assert dead == {"tabs": False, "search": False, "sectionHeading": False,
                    "grid": False, "randomize": False, "importCard": True}, dead

    _import(page, "first.zip", "第一个", "A", scenes=2)
    loaded = page.evaluate("""() => {
        const badge = document.querySelector('#template-runtime-badge');
        const button = document.querySelector('#select-emotelab-template-btn');
        return {
            shown: getComputedStyle(badge).display !== 'none',
            text: badge.textContent.trim(),
            sameAsButton: badge.textContent.trim() === button.textContent.trim(),
        };
    }""")
    assert loaded["shown"] is True, f"读进模板后徽章没收回来，运行状态没地方报了: {loaded}"
    assert loaded["sameAsButton"] is False, loaded
    assert loaded["text"], loaded
