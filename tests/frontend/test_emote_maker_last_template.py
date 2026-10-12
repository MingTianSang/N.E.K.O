"""The emote maker remembers *metadata* about the last opened template — never the
assets themselves (assetPolicy is local-import-and-render-only). On the next visit it offers
one click to re-pick that package and restores the scene/skins/sliders/slots/adjustments and
the avatar-pack mapping.

These tests seed localStorage directly, because the restore path can only be judged from
what the UI actually shows before any package exists.
"""

from __future__ import annotations

import json

from playwright.sync_api import Page, expect

STORAGE_KEY = "neko-emote-maker-last-template"


def _snapshot(**overrides) -> dict:
    base = {
        "schemaVersion": 1,
        "fingerprint": "YUI::shared::407::191",
        "packageName": "YUI",
        "displayName": "YUI 道具风格版",
        "importKind": "directory",
        "sceneId": "scenes/Character.json#3",
        "sceneListFilter": "",
        "packSceneIds": {"idle_image": "scenes/Character.json#3"},
        "character": {"skins": [], "sliders": [], "slots": []},
        "adjustments": {"x": 0, "y": 0, "rotation": 0, "scale": 100},
        "adjustOverwrite": True,
        "colorMode": "default",
        "secondaryColor": "#2a4664",
    }
    base.update(overrides)
    return base


def _seed(page: Page, server: str, payload: str | None) -> None:
    page.goto(f"{server}/emote_maker", wait_until="domcontentloaded")
    page.evaluate(
        """([key, value]) => {
            if (value === null) localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        }""",
        [STORAGE_KEY, payload],
    )


def _open_fresh(page: Page, server: str) -> None:
    page.goto(f"{server}/emote_maker", wait_until="networkidle")
    page.wait_for_timeout(250)


def test_no_prompt_without_a_previous_session(page: Page, running_server: str) -> None:
    _seed(page, running_server, None)
    _open_fresh(page, running_server)
    expect(page.locator("#last-template-row")).to_be_hidden()


def test_prompt_shows_the_last_package_and_reopens_the_right_picker(
    page: Page, running_server: str
) -> None:
    _seed(page, running_server, json.dumps(_snapshot(importKind="directory"), ensure_ascii=False))
    _open_fresh(page, running_server)
    row = page.locator("#last-template-row")
    expect(row).to_be_visible()
    assert page.locator("#last-template-name").inner_text() == "YUI 道具风格版"
    folder_label = page.locator("#reopen-last-template-btn").inner_text()
    assert "目录" in folder_label, folder_label

    _seed(page, running_server, json.dumps(_snapshot(importKind="file"), ensure_ascii=False))
    _open_fresh(page, running_server)
    file_label = page.locator("#reopen-last-template-btn").inner_text()
    assert "文件" in file_label, file_label


def test_corrupt_or_unrecognised_storage_is_ignored(page: Page, running_server: str) -> None:
    """localStorage 是外部输入：坏 JSON、缺 schemaVersion、缺指纹都不能让页面报错
    或者弹出一个恢复不出来的提示。"""
    for bad in ("{not json", "[]", json.dumps({"displayName": "X"}),
                json.dumps(_snapshot(schemaVersion=99))):
        _seed(page, running_server, bad)
        page.goto(f"{running_server}/emote_maker", wait_until="networkidle")
        page.wait_for_timeout(250)
        expect(page.locator("#last-template-row")).to_be_hidden()


def test_reopen_button_targets_a_real_file_input(page: Page, running_server: str) -> None:
    """提示做对了但按钮指向一个不存在的 input，等于没做。"""
    _seed(page, running_server, json.dumps(_snapshot(importKind="directory"), ensure_ascii=False))
    _open_fresh(page, running_server)
    inputs = page.evaluate(
        """() => ({
            file: !!document.querySelector('#emotelab-template-file'),
            directory: !!document.querySelector('#emotelab-template-directory'),
        })"""
    )
    assert inputs["file"] and inputs["directory"]
    expect(page.locator("#reopen-last-template-btn")).to_be_visible()


def test_prompt_sits_inside_the_import_card_and_survives_a_render(
    page: Page, running_server: str
) -> None:
    """提示条在导入卡片内；renderAll 会在导入流程里反复跑，hidden 由
    renderLastTemplatePrompt() 每次重算，所以它不该被某次渲染永久抹掉。"""
    _seed(page, running_server, json.dumps(_snapshot(), ensure_ascii=False))
    _open_fresh(page, running_server)
    assert page.evaluate(
        """() => {
            const row = document.querySelector('#last-template-row');
            return Boolean(row && row.closest('.template-import-card'));
        }"""
    ), "提示条应在导入卡片内，紧邻那两个选择按钮"
    page.evaluate("() => window.dispatchEvent(new Event('localechange'))")
    page.wait_for_timeout(250)
    expect(page.locator("#last-template-row")).to_be_visible()


STUB = """(behaviour) => {
    window.__SEEN = { bridge: [], fileInput: 0, dirInput: 0 };
    const file = document.querySelector('#template-file-input')
        || document.querySelector('input[type=file]:not([webkitdirectory])');
    const dir = document.querySelector('input[webkitdirectory]');
    if (file) file.click = () => { window.__SEEN.fileInput += 1; };
    if (dir) dir.click = () => { window.__SEEN.dirInput += 1; };
    window.nekoHost = {
        async pickTemplateDirectory(options) {
            window.__SEEN.bridge.push(options || {});
            if (behaviour === 'needs-pick') return { cancelled: true, needsPick: true };
            return { cancelled: true };
        },
    };
    return { wired: Boolean(file && dir) };
}"""


def _stub(page: Page, behaviour: str = "normal") -> None:
    assert page.evaluate(STUB, behaviour)["wired"] is True, "没找到两个 input，测试要跟着页面改"


def test_reopen_uses_the_host_bridge_without_a_dialog(page: Page, running_server: str) -> None:
    """回归：lastImportKind 是模块变量，重载后退回 'file'，
    于是「重新打开」永远弹文件选择框，也永远走不到桌面端记住的那个目录。"""
    import json as _json
    _seed(page, running_server, _json.dumps(_snapshot(importKind="directory")))
    _open_fresh(page, running_server)
    _stub(page)
    page.click("#reopen-last-template-btn")
    page.wait_for_timeout(400)
    seen = page.evaluate("() => window.__SEEN")
    assert seen["bridge"] and seen["bridge"][0].get("reopenLast") is True, seen
    assert seen["fileInput"] == 0, "不该再弹文件选择框"
    assert seen["dirInput"] == 0, "桥在的时候不该退回网页目录框"


def test_reopen_falls_back_to_the_picker_when_the_folder_is_gone(
    page: Page, running_server: str
) -> None:
    """记不住了要能退回正常选择框，而不是什么都不发生。"""
    import json as _json
    _seed(page, running_server, _json.dumps(_snapshot(importKind="directory")))
    _open_fresh(page, running_server)
    _stub(page, "needs-pick")
    page.click("#reopen-last-template-btn")
    page.wait_for_timeout(500)
    seen = page.evaluate("() => window.__SEEN")
    assert len(seen["bridge"]) == 2, seen
    assert seen["bridge"][0].get("reopenLast") is True, seen
    assert not seen["bridge"][1].get("reopenLast"), "第二次应该是正常的选框调用"


def test_a_file_kind_snapshot_still_reopens_the_file_input(page: Page, running_server: str) -> None:
    """别把单文件包的重开一起改掉。"""
    import json as _json
    _seed(page, running_server, _json.dumps(_snapshot(importKind="file")))
    _open_fresh(page, running_server)
    _stub(page)
    page.click("#reopen-last-template-btn")
    page.wait_for_timeout(300)
    seen = page.evaluate("() => window.__SEEN")
    assert seen["fileInput"] == 1, seen
    assert seen["bridge"] == [], seen
