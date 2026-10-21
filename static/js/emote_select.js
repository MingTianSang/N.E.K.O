/**
 * NekoEmoteSelect：把 <select> 换成风格统一的自绘下拉。
 *
 * 设计要点（吸取上一版教训）：没有需要维护的"镜像列表"——弹层每次展开时
 * 从 select.options 现读现画，选中写回 select.value 并派发 change
 * （bubbles），现有监听器零改动。行被页面重建时，旧的下拉随行一起消失，
 * 新 select 由 MutationObserver 自动接管——自愈，无需清理。
 */
(function (root) {
    'use strict';

    function selectedText(select) {
        const opt = select.options[select.selectedIndex];
        return opt ? opt.textContent : '';
    }

    function enhance(select) {
        if (select.dataset.nekoDd) return;
        select.dataset.nekoDd = '1';
        select.classList.add('neko-select-hidden');

        const dd = document.createElement('div');
        dd.className = 'neko-dd';
        const header = document.createElement('button');
        header.type = 'button';
        header.className = 'neko-dd-header';
        header.setAttribute('aria-haspopup', 'listbox');
        header.setAttribute('aria-expanded', 'false');
        const text = document.createElement('span');
        text.className = 'neko-dd-text';
        const caret = document.createElement('span');
        caret.className = 'neko-dd-caret';
        header.append(text, caret);
        const list = document.createElement('div');
        list.className = 'neko-list';
        list.setAttribute('role', 'listbox');
        dd.append(header, list);
        select.after(dd);

        function isOpen() { return dd.classList.contains('is-open'); }

        function close() {
            dd.classList.remove('is-open', 'open-up');
            header.setAttribute('aria-expanded', 'false');
        }

        function open() {
            if (select.disabled) return;
            // 现读现画：弹层内容永远是 select 当前的选项
            list.replaceChildren();
            Array.from(select.options).forEach((opt, index) => {
                const item = document.createElement('div');
                item.className = 'neko-dd-option';
                item.setAttribute('role', 'option');
                item.textContent = opt.textContent;
                if (index === select.selectedIndex) item.classList.add('is-selected');
                if (opt.disabled) item.classList.add('is-disabled');
                item.addEventListener('click', () => {
                    if (opt.disabled) return;
                    if (select.selectedIndex !== index) {
                        select.selectedIndex = index;
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    refreshHeader();
                    close();
                });
                list.appendChild(item);
            });
            refreshHeader();
            dd.classList.add('is-open');
            header.setAttribute('aria-expanded', 'true');
            const rect = header.getBoundingClientRect();
            dd.classList.toggle('open-up',
                window.innerHeight - rect.bottom < 260 && rect.top > 260);
            // 焦点给选中项，键盘直接可用
            const selectedEl = list.querySelector('.is-selected') || list.firstElementChild;
            if (selectedEl) selectedEl.focus();
        }

        function refreshHeader() { text.textContent = selectedText(select); }

        header.addEventListener('click', () => (isOpen() ? close() : open()));
        header.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                open();
                const selectedEl = list.querySelector('.is-selected') || list.firstElementChild;
                if (selectedEl) selectedEl.focus();
            }
        });
        list.addEventListener('keydown', (event) => {
            const current = document.activeElement;
            const items = Array.from(list.querySelectorAll('.neko-dd-option'));
            const at = items.indexOf(current);
            if (event.key === 'ArrowDown') {
                event.preventDefault();
                (items[Math.min(items.length - 1, at + 1)] || current).focus();
            } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                (items[Math.max(0, at - 1)] || current).focus();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                close();
                header.focus();
            } else if (event.key === 'Enter') {
                event.preventDefault();
                if (current) current.click();
            }
        });
        select.addEventListener('change', refreshHeader);
    }

    function enhanceAll(scope) {
        (scope.matches && scope.matches('select') ? [scope] : [])
            .concat(scope.querySelectorAll ? Array.from(scope.querySelectorAll('select')) : [])
            .forEach(enhance);
    }

    document.addEventListener('pointerdown', (event) => {
        if (!event.target.closest || event.target.closest('.neko-dd')) return;
        document.querySelectorAll('.neko-dd.is-open').forEach((dd) => {
            dd.classList.remove('is-open', 'open-up');
            const header = dd.querySelector('.neko-dd-header');
            if (header) header.setAttribute('aria-expanded', 'false');
        });
    }, true);

    // 行被页面重建时：新 select 自动接管（旧的随行一起消失，无需清理）
    new MutationObserver((mutations) => {
        mutations.forEach((m) => {
            m.addedNodes.forEach((node) => {
                if (node.nodeType !== 1) return;
                if (node.tagName === 'SELECT') enhance(node);
                else if (node.querySelectorAll) node.querySelectorAll('select').forEach(enhance);
            });
        });
    }).observe(document.body, { childList: true, subtree: true });

    function boot() { enhanceAll(document); }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

    root.NekoEmoteSelect = { enhanceAll };
})(typeof window !== 'undefined' ? window : globalThis);
