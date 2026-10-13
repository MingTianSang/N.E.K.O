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
    # 没加载模板时左侧就是模板库本身（搜一遍/看清单/点一条从副本装回来）；
    # 分类条和随机搭配靠 EXPRESSIONS/ACCESSORIES 供内容，它们是两处空常量，永远收着
    assert dead == {"tabs": False, "search": True, "sectionHeading": True,
                    "grid": True, "randomize": False, "importCard": True}, dead

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


def test_reopens_from_the_local_copy_after_reload(library_page: Page) -> None:
    """导入即拷副本：重开页面后点库卡片，直接从副本恢复，不再弹任何文件选择器。

    filechooser 是这条用件的判据：没有副本时点击卡片会落到「请重新定位」，
    那一步在测试里就是一次 filechooser 事件 —— 出现了就算失败。
    """
    _import(library_page, "first.zip", "第一个", "A", scenes=2)
    # 副本落盘在后台进行：卡片上出现占用字样才算存上了
    library_page.wait_for_function(
        "() => Boolean(document.querySelector('.template-lib-size'))", timeout=20000)
    assert "本地副本" in library_page.evaluate(
        "() => document.querySelector('.template-lib-usage').textContent")

    library_page.reload(wait_until="networkidle")
    # 重载后还没有加载任何模板，但左侧本来就是模板库：卡片直接可见、直接点。
    # 可见性要看 computed display —— 只查 DOM 存在会被 display:none 骗过（踩过）。
    library_page.wait_for_function(
        """() => {
            const grid = document.querySelector('#asset-grid');
            const card = grid && grid.querySelector('.template-lib-card');
            return Boolean(card) && getComputedStyle(grid).display !== 'none';
        }""", timeout=20000)

    choosers: list[object] = []
    library_page.on("filechooser", lambda chooser: choosers.append(chooser))
    library_page.evaluate(
        "() => document.querySelector('#asset-grid .template-lib-card .template-lib-open').click()")
    library_page.wait_for_function(
        "() => document.body.classList.contains('editor-has-template')", timeout=25000)
    assert choosers == [], f"重开走的是本地副本，不该再要用户定位文件: {choosers}"
    assert "第一个" in library_page.evaluate(
        "() => document.querySelector('#workspace-title').textContent")
    # 恢复必须落回同一个库身份（同键）：起个 template.zip 的新名字就会分裂成
    # 两条 —— 旧条目的取景/组随之全丢。这条就是防它的。
    identities = library_page.evaluate("""() => (JSON.parse(
        localStorage.getItem('neko-emote-maker-template-library') || '{}').entries || []
    ).map((entry) => entry.key)""")
    assert len(identities) == 1 and identities[0].startswith("first.zip::"), identities

    # 再导一次同一个包：副本必须原地覆盖。等的是服务端真有这个键的条目，
    # 而不是卡片上的占用字样 —— 那个可能是上一次导入留下的，测不出"这次存上了"。
    _import(library_page, "first.zip", "第一个", "A", scenes=2)
    library_page.wait_for_function("""() => {
        const key = document.querySelector('#asset-grid .template-lib-card').dataset.templateKey;
        return fetch('/api/emote-maker/library')
            .then((r) => r.json())
            .then((d) => d.entries.filter((e) => e.key === key).length === 1);
    }""", timeout=20000)
    listing = library_page.evaluate("""() => {
        const key = document.querySelector('#asset-grid .template-lib-card').dataset.templateKey;
        return fetch('/api/emote-maker/library')
            .then((r) => r.json())
            .then((d) => ({ key, mine: d.entries.find((e) => e.key === key) }));
    }""")
    assert listing["mine"] and listing["mine"]["bytes"] > 0, listing


def test_removing_a_template_frees_its_local_copy(library_page: Page) -> None:
    """删除库条目要真的删掉磁盘副本并如实报出释放了多少。"""
    _import(library_page, "solo.zip", "独一份", "S", scenes=1)
    library_page.wait_for_function(
        "() => Boolean(document.querySelector('.template-lib-size'))", timeout=20000)
    my_key = library_page.evaluate(
        "() => document.querySelector('#asset-grid .template-lib-card').dataset.templateKey")
    before = library_page.evaluate("""(key) => fetch('/api/emote-maker/library')
        .then((r) => r.json())
        .then((d) => d.entries.find((e) => e.key === key))""", my_key)
    assert before and before["bytes"] > 0

    library_page.evaluate("() => document.querySelector('.template-lib-remove').click()")
    library_page.wait_for_function("""(key) => fetch('/api/emote-maker/library')
        .then((r) => r.json())
        .then((d) => !d.entries.some((e) => e.key === key))""", arg=my_key, timeout=15000)
    toast = library_page.evaluate("() => document.querySelector('#emote-toast').textContent")
    assert "已释放" in toast, f"删了副本却没报释放了多少: {toast!r}"


_PNG_1PX = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01"
    b"\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


def test_supplemented_textures_survive_a_reload(library_page: Page) -> None:
    """导入后补的贴图要合并进副本：重开随副本一起回来，不再只活一次会话。"""
    _import(library_page, "tex.zip", "带贴图", "T", scenes=1)
    library_page.wait_for_function(
        "() => Boolean(document.querySelector('.template-lib-size'))", timeout=20000)
    # webkitdirectory 的 input 塞不进单个文件（Playwright 只收目录路径），
    # 直接构造 File 挂到 input 上再派 change —— 与真选择器走同一条处理函数
    library_page.evaluate("""(png) => {
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        const file = new File([bytes], 'Custom.png', { type: 'image/png' });
        Object.defineProperty(file, 'webkitRelativePath', {
            value: 'Texture Cache/Custom Textures/Custom.png',
        });
        const input = document.querySelector('#emotelab-texture-cache-input');
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }""", __import__("base64").b64encode(_PNG_1PX).decode("ascii"))
    library_page.wait_for_function(
        "() => document.querySelector('#template-texture-cache-filename').textContent.includes('1')",
        timeout=10000)
    # 副本里真有这张贴图，而不是只叠在当前会话的内存里
    library_page.wait_for_function("""() => {
        const key = document.querySelector('#asset-grid .template-lib-card').dataset.templateKey;
        return fetch(`/api/emote-maker/library/textures?key=${encodeURIComponent(key)}`)
            .then((r) => r.json())
            .then((d) => (d.paths || []).includes('Texture Cache/Custom Textures/Custom.png'));
    }""", timeout=15000)

    library_page.reload(wait_until="networkidle")
    library_page.wait_for_function(
        """() => {
            const grid = document.querySelector('#asset-grid');
            const card = grid && grid.querySelector('.template-lib-card');
            return Boolean(card) && getComputedStyle(grid).display !== 'none';
        }""", timeout=20000)
    library_page.evaluate(
        "() => document.querySelector('#asset-grid .template-lib-card .template-lib-open').click()")
    library_page.wait_for_function(
        "() => document.body.classList.contains('editor-has-template')", timeout=25000)
    assert "1" in library_page.evaluate(
        "() => document.querySelector('#template-texture-cache-filename').textContent"), \
        "补充的贴图没随副本回来"


def _write_template_directory(root, display_name: str, slot: str) -> None:
    """摊开的 EmoteLab 目录（选模板目录那条入口的输入）。"""
    import json as _json
    model = f"Model{slot}"
    base = root / "wrapper" / "EmoteLab"
    (base / "SpineModels" / model / "DisplayInfo").mkdir(parents=True)
    (base / "Characters" / model).mkdir(parents=True)
    (base / "SceneLists" / model).mkdir(parents=True)
    (base / "SpineModels" / model / "model.meta.json").write_text(
        _json.dumps({"DisplayName": display_name, "SharedModelKey": model}), encoding="utf-8")
    (base / "SpineModels" / model / f"{model}.skel.bytes").write_bytes(b"4.3.23")
    (base / "SpineModels" / model / f"{model}.atlas.txt").write_text("Page.png\nsize: 2, 3\n",
                                                                     encoding="utf-8")
    (base / "SpineModels" / model / "Page.png").write_bytes(b"not-a-png")
    (base / "SpineModels" / model / "DisplayInfo" / "Animations.csv").write_text(
        "AnimationName,DisplayName,en\nANIM/A,Demo,Demo\n", encoding="utf-8")
    (base / "Characters" / model / f"{model}.json").write_text(_json.dumps({
        "SharedModelKey": model, "ActiveSkins": {"Items": []},
        "SliderConstraints": [], "SlotGroups": [],
    }), encoding="utf-8")
    (base / "SceneLists" / model / f"{model}.json").write_text(_json.dumps({
        "sharedModelKey": model,
        "scenes": [{"name": f"场景{i}", "animationName": "ANIM/A",
                    "cameraPosition": {"x": i, "y": 2, "z": 3}, "model": {}, "texts": []}
                   for i in range(2)],
    }), encoding="utf-8")


def test_directory_import_names_the_card_by_folder(page: Page, running_server: str, tmp_path) -> None:
    """目录导入的默认名＝文件夹名，不是模板 meta 里的内部名，更不是「已选择模板目录」。"""
    folder = tmp_path / "YUI_道具风格版_改"
    _write_template_directory(folder, "内部作者名", "A")
    page.goto(f"{running_server}/emote_maker", wait_until="networkidle")
    page.set_input_files("#emotelab-template-directory", str(folder))
    page.wait_for_function("() => document.body.classList.contains('editor-has-template')",
                           timeout=25000)
    label = page.evaluate(
        "() => document.querySelector('#asset-grid .template-lib-card .asset-card-label')"
        ".textContent.trim()")
    assert label == "YUI_道具风格版_改", f"卡片默认名该是文件夹名: {label!r}"
    stored = page.evaluate("""() => (JSON.parse(localStorage.getItem(
        'neko-emote-maker-template-library') || '{}').entries || [])[0] || {}""")
    assert stored.get("sourceName") == "YUI_道具风格版_改", stored
    assert stored.get("displayName") == "内部作者名", "自报名留着当兜底，别丢"


def test_double_click_renames_the_card_and_survives_a_reload(library_page: Page) -> None:
    """双击卡片名就地改名：Enter 提交、Esc 放弃、跨重启还在，且库身份（键）不变。"""
    _import(library_page, "first.zip", "第一个", "A", scenes=2)
    card = library_page.locator("#asset-grid .template-lib-card")
    before = library_page.evaluate(
        "() => document.querySelector('#asset-grid .template-lib-card').dataset.templateKey")

    card.dblclick()
    library_page.wait_for_function(
        "() => Boolean(document.querySelector('#asset-grid .template-lib-rename'))",
        timeout=10000)
    library_page.evaluate("""() => {
        const input = document.querySelector('#asset-grid .template-lib-rename');
        input.value = '我的 YUI';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }""")
    library_page.wait_for_function(
        """() => document.querySelector('#asset-grid .template-lib-card .asset-card-label')
            .textContent.trim() === '我的 YUI'""", timeout=10000)
    stored = library_page.evaluate("""() => (JSON.parse(localStorage.getItem(
        'neko-emote-maker-template-library') || '{}').entries || [])[0] || {}""")
    assert stored.get("alias") == "我的 YUI", stored

    # Esc 放弃不改名
    card.dblclick()
    library_page.wait_for_function(
        "() => Boolean(document.querySelector('#asset-grid .template-lib-rename'))",
        timeout=10000)
    library_page.evaluate("""() => {
        const input = document.querySelector('#asset-grid .template-lib-rename');
        input.value = '不该生效';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    }""")
    library_page.wait_for_function(
        """() => document.querySelector('#asset-grid .template-lib-card .asset-card-label')
            .textContent.trim() === '我的 YUI'""", timeout=10000)

    # 改名跨重启还在，且只是外观：键没动，副本/会话都还认得
    library_page.reload(wait_until="networkidle")
    library_page.wait_for_function(
        """() => {
            const grid = document.querySelector('#asset-grid');
            const label = grid && grid.querySelector('.asset-card-label');
            return Boolean(label) && getComputedStyle(grid).display !== 'none'
                && label.textContent.trim() === '我的 YUI';
        }""", timeout=20000)
    after = library_page.evaluate(
        "() => document.querySelector('#asset-grid .template-lib-card').dataset.templateKey")
    assert after == before, f"改名不该动库身份: {before} → {after}"

    # 双击"非当前"的卡片：改名要发生，而双击的头两下 click 不能把模板切过去
    # （判别点是工作区标题：要是被切过去，它会变成 first 那条的名字）
    _import(library_page, "second.zip", "第二个", "B", scenes=2)
    other = library_page.evaluate("""() => {
        const cards = [...document.querySelectorAll('#asset-grid .template-lib-card')];
        return cards.find((c) => c.dataset.templateKey.startsWith('first.zip::')).dataset.templateKey;
    }""")
    library_page.locator(f'#asset-grid .template-lib-card[data-template-key="{other}"]').dblclick()
    library_page.wait_for_function(
        "() => Boolean(document.querySelector('#asset-grid .template-lib-rename'))",
        timeout=10000)
    title = library_page.evaluate("() => document.querySelector('#workspace-title').textContent")
    assert "第二个" in title, f"双击改名前的那两下 click 把模板切过去了: {title!r}"
    library_page.keyboard.press("Enter")
