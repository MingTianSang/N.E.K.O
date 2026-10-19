"""页顶进度条（neko-top-progress.js）：表情制作页的两个长操作——
「导出形象包」与「导入到模型管理」——都要在页面顶部给出完成进度。

导出/导入的真进度（烘包第 i/N 个、上传字节）依赖 Spine 渲染器与大文件，
合成模板起不来——那段接线只有语法与运行时防护（脚本缺失时不抛错），
人肉验证。这里钉的是模块本身的行为和页面的挂载。
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
        // 嵌套：导入功能会先包一层再进烘包，内层 done 不收、最外层才收
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


def test_emote_page_includes_the_script() -> None:
    """模板改动容易漏挂脚本：直接查标签。"""
    emote_html = (_PROJECT_ROOT / "templates" / "emote_maker.html").read_text(encoding="utf-8")
    assert "/static/js/neko-top-progress.js" in emote_html
