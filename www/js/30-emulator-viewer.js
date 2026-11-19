// ============================================================
// 30-emulator-viewer.js — Просмотр игр через EmulatorJS
// ============================================================
// ============================================================
// ПАТЧ EmulatorJS.prototype.handleResize
//
// Причина: EmulatorJS регистрирует глобальный window.addEventListener(
// 'resize', ...) в конструкторе и НЕ снимает его при destroy().
// После закрытия окна инстанс остаётся «зомби»: его this.elements.parent
// уже null (DOM вычищен), но глобальный listener продолжает получать
// события resize (от других эмуляторов, от JSDOS, от ресайза страницы)
// и падает: Cannot read properties of null (reading 'classList').
//
// Патч ставит null-guard в начале handleResize. Это защищает все
// инстансы (и живые, и зомби) и убирает шум в консоли.
// ============================================================
FAR._patchEmulatorJSResize = function () {
    const E = window.EmulatorJS;
    if (!E || !E.prototype) return false;

    const proto = E.prototype;
    if (proto._farPatchedHandleResize) return true;

    const orig = proto.handleResize;
    if (typeof orig !== 'function') return false;

    proto.handleResize = function () {
        try {
            // Если родительского контейнера нет (уничтожен) — молча выходим
            if (!this || !this.elements || !this.elements.parent) return;
            if (!this.elements.parent.isConnected) return;
            return orig.apply(this, arguments);
        } catch (e) {
            // Зомби-инстанс — гасим молча
        }
    };
    proto._farPatchedHandleResize = true;
    console.log('[EmulatorJS] handleResize патчен (null-safe)');
    return true;
};

// То же самое, но для конкретного инстанса (на случай если
// handleResize задан как own-property через .bind(this) в конструкторе).
FAR._patchEmulatorJSInstanceResize = function (emu) {
    if (!emu || emu._farPatchedResizeInstance) return;
    const orig = emu.handleResize;
    if (typeof orig !== 'function') return;
    emu.handleResize = function () {
        try {
            if (!this || !this.elements || !this.elements.parent) return;
            if (!this.elements.parent.isConnected) return;
            return orig.apply(this, arguments);
        } catch (e) { /* swallow */ }
    };
    emu._farPatchedResizeInstance = true;
};

// Фильтр ошибок — belt-and-suspenders: если по какой-то причине
// патч не успел примениться (или EmulatorJS переопределяет свой
// handleResize динамически), глушим конкретно этот «classList of null».
if (!FAR._ejsResizeErrorFilterInstalled) {
    FAR._ejsResizeErrorFilterInstalled = true;
    window.addEventListener('error', function (ev) {
        try {
            const msg = ev && ev.message ? String(ev.message) : '';
            if (msg.indexOf("Cannot read properties of null") !== -1 &&
                (msg.indexOf("classList") !== -1 || msg.indexOf("parent") !== -1)) {
                try { ev.preventDefault(); ev.stopPropagation(); } catch (e) {}
                return true;
            }
        } catch (e) {}
    }, true);
}

// ============================================================
// Жёсткая остановка EmulatorJS.
//
// EmulatorJS 4.x держит собственный AudioContext (WebAudio),
// который продолжает звучать даже после удаления DOM-узлов.
// Обычного el.remove() или element.remove() недостаточно.
// Нужно пройтись по всем AudioContext'ам, которые успел
// создать эмулятор, и явно закрыть их.
// ============================================================
if (!FAR._hardStopEmulatorJS) {
    FAR._hardStopEmulatorJS = function (emu) {
        if (!emu) return;

        // 1. Останавливаем игровой цикл
        try {
            if (emu.gameManager && typeof emu.gameManager.toggleMainLoop === 'function') {
                emu.gameManager.toggleMainLoop(0);
            }
        } catch (e) { /* ignore */ }

        try {
            if (emu.Module && typeof emu.Module.pauseMainLoop === 'function') {
                emu.Module.pauseMainLoop();
            }
        } catch (e) { /* ignore */ }

        // 2. Останавливаем звук (WebAudio). Перебираем все известные пути.
        try {
            const ctx =
                (emu.Module && emu.Module.AL && emu.Module.AL.currentCtx &&
                    emu.Module.AL.currentCtx.audioCtx) ||
                (emu.Module && emu.Module.audioContext) ||
                (emu.AudioContext) ||
                (emu.audioContext) ||
                null;

            if (ctx && typeof ctx.close === 'function' && ctx.state !== 'closed') {
                try { ctx.close(); } catch (e) {}
            }
        } catch (e) { /* ignore */ }

        // 2b. Дополнительно — закрываем все AudioContext, которые мы
        //     успели зарегистрировать при создании инстанса.
        try {
            if (Array.isArray(FAR._emuAudioContexts)) {
                for (const c of FAR._emuAudioContexts) {
                    try {
                        if (c && typeof c.close === 'function' && c.state !== 'closed') c.close();
                    } catch (e) {}
                }
                FAR._emuAudioContexts = [];
            }
        } catch (e) { /* ignore */ }

        // 3. Встроенные pause/stop/destroy
        try { if (typeof emu.pause === 'function')   emu.pause(true); } catch (e) {}
        try { if (typeof emu.stop === 'function')    emu.stop();      } catch (e) {}
        try { if (typeof emu.destroy === 'function') emu.destroy();   } catch (e) {}

        // 4. Прерываем WASM
        try {
            if (emu.Module && typeof emu.Module.abort === 'function') {
                emu.Module.abort();
            }
        } catch (e) { /* ignore */ }

        // 5. Гасим все <audio>/<video>/<iframe> внутри контейнеров
        //    эмулятора (ищем по всем известным id/классам).
        try {
            const containers = [];
            const byRoot = document.getElementById('emulatorRoot');
            const byEmu  = document.getElementById('emulator');
            if (byRoot) containers.push(byRoot);
            if (byEmu)  containers.push(byEmu);
            document.querySelectorAll('.emulator-root').forEach(function (el) {
                containers.push(el);
            });

            for (const container of containers) {
                if (!container) continue;
                container.querySelectorAll('audio, video, iframe').forEach(function (el) {
                    try {
                        if (typeof el.pause === 'function') el.pause();
                        el.src = '';
                        if (typeof el.load === 'function') el.load();
                    } catch (e) {}
                });
            }
        } catch (e) { /* ignore */ }

        // 6. Обнуляем глобальную ссылку — иначе нельзя создать новый инстанс
        try {
            if (window.EJS_emulator === emu) window.EJS_emulator = null;
        } catch (e) { /* ignore */ }
    };
}

FAR._emulatorInstance = null;
FAR._emulatorCurrentItem = null;
FAR._emulatorCurrentSide = null;
FAR._emulatorBlobUrls = [];
FAR._emuAudioContexts = [];
FAR._ejsLoaderPromise = null;
FAR._ejsLibraryLoaded = false;
FAR._emulatorKeyHandler = null;

FAR.EMULATOR_EXT_TO_CORE = {
    // NES (Денди)
    'nes': 'nes', 'unf': 'nes', 'unif': 'nes',
    // SNES
    'smc': 'snes', 'fig': 'snes', 'sfc': 'snes', 'gd3': 'snes',
    'gd7': 'snes', 'dx2': 'snes', 'bsx': 'snes', 'swc': 'snes',
    // N64
    'z64': 'n64', 'n64': 'n64',
    // PC Engine
    'pce': 'pce',
    // NeoGeo Pocket
    'ngp': 'ngp', 'ngc': 'ngp',
    // WonderSwan
    'ws': 'ws', 'wsc': 'ws',
    // ColecoVision
    'col': 'coleco', 'cv': 'coleco',
    // Commodore 64
    'd64': 'vice_x64sc',
    // Nintendo DS / GBA / GB / GBC
    'nds': 'nds', 'gba': 'gba', 'gb': 'gb', 'gbc': 'gb', 'sgb': 'gb',
    // Из выпадающего меню EmulatorJS (по системам)
    'psx': 'psx', 'bin': 'psx', 'cue': 'psx', 'img': 'psx',
    'iso': 'psx', 'pbp': 'psx', 'chd': 'psx',
    'vb': 'vb', 'vboy': 'vb',
    'md': 'segaMD', 'gen': 'segaMD', 'smd': 'segaMD',
    'sms': 'segaMS',
    '32x': 'sega32x',
    'gg': 'segaGG',
    'lnx': 'lynx',
    'j64': 'jaguar', 'jag': 'jaguar',
    'a78': 'atari7800',
    'a26': 'atari2600',
    'zip': 'arcade',
    'pcfx': 'pcfx',
    'x128': 'vice_x128',
    'xvic': 'vice_xvic',
    'xplus4': 'vice_xplus4',
    'xpet': 'vice_xpet'
};

FAR._getEmulatorCore = function(item) {
    if (!item || item.isFolder) return null;
    const ext = (item.name.split('.').pop() || '').toLowerCase();
    return FAR.EMULATOR_EXT_TO_CORE[ext] || null;
};

FAR.isEmulatorFile = function(item) {
    return FAR._getEmulatorCore(item) !== null;
};

FAR._loadEmulatorLoader = function() {
    if (FAR._ejsLibraryLoaded && window.EmulatorJS) {
        // Патчим resize при каждом вызове — идемпотентно
        try { FAR._patchEmulatorJSResize(); } catch (e) {}
        return Promise.resolve();
    }
    if (FAR._ejsLoaderPromise) {
        return FAR._ejsLoaderPromise;
    }

    FAR._ejsLoaderPromise = new Promise(function(resolve, reject) {
        const script = document.createElement('script');
        script.src = 'lib/js-emulator/loader.js';
        script.async = true;

        let elapsed = 0;
        const STEP = 50;
        const TIMEOUT = 30000;

        const poll = function() {
            if (typeof window.EmulatorJS === 'function') {
                FAR._ejsLibraryLoaded = true;
                try { FAR._patchEmulatorJSResize(); } catch (e) {}
                console.log('[EmulatorJS] loader.js выполнен, window.EmulatorJS доступен');
                resolve();
                return;
            }
            elapsed += STEP;
            if (elapsed >= TIMEOUT) {
                FAR._ejsLoaderPromise = null;
                reject(new Error('loader.js не завершился за ' + TIMEOUT + ' мс'));
                return;
            }
            setTimeout(poll, STEP);
        };

        script.onerror = function() {
            FAR._ejsLoaderPromise = null;
            reject(new Error('Не удалось загрузить lib/js-emulator/loader.js'));
        };

        document.head.appendChild(script);
        setTimeout(poll, STEP);
    });

    return FAR._ejsLoaderPromise;
};

FAR.openEmulatorViewer = async function (item, side) {
    side = side || FAR.activePanel;

    if (!FAR.ensureDb()) return;
    if (typeof FAR._ensureItemName === 'function') {
        FAR._ensureItemName(item);
    }

    const core = FAR._getEmulatorCore(item);
    if (!core) {
        FAR.toast('Формат не поддерживается эмулятором', 'warning');
        return;
    }

    // Если открыто окно WM — запускаем там
    if (typeof FAR.WM !== 'undefined' && FAR.WM.state && FAR.WM.state.active) {
        return FAR.WM.openApp('emulator', { props: { file: item, side: side } });
    }

    try { FAR.closeViewer(); } catch (e) {}
    try { FAR.closePanoramaViewer(); } catch (e) {}
    try { if (typeof FAR.closeJsdosViewer === 'function') FAR.closeJsdosViewer(); } catch (e) {}

    FAR._emulatorCurrentItem = item;
    FAR._emulatorCurrentSide = side;
    FAR._emulatorBlobUrls.forEach(function(u) { try { URL.revokeObjectURL(u); } catch (e) {} });
    FAR._emulatorBlobUrls = [];

    const modal = document.getElementById('emulatorViewerModal');
    const title = document.getElementById('emulatorViewerTitle');
    const info = document.getElementById('emulatorViewerInfo');
    const coreHint = document.getElementById('emulatorCoreHint');
    const loading = document.getElementById('emulatorLoading');
    const loadingText = document.getElementById('emulatorLoadingText');
    const root = document.getElementById('emulatorRoot');

    title.textContent = '🕹️ ' + item.name;
    info.textContent = '';
    coreHint.textContent = 'Ядро: ' + core;
    modal.classList.remove('hidden');
    loading.classList.remove('hidden');
    loadingText.textContent = 'Загрузка библиотеки эмулятора…';

    FAR._destroyEmulator();
    root.innerHTML = '';
    root.id = 'emulatorRoot';

    loadingText.textContent = 'Загрузка модуля сохранений…';
    try {
        if (typeof FAR._installEmulatorStateHooks !== 'function') {
            await FAR.loadScriptOnce('js/32-emulator-state-db.js');
        }
        FAR._installEmulatorStateHooks();
    } catch (e) {
        console.warn('[EmuState] Не удалось загрузить модуль состояний:', e);
    }

    let blobUrl = null;
    try {
        const { data, contentType } = await FAR.readFileBodyFromSide(side, item);
        const blob = new Blob([data], { type: contentType || 'application/octet-stream' });
        blobUrl = URL.createObjectURL(blob);
        FAR._emulatorBlobUrls.push(blobUrl);
        info.textContent = `💾 ${FAR.formatSize(data.length)}`;
    } catch (e) {
        console.error('openEmulatorViewer: readFileBodyFromSide failed:', e);
        loading.classList.add('hidden');
        FAR.toast('Не удалось загрузить ROM: ' + e.message, 'error');
        return;
    }

    window.EJS_player        = '#emulatorRoot';
    window.EJS_core          = core;
    window.EJS_gameUrl       = blobUrl;
    window.EJS_gameName      = item.name;
    window.EJS_pathtodata    = 'lib/js-emulator/';
    window.EJS_color         = '#89b4fa';
    window.EJS_startOnLoaded = true;

    FAR._emulatorSuppressEnter();

    try {
        await FAR._runEmulator(root, blobUrl);
        FAR._emulatorInstance = window.EJS_emulator || null;
        loading.classList.add('hidden');
        FAR.setStatus('🕹️ EmulatorJS: ' + item.name + ' (' + core + ')');
        FAR.toast('Игра запущена: ' + core, 'success');
        FAR._emulatorFocus(root);

        if (typeof FAR.VirtualGamepad !== 'undefined') {
            FAR.VirtualGamepad.mount(root, core);
        }
    } catch (e) {
        console.error('openEmulatorViewer: run failed:', e);
        loading.classList.add('hidden');
        FAR.toast('Не удалось запустить игру: ' + e.message, 'error');
    }
};

FAR._runEmulator = async function(rootContainer, blobUrl) {
    if (!FAR._ejsLibraryLoaded) {
        await FAR._loadEmulatorLoader();
        await FAR._waitForEjsEmulator(blobUrl);
        return;
    }

    return new Promise(function(resolve, reject) {
        FAR._createEmulatorInstance(rootContainer, resolve, reject);
    });
};

FAR._waitForEjsEmulator = function(expectedUrl) {
    return new Promise(function(resolve, reject) {
        let elapsed = 0;
        const STEP = 50;
        const TIMEOUT = 30000;

        const check = function() {
            const emu = window.EJS_emulator;
            if (emu) {
                try {
                    if (emu.config && emu.config.gameUrl === expectedUrl) {
                        resolve();
                        return;
                    }
                } catch (e) { /* ignore */ }
                resolve();
                return;
            }
            elapsed += STEP;
            if (elapsed >= TIMEOUT) {
                reject(new Error('loader.js не создал window.EJS_emulator за ' + TIMEOUT + ' мс'));
                return;
            }
            setTimeout(check, STEP);
        };

        setTimeout(check, STEP);
    });
};

FAR._emulatorSuppressEnter = function() {
    if (FAR._emulatorKeyHandler) return;

    FAR._emulatorKeyHandler = function(e) {
        const modal = document.getElementById('emulatorViewerModal');
        if (!modal || modal.classList.contains('hidden')) return;

        if (e.key === 'Enter' || e.key === ' ' || e.code === 'Space') {
            e.stopImmediatePropagation();
            e.preventDefault();
        }
    };

    document.addEventListener('keydown', FAR._emulatorKeyHandler, true);
};

FAR._emulatorFocus = function(root) {
    if (!root) return;
    try {
        root.setAttribute('tabindex', '0');
        root.focus();
    } catch (e) { /* ignore */ }
};

FAR._createEmulatorInstance = function(rootContainer, resolve, reject) {
    try {
        // Патчим EmulatorJS.prototype.handleResize ДО создания инстанса
        try { FAR._patchEmulatorJSResize(); } catch (e) {}

        const playerSelector = '#' + (rootContainer && rootContainer.id ? rootContainer.id : 'emulatorRoot');

        const config = {
            gameUrl:        window.EJS_gameUrl,
            dataPath:       window.EJS_pathtodata,
            system:         window.EJS_core,
            biosUrl:        window.EJS_biosUrl,
            gameName:       window.EJS_gameName || window.EJS_gameUrl,
            color:          window.EJS_color,
            adUrl:          window.EJS_AdUrl,
            adMode:         window.EJS_AdMode,
            adTimer:        window.EJS_AdTimer,
            adSize:         window.EJS_AdSize,
            alignStartButton: window.EJS_alignStartButton,
            VirtualGamepadSettings: window.EJS_VirtualGamepadSettings,
            buttonOpts:     window.EJS_Buttons,
            volume:         window.EJS_volume,
            defaultControllers: window.EJS_defaultControls,
            startOnLoad:    window.EJS_startOnLoaded,
            fullscreenOnLoad: window.EJS_fullscreenOnLoaded,
            filePaths:      window.EJS_paths,
            loadState:      window.EJS_loadStateURL,
            cacheLimit:     window.EJS_CacheLimit,
            cheats:         window.EJS_cheats,
            defaultOptions: window.EJS_defaultOptions,
            gamePatchUrl:   window.EJS_gamePatchUrl,
            gameParentUrl:  window.EJS_gameParentUrl,
            netplayUrl:     window.EJS_netplayServer,
            gameId:         window.EJS_gameID,
            backgroundImg:  window.EJS_backgroundImage,
            backgroundBlur: window.EJS_backgroundBlur,
            backgroundColor: window.EJS_backgroundColor,
            controlScheme:  window.EJS_controlScheme,
            threads:        window.EJS_threads,
            disableCue:     window.EJS_disableCue,
            startBtnName:   window.EJS_startButtonName,
            softLoad:       window.EJS_softLoad,
            capture:        window.EJS_screenCapture,
            externalFiles:  window.EJS_externalFiles,
            dontExtractBIOS: window.EJS_dontExtractBIOS,
            disableDatabases: window.EJS_disableDatabases,
            disableLocalStorage: window.EJS_disableLocalStorage,
            forceLegacyCores: window.EJS_forceLegacyCores,
            noAutoFocus:    window.EJS_noAutoFocus,
            videoRotation:  window.EJS_videoRotation,
            hideSettings:   window.EJS_hideSettings,
            shaders:        Object.assign({}, window.EJS_SHADERS, window.EJS_shaders || {}),
            language:       window.EJS_language,
            langJson:       window._farEjsLangJson || null
        };

        window.EJS_emulator = new window.EmulatorJS(playerSelector, config);

        // Патч на случай, если handleResize привязан как own-property
        try { FAR._patchEmulatorJSInstanceResize(window.EJS_emulator); } catch (e) {}

        // Сохраняем AudioContext — критично для остановки звука при закрытии.
        try {
            setTimeout(function() {
                try {
                    const emu = window.EJS_emulator;
                    if (!emu) return;
                    const c =
                        (emu.Module && emu.Module.AL && emu.Module.AL.currentCtx &&
                            emu.Module.AL.currentCtx.audioCtx) ||
                        (emu.Module && emu.Module.audioContext) ||
                        (emu.AudioContext) ||
                        (emu.audioContext) ||
                        null;
                    if (c) {
                        if (!Array.isArray(FAR._emuAudioContexts)) FAR._emuAudioContexts = [];
                        if (FAR._emuAudioContexts.indexOf(c) === -1) FAR._emuAudioContexts.push(c);
                    }
                } catch (e) { /* ignore */ }
            }, 100);
        } catch (e) { /* ignore */ }

        if (typeof FAR._emuStateOnSave === 'function') {
            try {
                window.EJS_emulator.on('saveState', FAR._emuStateOnSave);
                window.EJS_emulator.on('loadState', FAR._emuStateOnLoad);
                window.EJS_emulator._farStateHooksAttached = true;
                console.log('[EmuState] хуки привязаны к новому инстансу EmulatorJS');
            } catch (e) {
                console.warn('[EmuState] attach failed:', e);
            }
        }

        setTimeout(resolve, 200);
    } catch (e) {
        reject(e);
    }
};

FAR._ensureNipplejs = function() {
    if (typeof window.nipplejs !== 'undefined') return Promise.resolve();
    if (FAR._nipplejsPromise) return FAR._nipplejsPromise;

    FAR._nipplejsPromise = new Promise(function(resolve, reject) {
        const s = document.createElement('script');
        s.src = 'lib/js-emulator/src/nipplejs.js';
        s.async = true;
        s.onload = function() { resolve(); };
        s.onerror = function() { reject(new Error('nipplejs.js не найден')); };
        document.head.appendChild(s);
    });

    return FAR._nipplejsPromise;
};

FAR._destroyEmulator = function() {
    const root = document.getElementById('emulatorRoot');
    if (root && typeof FAR.VirtualGamepad !== 'undefined') {
        FAR.VirtualGamepad.unmount(root);
    }

    const emu = window.EJS_emulator;

    if (emu) {
        try { FAR._hardStopEmulatorJS(emu); } catch (e) {
            console.warn('[emu destroy] _hardStopEmulatorJS:', e);
        }
    }

    // Дополнительно: закрыть сохранённые AudioContext
    try {
        if (Array.isArray(FAR._emuAudioContexts)) {
            for (const c of FAR._emuAudioContexts) {
                try {
                    if (c && typeof c.close === 'function' && c.state !== 'closed') c.close();
                } catch (e) {}
            }
            FAR._emuAudioContexts = [];
        }
    } catch (e) {}

    if (FAR._emulatorKeyHandler) {
        try {
            document.removeEventListener('keydown', FAR._emulatorKeyHandler, true);
        } catch (e) {}
        FAR._emulatorKeyHandler = null;
    }

    FAR._emulatorInstance = null;

    if (FAR._emulatorBlobUrls && FAR._emulatorBlobUrls.length) {
        FAR._emulatorBlobUrls.forEach(function(u) {
            try { URL.revokeObjectURL(u); } catch (e) {}
        });
        FAR._emulatorBlobUrls = [];
    }

    if (root) {
        try {
            const canvases = root.querySelectorAll('canvas');
            for (let i = 0; i < canvases.length; i++) {
                try { canvases[i].width = 0; canvases[i].height = 0; } catch (e) {}
            }
            const media = root.querySelectorAll('audio, video, iframe');
            for (let i = 0; i < media.length; i++) {
                try { media[i].src = ''; media[i].remove(); } catch (e) {}
            }
        } catch (e) {}
        root.innerHTML = '';
    }

    try { if (root) root.blur(); } catch (e) {}
    try { document.body.focus(); } catch (e) {}
};

FAR.closeEmulatorViewerOutside = function(e) {
    if (e.target === e.currentTarget) FAR.closeEmulatorViewer();
};

FAR.downloadCurrentEmulator = async function() {
    if (!FAR._emulatorCurrentItem) {
        FAR.toast('Нет активной игры', 'warning');
        return;
    }
    const side = FAR._emulatorCurrentSide || FAR.activePanel;
    try {
        const { data, contentType } = await FAR.readFileBodyFromSide(side, FAR._emulatorCurrentItem);
        const blob = new Blob([data], { type: contentType || 'application/octet-stream' });
        FAR.saveBlobAs(blob, FAR.sanitizeFileName(FAR._emulatorCurrentItem.name));
        FAR.toast('Файл сохранён', 'success');
    } catch (e) {
        FAR.toast('Ошибка скачивания: ' + e.message, 'error');
    }
};

/**
 * Закрывает модалку эмулятора и ПОЛНОСТЬЮ выгружает игру из памяти.
 *
 * КРИТИЧНО: без жёсткой остановки EmulatorJS продолжает играть звук
 * из WebAudio даже после удаления DOM-узлов и закрытия модалки.
 */
FAR.closeEmulatorViewer = function () {
    const modal = document.getElementById('emulatorViewerModal');
    if (modal) modal.classList.add('hidden');

    // === 1. Жёстко останавливаем EmulatorJS через _destroyEmulator ===
    try { FAR._destroyEmulator(); } catch (e) {
        console.warn('[closeEmulatorViewer] _destroyEmulator:', e);
    }

    // === 2. Страховка ===
    try { if (FAR._emulatorInstance) FAR._hardStopEmulatorJS(FAR._emulatorInstance); } catch (e) {}
    try { if (window.EJS_emulator)    FAR._hardStopEmulatorJS(window.EJS_emulator);   } catch (e) {}
    try { FAR._emulatorInstance = null; } catch (e) {}
    try { if (window.EJS_emulator) window.EJS_emulator = null; } catch (e) {}

    // === 3. Сбрасываем контекст файла ===
    FAR._emulatorCurrentItem = null;
    FAR._emulatorCurrentSide = null;

    // === 4. Обновляем кнопки навигации ◀ / ▶ ===
    if (typeof FAR._viewerUpdateNavButtons === 'function') {
        try { FAR._viewerUpdateNavButtons(); } catch (e) {}
    }

    // === 5. Снимаем фокус ===
    try {
        if (document.activeElement && document.activeElement !== document.body) {
            document.activeElement.blur();
        }
    } catch (e) {}
};