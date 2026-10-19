"""页顶进度条（neko-top-progress.js）：两个页面都挂了、行为对。

导出侧的真进度（烘包第 i/N 个）依赖 Spine 渲染器，合成模板起不来——
那里的接线只有语法与运行时防护（脚本缺失时不抛错），人肉验证。
这里钉的是模块本身的行为和两个页面的挂载。
"""

from __future__ import annotations

from pathlib import Path

from playwright.sync_api import Page

_PROJECT_ROOT = Path(__file__).resolve().parents[2]


def test_top_progress_module_behavior(page: Page, running_server: str) -> None:
    page.goto(f"{running_server}/emote_maker", wait_until="networkidle")
    page.wait_for_function("() => Boolean(window.NekoTopProgress)", timeout=15000)
    state = page.evaluate("""() => {
        const bar = () => document.querySelector('.neko-top-progress');
        NekoTopProgress.begin();
        NekoTopProgress.progress(0.4);
        const active = bar().classList.contains('is-active');
        const fillWidth = bar().firstChild.style.width;
        NekoTopProgress.progress(null);
        const indeterminate = bar().classList.contains('is-indeterminate');
        NekoTopProgress.done();
        const hiddenAfterDone = !bar().classList.contains('is-active');
        // 嵌套：内层 done 不收，最外层 done 才收
        NekoTopProgress.begin();
        NekoTopProgress.begin();
        NekoTopProgress.progress(1);
        NekoTopProgress.done();
        const nestedStillActive = bar().classList.contains('is-active');
        NekoTopProgress.done();
        const nestedHidden = !bar().classList.contains('is-active');
        return { active, fillWidth, indeterminate, hiddenAfterDone,
                 nestedStillActive, nestedHidden };
    }""")
    assert state == {
        "active": True,
        "fillWidth": "40%",
        "indeterminate": True,
        "hiddenAfterDone": True,
        "nestedStillActive": True,
        "nestedHidden": True,
    }, state


def test_both_pages_include_the_script() -> None:
    """模板改动容易漏挂脚本：两个页面直接查标签。"""
    emote_html = (_PROJECT_ROOT / "templates" / "emote_maker.html").read_text(encoding="utf-8")
    manager_html = (_PROJECT_ROOT / "templates" / "model_manager.html").read_text(encoding="utf-8")
    assert "/static/js/neko-top-progress.js" in emote_html
    assert "/static/js/neko-top-progress.js" in manager_html


def test_model_manager_page_loads_with_the_bar(page: Page, running_server: str) -> None:
    """模型管理页挂了脚本且页面 JS 不报错（改过它的控制器与模板）。"""
    errors = []
    page.on("pageerror", lambda exc: errors.append(str(exc)))
    page.goto(f"{running_server}/model_manager", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_function("() => Boolean(window.NekoTopProgress)", timeout=15000)
    page.evaluate("""() => {
        NekoTopProgress.begin();
        NekoTopProgress.progress(0.5);
        NekoTopProgress.done();
    }""")
    assert not errors, errors
