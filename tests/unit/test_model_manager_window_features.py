from pathlib import Path


MODEL_MANAGER_PART_NAMES = (
    "runtime-loaders.js",
    "dropdown-manager.js",
    "page-bridge.js",
    "card-face.js",
    "path-request-fullscreen.js",
    "page-controller.js",
    "window-lifecycle.js",
)


def read_model_manager_source() -> str:
    parts_dir = Path("static/js/model_manager")
    return "".join(
        (parts_dir / part_name).read_text(encoding="utf-8")
        for part_name in MODEL_MANAGER_PART_NAMES
    )


def test_avatar_model_manager_popup_opens_fullscreen():
    source = Path("static/avatar/avatar-ui-popup.js").read_text(encoding="utf-8")

    assert "function buildAvatarFullscreenWindowFeatures()" in source
    assert "screenRef.availWidth || screenRef.width" in source
    assert "screenRef.availHeight || screenRef.height" in source
    assert "features = buildAvatarFullscreenWindowFeatures();" in source
    assert "openModelManagerWindow(finalUrl, windowName, features);" in source
    assert "window.handleHideMainUI()" not in source


def test_yui_model_manager_handoff_opens_fullscreen():
    source = Path("static/tutorial/yui-guide/page-handoff.js").read_text(encoding="utf-8")

    assert "function buildFullscreenWindowFeatures()" in source
    assert "function isModelManagerPageUrl(openUrl)" in source
    assert "if (isModelManagerPageUrl(openUrl))" in source
    assert "return buildFullscreenWindowFeatures();" in source
    start = source.index("function openModelManagerPage(")
    end = source.index("\n    function ", start + len("function openModelManagerPage("))
    model_manager_block = source[start:end]
    assert "buildFullscreenWindowFeatures()" in model_manager_block
    assert "{ keepMainUIVisible: true }" in model_manager_block


def test_model_manager_hides_main_model_only_while_fully_covered():
    model_manager_source = read_model_manager_source()
    interpage_source = Path(
        "static/app/app-interpage/bootstrap-resources-and-model-reload.js"
    ).read_text(encoding="utf-8")
    overlap_start = interpage_source.index("function refreshModelManagerWindowOverlap()")
    overlap_end = interpage_source.index(
        "function scheduleModelManagerWindowOverlapRefresh()", overlap_start
    )
    overlap_body = interpage_source[overlap_start:overlap_end]

    assert "model_manager_window_state" in model_manager_source
    assert "getModelManagerWindowScreenBounds" in model_manager_source
    assert "nekoModelManagerVisibility" in model_manager_source
    assert "document.hasFocus()" in model_manager_source
    assert "const MODEL_MANAGER_VISIBILITY_HEARTBEAT_MS = 400;" in model_manager_source
    assert model_manager_source.count("if (quiet) return;") >= 2
    assert "modelManagerRectFullyCovers" in interpage_source
    assert "clipModelManagerClientRectToViewport" in interpage_source
    assert "getModelManagerActiveModelScreenRect" in interpage_source
    assert "modelManagerCachedModelClientBounds" in interpage_source
    assert "isModelManagerActiveModelDragging" in interpage_source
    assert "I.handleHideMainUI({ reason: 'model-manager-overlap' })" in overlap_body
    assert "I.handleShowMainUI({ reason: 'model-manager-overlap' })" in overlap_body
    assert "scheduleModelManagerWindowOverlapRefresh()" in interpage_source
    assert "mainUIHideOwners = Object.create(null)" in interpage_source
    assert "delete mainUIHideOwners[getMainUIHideOwner(options)]" in interpage_source
    assert overlap_body.index("if (!visibleModelManagerStates.length)") < overlap_body.index(
        "getModelManagerActiveModelScreenRect()"
    )


def test_model_manager_uses_one_non_focusing_window_instance():
    common_dialogs = Path("static/common_dialogs.js").read_text(encoding="utf-8")
    character_manager = Path(
        "static/js/character_card_manager/character-data-and-transfer.js"
    ).read_text(encoding="utf-8")
    tutorial_handoff = Path("static/tutorial/yui-guide/page-handoff.js").read_text(
        encoding="utf-8"
    )
    reuse_start = character_manager.index("if (reusedModelManagerWindow)")
    reuse_end = character_manager.index(
        "window._openSettingsWindows[url] = popup;", reuse_start
    )
    reuse_body = character_manager[reuse_start:reuse_end]

    assert "MODEL_MANAGER_SINGLETON_WINDOW_NAME" in common_dialogs
    assert "pathname === '/model_manager' || pathname === '/l2d'" in common_dialogs
    assert "requestOpenedWindowRestoreIfMinimized(existingWindow)" in common_dialogs
    assert "if (!isModelManager) requestOpenedWindowRestore(newWindow);" in common_dialogs
    assert "neko:restore-window-if-minimized" in common_dialogs
    assert "window.open(url, '_blank'" not in character_manager
    assert "requestOpenedWindowRestoreIfMinimized(existingWindow)" in character_manager
    assert "targetWindow.document.hidden === true" in common_dialogs
    assert "if (!hasNativeRestoreBridge)" in common_dialogs
    assert "onReuse: () => { reusedModelManagerWindow = true; }" in character_manager
    assert "await rollbackAutoCreatedCatgirl(form);" in reuse_body
    assert "if (!isModelManagerPageUrl(targetUrl))" in tutorial_handoff
    assert "pathname === '/model_manager' || pathname === '/l2d'" in tutorial_handoff
    assert "handleHideMainUI({ owner: 'yui-page-handoff' })" in tutorial_handoff
    assert "handleShowMainUI({ owner: 'yui-page-handoff' })" in tutorial_handoff


def test_voice_clone_api_settings_uses_shared_named_window():
    source = Path("static/js/voice_clone.js").read_text(encoding="utf-8")
    common_source = Path("static/common_dialogs.js").read_text(encoding="utf-8")
    open_api_settings = source[source.index("function openApiSettings("):source.index("function openApiSettingsKeyBook(")]
    open_api_settings_key_book = source[source.index("function openApiSettingsKeyBook("):source.index("// 安全地解析 fetch 响应")]

    assert "function buildApiKeySettingsWindowFeatures(width = 1240, height = 940)" in common_source
    assert "window.buildApiKeySettingsWindowFeatures = buildApiKeySettingsWindowFeatures;" in common_source
    assert "const focusKeyBook = !!(options && options.focusKeyBook);" in open_api_settings
    assert "const url = focusKeyBook ? '/api_key?focus=key_book' : '/api_key';" in open_api_settings
    assert "const windowName = 'neko_api_key';" in open_api_settings
    assert "window.buildApiKeySettingsWindowFeatures()" in open_api_settings
    assert "window.openOrFocusWindow(url, windowName, features)" in open_api_settings
    assert "window.open(url, windowName, features)" in open_api_settings
    assert "win.focus()" in open_api_settings
    assert "function notifyApiSettingsKeyBookFocus(win)" in source
    assert "win.postMessage({ type: 'focus_api_key_book' }, window.location.origin);" in source
    assert "notifyApiSettingsKeyBookFocus(win);" in open_api_settings
    assert "openApiSettings({ focusKeyBook: true });" in open_api_settings_key_book
    assert "'apiSettings'" not in open_api_settings
    assert "width=820,height=700" not in source
