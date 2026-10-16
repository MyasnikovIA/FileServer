// ============================================================
// Просмотр JSDOS-игр в полноэкранной модалке
// ============================================================

FAR._jsdosInstance = null;       // Инстанс JsDos (возвращаемый dosObj.run)
FAR._jsdosCurrentItem = null;    // fileIndex-элемент текущей игры
FAR._jsdosCurrentUrl = null;     // Blob URL текущей игры
FAR._jsdosBlobUrls = [];         // Все созданные Blob URL для очистки

/**
 * Проверяет, является ли файл JSDOS-архивом.
 */
FAR.isJsdos = function(item) {
    if (!item || item.isFolder) return false;
    const ext = (item.name.split('.').pop() || '').toLowerCase();
    return ext === 'jsdos';
};

/**
 * Открывает JSDOS-игру в полноэкранной модалке.
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

    title.textContent = '🕹️ ' + item.name;
    info.textContent = '';
    modal.classList.remove('hidden');
    loading.classList.remove('hidden');
    loadingText.textContent = 'Загрузка игры…';

    // Уничтожаем предыдущий инстанс
    if (FAR._jsdosInstance) {
        try { FAR._jsdosInstance.stop(); } catch (e) {}
        FAR._jsdosInstance = null;
    }

    // Очищаем контейнер
    root.innerHTML = '';

    // Загружаем файл из PouchDB конкретной панели
    let url = null;
    try {
        const { data, contentType } = await FAR.readFileBodyFromSide(side, item);
        const blob = new Blob([data], { type: contentType || 'application/octet-stream' });
        url = URL.createObjectURL(blob);
        FAR._jsdosBlobUrls.push(url);
        FAR._jsdosCurrentUrl = url;

        info.textContent = `📦 ${FAR.formatSize(data.length)}`;
    } catch (e) {
        console.error('openJsdosViewer: readFileBodyFromSide failed:', e);
        loading.classList.add('hidden');
        FAR.toast('Не удалось загрузить игру: ' + e.message, 'error');
        return;
    }

    // Небольшая задержка, чтобы модалка успела отрисоваться
    await new Promise(function(resolve) { setTimeout(resolve, 50); });

    // Запускаем DOS
    try {
        const pathPrefix = new URL('lib/js-dos/', window.location.href).href;
        console.log('JSDOS: pathPrefix =', pathPrefix);

        if (typeof window.emulators !== 'undefined') {
            window.emulators.pathPrefix = pathPrefix;
            console.log('JSDOS: emulators.pathPrefix установлен');
        } else {
            console.warn('JSDOS: window.emulators не определён');
        }

        FAR._jsdosInstance = window.Dos(root, {
            wdosboxUrl: pathPrefix + 'wdosbox.js',
            pathPrefix: pathPrefix
        });

        loadingText.textContent = 'Запуск…';

        try {
            FAR._jsdosInstance.events().onStdout(function(line) {
                console.log('[jsdos]', line);
            });
        } catch (e) { /* ignore */ }

        await FAR._jsdosInstance.run(url);

        loading.classList.add('hidden');
        FAR.setStatus('🕹️ JSDOS: ' + item.name);
        FAR.toast('Игра запущена', 'success');

        // Переводим фокус в эмулятор, чтобы Enter/стрелки
        // шли в JSDOS, а не в панели файлового менеджера
        FAR._jsdosFocus(root);

    } catch (e) {
        console.error('openJsdosViewer: run failed:', e);
        loading.classList.add('hidden');
        FAR.toast('Не удалось запустить игру: ' + e.message, 'error');
    }
};

/**
 * Закрывает модалку JSDOS.
 */
FAR.closeJsdosViewer = function() {
    const modal = document.getElementById('jsdosViewerModal');
    if (modal) modal.classList.add('hidden');

    // Останавливаем эмулятор
    if (FAR._jsdosInstance) {
        try { FAR._jsdosInstance.stop(); } catch (e) {}
        FAR._jsdosInstance = null;
    }

    // Чистим Blob URL
    FAR._jsdosBlobUrls.forEach(function(u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    FAR._jsdosBlobUrls = [];
    FAR._jsdosCurrentUrl = null;

    // Очищаем контейнер
    const root = document.getElementById('jsdosRoot');
    if (root) root.innerHTML = '';

    // Возвращаем фокус в файловый менеджер
    FAR._jsdosBlur(root);

    FAR._jsdosCurrentItem = null;
    FAR._jsdosCurrentSide = null;
};

FAR.closeJsdosViewerOutside = function(e) {
    if (e.target === e.currentTarget) FAR.closeJsdosViewer();
};

/**
 * Скачивает оригинальный .jsdos файл.
 */
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

/**
 * Переводит фокус на контейнер JSDOS, чтобы клавиатура уходила
 * внутрь эмулятора, а не в панели файлового менеджера.
 */
FAR._jsdosFocus = function(root) {
    if (!root) return;

    try {
        root.setAttribute('tabindex', '0');
        root.focus();
    } catch (e) { /* ignore */ }

    // JSDOS создаёт внутри .jsdos-root свой canvas. Пробуем
    // сфокусировать его тоже — некоторые версии DOSBox слушают
    // клавиатуру именно на canvas.
    try {
        const canvas = root.querySelector('canvas');
        if (canvas) {
            canvas.setAttribute('tabindex', '0');
            canvas.focus();
        }
    } catch (e) { /* ignore */ }
};

/**
 * Снимает фокус с контейнера JSDOS и возвращает его в файловый
 * менеджер, чтобы клавиши снова обрабатывались панелями FAR.
 */
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