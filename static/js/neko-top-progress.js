/**
 * 页面顶部进度条（全站小工具，无依赖）。
 *
 * 用法：
 *   NekoTopProgress.begin();          // 出现（默认不定态流动）
 *   NekoTopProgress.progress(0.4);    // 确定态：0..1
 *   NekoTopProgress.progress(null);   // 回到不定态（比如字节传完、服务端还在处理）
 *   NekoTopProgress.done();           // 收起
 * begin/done 可嵌套（计数），最外层 done 才收起；progress 未调用时保持不定态。
 */
(function (root) {
    'use strict';

    let bar = null;
    let fill = null;
    let depth = 0;
    let hideTimer = 0;

    function ensure() {
        if (bar && bar.isConnected) return;
        bar = document.createElement('div');
        bar.className = 'neko-top-progress';
        fill = document.createElement('div');
        fill.className = 'neko-top-progress-fill';
        bar.appendChild(fill);
        const style = document.createElement('style');
        style.textContent = [
            '.neko-top-progress {',
            '  position: fixed; top: 0; left: 0; right: 0; height: 3px;',
            '  z-index: 2147483000; pointer-events: none;',
            '  background: transparent; opacity: 0; transition: opacity 160ms ease;',
            '}',
            '.neko-top-progress.is-active { opacity: 1; }',
            '.neko-top-progress-fill {',
            '  height: 100%; width: 0;',
            '  background: #4f8cff;',
            '  box-shadow: 0 0 6px rgba(79, 140, 255, 0.8);',
            '  transition: width 180ms ease;',
            '}',
            '.neko-top-progress.is-indeterminate .neko-top-progress-fill {',
            '  width: 32% !important;',
            '  animation: neko-top-progress-slide 1.1s ease-in-out infinite;',
            '}',
            '@keyframes neko-top-progress-slide {',
            '  0% { transform: translateX(-110%); }',
            '  100% { transform: translateX(420%); }',
            '}',
        ].join('\n');
        document.head.appendChild(style);
        document.body.appendChild(bar);
    }

    root.NekoTopProgress = {
        begin() {
            ensure();
            if (hideTimer) { root.clearTimeout(hideTimer); hideTimer = 0; }
            depth += 1;
            bar.classList.add('is-active');
            this.progress(null);
        },
        /** ratio: 0..1 确定态；null/undefined 回到不定态。 */
        progress(ratio) {
            if (!bar) return;
            if (ratio === null || ratio === undefined) {
                bar.classList.add('is-indeterminate');
                return;
            }
            const value = Number(ratio);
            if (!Number.isFinite(value) || value < 0) {
                bar.classList.add('is-indeterminate');
                return;
            }
            bar.classList.remove('is-indeterminate');
            fill.style.width = `${Math.min(100, Math.max(0, value * 100))}%`;
        },
        done() {
            if (!bar) return;
            depth = Math.max(0, depth - 1);
            if (depth > 0) return;
            bar.classList.remove('is-active');
            // 收起动画走完再归零宽度，免得下一次 begin 闪一下满条
            if (hideTimer) root.clearTimeout(hideTimer);
            hideTimer = root.setTimeout(() => {
                hideTimer = 0;
                if (depth === 0 && bar) {
                    bar.classList.remove('is-indeterminate');
                    fill.style.width = '0%';
                }
            }, 220);
        },
    };
})(typeof window !== 'undefined' ? window : globalThis);
