(function () {
    'use strict';

    function hexToRgba(hex, alpha) {
        const clean = hex.replace('#', '');
        const num = parseInt(clean, 16);
        const r = (num >> 16) & 255;
        const g = (num >> 8) & 255;
        const b = num & 255;
        return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }

    function mixHexColors(from, to, amount) {
        const a = parseInt(from.replace('#', ''), 16);
        const b = parseInt(to.replace('#', ''), 16);
        return '#' + [16, 8, 0].map(function (shift) {
            const value = Math.round(((a >> shift) & 255) * (1 - amount) + ((b >> shift) & 255) * amount);
            return value.toString(16).padStart(2, '0');
        }).join('');
    }

    function tr(key, fallback, vars) {
        if (typeof window.t === 'function') {
            try {
                const res = window.t(key, vars);
                if (res && res !== key) return res;
            } catch (_e) {
                // fallback
            }
        }
        let text = fallback || key;
        if (vars && typeof vars === 'object') {
            Object.keys(vars).forEach(function (k) {
                text = text.replace(new RegExp('\\{\\{' + k + '\\}\\}', 'g'), String(vars[k]));
            });
        }
        return text;
    }

    function mount(hostEl, data, opts) {
        if (!hostEl || !data) return;
        const options = opts || {};
        hostEl.textContent = '';
        hostEl.classList.add('starmap-surface');
        hostEl.classList.remove('is-expanded');
        let expanded = false;

        // Cold-start honest progress view when < min_required embedded entries
        if (!data.ready) {
            const cur = Number(data.embedded_count || 0);
            const need = Number(data.min_required || 15);
            const pct = Math.max(4, Math.min(100, Math.round((cur / Math.max(1, need)) * 100)));

            const wrap = document.createElement('div');
            wrap.className = 'starmap-coldstart';
            wrap.setAttribute('role', 'status');
            const title = document.createElement('div');
            title.className = 'starmap-coldstart-title';
            title.textContent = tr(
                'memory.starMapColdStartTitle',
                '正在点亮你们的记忆星图（已点亮 {{cur}} / {{need}} 颗星）',
                { cur: cur, need: need }
            );
            const desc = document.createElement('p');
            desc.className = 'starmap-coldstart-desc';
            desc.textContent = tr(
                'memory.starMapColdStartDesc',
                '等日常对话再沉淀几段珍贵记忆，这里就会自然汇聚成一片属于你们的主题星云。'
            );
            const bar = document.createElement('div');
            bar.className = 'starmap-progress-track';
            const fill = document.createElement('div');
            fill.className = 'starmap-progress-fill';
            fill.style.width = pct + '%';
            bar.appendChild(fill);

            wrap.appendChild(title);
            wrap.appendChild(bar);
            wrap.appendChild(desc);
            hostEl.appendChild(wrap);
            return {
                setExpanded: function (value) {
                    expanded = Boolean(value);
                    hostEl.classList.toggle('is-expanded', expanded);
                    if (!expanded && typeof options.onCollapseComplete === 'function') options.onCollapseComplete();
                },
                unmount: function () {},
            };
        }

        const points = Array.isArray(data.points) ? data.points : [];
        const clusters = Array.isArray(data.clusters) ? data.clusters : [];
        const previewBounds = points.reduce(function (bounds, point) {
            bounds.minX = Math.min(bounds.minX, point.x);
            bounds.maxX = Math.max(bounds.maxX, point.x);
            bounds.minY = Math.min(bounds.minY, point.y);
            bounds.maxY = Math.max(bounds.maxY, point.y);
            return bounds;
        }, { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity });
        if (!points.length) Object.assign(previewBounds, { minX: 0, maxX: 0, minY: 0, maxY: 0 });
        const pointByUid = {};
        points.forEach(function (p) { pointByUid[p.uid] = p; });
        const clusterById = {};
        clusters.forEach(function (c) { clusterById[c.id] = c; });
        const pointPhases = new Map();
        const edges = [];
        const edgeKeys = new Set();
        points.forEach(function (point) {
            let hash = 0;
            for (const char of String(point.uid)) hash = (hash * 31 + char.codePointAt(0)) | 0;
            pointPhases.set(point.uid, (hash >>> 0) / 4294967295 * Math.PI * 2);
            (point.neighbors || []).forEach(function (uid) {
                if (!pointByUid[uid] || uid === point.uid) return;
                const key = JSON.stringify([point.uid, uid].sort());
                if (edgeKeys.has(key)) return;
                edgeKeys.add(key);
                edges.push({ from: point, to: pointByUid[uid] });
            });
        });
        const ambientEdgeStep = Math.max(1, Math.ceil(edges.length / 240));
        const nearestEdges = new Map();
        edges.forEach(function (edge) {
            const distance = Math.hypot(edge.from.x - edge.to.x, edge.from.y - edge.to.y);
            if (distance > 0.45) return;
            [edge.from.uid, edge.to.uid].forEach(function (uid) {
                const current = nearestEdges.get(uid);
                if (!current || distance < current.distance) nearestEdges.set(uid, { edge: edge, distance: distance });
            });
        });
        const previewEdges = new Set(Array.from(nearestEdges.values(), function (entry) { return entry.edge; }));
        let mapColor = '#5c6f7e';
        let mapInkColor = '#1f2a36';
        let accentColor = '#147ea6';
        function updateColors() {
            const style = getComputedStyle(hostEl);
            mapColor = style.getPropertyValue('--memory-text-secondary').trim() || '#5c6f7e';
            mapInkColor = style.getPropertyValue('--memory-text').trim() || '#1f2a36';
            accentColor = style.getPropertyValue('--memory-accent-foreground').trim() || '#147ea6';
        }
        updateColors();

        const layout = document.createElement('div');
        layout.className = 'starmap-layout';

        const stage = document.createElement('div');
        stage.className = 'starmap-stage';

        const canvas = document.createElement('canvas');
        canvas.className = 'starmap-canvas';
        canvas.tabIndex = 0;
        canvas.setAttribute('role', 'button');
        canvas.setAttribute('aria-expanded', 'false');
        canvas.setAttribute('aria-busy', 'false');
        canvas.setAttribute('aria-label', tr('memory.starMapTitle', '专属记忆星图'));
        canvas.setAttribute('aria-describedby', 'starmap-explore-hint');
        stage.appendChild(canvas);

        const hint = document.createElement('p');
        hint.id = 'starmap-explore-hint';
        hint.className = 'starmap-explore-hint';
        hint.textContent = tr('memory.starMapClickHint', '悬停星星预览，点击展开并定位；展开后可拖动或滚轮探索。');
        stage.appendChild(hint);

        const tooltip = document.createElement('div');
        tooltip.className = 'starmap-tooltip';
        tooltip.setAttribute('role', 'tooltip');
        tooltip.hidden = true;
        stage.appendChild(tooltip);

        const controls = document.createElement('div');
        controls.className = 'starmap-canvas-controls';
        const resetBtn = document.createElement('button');
        resetBtn.type = 'button';
        resetBtn.className = 'memory-pill-btn is-sm';
        resetBtn.textContent = tr('memory.starMapResetView', '重置视角');
        controls.appendChild(resetBtn);
        stage.appendChild(controls);

        const detail = document.createElement('aside');
        detail.className = 'starmap-detail-card';
        detail.setAttribute('aria-live', 'polite');
        detail.hidden = true;

        layout.appendChild(stage);
        stage.appendChild(detail);
        hostEl.appendChild(layout);

        // Theme navigation floats above the full-size canvas.
        const legendDots = [];
        let legend = null;
        if (clusters.length) {
            legend = document.createElement('div');
            legend.className = 'starmap-legend';
            clusters.forEach(function (c) {
                const pill = document.createElement('button');
                pill.type = 'button';
                pill.className = 'starmap-legend-pill';
                pill.setAttribute('aria-pressed', 'false');
                const dot = document.createElement('span');
                dot.className = 'starmap-legend-dot';
                dot.style.background = mapColor;
                legendDots.push({ node: dot, button: pill, clusterId: c.id });
                const txt = document.createElement('span');
                txt.textContent = c.label + ' (' + c.count + ')';
                pill.appendChild(dot);
                pill.appendChild(txt);
                pill.addEventListener('click', function () {
                    const medoid = pointByUid[c.medoid_uid] || points.find(function (p) { return p.cluster_id === c.id; });
                    if (medoid) {
                        selectPoint(medoid);
                    }
                });
                legend.appendChild(pill);
            });
            if (options.legendHost) options.legendHost.appendChild(legend);
            else hostEl.insertBefore(legend, layout);
        }

        // Camera state
        let scale = 1.0;
        let offsetX = 0;
        let offsetY = 0;
        let hoveredUid = null;
        let selectedUid = null;
        let keyboardIndex = -1;
        let cameraFrame = null;
        let ambientFrame = null;
        let lastAmbientDraw = 0;
        let motionTime = 0;
        let stageVisible = true;
        let mounted = true;
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
        let isDragging = false;
        let dragMoved = false;
        let dragStartX = 0;
        let dragStartY = 0;
        let dragOrigOffsetX = 0;
        let dragOrigOffsetY = 0;
        const previewRoot = options.interactionRoot || hostEl.closest('#memory-panel-imprint') || hostEl;
        let tiltX = 0;
        let tiltY = 0;
        let targetTiltX = 0;
        let targetTiltY = 0;
        let lastTiltFrame = 0;
        let pressedPreviewUid = null;
        let previewDownX = 0;
        let previewDownY = 0;
        let viewTransition = null;
        let previewBlend = 1;
        let correctionMix = 0;
        const cameraCorrections = new Map();
        const previewVisibility = new Map();

        function expandedRadius(size) {
            return Math.max(40, Math.min(size.width / 2 - 42, size.height / 2 - 42));
        }

        function previewProjection(width, height) {
            // PCA centers the average, not the visible bounds. Fit the actual cloud to the corner.
            const spanX = previewBounds.maxX - previewBounds.minX;
            const spanY = previewBounds.maxY - previewBounds.minY;
            const radius = Math.min(Math.max(1, width * 0.55 - 12) / Math.max(0.4, spanX),
                Math.max(1, height * 0.7 - 12) / Math.max(0.4, spanY));
            return {
                x: 12 - previewBounds.minX * radius,
                y: 12 - previewBounds.minY * radius,
                radius: radius,
                centerX: 12 + spanX * radius / 2,
                centerY: 12 + spanY * radius / 2,
                reach: Math.max(spanX, spanY) * radius / 2 + 70,
            };
        }

        function captureView() {
            const size = stageSize();
            const rect = canvas.getBoundingClientRect();
            const origin = worldToScreen(0, 0, size.width, size.height);
            const unit = worldToScreen(1, 0, size.width, size.height);
            return {
                x: rect.left + origin[0], y: rect.top + origin[1], radius: unit[0] - origin[0],
                rect: rect, preview: !expanded, blend: previewBlend,
                selectedUid: selectedUid,
                detailScroll: detail.querySelector('.starmap-detail-body')?.scrollTop || 0,
                points: new Map(points.map(function (entry) {
                    const pos = pointScreen(entry, size.width, size.height);
                    return [entry.uid, [rect.left + pos[0], rect.top + pos[1]]];
                })),
            };
        }

        function updatePreviewVisibility(source) {
            const rect = source && source.preview ? source.rect : (options.getPreviewFrame ? options.getPreviewFrame() : null);
            if (!rect) return;
            const projection = previewProjection(rect.width, rect.height);
            points.forEach(function (entry) {
                const saved = source && source.preview ? source.points.get(entry.uid) : null;
                const x = saved ? saved[0] - rect.left : projection.x + entry.x * projection.radius;
                const y = saved ? saved[1] - rect.top : projection.y + entry.y * projection.radius;
                const distance = Math.hypot((x - rect.width * 0.24) / (rect.width * 0.52),
                    (y - rect.height * 0.3) / (rect.height * 0.78));
                const stops = [[0.2, 1], [0.42, 0.9], [0.68, 0.28], [1, 0]];
                let alpha = distance <= stops[0][0] ? 1 : 0;
                for (let index = 1; index < stops.length; index += 1) {
                    if (distance > stops[index - 1][0] && distance <= stops[index][0]) {
                        const from = stops[index - 1];
                        const to = stops[index];
                        alpha = from[1] + (to[1] - from[1]) * (distance - from[0]) / (to[0] - from[0]);
                    }
                }
                previewVisibility.set(entry.uid, alpha);
            });
        }

        function restoreCameraFrame(source) {
            const size = stageSize();
            const rect = canvas.getBoundingClientRect();
            scale = source.radius / expandedRadius(size);
            offsetX = source.x - rect.left - size.width / 2;
            offsetY = source.y - rect.top - size.height / 2;
            cameraCorrections.clear();
            correctionMix = 0;
            points.forEach(function (entry) {
                const old = source.points.get(entry.uid);
                if (!old) return;
                const pos = pointScreen(entry, size.width, size.height);
                cameraCorrections.set(entry.uid, [old[0] - rect.left - pos[0], old[1] - rect.top - pos[1]]);
            });
            correctionMix = 1;
        }

        function finishCollapse() {
            expanded = false;
            viewTransition = null;
            scale = 1;
            offsetX = offsetY = 0;
            previewBlend = 1;
            correctionMix = 0;
            cameraCorrections.clear();
            selectedUid = hoveredUid = null;
            keyboardIndex = -1;
            canvas.setAttribute('aria-expanded', 'false');
            hostEl.classList.remove('is-expanded');
            renderDetail(null);
            if (typeof options.onCollapseComplete === 'function') options.onCollapseComplete();
            draw();
            updateAmbientAnimation();
        }

        function closeToPreview() {
            if (!options.getPreviewFrame) {
                finishCollapse();
                return;
            }
            const target = options.getPreviewFrame();
            const rect = canvas.getBoundingClientRect();
            const size = stageSize();
            const projection = previewProjection(target.width, target.height);
            moveCamera({
                scale: projection.radius / expandedRadius(size),
                x: target.left + projection.x - rect.left - size.width / 2,
                y: target.top + projection.y - rect.top - size.height / 2,
                preview: 1,
            }, true);
        }

        function setExpanded(value, point, source, restoreView) {
            if (!value && !expanded) {
                draw();
                updateAmbientAnimation();
                return;
            }
            stopCameraAnimation();
            isDragging = false;
            canvas.style.cursor = 'grab';
            tiltX = tiltY = targetTiltX = targetTiltY = 0;
            pressedPreviewUid = null;
            previewRoot.classList.remove('is-starmap-hovering');
            selectedUid = null;
            hoveredUid = null;
            tooltip.hidden = true;
            if (!value) {
                viewTransition = 'closing';
                detail.inert = true;
                updatePreviewVisibility();
                closeToPreview();
                return;
            }
            expanded = true;
            viewTransition = 'opening';
            keyboardIndex = -1;
            previewBlend = source ? source.blend : 1;
            canvas.setAttribute('aria-expanded', 'true');
            hostEl.classList.add('is-expanded');
            renderDetail(null);
            if (source) restoreCameraFrame(source);
            updatePreviewVisibility(source);
            const selected = point || (restoreView && source && pointByUid[source.selectedUid]);
            if (selected) selectPoint(selected, restoreView);
            if (restoreView && source) {
                const body = detail.querySelector('.starmap-detail-body');
                if (body) body.scrollTop = source.detailScroll || 0;
                moveCamera({ scale: scale, x: offsetX, y: offsetY }, false);
            } else if (!selected) moveCamera({ scale: 1, x: 0, y: 0 }, true);
            updateAmbientAnimation();
        }

        function updateAmbientAnimation() {
            if (reducedMotion.matches || document.hidden) {
                tiltX = tiltY = targetTiltX = targetTiltY = 0;
            }
            if (document.hidden && !expanded) clearPreview();
            if (!mounted || !stageVisible || document.hidden || reducedMotion.matches) {
                if (ambientFrame !== null) window.cancelAnimationFrame(ambientFrame);
                ambientFrame = null;
                if (mounted && stageVisible && !document.hidden) draw();
                return;
            }
            if (ambientFrame === null) ambientFrame = window.requestAnimationFrame(ambientTick);
        }

        function ambientTick(now) {
            ambientFrame = null;
            if (!mounted || !stageVisible || document.hidden || reducedMotion.matches) return;
            const delta = Math.min(64, Math.max(1, now - lastTiltFrame));
            lastTiltFrame = now;
            const tiltMoving = !expanded && (Math.abs(targetTiltX - tiltX) + Math.abs(targetTiltY - tiltY) > 0.00003);
            if (tiltMoving) {
                const blend = 1 - Math.exp(-delta / 110);
                tiltX += (targetTiltX - tiltX) * blend;
                tiltY += (targetTiltY - tiltY) * blend;
            } else {
                tiltX = targetTiltX;
                tiltY = targetTiltY;
            }
            if (tiltMoving || now - lastAmbientDraw >= (expanded ? 40 : 80)) {
                if (cameraFrame === null) draw(now);
                lastAmbientDraw = now;
            }
            ambientFrame = window.requestAnimationFrame(ambientTick);
        }

        function pointScreen(point, width, height) {
            const pos = worldToScreen(point.x, point.y, width, height);
            if (!reducedMotion.matches) {
                const phase = pointPhases.get(point.uid) || 0;
                const drift = expanded ? 1.4 : 0.8;
                pos[0] += Math.sin(motionTime * 0.14 + phase) * drift;
                pos[1] += Math.cos(motionTime * 0.11 + phase * 1.3) * drift;
            }
            if (!expanded && (tiltX || tiltY)) {
                const projection = previewProjection(width, height);
                const cx = projection.centerX;
                const cy = projection.centerY;
                const x = pos[0] - cx;
                const y = pos[1] - cy;
                const z = y * Math.sin(tiltX);
                const depth = z * Math.cos(tiltY) - x * Math.sin(tiltY);
                const cameraDistance = Math.max(500, projection.reach * 10);
                const perspective = cameraDistance / (cameraDistance - depth);
                pos[0] = cx + (x * Math.cos(tiltY) + z * Math.sin(tiltY)) * perspective + tiltY * 55;
                pos[1] = cy + y * Math.cos(tiltX) * perspective - tiltX * 55;
            }
            const correction = expanded && correctionMix ? cameraCorrections.get(point.uid) : null;
            if (correction) {
                pos[0] += correction[0] * correctionMix;
                pos[1] += correction[1] * correctionMix;
            }
            return pos;
        }

        function stageSize() {
            return {
                width: Math.max(1, stage.clientWidth),
                height: Math.max(1, stage.clientHeight),
            };
        }

        function stopCameraAnimation() {
            if (cameraFrame !== null) {
                window.cancelAnimationFrame(cameraFrame);
                cameraFrame = null;
            }
            canvas.setAttribute('aria-busy', 'false');
        }

        function moveCamera(target, animate) {
            stopCameraAnimation();
            const from = { scale: scale, x: offsetX, y: offsetY, preview: previewBlend, correction: correctionMix };
            const started = performance.now();
            const duration = viewTransition === 'closing' ? 360 : (viewTransition === 'opening' ? 480 : 420);
            canvas.setAttribute('aria-busy', 'true');
            function frame(now) {
                if (!mounted) return;
                const progress = !animate || reducedMotion.matches ? 1 : Math.min(1, (now - started) / duration);
                const eased = 1 - Math.pow(1 - progress, 3);
                scale = from.scale + (target.scale - from.scale) * eased;
                offsetX = from.x + (target.x - from.x) * eased;
                offsetY = from.y + (target.y - from.y) * eased;
                previewBlend = from.preview + ((target.preview || 0) - from.preview) * eased;
                correctionMix = from.correction * (1 - eased);
                draw(now);
                cameraFrame = progress < 1 ? window.requestAnimationFrame(frame) : null;
                if (progress === 1) {
                    canvas.setAttribute('aria-busy', 'false');
                    if (viewTransition === 'closing') finishCollapse();
                    else viewTransition = null;
                }
            }
            frame(started);
        }

        function focusPoint(point, animate) {
            const size = stageSize();
            const rect = stage.getBoundingClientRect();
            const detailRect = detail.getBoundingClientRect();
            const targetScale = Math.max(2.4, scale);
            const radius = expandedRadius(size);
            // Keep the selected star in the open part of the sky, clear of its floating details.
            const stacked = detailRect.width > size.width * 0.65;
            const toolbarBottom = parseFloat(getComputedStyle(hostEl).getPropertyValue('--starmap-toolbar-bottom')) || 0;
            const centerX = stacked ? size.width / 2 : Math.max(60, (detailRect.left - rect.left) / 2);
            const centerY = stacked ? Math.max(toolbarBottom, (toolbarBottom + detailRect.top - rect.top) / 2) : size.height / 2;
            moveCamera({
                scale: targetScale,
                x: centerX - size.width / 2 - point.x * radius * targetScale,
                y: centerY - size.height / 2 - point.y * radius * targetScale,
            }, animate);
        }

        function resetView(restoreFocus) {
            selectedUid = null;
            hoveredUid = null;
            keyboardIndex = -1;
            tooltip.hidden = true;
            renderDetail(null);
            moveCamera({ scale: 1, x: 0, y: 0 }, true);
            if (restoreFocus) canvas.focus({ preventScroll: true });
        }

        function worldToScreen(wx, wy, w, h) {
            if (!expanded) {
                const projection = previewProjection(w, h);
                return [projection.x + wx * projection.radius, projection.y + wy * projection.radius];
            }
            const pad = 42;
            const halfW = Math.max(40, (w / 2) - pad);
            const halfH = Math.max(40, (h / 2) - pad);
            const r = Math.min(halfW, halfH);
            return [
                (w / 2) + offsetX + (wx * r * scale),
                (h / 2) + offsetY + (wy * r * scale),
            ];
        }

        function draw(now) {
            if (!mounted) return;
            motionTime = reducedMotion.matches ? 0 : (typeof now === 'number' ? now : performance.now()) / 1000;
            const size = stageSize();
            const w = size.width;
            const h = size.height;
            const openness = expanded ? 1 - previewBlend : 0;
            canvas.style.setProperty('--starmap-edge-strength', String(openness));
            const graphColor = mixHexColors(mapColor, mapInkColor, openness);
            const dpr = Math.min(window.devicePixelRatio || 1, 2);

            if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
                canvas.width = Math.round(w * dpr);
                canvas.height = Math.round(h * dpr);
            }

            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            ctx.save();
            ctx.scale(dpr, dpr);
            ctx.clearRect(0, 0, w, h);

            legendDots.forEach(function (entry) {
                const selected = selectedUid && pointByUid[selectedUid].cluster_id === entry.clusterId;
                entry.node.style.background = selected ? accentColor : mapColor;
                entry.button.setAttribute('aria-pressed', selected ? 'true' : 'false');
            });

            // Keep the graph tied to real neighbor relationships, with softly curved paths.
            const focusUid = hoveredUid || selectedUid;
            const focusPoint = focusUid ? pointByUid[focusUid] : null;
            const neighborSet = {};
            if (focusPoint && Array.isArray(focusPoint.neighbors)) {
                focusPoint.neighbors.forEach(function (nUid) {
                    const nb = pointByUid[nUid];
                    if (!nb) return;
                    neighborSet[nUid] = true;
                });
            }
            edges.forEach(function (edge, index) {
                const highlighted = focusPoint && (edge.from.uid === focusUid || edge.to.uid === focusUid);
                if (!expanded && !highlighted && !previewEdges.has(edge)) return;
                if (!highlighted && index % ambientEdgeStep !== 0) return;
                const a = pointScreen(edge.from, w, h);
                const b = pointScreen(edge.to, w, h);
                const dx = b[0] - a[0];
                const dy = b[1] - a[1];
                const distance = Math.max(1, Math.hypot(dx, dy));
                const phase = pointPhases.get(edge.from.uid) || 0;
                const bend = Math.min(expanded ? 32 : 12, distance * 0.16) * Math.sin(phase + index * 0.7);
                const cx = (a[0] + b[0]) / 2 - dy / distance * bend;
                const cy = (a[1] + b[1]) / 2 + dx / distance * bend;
                const color = highlighted ? accentColor : graphColor;
                const preview = expanded ? previewBlend : 1;
                let alpha = highlighted ? 0.45 + 0.4 * openness : (focusPoint ? 0.07 + 0.15 * openness : 0.26 + 0.28 * openness);
                if (expanded && !highlighted && !previewEdges.has(edge)) alpha *= 1 - preview;
                if (expanded && preview) {
                    const fade = Math.min(previewVisibility.get(edge.from.uid) ?? 1, previewVisibility.get(edge.to.uid) ?? 1);
                    alpha *= 1 - preview + preview * fade;
                }
                ctx.beginPath();
                ctx.moveTo(a[0], a[1]);
                ctx.quadraticCurveTo(cx, cy, b[0], b[1]);
                ctx.strokeStyle = hexToRgba(color, alpha);
                ctx.lineWidth = highlighted ? 0.9 + 0.5 * openness : 0.65 + 0.45 * openness;
                ctx.stroke();
            });

            // Only the active memory uses an accent; the reading view remains visible underneath.
            points.forEach(function (p) {
                const pos = pointScreen(p, w, h);
                const isSelected = p.uid === selectedUid;
                const isHovered = p.uid === hoveredUid;
                const isNeighbor = Boolean(neighborSet[p.uid]);
                const preview = expanded ? previewBlend : 1;
                const baseR = 1.4 + 0.8 * openness + Number(p.strength || 1) * 0.25;
                const r = isSelected ? 4.2 * (1 - preview) + (baseR + 0.7) * preview : (isHovered ? baseR + 0.7 : baseR);
                const col = isSelected || isHovered ? accentColor : graphColor;
                ctx.globalAlpha = (focusPoint && !isSelected && !isHovered && !isNeighbor) ? 0.25 + 0.35 * openness : 0.85 + 0.1 * openness;
                if (expanded && preview) ctx.globalAlpha *= 1 - preview + preview * (previewVisibility.get(p.uid) ?? 1);
                ctx.beginPath();
                ctx.arc(pos[0], pos[1], r, 0, Math.PI * 2);
                ctx.fillStyle = col;
                ctx.fill();
                if (isSelected) {
                    ctx.beginPath();
                    ctx.arc(pos[0], pos[1], r + 3, 0, Math.PI * 2);
                    ctx.strokeStyle = hexToRgba(col, 0.55 * (1 - preview));
                    ctx.lineWidth = 0.6 + 0.2 * openness;
                    ctx.stroke();
                }
                ctx.globalAlpha = 1;
            });

            ctx.restore();
        }

        function hitTest(clientX, clientY) {
            const rect = canvas.getBoundingClientRect();
            const mx = clientX - rect.left;
            const my = clientY - rect.top;
            if (mx < 0 || my < 0 || mx > rect.width || my > rect.height) return null;
            let best = null;
            let bestDist = 14;
            points.forEach(function (p) {
                const pos = pointScreen(p, rect.width, rect.height);
                if (expanded && previewBlend < 0.01
                    && (pos[0] <= 0 || pos[0] >= rect.width || pos[1] <= 0 || pos[1] >= rect.height)) return;
                const d = Math.hypot(pos[0] - mx, pos[1] - my);
                if (d < bestDist) {
                    bestDist = d;
                    best = p;
                }
            });
            return best;
        }

        function renderDetail(point) {
            detail.textContent = '';
            detail.hidden = !point;
            detail.inert = !point;
            hint.hidden = Boolean(point);
            if (!point) {
                canvas.setAttribute('aria-label', tr('memory.starMapTitle', '专属记忆星图'));
                return;
            }

            const cluster = clusterById[point.cluster_id];
            const head = document.createElement('div');
            head.className = 'memory-entry-badges';
            if (cluster) {
                const tag = document.createElement('span');
                tag.className = 'memory-mini-badge is-accent';
                tag.textContent = cluster.label;
                head.appendChild(tag);
            }
            const stars = document.createElement('span');
            stars.className = 'memory-mini-badge';
            stars.textContent = '★'.repeat(Math.max(1, Math.min(3, Number(point.strength || 1))));
            head.appendChild(stars);
            const detailHead = document.createElement('div');
            detailHead.className = 'starmap-detail-head';
            detailHead.appendChild(head);
            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'starmap-detail-close';
            closeBtn.setAttribute('aria-label', tr('common.close', '关闭'));
            closeBtn.textContent = '×';
            closeBtn.addEventListener('click', function () { resetView(true); });
            detailHead.appendChild(closeBtn);
            detail.appendChild(detailHead);

            const detailBody = document.createElement('div');
            detailBody.className = 'starmap-detail-body';
            detailBody.tabIndex = 0;
            detail.appendChild(detailBody);
            const body = document.createElement('p');
            body.className = 'starmap-detail-text';
            body.textContent = point.text;
            detailBody.appendChild(body);

            if (point.created_at) {
                const meta = document.createElement('div');
                meta.className = 'imprint-note-meta';
                meta.textContent = String(point.created_at).slice(0, 10);
                detailBody.appendChild(meta);
            }

            // Related stars jump links
            const neighbors = (point.neighbors || [])
                .map(function (uid) { return pointByUid[uid]; })
                .filter(Boolean);
            if (neighbors.length) {
                const relTitle = document.createElement('div');
                relTitle.className = 'starmap-rel-title';
                relTitle.textContent = tr('memory.starMapRelatedStars', '与之相连的记忆');
                detailBody.appendChild(relTitle);

                const relList = document.createElement('div');
                relList.className = 'starmap-rel-list';
                neighbors.slice(0, 3).forEach(function (nb) {
                    const btn = document.createElement('button');
                    btn.type = 'button';
                    btn.className = 'starmap-rel-item';
                    btn.textContent = nb.text.length > 34 ? nb.text.slice(0, 34) + '...' : nb.text;
                    btn.addEventListener('click', function () { selectPoint(nb); });
                    relList.appendChild(btn);
                });
                detailBody.appendChild(relList);
            }

            const actions = document.createElement('div');
            actions.className = 'memory-card-actions';

            if (typeof options.onTrace === 'function') {
                const traceBtn = document.createElement('button');
                traceBtn.type = 'button';
                traceBtn.className = 'memory-pill-btn is-sm';
                traceBtn.textContent = tr('memory.actionWhyRemember', '为什么这么记？');
                traceBtn.addEventListener('click', function () { options.onTrace(point); });
                actions.appendChild(traceBtn);
            }
            if (typeof options.onCorrect === 'function') {
                const fixBtn = document.createElement('button');
                fixBtn.type = 'button';
                fixBtn.className = 'memory-pill-btn is-primary is-sm';
                fixBtn.textContent = tr('memory.starMapGoCorrect', '去校准');
                fixBtn.addEventListener('click', function () { options.onCorrect(point); });
                actions.appendChild(fixBtn);
            }
            detail.appendChild(actions);
        }

        function selectPoint(point, preserveCamera) {
            if (!expanded || viewTransition === 'closing') {
                if (typeof options.onRequestExpand === 'function') options.onRequestExpand(point);
                return;
            }
            selectedUid = point ? point.uid : null;
            hoveredUid = null;
            tooltip.hidden = true;
            renderDetail(point);
            if (point) {
                keyboardIndex = points.indexOf(point);
                canvas.setAttribute('aria-label', tr('memory.starMapTitle', '专属记忆星图') + ' · ' + point.text);
                if (!preserveCamera) focusPoint(point, true);
            }
        }

        function previewPoint(point, clientX, clientY) {
            tooltip.textContent = '';
            const cluster = clusterById[point.cluster_id];
            if (cluster) {
                const topic = document.createElement('strong');
                topic.className = 'starmap-tooltip-topic';
                topic.textContent = cluster.label;
                tooltip.appendChild(topic);
            }
            const summary = document.createElement('span');
            const text = String(point.text || '');
            summary.textContent = text.length > 120 ? text.slice(0, 120) + '…' : text;
            tooltip.appendChild(summary);
            tooltip.hidden = false;
            const rect = stage.getBoundingClientRect();
            const x = clientX - rect.left;
            const y = clientY - rect.top;
            const left = x + tooltip.offsetWidth + 16 > rect.width ? x - tooltip.offsetWidth - 16 : x + 16;
            tooltip.style.left = Math.max(12, Math.min(left, rect.width - tooltip.offsetWidth - 12)) + 'px';
            tooltip.style.top = Math.max(12, Math.min(y + 16, rect.height - tooltip.offsetHeight - 12)) + 'px';
        }

        function isReadingControl(target) {
            return target instanceof Element && target.closest('button, a, input, select, textarea, label, [contenteditable]');
        }

        function clearPreview() {
            targetTiltX = targetTiltY = 0;
            pressedPreviewUid = null;
            hoveredUid = null;
            tooltip.hidden = true;
            previewRoot.classList.remove('is-starmap-hovering');
            if (!expanded) canvas.setAttribute('aria-label', tr('memory.starMapTitle', '专属记忆星图'));
            if (mounted && stageVisible && !document.hidden) draw();
        }

        function onPreviewMove(ev) {
            if (expanded || !stageVisible) return;
            const rect = canvas.getBoundingClientRect();
            if (!reducedMotion.matches && ev.pointerType !== 'touch') {
                const projection = previewProjection(rect.width, rect.height);
                const dx = (ev.clientX - rect.left - projection.centerX) / projection.reach;
                const dy = (ev.clientY - rect.top - projection.centerY) / projection.reach;
                const proximity = Math.max(0, Math.min(1, 1.5 - Math.hypot(dx, dy)));
                targetTiltX = -Math.max(-1, Math.min(1, dy)) * 0.05 * proximity;
                targetTiltY = Math.max(-1, Math.min(1, dx)) * 0.065 * proximity;
            }
            if (pressedPreviewUid && Math.hypot(ev.clientX - previewDownX, ev.clientY - previewDownY) > 6) {
                pressedPreviewUid = null;
            }
            const hit = isReadingControl(ev.target) ? null : hitTest(ev.clientX, ev.clientY);
            const nextHover = hit ? hit.uid : null;
            if (nextHover !== hoveredUid) {
                hoveredUid = nextHover;
                previewRoot.classList.toggle('is-starmap-hovering', Boolean(hit));
                draw();
            }
            if (hit && ev.pointerType !== 'touch') previewPoint(hit, ev.clientX, ev.clientY);
            else tooltip.hidden = true;
        }

        function onPreviewDown(ev) {
            if (expanded || ev.button !== 0 || isReadingControl(ev.target)) return;
            const hit = hitTest(ev.clientX, ev.clientY);
            pressedPreviewUid = hit ? hit.uid : null;
            previewDownX = ev.clientX;
            previewDownY = ev.clientY;
            if (hit && ev.pointerType !== 'touch') ev.preventDefault();
        }

        function onPreviewClick(ev) {
            if (expanded || !pressedPreviewUid || isReadingControl(ev.target)) return;
            const hit = hitTest(ev.clientX, ev.clientY);
            const pressedUid = pressedPreviewUid;
            pressedPreviewUid = null;
            if (!hit || hit.uid !== pressedUid) return;
            ev.preventDefault();
            ev.stopPropagation();
            selectPoint(hit);
        }

        function onPreviewLeave() {
            if (!expanded) clearPreview();
        }

        // Observe the panel without putting a transparent hit box over its text or controls.
        previewRoot.addEventListener('pointermove', onPreviewMove);
        previewRoot.addEventListener('pointerdown', onPreviewDown, true);
        previewRoot.addEventListener('click', onPreviewClick, true);
        previewRoot.addEventListener('pointerleave', onPreviewLeave);
        previewRoot.addEventListener('pointercancel', onPreviewLeave);

        // Mouse interactions
        canvas.addEventListener('pointerdown', function (ev) {
            if (!expanded || viewTransition || ev.button !== 0) return;
            stopCameraAnimation();
            isDragging = true;
            dragMoved = false;
            dragStartX = ev.clientX;
            dragStartY = ev.clientY;
            dragOrigOffsetX = offsetX;
            dragOrigOffsetY = offsetY;
            if (canvas.setPointerCapture) {
                try { canvas.setPointerCapture(ev.pointerId); } catch (_e) {}
            }
        });

        canvas.addEventListener('pointermove', function (ev) {
            if (!expanded || viewTransition) return;
            if (isDragging) {
                const dx = ev.clientX - dragStartX;
                const dy = ev.clientY - dragStartY;
                if (Math.hypot(dx, dy) > 4) dragMoved = true;
                offsetX = dragOrigOffsetX + dx;
                offsetY = dragOrigOffsetY + dy;
                tooltip.hidden = true;
                canvas.style.cursor = 'grabbing';
                draw();
                return;
            }
            const hit = hitTest(ev.clientX, ev.clientY);
            const nextHover = hit ? hit.uid : null;
            if (nextHover !== hoveredUid) {
                hoveredUid = nextHover;
                canvas.style.cursor = hit ? 'pointer' : 'grab';
                draw();
            }
            if (hit) {
                previewPoint(hit, ev.clientX, ev.clientY);
            } else {
                tooltip.hidden = true;
            }
        });

        canvas.addEventListener('pointerup', function (ev) {
            if (!isDragging) return;
            const wasDrag = dragMoved;
            isDragging = false;
            dragMoved = false;
            canvas.style.cursor = 'grab';
            if (canvas.hasPointerCapture && canvas.hasPointerCapture(ev.pointerId)) {
                canvas.releasePointerCapture(ev.pointerId);
            }
            if (!wasDrag) {
                const hit = hitTest(ev.clientX, ev.clientY);
                if (hit) {
                    selectPoint(hit);
                } else if (selectedUid) {
                    resetView(false);
                }
            }
        });

        canvas.addEventListener('pointerleave', function () {
            hoveredUid = null;
            tooltip.hidden = true;
            draw();
        });

        canvas.addEventListener('pointercancel', function () {
            isDragging = false;
            canvas.style.cursor = 'grab';
            hoveredUid = null;
            tooltip.hidden = true;
            draw();
        });
        canvas.addEventListener('lostpointercapture', function () {
            isDragging = false;
            canvas.style.cursor = 'grab';
        });
        canvas.addEventListener('blur', function () {
            if (!expanded) {
                clearPreview();
                return;
            }
            hoveredUid = null;
            tooltip.hidden = true;
            draw();
        });

        canvas.addEventListener('wheel', function (ev) {
            if (!expanded) return;
            ev.preventDefault();
            if (viewTransition) return;
            stopCameraAnimation();
            tooltip.hidden = true;
            hoveredUid = null;
            const rect = canvas.getBoundingClientRect();
            const x = ev.clientX - rect.left - rect.width / 2;
            const y = ev.clientY - rect.top - rect.height / 2;
            const factor = ev.deltaY < 0 ? 1.15 : 0.87;
            const nextScale = Math.max(0.6, Math.min(3.5, scale * factor));
            offsetX = x - (x - offsetX) * nextScale / scale;
            offsetY = y - (y - offsetY) * nextScale / scale;
            scale = nextScale;
            draw();
        }, { passive: false });

        canvas.addEventListener('keydown', function (ev) {
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(ev.key) && points.length) {
                ev.preventDefault();
                const step = ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 1;
                keyboardIndex = keyboardIndex < 0 ? (step > 0 ? 0 : points.length - 1)
                    : (keyboardIndex + step + points.length) % points.length;
                const point = points[keyboardIndex];
                hoveredUid = point.uid;
                const rect = canvas.getBoundingClientRect();
                const pos = pointScreen(point, rect.width, rect.height);
                previewPoint(point, rect.left + pos[0], rect.top + pos[1]);
                canvas.setAttribute('aria-label', tr('memory.starMapTitle', '专属记忆星图') + ' · ' + point.text);
                draw();
            } else if ((ev.key === 'Enter' || ev.key === ' ') && points.length) {
                ev.preventDefault();
                selectPoint(points[Math.max(0, keyboardIndex)]);
            }
        });

        stage.addEventListener('keydown', function (ev) {
            if (ev.key === 'Escape') {
                ev.preventDefault();
                if (!expanded) clearPreview();
                else if (selectedUid) resetView(true);
                else if (typeof options.onRequestCollapse === 'function') options.onRequestCollapse();
            }
        });
        resetBtn.addEventListener('click', function () { resetView(false); });

        renderDetail(null);
        window.requestAnimationFrame(function () { updateColors(); draw(); });

        let ro = null;
        if (typeof ResizeObserver !== 'undefined') {
            let initialized = false;
            ro = new ResizeObserver(function () {
                const initial = !initialized;
                initialized = true;
                if (typeof options.onResize === 'function') options.onResize();
                updateColors();
                if (viewTransition === 'closing') closeToPreview();
                else if (selectedUid && !initial) focusPoint(pointByUid[selectedUid], cameraFrame !== null);
                else draw();
            });
            ro.observe(stage);
            if (previewRoot !== stage) ro.observe(previewRoot);
            if (options.legendHost) ro.observe(options.legendHost);
        }
        let themeObserver = null;
        if (typeof MutationObserver !== 'undefined') {
            themeObserver = new MutationObserver(function () { updateColors(); draw(); });
            themeObserver.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ['data-theme'],
            });
        }
        let visibilityObserver = null;
        if (typeof IntersectionObserver !== 'undefined') {
            visibilityObserver = new IntersectionObserver(function (entries) {
                stageVisible = entries[0].isIntersecting;
                if (!stageVisible && !expanded) clearPreview();
                updateAmbientAnimation();
            });
            visibilityObserver.observe(stage);
        }
        document.addEventListener('visibilitychange', updateAmbientAnimation);
        reducedMotion.addEventListener('change', updateAmbientAnimation);
        setExpanded(false);

        function unmount() {
            mounted = false;
            stopCameraAnimation();
            if (ambientFrame !== null) window.cancelAnimationFrame(ambientFrame);
            previewRoot.removeEventListener('pointermove', onPreviewMove);
            previewRoot.removeEventListener('pointerdown', onPreviewDown, true);
            previewRoot.removeEventListener('click', onPreviewClick, true);
            previewRoot.removeEventListener('pointerleave', onPreviewLeave);
            previewRoot.removeEventListener('pointercancel', onPreviewLeave);
            previewRoot.classList.remove('is-starmap-hovering');
            if (legend) legend.remove();
            document.removeEventListener('visibilitychange', updateAmbientAnimation);
            reducedMotion.removeEventListener('change', updateAmbientAnimation);
            if (visibilityObserver) visibilityObserver.disconnect();
            if (ro) {
                ro.disconnect();
                ro = null;
            }
            if (themeObserver) {
                themeObserver.disconnect();
                themeObserver = null;
            }
        }
        return { unmount: unmount, setExpanded: setExpanded, captureView: captureView };
    }

    window.nekoMemoryStarMap = {
        mount: mount,
    };
})();
