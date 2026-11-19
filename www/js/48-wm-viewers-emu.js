// ============================================================
// 48-wm-viewers-emu.js — Эмуляторы и консоль (JSDOS v3)
// ============================================================

FAR.WM = FAR.WM || {};
FAR.WM._emu = FAR.WM._emu || {};

// ============================================================
// === Загрузка библиотеки JSDOS v3 ===
// ============================================================

FAR.WM._loadJsdosV3 = function() {
    if (window._jsdosV3Loaded) return Promise.resolve();
    if (window._jsdosV3Promise) return window._jsdosV3Promise;

    window._jsdosV3Promise = new Promise((resolve, reject) => {
        const base = new URL('lib/js-dos/', window.location.href).href;

        const loadScript = (src) => {
            return new Promise((res, rej) => {
                const s = document.createElement('script');
                s.src = src;
                s.onload = res;
                s.onerror = () => rej(new Error('Failed to load ' + src));
                document.head.appendChild(s);
            });
        };

        const loadAll = async () => {
            // 1. jQuery (необходим для js-dos-api.js)
            if (!window.$ && !window.jQuery) {
                try {
                    await loadScript('https://code.jquery.com/jquery-3.6.0.min.js');
                    console.log('[JSDOS] jQuery загружен с CDN');
                } catch(e) {
                    console.warn('[JSDOS] Не удалось загрузить jQuery с CDN, пробуем локально...');
                    try {
                        await loadScript(base + 'jquery.min.js');
                    } catch(e2) {
                        console.error('[JSDOS] jQuery отсутствует! Интерфейс js-dos-api.js может не работать.');
                    }
                }
            }

            // 2. js-dos-api.js
            await loadScript(base + 'js-dos-api.js');
            // 3. js-dos-v3.js
            await loadScript(base + 'js-dos-v3.js');
            // 4. jsdos-patch.js
            await loadScript(base + 'jsdos-patch.js');

            // 5. Переопределяем SaveManager.init, чтобы использовать постоянный ключ сохранения
            if (window.Dosbox && window.Dosbox.SaveManager) {
                const sm = window.Dosbox.SaveManager;
                const origInit = sm.init;
                sm.init = function(module, saveKey) {
                    const stableKey = window._currentJsdosSaveKey || saveKey;
                    console.log('[JSDOS] SaveManager.init -> stableKey:', stableKey);
                    return origInit.call(this, module, stableKey);
                };
            }

            window._jsdosV3Loaded = true;
            resolve();
        };

        loadAll().catch(reject);
    });
    return window._jsdosV3Promise;
};

// ============================================================
// === JSDOS — сохранение/загрузка состояния ===
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
// === Кнопки 💾 / 📂 в заголовке WM-окна ===
// ============================================================

FAR.WM._installJsdosStateButtons = function (win) {
    if (!win || !win.el) return;
    const titlebar = win.el.querySelector('.wm-titlebar');
    if (!titlebar) return;
    const actions = titlebar.querySelector('.wm-title-actions');
    if (!actions) return;

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

    const minBtn = actions.querySelector('.wm-btn-min');
    if (minBtn) {
        actions.insertBefore(loadBtn, minBtn);
        actions.insertBefore(saveBtn, minBtn);
    } else {
        actions.insertBefore(loadBtn, actions.firstChild);
        actions.insertBefore(saveBtn, actions.firstChild);
    }
};

// ============================================================
// === Получение состояния из SaveManager ===
// ============================================================

FAR.WM._jsdosGetState = async function (win) {
    const SaveManager = window.Dosbox && window.Dosbox.SaveManager;
    if (!SaveManager || !win.props._jsdosReady) return null;

    if (window._currentJsdosSaveKey) {
        SaveManager.saveKey = window._currentJsdosSaveKey;
    }

    try {
        const records = await SaveManager._readAll();
        if (records.length === 0) return null;

        const payload = {
            version: 1,
            saveKey: SaveManager.saveKey,
            exportedAt: new Date().toISOString(),
            files: records.map(r => ({
                path: r.path,
                data: Array.from(r.data)
            }))
        };
        return new TextEncoder().encode(JSON.stringify(payload));
    } catch (e) {
        console.warn('[JSDOS] getState failed:', e);
        return null;
    }
};

// ============================================================
// === Ручной экспорт ===
// ============================================================

FAR.WM._jsdosExportState = async function (win) {
    if (!win || !win.props) return;
    if (!win.props._jsdosInstance) { FAR.toast('Эмулятор не запущен', 'warning'); return; }
    if (!win.props._jsdosReady) { FAR.toast('Игра ещё загружается — подождите пару секунд', 'warning'); return; }

    FAR.toast('Сохранение состояния...', 'info');

    try {
        const stateBytes = await FAR.WM._jsdosGetState(win);
        if (!stateBytes || stateBytes.byteLength === 0) {
            FAR.toast('Не удалось получить состояние (пустой файл).', 'error');
            return;
        }

        const item = win.props.file || {};
        const baseName = (item.name || 'game.jsdos').replace(/\.[^/.]+$/, '');
        const fileName = baseName + '.state';

        FAR.saveBlobAs(new Blob([stateBytes], { type: 'application/octet-stream' }), fileName);

        if (win.props.side && win.props.file) {
            await FAR.WM._jsdosSaveStateToDB(win.props.side, win.props.file, stateBytes);
        }

        FAR.toast('Состояние выгружено: ' + fileName, 'success');
    } catch (e) {
        console.error('[JSDOS] export failed:', e);
        FAR.toast('Ошибка: ' + e.message, 'error');
    }
};

// ============================================================
// === Ручной импорт ===
// ============================================================

FAR.WM._jsdosImportState = function (win) {
    if (!win || !win.props) return;
    if (!win.props._jsdosInstance) { FAR.toast('Эмулятор не запущен', 'warning'); return; }
    if (!win.props._jsdosReady) { FAR.toast('Игра ещё загружается', 'warning'); return; }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.state,application/json';
    input.onchange = async function () {
        const f = input.files && input.files[0];
        if (!f) return;
        try {
            const buf = await f.arrayBuffer();
            const state = new Uint8Array(buf);
            if (state.byteLength === 0) { FAR.toast('Файл пустой', 'warning'); return; }

            const payload = JSON.parse(new TextDecoder().decode(state));
            if (!payload || !Array.isArray(payload.files)) throw new Error('Неверный формат файла сохранения');

            const SaveManager = window.Dosbox.SaveManager;
            if (window._currentJsdosSaveKey) SaveManager.saveKey = window._currentJsdosSaveKey;

            const records = payload.files.map(x => ({
                path: x.path,
                data: new Uint8Array(x.data)
            }));

            await SaveManager._writeAll(records);
            await SaveManager.restore();

            FAR.toast('Состояние загружено из файла', 'success');
            if (win.props.side && win.props.file) {
                await FAR.WM._jsdosSaveStateToDB(win.props.side, win.props.file, state);
            }
        } catch (e) {
            console.error('[JSDOS] import state failed:', e);
            FAR.toast('Ошибка загрузки: ' + e.message, 'error');
        }
    };
    input.click();
};

// ============================================================
// JSDOS - Основная функция монтирования
// ============================================================

FAR.WM._mountJsdosViewer = async function (win, props) {
    const item = props.file;
    const side = props.side || FAR.activePanel;

    win.el.querySelector('.wm-title-text').textContent = '🕹️ ' + item.name;

    // Внедряем CSS-стили для принудительного масштабирования канваса DOSBox
    win.bodyEl.innerHTML =
        '<style>' +
        '  .jsdos-wm-wrapper { width: 100%; height: 100%; position: relative; background: #000; overflow: hidden; display: flex; flex-direction: column; }' +
        '  .jsdos-wm-wrapper > div[data-role="root"] { flex: 1 1 0%; width: 100%; height: 100%; position: relative; outline: none; min-height: 0; }' +
        '  .jsdos-wm-wrapper .dosbox-container { width: 100% !important; height: 100% !important; position: absolute !important; inset: 0 !important; margin: 0 !important; padding: 0 !important; display: flex !important; align-items: center !important; justify-content: center !important; background: #000 !important; }' +
        '  .jsdos-wm-wrapper canvas { position: absolute !important; top: 50% !important; left: 50% !important; transform: translate(-50%, -50%) !important; width: 100% !important; height: 100% !important; max-width: 100% !important; max-height: 100% !important; object-fit: contain !important; margin: 0 !important; padding: 0 !important; image-rendering: pixelated !important; display: block !important; }' +
        '  .jsdos-wm-wrapper .dosbox-overlay { width: 100% !important; height: 100% !important; position: absolute !important; inset: 0 !important; }' +
        '</style>' +
        '<div class="jsdos-wm-wrapper">' +
        '  <div data-role="root" id="jsdos-root-' + win.id + '" class="dosbox-default" tabindex="0"></div>' +
        '  <div data-role="loading" style="position:absolute;inset:0;background:rgba(0,0,0,0.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#a6adc8;z-index:10;">' +
        '    <div style="width:50px;height:50px;border:4px solid #313244;border-top-color:#89b4fa;border-radius:50%;animation:spin 1s linear infinite;"></div>' +
        '    <div data-role="status" style="font-size:14px;">Загрузка игры…</div>' +
        '  </div>' +
        '</div>';

    const wrapper = win.bodyEl.querySelector('.jsdos-wm-wrapper');
    const root = win.bodyEl.querySelector('[data-role="root"]');
    const loadingEl = win.bodyEl.querySelector('[data-role="loading"]');
    const statusEl = win.bodyEl.querySelector('[data-role="status"]');

    try {
        statusEl.textContent = 'Загрузка библиотеки JS-DOS v3…';
        await FAR.WM._loadJsdosV3();
    } catch(e) {
        loadingEl.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">Ошибка загрузки библиотеки: ' + FAR.escapeHtml(e.message) + '</div>';
        return;
    }

    // Устанавливаем постоянный ключ сохранения
    window._currentJsdosSaveKey = item.path;

    let url = null;
    try {
        statusEl.textContent = 'Чтение .jsdos файла…';
        const r = await FAR.readFileBodyFromSide(side, item);
        const blob = new Blob([r.data], { type: r.contentType || 'application/octet-stream' });
        url = URL.createObjectURL(blob);
        FAR.WM._trackBlobUrl(win, url);
    } catch (e) {
        loadingEl.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">Ошибка чтения: ' + FAR.escapeHtml(e.message) + '</div>';
        return;
    }

    // Предзагрузка состояния из FileBD в IndexedDB
    statusEl.textContent = 'Проверка сохранений…';
    const stateBytes = await FAR.WM._jsdosLoadStateFromDB(side, item);
    if (stateBytes) {
        try {
            const payload = JSON.parse(new TextDecoder().decode(stateBytes));
            if (payload && Array.isArray(payload.files)) {
                const SaveManager = window.Dosbox.SaveManager;
                SaveManager.saveKey = item.path;
                const records = payload.files.map(x => ({
                    path: x.path,
                    data: new Uint8Array(x.data)
                }));
                await SaveManager._writeAll(records);
                console.log('[JSDOS] Preloaded state into IndexedDB');
            }
        } catch(e) {
            console.warn('[JSDOS] Failed to preload state:', e);
        }
    }

    // Запуск
    statusEl.textContent = 'Запуск DOSBox…';
    try {
        const dosbox = new window.Dosbox({
            id: root.id,
            autoStart: true,
            file: url,
            persistSaves: true
        });

        win.props._jsdosInstance = dosbox;
        win.props._jsdosReady = false;

        FAR.WM._installJsdosStateButtons(win);

        // ResizeObserver для пересчета размеров канваса и координат мыши при изменении окна WM
        if (window.ResizeObserver) {
            win._jsdosResizeObserver = new ResizeObserver(() => {
                window.dispatchEvent(new Event('resize'));
            });
            win._jsdosResizeObserver.observe(wrapper);
        }

        // Помечаем готовность через 3 секунды
        setTimeout(() => {
            if (!FAR.WM.getWindow(win.id)) return;
            win.props._jsdosReady = true;
            loadingEl.style.display = 'none';

            try { root.focus(); } catch(e) {}

            if (typeof FAR.VirtualGamepad !== 'undefined') {
                FAR.VirtualGamepad.mount(root, 'jsdos');
            }
            FAR.WM._installViewerNavButtons(win, item, side);

            // Триггерим ресайз для точной подгонки
            window.dispatchEvent(new Event('resize'));
        }, 3000);

        // Периодическая синхронизация из IndexedDB в FileBD (каждые 15 секунд)
        const autoSaveTimer = setInterval(async () => {
            if (win.props._jsdosReady && win.props._jsdosInstance) {
                try {
                    const stateBytes = await FAR.WM._jsdosGetState(win);
                    if (stateBytes) {
                        await FAR.WM._jsdosSaveStateToDB(side, item, stateBytes);
                        console.log('[JSDOS] Auto-saved to FileBD (periodic)');
                    }
                } catch(e) { /* ignore */ }
            }
        }, 15000);

        // Синхронизация при закрытии окна
        const closeBtn = win.el.querySelector('.wm-btn-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', function(e) {
                e.stopImmediatePropagation();
                e.preventDefault();

                FAR.toast('Сохранение состояния перед закрытием...', 'info');

                setTimeout(async () => {
                    try {
                        const stateBytes = await FAR.WM._jsdosGetState(win);
                        if (stateBytes) {
                            await FAR.WM._jsdosSaveStateToDB(side, item, stateBytes);
                            console.log('[JSDOS] Auto-saved to FileBD on close');
                        }
                    } catch (err) {
                        console.warn('[JSDOS] Auto-save failed:', err);
                    } finally {
                        clearInterval(autoSaveTimer);
                        FAR.WM.closeWindow(win.id);
                    }
                }, 100);
            }, true);
        }

        // Очистка таймера и ResizeObserver
        const prevOnClose = win.onClose;
        win.onClose = function (w) {
            clearInterval(autoSaveTimer);
            if (win._jsdosResizeObserver) {
                win._jsdosResizeObserver.disconnect();
                win._jsdosResizeObserver = null;
            }
            if (typeof prevOnClose === 'function') prevOnClose(w);
        };

    } catch (e) {
        loadingEl.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">Ошибка: ' + FAR.escapeHtml(e.message) + '</div>';
        console.error('[JSDOS] mount error:', e);
    }
};

// _mountNesViewer УДАЛЕНА

FAR.WM._mountEmulatorViewer = async function (win, props) {
    const others = FAR.WM.state.windows.filter(w => w.appId === 'emulator' && w.id !== win.id);
    for (const other of others) { try { FAR.WM._finalizeViewer(other); FAR.WM.closeWindow(other.id, true); } catch (e) {} }

    const item = props.file;
    const side = props.side || FAR.activePanel;
    const core = (typeof FAR._getEmulatorCore === 'function') ? FAR._getEmulatorCore(item) : null;

    if (!core) {
        win.el.querySelector('.wm-title-text').textContent = '🕹️ ' + item.name;
        FAR.WM._mountNotice(win, '🕹️', 'Формат файла не поддерживается EmulatorJS.');
        return;
    }

    win.el.querySelector('.wm-title-text').textContent = '🕹️ ' + item.name + ' (' + core + ')';
    win.bodyEl.innerHTML =
        '<div style="height:100%;position:relative;background:#000;">' +
        '<div data-role="root" style="width:100%;height:100%;min-height:400px;"></div>' +
        '<div data-role="loading" style="position:absolute;inset:0;background:rgba(0,0,0,0.9);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#a6adc8;z-index:10;">' +
        '<div style="width:50px;height:50px;border:4px solid #313244;border-top-color:#89b4fa;border-radius:50%;animation:spin 1s linear infinite;"></div>' +
        '<div data-role="status" style="font-size:14px;">Загрузка эмулятора…</div></div></div>';

    const root = win.bodyEl.querySelector('[data-role="root"]');
    const loadingEl = win.bodyEl.querySelector('[data-role="loading"]');
    const statusEl = win.bodyEl.querySelector('[data-role="status"]');

    win.props._emuSeq = (win.props._emuSeq || 0) + 1;
    const containerId = 'wm-emu-' + win.id + '-' + win.props._emuSeq;
    root.id = containerId;

    let blobUrl = null;
    try {
        statusEl.textContent = 'Загрузка ROM…';
        const r = await FAR.readFileBodyFromSide(side, item);
        const blob = new Blob([r.data], { type: r.contentType || 'application/octet-stream' });
        blobUrl = URL.createObjectURL(blob);
        FAR.WM._trackBlobUrl(win, blobUrl);
    } catch (e) { loadingEl.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">Ошибка ROM: ' + FAR.escapeHtml(e.message) + '</div>'; return; }

    if (typeof window.EmulatorJS !== 'function') {
        statusEl.textContent = 'Загрузка библиотеки…';
        const tempContainer = document.createElement('div');
        tempContainer.id = 'ejs-temp-' + win.id;
        tempContainer.style.cssText = 'position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;overflow:hidden;pointer-events:none;';
        document.body.appendChild(tempContainer);

        window.EJS_player = '#' + tempContainer.id;
        window.EJS_core = core; window.EJS_gameUrl = blobUrl; window.EJS_gameName = item.name;
        window.EJS_pathtodata = 'lib/js-emulator/'; window.EJS_color = '#89b4fa'; window.EJS_startOnLoaded = false;

        try {
            if (typeof FAR._loadEmulatorLoader !== 'function') throw new Error('Модуль 30-emulator-viewer.js не загружен');
            await FAR._loadEmulatorLoader();
        } catch (e) {
            try { tempContainer.remove(); } catch (e2) {}
            loadingEl.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">Ошибка библиотеки: ' + FAR.escapeHtml(e.message) + '</div>';
            return;
        }
        setTimeout(() => { try { tempContainer.remove(); } catch (e2) {} }, 200);
    }

    if (typeof window.EmulatorJS !== 'function') { loadingEl.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">window.EmulatorJS не определён</div>'; return; }

    window.EJS_player = '#' + containerId;
    window.EJS_core = core; window.EJS_gameUrl = blobUrl; window.EJS_gameName = item.name;
    window.EJS_pathtodata = 'lib/js-emulator/'; window.EJS_color = '#89b4fa'; window.EJS_startOnLoaded = true;

    statusEl.textContent = 'Запуск ядра ' + core + '…';

    try {
        const emu = new window.EmulatorJS('#' + containerId, {
            gameUrl: blobUrl, gameName: item.name, dataPath: 'lib/js-emulator/',
            system: core, color: '#89b4fa', startOnLoad: true
        });
        win.props._emulatorInstance = emu;

        setTimeout(() => {
            if (!FAR.WM.getWindow(win.id)) return;
            if (loadingEl) loadingEl.style.display = 'none';
            if (typeof FAR.VirtualGamepad !== 'undefined') {
                FAR.VirtualGamepad.mount(root, core);
            }
        }, 3000);
        FAR.setStatus('🕹️ EmulatorJS: ' + item.name + ' (' + core + ')');
        FAR.WM._installViewerNavButtons(win, item, side);
    } catch (e) { loadingEl.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">Ошибка запуска: ' + FAR.escapeHtml(e.message) + '</div>'; }
};

FAR.WM._mountConsoleViewer = async function (win, props) {
    win.el.querySelector('.wm-title-text').textContent = '🖥 Console';
    if (win.props._consoleApi) { try { win.props._consoleApi.destroy(); } catch (e) {} win.props._consoleApi = null; }
    win.bodyEl.innerHTML = '';
    win.bodyEl.style.display = 'flex'; win.bodyEl.style.flexDirection = 'column'; win.bodyEl.style.minHeight = '0';
    win.props._consoleApi = FAR._createConsole(win.bodyEl, {});
    setTimeout(() => { const ta = win.bodyEl.querySelector('.xterm-helper-textarea'); if (ta) try { ta.focus(); } catch (e) {} }, 100);
};