// ============================================================
// 48-wm-viewers-emu.js — WM-режим для JSDOS и EmulatorJS.
// ============================================================

FAR.WM = FAR.WM || {};
FAR.WM._emu = FAR.WM._emu || {};

// ============================================================
// JSDOS
// ============================================================
FAR.WM._mountJsdosViewer = async function (win, props) {
    props = props || {};
    const item = props.file;
    const side = props.side || FAR.activePanel;

    win.bodyEl.innerHTML = '';
    win.bodyEl.style.background = '#000';
    win.bodyEl.style.display = 'flex';
    win.bodyEl.style.flexDirection = 'column';
    win.bodyEl.style.minHeight = '0';
    win.bodyEl.style.position = 'relative';

    const host = document.createElement('div');
    host.className = 'jsdos-root';
    host.style.cssText =
        'flex:1; min-height:0; width:100%; height:100%;' +
        'background:#000; overflow:hidden; position:relative;';
    win.bodyEl.appendChild(host);

    const loading = document.createElement('div');
    loading.className = 'jsdos-loading';
    loading.innerHTML =
        '<div class="spinner"></div>' +
        '<div class="jsdos-loading-text">Загрузка игры…</div>';
    host.appendChild(loading);

    if (!item || !FAR.side[side] || !FAR.side[side].db) {
        loading.innerHTML = '<div class="jsdos-loading-text">Файл не выбран или нет БД</div>';
        return;
    }

    if (typeof FAR._ensureItemName === 'function') FAR._ensureItemName(item);
    if (!window.Dos) {
        loading.innerHTML = '<div class="jsdos-loading-text">JS-DOS не загружен</div>';
        return;
    }

    let blobUrl = '';
    try {
        const { data, contentType } = await FAR.readFileBodyFromSide(side, item);
        const blob = new Blob([data], { type: contentType || 'application/octet-stream' });
        blobUrl = URL.createObjectURL(blob);
        if (!win.props._jsdosBlobUrls) win.props._jsdosBlobUrls = [];
        win.props._jsdosBlobUrls.push(blobUrl);
    } catch (e) {
        loading.innerHTML = '<div class="jsdos-loading-text">Ошибка чтения файла</div>';
        return;
    }

    await new Promise(r => setTimeout(r, 50));

    try {
        const pathPrefix = new URL('lib/js-dos/', window.location.href).href;
        if (typeof window.emulators !== 'undefined') {
            window.emulators.pathPrefix = pathPrefix;
        }

        const instance = window.Dos(host, {
            wdosboxUrl: pathPrefix + 'wdosbox.js',
            pathPrefix: pathPrefix
        });
        win.props._jsdosInstance = instance;

        try {
            instance.events().onStdout(line => console.log('[jsdos wm]', line));
        } catch (e) {}

        // === Обработка ошибок запуска — с показом пользователю ===
        let runFailed = false;
        instance.run(blobUrl).catch(e => {
            runFailed = true;
            console.error('[WM JSDOS] run error:', e);

            const rawMsg = (e && (e.message || String(e))) || 'unknown';
            const combined = Array.isArray(e) ? String(e) : rawMsg;

            let userMsg = 'Ошибка запуска jsdos';
            if (combined.indexOf('dosbox.conf') !== -1 ||
                combined.indexOf('Broken bundle') !== -1) {
                userMsg =
                    'Файл .jsdos повреждён или не является jsdos-бандлом.<br>' +
                    '<small>Отсутствует <code>.jsdos/dosbox.conf</code>. ' +
                    'Загрузите корректный .jsdos-архив.</small>';
            } else {
                userMsg = 'Ошибка: ' + FAR.escapeHtml(combined.substring(0, 200));
            }

            loading.innerHTML =
                '<div class="jsdos-loading-text">' + userMsg + '</div>';
            loading.classList.remove('hidden');
        });

        // Прячем лоадер только когда действительно появился canvas
        const checkCanvas = setInterval(() => {
            if (runFailed) { clearInterval(checkCanvas); return; }
            const canvas = host.querySelector('canvas');
            if (canvas && canvas.width > 0) {
                clearInterval(checkCanvas);
                loading.classList.add('hidden');
                try { window.dispatchEvent(new Event('resize')); } catch (e) {}
            }
        }, 100);

        // Долгий fallback — если canvas не появился, но и ошибки нет
        setTimeout(() => {
            clearInterval(checkCanvas);
            if (!runFailed) {
                loading.classList.add('hidden');
                try { window.dispatchEvent(new Event('resize')); } catch (e) {}
            }
        }, 5000);

        if (typeof ResizeObserver !== 'undefined') {
            if (win.props._resizeObserver) {
                try { win.props._resizeObserver.disconnect(); } catch (e) {}
            }
            win.props._resizeObserver = new ResizeObserver(function () {
                if (runFailed) return;
                const canvas = host.querySelector('canvas');
                if (canvas) {
                    canvas.style.removeProperty('top');
                    canvas.style.removeProperty('left');
                    canvas.style.removeProperty('width');
                    canvas.style.removeProperty('height');
                    canvas.style.removeProperty('position');
                }
                // dispatchEvent теперь безопасен благодаря
                // FAR._patchEmulatorJSResize (null-safe handleResize)
                try { window.dispatchEvent(new Event('resize')); } catch (e) {}
            });
            win.props._resizeObserver.observe(win.bodyEl);
        }

        try {
            host.setAttribute('tabindex', '0');
            host.focus();
            const canvas = host.querySelector('canvas');
            if (canvas) { canvas.setAttribute('tabindex', '0'); canvas.focus(); }
        } catch (e) {}

        FAR.setStatus('🕹️ JSDOS: ' + (item.name || item.path));

        // === Кнопки ◀ / ▶ в titlebar ===
        if (typeof FAR.WM._installViewerNavButtons === 'function') {
            try { FAR.WM._installViewerNavButtons(win, item, side); } catch (e) {}
        }
    } catch (e) {
        console.error('[WM JSDOS] failed:', e);
        loading.innerHTML = '<div class="jsdos-loading-text">Ошибка запуска: ' +
            FAR.escapeHtml(e.message || String(e)) + '</div>';
    }
};

// ============================================================
// EmulatorJS
// ============================================================
FAR.WM._mountEmulatorViewer = async function (win, props) {
    props = props || {};
    const item = props.file;
    const side = props.side || FAR.activePanel;

    win.bodyEl.innerHTML = '';
    win.bodyEl.style.background = '#000';
    win.bodyEl.style.display = 'flex';
    win.bodyEl.style.flexDirection = 'column';
    win.bodyEl.style.minHeight = '0';
    win.bodyEl.style.position = 'relative';

    const host = document.createElement('div');
    host.className = 'emulator-root';
    host.id = 'ejs_' + win.id + '_' + Math.random().toString(36).substr(2, 6);
    host.style.cssText =
        'flex:1; min-height:0; width:100%; height:100%;' +
        'background:#000; overflow:hidden; position:relative;' +
        'display:flex; align-items:center; justify-content:center;';
    win.bodyEl.appendChild(host);

    const loading = document.createElement('div');
    loading.className = 'emulator-loading';
    loading.innerHTML =
        '<div class="spinner"></div>' +
        '<div class="emulator-loading-text">Загрузка эмулятора…</div>';
    host.appendChild(loading);

    if (!item || !FAR.side[side] || !FAR.side[side].db) {
        loading.innerHTML = '<div class="emulator-loading-text">Ошибка: нет файла или БД</div>';
        return;
    }

    if (typeof FAR._ensureItemName === 'function') FAR._ensureItemName(item);

    // Используем функцию определения ядра из 30-emulator-viewer.js
    const core = typeof FAR._getEmulatorCore === 'function' ? FAR._getEmulatorCore(item) : null;
    if (!core) {
        loading.innerHTML = '<div class="emulator-loading-text">Формат не поддерживается</div>';
        return;
    }

    let data = null;
    let contentType = 'application/octet-stream';
    try {
        const r = await FAR.readFileBodyFromSide(side, item);
        data = r.data;
        contentType = r.contentType || 'application/octet-stream';
    } catch (e) {
        loading.innerHTML = '<div class="emulator-loading-text">Ошибка чтения</div>';
        return;
    }

    const blob = new Blob([data], { type: contentType });
    const blobUrl = URL.createObjectURL(blob);
    if (!win.props._emuBlobUrls) win.props._emuBlobUrls = [];
    win.props._emuBlobUrls.push(blobUrl);

    try {
        if (typeof FAR._installEmulatorStateHooks === 'function') {
            FAR._installEmulatorStateHooks();
        }
    } catch (e) {
        console.warn('[EmuState] Hooks failed:', e);
    }

    await new Promise(r => setTimeout(r, 30));

    try {
        // Настройки для EmulatorJS
        window.EJS_player = '#' + host.id;
        window.EJS_core = core;
        window.EJS_gameUrl = blobUrl;
        window.EJS_gameName = item.name;
        window.EJS_pathtodata = 'lib/js-emulator/';
        window.EJS_color = '#89b4fa';
        window.EJS_startOnLoaded = true;

        // Загружаем библиотеку (внутри патчится handleResize)
        if (!FAR._ejsLibraryLoaded) {
            await FAR._loadEmulatorLoader();
        } else if (typeof FAR._patchEmulatorJSResize === 'function') {
            try { FAR._patchEmulatorJSResize(); } catch (e) {}
        }

        // Создаём инстанс
        await new Promise((resolve, reject) => {
            FAR._createEmulatorInstance(host, resolve, reject);
        });

        win.props._emulatorInstance = window.EJS_emulator;
        win.props._ejsOwnerWinId    = win.id;

        // Ждём создания canvas
        const waitStart = Date.now();
        while (!host.querySelector('canvas') && Date.now() - waitStart < 5000) {
            await new Promise(r => setTimeout(r, 100));
        }

        const canvas = host.querySelector('canvas');
        if (canvas) {
            canvas.style.maxWidth  = '100%';
            canvas.style.maxHeight = '100%';
            canvas.style.width     = '100%';
            canvas.style.height    = '100%';
            canvas.style.objectFit = 'contain';
            canvas.style.imageRendering = 'pixelated';
        }

        loading.classList.add('hidden');

        if (typeof ResizeObserver !== 'undefined') {
            if (win.props._resizeObserver) {
                try { win.props._resizeObserver.disconnect(); } catch (e) {}
            }
            win.props._resizeObserver = new ResizeObserver(function () {
                // Безопасно: prototype.handleResize пропатчен на null-safe
                try { window.dispatchEvent(new Event('resize')); } catch (e) {}
            });
            win.props._resizeObserver.observe(win.bodyEl);
        }

        FAR.setStatus('🕹️ EmulatorJS: ' + item.name + ' (' + core + ')');

        if (typeof FAR.VirtualGamepad !== 'undefined') {
            FAR.VirtualGamepad.mount(host, core);
        }

        // === Кнопки ◀ / ▶ в titlebar (как у панорам/PDF/видео) ===
        if (typeof FAR.WM._installViewerNavButtons === 'function') {
            try { FAR.WM._installViewerNavButtons(win, item, side); } catch (e) {}
        }

    } catch (e) {
        console.error('[WM Emu] failed:', e);
        loading.innerHTML = '<div class="emulator-loading-text">Ошибка запуска: ' + FAR.escapeHtml(e.message) + '</div>';
    }
};

// ============================================================
// Финализация WM-окна.
//
// ВАЖНО: эта функция ПЕРЕОПРЕДЕЛЯЕТ версию из 47-wm-viewers.js,
// поэтому обязана покрывать ВСЕ типы ресурсов.
// ============================================================
FAR.WM._finalizeViewer = function (win) {
    if (!win || !win.props) return;

    // --- ResizeObserver ---
    if (win.props._resizeObserver) {
        try { win.props._resizeObserver.disconnect(); } catch (e) {}
        win.props._resizeObserver = null;
    }

    // --- VirtualGamepad ---
    if (typeof FAR.VirtualGamepad !== 'undefined' && win.bodyEl) {
        try {
            const roots = win.bodyEl.querySelectorAll('.emulator-root, .jsdos-root, [data-role="root"]');
            roots.forEach(function (node) {
                try { FAR.VirtualGamepad.unmount(node); } catch (e) {}
            });
            try { FAR.VirtualGamepad.unmount(win.bodyEl); } catch (e) {}
        } catch (e) {}
    }

    // --- JSDOS ---
    if (win.props._jsdosInstance) {
        try { win.props._jsdosInstance.stop(); } catch (e) {}
        win.props._jsdosInstance = null;
    }

    // --- EmulatorJS: ЖЁСТКАЯ остановка ---
    const emuCandidates = [];
    if (win.props._emulatorInstance) emuCandidates.push(win.props._emulatorInstance);
    try {
        if (window.EJS_emulator && win.props._ejsOwnerWinId === win.id) {
            emuCandidates.push(window.EJS_emulator);
        }
    } catch (e) {}

    for (const emu of emuCandidates) {
        try {
            if (typeof FAR._hardStopEmulatorJS === 'function') {
                FAR._hardStopEmulatorJS(emu);
            } else {
                try { if (typeof emu.pause === 'function') emu.pause(true); } catch (e) {}
                try { if (typeof emu.destroy === 'function') emu.destroy(); } catch (e) {}
            }
        } catch (e) {
            console.warn('[WM _finalizeViewer] emu stop:', e);
        }
    }

    win.props._emulatorInstance = null;
    win.props._ejsOwnerWinId = null;

    try {
        if (window.EJS_emulator && win.props && win.props._ejsOwnerWinId === win.id) {
            window.EJS_emulator = null;
        }
    } catch (e) {}
    try { if (window.EJS_gameUrl) window.EJS_gameUrl = ''; } catch (e) {}

    // --- Pannellum ---
    if (win.props._pannellumViewer) {
        try { win.props._pannellumViewer.destroy(); } catch (e) {}
        win.props._pannellumViewer = null;
    }

    // --- Browser API ---
    if (win.props._browserApi) {
        try { win.props._browserApi.destroy(); } catch (e) {}
        win.props._browserApi = null;
    }

    // --- Blob URLs ---
    if (Array.isArray(win.props._jsdosBlobUrls)) {
        win.props._jsdosBlobUrls.forEach(function (u) {
            try { URL.revokeObjectURL(u); } catch (e) {}
        });
        win.props._jsdosBlobUrls = [];
    }
    if (Array.isArray(win.props._emuBlobUrls)) {
        win.props._emuBlobUrls.forEach(function (u) {
            try { URL.revokeObjectURL(u); } catch (e) {}
        });
        win.props._emuBlobUrls = [];
    }
    if (Array.isArray(win.props._blobUrls)) {
        win.props._blobUrls.forEach(function (u) {
            try { URL.revokeObjectURL(u); } catch (e) {}
        });
        win.props._blobUrls = [];
    }

    // --- Очистка DOM окна ---
    if (win.bodyEl) {
        try { win.bodyEl.innerHTML = ''; } catch (e) {}
    }

    // --- Снятие фокуса ---
    try {
        if (document.activeElement && document.activeElement !== document.body) {
            document.activeElement.blur();
        }
        document.body.focus();
    } catch (e) {}
};