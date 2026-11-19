// ============================================================
// 28-jsdos-viewer.js — Просмотр JSDOS-игр в полноэкранной модалке и WM
// ============================================================

FAR._jsdosInstance = null;       // Инстанс JsDos (возвращаемый dosObj.run)
FAR._jsdosCurrentItem = null;    // fileIndex-элемент текущей игры
FAR._jsdosCurrentUrl = null;     // Blob URL текущей игры
FAR._jsdosBlobUrls = [];         // Все созданные Blob URL для очистки
FAR._jsdosResizeObserver = null; // Наблюдатель за размером контейнера

/**
 * Проверяет, является ли файл JSDOS-архивом.
 */
FAR.isJsdos = function(item) {
    if (!item || item.isFolder) return false;
    const ext = (item.name.split('.').pop() || '').toLowerCase();
    return ext === 'jsdos';
};

/**
 * Открывает JSDOS-игру.
 */
FAR.openJsdosViewer = async function(item, side) {
    side = side || FAR.activePanel;

    if (!FAR.ensureDb()) return;
    if (typeof FAR._ensureItemName === 'function') {
        FAR._ensureItemName(item);
    }

    if (!window.Dos) {
        FAR.toast('Библиотека JS-DOS не загружена', 'error');
        console.error('window.Dos не определён. Проверьте подключение lib/js-dos/js-dos.js');
        return;
    }

    // Закрываем обычный просмотрщик и панорамный, если открыты
    try { FAR.closeViewer(); } catch (e) {}
    try { FAR.closePanoramaViewer(); } catch (e) {}

    FAR._jsdosCurrentItem = item;
    FAR._jsdosCurrentSide = side;
    FAR._jsdosBlobUrls.forEach(function(u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    FAR._jsdosBlobUrls = [];

    const modal = document.getElementById('jsdosViewerModal');
    const title = document.getElementById('jsdosViewerTitle');
    const info = document.getElementById('jsdosViewerInfo');
    const loading = document.getElementById('jsdosLoading');
    const loadingText = document.getElementById('jsdosLoadingText');
    const root = document.getElementById('jsdosRoot');

    // Если мы в WM, root может быть другим. Ищем его.
    const actualRoot = root || document.querySelector('.jsdos-root') || document.querySelector('[data-role="root"]');

    if (modal) {
        title.textContent = '🕹️ ' + item.name;
        info.textContent = '';
        modal.classList.remove('hidden');
        loading.classList.remove('hidden');
        loadingText.textContent = 'Загрузка игры…';
    }

    // Уничтожаем предыдущий инстанс
    if (FAR._jsdosInstance) {
        try { FAR._jsdosInstance.stop(); } catch (e) {}
        FAR._jsdosInstance = null;
    }

    // Отключаем старый observer
    if (FAR._jsdosResizeObserver) {
        FAR._jsdosResizeObserver.disconnect();
        FAR._jsdosResizeObserver = null;
    }

    if (actualRoot) actualRoot.innerHTML = '';

    // Инжектим CSS для адаптивности холста (если еще не добавлен)
    if (!document.getElementById('jsdos-responsive-css')) {
        const style = document.createElement('style');
        style.id = 'jsdos-responsive-css';
        style.textContent = `
            .jsdos-root canvas, #jsdosRoot canvas, .dosbox-container canvas {
                width: 100% !important;
                height: 100% !important;
                object-fit: contain !important;
                max-width: 100% !important;
                max-height: 100% !important;
                display: block !important;
            }
        `;
        document.head.appendChild(style);
    }

    // Загружаем файл из PouchDB конкретной панели
    let url = null;
    try {
        const { data, contentType } = await FAR.readFileBodyFromSide(side, item);
        const blob = new Blob([data], { type: contentType || 'application/octet-stream' });
        url = URL.createObjectURL(blob);
        FAR._jsdosBlobUrls.push(url);
        FAR._jsdosCurrentUrl = url;

        if (info) info.textContent = `📦 ${FAR.formatSize(data.length)}`;
    } catch (e) {
        console.error('openJsdosViewer: readFileBodyFromSide failed:', e);
        if (loading) loading.classList.add('hidden');
        FAR.toast('Не удалось загрузить игру: ' + e.message, 'error');
        return;
    }

    // Небольшая задержка, чтобы контейнер успел отрисоваться
    await new Promise(function(resolve) { setTimeout(resolve, 50); });

    // Запускаем DOS
    try {
        const pathPrefix = new URL('lib/js-dos/', window.location.href).href;
        console.log('JSDOS: pathPrefix =', pathPrefix);

        if (typeof window.emulators !== 'undefined') {
            window.emulators.pathPrefix = pathPrefix;
        }

        FAR._jsdosInstance = window.Dos(actualRoot, {
            wdosboxUrl: pathPrefix + 'wdosbox.js',
            pathPrefix: pathPrefix
        });

        if (loadingText) loadingText.textContent = 'Запуск…';

        try {
            FAR._jsdosInstance.events().onStdout(function(line) {
                console.log('[jsdos]', line);
            });
        } catch (e) { /* ignore */ }

        await FAR._jsdosInstance.run(url);

        if (loading) loading.classList.add('hidden');
        FAR.setStatus('🕹️ JSDOS: ' + item.name);
        FAR.toast('Игра запущена', 'success');

        // Настраиваем ResizeObserver
        if (window.ResizeObserver && actualRoot) {
            FAR._jsdosResizeObserver = new ResizeObserver(() => {
                // Принудительно триггерим ресайз для внутренних скриптов DOSBox
                window.dispatchEvent(new Event('resize'));
            });
            FAR._jsdosResizeObserver.observe(actualRoot);
        }

        // Переводим фокус в эмулятор
        FAR._jsdosFocus(actualRoot);

    } catch (e) {
        console.error('openJsdosViewer: run failed:', e);
        if (loading) loading.classList.add('hidden');
        FAR.toast('Не удалось запустить игру: ' + e.message, 'error');
    }
};

/**
 * Закрывает модалку JSDOS.
 */
FAR.closeJsdosViewer = function() {
    const modal = document.getElementById('jsdosViewerModal');
    if (modal) modal.classList.add('hidden');

    // Отключаем observer
    if (FAR._jsdosResizeObserver) {
        FAR._jsdosResizeObserver.disconnect();
        FAR._jsdosResizeObserver = null;
    }

    // Останавливаем эмулятор
    if (FAR._jsdosInstance) {
        try { FAR._jsdosInstance.stop(); } catch (e) {}
        FAR._jsdosInstance = null;
    }

    // Чистим Blob URL
    FAR._jsdosBlobUrls.forEach(function(u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    FAR._jsdosBlobUrls = [];
    FAR._jsdosCurrentUrl = null;

    // Очищаем контейнеры
    const roots = document.querySelectorAll('.jsdos-root, #jsdosRoot, .dosbox-container');
    roots.forEach(r => r.innerHTML = '');

    // Возвращаем фокус в файловый менеджер
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
    try {
        root.setAttribute('tabindex', '0');
        root.focus();
    } catch (e) { /* ignore */ }
    try {
        const canvas = root.querySelector('canvas');
        if (canvas) {
            canvas.setAttribute('tabindex', '0');
            canvas.focus();
        }
    } catch (e) { /* ignore */ }
};

FAR._jsdosBlur = function(root) {
    try {
        if (root) root.blur();
    } catch (e) { /* ignore */ }
    try {
        if (document.activeElement && document.activeElement !== document.body) {
            document.activeElement.blur();
        }
    } catch (e) { /* ignore */ }
    try {
        document.body.focus();
    } catch (e) { /* ignore */ }
};