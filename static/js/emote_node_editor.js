/*
 * Blender-style node editor overlay for the Emote maker.
 *
 * Everything here is presentation + interaction; the graph *meaning* (what a node does,
 * which sockets exist, how a graph folds into bake parameters, what is a legal link) lives
 * in emote_node_graph.js and is unit-tested there. That split is deliberate: the previous
 * attempt at this feature shipped a static diagram, and a diagram has no model to test.
 *
 * Interaction contract, matching what the user asked for:
 *   - wheel: zoom around the cursor
 *   - drag empty canvas: pan
 *   - drag a node header: move it
 *   - drag from an output socket onto an input socket: connect (replaces that input's link)
 *   - click a link: remove it
 *   - Shift+A or 添加节点: palette, grouped by category
 *   - Delete: remove selected node (and its links)
 *   - Esc: close
 */
(function (root, factory) {
    'use strict';

    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./emote_node_graph.js'));
        return;
    }

    root.NekoEmoteNodeEditor = factory(root.NekoEmoteNodeGraph);
}(typeof window !== 'undefined' ? window : globalThis, function (GraphModel) {
    'use strict';

    const ZOOM_MIN = 0.35;
    const ZOOM_MAX = 2.4;
    const NODE_W = 232;
    const SOCKET_HIT = 7;

    function create(options) {
        const model = options.model;
        const host = options.host || document.body;
        const t = typeof options.t === 'function' ? options.t : (key) => key;
        const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
        const onClose = typeof options.onClose === 'function' ? options.onClose : () => {};
        const lookup = options.lookup || {};

        let graph = GraphModel.normalizeGraph(options.graph);
        let view = { x: 24, y: 16, zoom: 1 };
        let selected = null;
        let drag = null;
        let pendingLink = null;

        const overlay = document.createElement('div');
        overlay.className = 'ne-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-label', t('emoteMaker.nodeEditorTitle'));

        const head = document.createElement('div');
        head.className = 'ne-head';
        const title = document.createElement('h2');
        title.textContent = t('emoteMaker.nodeEditorTitle');
        const tools = document.createElement('div');
        tools.className = 'ne-tools';

        const makeTool = (labelKey, handler, extraClass) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'ne-tool' + (extraClass ? ' ' + extraClass : '');
            button.textContent = t(labelKey);
            button.addEventListener('click', handler);
            tools.appendChild(button);
            return button;
        };
        makeTool('emoteMaker.nodeAddNode', () => openPalette(null));
        makeTool('emoteMaker.nodeFitView', fitView);
        makeTool('emoteMaker.nodeResetGraph', () => {
            // 重置只替换内存里的图，落盘要等用户确认导出或关闭，避免误触清掉别人的工程。
            graph = GraphModel.defaultGraph();
            selected = null;
            commit();
        });
        const exportButton = makeTool('emoteMaker.nodeExportJson', exportJson);
        const importButton = makeTool('emoteMaker.nodeImportJson', () => fileInput.click());
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json,application/json';
        fileInput.className = 'visually-hidden';
        fileInput.addEventListener('change', () => {
            const file = fileInput.files && fileInput.files[0];
            if (file) importJson(file);
            fileInput.value = '';
        });
        makeTool('emoteMaker.nodeClose', () => onClose(), 'ne-tool-close');
        head.append(title, tools);

        const canvas = document.createElement('div');
        canvas.className = 'ne-canvas';
        const world = document.createElement('div');
        world.className = 'ne-world';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'ne-links');
        const tempPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        tempPath.setAttribute('class', 'ne-path ne-path-temp');
        const nodesLayer = document.createElement('div');
        nodesLayer.className = 'ne-nodes';
        world.append(svg, nodesLayer);
        canvas.append(world);

        const status = document.createElement('div');
        status.className = 'ne-status';
        status.setAttribute('role', 'status');
        overlay.append(head, canvas, status);
        host.appendChild(overlay);

        const nodeEls = new Map();

        function toWorld(clientX, clientY) {
            const box = canvas.getBoundingClientRect();
            return {
                x: (clientX - box.left - view.x) / view.zoom,
                y: (clientY - box.top - view.y) / view.zoom,
            };
        }

        function applyView() {
            world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`;
        }

        function socketPosition(nodeId, socketId, side) {
            const el = nodeEls.get(nodeId);
            if (!el) return null;
            const ports = side === 'in'
                ? el.querySelectorAll('.ne-port-in')
                : el.querySelectorAll('.ne-port-out');
            const list = Array.from(ports);
            const wanted = el.dataset.singlePort === 'true' ? list[0]
                : list.find((p) => p.dataset.socket === socketId) || list[0];
            if (!wanted) return null;
            const box = wanted.getBoundingClientRect();
            const canvasBox = canvas.getBoundingClientRect();
            return {
                x: (box.left + box.width / 2 - canvasBox.left - view.x) / view.zoom,
                y: (box.top + box.height / 2 - canvasBox.top - view.y) / view.zoom,
            };
        }

        function pathD(from, to) {
            const dx = Math.max(28, Math.abs(to.x - from.x) * 0.5);
            return `M ${from.x} ${from.y} C ${from.x + dx} ${from.y}, ${to.x - dx} ${to.y}, ${to.x} ${to.y}`;
        }

        function drawLinks() {
            const existing = Array.from(svg.querySelectorAll('.ne-path-link'));
            existing.forEach((el) => el.remove());
            graph.links.forEach((link, index) => {
                const from = socketPosition(link.from, link.fromSocket, 'out');
                const to = socketPosition(link.to, link.toSocket, 'in');
                if (!from || !to) return;
                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.setAttribute('class', 'ne-path ne-path-link');
                path.setAttribute('d', pathD(from, to));
                // 细线点不中，叠一条宽透明路径当命中区。
                path.setAttribute('stroke-width', '2');
                path.dataset.index = String(index);
                path.addEventListener('click', () => {
                    graph = GraphModel.removeLink(graph, link);
                    commit();
                });
                const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                hit.setAttribute('class', 'ne-path-hit');
                hit.setAttribute('d', pathD(from, to));
                hit.addEventListener('click', () => {
                    graph = GraphModel.removeLink(graph, link);
                    commit();
                });
                svg.append(hit, path);
            });
            svg.appendChild(tempPath);
        }

        function optionList(values, labels) {
            return values.map((value, index) => ({
                value,
                label: (labels && labels[value]) || value || t('emoteMaker.nodeNoOption'),
            }));
        }

        function buildWidget(spec, node) {
            const wrap = document.createElement('label');
            wrap.className = 'ne-field';
            const caption = document.createElement('span');
            caption.textContent = t(`emoteMaker.nodeParam.${spec.id}`) !== `emoteMaker.nodeParam.${spec.id}`
                ? t(`emoteMaker.nodeParam.${spec.id}`)
                : spec.id;
            wrap.appendChild(caption);

            const write = (value) => {
                node.params[spec.id] = GraphModel.normalizeParams(node.type, {
                    ...node.params,
                    [spec.id]: value,
                })[spec.id];
            };
            const current = node.params[spec.id];
            let input;
            switch (spec.widget) {
                case 'number':
                    input = document.createElement('input');
                    input.type = 'range';
                    input.min = String(spec.min);
                    input.max = String(spec.max);
                    input.step = String(spec.step);
                    input.value = String(current == null ? spec.default : current);
                    const readout = document.createElement('output');
                    readout.textContent = String(input.value);
                    input.addEventListener('input', () => {
                        readout.textContent = input.value;
                        write(Number(input.value));
                    });
                    input.addEventListener('change', () => commit(false));
                    wrap.append(input, readout);
                    return wrap;
                case 'checkbox':
                    input = document.createElement('input');
                    input.type = 'checkbox';
                    input.checked = current === true;
                    input.addEventListener('change', () => {
                        write(input.checked);
                        commit(false);
                    });
                    wrap.appendChild(input);
                    return wrap;
                case 'color':
                    input = document.createElement('input');
                    input.type = 'color';
                    input.value = current || spec.default;
                    input.addEventListener('change', () => {
                        write(input.value);
                        commit(false);
                    });
                    wrap.appendChild(input);
                    return wrap;
                case 'text':
                    input = document.createElement('input');
                    input.type = 'text';
                    input.value = current || '';
                    input.placeholder = spec.id === 'content' ? t('emoteMaker.nodeTextPlaceholder') : '';
                    // 文本走 change 而不是 input：每敲一个字符就重绘会吃掉焦点。
                    input.addEventListener('change', () => {
                        write(input.value);
                        commit(false);
                    });
                    wrap.appendChild(input);
                    return wrap;
                case 'select':
                case 'scene':
                case 'sliderName':
                case 'slotGroup':
                case 'state':
                case 'skins':
                    if (spec.widget === 'skins') {
                        wrap.appendChild(buildSkinList(node, spec));
                        return wrap;
                    }
                    input = document.createElement('select');
                    const sources = {
                        scene: lookup.scenes || [],
                        sliderName: lookup.sliderNames || [],
                        slotGroup: lookup.slotGroups || [],
                        state: lookup.states || [],
                    };
                    const source = sources[spec.widget] || [];
                    const labels = {};
                    source.forEach((item) => { labels[item.value] = item.label || item.value; });
                    const values = spec.widget === 'select'
                        ? optionList(spec.options, (lookup.optionLabels || {})[spec.id])
                        : optionList(source.map((item) => item.value), labels);
                    const blank = document.createElement('option');
                    blank.value = '';
                    blank.textContent = spec.widget === 'state' ? '' : t('emoteMaker.nodeNoOption');
                    if (spec.widget !== 'state') input.appendChild(blank);
                    values.forEach((entry) => {
                        const option = document.createElement('option');
                        option.value = entry.value;
                        option.textContent = entry.label;
                        input.appendChild(option);
                    });
                    input.value = current || '';
                    input.addEventListener('change', () => {
                        write(input.value);
                        commit(false);
                    });
                    wrap.appendChild(input);
                    return wrap;
                default:
                    return wrap;
            }
        }

        function buildSkinList(node, spec) {
            const box = document.createElement('div');
            box.className = 'ne-skin-list';
            const groups = lookup.skinGroups || [];
            const chosen = Array.isArray(node.params.groups) ? node.params.groups : [];
            groups.forEach((group) => {
                const row = document.createElement('label');
                row.className = 'ne-skin-row';
                const name = document.createElement('span');
                name.textContent = group.label || group.value;
                const select = document.createElement('select');
                const off = document.createElement('option');
                off.value = '';
                off.textContent = t('emoteMaker.nodeSkinFollow');
                select.appendChild(off);
                (group.values || []).forEach((value) => {
                    const option = document.createElement('option');
                    option.value = value;
                    option.textContent = value;
                    select.appendChild(option);
                });
                const existing = chosen.find((item) => item.group === group.value);
                select.value = existing ? existing.value : '';
                select.addEventListener('change', () => {
                    const next = (node.params.groups || []).filter((item) => item.group !== group.value);
                    if (select.value) next.push({ group: group.value, value: select.value });
                    node.params.groups = next;
                    commit(false);
                });
                row.append(name, select);
                box.appendChild(row);
            });
            if (!groups.length) {
                const hint = document.createElement('span');
                hint.className = 'ne-empty';
                hint.textContent = t('emoteMaker.nodeSkinNone');
                box.appendChild(hint);
            }
            return box;
        }

        function buildNode(node) {
            const definition = GraphModel.typeOf(node);
            const el = document.createElement('div');
            el.className = `ne-node ne-cat-${definition.category}` + (selected === node.id ? ' is-selected' : '');
            el.style.transform = `translate(${node.x}px, ${node.y}px)`;
            el.dataset.id = node.id;
            el.dataset.singlePort = 'true';

            const header = document.createElement('div');
            header.className = 'ne-node-head';
            const label = document.createElement('span');
            label.textContent = t(definition.titleKey);
            const kill = document.createElement('button');
            kill.type = 'button';
            kill.className = 'ne-node-kill';
            kill.setAttribute('aria-label', t('emoteMaker.nodeDelete'));
            kill.textContent = '✕';
            kill.addEventListener('click', (event) => {
                event.stopPropagation();
                graph = GraphModel.removeNode(graph, node.id);
                if (selected === node.id) selected = null;
                commit();
            });
            header.append(label, kill);

            const body = document.createElement('div');
            body.className = 'ne-node-body';
            definition.inputs.forEach((socket) => {
                const row = document.createElement('div');
                row.className = 'ne-port-row';
                const dot = document.createElement('span');
                dot.className = 'ne-port ne-port-in';
                dot.dataset.socket = socket.id;
                dot.dataset.node = node.id;
                const name = document.createElement('span');
                name.className = 'ne-port-name';
                name.textContent = t('emoteMaker.nodeSocketLook');
                row.append(dot, name);
                body.appendChild(row);
            });
            definition.params.forEach((spec) => body.appendChild(buildWidget(spec, node)));
            definition.outputs.forEach((socket) => {
                const row = document.createElement('div');
                row.className = 'ne-port-row ne-port-row-out';
                const dot = document.createElement('span');
                dot.className = 'ne-port ne-port-out';
                dot.dataset.socket = socket.id;
                dot.dataset.node = node.id;
                const hint = document.createElement('span');
                hint.className = 'ne-port-hint';
                hint.textContent = '⇢';
                row.append(hint, dot);
                body.appendChild(row);
            });

            el.append(header, body);
            header.addEventListener('pointerdown', (event) => startNodeDrag(event, node));
            el.addEventListener('pointerdown', (event) => {
                if (event.target.closest('.ne-port')) return;
                selected = node.id;
                refreshSelection();
            });
            return el;
        }

        function refreshSelection() {
            nodeEls.forEach((el, id) => el.classList.toggle('is-selected', id === selected));
        }

        function startNodeDrag(event, node) {
            event.preventDefault();
            event.stopPropagation();
            const start = toWorld(event.clientX, event.clientY);
            drag = { kind: 'node', node, dx: start.x - node.x, dy: start.y - node.y };
            selected = node.id;
            refreshSelection();
            overlay.setPointerCapture && overlay.setPointerCapture(event.pointerId);
        }

        function startSocketDrag(event, node, socketId, side) {
            event.preventDefault();
            event.stopPropagation();
            drag = { kind: 'link', node, socketId, side };
        }

        function onPointerMove(event) {
            if (!drag) return;
            if (drag.kind === 'node') {
                const point = toWorld(event.clientX, event.clientY);
                drag.node.x = Math.round(point.x - drag.dx);
                drag.node.y = Math.round(point.y - drag.dy);
                const el = nodeEls.get(drag.node.id);
                if (el) el.style.transform = `translate(${drag.node.x}px, ${drag.node.y}px)`;
                drawLinks();
                return;
            }
            if (drag.kind === 'link') {
                const from = drag.side === 'out'
                    ? socketPosition(drag.node.id, drag.socketId, 'out')
                    : toWorld(event.clientX, event.clientY);
                const to = drag.side === 'out'
                    ? toWorld(event.clientX, event.clientY)
                    : socketPosition(drag.node.id, drag.socketId, 'in');
                if (from && to) {
                    const a = drag.side === 'out' ? from : to;
                    const b = drag.side === 'out' ? to : from;
                    tempPath.setAttribute('d', pathD(a, b));
                    tempPath.classList.add('is-live');
                }
            }
        }

        function onPointerUp(event) {
            if (!drag) return;
            const active = drag;
            drag = null;
            tempPath.classList.remove('is-live');
            if (active.kind === 'node') {
                commit(true);
                return;
            }
            if (active.kind === 'link') {
                const target = document.elementFromPoint(event.clientX, event.clientY);
                const port = target && target.closest ? target.closest('.ne-port') : null;
                if (!port) return;
                const otherId = port.dataset.node;
                const otherNode = graph.nodes.find((n) => n.id === otherId);
                if (!otherNode) return;
                const before = JSON.stringify(graph);
                if (active.side === 'out') {
                    graph = GraphModel.addLink(graph, active.node.id, active.socketId, otherId, port.dataset.socket);
                } else {
                    graph = GraphModel.addLink(graph, otherId, port.dataset.socket, active.node.id, active.socketId);
                }
                if (JSON.stringify(graph) !== before) commit();
            }
        }

        function openPalette(event) {
            const menu = document.createElement('div');
            menu.className = 'ne-menu';
            const categories = ['source', 'modify', 'output'];
            categories.forEach((category) => {
                const heading = document.createElement('div');
                heading.className = 'ne-menu-head';
                heading.textContent = t(`emoteMaker.nodeCat.${category}`);
                menu.appendChild(heading);
                GraphModel.PALETTE.filter((type) => GraphModel.TYPES[type].category === category)
                    .forEach((type) => {
                        const item = document.createElement('button');
                        item.type = 'button';
                        item.className = 'ne-menu-item';
                        item.textContent = t(GraphModel.TYPES[type].titleKey);
                        item.addEventListener('click', () => {
                            const point = event ? toWorld(event.clientX, event.clientY) : { x: 120, y: 120 };
                            const created = GraphModel.makeNode(type, point.x, point.y, {});
                            if (!created) return;
                            graph = { ...graph, nodes: graph.nodes.concat([created]) };
                            selected = created.id;
                            menu.remove();
                            commit();
                        });
                        menu.appendChild(item);
                    });
            });
            menu.appendChild(Object.assign(document.createElement('button'), {
                type: 'button',
                className: 'ne-menu-item ne-menu-cancel',
                textContent: t('emoteMaker.nodeCancel'),
            })).addEventListener('click', () => menu.remove());
            if (event) {
                const box = canvas.getBoundingClientRect();
                menu.style.left = `${event.clientX - box.left}px`;
                menu.style.top = `${event.clientY - box.top}px`;
            }
            canvas.appendChild(menu);
            const dismiss = (downEvent) => {
                if (!menu.contains(downEvent.target)) {
                    menu.remove();
                    document.removeEventListener('pointerdown', dismiss, true);
                }
            };
            document.addEventListener('pointerdown', dismiss, true);
        }

        function fitView() {
            if (!graph.nodes.length) return;
            const box = canvas.getBoundingClientRect();
            const xs = graph.nodes.map((n) => n.x);
            const ys = graph.nodes.map((n) => n.y);
            const minX = Math.min(...xs) - 20;
            const minY = Math.min(...ys) - 20;
            const maxX = Math.max(...xs) + NODE_W + 20;
            const maxY = Math.max(...ys) + 180;
            // 只缩小、不放大：节点少的时候按内容铺满会把画布撑到 240%，反而看不到全局。
            const zoom = Math.min(
                1,
                Math.max(ZOOM_MIN, Math.min(box.width / (maxX - minX), box.height / (maxY - minY))),
            );
            view.zoom = zoom;
            view.x = (box.width - (maxX - minX) * zoom) / 2 - minX * zoom;
            view.y = (box.height - (maxY - minY) * zoom) / 2 - minY * zoom;
            applyView();
            drawLinks();
        }

        function exportJson() {
            const payload = JSON.stringify({ ...graph, exportedAt: Date.now() }, null, 2);
            const blob = new Blob([payload], { type: 'application/json' });
            if (typeof options.download === 'function') {
                options.download(blob, 'neko-emote-nodes.json');
            }
        }

        function importJson(file) {
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const parsed = JSON.parse(String(reader.result));
                    const next = GraphModel.normalizeGraph(parsed);
                    if (!next.nodes.length) {
                        setStatus(t('emoteMaker.nodeImportEmpty'), true);
                        return;
                    }
                    graph = next;
                    selected = null;
                    commit();
                } catch (_) {
                    setStatus(t('emoteMaker.nodeImportBad'), true);
                }
            };
            reader.readAsText(file);
        }

        function setStatus(text, isWarning) {
            status.textContent = text || '';
            status.classList.toggle('is-warning', Boolean(isWarning));
        }

        function render() {
            nodesLayer.replaceChildren();
            nodeEls.clear();
            graph.nodes.forEach((node) => {
                const definition = GraphModel.typeOf(node);
                if (!definition) return;
                const el = buildNode(node);
                nodeEls.set(node.id, el);
                nodesLayer.appendChild(el);
            });
            nodeEls.forEach((el) => {
                el.querySelectorAll('.ne-port').forEach((port) => {
                    port.addEventListener('pointerdown', (event) => {
                        const node = graph.nodes.find((n) => n.id === port.dataset.node);
                        if (!node) return;
                        startSocketDrag(event, node, port.dataset.socket,
                            port.classList.contains('ne-port-out') ? 'out' : 'in');
                    });
                });
            });
            drawLinks();
            const outputs = graph.nodes.filter((n) => GraphModel.typeOf(n).category === 'output');
            const evaluated = GraphModel.evaluate(graph, {});
            if (evaluated.cycle) {
                setStatus(t('emoteMaker.nodeCycleWarning'), true);
            } else {
                setStatus(t('emoteMaker.nodeSummary')
                    .replace('{nodes}', String(graph.nodes.length))
                    .replace('{links}', String(graph.links.length))
                    .replace('{outputs}', String(outputs.length)), outputs.length === 0);
            }
        }

        function commit(skipRender) {
            if (!skipRender) render();
            else refreshSelection();
            onChange(GraphModel.normalizeGraph(graph));
        }

        canvas.addEventListener('pointerdown', (event) => {
            if (event.target.closest('.ne-node') || event.target.closest('.ne-menu')) return;
            drag = {
                kind: 'pan',
                startX: event.clientX - view.x,
                startY: event.clientY - view.y,
            };
            selected = null;
            refreshSelection();
        });
        canvas.addEventListener('wheel', (event) => {
            event.preventDefault();
            const before = toWorld(event.clientX, event.clientY);
            const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
            view.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.zoom * factor));
            const after = toWorld(event.clientX, event.clientY);
            view.x += (after.x - before.x) * view.zoom;
            view.y += (after.y - before.y) * view.zoom;
            applyView();
            drawLinks();
        }, { passive: false });
        canvas.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            openPalette(event);
        });
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        const onKey = (event) => {
            if (event.key === 'Escape') {
                onClose();
                return;
            }
            const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
            if ((event.shiftKey || event.ctrlKey) && event.code === 'KeyA') {
                event.preventDefault();
                openPalette(null);
                return;
            }
            if (typing) return;
            if ((event.key === 'Delete' || event.key === 'Backspace') && selected) {
                event.preventDefault();
                graph = GraphModel.removeNode(graph, selected);
                selected = null;
                commit();
            }
        };
        document.addEventListener('keydown', onKey);

        applyView();
        render();
        requestAnimationFrame(fitView);

        return {
            element: overlay,
            getGraph: () => GraphModel.normalizeGraph(graph),
            setGraph: (next) => {
                graph = GraphModel.normalizeGraph(next);
                selected = null;
                commit();
            },
            containsPoint(clientX, clientY) {
                const box = canvas.getBoundingClientRect();
                return clientX >= box.left && clientX <= box.right
                    && clientY >= box.top && clientY <= box.bottom;
            },
            // 画布高亮 + 在指定屏幕位置落一个场景节点。列表里长按拖出来的东西就落在这。
            setDropHighlight(on) {
                canvas.classList.toggle('is-drop-target', Boolean(on));
            },
            addSceneNodeAt(sceneId, clientX, clientY) {
                const box = canvas.getBoundingClientRect();
                const point = (clientX == null || clientY == null)
                    ? { x: 80, y: 80 }
                    : toWorld(clientX, clientY);
                const created = GraphModel.makeNode(
                    'source.scene',
                    Math.round(point.x - NODE_W / 2),
                    Math.round(point.y - 14),
                    { sceneId },
                );
                if (!created) return false;
                graph = { ...graph, nodes: graph.nodes.concat([created]) };
                selected = created.id;
                commit();
                return true;
            },
            dispose: () => {
                document.removeEventListener('pointermove', onPointerMove);
                document.removeEventListener('pointerup', onPointerUp);
                document.removeEventListener('keydown', onKey);
                overlay.remove();
            },
        };
    }

    return Object.freeze({ create, ZOOM_MIN, ZOOM_MAX });
}));
