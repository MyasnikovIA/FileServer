// ============================================================
// 48-wm-viewers-emu.js — WM-режим для JSDOS и EmulatorJS.
// ============================================================

FAR.WM = FAR.WM || {};
FAR.WM._emu = FAR.WM._emu || {};

// ============================================================
// === НОВОЕ: JSDOS — сохранение/загрузка состояния ===
// ============================================================

FAR.WM._jsdosGetStatePath = function (item) {
    if (!item || !item.path) return '';
    return FAR.normPath(item.path) + '.state';
};

FAR.WM._jsdosSaveStateToDB = async function (side, item, stateBytes) {
    if (!stateBytes || !item) return false;
    const ctx = FAR.side[side];
    if (!ctx || !ctx.db) return false;

    const statePath = FAR.WM._jsdosGetStatePath(item);
    if (!statePath) return false;

    const docId = 'f:' + encodeURIComponent(statePath);
    const blob = new Blob([stateBytes], { type: 'application/octet-stream' });

    try {
        let rev = null;
        try {
            const ex = await ctx.db.get(docId);
            rev = ex._rev;
        } catch (e) { if (e.status !== 404) throw e; }

        const doc = {
            _id: docId, type: 'file', path: statePath,
            name: statePath.split('/').pop(),
            size: blob.size, mtime: Date.now(),
            binary: true, contentType: 'application/octet-stream'
        };
        if (rev) doc._rev = rev;
        await ctx.db.put(doc);
        const fresh = await ctx.db.get(docId);
        await ctx.db.putAttachment(docId, 'b', fresh._rev, blob,
            'application/octet-stream');
        return true;
    } catch (e) {
        console.warn('[JSDOS] save state to DB failed:', e);
        return false;
    }
};

FAR.WM._jsdosLoadStateFromDB = async function (side, item) {
    if (!item) return null;
    const ctx = FAR.side[side];
    if (!ctx || !ctx.db) return null;

    const statePath = FAR.WM._jsdosGetStatePath(item);
    if (!statePath) return null;

    const docId = 'f:' + encodeURIComponent(statePath);
    try {
        await ctx.db.get(docId);
        const att = await ctx.db.getAttachment(docId, 'b', { binary: true });
        const r = await FAR._attachmentToBytesAsync(att, 'application/octet-stream');
        return r.bytes;
    } catch (e) {
        if (e.status !== 404) {
            console.warn('[JSDOS] load state from DB failed:', e);
        }
        return null;
    }
};

// ============================================================
// === НОВОЕ: кнопки 💾 / 📂 в заголовке WM-окна ===
// ============================================================

FAR.WM._installJsdosStateButtons = function (win) {
    if (!win || !win.el) return;
    const titlebar = win.el.querySelector('.wm-titlebar');
    if (!titlebar) return;
    const actions = titlebar.querySelector('.wm-title-actions');
    if (!actions) return;

    // Удаляем старые (на случай повторного вызова)
    actions.querySelectorAll('.wm-jsdos-state-btn').forEach(function (b) { b.remove(); });

    const saveBtn = document.createElement('button');
    saveBtn.className = 'wm-title-btn wm-jsdos-state-btn';
    saveBtn.textContent = '💾';
    saveBtn.title = 'Выгрузить состояние на диск';
    saveBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        FAR.WM._jsdosExportState(win);
    });

    const loadBtn = document.createElement('button');
    loadBtn.className = 'wm-title-btn wm-jsdos-state-btn';
    loadBtn.textContent = '📂';
    loadBtn.title = 'Загрузить состояние с диска';
    loadBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        FAR.WM._jsdosImportState(win);
    });

    // Вставляем ПЕРЕД кнопкой «Свернуть» (─)
    const minBtn = actions.querySelector('.wm-btn-min');
    if (minBtn) {
        actions.insertBefore(loadBtn, minBtn);
        actions.insertBefore(saveBtn, minBtn);
    } else {
        actions.insertBefore(loadBtn, actions.firstChild);
        actions.insertBefore(saveBtn, actions.firstChild);
    }
};

FAR.WM._jsdosExportState = async function (win) {
    console.log('[JSDOS] export click, win=', !!win, 'props=', !!(win && win.props));
    if (!win || !win.props) { alert('Нет окна/свойств'); return; }

    const ci = win.props._jsdosInstance;
    console.log('[JSDOS] instance=', !!ci, 'ready=', win.props._jsdosReady);

    if (!ci) {
        alert('Эмулятор не запущен');
        return;
    }
    if (!win.props._jsdosReady) {
        alert('Игра ещё загружается — подождите пару секунд и попробуйте снова');
        return;
    }

    let stateBytes = null;

    // 1. Пытаемся через стандартный API (v7.1+ / v8+)
    if (typeof ci.persist === 'function') {
        try {
            if (typeof ci.save === 'function' && ci.save !== ci.persist) {
                try { await ci.save(); } catch (e) {}
            }
            stateBytes = await ci.persist();
        } catch (e) {
            console.warn('[JSDOS] persist failed:', e);
        }
    }

    // 2. Если API нет или вернул пустоту — используем прямой доступ к FS (v6)
    if (!stateBytes || stateBytes.byteLength === 0) {
        // Ищем FS в разных версиях js-dos
        let fs = ci.fs || (ci.client && ci.client.fs);
        if (!fs) {
            let module = ci.emulators && (ci.emulators.module || ci.emulators.Module);
            if (module && module.FS) fs = module.FS;
        }

        if (!fs) {
            alert('Не удалось получить доступ к файловой системе эмулятора.');
            return;
        }
        console.log('[JSDOS] Используем прямой доступ к FS для сохранения');

        if (typeof JSZip === 'undefined') {
            alert('JSZip не загружен. Проверьте lib/jszip/jszip.min.js');
            return;
        }

        const zip = new JSZip();

        function walk(path) {
            let stat;
            try { stat = fs.stat(path); } catch (e) { return; }
            if (fs.isDir(stat.mode)) {
                let entries;
                try { entries = fs.readdir(path); } catch (e) { return; }
                for (const e of entries) {
                    if (e === '.' || e === '..') continue;
                    walk(path + '/' + e);
                }
            } else {
                try {
                    const data = fs.readFile(path);
                    // Убираем ведущий слэш для ZIP
                    zip.file(path.replace(/^\//, ''), data);
                } catch (e) {
                    console.warn('[JSDOS] read file failed:', path, e);
                }
            }
        }

        // Сохраняем диски C: и D: (там лежат сейвы игр)
        const drives = ['/C', '/D'];
        for (const drive of drives) {
            try {
                if (fs.analyzePath(drive).exists) {
                    walk(drive);
                }
            } catch (e) {}
        }

        try {
            stateBytes = await zip.generateAsync({ type: 'uint8array' });
        } catch (e) {
            console.error('[JSDOS] zip generation failed:', e);
            alert('Ошибка упаковки: ' + e.message);
            return;
        }
    }

    if (!stateBytes || stateBytes.byteLength === 0) {
        alert('Не удалось получить состояние (0 байт)');
        return;
    }

    const item = win.props.file || {};
    const baseName = (item.name || 'game.jsdos').replace(/\.[^/.]+$/, '');
    const fileName = baseName + '.state';

    // Скачиваем пользователю
    FAR.saveBlobAs(
        new Blob([stateBytes], { type: 'application/octet-stream' }),
        fileName
    );

    // Сохраняем в БД для авто-восстановления
    if (win.props.side && win.props.file) {
        try {
            await FAR.WM._jsdosSaveStateToDB(win.props.side, win.props.file, stateBytes);
        } catch (e) {
            console.warn('[JSDOS] DB save failed:', e);
        }
    }

    FAR.toast('Состояние выгружено: ' + fileName +
        ' (' + FAR.formatSize(stateBytes.byteLength) + ')', 'success');
    console.log('[JSDOS] state exported:', fileName, stateBytes.byteLength, 'bytes');
};

FAR.WM._jsdosImportState = function (win) {
    console.log('[JSDOS] import click, win=', !!win);
    if (!win || !win.props) { alert('Нет окна/свойств'); return; }

    const ci = win.props._jsdosInstance;
    if (!ci) { alert('Эмулятор не запущен'); return; }
    if (!win.props._jsdosReady) {
        alert('Игра ещё загружается — подождите пару секунд');
        return;
    }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.state,application/octet-stream';
    input.onchange = async function () {
        const f = input.files && input.files[0];
        if (!f) return;
        try {
            const buf   = await f.arrayBuffer();
            const state = new Uint8Array(buf);
            if (state.byteLength === 0) {
                alert('Файл пустой');
                return;
            }

            let restored = false;

            // 1. Пытаемся через стандартный API (v7.1+ / v8+)
            if (typeof ci.restore === 'function') {
                try {
                    await ci.restore(state);
                    restored = true;
                } catch (e) {
                    console.warn('[JSDOS] restore via API failed:', e);
                }
            }

            // 2. Если не вышло — пробуем распаковать в FS
            if (!restored) {
                let fs = ci.fs || (ci.client && ci.client.fs);
                if (!fs) {
                    let module = ci.emulators && (ci.emulators.module || ci.emulators.Module);
                    if (module && module.FS) fs = module.FS;
                }

                if (!fs) throw new Error('Нет метода restore и нет доступа к FS');
                if (typeof JSZip === 'undefined') throw new Error('JSZip не загружен');

                console.log('[JSDOS] Используем прямой доступ к FS для восстановления');
                const zip = await JSZip.loadAsync(state);

                const entries = Object.keys(zip.files);
                for (const path of entries) {
                    const file = zip.files[path];
                    if (file.dir) continue;

                    const data = await file.async('uint8array');
                    const targetPath = '/' + path; // восстанавливаем в корень (C:\...)

                    // Создаем директории
                    const parts = targetPath.split('/');
                    let cur = '';
                    for (let i = 0; i < parts.length - 1; i++) {
                        cur += (i > 0 ? '/' : '') + parts[i];
                        if (cur && !fs.analyzePath(cur).exists) {
                            try { fs.mkdir(cur); } catch(e) {}
                        }
                    }
                    try {
                        fs.writeFile(targetPath, data);
                    } catch (e) {
                        console.warn('[JSDOS] write failed:', targetPath, e);
                    }
                }
                restored = true;
            }

            if (!restored) throw new Error('Не удалось восстановить состояние');

            FAR.toast('Состояние загружено из файла', 'success');
            console.log('[JSDOS] state restored');

            // Кэшируем в БД
            if (win.props.side && win.props.file) {
                try {
                    await FAR.WM._jsdosSaveStateToDB(win.props.side, win.props.file, state);
                } catch (e) {
                    console.warn('[JSDOS] DB save failed:', e);
                }
            }
        } catch (e) {
            console.error('[JSDOS] import state failed:', e);
            alert('Ошибка загрузки: ' + e.message);
        }
    };
    input.click();
};

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
        win.props._jsdosReady = false;
        instance.run(blobUrl)
            .then(() => {
                if (runFailed) return;
                win.props._jsdosReady = true;
                console.log('[JSDOS] run() complete, ready');
            })
            .catch(e => {
                runFailed = true;
                console.error('[WM JSDOS] run error:', e);
                const rawMsg = (e && (e.message || String(e))) || 'unknown';
                const combined = Array.isArray(e) ? String(e) : rawMsg;
                let userMsg;
                if (combined.indexOf('dosbox.conf') !== -1 ||
                    combined.indexOf('Broken bundle') !== -1) {
                    userMsg =
                        'Файл .jsdos повреждён или не является jsdos-бандлом.<br>' +
                        '<small>Отсутствует <code>.jsdos/dosbox.conf</code>.</small>';
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

        // === НОВОЕ: авто-восстановление сохранённого состояния ===
        setTimeout(async () => {
            if (runFailed) return;
            try {
                const ci = win.props._jsdosInstance;
                if (ci && typeof ci.restore === 'function') {
                    const saved = await FAR.WM._jsdosLoadStateFromDB(side, item);
                    if (saved && saved.byteLength > 0) {
                        await ci.restore(saved);
                        FAR.toast('Состояние восстановлено автоматически', 'success');
                    }
                }
            } catch (e) {
                console.warn('[JSDOS] auto-restore failed:', e);
            }
        }, 1000);

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

        // === НОВОЕ: кнопки 💾 / 📂 в titlebar ===
        FAR.WM._installJsdosStateButtons(win);
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
        loading.innerHTML = '<div class="emulator-loading-text">Ошибка запуска: ' +
            FAR.escapeHtml(e.message) + '</div>';
    }
};

// ============================================================
// Финализация WM-окна.
//
// ВАЖНО: эта функция ПЕРЕОПРЕДЕЛЯЕТ версию из 47-wm-viewers.js,
// поэтому обязана покрывать ВСЕ типы ресурсов.
//
// === ИЗМЕНЕНО: JSDOS сохраняет состояние в БД перед stop() ===
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

    // --- JSDOS: сохранить состояние в БД, потом остановить ---
    if (win.props._jsdosInstance) {
        const ci    = win.props._jsdosInstance;
        const item  = win.props.file;
        const side  = win.props.side;
        win.props._jsdosInstance = null;   // защита от повторного вызова

        // Страховка от зависания persist() — принудительный stop через 5 с
        const stopTimer = setTimeout(function () {
            try { ci.stop(); } catch (e) {}
        }, 5000);

        (async function () {
            try {
                if (item && side && typeof ci.persist === 'function') {
                    if (typeof ci.save === 'function') {
                        try { await ci.save(); } catch (e) {}
                    }
                    const state = await ci.persist();
                    if (state && state.byteLength > 0) {
                        await FAR.WM._jsdosSaveStateToDB(side, item, state);
                    }
                }
            } catch (e) {
                console.warn('[JSDOS] save on close failed:', e);
            } finally {
                clearTimeout(stopTimer);
                try { ci.stop(); } catch (e) {}
            }
        })();
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
                try { if (typeof emu.stop  === 'function') emu.stop();      } catch (e) {}
                try { if (typeof emu.destroy === 'function') emu.destroy(); } catch (e) {}
            }
        } catch (e) {}
    }

    // --- Blob URLs JSDOS ---
    if (Array.isArray(win.props._jsdosBlobUrls)) {
        for (const u of win.props._jsdosBlobUrls) {
            try { URL.revokeObjectURL(u); } catch (e) {}
        }
        win.props._jsdosBlobUrls = [];
    }

    // --- Blob URLs EmulatorJS ---
    if (Array.isArray(win.props._emuBlobUrls)) {
        for (const u of win.props._emuBlobUrls) {
            try { URL.revokeObjectURL(u); } catch (e) {}
        }
        win.props._emuBlobUrls = [];
    }

    // --- Общие blob URLs (для панорам / PDF / браузера / NES и др.) ---
    if (Array.isArray(win.props._blobUrls)) {
        for (const u of win.props._blobUrls) {
            try { URL.revokeObjectURL(u); } catch (e) {}
        }
        win.props._blobUrls = [];
    }

    // --- NES ---
    if (win.props._nesBrowser) {
        try { win.props._nesBrowser.destroy(); } catch (e) {}
        win.props._nesBrowser = null;
    }

    // --- Pannellum ---
    if (win.props._pannellumViewer) {
        try { win.props._pannellumViewer.destroy(); } catch (e) {}
        win.props._pannellumViewer = null;
    }

    // --- Встроенный браузер ---
    if (win.props._browserApi) {
        try { win.props._browserApi.destroy(); } catch (e) {}
        win.props._browserApi = null;
    }
};
