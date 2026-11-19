// ============================================================
// 28-jsdos-viewer.js — Просмотр JSDOS-игр в модалке
// ============================================================

FAR._jsdosInstance = null;
FAR._jsdosCurrentItem = null;
FAR._jsdosCurrentSide = null;
FAR._jsdosCurrentUrl = null;
FAR._jsdosBlobUrls = [];
FAR._jsdosResizeObserver = null;

FAR.isJsdos = function(item) {
    if (!item || item.isFolder) return false;
    const ext = (item.name.split('.').pop() || '').toLowerCase();
    return ext === 'jsdos';
};

FAR.openJsdosViewer = async function(item, side) {
    side = side || FAR.activePanel;

    if (!FAR.ensureDb()) return;
    if (typeof FAR._ensureItemName === 'function') FAR._ensureItemName(item);

    if (!window.Dos) {
        FAR.toast('Библиотека JS-DOS не загружена', 'error');
        return;
    }

    try { FAR.closeViewer(); } catch (e) {}
    try { FAR.closePanoramaViewer(); } catch (e) {}

    FAR._jsdosCurrentItem = item;
    FAR._jsdosCurrentSide = side;
    FAR._jsdosBlobUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
    FAR._jsdosBlobUrls = [];

    const modal       = document.getElementById('jsdosViewerModal');
    const title       = document.getElementById('jsdosViewerTitle');
    const info        = document.getElementById('jsdosViewerInfo');
    const loading     = document.getElementById('jsdosLoading');
    const loadingText = document.getElementById('jsdosLoadingText');
    const root        = document.getElementById('jsdosRoot');

    const actualRoot = root || document.querySelector('.jsdos-root');

    if (modal) {
        title.textContent = '🕹️ ' + item.name;
        info.textContent = '';
        modal.classList.remove('hidden');
        loading.classList.remove('hidden');
        loadingText.textContent = 'Загрузка игры…';
    }

    if (FAR._jsdosInstance) {
        try { FAR._jsdosInstance.stop(); } catch (e) {}
        FAR._jsdosInstance = null;
    }
    if (FAR._jsdosResizeObserver) {
        FAR._jsdosResizeObserver.disconnect();
        FAR._jsdosResizeObserver = null;
    }
    if (actualRoot) actualRoot.innerHTML = '';

    let url = null;
    try {
        const { data, contentType } = await FAR.readFileBodyFromSide(side, item);
        const blob = new Blob([data], { type: contentType || 'application/octet-stream' });
        url = URL.createObjectURL(blob);
        FAR._jsdosBlobUrls.push(url);
        FAR._jsdosCurrentUrl = url;
        if (info) info.textContent = `📦 ${FAR.formatSize(data.length)}`;
    } catch (e) {
        console.error('openJsdosViewer: read failed:', e);
        if (loading) loading.classList.add('hidden');
        FAR.toast('Не удалось загрузить игру: ' + e.message, 'error');
        return;
    }

    await new Promise(r => setTimeout(r, 50));

    try {
        const pathPrefix = new URL('lib/js-dos/', window.location.href).href;
        if (typeof window.emulators !== 'undefined') {
            window.emulators.pathPrefix = pathPrefix;
        }

        FAR._jsdosInstance = window.Dos(actualRoot, {
            wdosboxUrl: pathPrefix + 'wdosbox.js',
            pathPrefix: pathPrefix
        });

        if (loadingText) loadingText.textContent = 'Запуск…';

        try {
            FAR._jsdosInstance.events().onStdout(line => console.log('[jsdos]', line));
        } catch (e) {}

        // Без await, чтобы не блокировать поток
        FAR._jsdosInstance.run(url).catch(e => console.error('[jsdos] run error:', e));

        // Умное скрытие лоадера (ждем появления canvas)
        const checkCanvas = setInterval(() => {
            const canvas = actualRoot.querySelector('canvas');
            if (canvas && canvas.width > 0) {
                clearInterval(checkCanvas);
                if (loading) loading.classList.add('hidden');
                window.dispatchEvent(new Event('resize'));
            }
        }, 100);

        setTimeout(() => {
            clearInterval(checkCanvas);
            if (loading) loading.classList.add('hidden');
            window.dispatchEvent(new Event('resize'));
        }, 2000);

        FAR.setStatus('🕹️ JSDOS: ' + item.name);
        FAR.toast('Игра запущена', 'success');

        // ResizeObserver
        if (window.ResizeObserver && actualRoot) {
            FAR._jsdosResizeObserver = new ResizeObserver(() => {
                const canvas = actualRoot.querySelector('canvas');
                if (canvas) {
                    // Принудительно сбрасываем инлайн-стили, которые ставит EmulatorJS
                    canvas.style.removeProperty('top');
                    canvas.style.removeProperty('left');
                    canvas.style.removeProperty('width');
                    canvas.style.removeProperty('height');
                    canvas.style.removeProperty('position');
                }
                // Триггерим внутренний обработчик resize у Emscripten
                window.dispatchEvent(new Event('resize'));
            });
            FAR._jsdosResizeObserver.observe(actualRoot);
        }

        FAR._jsdosFocus(actualRoot);

    } catch (e) {
        console.error('openJsdosViewer: run failed:', e);
        if (loading) loading.classList.add('hidden');
        FAR.toast('Не удалось запустить игру: ' + e.message, 'error');
    }
};

FAR.closeJsdosViewer = function() {
    const modal = document.getElementById('jsdosViewerModal');
    if (modal) modal.classList.add('hidden');

    if (FAR._jsdosResizeObserver) {
        FAR._jsdosResizeObserver.disconnect();
        FAR._jsdosResizeObserver = null;
    }
    if (FAR._jsdosInstance) {
        try { FAR._jsdosInstance.stop(); } catch (e) {}
        FAR._jsdosInstance = null;
    }

    FAR._jsdosBlobUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (e) {} });
    FAR._jsdosBlobUrls = [];
    FAR._jsdosCurrentUrl = null;

    const roots = document.querySelectorAll('.jsdos-root, #jsdosRoot, .dosbox-container');
    roots.forEach(r => r.innerHTML = '');

    FAR._jsdosBlur(document.getElementById('jsdosRoot'));
    FAR._jsdosCurrentItem = null;
    FAR._jsdosCurrentSide = null;
};

FAR.closeJsdosViewerOutside = function(e) {
    if (e.target === e.currentTarget) FAR.closeJsdosViewer();
};

FAR.downloadCurrentJsdos = async function() {
    if (!FAR._jsdosCurrentItem) {
        FAR.toast('Нет активной игры', 'warning');
        return;
    }
    const side = FAR._jsdosCurrentSide || FAR.activePanel;
    try {
        const { data, contentType } = await FAR.readFileBodyFromSide(side, FAR._jsdosCurrentItem);
        const blob = new Blob([data], { type: contentType || 'application/octet-stream' });
        FAR.saveBlobAs(blob, FAR.sanitizeFileName(FAR._jsdosCurrentItem.name));
        FAR.toast('Файл сохранён', 'success');
    } catch (e) {
        FAR.toast('Ошибка скачивания: ' + e.message, 'error');
    }
};

FAR._jsdosFocus = function(root) {
    if (!root) return;
    try { root.setAttribute('tabindex', '0'); root.focus(); } catch (e) {}
    try {
        const canvas = root.querySelector('canvas');
        if (canvas) { canvas.setAttribute('tabindex', '0'); canvas.focus(); }
    } catch (e) {}
};

FAR._jsdosBlur = function(root) {
    try { if (root) root.blur(); } catch (e) {}
    try {
        if (document.activeElement && document.activeElement !== document.body) {
            document.activeElement.blur();
        }
    } catch (e) {}
    try { document.body.focus(); } catch (e) {}
};