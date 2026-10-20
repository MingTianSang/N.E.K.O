/*
 * emote_maker.js
 *
 * A small, local-first preset composer for the N.E.K.O. emote maker.
 * The template library is intentionally empty while the character direction
 * is being reviewed. The editor keeps an explicit empty state so unfinished
 * or mismatched artwork is never shown as a finished template.
 */
(function () {
    'use strict';

    // The helper is loaded as a small standalone UMD module so Node contract
    // tests and the browser preview share the same EmoteLab enum semantics.
    const sceneTextCompat = typeof window !== 'undefined'
        ? window.NekoEmoteSceneText
        : null;

    const CANVAS_SIZE = 1024;
    // These defaults mirror the EmoteLab export profile found in the real
    // YUI package: 240x240, 20 fps, 128 palette colours, and a 1 MB budget.
    // The source Spine canvas remains 1024x1024; only the animated export is
    // downsampled to the interchange profile.
    const GIF_EXPORT_FPS = 20;
    const GIF_EXPORT_WIDTH = 240;
    const GIF_EXPORT_COLORS = 128;
    const GIF_EXPORT_MAX_BYTES = 1000000;
    const GIF_EXPORT_MAX_FRAMES = 120;
    const ICON_ROOT = '/static/icons/';
    const DEFAULT_COLORS = {
        expression: '#ffffff',
        accessory: '#ffd563'
    };
    const COLOR_SWATCHES = [
        '#ffffff', '#5ec9ff', '#8b8df7', '#ff9eaf', '#ffd563', '#9bd89b', '#2a4664',
        '#c4e8f6', '#f4c5de', '#ffbd7b', '#b9a0ff', '#68d6bf', '#f2f4f7', '#ef6e8e'
    ];

    // The previous YUI drafts are intentionally disabled until the character
    // template direction is approved. Keep the editor shell available with an
    // explicit empty library instead of silently showing mismatched artwork.
    const EXPRESSIONS = [];
    const ACCESSORIES = [];

    const EMPTY_EXPRESSION = { id: '', src: '', overlay: null, marker: '', nameKey: 'emoteMaker.noTemplates' };
    const EMPTY_ACCESSORY = { id: '', src: '', nameKey: 'emoteMaker.noTemplates', placement: null };

    // The groups are filters over the original template pack. They keep the
    // editor easy to scan without pretending that a finished reaction PNG is
    // an interchangeable eye, mouth or hair layer.
    const PART_GROUPS = [
        { id: 'template', labelKey: 'emoteMaker.categoryTemplate', kind: 'expression', items: EXPRESSIONS },
        { id: 'mood', labelKey: 'emoteMaker.categoryMood', kind: 'expression', items: EXPRESSIONS.slice(0, 5) },
        { id: 'action', labelKey: 'emoteMaker.categoryAction', kind: 'expression', items: EXPRESSIONS.slice(5) },
        { id: 'decoration', labelKey: 'emoteMaker.categoryDecoration', kind: 'accessory', items: ACCESSORIES }
    ];

    const ANIMATIONS = [
        { id: 'idle', nameKey: 'emoteMaker.animationIdle', duration: 4 },
        { id: 'bounce', nameKey: 'emoteMaker.animationBounce', duration: 2 },
        { id: 'wiggle', nameKey: 'emoteMaker.animationWiggle', duration: 2.5 },
        { id: 'celebrate', nameKey: 'emoteMaker.animationCelebrate', duration: 3 }
    ];

    const state = {
        category: 'template',
        expressionId: '',
        accessoryId: '',
        selectedLayer: 'expression',
        inspectorTab: 'parts',
        colors: { ...DEFAULT_COLORS },
        secondaryColor: '#2a4664',
        colorMode: 'default',
        layerVisible: { background: false, expression: true, accessory: true },
        layerOrder: ['background', 'expression', 'accessory'],
        adjustments: { x: 0, y: 0, rotation: 0, scale: 100 },
        adjustOverwrite: true,
        // 导出设置刻意放在 state 里但不进 cloneState()，所以不进撤销栈 ——
        // Ctrl+Z 不该改到你的输出尺寸。它们单独持久化到 neko-emote-maker-export。
        exportFormat: 'png',
        exportTransparent: true,
        exportResolution: GIF_EXPORT_WIDTH,
        exportFps: GIF_EXPORT_FPS,
        // 'mouth' = 说话时与待机交替一张定格张嘴图（经典 PNGTuber 口型）
        // 'loop'  = 不写 talking_image，待机动画连续播放、不做交替
        packScale: 1,
        packOffsetX: 0,
        packOffsetY: 0,
        packMirror: false,
        // 形象包的状态→场景映射放在 state 里而不是只读 DOM：renderAll 每次都会重建
        // 这些 select，拖拽落点需要一条可靠的写入路径。
        packSceneIds: {},
        // 基础模式的公共时长（null = 演完整段）与包格式
        packName: '',
        packPriority: 'talking',
        packFormat: 'flat',
        // 节点图本身。它是"谁从谁派生、改了什么"的唯一真相，导出读它。
        nodeGraph: null,
        // 形象包的编辑层级：基础只填一个待机场景，进阶交给节点图。
        packMode: 'basic',
        groupPanelOpen: true,
        // 底部「批量导出」那颗按钮的气泡开合：只是当前浏览状态，不存盘
        groupPickerOpen: false,
        zoom: 1,
        recentColors: ['#5ec9ff', '#ffd563', '#ff9eaf', '#8b8df7'],
        assetQuery: '',
        animationId: 'idle',
        animationProgress: 0,
        animationSpeed: 1,
        animationPlaying: false,
        selectedSceneId: '',
        selectedSceneListId: '',
        sceneListFilter: '',
        groupId: '',
        groups: [],
        shots: [],
        templateSkins: [],
        templateSliders: [],
        templateSlots: [],
        templateSlotDefaults: [],
        templateSlotGroup: ''
    };

    // A package is kept in memory only.  The normalized manifest contains
    // paths and metadata; binary assets live in a short-lived client store and
    // are never serialized into localStorage.
    let templatePackage = null;
    let templateAssetStore = null;
    let textureCacheFiles = [];
    // 上次的导入方式，决定"重新打开"该弹哪个选择器。
    let lastImportKind = 'file';
    const groupLibrary = window.NekoEmoteGroupLibrary;
    // 整组导出会一路烘到底，中途不接受再来一次导出或改设置
    let groupExportBusy = false;
    let groupExportAbort = false;
    // 预览列表里的多选集合（动画 id）。批量加组靠它，不然一个个右键点太累。
    const pickedAnimations = new Set();
    // ── 模板库 ────────────────────────────────────────────────────────────────
    // 数据规则都在 emote_template_library.js 里（可单测）；这里只负责喂和画。
    const templateLibraryModule = window.NekoEmoteTemplateLibrary;
    // 本次会话已经读进内存的模板：切回去不该再把几百个场景重新解析一遍。
    const loadedTemplates = new Map();
    let templateLibraryState = templateLibraryModule
        ? templateLibraryModule.emptyStore() : null;
    // 桌面端若能拿到绝对路径，跨重启就能静默重读；拿不到就靠用户点一次重新定位。

    const history = [];
    const future = [];
    const imageCache = new Map();
    let renderToken = 0;
    let toastTimer = null;
    let animationFrameHandle = null;
    let animationLastTimestamp = 0;
    let spineRenderer = null;
    let spineRendererGeneration = 0;
    let spineAnimationFrameHandle = null;
    let spineAnimationLastTimestamp = 0;

    const $ = (selector) => document.querySelector(selector);
    const canvas = $('#emote-canvas');
    const spineCanvas = $('#emote-spine-canvas');
    const outlineCanvas = $('#emote-outline-canvas');
    const textBehindCanvas = $('#emote-text-behind-canvas');
    const textFrontCanvas = $('#emote-text-front-canvas');
    const canvasFrame = $('#canvas-frame');
    const canvasStage = $('.canvas-stage');
    const assetGrid = $('#asset-grid');
    const assetTip = $('#asset-tip');
    const assetSectionTitle = $('#asset-section-title');
    const animationDock = document.querySelector('.animation-dock');
    const layerList = $('#layer-list');
    const colorSwatches = $('#color-swatches');
    const templateSlotControls = $('#template-slot-controls');
    const zoomValue = $('#zoom-value');
    const toast = $('#emote-toast');
    const partGroupList = $('#part-group-list');
    const partGroupHint = document.querySelector('.part-groups-section .part-group-hint');
    const animationList = $('#animation-list');
    const animationProgress = $('#animation-progress');
    const animationTime = $('#animation-time');
    const animationSpeed = $('#animation-speed');
    const templateFileInput = $('#emotelab-template-file');
    const templateDirectoryInput = $('#emotelab-template-directory');
    const templateImportButton = $('#select-emotelab-template-btn');
    const templateDirectoryButton = $('#select-emotelab-template-directory-btn');
    const templateImportStatus = $('#template-import-status');
    const templateRuntimeBadge = $('#template-runtime-badge');
    const templateCanvasStatus = $('#template-canvas-status');
    const templateCanvasStatusText = $('#template-canvas-status-text');
    const canvasImportButton = $('#canvas-import-btn');
    const inspectorEmptyState = $('#inspector-empty-state');
    const templateSceneListSelect = $('#template-scene-list-select');
    const templateSkinControls = $('#template-skin-controls');
    const templateSliderControls = $('#template-slider-controls');
    const assetSearchInput = $('#asset-search-input');

    const fallbackText = {
        'emoteMaker.title': '表情包制作',
        'emoteMaker.assetLibrary': '素材库',
        'emoteMaker.categoryTemplate': '模板',
        'emoteMaker.categoryMood': '情绪',
        'emoteMaker.categoryAction': '动作',
        'emoteMaker.categoryDecoration': '装饰',
        'emoteMaker.categoryHair': '发型',
        'emoteMaker.noTemplates': '模板暂未添加',
        'emoteMaker.emptyLibraryHint': '模板库暂为空，等待添加新模板',
        'emoteMaker.selectTemplateFile': '选择模板文件',
        'emoteMaker.selectTemplateFolder': '选择模板目录',
        'emoteMaker.importingTemplate': '正在读取模板…',
        'emoteMaker.importFailed': '模板添加失败',
        'emoteMaker.importFailedKeepCurrent': '模板读取失败，当前模板未更改。',
        'emoteMaker.templateMetadataOnly': '已读取模板，正在准备预览。',
        'emoteMaker.templateSceneList': '场景列表',
        'emoteMaker.templateCapabilityWarning': '部分预览功能暂不可用，仍可继续编辑模板。',
        'emoteMaker.templateCompatibilityWarning': '部分模板数据与当前素材不一致，已保留可用设置。',
        'emoteMaker.templatePendingPreview': '待预览',
        'emoteMaker.renameTemplate': '重命名模板',
        'emoteMaker.templateFolderIncomplete': '目录内容不完整，请选择包含场景和角色素材的完整素材目录。',
        'emoteMaker.templateFolderCancelled': '未选择模板目录',
        'emoteMaker.templateNoRuntime': '预览暂不可用',
        'emoteMaker.templateLibrary': "已有模板",
        'emoteMaker.removeTemplateConfirm': "删除「{{name}}」？",
        'emoteMaker.groupEmptyList': "暂无组",
        'emoteMaker.confirmCancel': "取消",
        'emoteMaker.confirmDelete': "删除",
        'emoteMaker.archiveSaveFailed': "本地副本没存上：下次打开这个模板可能要重新选一次文件",
        'emoteMaker.templateLibraryEmpty': "这里只有当前这一个模板；再导入一个就会并排留在这里。",
        'emoteMaker.templateInUse': "使用中",
        'emoteMaker.removeTemplate': "移除",
        'emoteMaker.templateSwitched': "已切换模板",
        'emoteMaker.templateImportHint': '支持模板文件或本地素材目录，系统会自动识别可用格式。',
        'emoteMaker.previewTitle': '表情包制作',
        'emoteMaker.modelPreset': '角色预设',
        'emoteMaker.searchParts': '搜索模板',
        'emoteMaker.addToGroup': "加入本组",
        'emoteMaker.saveShot': "存为取景",
        'emoteMaker.groupExportCancel': "停止导出",
        'emoteMaker.groupNameDefault': "未命名组",
        'emoteMaker.groupCreated': "已新建组",
        'emoteMaker.groupReadOnly': "导入的组只能看，要改动请先新建一个组",
        'emoteMaker.groupSceneAdded': "已加入本组",
        'emoteMaker.groupShotSaved': "已把当前画面存为取景",
        'emoteMaker.groupExportNoRuntime': "这个模板跑不起预览，整组导出需要能渲染的模板",
        'emoteMaker.groupExportEmpty': "这一组还是空的：先挑几个场景，或把当前画面存为取景",
        'emoteMaker.groupExporting': "正在导出 {{done}}/{{total}}…",
        'emoteMaker.groupExportDone': "整组已导出",
        'emoteMaker.groupExportCancelled': "已停止，已完成的部分照样打包",
        'emoteMaker.groupExportFailed': "{{count}} 项没能烘出来",
        'emoteMaker.groupExportTruncated': "一次最多导出 {{count}} 张，多余的没导",
        'emoteMaker.groupPickFirst': "组内暂无动作，去添加？",
        'emoteMaker.groupMemberShot': "取景",
        'emoteMaker.groupMemberMissing': "来源已不在当前模板里",
        'emoteMaker.groupRemoveMember': "移出",
        'emoteMaker.groupNoSelection': "先在预览里挑一个画面，再加入本组",
        'emoteMaker.batchExport': "批量导出",
        'emoteMaker.exportCurrent': "导出当前",
        'emoteMaker.batchExportPicker': "选择要导出的组",
        'emoteMaker.batchExportPickerEmpty': "还没有组：先在「批量导出」里按当前配置建一个。",
        'emoteMaker.groupImportedTag': "模板自带",
        'emoteMaker.groupMemberCount': "{{count}} 张",
        'emoteMaker.groupContextTitle': "批量导出组",
        'emoteMaker.groupContextAdd': "加入当前组",
        'emoteMaker.groupContextRemove': "移出当前组",
        'emoteMaker.newGroupFromCurrent': "按当前配置创建组",
        'emoteMaker.newGroupHelp': "新建一个组，并把当前动画作为第一条存入 —— 含你调好的大小、旋转角度等。",
        'emoteMaker.groupNonePicked': "还没选组",
        'emoteMaker.selectedCount': "已选 {{count}} 条",
        'emoteMaker.groupPickedMissing': "{{count}} 个动作没有对应的取景，没法加入",
        'emoteMaker.groupAddedCount': "已加入 {{count}} 条",
        'emoteMaker.groupRemovedCount': "已移出 {{count}} 条",
        'emoteMaker.selectAll': "全选",
        'emoteMaker.selectNone': "取消全选",
        'emoteMaker.resetView': '重置视图',
        'emoteMaker.viewportHint': '滚轮缩放 · Alt+滚轮旋转 · 中键平移',
        'emoteMaker.partsTab': '部件',
        'emoteMaker.adjustTab': '调整',
        'emoteMaker.colorsTab': '颜色',
        'emoteMaker.slotGroup': '色组',
        'emoteMaker.exportTab': '导出设置',
        'emoteMaker.editorPanels': '编辑器面板',
        'emoteMaker.animationProgressLabel': '动画进度',
        'emoteMaker.chooseParts': '选择模板',
        'emoteMaker.activeIndex': '当前变体',
        'emoteMaker.adjustments': '模板调整',
        'emoteMaker.overwrite': '覆盖默认值',
        'emoteMaker.positionX': '位置 X',
        'emoteMaker.positionY': '位置 Y',
        'emoteMaker.rotation': '旋转',
        'emoteMaker.scale': '缩放',
        'emoteMaker.colorMode': '着色模式',
        'emoteMaker.defaultColor': '原色',
        'emoteMaker.tintColor': '单色 Tint',
        'emoteMaker.twoColorTint': '双色 Tint',
        'emoteMaker.tintBlack': '阴影颜色',
        'emoteMaker.animationIdle': '待机',
        'emoteMaker.animationBounce': '弹跳',
        'emoteMaker.animationWiggle': '摇摆',
        'emoteMaker.animationCelebrate': '庆祝',
        'emoteMaker.speed': '速度',
        'emoteMaker.exportFormat': '格式',
        'emoteMaker.exportStatic': '静态 PNG',
        'emoteMaker.exportAnimated': '动画 GIF',
        'emoteMaker.exportGifProgress': '正在编码动画 GIF…',
        'emoteMaker.exportGifFailed': '动画 GIF 导出失败',
        'emoteMaker.exportGifUnavailable': '当前模板暂不支持动画导出',
        'emoteMaker.exportGifSuccess': 'GIF 已导出',
        'emoteMaker.exportPngFailed': 'PNG 导出失败，请重试。',
        'emoteMaker.exportResolution': '分辨率',
        'emoteMaker.exportFps': '帧率',
        'emoteMaker.packTitle': '形象包（PNGTuber）',
        'emoteMaker.packDropNoScene': '这个动画没有被任何场景引用，无法作为状态拖入。',
        'emoteMaker.packSkipOption': '不导出',
        'emoteMaker.packStateIdle': '待机',
        'emoteMaker.packStateTalking': '说话',
        'emoteMaker.packStateDrag': '拖拽',
        'emoteMaker.packStateClick': '点击',
        'emoteMaker.packStateHappy': '开心',
        'emoteMaker.packStateSad': '难过',
        'emoteMaker.packStateAngry': '生气',
        'emoteMaker.packStateSurprised': '惊讶',
        'emoteMaker.packExportZip': '导出形象包',
        'emoteMaker.packImportNow': '导入到模型管理',
        'emoteMaker.packBakingProgress': '正在生成形象包…',
        'emoteMaker.packIdleRequired': '需要先为「待机」挑选一个场景。',
        'emoteMaker.packZipSuccess': '形象包已导出。解压后在模型管理里选择解压出的文件夹导入。',
        'emoteMaker.packZipFailed': '形象包生成失败。',
        'emoteMaker.packImportSuccess': '形象包已导入模型管理。',
        'emoteMaker.packImportFailed': '形象包导入失败。',
        'emoteMaker.segmentScenes': '场景',
        'emoteMaker.segmentAnimations': '动画',
        'emoteMaker.listModeAria': '列表内容',
        'emoteMaker.resizeLibraryAria': '调整素材库宽度',
        'emoteMaker.resizeInspectorAria': '调整部件设置宽度',
        'emoteMaker.resizeListAria': '调整列表高度',
        'emoteMaker.packBasicFollowRoot': '跟随待机',
        'emoteMaker.packFormatLabel': '包格式',
        'emoteMaker.packFormatFlat': '平铺（GIF，通用兼容）',
        'emoteMaker.packFormatLayered': '分层（多状态，可驱动）',
        'emoteMaker.packLayeredUnavailable': '分层打包模块未加载。',
        'emoteMaker.packModeAria': '编辑方式',
        'emoteMaker.packModeBasic': '基础',
        'emoteMaker.packBasicMouthOn': "说话时切给你绑在「说话」上的那个动作。",
        'emoteMaker.packModeGraph': "进阶",
        'emoteMaker.stageOpen': "打开进阶设置",
        'emoteMaker.stageTitle': "进阶设置",
        'emoteMaker.stageClose': "关闭",
        'emoteMaker.stageCanvasAria': "状态预览台",
        'emoteMaker.stageShelfAria': "状态格",
        'emoteMaker.stageAnimation': "这个状态用的动画",
        'emoteMaker.stageStripAria': "胶片带：拖动两端设置起止帧",
        'emoteMaker.stagePlayWhole': "整段播放",
        'emoteMaker.stageResetPose': "复位大小和角度",
        'emoteMaker.stagePoseNeedsLayered': "平铺包不保存每个状态的大小和角度；换成「分层」格式才会生效。",
        'emoteMaker.stageNoFrames': "这个状态还没有可预览的帧，先在下面选一条动画。",
        'emoteMaker.stageScale': "大小",
        'emoteMaker.stageAngle': "角度",
        'emoteMaker.stageFollowTag': "跟随默认",
        'emoteMaker.stageStillTag': "定格",
        'emoteMaker.stageUseDefaults': "跟随默认外观",
        'emoteMaker.stageGestureHint': "拖动旋转，滚轮缩放",
        'emoteMaker.stageLibrary': "动作库",
        'emoteMaker.stageUserImages': "图片库",
        'emoteMaker.stageImportImages': "导入图片",
        'emoteMaker.stageNoUserImages': "还没有导入图片，点「导入图片」加几张",
        'emoteMaker.stageImagesPngOnly': "只支持 PNG 图片",
        'emoteMaker.stageImagesImported': "已导入 {{count}} 张图片",
        'emoteMaker.stageImagesSaveFailed': "图片没存进模板副本：下次打开可能要重新导入",
        'emoteMaker.nodeSourceImage': "用户图片",
        'emoteMaker.stageSearch': "搜索动作",
        'emoteMaker.packPlanSkipped': "已跳过未设置的槽位",
        'emoteMaker.packPriorityLabel': "状态优先级",
        'emoteMaker.packPriorityHint': "说话优先时情绪在说话后播放，情绪优先时说话期间触发情绪会覆盖说话动画",
        'emoteMaker.packPriorityTalking': "说话优先",
        'emoteMaker.packPriorityEmotion': "情绪优先",
        'emoteMaker.packPlanUnassigned': "未选动作",
        'emoteMaker.packPlanDuplicate': "同一槽位重复",
        'emoteMaker.graphCollapsedNotice': "已合并重复的槽位，保留你选过的动作",
        'emoteMaker.stageUnavailable': "状态表演台未加载。",
        'emoteMaker.packNeedsTemplate': "需要先载入模板并导入动画。",
        'emoteMaker.nodeCat.source': '来源',
        'emoteMaker.nodeCat.modify': '加工',
        'emoteMaker.nodeCat.output': '输出',
        'emoteMaker.nodeSourceDefault': '默认外观',
        'emoteMaker.nodeSourceScene': '指定场景',
        'emoteMaker.nodeModSkin': '皮肤',
        'emoteMaker.nodeModSlider': '滑杆',
        'emoteMaker.nodeModSlotTint': '色组着色',
        'emoteMaker.nodeModText': '文字',
        'emoteMaker.nodeModTransform': '变换',
        'emoteMaker.nodeOutputState': '状态输出',
        'emoteMaker.nodeParam.sceneId': '场景',
        'emoteMaker.nodeParam.seconds': '时长',
        'emoteMaker.nodeParam.stateKey': '状态',
        'emoteMaker.nodeParam.groups': '皮肤',
        'emoteMaker.nodeParam.name': '名称',
        'emoteMaker.nodeParam.value': '数值',
        'emoteMaker.nodeParam.tag': '标签',
        'emoteMaker.nodeParam.color': '颜色',
        'emoteMaker.nodeParam.secondary': '阴影',
        'emoteMaker.nodeParam.content': '内容',
        'emoteMaker.nodeParam.side': '图层',
        'emoteMaker.nodeParam.size': '字号',
        'emoteMaker.nodeParam.x': '偏移 X',
        'emoteMaker.nodeParam.y': '偏移 Y',
        'emoteMaker.nodeParam.scale': '缩放',
        'emoteMaker.nodeParam.mirror': '镜像',
        'emoteMaker.nodeCycleWarning': '节点之间存在环，无法求值。',
        'emoteMaker.nodeNoOutput': '节点图里没有一个可用的输出（检查场景是否已选）。',
        'emoteMaker.undo': '撤销',
        'emoteMaker.redo': '重做',
        'emoteMaker.fitWindow': '适应窗口',
        'emoteMaker.partSettings': '模板设置',
        'emoteMaker.recentColors': '最近使用',
        'emoteMaker.layers': '图层顺序',
        'emoteMaker.visible': '显示',
        'emoteMaker.hidden': '隐藏',
        'emoteMaker.moveUp': '上移',
        'emoteMaker.moveDown': '下移',
        'emoteMaker.exportPng': '导出 PNG',
        'emoteMaker.transparentBackground': '透明背景',
        'emoteMaker.exportSuccess': 'PNG 已导出',
        'emoteMaker.reset': '重置',
        'emoteMaker.layerNames.background': '背景',
        'emoteMaker.layerNames.expression': '表情',
        'emoteMaker.layerNames.accessory': '配饰'
    };

    function t(key) {
        try {
            if (typeof window.t === 'function') {
                const translated = window.t(key);
                if (translated && translated !== key) return translated;
            }
        } catch (error) {
            // Keep the editor usable if the locale bundle is still loading.
        }
        return fallbackText[key] || key;
    }

    function getImportedScenes() {
        return Array.isArray(templatePackage?.scenes) ? templatePackage.scenes : [];
    }

    function getImportedAnimations() {
        const entries = Array.isArray(templatePackage?.catalogs?.animations)
            ? templatePackage.catalogs.animations
            : [];
        const result = entries.map((item) => ({ ...item }));
        const known = new Set(result.map((item) => String(item.id || '')));
        const nativeAnimations = spineRenderer?.animations?.() || [];
        nativeAnimations.forEach((item) => {
            const id = String(item?.name || '');
            if (!id || known.has(id)) return;
            known.add(id);
            result.push({ id, displayName: id, labels: {}, runtimeOnly: true });
        });
        return result;
    }

    /**
     * 有没有可播放的动画。带模板时要把整份动画清单过一遍（runtimeOnly 过滤），
     * 这个结果在清单不变时是常量 —— 缓存它，播放循环里就不必每帧重算。
     */
    let playableMemo = { key: '', value: false };

    function hasPlayableAnimations() {
        if (!templatePackage) {
            return EXPRESSIONS.length > 0 || ACCESSORIES.length > 0;
        }
        const key = listsSignature(getVisibleImportedAnimations(), 'anim');
        if (playableMemo.key !== key) {
            playableMemo = { key, value: getVisibleImportedAnimations().length > 0 };
        }
        return playableMemo.value;
    }

    function getVisibleImportedAnimations() {
        const scenes = getImportedScenes();
        const sceneAnimationIds = new Set(
            scenes
                .map((scene) => String(scene?.animation?.id || ''))
                .filter(Boolean),
        );
        return getImportedAnimations().filter((item) => {
            if (!item?.runtimeOnly) return true;
            const id = String(item.id || '');
            // Spine also exposes internal CHAR/*, slot and constraint tracks.
            // They are useful to the runtime but are not user-facing actions.
            // Keep runtime-only tracks when a scene references them, plus the
            // conventional public ANIM/ namespace for incomplete catalogs.
            return sceneAnimationIds.has(id) || /^(ANIM|EMOTE|MOTION|ACTION)(\/|$)/i.test(id);
        });
    }

    function getCatalogLabel(item) {
        if (!item) return '';
        const labels = item.labels || {};
        const language = document.documentElement.lang || 'zh-CN';
        return labels[language] || labels[language.replace('-', '_')] || labels.en || item.displayName || item.id || '';
    }

    function setTemplateImportStatus(message, tone = 'muted') {
        if (!templateImportStatus) return;
        templateImportStatus.textContent = message;
        templateImportStatus.dataset.tone = tone;
    }

    function hasSpineRenderer() {
        return Boolean(spineRenderer && !spineRenderer.disposed && spineRenderer.loaded);
    }

    function setCanvasMode(nativePreview) {
        if (canvas) canvas.hidden = Boolean(nativePreview);
        if (spineCanvas) spineCanvas.hidden = !nativePreview;
        if (outlineCanvas) outlineCanvas.hidden = !nativePreview;
        if (textBehindCanvas) textBehindCanvas.hidden = !nativePreview;
        if (textFrontCanvas) textFrontCanvas.hidden = !nativePreview;
        if (templateCanvasStatus) templateCanvasStatus.hidden = Boolean(nativePreview);
    }

    function stopSpineAnimationLoop() {
        if (spineAnimationFrameHandle) {
            window.cancelAnimationFrame(spineAnimationFrameHandle);
            spineAnimationFrameHandle = null;
        }
        spineAnimationLastTimestamp = 0;
    }

    function stopAnimationLoops() {
        stopSpineAnimationLoop();
        if (animationFrameHandle) {
            window.cancelAnimationFrame(animationFrameHandle);
            animationFrameHandle = null;
        }
        animationLastTimestamp = 0;
    }

    function disposeSpineRenderer() {
        stopAnimationLoops();
        if (spineRenderer && typeof spineRenderer.dispose === 'function') {
            try {
                spineRenderer.dispose();
            } catch (_) {
                // Native WebGL teardown is best effort during replacement.
            }
        }
        spineRenderer = null;
        setCanvasMode(false);
    }

    function releaseAssetStore(store) {
        if (!store || typeof store.release !== 'function') return;
        try {
            store.release();
        } catch (_) {
            // Releasing local object URLs is best effort during navigation.
        }
    }

    function releaseTemplateAssetStore() {
        releaseAssetStore(templateAssetStore);
        templateAssetStore = null;
    }

    function buildTemplateAssetStore(zipStore, textureFiles = textureCacheFiles) {
        if (!zipStore) return null;
        const Overlay = window.NekoEmoteClientZipStore?.ClientFileOverlayStore;
        if (!textureFiles.length || typeof Overlay !== 'function') return zipStore;
        return new Overlay(zipStore, textureFiles);
    }

    function normalizeTextureCacheFiles(files) {
        return Array.from(files || []).filter((file) => {
            const path = String(file?.webkitRelativePath || file?.name || '').toLowerCase();
            return path.endsWith('.png');
        });
    }
    function importFailureMessage(error) {
        if (isIncompleteTemplateError(error)) {
            return t('emoteMaker.templateFolderIncomplete');
        }
        return t('emoteMaker.importFailedKeepCurrent');
    }

    function reportImportFailure(error, options = {}) {
        const message = importFailureMessage(error);
        setTemplateImportStatus(
            message,
            isIncompleteTemplateError(error) ? 'warning' : 'error',
        );
        showToast(message);
    }

    function getTemplateAssetPaths(packageManifest) {
        const paths = [
            packageManifest?.model?.skeleton?.path,
            packageManifest?.model?.atlas?.path,
            ...(Array.isArray(packageManifest?.model?.atlas?.pages)
                ? packageManifest.model.atlas.pages.map((page) => page?.path)
                : [])
        ];
        return [...new Set(paths.filter((path) => typeof path === 'string' && path))];
    }

    function getImportedAnimationDuration(animationId) {
        if (!animationId) return 0;
        const native = spineRenderer?.animations?.().find((item) => item.name === animationId);
        if (native && Number.isFinite(Number(native.duration))) return Number(native.duration);
        return 0;
    }

    function getSelectedScene() {
        return getImportedScenes().find((scene) => scene.id === state.selectedSceneId) || null;
    }

    function getTemplateSkinSelections() {
        if (Array.isArray(state.templateSkins) && state.templateSkins.length) {
            return state.templateSkins.map((item) => ({ ...item }));
        }
        return Array.isArray(templatePackage?.character?.skins)
            ? templatePackage.character.skins.map((item) => ({ ...item }))
            : [];
    }

    function getTemplateSliderValues() {
        if (Array.isArray(state.templateSliders) && state.templateSliders.length) {
            return state.templateSliders.map((item) => ({ ...item }));
        }
        return Array.isArray(templatePackage?.character?.sliders)
            ? templatePackage.character.sliders.map((item) => ({ ...item }))
            : [];
    }

    function getTemplateSlotStyles() {
        if (Array.isArray(state.templateSlots) && state.templateSlots.length) {
            return state.templateSlots.map((item) => ({
                ...item,
                tintColor: item?.tintColor ? { ...item.tintColor } : null,
                tintBlackColor: item?.tintBlackColor ? { ...item.tintBlackColor } : null,
            }));
        }
        return Array.isArray(templatePackage?.character?.slots)
            ? templatePackage.character.slots.map((item) => ({
                ...item,
                tintColor: item?.tintColor ? { ...item.tintColor } : null,
                tintBlackColor: item?.tintBlackColor ? { ...item.tintBlackColor } : null,
            }))
            : [];
    }

    function colorToHex(value, fallback = '#ffffff') {
        if (!value || typeof value !== 'object') return fallback;
        const channel = (key, fallbackValue) => {
            const number = Number(value[key]);
            return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallbackValue;
        };
        const bytes = ['r', 'g', 'b'].map((key) => Math.round(channel(key, 1) * 255));
        return `#${bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    }

    function hexToTemplateColor(value, fallback = { r: 1, g: 1, b: 1, a: 1 }) {
        const color = hexToColor(value, fallback);
        return { r: color.r, g: color.g, b: color.b, a: color.a };
    }

    function getTemplateSkinOptions() {
        const options = spineRenderer?.skinOptions?.() || {};
        return options && typeof options === 'object' ? options : {};
    }

    function applyNativeCharacterState({ render = true } = {}) {
        if (!hasSpineRenderer()) return false;
        try {
            spineRenderer.setCharacterState({
                skins: getTemplateSkinSelections(),
                sliders: getTemplateSliderValues(),
                slots: getTemplateSlotStyles(),
            }, { render });
            return true;
        } catch (_) {
            return false;
        }
    }

    function getNativeTransform() {
        const adjustments = state.adjustOverwrite ? state.adjustments : null;
        return {
            x: Number(adjustments?.x) || 0,
            y: Number(adjustments?.y) || 0,
            rotation: Number(adjustments?.rotation) || 0,
            scale: Math.max(0.01, (Number(adjustments?.scale) || 100) / 100),
        };
    }

    function syncNativeScene(scene = getSelectedScene(), { autoplay = state.animationPlaying } = {}) {
        if (!hasSpineRenderer() || !scene) return false;
        const animationId = state.animationId || scene.animation?.id;
        if (!animationId || !spineRenderer.animationNames().includes(animationId)) return false;
        const duration = getImportedAnimationDuration(animationId);
        const sceneTime = Number(scene.animation?.time) || 0;
        const progressTime = duration > 0
            ? duration * Math.max(0, Math.min(100, Number(state.animationProgress) || 0)) / 100
            : sceneTime;
        const time = state.animationProgress > 0 ? progressTime : sceneTime;
        try {
            spineRenderer.setScene(scene, { render: false });
            spineRenderer.setTransform(getNativeTransform(), { render: false });
            spineRenderer.selectAnimation(animationId, {
                loop: true,
                time,
                autoplay,
                render: false,
            });
            if (autoplay) spineRenderer.play();
            else spineRenderer.pause();
            applyNativeCharacterState({ render: false });
            state.animationId = animationId;
            if (duration > 0) state.animationProgress = (time / duration) * 100;
            spineRenderer.render();
            renderNativeOverlays();
            return true;
        } catch (_) {
            return false;
        }
    }

    function syncNativeTimeFromProgress() {
        if (!hasSpineRenderer()) return false;
        const duration = getImportedAnimationDuration(state.animationId);
        if (!(duration > 0)) return false;
        try {
            spineRenderer.setTime(duration * Math.max(0, Math.min(100, state.animationProgress)) / 100);
            spineRenderer.render();
            renderNativeOverlays();
            return true;
        } catch (_) {
            return false;
        }
    }

    function startSpineAnimationLoop() {
        if (!hasSpineRenderer() || !state.animationPlaying || spineAnimationFrameHandle) return;
        spineAnimationLastTimestamp = 0;
        spineAnimationFrameHandle = window.requestAnimationFrame(spineAnimationTick);
    }

    function spineAnimationTick(timestamp) {
        spineAnimationFrameHandle = null;
        if (!hasSpineRenderer() || !state.animationPlaying) return;
        if (!spineAnimationLastTimestamp) spineAnimationLastTimestamp = timestamp;
        const elapsed = Math.max(0, Math.min(250, timestamp - spineAnimationLastTimestamp));
        spineAnimationLastTimestamp = timestamp;
        const sceneSpeed = Number(getSelectedScene()?.animation?.speed) || 1;
        try {
            const frame = spineRenderer.tick(
                (elapsed / 1000) * Math.max(0.05, state.animationSpeed) * sceneSpeed,
                { render: true },
            );
            renderNativeOverlays();
            const duration = getImportedAnimationDuration(state.animationId);
            if (duration > 0) state.animationProgress = ((frame.time % duration) / duration) * 100;
            updateAnimationControls();
        } catch (_) {
            state.animationPlaying = false;
            updateAnimationControls();
            return;
        }
        spineAnimationFrameHandle = window.requestAnimationFrame(spineAnimationTick);
    }

    async function activateNativeSpineRenderer() {
        const generation = ++spineRendererGeneration;
        disposeSpineRenderer();
        if (!templatePackage || !templateAssetStore || !spineCanvas) return;
        const api = window.NekoEmoteSpineRenderer;
        if (!api || typeof api.create !== 'function') return;

        setCanvasMode(true);
        setTemplateImportStatus(t('emoteMaker.importingTemplate'));
        try {
            const renderer = await api.create({
                canvas: spineCanvas,
                manifest: templatePackage,
                assetStore: templateAssetStore,
                animationName: state.animationId,
                loop: true,
                renderOnLoad: false,
                fitPadding: 1.05,
            });
            if (generation !== spineRendererGeneration || !templatePackage) {
                renderer.dispose();
                return;
            }
            spineRenderer = renderer;
            templatePackage.capabilities = {
                ...(templatePackage.capabilities || {}),
                spineRender: true,
                // Current-frame PNG is verified separately from animated
                // export.  Keep the broad legacy flag false so callers do not
                // mistake this for full EmoteLab export parity (notably GIF).
                nativeExport: false,
                staticPngExport: true,
                animatedExport: Boolean(window.NekoEmoteGifEncoder?.toBlob),
                sceneOutline: true,
                sceneText: true,
                sceneOverlay: 'canvas2d-compatible',
            };
            syncNativeScene(getSelectedScene(), { autoplay: state.animationPlaying });
            const warnings = [
                ...(Array.isArray(templatePackage.warnings) ? templatePackage.warnings : []),
                ...(Array.isArray(renderer.status().warnings) ? renderer.status().warnings : []),
            ].filter((warning) => {
                if (!warning || String(warning).includes('已忽略')) return false;
                if (templatePackage.character?.customTextureCache?.provided
                    && String(warning).includes('外部贴图')) return false;
                return true;
            });
            setTemplateImportStatus(
                warnings.length ? presentTemplateWarning(warnings[0]) : '',
                warnings.length ? 'warning' : 'success',
            );
            setCanvasMode(true);
            renderAll();
            if (state.animationPlaying) startSpineAnimationLoop();
        } catch (error) {
            if (generation !== spineRendererGeneration) return;
            disposeSpineRenderer();
            setTemplateImportStatus(
                t('emoteMaker.templateCapabilityWarning'),
                'warning',
            );
            renderAll();
        }
    }

    function interpolate(value, values) {
        return String(value || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) => String(values?.[key] ?? ''));
    }

    function selectImportedScene(scene) {
        if (!scene) return;
        state.selectedSceneId = scene.id;
        state.selectedSceneListId = scene.source?.sceneList || '';
        state.animationId = scene.animation?.id || '';
        state.animationProgress = 0;
        state.animationPlaying = false;
        stopAnimationLoops();
        // Scene cards are playback choices too: selecting one should show the
        // scene's first frame immediately and start its animation when the
        // native renderer is available.
        startSelectedAnimationPlayback();
        renderAll();
        // 选中的场景也要落盘：以前只在导入和关页时存，所以"重新打开"或从模板库
        // 切回来永远落回第一个场景，用户挑的那个丢了。
        persistTemplateSession();
        persistTemplateToLibrary();
    }

    function cloneState() {
        return JSON.parse(JSON.stringify({
            category: state.category,
            expressionId: state.expressionId,
            accessoryId: state.accessoryId,
            selectedLayer: state.selectedLayer,
            inspectorTab: state.inspectorTab,
            colors: state.colors,
            secondaryColor: state.secondaryColor,
            colorMode: state.colorMode,
            layerVisible: state.layerVisible,
            layerOrder: state.layerOrder,
            recentColors: state.recentColors,
            adjustments: state.adjustments,
            adjustOverwrite: state.adjustOverwrite,
            animationId: state.animationId,
            animationProgress: state.animationProgress,
            animationSpeed: state.animationSpeed,
            selectedSceneId: state.selectedSceneId,
            selectedSceneListId: state.selectedSceneListId,
            sceneListFilter: state.sceneListFilter,
            templateSkins: state.templateSkins,
            templateSliders: state.templateSliders,
            templateSlots: state.templateSlots,
            templateSlotDefaults: state.templateSlotDefaults,
            templateSlotGroup: state.templateSlotGroup
        }));
    }

    function restoreState(snapshot) {
        Object.assign(state, JSON.parse(JSON.stringify(snapshot)));
        renderAll();
    }

    function recordChange(mutator) {
        const before = cloneState();
        mutator();
        history.push(before);
        future.length = 0;
        if (history.length > 40) history.shift();
        renderAll();
    }

    function undo() {
        if (!history.length) return;
        future.push(cloneState());
        restoreState(history.pop());
        updateHistoryButtons();
    }

    function redo() {
        if (!future.length) return;
        history.push(cloneState());
        restoreState(future.pop());
        updateHistoryButtons();
    }

    function getExpression() {
        return EXPRESSIONS.find((item) => item.id === state.expressionId) || EMPTY_EXPRESSION;
    }

    function getAccessory() {
        return ACCESSORIES.find((item) => item.id === state.accessoryId) || EMPTY_ACCESSORY;
    }

    function getSelectedColor() {
        return state.colors[state.selectedLayer] || state.colors.expression;
    }

    function setSelectedColor(color) {
        if (!color) return;
        recordChange(() => {
            state.colors[state.selectedLayer] = color;
            state.colorMode = 'tint';
            state.recentColors = [color, ...state.recentColors.filter((item) => item.toLowerCase() !== color.toLowerCase())].slice(0, 6);
        });
    }

    function hexToColor(value, fallback = { r: 1, g: 1, b: 1, a: 1 }) {
        const text = String(value || '').trim().replace(/^#/, '');
        if (!/^[0-9a-f]{6}$/i.test(text)) return fallback;
        return {
            r: parseInt(text.slice(0, 2), 16) / 255,
            g: parseInt(text.slice(2, 4), 16) / 255,
            b: parseInt(text.slice(4, 6), 16) / 255,
            a: 1,
        };
    }

    function applyNativeVisualState({ render = false } = {}) {
        if (!hasSpineRenderer()) return false;
        try {
            spineRenderer.setColorMode({
                mode: state.colorMode,
                primary: hexToColor(state.colors[state.selectedLayer] || state.colors.expression),
                secondary: hexToColor(state.secondaryColor, { r: 0, g: 0, b: 0, a: 1 }),
            }, { render: false });
            spineRenderer.setTransform(getNativeTransform(), { render: false });
            const transparent = state.exportTransparent !== false;
            spineRenderer.setBackground(transparent ? [0, 0, 0, 0] : [0.96, 0.98, 1, 1], { render: false });
            if (render) spineRenderer.render();
            if (render) renderNativeOverlays();
            return true;
        } catch (_) {
            return false;
        }
    }



    function createTemplateLibraryCard(entry) {
        const card = document.createElement('div');
        card.className = 'asset-card template-lib-card';
        card.dataset.templateKey = entry.key;
        const isCurrent = entry.key === currentTemplateKey();
        if (isCurrent) card.classList.add('is-selected');

        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'template-lib-open';
        const label = document.createElement('span');
        label.className = 'asset-card-label';
        // 显示名的裁决在库里（用户改的名 > 来源名 > 模板自报名 > 包名），别在这再写一条链
        label.textContent = templateLibraryModule.entryLabel(entry)
            || t('emoteMaker.templateSceneList');
        open.append(label);
        // 单击=装回模板，双击=改名：不延迟的话，双击的头一下已经把模板切过去了。
        // 240ms 的延迟对一次重导入级的操作无感。当前使用中的那条点了没去处，就地挡住。
        // 处理器放在**卡片层**而不是内层按钮上：卡片有 padding，点边缘时 target 是
        // 卡片自己，绑在按钮上那 7~8px 的边就点不动。移除钮和改名框各自挡掉。
        let openTimer = 0;
        card.addEventListener('click', (event) => {
            if (event.target.closest('.template-lib-remove')) return;
            if (event.target.closest('.template-lib-rename')) return;
            if (isCurrent || packBusy) return;
            clearTimeout(openTimer);
            openTimer = setTimeout(() => { void switchTemplate(entry.key); }, 240);
        });
        // 副本占多少就写多少：真实数字（后端 stat 来的），不是估的
        const archiveBytes = templateArchiveBytes.get(entry.key) || 0;
        if (archiveBytes > 0) {
            const size = document.createElement('small');
            size.className = 'template-lib-size';
            size.textContent = formatTemplateBytes(archiveBytes);
            open.append(size);
        }
        // 不能用 disabled 挡"当前使用中"：禁用按钮连同后代根本不派发指针事件，
        // 双击改名就永远落不到卡片上（当场踩过）。视觉用 aria-disabled 走同一套样式，
        // 行为在 click 处理器里挡。
        open.setAttribute('aria-label', `${label.textContent}${isCurrent ? ` · ${t('emoteMaker.templateInUse')}` : ''}`);
        open.disabled = packBusy;
        if (isCurrent) open.setAttribute('aria-disabled', 'true');

        const removeButton = document.createElement('button');
        removeButton.type = 'button';
        removeButton.className = 'template-lib-remove';
        removeButton.dataset.templateKey = entry.key;
        removeButton.setAttribute('aria-label', `${t('emoteMaker.removeTemplate')} · ${label.textContent}`);
        removeButton.textContent = '×';
        removeButton.addEventListener('click', (event) => {
            event.stopPropagation();
            removeTemplate(entry.key);
        });

        // 双击（整张卡都行，当前使用中的那条打开按钮是灰的也要能改名）= 就地改名；
        // 点在移除上不算。双击要先取消那个"单击切换"的定时器。
        card.addEventListener('dblclick', (event) => {
            if (event.target.closest('.template-lib-remove')) return;
            event.preventDefault();
            clearTimeout(openTimer);
            beginTemplateRename(entry.key, card);
        });

        // 完整名字给 title：一行装不下时鼠标悬停还能看全
        open.title = label.textContent;
        card.append(open);
        if (isCurrent) {
            const badge = document.createElement('span');
            badge.className = 'template-lib-badge';
            badge.textContent = t('emoteMaker.templateInUse');
            card.append(badge);
        }
        card.append(removeButton);
        return card;
    }

    /**
     * 双击卡片就地改名：整张卡换成一个输入框（input 不能住在 button 里——
     * 点它定位光标会触发"打开模板"），Enter/失焦提交，Esc 放弃。
     * 改成空 = 回到默认名。只动 alias，键不动 —— 改名是外观，不是身份，
     * 本地副本、会话、组都不跟着挪。
     */
    function beginTemplateRename(key, card) {
        const current = templateLibraryModule
            ? templateLibraryModule.entryLabel(
                templateLibraryModule.find(templateLibraryState, key)) : '';
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'template-lib-rename';
        input.value = current;
        input.maxLength = templateLibraryModule?.MAX_LABEL_CHARS || 60;
        input.setAttribute('aria-label', t('emoteMaker.renameTemplate'));
        input.dataset.key = key;
        card.replaceChildren(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (commit) => {
            if (done) return;
            done = true;
            const value = commit ? input.value : '';
            if (commit && value.trim() !== current.trim()) {
                templateLibraryState = templateLibraryModule.renameEntry(
                    templateLibraryState, key, value);
                try {
                    templateLibraryModule.save(localStorage, templateLibraryState);
                } catch (_) { /* 存不下只丢这一次改名 */ }
                renderAll();
                return;
            }
            renderTemplateLibraryGrid();
        };
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                finish(true);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                finish(false);
            }
            event.stopPropagation();
        });
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('dblclick', (event) => event.stopPropagation());
    }

    function renderTemplateLibraryGrid() {
        if (!assetSectionTitle || !assetGrid) return;
        assetGrid.classList.add('is-template-library');
        assetSectionTitle.textContent = t('emoteMaker.templateLibrary');
        const entries = templateLibraryModule && templateLibraryState
            ? [...templateLibraryState.entries] : [];
        const query = String(state.assetQuery || '').trim().toLocaleLowerCase();
        const shown = query
            ? entries.filter((entry) => `${entry.displayName || ''} ${entry.packageName || ''}`
                .toLocaleLowerCase().includes(query))
            : entries;
        if (!shown.length) {
            const empty = document.createElement('div');
            empty.className = 'empty-template-state';
            empty.setAttribute('role', 'status');
            empty.textContent = query ? t('emoteMaker.noTemplates') : t('emoteMaker.templateLibraryEmpty');
            assetGrid.replaceChildren(empty);
            return;
        }
        assetGrid.replaceChildren(...shown.map(createTemplateLibraryCard));
    }



    // 下拉只有一处构建者：以前这里和 renderGroupBar 各写一份，renderAnimations 之后
    // 跑到哪儿就把选项盖回哪份，界面上出现的是"场景列表 / ModelA (3)"这种老文案。
    function renderSceneListFilter() {
        if (!templateSceneListSelect) return;
        if (!templatePackage) {
            templateSceneListSelect.replaceChildren();
            return;
        }
        // 预览下方那份动画列表不再跟组联动：组只管"导出哪几张"，看动作归看动作
        const groups = allGroups();
        const options = groups.length
            ? []
            : [new Option(t('emoteMaker.groupEmptyList'), '')];
        groups.forEach((group) => {
            options.push(new Option(
                group.readOnly && group.count ? `${group.name} · ${group.count}` : group.name,
                group.id,
            ));
        });
        templateSceneListSelect.replaceChildren(...options);
        templateSceneListSelect.value = state.groupId;
    }

    function renderAssetGrid() {
        if (!assetGrid || !assetSectionTitle) return;
        // 左侧永远是模板库：加载了模板它是"最近用过"，没加载它就是入口本身
        //（点一条 = 从本地副本装回来）。以前的部件网格依赖 EXPRESSIONS 那套
        // 永远为空的脚手架，早就只剩一排点不动的分类。
        renderTemplateLibraryGrid();
    }

    function getPartGroup(groupId) {
        return PART_GROUPS.find((group) => group.id === groupId) || PART_GROUPS[0];
    }

    function getPartIndex(group) {
        const selectedId = group.kind === 'expression' ? state.expressionId : state.accessoryId;
        const index = group.items.findIndex((item) => item.id === selectedId);
        return index >= 0 ? index : -1;
    }

    function cyclePart(groupId, delta) {
        const group = getPartGroup(groupId);
        if (!group || !group.items.length) return;
        recordChange(() => {
            let index = getPartIndex(group);
            index = (index + delta + group.items.length) % group.items.length;
            const item = group.items[index];
            if (group.kind === 'expression') {
                state.expressionId = item.id;
                state.selectedLayer = 'expression';
            } else {
                state.accessoryId = item.id;
                state.selectedLayer = 'accessory';
            }
            state.category = groupId;
        });
    }

    function normalizeTemplateToken(value) {
        return String(value || '')
            .replace(/\[[^\]]*\]/g, '')
            .replace(/[\s_\-]+/g, '')
            .toLocaleLowerCase();
    }

    function renderTemplateSkinControls() {
        if (!templateSkinControls) return;
        if (!templatePackage) {
            templateSkinControls.hidden = true;
            templateSkinControls.replaceChildren();
            return;
        }
        templateSkinControls.hidden = false;
        const groups = Array.isArray(templatePackage.catalogs?.skinGroups)
            ? templatePackage.catalogs.skinGroups
            : [];
        const selections = getTemplateSkinSelections();
        const runtimeOptions = getTemplateSkinOptions();
        const heading = document.createElement('div');
        heading.className = 'template-compat-heading';
        heading.textContent = t('emoteMaker.categoryHair');
        const search = document.createElement('input');
        search.className = 'template-compat-search';
        search.type = 'search';
        search.placeholder = t('emoteMaker.searchParts');
        search.setAttribute('aria-label', t('emoteMaker.searchParts'));
        const rows = [];
        const children = [heading, search];
        groups.forEach((group) => {
            const groupId = String(group?.id || group?.displayName || '');
            if (!groupId) return;
            const selected = selections.find((item) => normalizeTemplateToken(item.group) === normalizeTemplateToken(groupId));
            const runtimeGroup = runtimeOptions[normalizeTemplateToken(groupId)];
            const values = Array.isArray(runtimeGroup?.options) && runtimeGroup.options.length
                ? runtimeGroup.options
                : (selected?.value ? [selected.value] : []);
            const row = document.createElement('label');
            row.className = 'template-compat-row';
            row.title = getCatalogLabel(group) || groupId;
            row.dataset.searchText = `${getCatalogLabel(group) || ''} ${groupId}`.toLocaleLowerCase();
            const name = document.createElement('span');
            name.textContent = getCatalogLabel(group) || groupId;
            const select = document.createElement('select');
            select.dataset.templateSkinGroup = groupId;
            select.disabled = !values.length || !hasSpineRenderer();
            if (!values.length) {
                select.appendChild(new Option(t('emoteMaker.templateMetadataOnly'), ''));
            } else {
                values.forEach((value) => {
                    const option = new Option(value, value);
                    option.selected = value === selected?.value;
                    select.appendChild(option);
                });
            }
            select.addEventListener('change', () => {
                const value = select.value;
                if (!value) return;
                const next = selections.filter((item) => normalizeTemplateToken(item.group) !== normalizeTemplateToken(groupId));
                next.push({ group: groupId, value });
                recordChange(() => { state.templateSkins = next; });
                applyNativeCharacterState();
            });
            row.append(name, select);
            rows.push(row);
            children.push(row);
        });
        search.addEventListener('input', () => {
            const query = search.value.trim().toLocaleLowerCase();
            rows.forEach((row) => {
                row.hidden = Boolean(query) && !row.dataset.searchText.includes(query);
            });
        });
        if (!hasSpineRenderer()) {
            const note = document.createElement('p');
            note.className = 'template-compat-note';
            note.textContent = t('emoteMaker.templateMetadataOnly');
            children.push(note);
        }
        templateSkinControls.replaceChildren(...children);
    }

    function renderPartGroups() {
        if (!partGroupList) return;
        if (templatePackage) {
            // Imported catalogs are metadata, not an additional navigation
            // layer. Showing four static cards here made them look clickable
            // and pushed the actual skin controls far below the fold.
            partGroupList.hidden = true;
            partGroupList.replaceChildren();
            if (partGroupHint) partGroupHint.hidden = true;
            renderTemplateSkinControls();
            return;
        }
        partGroupList.hidden = false;
        if (partGroupHint) partGroupHint.hidden = false;
        renderTemplateSkinControls();
        if (!PART_GROUPS.some((group) => group.items.length)) {
            const empty = document.createElement('div');
            empty.className = 'empty-template-state';
            empty.setAttribute('role', 'status');
            empty.textContent = t('emoteMaker.noTemplates');
            partGroupList.replaceChildren(empty);
            return;
        }
        partGroupList.replaceChildren(...PART_GROUPS.map((group) => {
            const row = document.createElement('div');
            row.className = 'part-group-row';
            row.dataset.groupId = group.id;

            const title = document.createElement('span');
            title.className = 'part-group-name';
            title.textContent = t(group.labelKey);

            const index = document.createElement('output');
            index.className = 'part-group-index';
            const selectedIndex = getPartIndex(group);
            index.textContent = selectedIndex < 0 ? `—/${group.items.length}` : `${selectedIndex + 1}/${group.items.length}`;

            const controls = document.createElement('span');
            controls.className = 'part-group-controls';
            const previous = document.createElement('button');
            previous.type = 'button';
            previous.className = 'part-nav-button';
            previous.textContent = '‹';
            previous.setAttribute('aria-label', `${t(group.labelKey)} ${t('common.prevPage')}`);
            previous.addEventListener('click', () => cyclePart(group.id, -1));
            const next = document.createElement('button');
            next.type = 'button';
            next.className = 'part-nav-button';
            next.textContent = '›';
            next.setAttribute('aria-label', `${t(group.labelKey)} ${t('common.nextPage')}`);
            next.addEventListener('click', () => cyclePart(group.id, 1));
            controls.append(previous, next);
            row.append(title, index, controls);
            return row;
        }));
    }

    function renderLibraryControls() {
        // 分类页签（模板/情绪/动作/装饰）连同它们唯一的部件源（两处 const []）已经
        // 删除：这个函数现在只负责把搜索/标题/清单亮出来——没加载模板时左侧就是
        // 模板库本身，点一条 = 从本地副本装回来。
        [
            document.querySelector('.asset-search'),
            document.querySelector('.asset-section-heading'),
            assetGrid,
        ].forEach((el) => { if (el) el.hidden = false; });
        if (assetGrid) assetGrid.setAttribute('aria-labelledby', 'asset-section-title');
    }

    function renderInspectorTabs() {
        document.querySelectorAll('.inspector-tab').forEach((button) => {
            const active = button.dataset.inspectorTab === state.inspectorTab;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', String(active));
            button.setAttribute('tabindex', active ? '0' : '-1');
            button.disabled = false;
        });
        document.querySelectorAll('.inspector-tab-panel').forEach((panel) => {
            const active = panel.dataset.inspectorPanel === state.inspectorTab;
            panel.classList.toggle('is-active', active);
            panel.hidden = !active;
        });
    }

    // 模板滑块区："有哪些行"没变就不重建（重建会把面板滚动夹回去）
    let templateSliderRowsSignature = '';

    function templateSliderRowSignature(entries) {
        // 只描述"有哪些行、哪行可用"：数值不在里面，数值变了走就地更新，不重建 DOM
        return entries.map((entry) => {
            const name = String(entry?.id || '');
            const mapping = hasSpineRenderer() && typeof spineRenderer.sliderMapping === 'function'
                ? spineRenderer.sliderMapping(name)
                : null;
            return `${name}:${mapping && mapping.supported === false ? 'off' : 'on'}`;
        }).join('|');
    }

    function updateTemplateSliderValues() {
        const valueMap = new Map(getTemplateSliderValues().map((item) => [String(item.name), Number(item.value)]));
        templateSliderControls.querySelectorAll('input[data-template-slider-name]').forEach((input) => {
            const name = input.dataset.templateSliderName;
            if (!valueMap.has(name)) return;
            const next = Math.max(0, Math.min(2, valueMap.get(name)));
            if (Number(input.value) === next) return;
            input.value = String(next);
            const output = input.parentElement?.querySelector('output');
            if (output) output.textContent = next.toFixed(2);
        });
    }

    function renderTemplateSliderControls() {
        if (!templateSliderControls) return;
        if (!templatePackage) {
            templateSliderControls.hidden = true;
            templateSliderControls.replaceChildren();
            templateSliderRowsSignature = '';
            return;
        }
        templateSliderControls.hidden = false;
        const entries = Array.isArray(templatePackage.catalogs?.sliders)
            ? templatePackage.catalogs.sliders
            : [];
        const signature = templateSliderRowSignature(entries);
        if (signature && signature === templateSliderRowsSignature) {
            updateTemplateSliderValues();
            return;
        }
        templateSliderRowsSignature = signature;
        const values = getTemplateSliderValues();
        const valueMap = new Map(values.map((item) => [String(item.name), Number(item.value)]));
        const heading = document.createElement('div');
        heading.className = 'template-compat-heading';
        heading.textContent = t('emoteMaker.adjustTab');
        const children = [heading];
        entries.forEach((entry) => {
            const name = String(entry?.id || '');
            if (!name) return;
            const row = document.createElement('label');
            row.className = 'template-compat-row template-slider-row';
            row.title = getCatalogLabel(entry) || name;
            const label = document.createElement('span');
            label.textContent = getCatalogLabel(entry) || name;
            const output = document.createElement('output');
            output.className = 'template-slider-value';
            const input = document.createElement('input');
            input.type = 'range';
            input.min = '0';
            input.max = '2';
            input.step = '0.01';
            const nativeDefault = hasSpineRenderer()
                && typeof spineRenderer.sliderDefaultValue === 'function'
                ? Number(spineRenderer.sliderDefaultValue(name))
                : NaN;
            const current = Number.isFinite(valueMap.get(name))
                ? valueMap.get(name)
                : (Number.isFinite(nativeDefault) ? nativeDefault : 1);
            input.value = String(Math.max(0, Math.min(2, current)));
            output.textContent = Number(input.value).toFixed(2);
            const mapping = hasSpineRenderer() && typeof spineRenderer.sliderMapping === 'function'
                ? spineRenderer.sliderMapping(name)
                : null;
            const supported = !mapping || mapping.supported !== false;
            input.disabled = !hasSpineRenderer() || !supported;
            input.dataset.templateSliderName = name;
            if (!supported) {
                row.classList.add('is-unsupported');
                row.title = `${getCatalogLabel(entry) || name} · ${t('emoteMaker.templateMetadataOnly')}`;
            }
            input.addEventListener('input', () => {
                output.textContent = Number(input.value).toFixed(2);
                const next = getTemplateSliderValues().filter((item) => String(item.name) !== name);
                next.push({ name, value: Number(input.value) });
                state.templateSliders = next;
                applyNativeCharacterState();
            });
            input.addEventListener('change', () => {
                const snapshot = getTemplateSliderValues();
                recordChange(() => { state.templateSliders = snapshot; });
            });
            row.append(label, output, input);
            children.push(row);
        });
        if (hasSpineRenderer() && typeof spineRenderer.sliderStatus === 'function') {
            const status = spineRenderer.sliderStatus();
            const unsupportedCatalog = entries.some((entry) => {
                if (typeof spineRenderer.sliderMapping !== 'function') return false;
                return spineRenderer.sliderMapping(String(entry?.id || '')).supported === false;
            });
            if ((status.configured.length && status.applied.length < status.configured.length) || unsupportedCatalog) {
                const note = document.createElement('p');
                note.className = 'template-compat-note';
                note.textContent = t('emoteMaker.templateMetadataOnly');
                children.push(note);
            }
        }
        templateSliderControls.replaceChildren(...children);
    }

    // 读数 + "有没有东西可复位"。拖动滑杆时每帧都要走这里，所以绝不能顺手动 DOM 结构：
    // 重建滑块区会让滚动容器内容瞬间变矮，scrollTop 被夹小 —— 就是"一拖就跳回顶部"。
    function adjustmentValuesDiffer() {
        return Math.round(state.adjustments.x) !== 0
            || Math.round(state.adjustments.y) !== 0
            || Math.round(state.adjustments.rotation) !== 0
            || Math.round(state.adjustments.scale) !== 100;
    }

    function syncAdjustmentReadouts() {
        const values = {
            x: `${Math.round(state.adjustments.x)}`,
            y: `${Math.round(state.adjustments.y)}`,
            rotation: `${Math.round(state.adjustments.rotation)}°`,
            scale: `${Math.round(state.adjustments.scale)}%`
        };
        Object.entries(values).forEach(([key, value]) => {
            const output = $(`#adjust-${key}-value`);
            if (output) output.textContent = value;
        });
        const resetButton = $('#reset-adjustments-btn');
        // 改了值就得立刻让他能按重置：这条以前只在整页重绘时算，
        // 拆成轻路径之后如果忘了带上，按钮会一直停在禁用状态。
        if (resetButton) resetButton.disabled = !adjustmentValuesDiffer();
    }

    function renderAdjustments() {
        syncAdjustmentReadouts();
        Object.entries(state.adjustments).forEach(([key, value]) => {
            const input = $(`#adjust-${key}`);
            if (input) input.value = value;
        });
        const overwrite = $('#adjust-overwrite');
        if (overwrite) overwrite.checked = state.adjustOverwrite;
        // 「覆盖默认值」关掉时这四条滑杆根本不起作用（native 与 2D 两条绘制路径都读这个
        // 开关）。以前只在没有模板时禁用它们，于是导入了模板的人能拖、能改读数，画面却
        // 一动不动 —— 看上去就是"滑杆坏了 / 重置没作用"。
        const inert = !state.adjustOverwrite;
        document.querySelectorAll('.range-row input').forEach((input) => {
            input.disabled = inert;
        });
        renderTemplateSliderControls();
    }

    function renderColorMode() {
        const genericColorControls = [
            document.querySelector('.color-mode-list'),
            colorSwatches,
            document.querySelector('.custom-color-row'),
            document.querySelector('.secondary-color-row'),
        ].filter(Boolean);
        genericColorControls.forEach((element) => {
            element.hidden = Boolean(templatePackage);
        });
        renderTemplateSlotControls();
        document.querySelectorAll('.color-mode-button').forEach((button) => {
            button.classList.toggle('is-active', button.dataset.colorMode === state.colorMode);
        });
        const secondary = $('.secondary-color-row');
        if (secondary) secondary.hidden = Boolean(templatePackage) || state.colorMode !== 'two-tone';
        applyNativeVisualState();
    }

    const PLAY_ICON_URL = `${ICON_ROOT}motion_play_icon.png`;

    /** 清单内容签名：由 pack 模块给（纯函数，可在 Node 里单测） */
    function listsSignature(items, kind) {
        const packModule = window.NekoEmotePngtuberPack;
        if (!packModule || typeof packModule.listSignature !== 'function') {
            return `${kind}|${state.sceneListFilter || ''}|${(items || []).length}`;
        }
        return packModule.listSignature(kind, items, state.sceneListFilter);
    }

    function replaceAnimationList(...children) {
        if (!animationList) return;
        // Rebuilding the cards is sometimes necessary (locale/template
        // changes), but replaceChildren() resets the scroll container. Keep
        // the user's place so selecting an item near the end does not jump
        // back to the first animation.
        const scrollTop = animationList.scrollTop;
        const scrollLeft = animationList.scrollLeft;
        animationList.replaceChildren(...children);
        animationList.scrollTop = scrollTop;
        animationList.scrollLeft = scrollLeft;
    }

    function updateAnimationCardSelection() {
        if (!animationList) return;
        animationList.querySelectorAll('.animation-card').forEach((card) => {
            const selected = card.dataset.animationId === String(state.animationId);
            card.classList.toggle('is-selected', selected);
            card.setAttribute('aria-pressed', String(selected));
        });
    }



    // ── 组（分组导出）─────────────────────────────────────────────────────────
    // 数据规则都在 emote_group_library.js；这一层只管"页面上的组"：谁被选中、选中时
    // 列表显示什么、导出时把每一项交给烘焙器。
    function ownGroups() {
        return groupLibrary ? groupLibrary.groupsFrom(state.groups) : [];
    }

    function allGroups() {
        if (!groupLibrary) return [];
        const imported = templatePackage ? groupLibrary.importedGroups(templatePackage) : [];
        return [...imported, ...ownGroups()];
    }

    function activeGroup() {
        if (!state.groupId) return null;
        return allGroups().find((group) => group.id === state.groupId) || null;
    }

    function ownShots() {
        return groupLibrary ? groupLibrary.shotsFrom(state.shots) : [];
    }

    function findShotById(id) {
        return ownShots().find((shot) => shot.id === String(id)) || null;
    }

    function writeGroups(groups, shots) {
        state.groups = groups;
        state.shots = shots;
        // 组跟着模板走：换一个形象不该看到上一个形象的分组
        persistTemplateSession();
        persistTemplateToLibrary();
    }

    function selectGroup(id) {
        state.groupId = String(id || '');
        const group = activeGroup();
        // 导入的组沿用原来的 path 过滤器：同一份判定，别在两条路上各写一半
        let filterPath = '';
        if (group && group.readOnly) {
            const lists = Array.isArray(templatePackage?.sceneLists) ? templatePackage.sceneLists : [];
            const match = lists.find((list) => (
                groupLibrary.importedGroups({ sceneLists: [list] })[0]?.id === group.id));
            filterPath = match?.path || '';
        }
        state.sceneListFilter = filterPath;
        renderAnimations();
        renderGroupBar();
    }

    /**
     * 要往组里写东西时先有一个能写的组。没选组 / 选中的是导入的只读组 → 就地新建一个。
     * 空组，不带取景：右键「加入当前组」不该顺手塞进一条用户没点过的画面。
     */
    function ensureWritableGroup() {
        const current = activeGroup();
        if (current && !current.readOnly) return current;
        if (!groupLibrary || !templatePackage) return null;
        const fresh = groupLibrary.makeGroup({
            name: groupLibrary.uniqueGroupName(ownGroups(), t('emoteMaker.groupNameDefault')),
        });
        writeGroups([...ownGroups(), fresh], state.shots);
        selectGroup(fresh.id);
        return allGroups().find((group) => group.id === fresh.id) || fresh;
    }

    /**
     * 「按当前配置创建组」：建组的同时把当前画面作为第一条成员存进去。
     * 存的是取景（shot）而不是裸场景 —— 因为用户说的"保留当前设置的大小、旋转角度"
     * 就活在调整值/换装里，裸场景引用不带这些。
     */
    function createGroup() {
        if (!groupLibrary || !templatePackage) return null;
        const groups = ownGroups();
        const group = groupLibrary.makeGroup({
            name: groupLibrary.uniqueGroupName(groups, t('emoteMaker.groupNameDefault')),
        });
        const scene = getSelectedScene();
        let shots = ownShots();
        let withMember = group;
        if (scene) {
            const shot = groupLibrary.makeShot({
                name: `${scene.name || scene.id} · ${Math.round(Number(state.animationProgress) || 0)}%`,
                sourceSceneId: scene.id,
                progress: Number(state.animationProgress) || 0,
                look: currentLookDefaults(),
            });
            shots = [...shots, shot];
            withMember = groupLibrary.addItem(group, 'shot', shot.id);
        }
        writeGroups([...groups, withMember], shots);
        selectGroup(withMember.id);
        return withMember;
    }

    /**
     * 标题行上的多选工具。以前它自己独占一行、而且常驻：列表被压矮一截，
     * 用不到的时候也挂着。现在跟着标题走，「取消全选」只在真选了东西时才出现。
     */
    function updateListSelectRow() {
        const tools = $('#list-select-tools');
        if (tools) tools.hidden = !templatePackage;
        const all = $('#select-all-btn');
        if (all) all.hidden = !templatePackage || getVisibleImportedAnimations().length === 0;
        const none = $('#select-none-btn');
        if (none) none.hidden = pickedAnimations.size === 0;
        const count = $('#list-select-count');
        if (count) {
            count.textContent = pickedAnimations.size
                ? interpolate(t('emoteMaker.selectedCount'), { count: pickedAnimations.size })
                : '';
        }
    }

    function setPickedAnimations(ids) {
        pickedAnimations.clear();
        (ids || []).forEach((id) => pickedAnimations.add(String(id)));
        updateAnimationCardPicked();
        updateListSelectRow();
    }

    /** 多选里的动画 → 各自对应的场景（沿用拖拽那条解析：找不到就拒绝，不猜视角） */
    function pickedSceneEntries() {
        const out = [];
        const missing = [];
        pickedAnimations.forEach((id) => {
            const scene = window.NekoEmotePngtuberPack
                ? packResolveScene(id) : null;
            if (scene) out.push(scene);
            else missing.push(id);
        });
        return { scenes: out, missing };
    }

    function packResolveScene(animationId) {
        const packModule = window.NekoEmotePngtuberPack;
        if (!packModule || typeof packModule.resolveSceneForDrag !== 'function') return null;
        return packModule.resolveSceneForDrag(getImportedScenes(), {
            kind: 'animation', animationId,
        });
    }

    function addPickedToActiveGroup() {
        // 没选组 / 选的是导入的只读组：就地新建一个再放进来，而不是让人先去找「创建组」
        const group = ensureWritableGroup();
        if (!group) {
            showToast(t('emoteMaker.groupReadOnly'));
            return 0;
        }
        const { scenes, missing } = pickedSceneEntries();
        let next = group;
        scenes.forEach((scene) => {
            next = groupLibrary.addItem(next, 'scene', scene.id);
        });
        if (next.items.length !== group.items.length) {
            writeGroups(ownGroups().map((entry) => (entry.id === group.id ? next : entry)), state.shots);
        }
        renderGroupBar();
        if (missing.length) showToast(interpolate(t('emoteMaker.groupPickedMissing'), { count: missing.length }));
        return next.items.length - group.items.length;
    }

    function removePickedFromActiveGroup() {
        const group = activeGroup();
        if (!group || group.readOnly) return 0;
        const ids = new Set(pickedSceneEntries().scenes.map((scene) => scene.id));
        let next = group;
        ids.forEach((id) => { next = groupLibrary.removeItem(next, 'scene', id); });
        if (next.items.length !== group.items.length) {
            writeGroups(ownGroups().map((entry) => (entry.id === group.id ? next : entry)), state.shots);
        }
        renderGroupBar();
        return group.items.length - next.items.length;
    }

    function isPickedInGroup() {
        const group = activeGroup();
        if (!group) return false;
        const ids = pickedSceneEntries().scenes.map((scene) => scene.id);
        return ids.length > 0 && ids.every((id) => groupLibrary.hasItem(group, 'scene', id));
    }

    function showGroupContextMenu(event, animationId) {
        pickedAnimations.add(String(animationId));
        updateAnimationCardPicked();
        updateListSelectRow();
        const menu = $('#group-context-menu');
        if (!menu) return;
        const group = activeGroup();
        // 菜单上的「加入」不要求先选中一个组：没有就新建一个再放。
        const canWrite = Boolean(templatePackage && groupLibrary);
        const inGroup = isPickedInGroup();
        const add = $('#context-add-btn');
        const remove = $('#context-remove-btn');
        if (add) {
            add.hidden = !canWrite || inGroup;
            add.disabled = false;
        }
        if (remove) remove.hidden = !canWrite || !inGroup;
        const label = $('#context-group-name');
        if (label) {
            // 没有可写的组时，报出即将建出来的那个名字，别让人以为加进了空气
            label.textContent = group && !group.readOnly
                ? group.name
                : t('emoteMaker.groupNameDefault');
        }
        menu.hidden = false;
        menu.style.left = `${Math.max(8, event.clientX)}px`;
        menu.style.top = `${Math.max(8, event.clientY)}px`;
    }

    function hideGroupContextMenu() {
        const menu = $('#group-context-menu');
        if (menu) menu.hidden = true;
    }

    function updateAnimationCardPicked() {
        if (!animationList) return;
        animationList.querySelectorAll('[data-animation-id]').forEach((card) => {
            const on = pickedAnimations.has(String(card.dataset.animationId));
            card.classList.toggle('is-picked', on);
            card.setAttribute('aria-selected', String(on));
        });
    }

    function addCurrentSceneToGroup() {
        if (!state.selectedSceneId) {
            // 静默返回会被当成"按钮坏了"；这里连"加入哪一格"都没定，必须说
            showToast(t('emoteMaker.groupNoSelection'));
            return;
        }
        const group = ensureWritableGroup();
        if (!group) return;
        const next = groupLibrary.addItem(group, 'scene', state.selectedSceneId);
        if (next.items.length === group.items.length) return;
        writeGroups(ownGroups().map((item) => (item.id === group.id ? next : item)), state.shots);
        renderAnimations();
        renderGroupBar();
        showToast(t('emoteMaker.groupSceneAdded'));
    }

    /** 把当前画面存成一条"取景"：来源场景 + 当时的换装/滑杆/色组/位移。 */
    function saveCurrentAsShot() {
        const group = activeGroup();
        if (!group || group.readOnly || !groupLibrary) {
            showToast(t('emoteMaker.groupReadOnly'));
            return;
        }
        const scene = getSelectedScene();
        if (!scene) return;
        const shot = groupLibrary.makeShot({
            // 用进度当区分，不额外要一个"后缀"文案键：同一个场景存两遍取景时，
            // 名字要能看出停在第几帧
            name: `${scene.name || scene.id} · ${Math.round(Number(state.animationProgress) || 0)}%`,
            sourceSceneId: scene.id,
            progress: Number(state.animationProgress) || 0,
            look: currentLookDefaults(),
        });
        const shots = [...ownShots(), shot];
        const next = groupLibrary.addItem(group, 'shot', shot.id);
        writeGroups(ownGroups().map((item) => (item.id === group.id ? next : item)), shots);
        renderAnimations();
        renderGroupBar();
        showToast(t('emoteMaker.groupShotSaved'));
    }

    function applyShotLook(shot) {
        const scene = getImportedScenes().find((entry) => entry.id === shot.sourceSceneId) || null;
        if (!scene) return false;
        applyLookToState({ ...shot.look, sceneId: scene.id });
        state.selectedSceneId = scene.id;
        state.animationId = scene.animation?.id || state.animationId;
        state.animationProgress = shot.progress || 0;
        return true;
    }

    function groupMemberInfo(item) {
        if (item.kind === 'shot') {
            const shot = findShotById(item.ref);
            return {
                name: shot ? shot.name : item.ref,
                kind: t('emoteMaker.groupMemberShot'),
                missing: !shot || !getImportedScenes().some((entry) => entry.id === shot.sourceSceneId),
            };
        }
        const scene = getImportedScenes().find((entry) => entry.id === item.ref);
        return {
            name: scene ? (scene.name || scene.id) : item.ref,
            kind: t('emoteMaker.segmentScenes'),
            missing: !scene,
        };
    }

    function removeGroupMember(group, item) {
        const next = groupLibrary.removeItem(group, item.kind, item.ref);
        writeGroups(ownGroups().map((entry) => (entry.id === group.id ? next : entry)), state.shots);
        renderAll();
    }

    function renderGroupMembers(group, writable) {
        const host = $('#group-members');
        if (!host) return;
        const items = group ? (group.items || []) : [];
        if (!items.length) {
            const empty = document.createElement('p');
            empty.className = 'group-members-empty';
            // 有组但没动作：一句去添加？加一个加号（顶替删掉的「加入本组」按钮）。
            // 连组都没有（下拉显示「暂无组」的那种）：组员区就别再指挥人做事了。
            empty.textContent = group ? t('emoteMaker.groupPickFirst') : t('emoteMaker.groupEmptyList');
            if (group && writable) {
                const add = document.createElement('button');
                add.type = 'button';
                add.id = 'add-scene-to-group-btn';
                add.className = 'group-add-btn';
                add.textContent = '+';
                add.setAttribute('aria-label', t('emoteMaker.addToGroup'));
                empty.appendChild(add);
            }
            host.replaceChildren(empty);
            return;
        }
        host.replaceChildren(...items.map((item) => {
            const info = groupMemberInfo(item);
            const row = document.createElement('div');
            row.className = 'group-member' + (info.missing ? ' is-missing' : '');
            row.dataset.memberKind = item.kind;
            row.dataset.memberRef = item.ref;

            const pick = document.createElement('button');
            pick.type = 'button';
            pick.className = 'group-member-pick';
            const chip = document.createElement('small');
            chip.className = 'group-member-kind';
            chip.textContent = info.kind;
            const name = document.createElement('span');
            name.className = 'group-member-name';
            name.textContent = info.name;
            pick.append(chip, name);
            pick.title = info.missing ? t('emoteMaker.groupMemberMissing') : info.name;
            pick.disabled = info.missing;
            pick.setAttribute('aria-disabled', String(info.missing));
            if (!info.missing) {
                pick.addEventListener('click', () => {
                    if (item.kind === 'shot') {
                        const shot = findShotById(item.ref);
                        if (shot) {
                            state.adjustOverwrite = true;
                            applyShotLook(shot);
                            renderAll();
                        }
                        return;
                    }
                    const scene = getImportedScenes().find((entry) => entry.id === item.ref);
                    if (scene) selectImportedScene(scene);
                });
            }
            row.append(pick);

            if (writable && !info.missing) {
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'group-member-remove';
                remove.textContent = '×';
                remove.setAttribute('aria-label', `${t('emoteMaker.groupRemoveMember')} · ${info.name}`);
                remove.addEventListener('click', () => removeGroupMember(group, item));
                row.append(remove);
            } else if (info.missing) {
                // 来源没了就别只留一个灰条：说清为什么点不动
                const note = document.createElement('span');
                note.className = 'group-member-note';
                note.textContent = t('emoteMaker.groupMemberMissing');
                row.append(note);
            }
            return row;
        }));
    }

    // ── 锚定在控件上的说明气泡 ────────────────────────────────────────────────
    // 原生 title 要悬停半秒才出、位置也不受控；跟着光标跑的框又显得毛躁。
    // [data-tip] 统一做成钉在触发控件上方（放不下就翻到下方）的带尖角气泡，
    // 位置只跟控件走，不跟鼠标。
    function bindCursorTips() {
        const tip = $('#emote-cursor-tip');
        if (!tip || tip.dataset.bound === '1') return;
        tip.dataset.bound = '1';
        let owner = null;

        const place = (target) => {
            const margin = 10;
            const gap = 10;
            const box = tip.getBoundingClientRect();
            const rect = target.getBoundingClientRect();
            const centered = rect.left + rect.width / 2 - box.width / 2;
            const left = Math.min(
                Math.max(margin, centered),
                window.innerWidth - box.width - margin,
            );
            // 默认在控件上方；上方放不下翻到下方，箭头跟着换边。
            const below = rect.top - box.height - gap < margin;
            const top = below ? rect.bottom + gap : rect.top - box.height - gap;
            // 箭头横向钉在触发控件中心（气泡被屏幕边夹住时也不跑偏）。
            const arrowX = Math.min(
                Math.max(rect.left + rect.width / 2 - left, 14),
                box.width - 14,
            );
            tip.style.setProperty('--tip-arrow-x', `${Math.round(arrowX)}px`);
            tip.classList.toggle('is-below', below);
            tip.style.left = `${Math.round(left)}px`;
            tip.style.top = `${Math.round(top)}px`;
        };
        const show = (target) => {
            owner = target;
            tip.textContent = target.dataset.tip || '';
            // 先显示再定位：hidden 的元素量出来是 0×0，会算出贴到左上角的位置
            tip.hidden = false;
            place(target);
            target.setAttribute('aria-describedby', tip.id);
        };
        const hide = () => {
            if (owner) owner.removeAttribute('aria-describedby');
            owner = null;
            tip.hidden = true;
        };
        const tipHost = (node) => ((node && node.closest) ? node.closest('[data-tip]') : null);

        document.addEventListener('pointerover', (event) => {
            if (event.pointerType && event.pointerType !== 'mouse') return;
            const target = tipHost(event.target);
            if (!target || target === owner || !target.dataset.tip) return;
            show(target);
        });
        document.addEventListener('pointerout', (event) => {
            if (owner && !owner.contains(event.relatedTarget)) hide();
        });
        // 键盘用户也能拿到：聚焦即出，同一套锚定位置
        document.addEventListener('focusin', (event) => {
            const target = tipHost(event.target);
            if (!target || target === owner || !target.dataset.tip) return;
            show(target);
        });
        document.addEventListener('focusout', hide);
        // 滚动/换行会让锚点跑掉，直接收掉比留着一个假位置好
        window.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);
    }

    /** [data-tip-key] 的问号按钮：把键翻译成 [data-tip]，气泡那套就能接管。 */
    function bindTipKeys() {
        document.querySelectorAll('[data-tip-key]').forEach((el) => {
            el.dataset.tip = t(el.dataset.tipKey);
        });
    }

    function bindGroupPanelToggle() {
        const section = $('#group-section');
        if (!section || section.dataset.toggleBound === '1') return;
        section.dataset.toggleBound = '1';
        // 只挂一次：挂在每次重绘里再配 once，第一次收起就会把监听器消耗掉，
        // 之后再收起就再不存状态了
        section.addEventListener('toggle', () => {
            state.groupPanelOpen = section.open;
            persistLayout();
        });
    }

    /** 气泡里一行：组名 + 张数。点一下就是"导出这一组"。 */
    function createGroupPickerRow(group) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'group-picker-item';
        row.dataset.groupId = group.id;
        row.setAttribute('role', 'listitem');
        const name = document.createElement('span');
        name.className = 'group-picker-name';
        name.textContent = group.name;
        // 只读组显示它自带的张数，自建组显示攒了几条
        const total = group.readOnly ? (group.count || group.items.length) : group.items.length;
        const count = document.createElement('small');
        count.className = 'group-picker-count';
        count.textContent = interpolate(t('emoteMaker.groupMemberCount'), { count: total });
        row.append(name, count);
        if (group.readOnly) {
            const tag = document.createElement('small');
            tag.className = 'group-picker-tag';
            tag.textContent = t('emoteMaker.groupImportedTag');
            row.append(tag);
        }
        // 只读只是"不能改组员"，整组照导不误 —— 那正是"把这份场景列表全导出来"的入口
        row.disabled = !total || !hasSpineRenderer();
        row.addEventListener('click', () => {
            closeGroupPicker();
            void exportGroup(group, $('#export-group-open-btn'));
        });
        return row;
    }

    function renderGroupPicker() {
        const picker = $('#group-export-picker');
        const trigger = $('#export-group-open-btn');
        if (!picker || !trigger) return;
        const open = Boolean(state.groupPickerOpen) && Boolean(templatePackage);
        if (!open) {
            picker.hidden = true;
            trigger.setAttribute('aria-expanded', 'false');
            return;
        }
        const list = $('#group-picker-list');
        const groups = allGroups();
        if (list) {
            const rows = groups.length
                ? groups.map((group) => createGroupPickerRow(group))
                : [Object.assign(document.createElement('p'), {
                    className: 'group-picker-empty',
                    textContent: t('emoteMaker.batchExportPickerEmpty'),
                })];
            if (!hasSpineRenderer()) {
                // 行是灰的，但灰不等于说清了为什么灰：disabled 的按钮连悬停提示都给不出
                rows.push(Object.assign(document.createElement('p'), {
                    className: 'group-picker-note',
                    textContent: t('emoteMaker.groupExportNoRuntime'),
                }));
            }
            list.replaceChildren(...rows);
        }
        picker.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
    }

    function openGroupPicker() {
        if (!templatePackage || groupExportBusy) return;
        state.groupPickerOpen = true;
        renderGroupPicker();
    }

    function closeGroupPicker() {
        if (!state.groupPickerOpen) return;
        state.groupPickerOpen = false;
        renderGroupPicker();
    }

    function renderGroupBar() {
        bindGroupPanelToggle();
        const section = $('#group-section');
        if (section) {
            section.hidden = !templatePackage;
            if (templatePackage) section.open = state.groupPanelOpen !== false;
        }
        const help = $('#new-group-help');
        // 说明交给跟着光标的气泡，不用原生 title（要等半秒）、也不弹底部 toast
        if (help) help.dataset.tip = t('emoteMaker.newGroupHelp');
        if (!templatePackage || !groupLibrary) return;
        renderSceneListFilter();
        const active = activeGroup();
        const writable = Boolean(active && !active.readOnly);
        const saveShot = $('#save-shot-btn');
        // 选中的是导入的组时无处可写，收着比按了弹一句"不能改"更好；
        // 还没选组时它会顺手新建一个组，所以照样能按。
        if (saveShot) saveShot.hidden = Boolean(active && active.readOnly);
        const summary = $('#group-summary-state');
        if (summary) {
            // 收起时也要看得见"现在攒的是哪一组、几张"，否则收起就等于信息没了
            summary.textContent = active
                ? `${active.name} · ${active.items.length}`
                : t('emoteMaker.groupNonePicked');
        }
        renderGroupMembers(active, writable);
        renderGroupPicker();
    }

    /** 烘一项 → 一段字节。png 只要第 0 帧，gif 走现有编码器。 */
    async function produceGroupFile(item, format) {
        const encoder = window.NekoEmoteGifEncoder;
        const sheet = window.NekoEmoteSheet;
        const edge = Math.min(state.exportResolution || GIF_EXPORT_WIDTH, GIF_EXPORT_WIDTH);
        const fps = state.exportFps || GIF_EXPORT_FPS;
        let scene = getImportedScenes().find((entry) => entry.id === item.ref) || null;
        if (item.kind === 'shot') {
            const shot = findShotById(item.ref);
            if (!shot) throw new Error('missing-shot');
            // 取景存的是当时的换装与位移，先套上再烘；位移受「覆盖默认值」控制，
            // 整组导出期间强制打开，否则会烘出一批没构图的图。
            if (!applyShotLook(shot)) throw new Error('scene_unavailable');
            state.adjustOverwrite = true;
            scene = getImportedScenes().find((entry) => entry.id === shot.sourceSceneId) || null;
        }
        if (!scene) throw new Error('missing-scene');
        const frames = await captureGifFrames({
            scene,
            maxFrames: format === 'png' ? 1 : PACK_MAX_FRAMES,
            fps,
            maxDimension: edge,
        });
        if (!frames || !frames.length) throw new Error('empty');
        if (format === 'png') {
            return sheet.canvasToPngBytes(sheet.firstFrameCanvas(frames[0]));
        }
        if (!encoder || typeof encoder.encode !== 'function') throw new Error('encoder-unavailable');
        return encoder.encode(frames, {
            width: frames[0].width,
            height: frames[0].height,
            colors: GIF_EXPORT_COLORS,
            transparent: state.exportTransparent !== false,
            loopCount: 0,
        });
    }

    /** 导出气泡/按钮真正要导的那一组 —— 由气泡里的行决定，不是"当前下拉选中的那组"。 */
    async function exportGroup(group, exportTrigger) {
        if (groupExportBusy) return;
        if (!group) return;
        if (!hasSpineRenderer()) {
            // 没有运行时 captureGifFrames 只能给到当前画面 —— 宁可不导，也不下一个是
            // "每张都长一样"的包，那种东西看起来像成功了。
            showToast(t('emoteMaker.groupExportNoRuntime'));
            return;
        }
        const format = state.exportFormat === 'png' ? 'png' : 'gif';
        const sceneName = (ref) => {
            const scene = getImportedScenes().find((entry) => entry.id === ref);
            return scene ? (scene.name || scene.id) : '';
        };
        const plan = groupLibrary.planGroupExport({
            group, shots: ownShots(), ext: format, nameOf: sceneName,
        });
        if (!plan.ready) {
            showToast(t('emoteMaker.groupExportEmpty'));
            return;
        }
        groupExportBusy = true;
        groupExportAbort = false;
        setPackBusy(true);
        const trigger = exportTrigger && exportTrigger.nodeType === 1 ? exportTrigger : null;
        const triggerLabel = trigger ? trigger.textContent : '';
        if (trigger) trigger.textContent = t('emoteMaker.groupExportCancel');
        const previousSceneId = state.selectedSceneId;
        const previousAnimationId = state.animationId;
        const previousProgress = state.animationProgress;
        const previousOverwrite = state.adjustOverwrite;
        let result = null;
        try {
            result = await groupLibrary.runGroupExport({
                plan,
                produce: (item) => produceGroupFile(item, format),
                zip: async (files) => {
                    const entries = {};
                    files.forEach((file) => { entries[file.path] = file.data; });
                    return new Blob([window.fflate.zipSync(entries, { level: 6 })], { type: 'application/zip' });
                },
                shouldAbort: () => groupExportAbort,
                onProgress: ({ done, total }) => setGroupExportStatus(
                    interpolate(t('emoteMaker.groupExporting'), { done, total })),
            });
        } finally {
            groupExportBusy = false;
            setPackBusy(false);
            setGroupExportStatus('');
            if (trigger && trigger.isConnected) trigger.textContent = triggerLabel;
            state.adjustOverwrite = previousOverwrite;
            state.selectedSceneId = previousSceneId;
            state.animationId = previousAnimationId;
            state.animationProgress = previousProgress;
            const back = getSelectedScene();
            if (back) syncNativeScene(back, { autoplay: false });
            renderAll();
        }
        if (!result) return;
        if (result.blob) {
            fallbackDownload(
                result.blob,
                `${groupLibrary.sanitizeFileName(group.name, 'group')}.zip`,
                'emoteMaker.groupExportDone', 'emoteMaker.exportGifFailed');
        }
        if (result.aborted) showToast(t('emoteMaker.groupExportCancelled'));
        const lost = result.failed.length + plan.skipped.length;
        if (lost) showToast(interpolate(t('emoteMaker.groupExportFailed'), { count: lost }));
        if (plan.truncated) showToast(interpolate(t('emoteMaker.groupExportTruncated'), { count: plan.limit }));
    }

    let animationCardsSignature = '';

    function renderAnimations() {
        if (!animationList) return;
        // 列表在画就顺手刷新标题行上那排多选工具：以前只有点过一张之后才现身，
        // 第一次进来的人根本看不见有这东西
        updateListSelectRow();
        const animations = templatePackage
            ? getVisibleImportedAnimations().map((item) => ({
                id: item.id,
                name: getCatalogLabel(item),
                duration: getImportedAnimationDuration(item.id),
                metadataOnly: !animationIsPlayable(item.id),
            }))
            : ANIMATIONS;
        const signature = listsSignature(animations, 'anim');
        if (signature && signature === animationCardsSignature) {
            // 只有选中项变了：切 class 就够，不必重建 191 张卡
            updateAnimationCardSelection();
            updateAnimationControls();
            return;
        }
        animationCardsSignature = signature;
        if (!templatePackage && !EXPRESSIONS.length && !ACCESSORIES.length) {
            const empty = document.createElement('div');
            empty.className = 'empty-template-state';
            empty.setAttribute('role', 'status');
            empty.textContent = t('emoteMaker.selectTemplateFile');
            replaceAnimationList(empty);
            updateAnimationControls();
            return;
        }
        if (templatePackage && !animations.length) {
            replaceAnimationList(Object.assign(document.createElement('div'), {
                className: 'empty-template-state',
                textContent: t('emoteMaker.noTemplates')
            }));
            updateAnimationControls();
            return;
        }
        replaceAnimationList(...animations.map((animation) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'animation-card' + (animation.id === state.animationId ? ' is-selected' : '');
            button.dataset.animationId = animation.id;
            const icon = document.createElement('span');
            // 以前每卡一个 <img src=同一张图>：几百个元素、几百份解码调度，只为同一个播放符
            icon.className = 'animation-card-icon';
            icon.setAttribute('aria-hidden', 'true');
            const label = document.createElement('span');
            label.textContent = animation.nameKey ? t(animation.nameKey) : animation.name;
            const duration = document.createElement('small');
            duration.textContent = animation.metadataOnly
                ? t('emoteMaker.templatePendingPreview')
                : `${Number(animation.duration || 0).toFixed(1)}s`;
            button.append(icon, label, duration);
            button.disabled = Boolean(animation.metadataOnly);
            button.setAttribute('aria-pressed', String(animation.id === state.animationId));
            if (animation.metadataOnly) button.setAttribute('aria-disabled', 'true');
            attachDragSource(button, {
                kind: 'animation',
                animationId: animation.id,
                label: animation.nameKey ? t(animation.nameKey) : animation.name,
                thumbUrl: PLAY_ICON_URL,
            });
            button.addEventListener('click', (event) => {
                if (Date.now() < suppressClickUntil) return;
                if (event.ctrlKey || event.metaKey) {
                    // 按住 Ctrl/⌘ 点 = 加进/移出多选集合，不改当前播放的那条；
                    // 这条也不要求"能播"，同上
                    const id = String(animation.id);
                    if (pickedAnimations.has(id)) pickedAnimations.delete(id);
                    else pickedAnimations.add(id);
                    updateAnimationCardPicked();
                    updateListSelectRow();
                    return;
                }
                if (animation.metadataOnly) return;
                state.animationId = animation.id;
                state.animationProgress = 0;
                state.animationPlaying = false;
                // Selecting a card is also the play gesture, matching the
                // EmoteLab workflow. Stop the previous loop before switching
                // tracks so an old RAF cannot overwrite the new selection.
                stopAnimationLoops();
                startSelectedAnimationPlayback();
                updateAnimationCardSelection();
                updateAnimationControls();
                void renderCanvas();
            });
            button.title = animation.metadataOnly ? t('emoteMaker.templateMetadataOnly') : label.textContent;
            // 右键多选/加组不设"能不能播"这个门槛：攒一份要导出的清单不需要播放，
            // 真烘不出来由「批量导出」的气泡统一拦（那里才有渲染器可用与否的判断）
            button.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                showGroupContextMenu(event, animation.id);
            });
            return button;
        }));
        updateAnimationControls();
    }

    function getCurrentAnimation() {
        if (templatePackage) {
            const imported = getImportedAnimations().find((animation) => animation.id === state.animationId);
            return {
                id: state.animationId,
                name: imported ? getCatalogLabel(imported) : state.animationId,
                duration: getImportedAnimationDuration(state.animationId) || 1
            };
        }
        return ANIMATIONS.find((animation) => animation.id === state.animationId) || ANIMATIONS[0];
    }

    function formatAnimationTime(totalSeconds) {
        const total = Math.max(0, Math.round(Number(totalSeconds) || 0));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const seconds = total % 60;
        const pad = (value) => String(value).padStart(2, '0');
        return hours > 0
            ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
            : `${pad(minutes)}:${pad(seconds)}`;
    }

    // 这些是"上一次写进去的值"：播放循环每帧都会调这里，不比对就会每帧都
    // 写一次文本和属性（实测约 122 次文本写入/秒），逼浏览器重算布局和无障碍树。
    const controlsMemo = { progress: null, speed: null, time: '', play: null, disabled: null };

    function updateAnimationControls() {
        if (animationProgress) {
            if (controlsMemo.progress !== state.animationProgress) {
                controlsMemo.progress = state.animationProgress;
                animationProgress.value = state.animationProgress;
            }
        }
        if (animationSpeed && controlsMemo.speed !== state.animationSpeed) {
            controlsMemo.speed = state.animationSpeed;
            animationSpeed.value = state.animationSpeed;
        }
        if (animationTime) {
            const currentAnimation = getCurrentAnimation() || { duration: 0 };
            const totalSeconds = Number(currentAnimation.duration) || 0;
            const seconds = Math.round(totalSeconds * state.animationProgress / 100);
            const label = formatAnimationTime(seconds);
            if (controlsMemo.time !== label) {
                controlsMemo.time = label;
                animationTime.textContent = label;
            }
        }
        const playButton = $('#play-animation-btn');
        const nativeReady = hasSpineRenderer();
        // 只有清单变了才重算可见动画数（见 listsSignature）；以前每帧 new Set + filter
        const hasAnimations = hasPlayableAnimations();
        const disabled = !hasAnimations || (Boolean(templatePackage) && !nativeReady);
        if (playButton) {
            const playLabel = state.animationPlaying ? t('common.pause') : t('common.play');
            if (controlsMemo.play !== playLabel || controlsMemo.disabled !== disabled) {
                controlsMemo.play = playLabel;
                controlsMemo.disabled = disabled;
                playButton.textContent = playLabel;
                playButton.disabled = disabled;
                if (disabled) playButton.title = t('emoteMaker.templateMetadataOnly');
                else playButton.removeAttribute('title');
            }
        }
        if (animationProgress) {
            if (animationProgress.disabled !== disabled) {
                animationProgress.disabled = disabled;
                animationProgress.setAttribute('aria-disabled', String(disabled));
            }
        }
        if (animationSpeed) {
            // 同样只在变了时写：这条以前每帧都 setAttribute 一次
            if (animationSpeed.disabled !== disabled) {
                animationSpeed.disabled = disabled;
                animationSpeed.setAttribute('aria-disabled', String(disabled));
            }
        }
    }

    function toggleAnimationPlayback() {
        if (templatePackage && !hasSpineRenderer()) {
            showToast(t('emoteMaker.templateMetadataOnly'));
            return;
        }
        state.animationPlaying = !state.animationPlaying;
        if (templatePackage && hasSpineRenderer()) {
            if (state.animationPlaying) {
                spineRenderer.play();
                startSpineAnimationLoop();
            } else {
                spineRenderer.pause();
                stopSpineAnimationLoop();
            }
            updateAnimationControls();
            return;
        }
        if (state.animationPlaying) {
            animationLastTimestamp = 0;
            animationFrameHandle = window.requestAnimationFrame(animationTick);
        } else if (animationFrameHandle) {
            window.cancelAnimationFrame(animationFrameHandle);
            animationFrameHandle = null;
        }
        updateAnimationControls();
    }

    function animationTick(timestamp) {
        if (!state.animationPlaying) return;
        if (!animationLastTimestamp) animationLastTimestamp = timestamp;
        const elapsed = timestamp - animationLastTimestamp;
        animationLastTimestamp = timestamp;
        const durationMs = getCurrentAnimation().duration * 1000;
        state.animationProgress = (state.animationProgress + (elapsed * state.animationSpeed / durationMs) * 100) % 100;
        updateAnimationControls();
        void renderCanvas();
        animationFrameHandle = window.requestAnimationFrame(animationTick);
    }

    /**
     * Start the editor-owned playback loop after an animation has been
     * selected.  EmoteLab starts an animation as soon as an item is chosen;
     * keeping that behaviour here also prevents a stale RAF/Spine track from
     * leaving the preview frozen on the previous animation.
     */
    function startSelectedAnimationPlayback() {
        if (templatePackage) {
            if (!hasSpineRenderer()) return false;
            // Stop the previous native track before validating the new scene;
            // malformed/paused scene metadata must not leave an old Spine
            // animation playing behind a stopped editor loop.
            try { spineRenderer.pause(); } catch (_) { /* best effort */ }
            const synced = syncNativeScene(getSelectedScene(), { autoplay: true });
            if (!synced) {
                // A failed scene switch must not leave the old native track
                // running while the UI reports the newly selected animation.
                try { spineRenderer.pause(); } catch (_) { /* best effort */ }
                state.animationPlaying = false;
                return false;
            }
            state.animationPlaying = true;
            startSpineAnimationLoop();
            return true;
        }

        state.animationPlaying = true;
        animationLastTimestamp = 0;
        if (!animationFrameHandle && typeof window.requestAnimationFrame === 'function') {
            animationFrameHandle = window.requestAnimationFrame(animationTick);
        }
        return true;
    }


    function renderColorSwatches() {
        if (!colorSwatches) return;
        const colors = [...new Set([...state.recentColors, ...COLOR_SWATCHES])].slice(0, 14);
        colorSwatches.replaceChildren(...colors.map((color) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'color-swatch' + (color.toLowerCase() === getSelectedColor().toLowerCase() ? ' is-selected' : '');
            button.style.setProperty('--swatch', color);
            button.title = color;
            button.setAttribute('aria-label', color);
            button.addEventListener('click', () => setSelectedColor(color));
            return button;
        }));
        const customColor = $('#custom-color-input');
        if (customColor) customColor.value = getSelectedColor();
    }

    function renderTemplateSlotControls() {
        if (!templateSlotControls) return;
        if (!templatePackage) {
            templateSlotControls.hidden = true;
            templateSlotControls.replaceChildren();
            return;
        }
        const slots = getTemplateSlotStyles().filter((item) => item?.name);
        templateSlotControls.hidden = false;
        if (!slots.length) {
            const note = document.createElement('p');
            note.className = 'template-compat-note';
            note.textContent = t('emoteMaker.templateMetadataOnly');
            templateSlotControls.replaceChildren(note);
            return;
        }

        let selectedName = String(state.templateSlotGroup || '');
        if (!slots.some((item) => String(item.name) === selectedName)) {
            selectedName = String(slots[0].name);
            state.templateSlotGroup = selectedName;
        }
        const selected = slots.find((item) => String(item.name) === selectedName) || slots[0];
        const catalogEntries = Array.isArray(templatePackage.catalogs?.slotGroups)
            ? templatePackage.catalogs.slotGroups
            : [];
        const catalogMap = new Map(catalogEntries.map((item) => [String(item?.id || ''), item]));
        const labelFor = (item) => getCatalogLabel(catalogMap.get(String(item?.name || ''))) || String(item?.name || '');

        const heading = document.createElement('div');
        heading.className = 'template-compat-heading';
        heading.textContent = t('emoteMaker.colorsTab');

        const selectRow = document.createElement('label');
        selectRow.className = 'template-compat-row';
        const selectLabel = document.createElement('span');
        selectLabel.textContent = t('emoteMaker.slotGroup');
        const select = document.createElement('select');
        select.setAttribute('aria-label', t('emoteMaker.slotGroup'));
        for (const item of slots) {
            const option = new Option(labelFor(item), String(item.name));
            option.title = String(item.name);
            option.selected = String(item.name) === selectedName;
            select.appendChild(option);
        }
        select.addEventListener('change', () => {
            state.templateSlotGroup = select.value;
            renderColorMode();
        });
        selectRow.append(selectLabel, select);

        const children = [heading, selectRow];
        const makeColorRow = (labelText, field, fallback) => {
            const row = document.createElement('label');
            row.className = 'template-compat-row';
            const label = document.createElement('span');
            label.textContent = labelText;
            const input = document.createElement('input');
            input.type = 'color';
            input.value = colorToHex(selected[field], colorToHex(fallback));
            input.disabled = !hasSpineRenderer();
            let beforeState = null;
            input.addEventListener('input', () => {
                if (!beforeState) beforeState = cloneState();
                const next = getTemplateSlotStyles();
                const target = next.find((item) => String(item.name) === String(selected.name));
                if (!target) return;
                target[field] = hexToTemplateColor(input.value, fallback);
                state.templateSlots = next;
                applyNativeCharacterState({ render: true });
            });
            input.addEventListener('change', () => {
                if (beforeState) {
                    history.push(beforeState);
                    future.length = 0;
                    if (history.length > 40) history.shift();
                }
                renderAll();
            });
            row.append(label, input);
            return row;
        };
        children.push(
            makeColorRow(t('emoteMaker.defaultColor'), 'tintColor', { r: 1, g: 1, b: 1, a: 1 }),
            makeColorRow(t('emoteMaker.tintBlack'), 'tintBlackColor', { r: 0, g: 0, b: 0, a: 1 }),
        );
        if (!hasSpineRenderer()) {
            const note = document.createElement('p');
            note.className = 'template-compat-note';
            note.textContent = t('emoteMaker.templateMetadataOnly');
            children.push(note);
        }
        templateSlotControls.replaceChildren(...children);
    }

    function layerLabel(layerId) {
        return t(`emoteMaker.layerNames.${layerId}`);
    }

    function layerSource(layerId) {
        if (layerId === 'expression') return getExpression().src || `${ICON_ROOT}expression_chosen.png`;
        if (layerId === 'accessory') return getAccessory().src || `${ICON_ROOT}expression_chosen.png`;
        return `${ICON_ROOT}emotion_config_bg.png`;
    }

    function renderLayers() {
        if (!layerList) return;
        const section = layerList.closest('.layer-section');
        if (section) section.hidden = Boolean(templatePackage);
        if (templatePackage) {
            // Imported Spine draw order is authored by the skeleton/animation.
            // The editor's raster expression/accessory stack cannot safely
            // reorder or hide those slots, so do not expose inert controls.
            layerList.replaceChildren();
            return;
        }
        const ordered = [...state.layerOrder].reverse();
        layerList.replaceChildren(...ordered.map((layerId) => {
            const item = document.createElement('div');
            item.className = 'layer-item' + (layerId === state.selectedLayer ? ' is-selected' : '');
            item.dataset.layerId = layerId;
            item.addEventListener('click', () => {
                if (state.selectedLayer === layerId) return;
                state.selectedLayer = layerId;
                renderAll();
            });

            const thumb = document.createElement('img');
            thumb.className = 'layer-thumb';
            thumb.src = layerSource(layerId);
            thumb.alt = layerLabel(layerId);

            const copy = document.createElement('span');
            copy.className = 'layer-copy';
            const name = document.createElement('span');
            name.className = 'layer-name';
            name.textContent = layerLabel(layerId);
            const status = document.createElement('span');
            status.className = 'layer-state';
            status.textContent = state.layerVisible[layerId] ? t('emoteMaker.visible') : t('emoteMaker.hidden');
            copy.append(name, status);

            const actions = document.createElement('span');
            actions.className = 'layer-actions';
            const visibility = document.createElement('button');
            visibility.type = 'button';
            visibility.textContent = state.layerVisible[layerId] ? t('emoteMaker.visible') : t('emoteMaker.hidden');
            visibility.addEventListener('click', (event) => {
                event.stopPropagation();
                recordChange(() => { state.layerVisible[layerId] = !state.layerVisible[layerId]; });
            });
            const index = state.layerOrder.indexOf(layerId);
            const moveUp = document.createElement('button');
            moveUp.type = 'button';
            moveUp.textContent = t('emoteMaker.moveUp');
            moveUp.disabled = index >= state.layerOrder.length - 1;
            moveUp.addEventListener('click', (event) => {
                event.stopPropagation();
                moveLayer(layerId, 1);
            });
            const moveDown = document.createElement('button');
            moveDown.type = 'button';
            moveDown.textContent = t('emoteMaker.moveDown');
            moveDown.disabled = index <= 0;
            moveDown.addEventListener('click', (event) => {
                event.stopPropagation();
                moveLayer(layerId, -1);
            });
            actions.append(visibility, moveUp, moveDown);
            item.append(thumb, copy, actions);
            return item;
        }));
    }

    function moveLayer(layerId, direction) {
        recordChange(() => {
            const index = state.layerOrder.indexOf(layerId);
            const nextIndex = index + direction;
            if (index < 0 || nextIndex < 0 || nextIndex >= state.layerOrder.length) return;
            const next = state.layerOrder[nextIndex];
            state.layerOrder[nextIndex] = layerId;
            state.layerOrder[index] = next;
        });
    }

    function updateHistoryButtons() {
        const undoButton = $('#undo-btn');
        const redoButton = $('#redo-btn');
        if (undoButton) undoButton.disabled = history.length === 0;
        if (redoButton) redoButton.disabled = future.length === 0;
    }

    function loadImage(src) {
        if (!src) return Promise.resolve(null);
        if (imageCache.has(src)) return imageCache.get(src);
        const promise = new Promise((resolve) => {
            const image = new Image();
            image.onload = () => resolve(image);
            image.onerror = () => resolve(null);
            image.src = src;
        });
        imageCache.set(src, promise);
        return promise;
    }

    function drawContain(context, image, x, y, width, height) {
        if (!image) return;
        const scale = Math.min(width / image.width, height / image.height);
        const drawWidth = image.width * scale;
        const drawHeight = image.height * scale;
        context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
    }

    async function drawTintedImage(context, image, box, color, tintStrength) {
        if (!image) return;
        const scratch = document.createElement('canvas');
        scratch.width = Math.max(1, Math.round(box.width));
        scratch.height = Math.max(1, Math.round(box.height));
        const scratchContext = scratch.getContext('2d');
        scratchContext.imageSmoothingEnabled = true;
        scratchContext.imageSmoothingQuality = 'high';
        drawContain(scratchContext, image, 0, 0, scratch.width, scratch.height);
        if (state.colorMode !== 'default' && color && color.toLowerCase() !== '#ffffff') {
            scratchContext.globalCompositeOperation = 'source-atop';
            scratchContext.globalAlpha = tintStrength;
            scratchContext.fillStyle = color;
            scratchContext.fillRect(0, 0, scratch.width, scratch.height);
            if (state.colorMode === 'two-tone') {
                scratchContext.globalAlpha = Math.min(0.46, tintStrength * 0.72);
                scratchContext.fillStyle = state.secondaryColor;
                scratchContext.fillRect(0, 0, scratch.width, scratch.height);
            }
            scratchContext.globalAlpha = 1;
            scratchContext.globalCompositeOperation = 'source-over';
        }
        context.drawImage(scratch, box.x, box.y, box.width, box.height);
    }

    function drawReactionHeart(context, x, y, size, fill) {
        context.beginPath();
        context.moveTo(x, y + size * 0.28);
        context.bezierCurveTo(x - size * 0.52, y - size * 0.18, x - size * 0.62, y + size * 0.58, x, y + size);
        context.bezierCurveTo(x + size * 0.62, y + size * 0.58, x + size * 0.52, y - size * 0.18, x, y + size * 0.28);
        context.fillStyle = fill;
        context.fill();
        context.stroke();
    }

    function drawReactionSpark(context, x, y, size, fill) {
        context.beginPath();
        context.moveTo(x, y - size);
        context.lineTo(x + size * 0.22, y - size * 0.22);
        context.lineTo(x + size, y);
        context.lineTo(x + size * 0.22, y + size * 0.22);
        context.lineTo(x, y + size);
        context.lineTo(x - size * 0.22, y + size * 0.22);
        context.lineTo(x - size, y);
        context.lineTo(x - size * 0.22, y - size * 0.22);
        context.closePath();
        context.fillStyle = fill;
        context.fill();
        context.stroke();
    }

    function drawReactionDrop(context, x, y, size) {
        context.beginPath();
        context.moveTo(x, y - size);
        context.bezierCurveTo(x - size * 0.72, y - size * 0.18, x - size * 0.62, y + size * 0.78, x, y + size);
        context.bezierCurveTo(x + size * 0.62, y + size * 0.78, x + size * 0.72, y - size * 0.18, x, y - size);
        context.fillStyle = '#75d8ff';
        context.fill();
        context.stroke();
    }

    function drawReactionText(context, value, x, y, size, fill) {
        context.font = `900 ${size}px "Trebuchet MS", sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.lineWidth = Math.max(5, size * 0.12);
        context.strokeText(value, x, y);
        context.fillStyle = fill;
        context.fillText(value, x, y);
    }

    function drawReactionOverlay(context, overlay) {
        const outline = '#5b1233';
        context.save();
        context.lineJoin = 'round';
        context.lineCap = 'round';
        context.lineWidth = 8;
        context.strokeStyle = outline;

        if (overlay === 'cheer') {
            drawReactionSpark(context, 174, 356, 22, '#ffdc62');
            drawReactionSpark(context, 850, 350, 22, '#78caff');
            drawReactionSpark(context, 126, 438, 15, '#78caff');
            drawReactionSpark(context, 900, 432, 15, '#ffdc62');
        } else if (overlay === 'hello') {
            context.beginPath();
            context.arc(876, 514, 35, 0, Math.PI * 2);
            context.fillStyle = '#75d8ff';
            context.fill();
            context.stroke();
            context.beginPath();
            context.moveTo(855, 486);
            context.quadraticCurveTo(872, 452, 888, 480);
            context.moveTo(872, 480);
            context.quadraticCurveTo(898, 448, 910, 482);
            context.stroke();
            context.beginPath();
            context.moveTo(924, 440);
            context.lineTo(954, 418);
            context.moveTo(930, 468);
            context.lineTo(964, 460);
            context.strokeStyle = '#78caff';
            context.stroke();
        } else if (overlay === 'sleepy') {
            drawReactionText(context, 'Z', 848, 300, 58, '#b9a7ff');
            drawReactionText(context, 'z', 906, 244, 38, '#b9a7ff');
        } else if (overlay === 'shy') {
            drawReactionHeart(context, 164, 450, 34, '#8fd6ff');
            drawReactionHeart(context, 852, 446, 36, '#8fd6ff');
            context.strokeStyle = '#f08ca7';
            context.lineWidth = 7;
            context.beginPath();
            context.moveTo(402, 628); context.lineTo(420, 617);
            context.moveTo(428, 638); context.lineTo(446, 627);
            context.moveTo(716, 628); context.lineTo(734, 617);
            context.moveTo(690, 638); context.lineTo(708, 627);
            context.stroke();
        } else if (overlay === 'cry') {
            drawReactionDrop(context, 390, 650, 28);
            drawReactionDrop(context, 634, 650, 28);
            drawReactionDrop(context, 286, 716, 17);
            drawReactionDrop(context, 738, 716, 17);
        } else if (overlay === 'confused') {
            drawReactionText(context, '?', 170, 310, 70, '#b9a7ff');
            drawReactionText(context, '?', 874, 300, 58, '#b9a7ff');
        } else if (overlay === 'angry') {
            context.strokeStyle = '#ef6e8e';
            context.lineWidth = 12;
            context.beginPath();
            context.moveTo(182, 364); context.lineTo(206, 344); context.lineTo(230, 364); context.lineTo(254, 344);
            context.moveTo(770, 344); context.lineTo(794, 364); context.lineTo(818, 344); context.lineTo(842, 364);
            context.stroke();
            drawReactionText(context, '!', 860, 240, 48, '#ef6e8e');
        } else if (overlay === 'love') {
            drawReactionHeart(context, 160, 370, 48, '#ff9fb5');
            drawReactionHeart(context, 866, 368, 52, '#ff9fb5');
            drawReactionHeart(context, 190, 492, 26, '#8fd6ff');
            drawReactionHeart(context, 836, 500, 28, '#8fd6ff');
        } else if (overlay === 'celebrate') {
            const confetti = [
                [154, 300, 12, 34, '#78caff'], [216, 250, 12, 30, '#ffdc62'],
                [836, 270, 12, 34, '#ff9fb5'], [896, 324, 12, 30, '#78caff'],
                [168, 620, 12, 28, '#ff9fb5'], [866, 620, 12, 28, '#ffdc62']
            ];
            for (const [x, y, width, height, fill] of confetti) {
                context.save();
                context.translate(x, y);
                context.rotate((x % 3) * 0.32 - 0.3);
                context.fillStyle = fill;
                context.fillRect(-width / 2, -height / 2, width, height);
                context.strokeRect(-width / 2, -height / 2, width, height);
                context.restore();
            }
            drawReactionSpark(context, 278, 268, 18, '#ffdc62');
            drawReactionSpark(context, 750, 264, 18, '#78caff');
        }
        context.restore();
    }

    function getAnimationTransform(layerId) {
        const phase = (state.animationProgress / 100) * Math.PI * 2;
        const transform = { x: 0, y: 0, rotation: 0, scale: 100 };
        if (state.animationId === 'bounce') {
            transform.y = -Math.abs(Math.sin(phase)) * 18;
            transform.scale = 100 + Math.sin(phase) * 2;
        } else if (state.animationId === 'wiggle') {
            transform.rotation = Math.sin(phase * 2) * 4;
            transform.x = Math.sin(phase) * 8;
        } else if (state.animationId === 'celebrate') {
            transform.y = -Math.abs(Math.sin(phase * 2)) * 12;
            transform.rotation = Math.sin(phase * 2) * 7;
            transform.scale = 100 + Math.abs(Math.sin(phase * 2)) * 3;
        }
        if (state.adjustOverwrite && state.selectedLayer === layerId) {
            transform.x += Number(state.adjustments.x) || 0;
            transform.y += Number(state.adjustments.y) || 0;
            transform.rotation += Number(state.adjustments.rotation) || 0;
            transform.scale = transform.scale * ((Number(state.adjustments.scale) || 100) / 100);
        }
        return transform;
    }

    async function drawLayerImage(context, image, box, color, tintStrength, layerId) {
        if (!image) return;
        const transform = getAnimationTransform(layerId);
        context.save();
        context.translate(CANVAS_SIZE / 2 + transform.x * 2, CANVAS_SIZE / 2 + transform.y * 2);
        context.rotate((transform.rotation * Math.PI) / 180);
        context.scale(transform.scale / 100, transform.scale / 100);
        await drawTintedImage(context, image, {
            x: box.x - CANVAS_SIZE / 2,
            y: box.y - CANVAS_SIZE / 2,
            width: box.width,
            height: box.height
        }, color, tintStrength);
        context.restore();
    }

    async function drawExpressionLayer(context, image, expression) {
        if (!image) return;
        const transform = getAnimationTransform('expression');
        context.save();
        context.translate(CANVAS_SIZE / 2 + transform.x * 2, CANVAS_SIZE / 2 + transform.y * 2);
        context.rotate((transform.rotation * Math.PI) / 180);
        context.scale(transform.scale / 100, transform.scale / 100);
        await drawTintedImage(context, image, {
            // The supplied PNG contains generous transparent padding. Crop
            // only that padding; the character pixels themselves stay intact.
            x: -112 - CANVAS_SIZE / 2,
            y: -112 - CANVAS_SIZE / 2,
            width: 1248,
            height: 1248
        }, state.colors.expression, 0.14);
        // The reaction marks travel with the immutable character base.
        context.translate(-CANVAS_SIZE / 2, -CANVAS_SIZE / 2);
        drawReactionOverlay(context, expression.overlay);
        context.restore();
    }

    function finiteNumber(value, fallback = 0) {
        const number = Number(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function sceneVector(value, fallback = [0, 0, 0]) {
        if (Array.isArray(value)) {
            return fallback.map((item, index) => finiteNumber(value[index], item));
        }
        if (value && typeof value === 'object') {
            return fallback.map((item, index) => finiteNumber(value[['x', 'y', 'z'][index]], item));
        }
        return [...fallback];
    }

    function sceneColorCss(value, fallback = { r: 1, g: 1, b: 1, a: 1 }) {
        const color = value && typeof value === 'object' ? value : fallback;
        const channel = (key, defaultValue) => Math.max(0, Math.min(1, finiteNumber(color[key], defaultValue)));
        return `rgba(${Math.round(channel('r', fallback.r) * 255)}, ${Math.round(channel('g', fallback.g) * 255)}, ${Math.round(channel('b', fallback.b) * 255)}, ${channel('a', fallback.a)})`;
    }

    function syncOverlayCanvasSize(target, source = spineCanvas) {
        if (!target || !source) return null;
        const width = Math.max(1, Number(source.width) || CANVAS_SIZE);
        const height = Math.max(1, Number(source.height) || CANVAS_SIZE);
        if (target.width !== width) target.width = width;
        if (target.height !== height) target.height = height;
        return { width, height };
    }

    function clearOverlayCanvas(target, source = spineCanvas) {
        const size = syncOverlayCanvasSize(target, source);
        if (!size) return null;
        const context = target.getContext('2d');
        context.clearRect(0, 0, size.width, size.height);
        return { context, ...size };
    }

    function sceneTextProjection(text, scene, width, height) {
        const camera = scene?.camera || {};
        const style = text?.transformData || {};
        const local = sceneVector(style.localPosition, [0, 0, 0]);
        const orthographicSize = Math.max(0.001, finiteNumber(camera.orthographicSize, 5));
        // EmoteLab stores text positions in the SceneTextRoot's local space.
        // That root is camera-centred, so the vertical orthographic span is
        // exactly 2 * orthographicSize.  Keeping this conversion in one place
        // also makes the overlay and animated export use identical geometry.
        const pixelsPerUnit = height / (orthographicSize * 2);
        return {
            x: width / 2 + local[0] * pixelsPerUnit,
            y: height / 2 - local[1] * pixelsPerUnit,
            z: local[2],
            pixelsPerUnit,
        };
    }

    function normalizedTextContent(value, style = {}) {
        if (sceneTextCompat?.normalizeTextContent) {
            return sceneTextCompat.normalizeTextContent(value, {
                richText: style.richText,
                parseCtrlCharacters: style.parseCtrlCharacters,
            });
        }
        return String(value ?? '')
            .replace(/<br\s*\/?\s*>/gi, '\n')
            .replace(/<[^>]+>/g, '');
    }

    function textFont(style, pixelSize) {
        if (sceneTextCompat?.fontCss) return sceneTextCompat.fontCss(style, pixelSize);
        const rawStyle = String(style?.fontStyle || '').toLocaleLowerCase();
        const italic = rawStyle.includes('italic') ? 'italic ' : '';
        const bold = rawStyle.includes('bold') || rawStyle.includes('heavy') ? '700 ' : '';
        const requested = String(style?.fontName || '').replace(/["']/g, '').trim();
        const family = requested
            ? `"${requested}", Arial, "Microsoft YaHei", sans-serif`
            : 'Arial, "Microsoft YaHei", sans-serif';
        return `${italic}${bold}${Math.max(1, pixelSize)}px ${family}`;
    }

    function textAlignValue(value) {
        if (sceneTextCompat?.alignmentToken) return sceneTextCompat.alignmentToken(value);
        const token = String(value || '').toLocaleLowerCase();
        if (token.includes('left') || token.includes('start')) return 'left';
        if (token.includes('right') || token.includes('end')) return 'right';
        return 'center';
    }

    function textBaselineValue(value) {
        if (sceneTextCompat?.baselineToken) return sceneTextCompat.baselineToken(value);
        const token = String(value || '').toLocaleLowerCase();
        if (token.includes('top')) return 'top';
        if (token.includes('bottom')) return 'bottom';
        if (token.includes('cap')) return 'hanging';
        return 'middle';
    }

    function drawTextLineWithSpacing(context, line, x, y, align, characterSpacing, wordSpacing, draw) {
        const chars = [...String(line ?? '')];
        if (!chars.length) return;
        const spacing = Math.max(-context.measureText(chars[0]).width, finiteNumber(characterSpacing, 0));
        const extraWordSpacing = finiteNumber(wordSpacing, 0);
        if (Math.abs(spacing) < 0.001 && Math.abs(extraWordSpacing) < 0.001) {
            context.textAlign = align;
            draw(line, x, y);
            return;
        }
        let totalWidth = 0;
        const widths = chars.map((char) => context.measureText(char).width);
        chars.forEach((char, index) => {
            totalWidth += widths[index];
            if (index < chars.length - 1) {
                totalWidth += spacing;
                if (/\s/.test(char)) totalWidth += extraWordSpacing;
            }
        });
        let cursor = x;
        if (align === 'center') cursor -= totalWidth / 2;
        else if (align === 'right') cursor -= totalWidth;
        context.textAlign = 'left';
        chars.forEach((char, index) => {
            draw(char, cursor, y);
            cursor += widths[index];
            if (index < chars.length - 1) {
                cursor += spacing;
                if (/\s/.test(char)) cursor += extraWordSpacing;
            }
        });
    }

    function drawSceneTextLayer(target, scene, side) {
        const layer = clearOverlayCanvas(target);
        if (!layer || !scene) return;
        const texts = (Array.isArray(scene.texts) ? scene.texts : [])
            .map((item, index) => ({ item, index }))
            .filter(({ item }) => {
                const normalizedSide = sceneTextCompat?.normalizeSide
                    ? sceneTextCompat.normalizeSide(item?.side)
                    : (String(item?.side || '').toLocaleLowerCase() === 'behind' ? 'Behind' : 'Front');
                return normalizedSide === side;
            })
            .filter(({ item }) => item?.transformData?.visible !== false)
            .sort((left, right) => finiteNumber(left.item?.transformData?.sortingOrder, 0)
                - finiteNumber(right.item?.transformData?.sortingOrder, 0) || left.index - right.index)
            .map(({ item }) => item);
        if (!texts.length) return;
        const { context, width, height } = layer;
        const editorTransform = getNativeTransform();
        const globalScale = Math.max(0.01, finiteNumber(editorTransform.scale, 1));
        const globalRotation = finiteNumber(editorTransform.rotation, 0) * Math.PI / 180;
        context.save();
        context.translate(width / 2 + finiteNumber(editorTransform.x, 0) * height / 1000, height / 2 + finiteNumber(editorTransform.y, 0) * height / 1000);
        context.rotate(globalRotation);
        context.scale(globalScale, globalScale);
        context.translate(-width / 2, -height / 2);
        for (const item of texts) {
            const style = item.style || {};
            const material = item.material || {};
            const transform = item.transformData || {};
            const projected = sceneTextProjection(item, scene, width, height);
            const text = normalizedTextContent(style.text ?? item.text ?? '', style);
            if (!text) continue;
            // TextMeshPro's fontSize is a UI point size rather than a Spine
            // world-unit length. Keep it legible at both the 6-unit and
            // 14.4-unit YUI camera presets; very small viewports still get a
            // proportional floor through the same scale factor.
            const textUnitScale = Math.max(1, projected.pixelsPerUnit * 0.01);
            const fontSize = Math.max(8, Math.min(512, finiteNumber(style.fontSize, 36) * textUnitScale));
            const rotation = -finiteNumber(transform.rotationZ, 0) * Math.PI / 180;
            context.save();
            context.translate(projected.x, projected.y);
            context.rotate(rotation);
            context.font = textFont(style, fontSize);
            context.textAlign = textAlignValue(style.horizontalAlignment);
            context.textBaseline = textBaselineValue(style.verticalAlignment);
            const textWidth = Math.max(0, finiteNumber(
                style.textWidth ?? style.rectWidth ?? style.maxWidth,
                0,
            ) * textUnitScale);
            const lines = sceneTextCompat?.wrapLines
                ? sceneTextCompat.wrapLines(
                    text,
                    (value) => context.measureText(value).width,
                    textWidth,
                    {
                        enableWordWrapping: style.enableWordWrapping === true,
                        overflowMode: style.overflowMode,
                    },
                )
                : text.split(/\r?\n/);
            const lineHeight = Math.max(fontSize, fontSize + finiteNumber(style.lineSpacing, 0) * textUnitScale);
            const paragraphSpacing = Math.max(0, finiteNumber(style.paragraphSpacing, 0) * textUnitScale);
            const paragraphBreaks = lines.slice(1).reduce(
                (count, line, index) => count + (lines[index] === '' || line === '' ? 1 : 0),
                0,
            );
            const blockHeight = lineHeight * lines.length + paragraphSpacing * paragraphBreaks;
            const align = context.textAlign;
            const baseline = context.textBaseline;
            const startY = baseline === 'middle'
                ? -blockHeight / 2 + lineHeight / 2
                : baseline === 'bottom' ? -blockHeight : 0;
            const drawX = 0;
            const face = sceneColorCss(material.faceColor);
            const outline = sceneColorCss(material.outlineColor, { r: 0, g: 0, b: 0, a: 1 });
            const underlay = sceneColorCss(material.underlayColor, { r: 0, g: 0, b: 0, a: 0 });
            const characterSpacing = finiteNumber(style.characterSpacing, 0) * textUnitScale;
            const wordSpacing = finiteNumber(style.wordSpacing, 0) * textUnitScale;
            const outlineWidth = material.outlineEnabled
                ? Math.max(0, Math.min(48, finiteNumber(material.outlineWidth, 0) * textUnitScale))
                : 0;
            const underlayEnabled = Boolean(material.underlayEnabled);
            const underlayX = finiteNumber(material.underlayOffsetX, 0) * textUnitScale;
            const underlayY = -finiteNumber(material.underlayOffsetY, 0) * textUnitScale;
            lines.forEach((line, lineIndex) => {
                let paragraphOffset = 0;
                for (let prior = 1; prior <= lineIndex; prior += 1) {
                    if (lines[prior - 1] === '' || lines[prior] === '') paragraphOffset += paragraphSpacing;
                }
                const y = startY + lineIndex * lineHeight + paragraphOffset;
                if (underlayEnabled) {
                    context.fillStyle = underlay;
                    drawTextLineWithSpacing(
                        context,
                        line,
                        drawX + underlayX,
                        y + underlayY,
                        align,
                        characterSpacing,
                        wordSpacing,
                        (part, partX, partY) => context.fillText(part, partX, partY),
                    );
                }
                if (outlineWidth > 0) {
                    context.lineJoin = 'round';
                    context.lineWidth = outlineWidth;
                    context.strokeStyle = outline;
                    drawTextLineWithSpacing(
                        context,
                        line,
                        drawX,
                        y,
                        align,
                        characterSpacing,
                        wordSpacing,
                        (part, partX, partY) => context.strokeText(part, partX, partY),
                    );
                }
                context.fillStyle = face;
                drawTextLineWithSpacing(
                    context,
                    line,
                    drawX,
                    y,
                    align,
                    characterSpacing,
                    wordSpacing,
                    (part, partX, partY) => context.fillText(part, partX, partY),
                );
            });
            context.restore();
        }
        context.restore();
    }

    function renderNativeOutline() {
        const layer = clearOverlayCanvas(outlineCanvas);
        const scene = getSelectedScene();
        const outline = scene?.model?.outline;
        if (!layer || !spineCanvas || !outline?.enabled || scene?.model?.visible === false) return;
        const editorScale = Math.max(0.01, finiteNumber(getNativeTransform()?.scale, 1));
        const outlineWidth = Math.max(0, Math.min(48, finiteNumber(outline.width, 8) || 8));
        const radius = sceneTextCompat?.outlinePixelRadius
            ? Math.max(1, sceneTextCompat.outlinePixelRadius(
                outlineWidth || 8,
                scene?.camera?.orthographicSize,
                layer.height,
                editorScale,
            ))
            : Math.max(1, Math.min(48, outlineWidth || 8));
        const context = layer.context;
        const { width, height } = layer;
        const steps = Math.max(16, Math.min(256, Math.ceil(radius * 2)));
        context.save();
        context.globalCompositeOperation = 'source-over';
        for (let index = 0; index < steps; index += 1) {
            const angle = (Math.PI * 2 * index) / steps;
            context.drawImage(spineCanvas, Math.cos(angle) * radius, Math.sin(angle) * radius, width, height);
        }
        // The shifted silhouettes are now a mask. Tint only the mask, leaving
        // the original Spine canvas above it to preserve interior pixels.
        context.globalCompositeOperation = 'source-in';
        context.fillStyle = sceneColorCss(outline.color);
        context.fillRect(0, 0, width, height);
        context.restore();
    }

    function renderNativeOverlays() {
        if (!templatePackage || !hasSpineRenderer()) {
            clearOverlayCanvas(outlineCanvas);
            clearOverlayCanvas(textBehindCanvas);
            clearOverlayCanvas(textFrontCanvas);
            return;
        }
        try {
            renderNativeOutline();
            const scene = getSelectedScene();
            drawSceneTextLayer(textBehindCanvas, scene, 'Behind');
            drawSceneTextLayer(textFrontCanvas, scene, 'Front');
        } catch (_) {
            clearOverlayCanvas(outlineCanvas);
            clearOverlayCanvas(textBehindCanvas);
            clearOverlayCanvas(textFrontCanvas);
        }
    }

    function nativeCompositeCanvas() {
        if (!hasSpineRenderer() || !spineCanvas) return null;
        const output = document.createElement('canvas');
        output.width = spineCanvas.width || CANVAS_SIZE;
        output.height = spineCanvas.height || CANVAS_SIZE;
        const context = output.getContext('2d');
        if (state.exportTransparent === false) {
            context.fillStyle = '#f5f9fc';
            context.fillRect(0, 0, output.width, output.height);
        }
        [outlineCanvas, textBehindCanvas, spineCanvas, textFrontCanvas].forEach((source) => {
            if (source && !source.hidden) context.drawImage(source, 0, 0, output.width, output.height);
        });
        return output;
    }

    async function renderCanvas() {
        if (!canvas) return;
        const token = ++renderToken;
        if (templatePackage && hasSpineRenderer()) {
            setCanvasMode(true);
            try {
                applyNativeVisualState();
                spineRenderer.render();
                renderNativeOverlays();
            } catch (_) {
                // The metadata fallback below remains available if the WebGL
                // context is lost while the editor is open.
                renderNativeOverlays();
            }
            return;
        }
        setCanvasMode(false);
        const context = canvas.getContext('2d');
        context.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';

        if (templatePackage) {
            const scene = getImportedScenes().find((item) => item.id === state.selectedSceneId);
            context.save();
            context.fillStyle = 'rgba(36, 170, 244, 0.06)';
            context.fillRect(86, 86, CANVAS_SIZE - 172, CANVAS_SIZE - 172);
            context.strokeStyle = 'rgba(36, 170, 244, 0.42)';
            context.setLineDash([14, 12]);
            context.lineWidth = 4;
            context.strokeRect(86, 86, CANVAS_SIZE - 172, CANVAS_SIZE - 172);
            context.setLineDash([]);
            context.fillStyle = '#1b6fa8';
            context.textAlign = 'center';
            context.textBaseline = 'middle';
            context.font = '700 34px "Microsoft YaHei", sans-serif';
            context.fillText(currentTemplateLabel() || t('emoteMaker.title'), CANVAS_SIZE / 2, 402);
            context.font = '600 24px "Microsoft YaHei", sans-serif';
            context.fillStyle = '#6d8eae';
            context.fillText(scene?.name || t('emoteMaker.templateSceneList'), CANVAS_SIZE / 2, 470);
            context.font = '500 20px "Microsoft YaHei", sans-serif';
            context.fillText(t('emoteMaker.templateNoRuntime'), CANVAS_SIZE / 2, 548);
            context.restore();
            return;
        }

        const expression = getExpression();
        const accessory = getAccessory();
        const [expressionImage, accessoryImage] = await Promise.all([
            loadImage(expression.src),
            loadImage(accessory.src)
        ]);
        if (token !== renderToken) return;

        for (const layerId of state.layerOrder) {
            if (!state.layerVisible[layerId]) continue;
            if (layerId === 'background') {
                context.save();
                context.fillStyle = '#f5fbff';
                context.fillRect(34, 34, CANVAS_SIZE - 68, CANVAS_SIZE - 68);
                context.restore();
                continue;
            }
            if (layerId === 'expression') {
                context.save();
                context.shadowColor = 'rgba(28, 87, 126, 0.17)';
                context.shadowBlur = 28;
                context.shadowOffsetY = 14;
                // The supplied YUI PNG is the immutable identity layer;
                // reaction marks are composed around it without redrawing it.
                await drawExpressionLayer(context, expressionImage, expression);
                context.restore();
                continue;
            }
            if (layerId === 'accessory' && accessoryImage && accessory.placement) {
                const size = CANVAS_SIZE * accessory.placement.size;
                const x = CANVAS_SIZE * accessory.placement.x - size / 2;
                const y = CANVAS_SIZE * accessory.placement.y - size / 2;
                await drawLayerImage(context, accessoryImage, { x, y, width: size, height: size }, state.colors.accessory, 0.82, 'accessory');
            }
        }
    }

    function applyZoom() {
        const zoom = Math.max(0.75, Math.min(1.18, state.zoom));
        state.zoom = zoom;
        if (canvasFrame) canvasFrame.style.transform = `scale(${zoom})`;
        if (zoomValue) zoomValue.textContent = `${Math.round(zoom * 100)}%`;
    }

    // ── 长按拖到形象包 ────────────────────────────────────────────────────────
    // 用指针事件而不是 HTML5 dnd：原生 draggable 在 mousedown+移动就启动，跟列表的
    // 点击抢同一个手势，没法表达"按住一会儿才算拖"。
    let suppressClickUntil = 0;

    function resolveSceneForPayload(payload) {
        const packModule = window.NekoEmotePngtuberPack;
        if (!packModule || typeof packModule.resolveSceneForDrag !== 'function') return null;
        return packModule.resolveSceneForDrag(getImportedScenes(), payload);
    }

    // 落点，从具体到笼统：表演台的某一格 → 基础模式某一行 → 形象包区块（只负责把
    // 表演台打开，然后提示"拖到格上"）。整个形象包区块都能接住，是为了避免
    // "拖了半天什么都没发生"这类最难自查的失败。
    function packDropTargetAt(x, y) {
        if (stateStageSession && stateStageSession.containsPoint(x, y)) {
            const stateKey = stateStageSession.stateAtPoint(x, y);
            return stateKey ? { kind: 'tile', element: stateStageSession.element, stateKey } : null;
        }
        const under = document.elementFromPoint(x, y);
        if (!under || !under.closest) return null;
        // 只承认"这一格会被设成什么"。整个区块都能接住看似周到，实际是让用户
        // 在八个地方松手、然后有三个什么都不做。
        const row = under.closest('.pack-basic-row');
        return row && row.dataset.stateKey ? { kind: 'row', element: row } : null;
    }

    let packDropRevealed = false;

    /**
     * 拖着拖着进了右侧面板：先把「导出设置 → 基础」翻出来、滚到形象包那块、
     * 让八行轻轻呼吸一下 —— 否则用户手里拿着东西，却不知道该往哪儿放。
     * 一次拖拽只reveal一次，不打断已经在对准的手。
     */
    function revealPackPanelForDrop() {
        if (packDropRevealed) return;
        const panel = $('#inspector-panel-export');
        if (!panel) return;
        const insideInspector = panel.closest('.inspector-panel') || panel;
        if (!insideInspector.getBoundingClientRect().width) return;
        packDropRevealed = true;
        if (state.inspectorTab !== 'export') setInspectorTab('export');
        if (state.packMode !== 'basic') {
            state.packMode = 'basic';
            persistLayout();
        }
        renderPackPanel();
        const rows = $('#pack-basic-rows');
        if (rows) {
            rows.classList.add('is-drop-hint');
            scrollGroupIntoView(rows);
        }
    }

    /**
     * 目标是"八行全都看得见"，不是把容器底边对齐到面板底 ——
     * 上一版用 scrollIntoView({block:'end'}) 就是滚到了最顶上，只露出后几行。
     */
    /**
     * 目标很具体：八行全都看得见（不是把容器底边对齐，也不是滚到顶）。
     * 哪个元素真能滚不靠 CSS 猜 —— 直接试着滚一下、读回来，能动才算找到。
     */
    function scrollGroupIntoView(el) {
        const pad = 10;
        const candidates = [];
        let node = el.parentElement;
        while (node && node !== document.body) {
            candidates.push(node);
            node = node.parentElement;
        }
        candidates.push(document.scrollingElement || document.documentElement);

        for (let i = 0; i < candidates.length; i += 1) {
            const scroller = candidates[i];
            const before = scroller.scrollTop;
            const frame = scroller.getBoundingClientRect();
            const box = el.getBoundingClientRect();
            let delta = 0;
            if (box.height + pad * 2 >= frame.height) {
                delta = box.top - frame.top - pad;      // 装不下：至少从顶部对齐
            } else {
                if (box.bottom > frame.bottom - pad) delta = box.bottom - (frame.bottom - pad);
                else if (box.top < frame.top + pad) delta = box.top - (frame.top + pad);
            }
            if (!delta) return;
            scroller.scrollTop = before + delta;
            // 上一行没生效（这个元素根本不滚）就换下一个候选
            if (Math.abs(scroller.scrollTop - before) > 0.5) return;
            scroller.scrollTop = before;
        }
    }

    function hidePackDropHint() {
        packDropRevealed = false;
        const rows = $('#pack-basic-rows');
        if (rows) rows.classList.remove('is-drop-hint');
    }



    function setDropHighlight(target, on) {
        if (!target) return;
        if (target.kind === 'tile') stateStageSession.setDropHighlight(on ? target.stateKey : null);
        else target.element.classList.toggle('is-drop-target', on);
    }

    function beginPackDrag(payload, event, sourceElement) {
        const holdModule = window.NekoEmoteDragHold;
        // 拖出来的东西长得像它来自的那张选项卡（缩略图 + 名字）。
        // 一行文字的 ghost 会让人以为自己在拖空气。
        const ghost = holdModule
            ? holdModule.buildGhost(payload, sourceElement)
            : Object.assign(document.createElement('div'), {
                className: 'pack-drag-ghost',
            });
        if (!holdModule) {
            const label = document.createElement('span');
            label.className = 'pack-drag-label';
            label.textContent = String(payload.label || '');
            ghost.appendChild(label);
        }
        document.body.appendChild(ghost);
        document.body.classList.add('is-pack-dragging');
        // 长按一起拖，这一轮就到此为止：原地松手不能被当成"点击选中那个场景"。
        // 以前只在松手时才记，指针一动不动地按住再松开仍会漏。
        suppressClickUntil = Date.now() + 600;
        let lastTarget = null;
        // 手里的东西跟着横向速度甩一下、停下回正：不甩就像钉在光标上的贴图
        const swing = holdModule ? holdModule.createGhostSwing(ghost) : null;
        const place = swing
            ? (x, y) => swing.moveTo(x, y)
            : (x, y) => { ghost.style.left = `${x}px`; ghost.style.top = `${y}px`; };
        if (swing) { place(event.clientX, event.clientY); swing.start(); }
        const highlight = (target) => {
            if (lastTarget === target) return;
            setDropHighlight(lastTarget, false);
            setDropHighlight(target, true);
            lastTarget = target;
        };
        const move = (moveEvent) => {
            place(moveEvent.clientX, moveEvent.clientY);
            const target = packDropTargetAt(moveEvent.clientX, moveEvent.clientY);
            if (!target) {
                // 手里有东西时指针样式不能被下面的按钮改来改去（CSS 里锁住），
                // 同时把该放的地方翻出来给他看。
                const under = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
                if (under && under.closest && under.closest('.inspector-panel')) {
                    revealPackPanelForDrop();
                }
            }
            highlight(target);
        };
        const stop = (upEvent) => {
            window.removeEventListener('pointermove', move, true);
            window.removeEventListener('pointerup', stop, true);
            window.removeEventListener('pointercancel', cancel, true);
            swing?.stop();
            ghost.remove();
            document.body.classList.remove('is-pack-dragging');
            hidePackDropHint();
            setDropHighlight(lastTarget, false);
            // 必须在这里就设，而不是等到确认"落到某一格"之后：
            // 悬停久了再松手时，起拖时设的那 600ms 已经过期，而下面任何一次早退
            // 都会让这一轮"长按过"的事实被漏掉 —— 于是被当成一次普通点击。
            suppressClickUntil = Date.now() + 600;
            if (upEvent.type === 'pointercancel') return;
            const target = packDropTargetAt(upEvent.clientX, upEvent.clientY);
            if (!target) return;
            console.log('[drag-drop] payload:', JSON.stringify(payload),
                'target:', target ? target.kind + ':' + target.stateKey : 'null');
            if (payload.kind === 'image') {
                suppressClickUntil = Date.now() + 500;
                stateStageSession.assignImage(target.stateKey, payload.imageId)
                    .then(() => console.log('[drag] assignImage OK'))
                    .catch((err) => console.error('[drag] assignImage FAILED:', err.message || err));
                return;
            }
            const scene = resolveSceneForPayload(payload);
            if (!scene) {
                showToast(t('emoteMaker.packDropNoScene'));
                return;
            }
            // 长按拖出来的这一次不应该再被当成一次点击去选中它。
            suppressClickUntil = Date.now() + 500;
            if (target.kind === 'tile') {
                stateStageSession.assignScene(target.stateKey, scene.id);
                return;
            }
            if (target.kind === 'row') {
                state.packSceneIds[target.element.dataset.stateKey] = scene.id;
                persistExportSettings();
                renderPackPanel();
                showToast(t('emoteMaker.stageDropApplied').replace('{name}', scene.name || scene.id));
                return;
            }
            // 落在别处＝没对着任何一格：什么都不改
        };

        const cancel = () => stop({ type: 'pointercancel', clientX: 0, clientY: 0 });

        place(event.clientX, event.clientY);
        window.addEventListener('pointermove', move, true);
        window.addEventListener('pointerup', stop, true);
        window.addEventListener('pointercancel', cancel, true);
    }

    // 长按计时和光标圆环都在 NekoEmoteDragHold 里（表演台的行也要同一套手感，
    // 两边各写一份 320ms/8px 迟早会漂）。这里只负责"起拖之后做什么"。
    function armDragSource(card, payload, event) {
        const holdModule = window.NekoEmoteDragHold;
        if (!holdModule) {
            beginPackDrag(payload, { clientX: event.clientX, clientY: event.clientY }, card);
            return;
        }
        holdModule.armHold(event, {
            onComplete: (point) => beginPackDrag(payload, point, card),
        });
    }

    function attachDragSource(card, payload) {
        card.addEventListener('pointerdown', (event) => {
            if (card.disabled) return;
            armDragSource(card, payload, event);
        });
    }

    // PNGTuber 平铺模式真实存在的触发边，全部来自运行时源码；这些数字是写死的常量，
    // 所以这里只**标注**、不开放编辑 —— 给一个改了没用的旋钮比不给更糟。

    const NODE_GRAPH_KEY = 'neko-emote-maker-node-graph';

    function loadNodeGraph() {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(NODE_GRAPH_KEY) || 'null');
        } catch (_) {
            saved = null;
        }
        const model = window.NekoEmoteNodeGraph;
        if (!model || !saved) return;
        state.nodeGraph = model.normalizeGraph(saved);
        // 旧图里可能有重复槽位：界面上报"跟随默认"、烘包却用了另一条动作。
        // 归一化时已经收成一条，这里要落盘并说一声，不能悄悄改人存好的设置。
        const collapsed = (state.nodeGraph.dropped || []).length;
        if (collapsed) {
            persistNodeGraph();
            showToast(`${t('emoteMaker.packPlanDuplicate')} (${collapsed}) · ${t('emoteMaker.graphCollapsedNotice')}`);
        }
    }

    function persistNodeGraph() {
        try {
            localStorage.setItem(NODE_GRAPH_KEY, JSON.stringify(state.nodeGraph));
        } catch (_) {
            // 存不下不影响导出走面板回落。
        }
    }


    function currentLookDefaults() {
        return {
            sceneId: state.selectedSceneId || '',
            skins: (state.templateSkins || []).map((item) => ({ ...item })),
            sliders: (state.templateSliders || []).map((item) => ({ ...item })),
            slots: (state.templateSlots || []).map((item) => ({ ...item })),
            texts: [],
            transform: {
                x: Number(state.adjustments?.x) || 0,
                y: Number(state.adjustments?.y) || 0,
                // 旋转角度也要带走：取景要能还原"我调成什么样"，少一项就少一项
                rotation: Number(state.adjustments?.rotation) || 0,
                scale: (Number(state.adjustments?.scale) || 100) / 100,
                mirror: false,
            },
        };
    }

    // ── 状态表演台 ────────────────────────────────────────────────────────────
    // 预览采集比导出便宜得多：低 fps、小边长、帧数封顶。秒数是唯一的真值，
    // 帧号由 delayMs 反算，所以预览的采样率和导出不一致也不会骗人。
    // 舞台上的清晰度由这一档决定：176 铺到 ~500px 的台面上必然糊。
    const STAGE_QUALITY = {
        // 悬停一眼：宁可先动起来也不等，帧数少、边长小
        poster: { fps: 8, edge: 232, maxFrames: 14 },
        // 真正选中那一格：要能看清细节，也要够铺满时间轴
        full: { fps: 12, edge: 420, maxFrames: 48 },
        // 选择器里的缩略图：只要一张小图。之前它走的是 full 档，
        // 展开一次等于把所有动画整条重采一遍，卡就卡在这里。
        thumb: { fps: 1, edge: 96, maxFrames: 1 },
    };
    const STAGE_ROOT_PREFIX = 'root:';
    const STAGE_CAPTURE_INTERACTIVE = 10;
    const STAGE_CAPTURE_THUMB = 1;
    // 表演台预览帧率：时间轴刻度和"一帧多长"都靠它，太高浪费、太低不流畅
    const STAGE_PREVIEW_FPS = 10;
    const stageFramesBySource = new Map();   // `${源}|${档位}` -> frame[]
    const stageThumbs = new Map();           // sceneId -> dataURL
    // 用户图片：id -> { name, dataUrl }。字节随副本走（StageImages/ 合并进贴图管线），
    // 内存里只留 dataURL 供预览与帧绘制；导出/清库跟模板副本同生共死。
    const stageUserImages = new Map();
    let stageUserImagesRestored = false;
    // 原始文件名随 localStorage 走：副本管线只收 .png 字节，id 又是时间戳
    // （CJK 文件名进 id 会被洗成横杠），名字必须单独记。单键 { id: name }。
    const STAGE_IMAGE_NAMES_KEY = 'neko-emote-maker-stage-image-names';

    function loadStageImageNames() {
        try {
            const saved = JSON.parse(localStorage.getItem(STAGE_IMAGE_NAMES_KEY) || '{}');
            return saved && typeof saved === 'object' ? saved : {};
        } catch (_) {
            return {};
        }
    }

    function rememberStageImageName(id, name) {
        const names = loadStageImageNames();
        names[id] = String(name || '').trim() || id;
        try {
            localStorage.setItem(STAGE_IMAGE_NAMES_KEY, JSON.stringify(names));
        } catch (_) { /* 存不下就退回 id 当名字 */ }
    }

    function forgetStageImageName(id) {
        const names = loadStageImageNames();
        if (!(id in names)) return;
        delete names[id];
        try {
            localStorage.setItem(STAGE_IMAGE_NAMES_KEY, JSON.stringify(names));
        } catch (_) { /* 同上 */ }
    }
    const stagePending = new Map();          // 队列键 -> Promise（同一份不重复排）
    /**
     * 所有采集排队串行跑。bakePackJobs 会暂停渲染器、改 state.selectedSceneId、
     * 结束时还原——并发调用不但抢主线程，还会互相踩场景（缩略图全变成同一条动画）。
     * 交互请求（选中/悬停）排在缩略图前面，缩略图可以在选择器收起时被丢掉。
     */
    const stageQueue = [];
    let stageQueueRunning = false;
    let stagePersistTimer = 0;

    function queueStageCapture(key, priority, kind, task) {
        if (stagePending.has(key)) {
            // 已经在队里的任务可以提优先级：抽屉一开会排进几百条缩略图，
            // 右侧状态行那八条要是排在长队末尾，就一直是空白。
            const queued = stageQueue.find((entry) => entry.key === key);
            if (queued && priority > queued.priority) {
                queued.priority = priority;
                if (queued.kind === 'thumb') queued.kind = kind;
            }
            return stagePending.get(key);
        }
        let settle = null;
        const promise = new Promise((resolve, reject) => { settle = { resolve, reject }; });
        stageQueue.push({ key, priority, kind, task, resolve: settle.resolve, reject: settle.reject });
        stagePending.set(key, promise);
        // 队列自己消化异常（失败就不缓存，下次重试），这里只负责让 promise 被处理过
        promise.catch(() => []).then(() => stagePending.delete(key));
        drainStageQueue();
        return promise;
    }

    async function drainStageQueue() {
        if (stageQueueRunning) return;
        stageQueueRunning = true;
        try {
            while (stageQueue.length) {
                stageQueue.sort((a, b) => b.priority - a.priority);
                const job = stageQueue.shift();
                try {
                    job.resolve(await job.task());
                } catch (error) {
                    job.reject(error);
                }
            }
        } finally {
            stageQueueRunning = false;
        }
    }

    /** 选择器收起：还没跑到的缩略图直接丢掉，别继续占着渲染器。*/
    function dropQueuedThumbs() {
        for (let i = stageQueue.length - 1; i >= 0; i -= 1) {
            if (stageQueue[i].kind === 'thumb') {
                const dropped = stageQueue.splice(i, 1)[0];
                stagePending.delete(dropped.key);
                dropped.resolve('');
            }
        }
    }

    function forgetStageFrames() {
        stageFramesBySource.clear();
        stageThumbs.clear();
        stagePending.clear();
    }

    // 动画列表一旦变了（换包、重导入、改名），按 sceneId 存的缓存就是别的包的画面。
    // 用签名自查比在每个改动点插一句可靠——漏一处就是"预览看着对、烘出来是空的"。
    let stageSceneSignature = '';
    function syncStageSceneCache() {
        const signature = getImportedScenes().map((scene) => `${scene.id}|${scene.name || ''}`).join(',');
        if (signature !== stageSceneSignature) {
            stageSceneSignature = signature;
            forgetStageFrames();
        }
    }

    function stageGraph() {
        return (stateStageSession && stateStageSession.getGraph())
            || state.nodeGraph
            || basicGraph();
    }

    /** 采一帧源的某一档。同一 sceneId 的不同档位分开缓存，海报不会污染清晰视图。*/
    // ── 用户图片：导入、持久化、恢复 ─────────────────────────────────────
    // 图片走本地副本的贴图管线（StageImages/ 合并进副本），随模板同生共死；
    // 不进场景清单，帧源用 image:<id> 前缀与场景区分。
    const STAGE_IMAGE_PREFIX = 'StageImages/';

    function stageImageId(name) {
        return `img-${String(name || 'image').replace(/[^\w.-]+/g, '-').toLowerCase()}-${Date.now().toString(36)}`;
    }

    function dataUrlToBlob(dataUrl) {
        const [head, body] = String(dataUrl).split(',');
        const mime = /:(.*?);/.exec(head)[1] || 'image/png';
        const binary = atob(body);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    }

    async function persistStageImages(entries) {
        if (!entries.length) return;
        const form = new FormData();
        entries.forEach(([id, image]) => {
            const blob = dataUrlToBlob(image.dataUrl);
            form.append('textures', blob, `${id}.png`);
            form.append('texture_paths', `${STAGE_IMAGE_PREFIX}${id}.png`);
        });
        const key = currentTemplateKey();
        if (!key) return;
        const response = await fetch(
            `/api/emote-maker/library/textures?key=${encodeURIComponent(key)}`,
            { method: 'POST', body: form, credentials: 'same-origin' },
        );
        if (!response.ok) throw new Error('stage-image-persist-failed');
    }

    async function importStageImages(files) {
        const images = Array.from(files || []).filter(
            (file) => /\.png$/i.test(file.name || ''),
        );
        if (!images.length) {
            showToast(t('emoteMaker.stageImagesPngOnly'));
            return;
        }
        const persisted = [];
        for (const file of images) {
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => reject(reader.error);
                reader.readAsDataURL(file);
            });
            const id = stageImageId(file.name);
            stageUserImages.set(id, { name: file.name, dataUrl });
            rememberStageImageName(id, file.name);
            persisted.push([id, stageUserImages.get(id)]);
        }
        try {
            await persistStageImages(persisted);
        } catch (_) {
            showToast(t('emoteMaker.stageImagesSaveFailed'));
        }
        pushStageUserImages();
        if (stateStageSession?.refreshUserImages) stateStageSession.refreshUserImages();
        showToast(interpolate(t('emoteMaker.stageImagesImported'), { count: images.length }));
    }

    async function restoreStageImages() {
        if (stageUserImagesRestored || !currentTemplateKey()) return;
        stageUserImagesRestored = true;
        try {
            const listResponse = await fetch('/api/emote-maker/library/textures'
                + `?key=${encodeURIComponent(currentTemplateKey())}`,
            { credentials: 'same-origin' });
            const list = await listResponse.json();
            const paths = (list.paths || []).filter(
                (path) => String(path).indexOf(STAGE_IMAGE_PREFIX) === 0);
            for (const path of paths) {
                const id = path.slice(STAGE_IMAGE_PREFIX.length).replace(/\.png$/i, '');
                const response = await fetch('/api/emote-maker/library/texture'
                    + `?key=${encodeURIComponent(currentTemplateKey())}&path=${encodeURIComponent(path)}`,
                { credentials: 'same-origin' });
                if (!response.ok) continue;
                const blob = await response.blob();
                const dataUrl = await new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result || ''));
                    reader.onerror = () => resolve('');
                    reader.readAsDataURL(blob);
                });
                const names = loadStageImageNames();
                if (dataUrl) stageUserImages.set(
                    id, { name: names[id] || id, dataUrl });
            }
            if (paths.length) {
                pushStageUserImages();
                // 恢复晚于抽屉渲染完成：不主动刷一次，绑图格子会一直停在
                // "跟随默认"，直到用户点了别的什么才被连带重绘
                if (stateStageSession?.refreshUserImages) {
                    stateStageSession.refreshUserImages();
                }
            }
        } catch (_) {
            stageUserImagesRestored = false;   // 拉取失败下次再试
        }
    }

    /** 把内存清单推给舞台模块（冻结对象的方法照常可调）。 */
    function pushStageUserImages() {
        const stageModule = window.NekoEmoteStateStage;
        if (!stageModule || typeof stageModule.setUserImages !== 'function') return;
        stageModule.setUserImages([...stageUserImages.entries()].map(([id, image]) => ({
            id, label: image.name, thumb: image.dataUrl,
        })));
    }

    /** 用户图片 → 单帧（按导出边长画到画布中央，透明背景）。 */
    function frameFromStageImage(image, edge) {
        return new Promise((resolve) => {
            const imageEl = new Image();
            imageEl.onload = () => {
                const size = Math.max(1, edge || 512);
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d');
                const scale = Math.min(size / imageEl.width, size / imageEl.height) || 1;
                const width = imageEl.width * scale;
                const height = imageEl.height * scale;
                ctx.drawImage(imageEl, (size - width) / 2, (size - height) / 2, width, height);
                const data = ctx.getImageData(0, 0, size, size);
                resolve([{ width: size, height: size, data: data.data }]);
            };
            imageEl.onerror = () => resolve([]);
            imageEl.src = image.dataUrl;
        });
    }

    function captureStageSource(sourceKey, quality, priorityOverride, windowOverride) {
        const budget = STAGE_QUALITY[quality] || STAGE_QUALITY.full;
        const priority = Number(priorityOverride) > 0
            ? Number(priorityOverride)
            : (quality === 'thumb' ? STAGE_CAPTURE_THUMB : STAGE_CAPTURE_INTERACTIVE);
        // 同一源不同起点是不同的采集：队列键带上起点，缓存才不会互串
        const startAt = Math.max(0, Number(windowOverride && windowOverride.startAt) || 0);
        const captureKey = startAt > 0
            ? `${sourceKey}|${quality}@${startAt}` : `${sourceKey}|${quality}`;
        return queueStageCapture(captureKey,
            priority,
            priority >= STAGE_CAPTURE_INTERACTIVE ? 'frames' : 'thumb',
            async () => {
                // 用户图片：单帧源，不过 Spine 采集管线。images: 是轮播
                // 列表（按序每张一帧）；image: 是旧的单图键，照旧认。
                const captureKey = String(sourceKey || '');
                if (captureKey.indexOf('images:') === 0) {
                    const frames = [];
                    for (const id of captureKey.slice('images:'.length).split('|')) {
                        if (!id) continue;
                        const image = stageUserImages.get(id);
                        if (!image) continue;
                        const one = await frameFromStageImage(image, budget.edge);
                        if (one.length) frames.push(one[0]);
                    }
                    return frames;
                }
                if (captureKey.indexOf('image:') === 0) {
                    const image = stageUserImages.get(captureKey.slice('image:'.length));
                    if (!image) return [];
                    return frameFromStageImage(image, budget.edge);
                }
                const resolved = await resolveStageSource(sourceKey);
                if (!resolved) return [];
                const { scene, look } = resolved;
                const duration = Math.max(0.05,
                    Number(getImportedAnimationDuration(scene.animation?.id)) || 0.05);
                const frames = Math.max(1,
                    Math.min(budget.maxFrames, Math.ceil(duration * budget.fps)));
                const baked = await bakePackJobs(
                    [{ stateKey: 'preview', sceneId: scene.id, look, frames,
                        timeWindow: startAt > 0
                            ? { from: startAt, to: startAt + 1 / budget.fps }
                            : undefined }],
                    { fps: budget.fps, edge: budget.edge },
                );
                return baked[0] ? baked[0].frames : [];
            });
    }

    /**
     * 把"要看的源"翻译成（场景, 外观）。
     * `root:<stateKey>` = 这一格跟随默认外观，得从图里把它的 look 算出来；
     * 其余就是动画 id，外观沿用上游标签页定好的那套。
     */
    async function resolveStageSource(sourceKey) {
        const key = String(sourceKey || '');
        const model = window.NekoEmoteNodeGraph;
        const graph = stageGraph();
        if (!model || !graph || !hasSpineRenderer() || packBusy) return null;
        let sceneId = key;
        let look = { ...currentLookDefaults(), sceneId };
        if (key.indexOf(STAGE_ROOT_PREFIX) === 0) {
            const stateKey = key.slice(STAGE_ROOT_PREFIX.length);
            const evaluated = model.evaluate(graph, currentLookDefaults());
            const output = evaluated.outputs.find((item) => item.stateKey === stateKey);
            if (!output) return null;
            look = output.look;
            sceneId = look.sceneId;
        }
        const scene = getImportedScenes().find((item) => item.id === sceneId);
        return scene ? { scene, look } : null;
    }

    async function stageFramesFor(sourceKey, quality) {
        syncStageSceneCache();
        const key = `${String(sourceKey || '')}|${quality || 'full'}`;
        if (stageFramesBySource.has(key)) return stageFramesBySource.get(key);
        const result = await captureStageSource(String(sourceKey || ''), quality || 'full');
        // 采集失败/场景没了时不要缓存空表，否则切回来永远是空的
        if (result.length) stageFramesBySource.set(key, result);
        return result;
    }

    /**
     * 一条动画的 96px 单帧缩略图。走 thumb 档（1 帧、不碰整条动画）。
     * hot=true 是给右侧状态行用的：那八条要排在抽屉的缩略图长队前面，
     * 否则抽屉一开，状态行就长时间是空白。
     * opts.startAt：状态格的缩略图要采这一格起始手柄指向的那一帧——
     * 同一条动画不同起点采出来的样子不一样，缓存键按起点拆开。
     */
    async function stageThumbFor(sceneId, hot, opts) {
        const startAt = Math.max(0, Number(opts && opts.startAt) || 0);
        const key = startAt > 0 ? `${String(sceneId)}@${startAt}` : String(sceneId || '');
        if (stageThumbs.has(key)) return stageThumbs.get(key);
        const frames = await captureStageSource(
            String(sceneId || ''), 'thumb',
            hot ? STAGE_CAPTURE_INTERACTIVE : STAGE_CAPTURE_THUMB,
            startAt > 0 ? { startAt } : undefined);
        const first = frames[0];
        if (!first) return '';
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, first.width | 0);
        canvas.height = Math.max(1, first.height | 0);
        const data = first.data instanceof Uint8ClampedArray
            ? first.data : new Uint8ClampedArray(first.data);
        canvas.getContext('2d').putImageData(new ImageData(data, canvas.width, canvas.height), 0, 0);
        const url = canvas.toDataURL('image/png');
        stageThumbs.set(key, url);
        return url;
    }

    function openStateStage() {
        void restoreStageImages();   // 副本里的图片先拉回来（异步不阻塞打开）
        pushStageUserImages();       // 把当前清单推给舞台模块
        const stageModule = window.NekoEmoteStateStage;
        const model = window.NekoEmoteNodeGraph;
        if (!stageModule || !model) {
            showToast(t('emoteMaker.stageUnavailable'));
            return;
        }
        if (!hasSpineRenderer() || !getImportedScenes().length) {
            showToast(t('emoteMaker.packNeedsTemplate'));
            return;
        }
        if (stateStageSession) stateStageSession.dispose();
        if (!state.nodeGraph) state.nodeGraph = model.normalizeGraph(basicGraph());
        forgetStageFrames();
        stateStageSession = stageModule.create({
            model,
            graph: state.nodeGraph,
            t,
            fps: () => STAGE_PREVIEW_FPS,
            format: () => state.packFormat,
            framesFor: stageFramesFor,
            thumbFor: stageThumbFor,
            onPickerClose: dropQueuedThumbs,
            // 抽屉里的动作长按拖出来，走和动画列表完全同一套投递机制
            // 表演台的行自己已经用 NekoEmoteDragHold 计好长按了，这里只管起拖；
            // sourceElement 传回去，ghost 才能长成那张选项卡的样子。
            beginDrag: (payload, event, sourceElement) => beginPackDrag(payload, event, sourceElement),
            animationsFor: () => getImportedScenes().map((scene) => ({
                value: scene.id,
                label: scene.name || scene.animation?.id || scene.id,
            })),
            onImportImages: () => { void restoreStageImages().then(() => stageImageInput?.click()); },
            onRemoveImage: (imageId) => {
                stageUserImages.delete(imageId);
                forgetStageImageName(imageId);
                pushStageUserImages();
                if (stateStageSession?.refreshUserImages) stateStageSession.refreshUserImages();
                // 副本上的文件也真删：不然每次打开表演台 restore 又拉回来
                const key = currentTemplateKey();
                if (!key) return;
                const form = new FormData();
                form.append('texture_paths', `${STAGE_IMAGE_PREFIX}${imageId}.png`);
                fetch(`/api/emote-maker/library/textures/remove?key=${encodeURIComponent(key)}`,
                    { method: 'POST', body: form, credentials: 'same-origin' });
            },
            onChange: (next) => {
                state.nodeGraph = next;
                state.packMode = 'graph';
                // 拖动时每帧都会回调，落盘必须合并成一次
                window.clearTimeout(stagePersistTimer);
                stagePersistTimer = window.setTimeout(() => {
                    persistNodeGraph();
                    persistLayout();
                }, 250);
            },
            onClose: () => {
                if (stateStageSession) stateStageSession.dispose();
                stateStageSession = null;
                window.clearTimeout(stagePersistTimer);
                persistNodeGraph();
                persistLayout();
                renderPackPanel();
            },
        });
        renderPackPanel();
    }

    // 把图算出来的 look 写进 state，让现有的场景套用与 overlay 渲染原样画出来。
    function applyLookToState(look) {
        state.selectedSceneId = look.sceneId || state.selectedSceneId;
        state.templateSkins = look.skins.map((item) => ({ ...item }));
        state.templateSliders = look.sliders.map((item) => ({ ...item }));
        state.templateSlots = look.slots.map((item) => ({ ...item }));
        state.adjustments = {
            x: look.transform.x,
            y: look.transform.y,
            // 原来这里硬写 0：套一个取景会把旋转悄悄抹平，取景就白存了
            rotation: Number(look.transform.rotation) || 0,
            scale: Math.round(look.transform.scale * 100),
        };
    }




    // ── 上次打开的模板：只记元数据，不记素材字节 ─────────────────────────────
    // 浏览器不会把上一次选过的文件留给下一次，而"缓存这个包"与 assetPolicy
    // (local-import-and-render-only) 冲突，所以这里只存到足以一键重开+恢复编辑
    // 状态的程度：指纹、名字、导入方式、选中的场景、皮肤/滑杆/色组、调整与映射。
    const LAST_TEMPLATE_KEY = 'neko-emote-maker-last-template';
    let lastTemplate = null;

    function templateFingerprint(pkg) {
        if (!pkg) return '';
        const counts = pkg.counts || {};
        return [
            pkg.source?.packageName || '',
            pkg.source?.sharedModelKey || pkg.model?.id || '',
            String(counts.scenes ?? ''),
            String(counts.animations ?? ''),
        ].join('::');
    }

    function snapshotTemplateSession() {
        if (!templatePackage) return null;
        const pick = (list) => (Array.isArray(list) ? list.map((item) => ({ ...item })) : []);
        return {
            schemaVersion: 1,
            fingerprint: templateFingerprint(templatePackage),
            packageName: templatePackage.source?.packageName || '',
            displayName: templatePackage.model?.displayName || '',
            importKind: lastImportKind,
            sceneId: state.selectedSceneId || '',
            sceneListFilter: state.sceneListFilter || '',
            groupId: state.groupId || '',
            groups: (Array.isArray(state.groups) ? state.groups : []).map((group) => ({ ...group })),
            shots: (Array.isArray(state.shots) ? state.shots : []).map((shot) => ({ ...shot })),
            packSceneIds: { ...(state.packSceneIds || {}) },
            character: {
                skins: pick(state.templateSkins),
                sliders: pick(state.templateSliders),
                slots: pick(state.templateSlots),
            },
            adjustments: { ...state.adjustments },
            adjustOverwrite: state.adjustOverwrite,
            colorMode: state.colorMode,
            secondaryColor: state.secondaryColor,
        };
    }

    function persistTemplateSession() {
        const snapshot = snapshotTemplateSession();
        if (!snapshot) return;
        lastTemplate = snapshot;
        try {
            localStorage.setItem(LAST_TEMPLATE_KEY, JSON.stringify(snapshot));
        } catch (_) {
            // 存不下只影响"下次还记得"，不影响当前会话。
        }
    }

    function loadTemplateSession() {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(LAST_TEMPLATE_KEY) || 'null');
        } catch (_) {
            saved = null;
        }
        lastTemplate = saved && saved.schemaVersion === 1 && saved.fingerprint ? saved : null;
        // 快照里有 importKind，但 lastImportKind 是模块变量：不回填的话，老条目
        // （还没有本地副本的那种）退回重新定位时会弹错选择器。
        if (lastTemplate) lastImportKind = lastTemplate.importKind === 'file' ? 'file' : 'directory';
    }

    function currentTemplateKey() {
        if (!templateLibraryModule || !templatePackage) return '';
        return templateLibraryModule.entryKeyFor(templatePackage);
    }

    /**
     * 当前模板的显示名：库条目在就用库的裁决（用户改名 > 来源名 > 包名 > 自报名），
     * 库还没提交（导入的同一拍）就按同一条链就地算一遍 —— 两处顺序不能反，
     * 否则标题会比卡片晚一拍才对上。
     */
    function currentTemplateLabel() {
        if (!templateLibraryModule || !templatePackage) return '';
        const entry = templateLibraryModule.find(templateLibraryState, currentTemplateKey());
        if (entry) return templateLibraryModule.entryLabel(entry);
        const pkgName = String(templatePackage.source?.packageName || '')
            .replace(/\.zip$/i, '');
        return pkgName && pkgName !== 'template-directory'
            ? pkgName
            : (templatePackage.model?.displayName || '');
    }

    /** 注册表里还活着的 store 不能释放：清字节是不可逆的，切回去就得重新读盘。 */
    function holdsTemplateStore(store) {
        if (!store) return false;
        for (const held of loadedTemplates.values()) {
            if (held.store === store) return true;
        }
        return false;
    }

    function rememberLoadedTemplate() {
        const key = currentTemplateKey();
        if (!key || !templateAssetStore) return '';
        loadedTemplates.set(key, {
            pkg: templatePackage,
            store: templateAssetStore,
            textureFiles: Array.isArray(textureCacheFiles) ? [...textureCacheFiles] : [],
        });
        return key;
    }

    // 96px 的 PNG，只用来"认脸"。取不到（画布还没画过、跨域像素）就留空，
    // 库里那条会继续用上一次存的缩略图。
    function templateThumbDataUrl() {
        if (!canvas || !templatePackage) return '';
        try {
            const box = document.createElement('canvas');
            box.width = 96;
            box.height = 96;
            const ctx = box.getContext('2d');
            ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, 96, 96);
            const url = box.toDataURL('image/png');
            return typeof url === 'string' && url.startsWith('data:image/png') ? url : '';
        } catch (_) {
            return '';
        }
    }

    function persistTemplateToLibrary({ withThumb = false, sourceName = '' } = {}) {
        if (!templateLibraryModule || !templatePackage) return;
        const key = currentTemplateKey();
        const snapshot = key ? snapshotTemplateSession() : null;
        if (!snapshot) return;
        // 这些是"每个模板各一份"的绑定与导出选择，全局那份只是当前模板的镜像
        snapshot.nodeGraph = state.nodeGraph || null;
        snapshot.packName = state.packName || '';
        snapshot.packFormat = state.packFormat === 'layered' ? 'layered' : 'flat';
        snapshot.packPriority = state.packPriority === 'emotion' ? 'emotion' : 'talking';
        const existing = templateLibraryModule.find(templateLibraryState, key);
        const thumb = withThumb ? templateThumbDataUrl() : '';
        try {
            let next = templateLibraryModule.upsert(templateLibraryState, templateLibraryModule.makeEntry({
                key,
                pkg: templatePackage,
                importKind: lastImportKind,
                // 来源名：这次导入带来了就用这次的（目录改名后再导一次，名字跟着走），
                // 没带来（切回/重绘触发的保存）沿用库里那份。alias 只有双击改名才写，
                // 这里永远沿用，别把用户改的名冲掉
                sourceName: sourceName || (existing && existing.sourceName) || '',
                alias: (existing && existing.alias) || '',
                thumb: thumb || (existing && existing.thumb) || '',
                addedAt: existing && existing.addedAt,
                session: {
                    ...(existing && existing.session ? existing.session : {}),
                    ...snapshot,
                },
            }));
            next = templateLibraryModule.touch(next, key);
            templateLibraryState = next;
            templateLibraryModule.save(localStorage, templateLibraryState);
        } catch (_) {
            // 存不下只影响"下次库里还认得它"，不影响当前编辑。
        }
    }

    function loadTemplateLibrary() {
        if (!templateLibraryModule) return;
        templateLibraryState = templateLibraryModule.load(localStorage);
        if (!templateLibraryState.entries.length && lastTemplate) {
            const migrated = templateLibraryModule.migrateFromLegacy(lastTemplate, localStorage);
            if (migrated) {
                templateLibraryState = migrated;
                try {
                    templateLibraryModule.save(localStorage, templateLibraryState);
                } catch (_) { /* 同上 */ }
            }
        }
    }

    // ── 导入即拷副本 ──────────────────────────────────────────────────────────
    // 导入成功后把整份 zip（连附带贴图）拷进应用数据目录，重开直接从副本恢复。
    // 副本即唯一事实：原件更新/删除/挪走都与这里无关，想更新就再导一次（同键原地覆盖）。
    // 后端没有这套接口时一切照旧：存副本失败提示一句，重开退回"请重新定位"。
    const TEMPLATE_LIBRARY_API = '/api/emote-maker/library';
    let templateArchiveBytes = new Map();
    let templateArchiveTotalBytes = 0;

    function formatTemplateBytes(bytes) {
        return templateLibraryModule && typeof templateLibraryModule.formatBytes === 'function'
            ? templateLibraryModule.formatBytes(bytes) : '';
    }

    async function refreshTemplateArchiveSizes() {
        try {
            const response = await fetch(TEMPLATE_LIBRARY_API, { credentials: 'same-origin' });
            const payload = await response.json();
            if (!response.ok || !payload.success || !Array.isArray(payload.entries)) return;
            const next = new Map(payload.entries.map((entry) => [
                String(entry.key), Number(entry.bytes) || 0,
            ]));
            const nextTotal = Number(payload.totalBytes) || 0;
            const same = nextTotal === templateArchiveTotalBytes
                && next.size === templateArchiveBytes.size
                && [...next].every(([key, bytes]) => templateArchiveBytes.get(key) === bytes);
            if (same) return;
            templateArchiveBytes = next;
            templateArchiveTotalBytes = nextTotal;
            renderTemplateLibraryGrid();
        } catch (_) {
            // 占用显示拿不到就先不显示，不影响任何功能
        }
    }

    function archiveTextureForm(textureFiles) {
        const form = new FormData();
        (textureFiles || []).forEach((texture) => {
            form.append('textures', texture, texture.name || 'texture.png');
            form.append('texture_paths', texture.webkitRelativePath || texture.name || '');
        });
        return form;
    }

    /** 把刚导入的模板拷一份到应用数据目录。失败要说话：用户以为下次还能免定位。 */
    async function persistTemplateArchive(key, file, textureFiles) {
        const form = archiveTextureForm(textureFiles);
        // 文件名必须原样带过去：副本要靠它恢复出同一个库身份
        form.append('file', file, file.name || 'template.zip');
        const response = await fetch(
            `${TEMPLATE_LIBRARY_API}/archive?key=${encodeURIComponent(key)}`,
            { method: 'POST', body: form, credentials: 'same-origin' },
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.success) throw new Error(payload.error || 'archive-failed');
        await refreshTemplateArchiveSizes();
    }

    /** 导入之后才补的贴图单独合并进副本：不然重开一次就丢，正是副本要消掉的痛点。 */


    async function fetchArchiveTextureFiles(key) {
        const listResponse = await fetch(
            `${TEMPLATE_LIBRARY_API}/textures?key=${encodeURIComponent(key)}`,
            { credentials: 'same-origin' },
        );
        const listPayload = await listResponse.json().catch(() => null);
        if (!listResponse.ok || !listPayload?.success) return [];
        const paths = Array.isArray(listPayload.paths) ? listPayload.paths : [];
        return Promise.all(paths.map(async (path) => {
            const response = await fetch(`${TEMPLATE_LIBRARY_API}/texture`
                + `?key=${encodeURIComponent(key)}&path=${encodeURIComponent(path)}`,
            { credentials: 'same-origin' });
            if (!response.ok) throw new Error(`texture-missing:${path}`);
            const blob = await response.blob();
            const file = new File([blob], String(path).split('/').pop() || 'texture.png',
                { type: 'image/png' });
            // 覆盖层按相对路径精确匹配；构造出来的 File 自带 webkitRelativePath 是空串
            Object.defineProperty(file, 'webkitRelativePath', { value: String(path) });
            return file;
        }));
    }

    /**
     * 从本地副本把一个模板装回来。没有副本 / 副本拉不下来 → false，
     * 调用方再走原来的"请重新定位"。老库条目第一次被点开时走的就是这条路：
     * 重新定位导入完成后副本自然就有了（迁移不需要专门代码）。
     */
    async function tryRestoreTemplateFromArchive(key) {
        if (!key || !templateLibraryModule) return false;
        const entry = templateLibraryModule.find(templateLibraryState, key);
        try {
            const [archiveResponse, textureFiles] = await Promise.all([
                fetch(`${TEMPLATE_LIBRARY_API}/archive?key=${encodeURIComponent(key)}`,
                    { credentials: 'same-origin' }),
                fetchArchiveTextureFiles(key).catch(() => []),
            ]);
            if (!archiveResponse.ok) return false;
            const blob = await archiveResponse.blob();
            // 副本记着当初的文件名，必须原样还给 File：库键的第一段就是它
            // （adapter 拿上传文件名当 packageName），起个新名字等于把同一个模板
            // 分裂成两个库身份，旧条目的会话与组就全丢了。
            const rawName = archiveResponse.headers.get('X-Archive-Filename') || '';
            const fileName = rawName ? decodeURIComponent(rawName) : 'template.zip';
            const file = new File([blob], fileName, { type: 'application/zip' });
            return await importTemplateFile(file, {
                displayName: templateLibraryModule.entryLabel(entry) || '',
                textureFiles,
                kind: entry?.importKind === 'directory' ? 'directory' : 'file',
                fromArchive: true,
            });
        } catch (_) {
            return false;
        }
    }

    /** 删副本，返回真实释放的字节数。失败返回 0：库条目照删，磁盘上那份留着也无害。 */
    async function deleteTemplateArchive(key) {
        if (!key) return 0;
        try {
            const response = await fetch(
                `${TEMPLATE_LIBRARY_API}?key=${encodeURIComponent(key)}`,
                { method: 'DELETE', credentials: 'same-origin' },
            );
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || !payload.success) return 0;
            await refreshTemplateArchiveSizes();
            return Number(payload.freedBytes) || 0;
        } catch (_) {
            return 0;
        }
    }

    /**
     * 从内存注册表把某个模板装回来：不读盘、不请求后端、不重新解析场景。
     * 会话恢复复用 applyTemplateSession —— 它按"指纹对不对得上"决定要不要套皮肤/滑杆，
     * 那套校验（只接受仍然存在的槽位名等）不该在库里再写第二份。
     */
    function applyTemplateFromRegistry(key) {
        const held = loadedTemplates.get(key);
        const entry = templateLibraryModule
            ? templateLibraryModule.find(templateLibraryState, key) : null;
        if (!held || !entry) return false;
        persistTemplateToLibrary();
        spineRendererGeneration += 1;
        disposeSpineRenderer();
        templatePackage = held.pkg;
        templateAssetStore = held.store;
        textureCacheFiles = [...held.textureFiles];
        lastImportKind = entry.importKind === 'file' ? 'file' : 'directory';
        lastTemplate = {
            ...entry.session,
            fingerprint: templateFingerprint(held.pkg),
        };
        applyTemplateSession(held.pkg);
        if (!state.groupId) {
            const first = allGroups()[0];
            if (first) selectGroup(first.id);
        }
        if (entry.session.packName) state.packName = entry.session.packName;
        state.packFormat = entry.session.packFormat === 'layered' ? 'layered' : 'flat';
        state.packPriority = entry.session.packPriority === 'emotion' ? 'emotion' : 'talking';
        const restored = Object.keys(entry.session.packSceneIds || {}).length
            ? entry.session.packSceneIds : state.packSceneIds;
        state.packSceneIds = { ...(restored || {}) };
        if (entry.session.nodeGraph) {
            state.nodeGraph = window.NekoEmoteNodeGraph
                ? window.NekoEmoteNodeGraph.normalizeGraph(entry.session.nodeGraph)
                : entry.session.nodeGraph;
            persistNodeGraph();
        }
        const firstScene = getImportedScenes()[0];
        if (firstScene && !getImportedScenes().some((scene) => scene.id === state.selectedSceneId)) {
            state.selectedSceneId = firstScene.id;
            state.animationId = firstScene.animation?.id || '';
        }
        history.length = 0;
        future.length = 0;
        templateLibraryState = templateLibraryModule.touch(templateLibraryState, key);
        templateLibraryModule.save(localStorage, templateLibraryState);
        renderAll();
        void activateNativeSpineRenderer();
        return true;
    }

    /**
     * 切到库里的另一个模板。内存里没有它（重启过、或那次导入的 store 已释放），
     * 就借现有导入流程请用户重新定位一次：落到同一个指纹上，库里那条会被就地补齐，
     * 不会多出第二条。
     */
    async function switchTemplate(key) {
        if (!templateLibraryModule || !key || packBusy) return;
        if (key === currentTemplateKey()) return;
        if (applyTemplateFromRegistry(key)) {
            showToast(t('emoteMaker.templateSwitched'));
            return;
        }
        const entry = templateLibraryModule.find(templateLibraryState, key);
        persistTemplateToLibrary();
        // 内存里没有（重启过）就先试本地副本：有副本就不该再让用户去认一遍路径。
        // 旧条目第一次没有副本，走完重新定位导入后副本自然就有了。
        if (await tryRestoreTemplateFromArchive(key)) {
            showToast(t('emoteMaker.templateSwitched'));
            return;
        }
        if (entry && entry.importKind === 'directory' && window.nekoHost
            && typeof window.nekoHost.pickTemplateDirectory === 'function') {
            await importTemplateDirectoryFromHost();
        } else {
            templateFileInput?.click();
        }
    }

    /** 页内确认框：window.confirm 的默认样式和这一页毫不相干，插值也归这里管。 */
    function confirmModal(text) {
        return new Promise((resolve) => {
            const box = $('#emote-confirm');
            if (!box) {
                resolve(window.confirm(text));
                return;
            }
            $('#emote-confirm-text').textContent = text;
            box.hidden = false;
            const ok = $('#emote-confirm-ok');
            const cancel = $('#emote-confirm-cancel');
            const done = (value) => {
                box.hidden = true;
                ok.removeEventListener('click', onOk);
                cancel.removeEventListener('click', onCancel);
                document.removeEventListener('keydown', onKey, true);
                resolve(value);
            };
            const onOk = () => done(true);
            const onCancel = () => done(false);
            const onKey = (event) => {
                if (event.key === 'Escape') {
                    event.stopPropagation();
                    done(false);
                } else if (event.key === 'Enter') {
                    event.stopPropagation();
                    done(true);
                }
            };
            ok.addEventListener('click', onOk);
            cancel.addEventListener('click', onCancel);
            document.addEventListener('keydown', onKey, true);
            ok.focus();
        });
    }

    async function removeTemplate(key) {
        if (!templateLibraryModule || !key) return;
        // 删的是用户攒的模板 + 它的本地副本，得先问一句；名字用卡片上那个
        const entry = templateLibraryModule.find(templateLibraryState, key);
        const label = templateLibraryModule.entryLabel(entry) || key;
        if (!(await confirmModal(interpolate(t('emoteMaker.removeTemplateConfirm'), { name: label })))) {
            return;
        }
        const held = loadedTemplates.get(key);
        const isCurrent = key === currentTemplateKey();
        loadedTemplates.delete(key);
        // 移除的是当前正用着的那个时，store 归页面自己收尾，不能留着读不到的字节
        if (held && !isCurrent && !holdsTemplateStore(held.store)) releaseAssetStore(held.store);
        templateLibraryState = templateLibraryModule.remove(templateLibraryState, key);
        try {
            templateLibraryModule.save(localStorage, templateLibraryState);
        } catch (_) { /* 存不下就只丢这一次的记忆 */ }
        // 库条目删了，磁盘上的副本跟着删（确认框里已经说过会删）
        void deleteTemplateArchive(key);
        if (isCurrent) {
            spineRendererGeneration += 1;
            disposeSpineRenderer();
            releaseTemplateAssetStore();
            templatePackage = null;
            textureCacheFiles = [];
            lastTemplate = null;
        }
        renderAll();
    }

    function applyTemplateSession(manifest) {
        if (!lastTemplate || !manifest) return false;
        if (lastTemplate.fingerprint !== templateFingerprint(manifest)) {
            // 不是同一个包就什么都不恢复。把上一个包的皮肤/滑杆套到新包上，
            // 会得到一个"看起来能开但全是错的东西"，比不恢复更糟。
            return false;
        }
        const scenes = getImportedScenes();
        const ids = new Set(scenes.map((scene) => scene.id));
        const character = lastTemplate.character || {};
        if (Array.isArray(character.skins)) state.templateSkins = character.skins.map((item) => ({ ...item }));
        if (Array.isArray(character.sliders)) state.templateSliders = character.sliders.map((item) => ({ ...item }));
        if (Array.isArray(character.slots) && character.slots.length) {
            // 只接受新包里仍然存在的槽位名，避免把过期色组写回去。
            const known = new Set((manifest.character?.slots || []).map((slot) => String(slot?.name || '')));
            const kept = character.slots.filter((slot) => known.has(String(slot?.name || '')));
            if (kept.length) {
                state.templateSlots = kept.map((slot) => ({ ...slot }));
                state.templateSlotDefaults = kept.map((slot) => ({ ...slot }));
                state.templateSlotGroup = kept[0]?.name || '';
            }
        }
        if (lastTemplate.adjustments && typeof lastTemplate.adjustments === 'object') {
            state.adjustments = { ...state.adjustments, ...lastTemplate.adjustments };
        }
        if (typeof lastTemplate.adjustOverwrite === 'boolean') state.adjustOverwrite = lastTemplate.adjustOverwrite;
        if (lastTemplate.colorMode) state.colorMode = lastTemplate.colorMode;
        if (lastTemplate.secondaryColor) state.secondaryColor = lastTemplate.secondaryColor;
        const scene = scenes.find((item) => item.id === lastTemplate.sceneId);
        if (scene) {
            state.selectedSceneId = scene.id;
            state.selectedSceneListId = scene.source?.sceneList || '';
            state.animationId = scene.animation?.id || state.animationId;
        }
        if (lastTemplate.sceneListFilter && manifest.sceneLists?.some((list) => (
            (list.id || list.path || list.name) === lastTemplate.sceneListFilter
        ))) {
            state.sceneListFilter = lastTemplate.sceneListFilter;
        }
        // 组/取景跟着模板回来。成员如果在这个包里已经不存在（模板换了版本、
        // 场景数变了），就把它从组里剔掉，而不是留着一条烘不出来的引用。
        if (groupLibrary && Array.isArray(lastTemplate.groups)) {
            const groups = groupLibrary.groupsFrom(lastTemplate.groups);
            const shots = groupLibrary.shotsFrom(lastTemplate.shots);
            const shotIds = new Set(shots.map((shot) => shot.id));
            state.shots = shots;
            state.groups = groups.map((group) => ({
                ...group,
                items: (group.items || []).filter((item) => (
                    item.kind === 'scene' ? ids.has(item.ref) : shotIds.has(item.ref)
                )),
            }));
        }
        if (allGroups().some((group) => group.id === lastTemplate.groupId)) {
            state.groupId = lastTemplate.groupId || '';
        }
        const pack = {};
        Object.entries(lastTemplate.packSceneIds || {}).forEach(([key, id]) => {
            if (ids.has(id)) pack[key] = id;
        });
        state.packSceneIds = pack;
        return true;
    }

    // ── 可拖拽的比例布局 ──────────────────────────────────────────────────────
    // 三栏宽度和底部列表高度都存在一个独立键里：它们是窗口偏好，既不属于角色
    // 设计（不该进撤销栈），也不属于导出参数（换模板时不应该跟着变）。
    const LAYOUT_STORAGE_KEY = 'neko-emote-maker-layout';
    // dock 的下限不是审美问题而是几何问题：它至少要容下标题 + 可滚动的列表 +
    // 40px 播放控件，否则 .animation-dock 的 overflow:hidden 会把控件裁掉。
    const LAYOUT_LIMITS = Object.freeze({
        left: Object.freeze([200, 520]),
        right: Object.freeze([220, 560]),
        dock: Object.freeze([180, 620]),
    });
    // 窗口很矮时按比例算出的上限可能已经小于 180；再往下还留 标题+40px 控件 的
    // 硬底线，配合 .workspace-panel 的面内滚动保证控件永远够得着。
    const DOCK_HARD_MIN = 96;
    const layout = { left: 300, right: 360, dock: 0 };

    // 静态像素上限在窄窗口下会把面板拖出屏幕外（实测 1120px 窗口把两侧拖到
    // 520/560 会让网格溢出 52px、右栏出界 36px，而且手柄自己也跑出可视区，
    // 用户再也拖不回来）。所以上限必须按当前容器实算：可用宽度减去中列最小值、
    // 两条手柄轨道和全部 gap，再留给对面一个最小值。
    function parsePx(value, fallback) {
        const number = parseFloat(value);
        return Number.isFinite(number) ? number : fallback;
    }

    function gridTracks(element, property) {
        const raw = getComputedStyle(element)[property] || '';
        return raw.split(' ').filter(Boolean).map((track) => parsePx(track, 0));
    }

    function sideMaximum(which) {
        const bounds = LAYOUT_LIMITS[which];
        const grid = document.querySelector('.maker-grid');
        if (!grid) return bounds[1];
        const style = getComputedStyle(grid);
        const tracks = gridTracks(grid, 'gridTemplateColumns');
        const gap = parsePx(style.columnGap, 0);
        const centerMin = parsePx(style.getPropertyValue('--center-min'), 340);
        const handleWidth = tracks.length > 3 ? tracks[1] + tracks[3] : 20;
        // 约束要加在两栏之"和"上：先前各侧只给对面留一个最小值，结果两边各自
        // 合法、加起来仍然超预算（1090px 下算出 438+458+340 > 1058，照样溢出）。
        // 所以这里用对面"当前"的宽度来限本侧，拖宽一边就会压缩另一边的上限。
        const other = which === 'left' ? 'right' : 'left';
        const usable = grid.clientWidth - centerMin - handleWidth - gap * 4;
        const room = usable - layout[other];
        return Math.max(bounds[0], Math.min(bounds[1], Math.floor(room)));
    }

    function dockMaximum() {
        const bounds = LAYOUT_LIMITS.dock;
        const workspace = document.querySelector('.workspace-panel');
        if (!workspace) return bounds[1];
        const style = getComputedStyle(workspace);
        const rows = gridTracks(workspace, 'gridTemplateRows');
        const gap = parsePx(style.rowGap, 0);
        const canvasMin = parsePx(style.getPropertyValue('--canvas-min'), 300);
        const heading = rows.length > 0 ? rows[0] : 0;
        const handle = rows.length > 2 ? rows[2] : 12;
        // clientHeight 是含 padding 的，必须把上下内边距扣掉，否则每个窗口都会
        // 稳定多出 ~36px 把播放控件顶出可视区（实测各宽度一律溢出 32px）。
        const padY = parsePx(style.paddingTop, 0) + parsePx(style.paddingBottom, 0);
        const shareable = workspace.clientHeight - padY - canvasMin - heading - handle - gap * 3;
        return Math.max(DOCK_HARD_MIN, Math.min(bounds[1], Math.floor(shareable)));
    }

    function clampLayout(which, value) {
        const bounds = LAYOUT_LIMITS[which];
        const number = Number(value);
        if (!Number.isFinite(number)) return layout[which];
        const max = which === 'dock' ? dockMaximum() : sideMaximum(which);
        return Math.min(max, Math.max(bounds[0], Math.round(number)));
    }

    function applyLayout() {
        const grid = document.querySelector('.maker-grid');
        if (!grid) return;
        // 两侧互为对方的余量约束，走两遍才收敛（钳制只会往下调，不会震荡）。
        layout.left = clampLayout('left', layout.left);
        layout.right = clampLayout('right', layout.right);
        layout.left = clampLayout('left', layout.left);
        layout.right = clampLayout('right', layout.right);
        if (layout.dock) layout.dock = clampLayout('dock', layout.dock);
        grid.style.setProperty('--col-left', `${layout.left}px`);
        grid.style.setProperty('--col-right', `${layout.right}px`);
        // dock 允许 0 表示"未固定"，此时交给内容自适应。
        const workspace = document.querySelector('.workspace-panel');
        if (workspace) {
            if (layout.dock) workspace.style.setProperty('--dock-height', `${layout.dock}px`);
            else workspace.style.removeProperty('--dock-height');
        }
    }

    function loadLayout() {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || 'null');
        } catch (_) {
            saved = null;
        }
        if (!saved || typeof saved !== 'object') return;
        ['left', 'right'].forEach((which) => {
            if (Number.isFinite(Number(saved[which])) && saved[which] > 0) {
                layout[which] = clampLayout(which, saved[which]);
            }
        });
        // dock 允许 0 表示"未固定"
        layout.dock = Number.isFinite(Number(saved.dock)) && Number(saved.dock) >= 0
            ? Math.min(LAYOUT_LIMITS.dock[1], Math.max(0, Math.round(Number(saved.dock))))
            : 0;
        // 旧存档里可能带着 listMode（当时列表分「场景 / 动画」两栏）。现在只剩一种，
        // 读到它就忽略 —— 不删键位，免得有人回滚代码时又丢设置。
        if (saved.packMode === 'basic' || saved.packMode === 'graph') {
            state.packMode = saved.packMode;
        }
        if (typeof saved.groupPanelOpen === 'boolean') state.groupPanelOpen = saved.groupPanelOpen;
    }

    function persistLayout() {
        try {
            localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify({
                left: layout.left,
                right: layout.right,
                dock: layout.dock,
                packMode: state.packMode,
                groupPanelOpen: state.groupPanelOpen !== false,
            }));
        } catch (_) {
            // 存不下只影响下次打开时的布局记忆。
        }
    }

    // sign 决定"往哪个方向拖是变大"：左栏向右变大、右栏向左变大、
    // 底部列表向上变大（所以 y 方向取负）。
    function bindResizeHandle(handle, read, write, signX, signY) {
        if (!handle) return;
        let startX = 0;
        let startY = 0;
        let startValue = 0;
        let dragging = false;

        const move = (event) => {
            if (!dragging) return;
            // 每个手柄只管一个轴；sign 为 ±1，表示"往哪个方向拖算变大"。
            const raw = signX
                ? (event.clientX - startX) * signX
                : (event.clientY - startY) * signY;
            write(clampValueFor(handle, startValue + Math.round(raw)));
        };
        const stop = () => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('is-dragging');
            document.body.classList.remove('is-resizing');
            persistLayout();
        };
        handle.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            dragging = true;
            startX = event.clientX;
            startY = event.clientY;
            startValue = read();
            handle.classList.add('is-dragging');
            document.body.classList.add('is-resizing');
            if (typeof handle.setPointerCapture === 'function') {
                handle.setPointerCapture(event.pointerId);
            }
        });
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', stop);
        handle.addEventListener('pointercancel', stop);
        handle.addEventListener('lostpointercapture', stop);
        handle.addEventListener('keydown', (event) => {
            const step = event.shiftKey ? 24 : 8;
            let delta = 0;
            if (signX) {
                if (event.key === 'ArrowLeft') delta = -step * signX;
                if (event.key === 'ArrowRight') delta = step * signX;
            }
            if (signY) {
                if (event.key === 'ArrowUp') delta = -step * signY;
                if (event.key === 'ArrowDown') delta = step * signY;
            }
            if (!delta) return;
            event.preventDefault();
            write(clampValueFor(handle, read() + delta));
            persistLayout();
        });
    }

    function clampValueFor(handle, value) {
        if (handle.id === 'resize-left') return clampLayout('left', value);
        if (handle.id === 'resize-right') return clampLayout('right', value);
        return clampLayout('dock', value);
    }

    function setupResizing() {
        bindResizeHandle(
            $('#resize-left'),
            () => layout.left,
            (value) => { layout.left = value; applyLayout(); },
            1, 0,
        );
        bindResizeHandle(
            $('#resize-right'),
            () => layout.right,
            (value) => { layout.right = value; applyLayout(); },
            -1, 0,
        );
        bindResizeHandle(
            $('#resize-dock'),
            () => layout.dock || measureDock(),
            (value) => { layout.dock = value; applyLayout(); },
            0, -1,
        );
        // 窗口变窄时必须重新夹一遍：否则用户在大窗口下拉好的比例会在小窗口里
        // 把面板顶出屏幕，而手柄本身也跟着消失、无法再拖回来。
        let pending = 0;
        window.addEventListener('resize', () => {
            if (pending) return;
            pending = window.requestAnimationFrame(() => {
                pending = 0;
                applyLayout();
            });
        });
    }

    function measureDock() {
        const dock = document.querySelector('.animation-dock');
        return dock ? Math.round(dock.getBoundingClientRect().height) : LAYOUT_LIMITS.dock[0];
    }

    // 基础模式：两个场景下拉。填了说话场景就是经典口型交替（运行时在两张图之间
    // 换 src），留空则不产出 talking_image、说话时继续播待机动画。这比一个
    // "模式"开关直观，也少一个会撒谎的状态字段。
    // 把基础设置表达成同一张节点图 —— 于是导出只有一条路径，基础和进阶不会互相漂移。
    // 待机用 seconds:null 表示演完整段；填 0 会被算成 1 帧，待机就成静图了。
    function basicGraph() {
        const model = window.NekoEmoteNodeGraph;
        const packModule = window.NekoEmotePngtuberPack;
        if (!model || !packModule) return null;
        const nodes = [model.makeNode('source.default', 60, 60, {}, 'basic-root')];
        const links = [];
        // 八个槽全部可达：以前只有待机/说话两行，另外六个情绪槽永远是空的，
        // 运行时 setEmotion 查到空串就直接 return false，等于"导出后没有表情"。
        packModule.STATES.forEach((entry, index) => {
            const sceneId = state.packSceneIds[entry.key] || '';
            const top = 60 + index * 92;
            const outId = 'out-' + index;
            // 说话位固定单帧定格在装配处强制（运行时靠换 <img> src 做口型交替，
            // 给它多帧 GIF 会被反复从头重载，永远播不动）。
            // 秒数不再由面板给：整段动画就是默认，挑片段去表演台的胶片带上拖
            const seconds = 0;
            if (!sceneId) {
                // 未另选场景 = 复用根节点外观；除待机外的空槽由运行时回落 idle
                if (!entry.required) return;
                nodes.push(model.makeNode('output.state', 380, top, { stateKey: entry.key, seconds }, outId));
                links.push({ from: 'basic-root', fromSocket: 'look', to: outId, toSocket: 'look' });
                return;
            }
            const sceneNodeId = 'scene-' + index;
            nodes.push(model.makeNode('source.scene', 60, top, { sceneId }, sceneNodeId));
            nodes.push(model.makeNode('output.state', 380, top, { stateKey: entry.key, seconds }, outId));
            links.push({ from: sceneNodeId, fromSocket: 'look', to: outId, toSocket: 'look' });
        });
        return { schemaVersion: 1, nodes: nodes.filter(Boolean), links };
    }

    function currentBakeGraph() {
        return state.packMode === 'graph' && state.nodeGraph ? state.nodeGraph : basicGraph();
    }

    function renderPackPanel() {
        const packModule = window.NekoEmotePngtuberPack;
        if (!packModule) return;
        const basicPanel = $('#pack-panel-basic');
        const graphPanel = $('#pack-panel-graph');
        const isGraph = state.packMode === 'graph';
        const scenes = getImportedScenes();
        const available = hasSpineRenderer() && scenes.length > 0;
        const validIds = new Set(scenes.map((scene) => scene.id));
        // 换包后旧 scene id 大概率不存在：丢掉，别等导出时烘出空场景。
        Object.keys(state.packSceneIds).forEach((key) => {
            if (!validIds.has(state.packSceneIds[key])) delete state.packSceneIds[key];
        });
        if (!state.packSceneIds.idle_image && validIds.has(state.selectedSceneId)) {
            state.packSceneIds.idle_image = state.selectedSceneId;
        }

        document.querySelectorAll('[data-pack-mode]').forEach((button) => {
            const active = (button.dataset.packMode === 'graph') === isGraph;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', String(active));
        });
        if (basicPanel) basicPanel.hidden = isGraph || !available;
        if (graphPanel) graphPanel.hidden = !isGraph || !available;

        const rowsHost = $('#pack-basic-rows');
        if (rowsHost) {
            rowsHost.replaceChildren();
            packModule.STATES.forEach((entry) => {
                const row = document.createElement('label');
                row.className = 'select-row pack-basic-row';
                // 落点解析要按这个认出"是哪一格"；以前只读不写，拖上去等于没反应
                row.dataset.stateKey = entry.key;
                const caption = document.createElement('span');
                caption.textContent = t(entry.labelKey);
                const select = document.createElement('select');
                select.id = 'pack-scene-' + entry.key.replace(/_image$/, '');
                const blank = document.createElement('option');
                blank.value = '';
                blank.textContent = entry.required
                    ? t('emoteMaker.packSkipOption')
                    : t('emoteMaker.packBasicFollowRoot');
                select.appendChild(blank);
                scenes.forEach((scene) => {
                    const option = document.createElement('option');
                    option.value = scene.id;
                    option.textContent = scene.name || scene.animation?.id || scene.id;
                    select.appendChild(option);
                });
                select.value = state.packSceneIds[entry.key] || '';
                select.addEventListener('change', () => {
                    if (select.value) state.packSceneIds[entry.key] = select.value;
                    else delete state.packSceneIds[entry.key];
                    persistExportSettings();
                    renderPackPanel();
                });
                row.append(caption, select);
                rowsHost.appendChild(row);
            });
        }
        const nameInput = $('#pack-name');
        if (nameInput) {
            nameInput.value = state.packName || '';
            nameInput.placeholder = currentTemplateLabel() || t('emoteMaker.title');
        }
        const formatSelect = $('#pack-format');
        if (formatSelect) formatSelect.value = state.packFormat === 'layered' ? 'layered' : 'flat';
        const prioritySelect = $('#pack-priority');
        if (prioritySelect) {
            prioritySelect.value = state.packPriority === 'emotion' ? 'emotion' : 'talking';
        }

        const summary = $('#pack-basic-summary');
        if (summary) {
            // 未绑说话场景的那句"继续播待机动画"没人需要读：收掉，绑了才说
            const bound = Boolean(state.packSceneIds.talking_image);
            summary.hidden = !bound;
            summary.textContent = bound ? t('emoteMaker.packBasicMouthOn') : '';
        }
        ['#pack-export-btn', '#pack-import-btn'].forEach((selector) => {
            const button = $(selector);
            if (button && !packBusy) button.disabled = !available;
        });
    }



    // ── 形象包产出（统一路径）─────────────────────────────────────────────────
    // 基础和进阶都先编译成节点图，因此这里只有一条采集流程；两种输出格式
    // （平铺 GIF / 分层 PNG 雪碧图）只在最后的装配阶段分叉。
    function packFrameBudget(seconds, fps) {
        const packModule = window.NekoEmotePngtuberLayered;
        const limit = PACK_MAX_FRAMES;
        const requested = Number(seconds);
        if (!Number.isFinite(requested) || requested <= 0) return limit;
        return Math.max(1, Math.min(limit, Math.round(requested * fps)));
    }

    async function bakePackJobs(jobs, preview = {}) {
        const previewFps = Number(preview.fps) || 0;
        const previewEdge = Number(preview.edge) || 0;
        const encoder = window.NekoEmoteGifEncoder;
        const packModule = window.NekoEmotePngtuberPack;
        // 预览用的 job 会自带 fps/edge（表演台只要看得清，不需要导出级精度）；
        // 导出路径不传，仍取全局值。
        const edge = Math.min(previewEdge || state.exportResolution || PACK_MAX_EDGE, PACK_MAX_EDGE);
        const fps = previewFps || state.exportFps || GIF_EXPORT_FPS;
        const sceneList = getImportedScenes();
        const results = [];
        let missingImages = 0;
        const previousSceneId = state.selectedSceneId;
        const previousAnimationId = state.animationId;
        try {
            for (let index = 0; index < jobs.length; index += 1) {
                const job = jobs[index];
                // 图片状态：没有场景，把用户图片按导出边长画成一帧；
                // 多图轮播 = 总帧数均摊到每张图，前 total%n 张各多扛一帧
                const jobImageIds = (job.imageIds && job.imageIds.length)
                    ? job.imageIds
                    : (job.imageId ? [job.imageId] : []);
                if (jobImageIds.length) {
                    const sources = jobImageIds
                        .map((id) => stageUserImages.get(id))
                        .filter(Boolean);
                    if (!sources.length) {
                        // 真缺图（图被删了还绑着）不再无声：导出时说一声缺了几个
                        if (!previewFps) missingImages += 1;
                        continue;
                    }
                    if (!previewFps) setPackStatus(`${t('emoteMaker.packBakingProgress')} ${index + 1}/${jobs.length}`);
                    const singles = [];
                    for (const image of sources) {
                        const one = await frameFromStageImage(image, edge);
                        if (one.length) singles.push(one[0]);
                    }
                    if (!singles.length) continue;
                    // 平铺包的说话位只定格第一张：与场景侧的 still 规则同源
                    // （运行时换 src 重载多帧 GIF 的空窗问题），分层不受限。
                    const still = job.stateKey === 'talking_image' && state.packFormat !== 'layered';
                    const shown = still ? singles.slice(0, 1) : singles;
                    const total = still ? 1
                        : Math.max(shown.length, Number(job.frames) || shown.length);
                    const base = Math.floor(total / shown.length);
                    const extra = total % shown.length;
                    const frames = [];
                    shown.forEach((frame, imageIndex) => {
                        const count = base + (imageIndex < extra ? 1 : 0);
                        for (let repeat = 0; repeat < count; repeat += 1) frames.push(frame);
                    });
                    results.push({
                        stateKey: job.stateKey, frames, edge, fps,
                        look: { sceneId: '', skins: [], sliders: [], slots: [], texts: [] },
                        scale: job.scale || 1, rotation: job.rotation || 0,
                    });
                    continue;
                }
                const scene = sceneList.find((item) => item.id === job.sceneId);
                if (!scene) continue;
                if (!previewFps) setPackStatus(`${t('emoteMaker.packBakingProgress')} ${index + 1}/${jobs.length}`);
                await yieldToBrowser();
                applyLookToState(job.look);
                const frames = await captureGifFrames({
                    scene,
                    maxFrames: job.frames,
                    fps,
                    maxDimension: edge,
                    timeWindow: job.timeWindow,
                });
                if (!frames.length) continue;
                results.push({
                    stateKey: job.stateKey,
                    frames,
                    edge,
                    fps,
                    look: job.look,
                    // 每个状态自己的大小/角度：只有分层模式会把它写进 manifest
                    scale: job.scale,
                    rotation: job.rotation,
                });
            }
        } finally {
            if (!previewFps) setPackStatus('');
            state.selectedSceneId = previousSceneId;
            state.animationId = previousAnimationId;
            const back = sceneList.find((item) => item.id === previousSceneId);
            if (back) syncNativeScene(back, { autoplay: false });
        }
        if (missingImages > 0) {
            showToast(interpolate(t('emoteMaker.stageImagesMissing'), { count: missingImages }));
        }
        return results;
    }

    function flatStates(baked) {
        const encoder = window.NekoEmoteGifEncoder;
        return baked.map((item) => ({
            key: item.stateKey,
            bytes: encoder.encode(item.frames, {
                width: item.edge,
                height: item.edge,
                colors: GIF_EXPORT_COLORS,
                transparent: true,
                loopCount: 0,
            }),
        }));
    }

    async function layeredStates(baked, displayName) {
        const sheet = window.NekoEmoteSheet;
        const layeredModule = window.NekoEmotePngtuberLayered;
        const packModule = window.NekoEmotePngtuberPack;
        const states = [];
        const extras = [];
        for (const item of baked) {
            // eslint-disable-next-line no-await-in-loop
            const composed = sheet.composeSheetCanvas(item.frames, (w, h) => {
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                return canvas;
            });
            // eslint-disable-next-line no-await-in-loop
            const sheetBytes = await sheet.canvasToPngBytes(composed.canvas);
            const path = `layers/${states.length}-${item.stateKey}.png`;
            extras.push({ path, data: sheetBytes });
            states.push({
                stateKey: item.stateKey,
                // 格子总数（含补齐的空格）和真实帧数要分开传：贴图尺寸决定网格，
                // frameCount 决定动画只播到有内容的那一格
                frames: composed.hframes * composed.vframes,
                frameCount: item.frames.length,
                // 写"合成器实际用的格子尺寸"，不是"我要求的导出边长"：metadata 的
                // frame_width 必须和表上的格子对得上，差一个像素就是整表错位闪烁
                width: composed.frameWidth,
                height: composed.frameHeight,
                sheetWidth: composed.canvas.width,
                sheetHeight: composed.canvas.height,
                fps: item.fps,
                pngBytes: sheetBytes,
                x: 0,
                y: 0,
                // 表演台上直接拖出来的大小/角度；平铺模式没有这两个字段的位置，会被忽略
                scale: item.scale,
                rotation: item.rotation,
            });
        }
        const built = layeredModule.buildLayeredPackage({
            // 画布与第一张表的格子同尺寸，否则合成画面与包里的表对不上
            canvasWidth: states[0].width,
            canvasHeight: states[0].height,
            states,
        });
        // 分层包也必须带一张平铺回落图：服务端要求 idle_image 非空且真实存在。
        const idleJob = baked.find((item) => item.stateKey === 'idle_image') || baked[0];
        const fallbackBytes = await sheet.canvasToPngBytes(
            sheet.firstFrameCanvas(idleJob.frames[0]),
        );
        const flat = flatStates([{ ...idleJob, frames: idleJob.frames.slice(0, 1) }]);
        const assembled = packModule.buildPackageFiles({
            displayName,
            description: `${t('emoteMaker.title')} · ${displayName}`,
            placement: packPlacement(),
            statePriority: state.packPriority,
            // 回落图只给 idle：其余槽位空着，运行时会回落到 idle 而不是 404
            states: [{ key: 'idle_image', file: 'idle.png', bytes: fallbackBytes }],
            layered: {
                adapter: built.adapter,
                metadataPath: built.metadataPath,
                files: built.files.filter((file) => file.path === 'metadata.json')
                    .concat(extras.map((file) => ({ path: file.path, data: file.data }))),
            },
        });
        return { assembled, metadata: built.metadata };
    }

    async function buildPngtuberPackage() {
        const packModule = window.NekoEmotePngtuberPack;
        if (!packModule || !window.NekoEmoteGifEncoder || !hasSpineRenderer()) {
            showToast(t('emoteMaker.exportGifUnavailable'));
            return null;
        }
        if (packBusy) return null;
        if (state.packFormat === 'layered' && !window.NekoEmotePngtuberLayered) {
            showToast(t('emoteMaker.packLayeredUnavailable'));
            return null;
        }
        // 图片槽位的字节在副本里，内存清单只在开表演台时恢复。刷新后直接导出
        // 而没开过抽屉的话，清单是空的——所有图片槽会被烘包静默跳过。
        // 先起恢复不 await：setPackBusy 之前不能有让渡点，否则双击会导出两份；
        // 真正等它落在烘包前。
        const stageImagesReady = restoreStageImages();
        const graph = currentBakeGraph();
        const model = window.NekoEmoteNodeGraph;
        if (!graph || !model) {
            showToast(t('emoteMaker.packIdleRequired'));
            return null;
        }
        const evaluated = model.evaluate(graph, currentLookDefaults());
        if (evaluated.cycle) {
            showToast(t('emoteMaker.nodeCycleWarning'));
            return null;
        }
        // 只是点过去看过的格子会在图里留下"跟随默认外观"的输出。它们不该进包——
        // 否则烘出来的是当前场景的图，而用户从没给它选过动作。
        const plan = model.planOutputs(
            graph,
            evaluated.outputs,
            packModule.STATES.map((entry) => entry.key),
            ['idle_image'],
        );
        const sceneIds = new Set(getImportedScenes().map((scene) => scene.id));
        const usable = plan.kept.filter((output) =>
            sceneIds.has(output.look.sceneId)
            || (output.imageId && output.imageId.length)
            || (output.imageIds && output.imageIds.length));
        if (plan.dropped.length) {
            const reasons = new Set(plan.dropped.map((item) => item.reason));
            showToast(`${t('emoteMaker.packPlanSkipped')} (${plan.dropped.length})${
                reasons.has('unassigned') ? ` · ${t('emoteMaker.packPlanUnassigned')}` : ''}${
                reasons.has('duplicate') ? ` · ${t('emoteMaker.packPlanDuplicate')}` : ''}`);
        }
        if (!usable.length) {
            showToast(t('emoteMaker.nodeNoOutput'));
            return null;
        }
        if (!usable.some((output) => output.stateKey === 'idle_image')) {
            showToast(t('emoteMaker.packIdleRequired'));
            return null;
        }

        const fps = state.exportFps || GIF_EXPORT_FPS;
        // 优先用用户起的名字；没起才跟随模板名，否则每次导出都是同一个目录
        const displayName = String(state.packName || '').trim()
            || currentTemplateLabel()
            || templatePackage?.model?.displayName
            || t('emoteMaker.title');
        const jobs = usable.map((output) => {
            const imageIds = (output.imageIds && output.imageIds.length)
                ? output.imageIds
                : (output.imageId ? [output.imageId] : []);
            if (imageIds.length) {
                // 图片状态：静态源，时间轴控总停留时长；多图 = 按序轮播，
                // 总帧数均摊到每张图（保底每张至少一帧）。平铺包的说话位照旧
                // 只烘一帧：运行时按口型节奏换 src，多帧 GIF 每换一次就整条
                // 重载，首帧解码前的空窗就是"有一帧空白"。
                const still = output.stateKey === 'talking_image' && state.packFormat !== 'layered';
                const hold = Math.max(0.05, Number(output.seconds) || 0.05);
                return {
                    stateKey: output.stateKey,
                    imageIds,
                    frames: still ? 1 : Math.max(imageIds.length, Math.ceil(hold * fps)),
                    timeWindow: { from: 0, to: hold },
                    scale: output.scale,
                    rotation: output.rotation,
                };
            }
            const scene = getImportedScenes().find((item) => item.id === output.look.sceneId);
            const duration = Math.max(0.05, Number(getImportedAnimationDuration(scene?.animation?.id)) || 0.05);
            const from = Math.min(Math.max(0, Number(output.startAt) || 0), duration);
            const wanted = Number(output.seconds) || 0;
            // 平铺包的说话位只烘一帧：运行时按口型节奏在 idle/talking 两张图之间来回切，
            // 图自己再动一次就成了双重动画。分层包不一样 —— 说话是去占状态槽，画面完全
            // 由这一格的雪碧图自己演，定格成一张就等于用户绑的动作没演。
            const still = output.stateKey === 'talking_image' && state.packFormat !== 'layered';
            const to = still
                ? Math.min(duration, from + 1 / fps)
                : (wanted > 0 ? Math.min(duration, from + wanted) : duration);
            const timeWindow = { from, to: Math.max(to, from + 1 / fps) };
            return {
                stateKey: output.stateKey,
                sceneId: output.look.sceneId,
                look: output.look,
                frames: still ? 1 : packFrameBudget(timeWindow.to - timeWindow.from, fps),
                timeWindow,
                scale: output.scale,
                rotation: output.rotation,
            };
        });

        setPackBusy(true);
        try {
            await stageImagesReady;
            const baked = await bakePackJobs(jobs);
            if (!baked.length) {
                showToast(t('emoteMaker.packZipFailed'));
                return null;
            }
            if (state.packFormat === 'layered') {
                baked[0].displayName = displayName;
                baked[0].description = `${t('emoteMaker.title')} · ${displayName}`;
                const result = await layeredStates(baked, displayName);
                return result.assembled;
            }
            return packModule.buildPackageFiles({
                displayName,
                description: `${t('emoteMaker.title')} · ${displayName}`,
                states: flatStates(baked),
                placement: packPlacement(),
                statePriority: state.packPriority,
            });
        } catch (error) {
            console.warn('[emote-maker] 形象包生成失败', error);
            showToast(t('emoteMaker.packZipFailed'));
            return null;
        } finally {
            setPackBusy(false);
            renderAll();
        }
    }

    function renderAll() {
        const hasEditorContent = Boolean(templatePackage) || EXPRESSIONS.length > 0 || ACCESSORIES.length > 0;
        const nativePreview = hasSpineRenderer();
        document.body.classList.toggle('editor-empty', !hasEditorContent);
        document.body.classList.toggle('editor-has-template', Boolean(templatePackage));
        // The import card and canvas already provide the empty-state message;
        // keeping this legacy footer visible creates a duplicate instruction.
        if (assetTip) assetTip.hidden = true;
        if (inspectorEmptyState) inspectorEmptyState.hidden = hasEditorContent;
        if (animationDock) animationDock.hidden = !hasEditorContent;
        if (templateRuntimeBadge) {
            // 徽章只报忧：跑不起预览才现身。一切正常时它就是第三个"模板已读取"。
            templateRuntimeBadge.hidden = !templatePackage || hasSpineRenderer();
            if (!templateRuntimeBadge.hidden) {
                templateRuntimeBadge.textContent = t('emoteMaker.templateNoRuntime');
                templateRuntimeBadge.dataset.tone = 'warning';
            }
        }
        bindTipKeys();
        renderLibraryControls();
        renderInspectorTabs();
        syncExportControls();
        renderPackPanel();
        renderSceneListFilter();
        renderGroupBar();
        renderAssetGrid();
        renderPartGroups();
        renderColorSwatches();
        renderColorMode();
        renderAdjustments();
        renderAnimations();
        renderLayers();
        applyZoom();
        const secondaryColor = $('#secondary-color-input');
        if (secondaryColor) secondaryColor.value = state.secondaryColor;
        const exportButton = $('#export-png-btn');
        if (exportButton) exportButton.disabled = EXPRESSIONS.length === 0 && !hasSpineRenderer();
        const exportLabel = exportButton?.querySelector('span');
        if (exportLabel) {
            // 出什么格式由上面的「格式」下拉说了算，按钮只管说"导哪一张"：现在是两颗
            // 半宽按钮并排，再把 静态 PNG / 动画 GIF 印上去只会挤。渲染不了时留着原因，
            // 别让按钮哑掉而看不出为什么。
            exportLabel.textContent = (templatePackage && !hasSpineRenderer())
                ? t('emoteMaker.templateNoRuntime')
                : t('emoteMaker.exportCurrent');
        }
        const titleSubtitle = document.querySelector('.title-brand p');
        if (titleSubtitle) {
            titleSubtitle.textContent = templatePackage
                ? (hasSpineRenderer() ? '' : t('emoteMaker.templateMetadataOnly'))
                : t('emoteMaker.emptyLibraryHint');
        }
        if (templateCanvasStatus) {
            const statusText = templatePackage
                ? t('emoteMaker.templateCapabilityWarning')
                : t('emoteMaker.emptyLibraryHint');
            if (templateCanvasStatusText) {
                templateCanvasStatusText.textContent = statusText;
            } else {
                templateCanvasStatus.textContent = statusText;
            }
            if (canvasImportButton) canvasImportButton.hidden = hasEditorContent;
            templateCanvasStatus.hidden = nativePreview;
        }
        updateHistoryButtons();
        void renderCanvas();
    }

    function showToast(message) {
        if (!toast) return;
        toast.textContent = message;
        toast.classList.add('is-visible');
        if (toastTimer) window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => toast.classList.remove('is-visible'), 2200);
    }

    function presentTemplateWarning(warning) {
        const text = String(warning || '').trim();
        if (!text) return t('emoteMaker.templateCompatibilityWarning');
        // Keep implementation/provider terminology out of the normal editor
        // surface. Detailed diagnostics remain available in the package data
        // and developer tools, while users get one neutral notice.
        const technicalPattern = /(emotelab|sharedmodelkey|\bcharacter\b|\bspine\b|atlas(?:\.txt)?|scenelist|scenes\s*数组|slider|skin|slotgroup|角色数据|当前模型.*不一致|模型.*不一致)/i;
        return technicalPattern.test(text)
            ? t('emoteMaker.templateCompatibilityWarning')
            : text;
    }



    function yieldToBrowser() {
        return new Promise((resolve) => {
            if (typeof window.requestAnimationFrame === 'function') {
                window.requestAnimationFrame(() => resolve());
            } else {
                window.setTimeout(resolve, 0);
            }
        });
    }

    // 缩放唯一出口：GIF 逐帧取图和 PNG 导出都走这里，避免两份缩放实现漂移。
    function downscaleCanvas(source, maxDimension) {
        if (!source || typeof source.getContext !== 'function') {
            throw new Error('当前画布不可读取');
        }
        const sourceWidth = Math.max(1, Math.round(Number(source.width) || 0));
        const sourceHeight = Math.max(1, Math.round(Number(source.height) || 0));
        const requested = Math.max(1, Math.round(Number(maxDimension) || sourceWidth));
        const scale = Math.min(1, requested / Math.max(sourceWidth, sourceHeight));
        const width = Math.max(1, Math.round(sourceWidth * scale));
        const height = Math.max(1, Math.round(sourceHeight * scale));
        if (width === sourceWidth && height === sourceHeight) {
            return { canvas: source, width, height };
        }
        const target = document.createElement('canvas');
        target.width = width;
        target.height = height;
        const context = target.getContext('2d');
        if (!context) throw new Error('当前画布不支持读取像素');
        context.clearRect(0, 0, width, height);
        // 1024→128 这种大跨度缩放，默认插值会出锯齿并丢细节；与 renderCanvas 的
        // 2D 路径保持一致用 high。
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(source, 0, 0, width, height);
        return { canvas: target, width, height };
    }

    function captureCanvasFrame(source, maxDimension) {
        const fitted = downscaleCanvas(source, maxDimension);
        const context = fitted.canvas.getContext('2d', { willReadFrequently: true });
        if (!context || typeof context.getImageData !== 'function') {
            throw new Error('当前画布不支持读取像素');
        }
        const image = context.getImageData(0, 0, fitted.width, fitted.height);
        return { width: fitted.width, height: fitted.height, data: new Uint8ClampedArray(image.data) };
    }

    function captureCurrentEditorFrame(maxDimension) {
        const edge = Math.max(1, Number(maxDimension) || state.exportResolution || GIF_EXPORT_WIDTH);
        if (hasSpineRenderer()) {
            // Spine itself is WebGL, while EmoteLab's outline/text layers are
            // 2D overlays.  Capture the same composite canvas used by the
            // static PNG path so animated export does not silently drop them.
            renderNativeOverlays();
            const composite = typeof nativeCompositeCanvas === 'function'
                ? nativeCompositeCanvas()
                : null;
            if (composite) return captureCanvasFrame(composite, edge);
            if (typeof spineRenderer.captureFrame === 'function') {
                return spineRenderer.captureFrame({ maxDimension: edge, render: false });
            }
            throw new Error('当前 Spine 运行时不支持帧读取');
        }
        return captureCanvasFrame(canvas, edge);
    }

    // options 供两条调用路径共用同一份逐帧循环与恢复逻辑：
    //   · GIF 导出用默认值（烘当前选中场景）。
    //   · PNGTuber 形象包传入 {scene, maxFrames, fps}，烘调用方指定的某个场景。
    // 传入 scene 时本函数只负责套用并烘焙它，不还原选中态 —— 那由调用方处理，
    // 因为它还要连带刷新一次界面。
    async function captureGifFrames(options = {}) {
        const scene = options.scene || null;
        const animationId = scene ? (scene.animation?.id || state.animationId) : state.animationId;
        const duration = Math.max(
            0.05,
            Number(scene
                ? getImportedAnimationDuration(animationId)
                : getCurrentAnimation()?.duration) || 0,
        );
        const sceneSpeed = templatePackage
            ? Math.max(0.05, Number((scene || getSelectedScene())?.animation?.speed) || 1)
            : 1;
        const playbackSpeed = Math.max(0.05, Number(state.animationSpeed) || 1) * sceneSpeed;
        const maxFrames = Math.max(1, Number(options.maxFrames) || GIF_EXPORT_MAX_FRAMES);
        const fps = Number(options.fps) || state.exportFps || GIF_EXPORT_FPS;
        // 允许 1 帧：形象包的"口型交替"就是要一张定格图。动画导出仍保持最少 2 帧。
        const frameFloor = maxFrames === 1 ? 1 : 2;
        // timeWindow 把采集窗口从"整段动画"收窄到用户挑的那一段；不给就是整段，
        // 于是 GIF/PNG 导出这些老调用方行为完全不变。
        const windowFrom = Math.max(0, Math.min(duration, Number(options.timeWindow?.from) || 0));
        const windowTo = options.timeWindow?.to == null
            ? duration
            : Math.max(windowFrom + 0.01, Math.min(duration, Number(options.timeWindow.to) || duration));
        const span = windowTo - windowFrom;
        const frameCount = Math.max(frameFloor, Math.min(maxFrames, Math.ceil(span * fps)));
        const delayMs = Math.max(10, (span * 1000) / frameCount / playbackSpeed);
        const frames = [];
        const wasPlaying = Boolean(state.animationPlaying);
        const previousProgress = Number(state.animationProgress) || 0;
        const previousTime = previousProgress > 0
            ? duration * Math.max(0, Math.min(100, previousProgress)) / 100
            : Number((scene || getSelectedScene())?.animation?.time) || 0;

        state.animationPlaying = false;
        if (templatePackage && hasSpineRenderer()) {
            stopSpineAnimationLoop();
            spineRenderer.pause();
        } else if (animationFrameHandle) {
            window.cancelAnimationFrame(animationFrameHandle);
            animationFrameHandle = null;
        }

        try {
            if (scene) {
                state.selectedSceneId = scene.id;
                state.animationId = animationId;
                state.animationProgress = 0;
                // 套用场景会连带设置相机、皮肤、滑杆、色组和描边/文字层；套不上就
                // 明确失败，免得把当前画面当成那个状态烘出来。
                if (!syncNativeScene(scene, { autoplay: false })) {
                    throw new Error('scene_unavailable');
                }
            }
            for (let index = 0; index < frameCount; index += 1) {
                // 采集时间落在 timeWindow 里，进度条与 setTime 都按同一秒数走，
                // 否则旧渲染器（靠 animationProgress 反算秒）会和 Spine 路径烘出不同的帧。
                const at = windowFrom + (span * index) / frameCount;
                const progress = (at / duration) * 100;
                state.animationProgress = progress;
                if (templatePackage && hasSpineRenderer()) {
                    spineRenderer.setTime(at, { render: false });
                    spineRenderer.render();
                } else {
                    // The legacy canvas renderer is asynchronous because it
                    // may load a selected PNG layer.
                    await renderCanvas();
                }
                const frame = captureCurrentEditorFrame(options.maxDimension);
                frames.push({ ...frame, delayMs });
                // Let the browser paint between readbacks. This keeps the
                // editor responsive for 60–90 frame exports.
                if (index % 2 === 1) await yieldToBrowser();
            }
            return frames;
        } finally {
            state.animationProgress = previousProgress;
            if (templatePackage && hasSpineRenderer()) {
                spineRenderer.setTime(previousTime, { render: false });
                spineRenderer.render();
                renderNativeOverlays();
                if (wasPlaying) {
                    spineRenderer.play();
                    state.animationPlaying = true;
                    startSpineAnimationLoop();
                } else {
                    spineRenderer.pause();
                    state.animationPlaying = false;
                }
            } else {
                state.animationPlaying = wasPlaying;
                if (wasPlaying) {
                    animationLastTimestamp = 0;
                    animationFrameHandle = window.requestAnimationFrame(animationTick);
                }
            }
            updateAnimationControls();
            void renderCanvas();
        }
    }

    function exportFilename(extension) {
        const value = state.expressionId || state.animationId || 'empty';
        const safe = String(value)
            .replace(/[\\/:*?"<>|]+/g, '-')
            .replace(/\s+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 96) || 'empty';
        return `neko-emote-${safe}.${extension}`;
    }

    function gifByteLength(value) {
        if (value && Number.isFinite(Number(value.size))) return Number(value.size);
        if (value && Number.isFinite(Number(value.byteLength))) return Number(value.byteLength);
        if (value && Number.isFinite(Number(value.length))) return Number(value.length);
        return Number.POSITIVE_INFINITY;
    }

    function compactGifFrames(frames, stride) {
        const step = Math.max(1, Math.round(Number(stride) || 1));
        if (step === 1) return frames;
        const compacted = [];
        for (let index = 0; index < frames.length; index += step) {
            const frame = frames[index];
            compacted.push({
                ...frame,
                delayMs: Math.max(10, (Number(frame.delayMs) || 10) * step),
            });
        }
        return compacted;
    }

    function encodeGifWithinBudget(frames, encoder, transparent) {
        const attempts = [];
        // 阶梯从用户选的尺寸推导：主档不缩画布、只抽帧；还不够再逐级缩小。
        // 原来写死的 240 → 200/160/128 只在"用户想要 240"时才成立。
        const requested = Math.max(1, Math.round(Number(state.exportResolution) || GIF_EXPORT_WIDTH));
        const tiers = [requested];
        [0.83, 0.67, 0.5].forEach((factor) => {
            const size = Math.max(64, Math.round(requested * factor / 8) * 8);
            if (!tiers.includes(size)) tiers.push(size);
        });
        [1, 2, 3, 4, 5, 6, 8].forEach((stride) => {
            attempts.push({
                frames: compactGifFrames(frames, stride),
                width: tiers[0],
                height: tiers[0],
            });
        });
        tiers.slice(1).forEach((size) => {
            [1, 2, 4].forEach((stride) => {
                attempts.push({
                    frames: compactGifFrames(frames, stride),
                    width: size,
                    height: size,
                });
            });
        });

        // 从完整帧列表采样一次，16 次重试共用同一张表：否则"超预算就缩小尺寸"的
        // 重试会让同一个动画在不同 attempt 之间换色。降采样是最近邻、只取已有像素，
        // 所以对更小的 attempt 尺寸这张表依然有效。
        const sampled = typeof encoder.buildPaletteFromFrames === 'function'
            ? encoder.buildPaletteFromFrames(frames, { colors: GIF_EXPORT_COLORS })
            : null;

        let best = null;
        for (const attempt of attempts) {
            const encoded = encoder.toBlob(attempt.frames, {
                width: attempt.width,
                height: attempt.height,
                colors: GIF_EXPORT_COLORS,
                transparent,
                loopCount: 0,
                ...(sampled ? { palette: sampled } : {}),
            });
            const size = gifByteLength(encoded);
            const candidate = { encoded, size, ...attempt };
            if (!best || size < best.size) best = candidate;
            if (size <= GIF_EXPORT_MAX_BYTES) return candidate;
        }
        return best;
    }

    const EXPORT_STORAGE_KEY = 'neko-emote-maker-export';
    const EXPORT_RESOLUTIONS = Object.freeze([128, 240, 320, 480, 512, 1024]);
    const EXPORT_FPS_VALUES = Object.freeze([8, 10, 12, 15, 20, 24, 30, 48, 60]);
    // GIF 的编码耗时按像素数平方增长（实测 120 帧 240² ≈ 0.48s，折算 1024² ≈ 8.8s），
    // 而且 1MB 预算下大尺寸一定会被降质阶梯抽帧/缩小，所以 GIF 封顶 512。
    const GIF_MAX_RESOLUTION = 512;

    function loadExportSettings() {
        let saved = null;
        try {
            saved = JSON.parse(localStorage.getItem(EXPORT_STORAGE_KEY) || 'null');
        } catch (_) {
            saved = null;
        }
        if (!saved || typeof saved !== 'object') return;
        // localStorage 的内容算外部输入，逐项校验后再用，不直接相信形状。
        if (saved.exportFormat === 'gif' || saved.exportFormat === 'png') {
            state.exportFormat = saved.exportFormat;
        }
        if (typeof saved.exportTransparent === 'boolean') {
            state.exportTransparent = saved.exportTransparent;
        }
        if (EXPORT_RESOLUTIONS.includes(Number(saved.exportResolution))) {
            state.exportResolution = Number(saved.exportResolution);
        }
        if (EXPORT_FPS_VALUES.includes(Number(saved.exportFps))) {
            state.exportFps = Number(saved.exportFps);
        }
        // 落位的合法范围只在 NekoEmotePngtuberPack 里定义一份；这里复用它的钳制，
        // 免得两边各写一套 0.1/5/锚点枚举然后悄悄漂移。
        const packModule = window.NekoEmotePngtuberPack;
        if (packModule && typeof packModule.normalizePlacement === 'function') {
            const safe = packModule.normalizePlacement({
                scale: saved.packScale,
                offsetX: saved.packOffsetX,
                offsetY: saved.packOffsetY,
                mirror: saved.packMirror,
            });
            state.packScale = safe.scale;
            state.packOffsetX = safe.offset_x;
            state.packOffsetY = safe.offset_y;
            state.packMirror = safe.mirror;
        }
        if (saved.packFormat === 'layered' || saved.packFormat === 'flat') {
            state.packFormat = saved.packFormat;
        }
        if (typeof saved.packName === 'string') state.packName = saved.packName;
        if (saved.packPriority === 'emotion' || saved.packPriority === 'talking') {
            state.packPriority = saved.packPriority;
        }
        // 场景映射要按当前包重新过滤：跨包残留的 scene id 会让导出烘出空场景
        if (saved.packSceneIds && typeof saved.packSceneIds === 'object') {
            state.packSceneIds = { ...saved.packSceneIds };
        }
    }

    function persistExportSettings() {
        persistTemplateToLibrary();
        try {
            localStorage.setItem(EXPORT_STORAGE_KEY, JSON.stringify({
                exportFormat: state.exportFormat,
                exportTransparent: state.exportTransparent,
                exportResolution: state.exportResolution,
                exportFps: state.exportFps,
                packScale: state.packScale,
                packOffsetX: state.packOffsetX,
                packOffsetY: state.packOffsetY,
                packMirror: state.packMirror,
                packFormat: state.packFormat,
                packName: state.packName,
                packPriority: state.packPriority,
                packSceneIds: { ...(state.packSceneIds || {}) },
            }));
        } catch (_) {
            // 存不下只影响"记住选择"，不影响导出本身。
        }
    }

    function packPlacement() {
        return {
            scale: state.packScale,
            offsetX: state.packOffsetX,
            offsetY: state.packOffsetY,
            mirror: state.packMirror,
        };
    }

    function syncExportControls() {
        const isGif = state.exportFormat === 'gif';
        if (isGif && state.exportResolution > GIF_MAX_RESOLUTION) {
            state.exportResolution = GIF_MAX_RESOLUTION;
        }
        const format = $('#export-format');
        if (format) format.value = state.exportFormat;
        const resolution = $('#export-resolution');
        const resolutionMax = $('#export-resolution-1024');
        if (resolutionMax) resolutionMax.hidden = isGif;
        if (resolution) resolution.value = String(state.exportResolution);
        // 帧率刻意不再按格式禁用：它同时驱动动画 GIF 和形象包的每个状态，
        // 一个"看不见却在影响另一条路径"的置灰控件比常开的更容易误判。
        const fps = $('#export-fps');
        if (fps) fps.value = String(state.exportFps);
        const transparent = $('#transparent-background');
        if (transparent) transparent.checked = state.exportTransparent !== false;
        const scale = $('#pack-scale');
        if (scale) scale.value = String(state.packScale);
        const scaleValue = $('#pack-scale-value');
        if (scaleValue) scaleValue.textContent = `${Math.round(state.packScale * 100)}%`;
        const offsetX = $('#pack-offset-x');
        if (offsetX) offsetX.value = String(state.packOffsetX);
        const offsetXValue = $('#pack-offset-x-value');
        if (offsetXValue) offsetXValue.textContent = `${state.packOffsetX}px`;
        const offsetY = $('#pack-offset-y');
        if (offsetY) offsetY.value = String(state.packOffsetY);
        const offsetYValue = $('#pack-offset-y-value');
        if (offsetYValue) offsetYValue.textContent = `${state.packOffsetY}px`;
        const mirror = $('#pack-mirror');
        if (mirror) mirror.checked = state.packMirror === true;
    }

    // 这个页面跑在 Electron 托管子窗口里，那里的 File System Access 只能弹框、不能写：
    // showSaveFilePicker 会正常返回 handle（并且把目标文件创建/截断成 0 字节），紧接着
    // createWritable() 抛 NotAllowedError "not allowed by the user agent or the platform
    // in the current context"，用户手里剩下的就是一个打不开的空文件。
    // 所以这里不尝试 picker —— 一律用 <a download>，让 Electron 的原生保存框来选位置，
    // 一次交互、一个有效文件。
    // PNG 和 GIF 共用同一个分辨率选择。缩放失败时退回原尺寸，而不是让整个导出失败 ——
    // 拿到偏大的图总比拼不出来好。
    function downscaleForPng(source) {
        try {
            return downscaleCanvas(source, state.exportResolution).canvas;
        } catch (_) {
            return source;
        }
    }

    function canvasToPngBlob(source) {
        return new Promise((resolve) => {
            try {
                source.toBlob((blob) => resolve(blob || null), 'image/png');
            } catch (_) {
                // 被污染（tainted）的画布会在这里同步抛 SecurityError。
                resolve(null);
            }
        });
    }

    async function downloadPng() {
        // 同步快照：nativeCompositeCanvas 把 WebGL 画布的当下像素拷进新的 2D canvas，
        // 因此编码期间动画继续跑也不会改变导出的那一帧。
        const outputCanvas = hasSpineRenderer() ? (nativeCompositeCanvas() || spineCanvas) : canvas;
        if (!outputCanvas) return;
        if (!EXPRESSIONS.length && !hasSpineRenderer()) {
            showToast(t('emoteMaker.noTemplates'));
            return;
        }
        const blob = await canvasToPngBlob(downscaleForPng(outputCanvas));
        if (!blob || !blob.size) {
            showToast(t('emoteMaker.exportPngFailed'));
            return;
        }
        fallbackDownload(blob, exportFilename('png'), 'emoteMaker.exportSuccess', 'emoteMaker.exportPngFailed');
    }

    async function downloadGif() {
        const encoder = window.NekoEmoteGifEncoder;
        if (!encoder || typeof encoder.toBlob !== 'function' || typeof Blob !== 'function') {
            showToast(t('emoteMaker.exportGifUnavailable'));
            return;
        }
        if (templatePackage && !hasSpineRenderer()) {
            showToast(t('emoteMaker.exportGifUnavailable'));
            return;
        }
        if (!EXPRESSIONS.length && !hasSpineRenderer()) {
            showToast(t('emoteMaker.noTemplates'));
            return;
        }
        const exportButton = $('#export-png-btn');
        if (exportButton) exportButton.disabled = true;
        showToast(t('emoteMaker.exportGifProgress'));
        try {
            const frames = await captureGifFrames();
            const encodedResult = encodeGifWithinBudget(
                frames,
                encoder,
                state.exportTransparent !== false,
            );
            if (!encodedResult?.encoded) throw new Error('GIF 编码器没有返回数据');
            const encoded = encodedResult.encoded;
            const blob = typeof Blob === 'function' && encoded instanceof Blob
                ? encoded
                : new Blob([encoded], { type: 'image/gif' });
            if (!blob || !blob.size) throw new Error('GIF 编码结果为空');
            fallbackDownload(
                blob, exportFilename('gif'),
                'emoteMaker.exportGifSuccess', 'emoteMaker.exportGifFailed',
            );
        } catch (error) {
            showToast(t('emoteMaker.exportGifFailed'));
        } finally {
            if (exportButton) exportButton.disabled = false;
            renderAll();
        }
    }

    // ── 生成 PNGTuber 形象包 ────────────────────────────────────────────────
    // 每个状态烘一条 GIF：PNGTuber 的平铺模式直接接受 .gif
    // （main_routers/pngtuber_router.py:24 的 PNGTUBER_EXTENSIONS），运行时是 DOM
    // <img> 换 src、由浏览器自己播放 GIF。所以不需要分层雪碧图，也不用碰被 33 个
    // 静态契约测试钉住的 static/pngtuber-core.js。
    // 尺寸和帧数独立于表情导出的预算：桌面头像用不到 1024（PNGTuber 画布上限就是
    // 1024），而 8 个状态的帧数直接决定包体积。
    const PACK_MAX_EDGE = 512;
    // 帧数上限跟着 60fps 走，否则 60fps 下只有 1/3 秒的循环。
    const PACK_MAX_FRAMES = 60;
    const PACK_TALKING_FRAMES = 1;
    let packBusy = false;
    let stateStageSession = null;
    // 表演台的用户图片导入入口：input 常驻页面，表演台的"导入图片"按钮只负责叫它
    const stageImageInput = document.createElement('input');
    stageImageInput.type = 'file';
    stageImageInput.accept = '.png,image/png';
    stageImageInput.multiple = true;
    stageImageInput.hidden = true;
    stageImageInput.addEventListener('change', () => {
        void importStageImages(stageImageInput.files);
        stageImageInput.value = '';
    });
    document.body.appendChild(stageImageInput);

    function animationIsPlayable(id) {
        if (!hasSpineRenderer()) return false;
        const names = spineRenderer.animationNames ? spineRenderer.animationNames() : [];
        return names.map(String).includes(String(id || ''));
    }

    /** 导出进度：状态行与摘要各写一份 —— 那块可能被收起，收起时摘要是唯一看得见的位置。 */
    function setGroupExportStatus(message) {
        const el = $('#group-export-status');
        if (el) el.textContent = message || '';
        const summary = $('#group-summary-state');
        if (summary && message) summary.textContent = message;
    }

    function setPackStatus(message) {
        const el = $('#pack-status');
        if (el) el.textContent = message || '';
    }

    function setPackBusy(busy) {
        packBusy = Boolean(busy);
        // 烘一批的时候把单张导出按住：并发跑两次只会互相抢同一个渲染上下文。
        // 「批量导出」那颗不在此列 —— 跑起来时它就是停止按钮，按住就停不下来了。
        ['#pack-export-btn', '#pack-import-btn', '#export-png-btn'].forEach((selector) => {
            const button = $(selector);
            if (button) button.disabled = packBusy;
        });
    }




    // 图算出的每个输出节点 = 一张状态图。look 写回 state，让现有的场景套用与
    // overlay 渲染原样画出来，而不是再维护第二条渲染路径。



    async function downloadPngtuberPack() {
        const built = await buildPngtuberPackage();
        if (!built) return;
        try {
            const zip = window.NekoEmotePngtuberPack.packToZip(built.files);
            fallbackDownload(
                new Blob([zip], { type: 'application/zip' }),
                `${built.folder}.zip`,
                'emoteMaker.packZipSuccess',
                'emoteMaker.packZipFailed',
            );
        } catch (_) {
            showToast(t('emoteMaker.packZipFailed'));
        }
    }

    async function importPngtuberPack() {
        const built = await buildPngtuberPackage();
        if (!built) return;
        const packModule = window.NekoEmotePngtuberPack;
        try {
            // 一个文件一个 part、文件名带相对路径 —— 与模型管理选择文件夹时发出的
            // 请求完全同形，所以复用它的全部校验、限额、不覆盖和原子发布逻辑。
            const response = await fetch(packModule.uploadUrl(), {
                method: 'POST',
                body: packModule.appendMultipart(built.files),
                credentials: 'same-origin',
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || !payload.success) {
                const reason = payload.error || payload.detail || '';
                showToast(reason
                    ? `${t('emoteMaker.packImportFailed')}：${reason}`
                    : t('emoteMaker.packImportFailed'));
                return;
            }
            showToast(t('emoteMaker.packImportSuccess'));
        } catch (_) {
            showToast(t('emoteMaker.packImportFailed'));
        }
    }

    function fallbackDownload(
        blob,
        filename,
        successKey = 'emoteMaker.exportSuccess',
        failureKey = 'emoteMaker.exportPngFailed',
    ) {
        let url = '';
        try {
            url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            showToast(t(successKey));
        } catch (_) {
            if (url) URL.revokeObjectURL(url);
            showToast(t(failureKey));
        }
    }

    function updateAdjustment(key, value) {
        // 「覆盖默认值」关着时这些值不参与绘制，Alt+滚轮也不该偷偷改它们
        if (!state.adjustOverwrite) return;
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) return;
        state.adjustments[key] = numericValue;
        syncAdjustmentReadouts();
        applyNativeVisualState();
        void renderCanvas();
    }

    function setInspectorTab(tab) {
        state.inspectorTab = tab;
        renderInspectorTabs();
    }



    function cloneBinaryValue(value) {
        if (value instanceof Uint8Array) {
            return new Uint8Array(value);
        }
        if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
            return new Uint8Array(value.slice(0));
        }
        if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
            return new Uint8Array(value.buffer.slice(
                value.byteOffset,
                value.byteOffset + value.byteLength,
            ));
        }
        if (Array.isArray(value)) return Uint8Array.from(value);
        if (value && typeof value === 'object' && value.data !== undefined) {
            return cloneBinaryValue(value.data);
        }
        return null;
    }

    async function readBinaryValue(value) {
        const direct = cloneBinaryValue(value);
        if (direct) return direct;
        if (value && typeof value.arrayBuffer === 'function') {
            return cloneBinaryValue(await value.arrayBuffer());
        }
        return null;
    }

    function createMemoryFile(bytes, name, type = 'application/octet-stream') {
        const safeName = String(name || 'template.zip').split(/[\\/]/).pop() || 'template.zip';
        if (typeof File === 'function') {
            return new File([bytes], safeName, { type });
        }
        if (typeof Blob === 'function') {
            const blob = new Blob([bytes], { type });
            try {
                Object.defineProperty(blob, 'name', { value: safeName, configurable: true });
            } catch (_) {
                // Blob remains usable through arrayBuffer() when name is read-only.
            }
            return blob;
        }
        return null;
    }

    function setRelativePath(file, relativePath) {
        const path = String(relativePath || '').replace(/\\/g, '/').trim();
        if (!file || !path) return file;
        try {
            Object.defineProperty(file, 'webkitRelativePath', {
                value: path,
                configurable: true,
            });
            return file;
        } catch (_) {
            // Some browser File implementations expose a non-configurable
            // relative path.  A tiny read-only facade preserves the full path
            // so two same-named pages do not collapse to a basename guess.
            return {
                name: file.name || path.split('/').at(-1) || 'texture.png',
                size: file.size,
                type: file.type || 'image/png',
                webkitRelativePath: path,
                arrayBuffer: () => file.arrayBuffer(),
            };
        }
    }

    async function normalizeHostTextureFiles(values) {
        const result = [];
        for (const value of Array.from(values || [])) {
            if (value && typeof value.arrayBuffer === 'function') {
                result.push(value);
                continue;
            }
            const bytes = await readBinaryValue(value?.bytes ?? value?.data ?? value);
            if (!bytes) continue;
            const path = String(value?.path || value?.relativePath || value?.name || 'texture.png');
            const file = createMemoryFile(bytes, path, 'image/png');
            if (file) result.push(setRelativePath(file, path));
        }
        return result;
    }

    function incompleteTemplateError() {
        const error = new Error(t('emoteMaker.templateFolderIncomplete'));
        error.code = 'template_incomplete';
        return error;
    }

    function isIncompleteTemplateError(error) {
        return error?.code === 'template_incomplete';
    }

    async function hostTemplateFile(result) {
        const candidate = result?.file || result?.zip || result?.bytes || result?.data;
        if (candidate && typeof candidate.arrayBuffer === 'function' && candidate.name) {
            return candidate;
        }
        const bytes = await readBinaryValue(candidate);
        if (!bytes) return null;
        return createMemoryFile(
            bytes,
            result?.fileName || result?.filename || result?.name || 'template.zip',
            'application/zip',
        );
    }

    async function importTemplateDirectoryFromHost() {
        const bridge = window.nekoHost;
        if (!bridge || typeof bridge.pickTemplateDirectory !== 'function') return false;
        if (templateImportButton) templateImportButton.disabled = true;
        if (templateDirectoryButton) templateDirectoryButton.disabled = true;
        setTemplateImportStatus(t('emoteMaker.importingTemplate'));
        try {
            // 不给 startPath：桌面端会把对话框开在用户上次选过的目录，
            // 这里给了反而会盖掉它。界面只需要点一下确认。
            // （"记住上次目录"属于被本地副本取代的旧重开路径，这里只管新导入。）
            let result = await bridge.pickTemplateDirectory({
                title: t('emoteMaker.selectTemplateFolder'),
            });
            if (!result || result.cancelled) {
                setTemplateImportStatus(t('emoteMaker.templateFolderCancelled'), 'muted');
                return true;
            }
            if (result.complete === false || result.completeness?.complete === false) {
                throw incompleteTemplateError();
            }
            const file = await hostTemplateFile(result);
            if (!file) throw new Error(t('emoteMaker.importFailed'));
            let nextTextureFiles = textureCacheFiles;
            if (Array.isArray(result.textureFiles || result.textures)) {
                nextTextureFiles = await normalizeHostTextureFiles(result.textureFiles || result.textures);
            }
            await importTemplateFile(file, {
                textureFiles: nextTextureFiles,
                kind: 'directory',
                sourceName: result.folderName || '',
            });
            return true;
        } catch (error) {
            reportImportFailure(error);
            return true;
        } finally {
            if (templateImportButton) templateImportButton.disabled = false;
            if (templateDirectoryButton) templateDirectoryButton.disabled = false;
        }
    }

    /**
     * @returns {Promise<boolean>} 导入是否成功。重开（从副本/重新定位）依赖这个返回值
     * 决定要不要退回下一条路，所以失败路径也必须返回 false 而不是静默。
     */
    async function importTemplateFile(file, {
        displayName = '', textureFiles, kind = 'file', fromArchive = false, sourceName = '',
    } = {}) {
        if (!file) return false;
        lastImportKind = kind === 'directory' ? 'directory' : 'file';
        const nextTextureFiles = normalizeTextureCacheFiles(
            textureFiles === undefined ? textureCacheFiles : textureFiles,
        );
        if (templateImportButton) templateImportButton.disabled = true;
        if (templateDirectoryButton) templateDirectoryButton.disabled = true;
        setTemplateImportStatus(t('emoteMaker.importingTemplate'));
        let nextAssetStore = null;
        let committed = false;
        try {
            const formData = new FormData();
            formData.append('file', file, file.name || 'template.zip');
            const response = await fetch('/api/emote-maker/import/emotelab', {
                method: 'POST',
                body: formData,
                credentials: 'same-origin'
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok || !payload.success || !payload.package) {
                throw new Error(payload.error || t('emoteMaker.importFailed'));
            }
            if (!Array.isArray(payload.package.scenes) || !payload.package.scenes.length) {
                throw incompleteTemplateError();
            }
            const provider = window.NekoEmoteTemplateRegistry?.resolve(payload.package);
            if (!provider) {
                throw new Error(t('emoteMaker.importFailed'));
            }

            // Keep the selected ZIP local as an optional renderer asset store.
            // The metadata path remains authoritative and still works when
            // the optional decoder is unavailable; this bridge never writes
            // the archive to disk or localStorage.
            const clientStoreApi = window.NekoEmoteClientZipStore;
            const ClientZipAssetStore = clientStoreApi?.ClientZipAssetStore;
            if (ClientZipAssetStore && typeof ClientZipAssetStore.fromFile === 'function') {
                try {
                    const candidate = await ClientZipAssetStore.fromFile(file);
                    const missing = getTemplateAssetPaths(payload.package)
                        .filter((path) => !candidate.has(path));
                    if (!missing.length) {
                        nextAssetStore = buildTemplateAssetStore(candidate, nextTextureFiles);
                    } else {
                        candidate.release();
                    }
                } catch (_) {
                    // Metadata-only import is intentionally not blocked by a
                    // browser decoder failure. Native rendering will report
                    // the missing local asset store when it is requested.
                }
            }

            // Everything above is staged. Do not tear down the current
            // renderer/package until the new manifest and optional asset
            // store have passed validation, so a bad import is recoverable.
            const nextPackage = payload.package;
            const nextTemplateSkins = Array.isArray(nextPackage.character?.skins)
                ? nextPackage.character.skins.map((item) => ({ ...item }))
                : [];
            const nextTemplateSliders = Array.isArray(nextPackage.character?.sliders)
                ? nextPackage.character.sliders.map((item) => ({ ...item }))
                : [];
            const nextTemplateSlots = Array.isArray(nextPackage.character?.slots)
                ? nextPackage.character.slots.map((item) => ({
                    ...item,
                    tintColor: item?.tintColor ? { ...item.tintColor } : null,
                    tintBlackColor: item?.tintBlackColor ? { ...item.tintBlackColor } : null,
                }))
                : [];
            const nextTemplateSlotDefaults = nextTemplateSlots.map((item) => ({
                ...item,
                tintColor: item?.tintColor ? { ...item.tintColor } : null,
                tintBlackColor: item?.tintBlackColor ? { ...item.tintBlackColor } : null,
            }));
            const firstScene = Array.isArray(nextPackage.scenes) ? nextPackage.scenes[0] : null;

            const previousAssetStore = templateAssetStore;
            spineRendererGeneration += 1;
            disposeSpineRenderer();
            if (previousAssetStore && previousAssetStore !== nextAssetStore
                && !holdsTemplateStore(previousAssetStore)) {
                // 库里还留着这个模板的贴图，清了就得重新读盘才能切回去
                releaseAssetStore(previousAssetStore);
            }
            templatePackage = nextPackage;
            templateAssetStore = nextAssetStore;
            textureCacheFiles = nextTextureFiles;
            committed = true;
            if (nextAssetStore) {
                templatePackage.capabilities = {
                    ...(templatePackage.capabilities || {}),
                    localAssets: true,
                    assetTransport: 'client-memory'
                };
                if (textureCacheFiles.length) {
                    templatePackage.character = {
                        ...(templatePackage.character || {}),
                        customTextureCache: {
                            ...(templatePackage.character?.customTextureCache || {}),
                            provided: true,
                        },
                    };
                    templatePackage.model = {
                        ...(templatePackage.model || {}),
                        customTextureCache: {
                            ...(templatePackage.model?.customTextureCache || {}),
                            provided: true,
                        },
                    };
                }
            }
            state.sceneListFilter = '';
            state.templateSkins = nextTemplateSkins;
            state.templateSliders = nextTemplateSliders;
            state.templateSlots = nextTemplateSlots;
            state.templateSlotDefaults = nextTemplateSlotDefaults;
            state.templateSlotGroup = nextTemplateSlots[0]?.name || '';
            if (firstScene) {
                state.selectedSceneId = firstScene.id;
                state.selectedSceneListId = firstScene.source?.sceneList || '';
                state.animationId = firstScene.animation?.id || '';
            }
            // 组与取景属于某个模板：指纹对不上时 applyTemplateSession 会原样退回，
            // 不在这里清干净，新模板就会顶着旧模板的分组。
            state.groups = [];
            state.shots = [];
            state.groupId = '';
            state.sceneListFilter = '';
            // 多选集合里是上一个模板的动画 id，留着会把旧动作一起加进新模板的组
            setPickedAnimations([]);
            applyTemplateSession(nextPackage);
            if (!state.groupId) {
                const first = allGroups()[0];
                if (first) selectGroup(first.id);
            }
            state.animationPlaying = false;
            history.length = 0;
            future.length = 0;
            const warnings = Array.isArray(templatePackage.warnings)
                ? templatePackage.warnings.filter((warning) => !String(warning).includes('已忽略'))
                : [];
            const warningCount = warnings.length;
            // 成功不需要庆祝——只有警告值得占这一行，而且不带"模板已读取"前缀
            setTemplateImportStatus(
                warningCount ? presentTemplateWarning(warnings[0]) : '',
                warningCount ? 'warning' : 'success',
            );
            // 库条目要先落进 templateLibraryState 再 renderAll：网格画的是那份状态，
            // 顺序反了就会出现"模板已载入、卡片却还没画出来"的窗口（自动化和手快都会撞上）
            persistTemplateSession();
            rememberLoadedTemplate();
            persistTemplateToLibrary({ withThumb: true, sourceName });
            renderAll();
            // 导入即拷副本：在后台拷，别把界面卡住；失败要说话，不然用户会以为
            // 下次打开还能免定位。从副本恢复进来的那份不必再拷自己一遍。
            if (!fromArchive) {
                const archiveKey = currentTemplateKey();
                if (archiveKey) {
                    void persistTemplateArchive(archiveKey, file, nextTextureFiles).catch(() => {
                        showToast(t('emoteMaker.archiveSaveFailed'));
                    });
                }
            }
            void activateNativeSpineRenderer();
            return true;
        } catch (error) {
            // A staged asset store belongs to the failed candidate only. The
            // active package/renderer remains untouched when validation fails.
            if (!committed && nextAssetStore) releaseAssetStore(nextAssetStore);
            if (committed) {
                // 成功不走嘴：激活渲染器的那条状态行随后会说话（或带着警告说）
            } else {
                reportImportFailure(error);
                renderAll();
            }
            return committed;
        } finally {
            if (templateImportButton) templateImportButton.disabled = false;
            if (templateDirectoryButton) templateDirectoryButton.disabled = false;
            if (templateFileInput) templateFileInput.value = '';
        }
    }

    /** 目录导入的默认名＝文件夹名：来源是每个文件的 webkitRelativePath 第一段。 */
    function folderNameFromFiles(files) {
        for (const file of Array.from(files || [])) {
            const relative = String(file?.webkitRelativePath || '');
            const first = relative.split('/')[0];
            if (first) return first;
        }
        return '';
    }

    async function importTemplateDirectory(files) {
        const directoryApi = window.NekoEmoteTemplateDirectory;
        if (!directoryApi || typeof directoryApi.pack !== 'function' || typeof directoryApi.toFile !== 'function') {
            reportImportFailure(new Error(t('emoteMaker.importFailed')));
            return;
        }
        if (templateImportButton) templateImportButton.disabled = true;
        if (templateDirectoryButton) templateDirectoryButton.disabled = true;
        setTemplateImportStatus(t('emoteMaker.importingTemplate'));
        try {
            const selectedFiles = Array.from(files || []);
            const packed = await directoryApi.pack(selectedFiles, {
                filename: 'template-directory.zip',
            });
            if (packed.completeness && !packed.completeness.complete) {
                throw incompleteTemplateError();
            }
            // A selected data root may also contain a large external texture
            // cache. Keep those PNGs as the normal overlay instead of copying
            // them into the temporary ZIP and exceeding the package limit.
            const file = directoryApi.toFile(packed);
            await importTemplateFile(file, {
                textureFiles: packed.textureFiles || [],
                kind: 'directory',
                sourceName: folderNameFromFiles(selectedFiles),
            });
        } catch (error) {
            reportImportFailure(error);
        } finally {
            if (templateDirectoryInput) templateDirectoryInput.value = '';
            if (templateImportButton) templateImportButton.disabled = false;
            if (templateDirectoryButton) templateDirectoryButton.disabled = false;
        }
    }

    function resetView() {
        state.zoom = 1;
        state.adjustments = { x: 0, y: 0, rotation: 0, scale: 100 };
        renderAdjustments();
        applyZoom();
        void renderCanvas();
    }

    function bindViewportNavigation() {
        if (!canvasStage) return;
        canvasStage.addEventListener('wheel', (event) => {
            event.preventDefault();
            if (event.altKey) {
                updateAdjustment('rotation', state.adjustments.rotation + (event.deltaY > 0 ? 1 : -1));
                return;
            }
            state.zoom = Math.max(0.75, Math.min(1.18, state.zoom + (event.deltaY > 0 ? -0.04 : 0.04)));
            applyZoom();
        }, { passive: false });
    }

    function bindEvents() {
        document.querySelectorAll('.category-tab').forEach((button) => {
            button.addEventListener('click', () => {
                state.category = button.dataset.category || 'template';
                renderAll();
            });
        });
        document.querySelectorAll('.inspector-tab').forEach((button) => {
            button.addEventListener('click', () => setInspectorTab(button.dataset.inspectorTab || 'parts'));
        });
        $('#asset-search-input')?.addEventListener('input', (event) => {
            state.assetQuery = event.target.value || '';
            renderAssetGrid();
        });
        templateSceneListSelect?.addEventListener('change', (event) => {
            // 这个下拉现在是"组"：选导入组时 selectGroup 会写回 sceneListFilter，
            // 选自建组时改成按成员过滤。
            selectGroup(event.target.value);
        });
        bindCursorTips();
        $('#new-group-btn')?.addEventListener('click', () => {
            if (createGroup()) showToast(t('emoteMaker.groupCreated'));
        });
        $('#select-all-btn')?.addEventListener('click', () => {
            setPickedAnimations(getVisibleImportedAnimations().map((item) => item.id));
        });
        $('#select-none-btn')?.addEventListener('click', () => setPickedAnimations([]));
        $('#context-add-btn')?.addEventListener('click', () => {
            const added = addPickedToActiveGroup();
            hideGroupContextMenu();
            showToast(interpolate(t('emoteMaker.groupAddedCount'), { count: Math.max(added, 0) }));
        });
        $('#context-remove-btn')?.addEventListener('click', () => {
            const removed = removePickedFromActiveGroup();
            hideGroupContextMenu();
            showToast(interpolate(t('emoteMaker.groupRemovedCount'), { count: Math.max(removed, 0) }));
        });
        // 气泡和右键菜单一样：点外面、按 Esc 都要能关掉，否则卡在屏幕上比不给更烦
        window.addEventListener('pointerdown', (event) => {
            const menu = $('#group-context-menu');
            if (menu && !menu.hidden && !menu.contains(event.target)) hideGroupContextMenu();
            const picker = $('#group-export-picker');
            if (picker && !picker.hidden
                && !picker.contains(event.target)
                && !event.target.closest('#export-group-open-btn')) closeGroupPicker();
        }, true);
        window.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape') return;
            hideGroupContextMenu();
            closeGroupPicker();
        });
        $('#group-members')?.addEventListener('click', (event) => {
            // 加号在每次重绘里重建，监听挂委托：点在它或它里面的东西都算
            if (event.target.closest('#add-scene-to-group-btn')) addCurrentSceneToGroup();
        });
        $('#save-shot-btn')?.addEventListener('click', () => saveCurrentAsShot());
        $('#export-group-open-btn')?.addEventListener('click', () => {
            if (groupExportBusy) {
                // 同一颗按钮在跑的时候就是停止：一批最多 100 张，得能中途停
                groupExportAbort = true;
                return;
            }
            // aria-expanded 只由 renderGroupPicker 写：两处各写一份的话，
            // 一处漏了就成"按钮说它开着、气泡却没开"
            if (state.groupPickerOpen) closeGroupPicker();
            else openGroupPicker();
        });
        $('#model-preset-select')?.addEventListener('change', (event) => {
            showToast(t('emoteMaker.modelPreset'));
        });
        templateImportButton?.addEventListener('click', () => templateFileInput?.click());
        canvasImportButton?.addEventListener('click', () => templateFileInput?.click());
        templateFileInput?.addEventListener('change', (event) => {
            const file = event.target.files?.[0];
            void importTemplateFile(file);
        });
        templateDirectoryButton?.addEventListener('click', () => {
            // Desktop builds can read the selected folder's sibling resources
            // through the host bridge.  Web builds keep the normal directory
            // input as a privacy-safe fallback.
            if (window.nekoHost && typeof window.nekoHost.pickTemplateDirectory === 'function') {
                void importTemplateDirectoryFromHost();
                return;
            }
            templateDirectoryInput?.click();
        });
        templateDirectoryInput?.addEventListener('change', (event) => {
            void importTemplateDirectory(event.target.files || []);
        });
        $('#undo-btn')?.addEventListener('click', undo);
        $('#redo-btn')?.addEventListener('click', redo);
        // 曾经这里也绑列表分段：那时代码会把形象包的「基础/进阶」按钮一起选中，
        // 点它们顺手把 listMode 写回 'scenes'。列表只剩一种之后不再需要这个开关。
        $('#export-format')?.addEventListener('change', (event) => {
            state.exportFormat = event.target.value === 'gif' ? 'gif' : 'png';
            persistExportSettings();
            renderAll();
        });
        $('#export-resolution')?.addEventListener('change', (event) => {
            const value = Number(event.target.value);
            if (EXPORT_RESOLUTIONS.includes(value)) state.exportResolution = value;
            persistExportSettings();
            renderAll();
        });
        $('#export-fps')?.addEventListener('change', (event) => {
            const value = Number(event.target.value);
            if (EXPORT_FPS_VALUES.includes(value)) state.exportFps = value;
            persistExportSettings();
            renderAll();
        });
        $('#export-png-btn')?.addEventListener('click', () => {
            if (state.exportFormat === 'gif') {
                void downloadGif();
                return;
            }
            void downloadPng();
        });
        $('#open-state-stage-btn')?.addEventListener('click', () => { openStateStage(); });
        document.querySelectorAll('[data-pack-mode]').forEach((button) => {
            button.addEventListener('click', () => {
                state.packMode = button.dataset.packMode === 'graph' ? 'graph' : 'basic';
                persistLayout();
                renderAll();
            });
        });
        $('#pack-export-btn')?.addEventListener('click', () => { void downloadPngtuberPack(); });
        $('#pack-name')?.addEventListener('change', (event) => {
            state.packName = String(event.target.value || '').trim();
            persistExportSettings();
            renderPackPanel();
        });
        $('#pack-priority')?.addEventListener('change', (event) => {
            state.packPriority = event.target.value === 'emotion' ? 'emotion' : 'talking';
            persistExportSettings();
        });
        $('#pack-format')?.addEventListener('change', (event) => {
            state.packFormat = event.target.value === 'layered' ? 'layered' : 'flat';
            persistExportSettings();
            renderPackPanel();
        });
        $('#pack-import-btn')?.addEventListener('click', () => { void importPngtuberPack(); });
        const bindPackNumber = (selector, apply) => {
            const input = $(selector);
            if (!input) return;
            input.addEventListener('input', (event) => {
                apply(Number(event.target.value));
                // 只刷落位显示，不 renderAll —— 后者会重建整个形象包区块的 select，
                // 拖动过程中把焦点和拖动状态打断。
                syncExportControls();
            });
            input.addEventListener('change', () => persistExportSettings());
        };
        bindPackNumber('#pack-scale', (value) => { state.packScale = value; });
        bindPackNumber('#pack-offset-x', (value) => { state.packOffsetX = value; });
        bindPackNumber('#pack-offset-y', (value) => { state.packOffsetY = value; });
        $('#pack-mirror')?.addEventListener('change', (event) => {
            state.packMirror = event.target.checked === true;
            persistExportSettings();
            syncExportControls();
        });
        $('#pack-reset-btn')?.addEventListener('click', () => {
            state.packScale = 1;
            state.packOffsetX = 0;
            state.packOffsetY = 0;
            state.packMirror = false;
            persistExportSettings();
            syncExportControls();
        });
        $('#fit-btn')?.addEventListener('click', () => {
            state.zoom = 1;
            applyZoom();
        });
        $('#reset-view-btn')?.addEventListener('click', resetView);
        $('#zoom-in-btn')?.addEventListener('click', () => {
            state.zoom = Math.min(1.18, state.zoom + 0.05);
            applyZoom();
        });
        $('#zoom-out-btn')?.addEventListener('click', () => {
            state.zoom = Math.max(0.75, state.zoom - 0.05);
            applyZoom();
        });
        $('#custom-color-input')?.addEventListener('input', (event) => setSelectedColor(event.target.value));
        $('#secondary-color-input')?.addEventListener('input', (event) => {
            state.secondaryColor = event.target.value;
            applyNativeVisualState();
            void renderCanvas();
        });
        document.querySelectorAll('.color-mode-button').forEach((button) => {
            button.addEventListener('click', () => {
                recordChange(() => { state.colorMode = button.dataset.colorMode || 'default'; });
            });
        });
        $('#reset-color-btn')?.addEventListener('click', () => {
            if (templatePackage) {
                const before = cloneState();
                const defaults = Array.isArray(state.templateSlotDefaults)
                    ? state.templateSlotDefaults
                    : [];
                const selectedName = String(state.templateSlotGroup || '');
                const defaultSlot = defaults.find((item) => String(item?.name || '') === selectedName);
                const next = getTemplateSlotStyles();
                const target = next.find((item) => String(item?.name || '') === selectedName);
                if (target && defaultSlot) {
                    target.tintColor = defaultSlot.tintColor ? { ...defaultSlot.tintColor } : null;
                    target.tintBlackColor = defaultSlot.tintBlackColor ? { ...defaultSlot.tintBlackColor } : null;
                    state.templateSlots = next;
                    history.push(before);
                    future.length = 0;
                    applyNativeCharacterState({ render: true });
                    renderAll();
                }
                return;
            }
            recordChange(() => {
                state.colorMode = 'default';
                state.colors[state.selectedLayer] = DEFAULT_COLORS[state.selectedLayer] || DEFAULT_COLORS.expression;
                state.secondaryColor = '#2a4664';
            });
            applyNativeVisualState();
        });
        $('#adjust-overwrite')?.addEventListener('change', (event) => {
            state.adjustOverwrite = Boolean(event.target.checked);
            renderAdjustments();
            void renderCanvas();
        });
        ['x', 'y', 'rotation', 'scale'].forEach((key) => {
            const input = $(`#adjust-${key}`);
            input?.addEventListener('input', (event) => updateAdjustment(key, event.target.value));
        });
        $('#reset-adjustments-btn')?.addEventListener('click', () => {
            recordChange(() => { state.adjustments = { x: 0, y: 0, rotation: 0, scale: 100 }; });
            applyNativeVisualState();
        });
        $('#play-animation-btn')?.addEventListener('click', toggleAnimationPlayback);
        animationProgress?.addEventListener('input', (event) => {
            state.animationProgress = Number(event.target.value) || 0;
            updateAnimationControls();
            if (templatePackage && hasSpineRenderer()) syncNativeTimeFromProgress();
            void renderCanvas();
        });
        animationSpeed?.addEventListener('input', (event) => {
            state.animationSpeed = Number(event.target.value) || 1;
            updateAnimationControls();
        });
        $('#transparent-background')?.addEventListener('change', (event) => {
            state.exportTransparent = event.target.checked !== false;
            state.layerVisible.background = !state.exportTransparent;
            persistExportSettings();
            applyNativeVisualState();
            void renderCanvas();
        });
        bindViewportNavigation();
        $('#emote-maker-close')?.addEventListener('click', () => {
            if (window.opener && !window.opener.closed) {
                window.close();
            } else if (window.history.length > 1) {
                window.history.back();
            } else {
                window.location.assign('/');
            }
        });
        window.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
                event.preventDefault();
                if (event.shiftKey) redo(); else undo();
            }
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                if (state.exportFormat === 'gif') {
                    void downloadGif();
                } else {
                    void downloadPng();
                }
            }
        });
        window.addEventListener('localechange', renderAll);
        window.addEventListener('pagehide', () => {
            persistTemplateSession();
            spineRendererGeneration += 1;
            disposeSpineRenderer();
            releaseTemplateAssetStore();
            textureCacheFiles = [];
        }, { once: true });
    }

    function initialize() {
        if (!canvas) return;
        canvas.width = CANVAS_SIZE;
        canvas.height = CANVAS_SIZE;
        history.length = 0;
        future.length = 0;
        loadExportSettings();
        loadLayout();
        loadTemplateSession();
        loadTemplateLibrary();
        // 副本占用是后端 stat 的真实数字，页面起来就去拉一份
        void refreshTemplateArchiveSizes();
        loadNodeGraph();
        setTemplateImportStatus(t('emoteMaker.templateImportHint'), 'muted');
        bindEvents();
        setupResizing();
        applyLayout();
        renderAll();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        initialize();
    }
})();
