# -*- coding: utf-8 -*-
"""复现取证 + 修复回归：主页面内存里的 touch_set 是页面加载时的一次性快照，模型管理页的
后续保存永远到不了运行中的主页面。

用户报告的现象：在模型管理页配置 Live2D 自定义触摸区域并保存后，模型管理页
回读显示已保存（PATCH /api/characters/catgirl/{name}/touch_set 立即落盘），
但回到主页面点击自定义区域没有任何效果，刷新主页面后（或重启应用后）才生效。

根因：touch-config.js 的 InitializationTouchSet() 只在页面启动时执行一次
（startTouchConfigAfterStorageBarrier() → touchPage_init + InitializationTouchSet），
把 /api/characters 的 _reserved.touch_set 快照进 window.live2dManager.touchSet。
此后模型管理页保存只触发 reload_model 重载模型本身
（bootstrap-resources-and-model-reload.js 全程没有重新拉取 touch_set），
运行中的主页面/桌宠窗口继续拿旧快照做自定义区域命中检测
（live2d-interaction.js 的 _getCustomTouchAreaIdAtPoint → touchSet 里没有新矩形
→ customAreaId=null → 路由回 default/随机动画）。

修复（2026-10-20）：
  A. touch-config.js 新增 nekoRefreshLive2DTouchSet()：模型加载完成钩子——数据刚
     拉取过只补原生 HitArea 接线，过期则重拉；InitializationTouchSet 修掉"等不到
     模型仍拿 undefined 接线"和 modelName 为空时创建 "null" 垃圾键。
  B. touch-config.js 保存成功后经 neko_touch_set_channel 广播，主页面收到即强制
     重拉（BC 不可用时静默降级为旧行为：刷新主页面生效）。
  C. live2d-init.js 初始加载完成、bootstrap-resources-and-model-reload.js 热切换
     完成各接一个刷新钩子。

本测试在真实服务端 + 真实主页面上验证：
  - fresh-load 基线：直接 PATCH 落盘后冷启动页面，同一点命中自定义区域；
  - fix-broadcast：PATCH + 真实 broadcastTouchSetUpdated 信号 → 不刷新页面即生效；
  - fix-reload-hook：PATCH + 真实 handleModelReload → 切换完成后自动生效；
  - fix-rebind：慢加载场景模拟——接线被清空、数据过期后调用刷新钩子，
    原生 HitArea 监听被重新接到当前模型上。
判定序列均与 onDragEnd 点击分支一致（_getCustomTouchAreaIdAtPoint +
_getPreferredTouchSetHitArea），每阶段重复 n=3 次。
"""

import time

import pytest
from playwright.sync_api import Page

CUSTOM_AREA_ID = "custom_repro_stale_area_1"
CUSTOM_RECT = {"x": 0.4, "y": 0.3, "width": 0.2, "height": 0.2}
PROBE_NX = 0.5  # 矩形中心的归一化坐标
PROBE_NY = 0.4
REPEATS = 3


def _wait_main_page_ready(page: Page, timeout_ms: int = 60000):
    page.wait_for_function(
        """() => {
            const m = window.live2dManager;
            return !!(m && m.currentModel && !m.currentModel.destroyed
                && m.modelName && m.touchSet && m.touchSet[m.modelName]);
        }""",
        timeout=timeout_ms,
    )


def _wait_probe_hits(page: Page, area_id: str, timeout_ms: int = 15000):
    """轮询路由探测，直到给定自定义区域在矩形中心点被命中（不刷新页面）。"""
    deadline = time.monotonic() + timeout_ms / 1000
    last_probe = None
    while time.monotonic() < deadline:
        last_probe = _route_probe(page)
        if (
            "error" not in last_probe
            and last_probe.get("customAreaId") == area_id
            and last_probe.get("useBlock") == area_id
        ):
            return last_probe
        page.wait_for_timeout(300)
    raise AssertionError(
        f"{timeout_ms}ms 内自定义区域 {area_id} 未被命中，最后一次探测: {last_probe}"
    )


def _route_probe(page: Page):
    """在自定义矩形中心点执行与 onDragEnd 点击分支一致的判定序列。

    对应 live2d-interaction.js onDragEnd：
      customAreaId = _getCustomTouchAreaIdAtPoint(x, y)
      UseBlock     = _getPreferredTouchSetHitArea(hitAreas, customAreaId)
    """
    return page.evaluate(
        """({ nx, ny }) => {
            const manager = window.live2dManager;
            const b = manager._getModelBoundsRect(manager.currentModel);
            if (!b) return { error: 'no model bounds' };
            const px = b.left + nx * b.width;
            const py = b.top + ny * b.height;
            const customAreaId = manager._getCustomTouchAreaIdAtPoint(px, py);
            const hitAreas = Array.isArray(manager._lastTouchHitAreas)
                ? manager._lastTouchHitAreas
                : [];
            const useBlock = manager._getPreferredTouchSetHitArea(hitAreas, customAreaId);
            return {
                modelName: manager.modelName,
                inMemoryTouchSetKeys: Object.keys(manager.touchSet[manager.modelName] || {}),
                customAreaId,
                useBlock,
            };
        }""",
        {"nx": PROBE_NX, "ny": PROBE_NY},
    )


def _patch_touch_set_as_model_manager_does(page: Page, area_id: str = CUSTOM_AREA_ID) -> dict:
    """模拟模型管理页保存：整模型替换 touch_set[modelName]，含一个自定义区域。"""
    return page.evaluate(
        """async ({ areaId, rect }) => {
            const lanlan = new URLSearchParams(window.location.search).get('lanlan_name')
                || window.lanlan_config?.lanlan_name;
            const modelName = window.live2dManager.modelName;
            const touchSet = {
                default: { motions: [], expressions: [] },
                [areaId]: {
                    motions: [],
                    expressions: [],
                    customArea: {
                        id: areaId, type: 'rect', name: 'repro-stale',
                        rect, createdAt: Date.now(),
                    },
                },
            };
            const resp = await fetch(
                `/api/characters/catgirl/${encodeURIComponent(lanlan)}/touch_set`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model_name: modelName, touch_set: touchSet }),
                }
            );
            return await resp.json();
        }""",
        {"areaId": area_id, "rect": CUSTOM_RECT},
    )


def _server_has_custom_area(page: Page) -> bool:
    return page.evaluate(
        """async (areaId) => {
            const characters = await (await fetch('/api/characters')).json();
            const lanlan = new URLSearchParams(window.location.search).get('lanlan_name')
                || window.lanlan_config?.lanlan_name;
            const reserved = characters['猫娘']?.[lanlan]?._reserved || {};
            const saved = reserved.touch_set?.[window.live2dManager.modelName] || {};
            return !!(saved[areaId] && saved[areaId].customArea);
        }""",
        CUSTOM_AREA_ID,
    )


@pytest.mark.frontend
def test_custom_touch_area_saved_in_model_manager_reaches_main_page_only_after_reload(
    mock_page: Page, running_server: str
):
    """冷启动基线：服务端已保存的自定义区域，主页面冷启动后即可命中。n=3。

    （历史版本曾断言"不刷新页面必须保持陈旧"；修复引入加载完成/保存信号两个
    合法刷新路径后，页面会自愈，该断言不再成立，已被三个修复验证用例取代。）
    """
    mock_page.goto(f"{running_server}/", wait_until="domcontentloaded")
    _wait_main_page_ready(mock_page)

    # ── 模拟模型管理页保存 ────────────────────────────────────────────────
    patch_result = _patch_touch_set_as_model_manager_does(mock_page)
    assert patch_result.get("success"), f"PATCH 保存失败: {patch_result}"
    assert _server_has_custom_area(mock_page), "服务端未落盘自定义区域（保存侧应无问题）"

    # ── 冷启动后同一点应命中（与 onDragEnd 点击分支一致的判定序列） ──────
    mock_page.reload(wait_until="domcontentloaded")
    _wait_main_page_ready(mock_page)

    for attempt in range(REPEATS):
        probe = _route_probe(mock_page)
        assert "error" not in probe, f"第 {attempt + 1} 次探测失败: {probe}"
        assert CUSTOM_AREA_ID in probe["inMemoryTouchSetKeys"], (
            f"第 {attempt + 1} 次：冷启动后内存快照应包含自定义区域: {probe}"
        )
        assert probe["customAreaId"] == CUSTOM_AREA_ID, (
            f"第 {attempt + 1} 次：冷启动后同一点应命中自定义区域: {probe}"
        )
        assert probe["useBlock"] == CUSTOM_AREA_ID, (
            f"第 {attempt + 1} 次：冷启动后路由应指向自定义区域: {probe}"
        )
        mock_page.wait_for_timeout(1000)


@pytest.mark.frontend
def test_touch_set_broadcast_reaches_running_main_page_without_reload(
    mock_page: Page, running_server: str
):
    """修复 B：保存成功后的 neko_touch_set_channel 信号必须让运行中的主页面立即生效。

    通过 API 落盘（等价模型管理页的 PATCH），再调用页面上真实的
    broadcastTouchSetUpdated() 发出保存信号——主页面不刷新，探测即应命中。
    n=3。
    """
    mock_page.goto(f"{running_server}/", wait_until="domcontentloaded")
    _wait_main_page_ready(mock_page)

    area_id = "custom_repro_fix_area_1"
    patch_result = _patch_touch_set_as_model_manager_does(mock_page, area_id)
    assert patch_result.get("success"), f"PATCH 保存失败: {patch_result}"

    mock_page.evaluate(
        """() => {
            broadcastTouchSetUpdated(window.live2dManager.modelName);
        }"""
    )

    for attempt in range(REPEATS):
        probe = _wait_probe_hits(mock_page, area_id)
        assert area_id in probe["inMemoryTouchSetKeys"], (
            f"第 {attempt + 1} 次：内存快照应已包含新区域: {probe['inMemoryTouchSetKeys']}"
        )
        mock_page.wait_for_timeout(1000)


@pytest.mark.frontend
def test_model_reload_hook_refetches_touch_set(
    mock_page: Page, running_server: str
):
    """修复 C：handleModelReload 完成后的刷新钩子必须让新保存的区域在切换后生效。

    通过 API 落盘一个新自定义区域（不发广播信号），然后走真实的
    window.handleModelReload 热切换——完成后探测应命中，证明钩子在切换后
    重新拉取了 touch_set。n=3。
    """
    mock_page.goto(f"{running_server}/", wait_until="domcontentloaded")
    _wait_main_page_ready(mock_page)

    area_id = "custom_repro_reload_area_1"
    patch_result = _patch_touch_set_as_model_manager_does(mock_page, area_id)
    assert patch_result.get("success"), f"PATCH 保存失败: {patch_result}"

    reload_result = mock_page.evaluate(
        """async () => {
            if (typeof window.handleModelReload !== 'function') {
                return { success: false, error: 'handleModelReload unavailable' };
            }
            const lanlan = new URLSearchParams(window.location.search).get('lanlan_name')
                || window.lanlan_config?.lanlan_name;
            await window.handleModelReload(lanlan);
            return { success: true };
        }"""
    )
    assert reload_result.get("success"), f"模型热切换失败: {reload_result}"

    _wait_main_page_ready(mock_page)
    for attempt in range(REPEATS):
        probe = _wait_probe_hits(mock_page, area_id)
        assert probe["useBlock"] == area_id
        mock_page.wait_for_timeout(1000)


@pytest.mark.frontend
def test_refresh_hook_rewires_native_hit_area_listener(
    mock_page: Page, running_server: str
):
    """修复 A（缺陷 2）：模型晚于启动初始化就绪时，刷新钩子必须补上原生 HitArea 接线。

    在已就绪的主页面上模拟"接线从未成功"的状态（清空 _touchSetHitModel/
    _touchSetHitHandler、把数据标记为过期），调用真实刷新钩子后，
    监听必须重新绑定到当前模型实例上。n=3。
    """
    mock_page.goto(f"{running_server}/", wait_until="domcontentloaded")
    _wait_main_page_ready(mock_page)

    for attempt in range(REPEATS):
        state = mock_page.evaluate(
            """() => {
                const manager = window.live2dManager;
                manager._touchSetHitModel = null;
                manager._touchSetHitHandler = null;
                manager._touchSetLoadedAt = 0;  // 标记数据过期 → 刷新走完整重拉路径
                return { modelName: manager.modelName };
            }"""
        )
        assert state["modelName"], "主页面模型名不应为空"

        refreshed = mock_page.evaluate(
            """async () => {
                if (typeof window.nekoRefreshLive2DTouchSet !== 'function') {
                    return { success: false, error: 'refresh hook unavailable' };
                }
                return { success: await window.nekoRefreshLive2DTouchSet() === true };
            }"""
        )
        assert refreshed.get("success"), f"刷新钩子执行失败: {refreshed}"

        wired = mock_page.evaluate(
            """() => {
                const manager = window.live2dManager;
                return {
                    hasHandler: typeof manager._touchSetHitHandler === 'function',
                    boundToCurrentModel: manager._touchSetHitModel === manager.currentModel,
                    loadedAtFresh: (Date.now() - Number(manager._touchSetLoadedAt || 0)) < 5000,
                };
            }"""
        )
        assert wired["hasHandler"], f"第 {attempt + 1} 次：原生 HitArea 监听未被重新接线: {wired}"
        assert wired["boundToCurrentModel"], (
            f"第 {attempt + 1} 次：监听应绑定到当前模型实例: {wired}"
        )
        assert wired["loadedAtFresh"], f"第 {attempt + 1} 次：触摸数据应被重新拉取: {wired}"
        mock_page.wait_for_timeout(500)
