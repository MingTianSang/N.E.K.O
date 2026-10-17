"""用户图片页签：胶囊切换、导入、赋格。"""
from __future__ import annotations

import io
import json
import zipfile

from playwright.sync_api import Page

import tests.frontend.test_emote_state_stage as harness


def _template() -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        root, model = "wrapper/EmoteLab", "ModelA"
        archive.writestr(f"{root}/SpineModels/{model}/model.meta.json",
                         json.dumps({"DisplayName": "演示", "SharedModelKey": model}))
        archive.writestr(f"{root}/SpineModels/{model}/{model}.skel.bytes", b"4.3.23")
        archive.writestr(f"{root}/SpineModels/{model}/{model}.atlas.txt", "Page.png\nsize: 2, 3\n")
        archive.writestr(f"{root}/SpineModels/{model}/Page.png", b"not-a-png")
        archive.writestr(f"{root}/SpineModels/{model}/DisplayInfo/Animations.csv",
                         "AnimationName,DisplayName,en\nANIM/A,生气,angry\n")
        archive.writestr(f"{root}/Characters/{model}/{model}.json", json.dumps({
            "SharedModelKey": model, "ActiveSkins": {"Items": []},
            "SliderConstraints": [], "SlotGroups": [],
        }))
        archive.writestr(f"{root}/SceneLists/{model}/{model}.json", json.dumps({
            "sharedModelKey": model,
            "scenes": [{"name": f"场景{i}", "animationName": "ANIM/A",
                        "cameraPosition": {"x": i, "y": 2, "z": 3}, "model": {}, "texts": []}
                       for i in range(2)],
        }))
    return stream.getvalue()


def _open_stage(page: Page, running_server: str, images=None) -> None:
    """真导入模板 → 包装 create 注入活引用清单与导入桩 → 合成环境起舞台。"""
    page.goto(f"{running_server}/emote_maker", wait_until="networkidle")
    page.set_input_files("#emotelab-template-file", {
        "name": "first.zip", "mimeType": "application/zip", "buffer": _template(),
    })
    page.wait_for_function("() => document.body.classList.contains('editor-has-template')",
                           timeout=25000)
    images = images if images is not None else []
    page.evaluate(harness.REVEAL)
    page.evaluate(harness.LOCALE, "/static/locales/zh-CN.json")
    page.on("console", lambda msg: print("CONSOLE:", msg.text[:130]))
    page.evaluate(
        """([flat, images]) => {
            window.__userImages = images;   // 活引用：测试从浏览器侧往这里追加
            const posts = [];
            window.__texturePosts = posts;
            const original = window.fetch;
            window.fetch = function (input, init) {
                try {
                    const url = typeof input === 'string' ? input : input.url;
                    if ((init && init.method === 'POST') && url.includes('/library/textures')) {
                        const paths = init && init.body && init.body.get
                            ? init.body.getAll('texture_paths') : [];
                        posts.push({ url, paths });
                    }
                } catch (_) { /* 记录失败不影响主流程 */ }
                return original.apply(this, arguments);
            };
            window.NekoEmoteStateStage.setUserImages(window.__userImages);
            window.__IMPORT_CLICKED = false;
            window.NekoEmoteStateStage.setUserImages(window.__userImages);
        }""", [False, images])
    page.evaluate(harness.BOOT, 1.0)
    page.wait_for_timeout(400)
    page.evaluate("() => document.querySelector('.st-rail').click()")
    page.wait_for_function(
        "() => document.querySelector('.st-drawer').classList.contains('is-open')",
        timeout=10000)


def _switch_to_images(page: Page) -> None:
    page.evaluate("""() => {
        const btns = [...document.querySelectorAll('.st-drawer-head .list-segment-btn')];
        btns[1].click();
    }""")


def _switch_to_library(page: Page) -> None:
    page.evaluate("""() => {
        const btns = [...document.querySelectorAll('.st-drawer-head .list-segment-btn')];
        btns.find((b) => b.textContent.includes('动作库')).click();
    }""")


def test_capsule_switches_between_library_and_images(page: Page, running_server: str) -> None:
    _open_stage(page, running_server)
    initial = page.evaluate("""() => ({
        sceneActive: [...document.querySelectorAll('.st-drawer-head .list-segment-btn')]
            .find((b) => b.textContent.includes('动作库')).className.includes('is-active'),
        searchShown: !document.querySelector('.st-library-search').hidden,
        libraryShown: getComputedStyle(document.querySelector('.st-library')).display !== 'none',
        panelHidden: document.querySelector('.st-userimg-panel').hidden,
    })""")
    assert initial["sceneActive"] and initial["libraryShown"] and initial["panelHidden"], initial

    _switch_to_images(page)
    switched = page.evaluate("""() => ({
        sceneShown: getComputedStyle(document.querySelector('.st-library')).display !== 'none',
        searchHidden: document.querySelector('.st-library-search').hidden,
        panelShown: getComputedStyle(document.querySelector('.st-userimg-panel')).display !== 'none',
        importShown: getComputedStyle(document.querySelector('.st-userimg-import')).display !== 'none',
    })""")
    assert not switched["sceneShown"], switched
    assert switched["searchHidden"] and switched["panelShown"] and switched["importShown"], switched
    _switch_to_library(page)


def test_import_persists_into_the_template_copy(page: Page, running_server: str) -> None:
    """导入走真实入口（File + change）：页面层把 PNG POST 进副本（StageImages/ 路径）。"""
    images = []
    _open_stage(page, running_server, images=images)
    _switch_to_images(page)
    page.evaluate("""() => {
        const bytes = Uint8Array.from(atob(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg=='),
            (c) => c.charCodeAt(0));
        const file = new File([bytes], '我的图片.png', { type: 'image/png' });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        const input = document.querySelector('input[type=file][accept=".png,image/png"]');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }""")
    page.wait_for_function(
        "() => (window.__texturePosts || []).some((p) =>"
        "        p.paths.some((path) => path.startsWith('StageImages/')))",
        timeout=5000)


def test_seeded_image_renders_and_click_assigns(page: Page, running_server: str) -> None:
    """表演台侧：用户图片格渲染缩略图与名字，点击赋给选中的状态
    （图上出现 source.image 节点）。"""
    images = [{"id": "img-mine", "label": "我的图片.png", "thumb": ""}]
    _open_stage(page, running_server, images=images)
    _switch_to_images(page)
    label = page.evaluate(
        "() => document.querySelector('.st-userimg-grid .st-pick-label')?.textContent || null")
    print("GRID-STATE:", page.evaluate(
        '() => document.querySelector(".st-userimg-grid").textContent'))
    page.screenshot(path="shots/stage_images.png")
    page.screenshot(path="shots/stage_images.png")
    print("GRID:", page.evaluate(
        "() => document.querySelector('.st-userimg-grid').innerHTML.slice(0, 200)"))
    assert label == "我的图片.png", label
    assert page.evaluate("() => document.querySelector('.st-userimg-empty').hidden") is True
    assert page.evaluate(
        "() => document.querySelector('.st-drawer-count').textContent") == "1"

    page.evaluate("() => document.querySelector('.st-userimg-grid .st-userimg').click()")
    assigned = page.evaluate("""() => {
        const graph = window.__STAGE.getGraph();
        const image = graph.nodes.find((n) => n.type === 'source.image');
        return image ? image.params.imageId : '';
    }""")
    assert assigned == "img-mine", assigned

    # 删除钮：从清单里移除（赋格不受影响，节点还在图上）
    page.evaluate("""() => {
        window.__userImages.splice(0, 1);   // 同步清单
        const btns = [...document.querySelectorAll('.st-drawer-head .list-segment-btn')];
        btns.find((b) => b.textContent.includes('动作库')).click();
        btns[1].click();
    }""")
    page.wait_for_function(
        "() => document.querySelectorAll('.st-userimg-grid .st-userimg').length === 0",
        timeout=5000)
    empty_shown = page.evaluate(
        "() => !document.querySelector('.st-userimg-empty').hidden")
    assert empty_shown is True, "删完该显示空态"
    # 图上的 source.image 节点仍在（赋格已完成，删图不撤赋格）
    still = page.evaluate(
        "() => Boolean(window.__STAGE.getGraph().nodes.find((n) => n.type === 'source.image'))")
    assert still is True, "删图不该撤掉已赋的格"
