// ============================================================
// 48-wm-viewers-emu.js — Эмуляторы и консоль (JSDOS v8 CDN)
// ============================================================
//
// KillNet v3:
//   • Suspend всех AudioContext — СИНХРОННО, для мгновенной тишины.
//   • Kill не ждёт persist — persist вызывается в фоне ПОСЛЕ kill.
//   • Не полагаемся на ci.pause/mute — они best effort.
// ============================================================

FAR.WM = FAR.WM || {};
FAR.WM._emu = FAR.WM._emu || {};

// ============================================================
// KILLNET — патчи (один раз)
// ============================================================

(function installKillNet() {
    if (window._farKillNetInstalled) return;
    window._farKillNetInstalled = true;

    window._farAllAudioContexts = window._farAllAudioContexts || [];
    window._farAllMedia = window._farAllMedia || [];
    window._farAllWorkers = window._farAllWorkers || [];

    // ---- AudioContext ----
    const _OrigAC = window.AudioContext || window.webkitAudioContext;
    if (_OrigAC) {
        const PatchedAC = function () {
            const ctx = new _OrigAC(...arguments);
            window._farAllAudioContexts.push(ctx);
            return ctx;
        };
        PatchedAC.prototype = _OrigAC.prototype;

        const proto = _OrigAC.prototype;

        ['createGain'].forEach(function (m) {
            if (typeof proto[m] !== 'function') return;
            const orig = proto[m];
            proto[m] = function () {
                const n = orig.apply(this, arguments);
                if (!this._farGains) this._farGains = [];
                this._farGains.push(n);
                return n;
            };
        });

        ['createOscillator', 'createBufferSource', 'createConstantSource',
            'createScriptProcessor', 'createMediaElementSource',
            'createMediaStreamSource'].forEach(function (m) {
            if (typeof proto[m] !== 'function') return;
            const orig = proto[m];
            proto[m] = function () {
                const n = orig.apply(this, arguments);
                if (!this._farNodes) this._farNodes = [];
                this._farNodes.push(n);
                return n;
            };
        });

        window.AudioContext = PatchedAC;
        if (window.webkitAudioContext) window.webkitAudioContext = PatchedAC;
    }

    // ---- Audio ----
    const _OrigAudio = window.Audio;
    if (_OrigAudio) {
        const PatchedAudio = function () {
            const a = new _OrigAudio(...arguments);
            window._farAllMedia.push(a);
            return a;
        };
        PatchedAudio.prototype = _OrigAudio.prototype;
        window.Audio = PatchedAudio;
    }

    // ---- createElement / createElementNS ----
    const _origCreateElement = Document.prototype.createElement;
    Document.prototype.createElement = function (tag) {
        const el = _origCreateElement.apply(this, arguments);
        const t = String(tag || '').toLowerCase();
        if (t === 'audio' || t === 'video') window._farAllMedia.push(el);
        return el;
    };

    const _origCreateElementNS = Document.prototype.createElementNS;
    if (typeof _origCreateElementNS === 'function') {
        Document.prototype.createElementNS = function (ns, tag) {
            const el = _origCreateElementNS.apply(this, arguments);
            const t = String(tag || '').toLowerCase();
            if (t === 'audio' || t === 'video') window._farAllMedia.push(el);
            return el;
        };
    }

    // ---- Worker ----
    const _OrigWorker = window.Worker;
    if (_OrigWorker) {
        const PatchedWorker = function () {
            const w = new _OrigWorker(...arguments);
            window._farAllWorkers.push(w);
            return w;
        };
        PatchedWorker.prototype = _OrigWorker.prototype;
        window.Worker = PatchedWorker;
    }

    // ---- AudioWorkletNode ----
    if (window.AudioWorkletNode) {
        const _OrigAWN = window.AudioWorkletNode;
        const PatchedAWN = function (...args) {
            const n = new _OrigAWN(...args);
            if (n.context) {
                if (!n.context._farNodes) n.context._farNodes = [];
                n.context._farNodes.push(n);
            }
            return n;
        };
        PatchedAWN.prototype = _OrigAWN.prototype;
        window.AudioWorkletNode = PatchedAWN;
    }

    console.log('[KILLNET-v3] installed');
})();

// ============================================================
// Снимок реестров
// ============================================================

FAR._jsdosMakeKillSnap = function () {
    return {
        ctx:    (window._farAllAudioContexts || []).length,
        media:  (window._farAllMedia || []).length,
        worker: (window._farAllWorkers || []).length
    };
};

// ============================================================
// ★ МГНОВЕННАЯ ТИШИНА ★
// ============================================================
// Suspend всех AudioContext СИНХРОННО — эффект за <1 мс,
// независимо от того, есть ли у ci методы pause/mute/exit.
FAR._hardSilenceJsdos = function (ci, rootEl) {
    if (ci) {
        try { if (typeof ci.pause === 'function') ci.pause(); } catch (e) {}
        try { if (typeof ci.mute === 'function') ci.mute(true); } catch (e) {}
        try { if (typeof ci.setVolume === 'function') ci.setVolume(0); } catch (e) {}
    }

    // Suspend всех AudioContext — СИНХРОННО
    if (Array.isArray(window._farAllAudioContexts)) {
        for (const ctx of window._farAllAudioContexts) {
            try {
                if (ctx.state === 'running' && typeof ctx.suspend === 'function') {
                    ctx.suspend();
                }
            } catch (e) {}
        }
    }

    // Mute всех <audio>/<video> в документе
    try {
        document.querySelectorAll('audio, video').forEach(function (el) {
            try { el.pause(); el.muted = true; el.volume = 0; } catch (e) {}
        });
    } catch (e) {}

    if (rootEl) {
        try {
            rootEl.querySelectorAll('audio, video').forEach(function (el) {
                try { el.pause(); el.muted = true; el.volume = 0; } catch (e) {}
            });
        } catch (e) {}
    }
};

// ============================================================
// ★ KILLNET — жёсткое уничтожение ★
// ============================================================

FAR._killJsdos = function (snap) {
    snap = snap || {};
    console.log('[KILL] snap:', snap);

    // ---- 1. AudioContext ----
    if (Array.isArray(window._farAllAudioContexts)) {
        const startIdx = (typeof snap.ctx === 'number') ? snap.ctx : 0;
        const total = window._farAllAudioContexts.length;
        const ctxs = window._farAllAudioContexts.splice(startIdx, total - startIdx);
        console.log('[KILL] closing', ctxs.length, 'AudioContext(s)');

        ctxs.forEach(function (ctx) {
            try {
                if (Array.isArray(ctx._farGains)) {
                    ctx._farGains.forEach(function (g) {
                        try { g.gain.value = 0; } catch (e) {}
                        try { g.disconnect(); } catch (e) {}
                    });
                    ctx._farGains.length = 0;
                }
                if (Array.isArray(ctx._farNodes)) {
                    ctx._farNodes.forEach(function (n) {
                        try { if (typeof n.stop === 'function') n.stop(0); } catch (e) {}
                        try { n.disconnect(); } catch (e) {}
                    });
                    ctx._farNodes.length = 0;
                }
                try { if (ctx.state !== 'closed') ctx.suspend(); } catch (e) {}
                try { if (ctx.state !== 'closed') ctx.close().catch(function () {}); } catch (e) {}
            } catch (e) {}
        });
    }

    // ---- 2. Media ----
    if (Array.isArray(window._farAllMedia)) {
        const startIdx = (typeof snap.media === 'number') ? snap.media : 0;
        const total = window._farAllMedia.length;
        const media = window._farAllMedia.splice(startIdx, total - startIdx);
        console.log('[KILL] killing', media.length, 'media element(s)');

        media.forEach(function (el) {
            try { el.pause(); } catch (e) {}
            try { el.muted = true; } catch (e) {}
            try { el.volume = 0; } catch (e) {}
            try { el.removeAttribute('src'); } catch (e) {}
            try { el.srcObject = null; } catch (e) {}
            try { el.load(); } catch (e) {}
            try { if (el.parentNode) el.parentNode.removeChild(el); } catch (e) {}
        });
    }

    // ---- 3. Worker ----
    if (Array.isArray(window._farAllWorkers)) {
        const startIdx = (typeof snap.worker === 'number') ? snap.worker : 0;
        const total = window._farAllWorkers.length;
        const workers = window._farAllWorkers.splice(startIdx, total - startIdx);
        console.log('[KILL] terminating', workers.length, 'worker(s)');

        workers.forEach(function (w) {
            try { w.terminate(); } catch (e) {}
        });
    }

    // ---- 4. Все медиа в документе ----
    try {
        document.querySelectorAll('audio, video').forEach(function (el) {
            try { el.pause(); el.muted = true; el.volume = 0; el.src = ''; el.load(); } catch (e) {}
        });
    } catch (e) {}

    // ---- 5. Post-kill monitoring: 1с ловим «поздние» ресурсы ----
    let iter = 0;
    const monitorId = setInterval(function () {
        iter++;
        if (iter > 10) { clearInterval(monitorId); return; }

        let found = false;

        if (Array.isArray(window._farAllAudioContexts) && window._farAllAudioContexts.length > 0) {
            const late = window._farAllAudioContexts.splice(0);
            console.log('[KILL] late AudioContexts:', late.length);
            late.forEach(function (ctx) {
                try { if (ctx.state !== 'closed') ctx.close().catch(function () {}); } catch (e) {}
            });
            found = true;
        }

        if (Array.isArray(window._farAllWorkers) && window._farAllWorkers.length > 0) {
            const late = window._farAllWorkers.splice(0);
            console.log('[KILL] late Workers:', late.length);
            late.forEach(function (w) { try { w.terminate(); } catch (e) {} });
            found = true;
        }

        if (Array.isArray(window._farAllMedia) && window._farAllMedia.length > 0) {
            const late = window._farAllMedia.splice(0);
            console.log('[KILL] late Media:', late.length);
            late.forEach(function (el) {
                try { el.pause(); el.muted = true; el.src = ''; el.load(); } catch (e) {}
            });
            found = true;
        }

        if (!found && iter > 3) clearInterval(monitorId);
    }, 100);
};

// Совместимость
FAR._closeJsdosAudioContexts = function (startIdx) {
    FAR._killJsdos({ ctx: startIdx || 0, media: 0, worker: 0 });
};

// ============================================================
// Загрузка библиотеки JSDOS v8 с CDN
// ============================================================

FAR.WM._loadJsdosV8 = function() {
    if (window.Dos) return Promise.resolve();
    if (window._jsdosV8Loaded) return Promise.resolve();
    if (window._jsdosV8Promise) return window._jsdosV8Promise;

    window._jsdosV8Promise = new Promise((resolve, reject) => {
        const cdnJs = 'https://v8.js-dos.com/latest/js-dos.js';
        const cdnCss = 'https://v8.js-dos.com/latest/js-dos.css';

        if (!document.getElementById('jsdos-v8-css')) {
            const link = document.createElement('link');
            link.id = 'jsdos-v8-css';
            link.rel = 'stylesheet';
            link.href = cdnCss;
            document.head.appendChild(link);
        }

        if (!document.getElementById('jsdos-v8-script')) {
            const s = document.createElement('script');
            s.id = 'jsdos-v8-script';
            s.src = cdnJs;
            s.onload = () => { window._jsdosV8Loaded = true; resolve(); };
            s.onerror = () => reject(new Error('Не удалось загрузить js-dos с CDN'));
            document.head.appendChild(s);
        } else {
            let attempts = 0;
            const timer = setInterval(() => {
                if (window.Dos) { clearInterval(timer); window._jsdosV8Loaded = true; resolve(); }
                else if (++attempts > 50) {
                    clearInterval(timer);
                    reject(new Error('Скрипт js-dos.js есть в DOM, но window.Dos отсутствует'));
                }
            }, 100);
        }
    });
    return window._jsdosV8Promise;
};

// ============================================================
// Сохранение / загрузка .state
// ============================================================

FAR.WM._jsdosGetStatePath = function (item) {
    if (!item || !item.path) return '';
    return FAR.normPath(item.path) + '.state';
};

FAR.WM._jsdosSaveStateToDB = async function (side, item, stateBytes) {
    if (!stateBytes || !stateBytes.byteLength || !item) return false;
    const ctx = FAR.side[side];
    if (!ctx || !ctx.db) return false;

    const statePath = FAR.WM._jsdosGetStatePath(item);
    if (!statePath) return false;

    try {
        const blob = new Blob([stateBytes], { type: 'application/octet-stream' });
        const res = await ctx.db._fetch(
            ctx.db._url('/api/write', { path: statePath }),
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: blob
            }
        );
        if (!res.ok) {
            console.warn('[JSDOS] save state failed: HTTP ' + res.status);
            return false;
        }
        console.log('[JSDOS] state saved:', statePath, '(' + blob.size + ' B)');
        return true;
    } catch (e) {
        console.warn('[JSDOS] save state failed:', e);
        return false;
    }
};

FAR.WM._jsdosLoadStateFromDB = async function (side, item) {
    if (!item) return null;
    const ctx = FAR.side[side];
    if (!ctx || !ctx.db) return null;

    const statePath = FAR.WM._jsdosGetStatePath(item);
    if (!statePath) return null;

    const lastSlash = statePath.lastIndexOf('/');
    const parentDir = lastSlash >= 0 ? statePath.substring(0, lastSlash) : '';

    try {
        const listRes = await ctx.db._fetch(
            ctx.db._url('/api/list', { path: parentDir, recursive: 0 })
        );
        if (!listRes.ok) return null;
        const listData = await listRes.json();
        const entries = listData.entries || [];
        const exists = entries.some(function (e) {
            return !e.isFolder && FAR.normPath(e.path) === statePath;
        });
        if (!exists) return null;
    } catch (e) {
        return null;
    }

    try {
        const readRes = await ctx.db._fetch(
            ctx.db._url('/api/read', { path: statePath })
        );
        if (!readRes.ok) return null;
        const buf = await readRes.arrayBuffer();
        return new Uint8Array(buf);
    } catch (e) {
        return null;
    }
};

// ============================================================
// JSDOS — ОСТАНОВКА (WM, KillNet v3)
// ============================================================
// Порядок: silence (sync) → kill (sync) → cleanup (async, в фоне)
FAR.WM._stopJsdos = async function (win) {
    if (!win || !win.props) return;

    win.props._jsdosAborted = true;

    if (win.props._jsdosAutoSaveTimer) {
        clearInterval(win.props._jsdosAutoSaveTimer);
        win.props._jsdosAutoSaveTimer = null;
    }
    if (win.props._jsdosVisibilityHandler) {
        document.removeEventListener('visibilitychange', win.props._jsdosVisibilityHandler);
        win.props._jsdosVisibilityHandler = null;
    }
    if (win.props._jsdosResizeObserver) {
        try { win.props._jsdosResizeObserver.disconnect(); } catch (e) {}
        win.props._jsdosResizeObserver = null;
    }

    const ci = win.props._jsdosInstance;
    const snap = win.props._jsdosKillSnap;
    const side = win.props.side;
    const item = win.props.file;

    win.props._jsdosInstance = null;
    win.props._jsdosReady = false;
    win.props._jsdosKillSnap = null;

    if (!ci && !snap) return;

    const rootEl = win.bodyEl ? win.bodyEl.querySelector('[data-role="root"]') : null;

    // 1. Sync: мгновенная тишина (suspend всех AudioContext)
    FAR._hardSilenceJsdos(ci, rootEl);

    // 2. Sync: жёсткое уничтожение
    FAR._killJsdos(snap);

    // 3. Sync: best effort dos-методы
    if (ci) {
        try { if (typeof ci.exit === 'function') ci.exit(); } catch (e) {}
        try { if (typeof ci.stop === 'function') ci.stop(); } catch (e) {}
    }

    // 4. Sync: очистить DOM
    if (rootEl) {
        try { rootEl.innerHTML = ''; } catch (e) {}
    }

    // 5. Async: persist (fire and forget, максимум 5с)
    if (ci && typeof ci.persist === 'function' && side && item) {
        Promise.race([
            ci.persist(),
            new Promise(function (r) { setTimeout(r, 5000); })
        ]).then(function (bytes) {
            if (bytes && bytes.byteLength > 0 && typeof FAR.WM._jsdosSaveStateToDB === 'function') {
                return FAR.WM._jsdosSaveStateToDB(side, item, bytes);
            }
        }).catch(function (e) {
            console.warn('[JSDOS] persist failed:', e);
        });
    }
};

// ============================================================
// Кнопки 💾 / 📂 в titlebar
// ============================================================

FAR.WM._installJsdosStateButtons = function (win) {
    if (!win || !win.el) return;
    const titlebar = win.el.querySelector('.wm-titlebar');
    if (!titlebar) return;
    const actions = titlebar.querySelector('.wm-title-actions');
    if (!actions) return;

    actions.querySelectorAll('.wm-jsdos-state-btn').forEach(b => b.remove());

    const saveBtn = document.createElement('button');
    saveBtn.className = 'wm-title-btn wm-jsdos-state-btn';
    saveBtn.textContent = '💾';
    saveBtn.title = 'Выгрузить состояние на сервер';
    saveBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        FAR.WM._jsdosExportState(win);
    });

    const loadBtn = document.createElement('button');
    loadBtn.className = 'wm-title-btn wm-jsdos-state-btn';
    loadBtn.textContent = '📂';
    loadBtn.title = 'Загрузить состояние с сервера';
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
// Ручной экспорт / импорт
// ============================================================

FAR.WM._jsdosGetState = async function (win) {
    const ci = win.props._jsdosInstance;
    if (!ci || !win.props._jsdosReady) return null;
    if (typeof ci.persist !== 'function') return null;

    try {
        const stateBytes = await ci.persist();
        if (stateBytes && stateBytes.byteLength > 0) return stateBytes;
    } catch (e) {
        console.warn('[JSDOS] persist failed:', e);
    }
    return null;
};

FAR.WM._jsdosExportState = async function (win) {
    if (!win || !win.props) return;
    if (!win.props._jsdosInstance) { FAR.toast('Эмулятор не запущен', 'warning'); return; }
    if (!win.props._jsdosReady) { FAR.toast('Игра ещё загружается', 'warning'); return; }

    FAR.toast('Сохранение состояния…', 'info');

    try {
        const stateBytes = await FAR.WM._jsdosGetState(win);
        if (!stateBytes) {
            FAR.toast('Не удалось получить состояние', 'error');
            return;
        }

        const item = win.props.file || {};
        const baseName = (item.name || 'game.jsdos').replace(/\.[^/.]+$/, '');
        FAR.saveBlobAs(new Blob([stateBytes], { type: 'application/octet-stream' }),
            baseName + '.state');

        if (win.props.side && win.props.file) {
            const ok = await FAR.WM._jsdosSaveStateToDB(
                win.props.side, win.props.file, stateBytes);
            if (ok) FAR.toast('Состояние сохранено на сервер', 'success');
            else FAR.toast('Не удалось сохранить на сервер (локальная копия скачана)', 'warning');
        }
    } catch (e) {
        console.error('[JSDOS] export failed:', e);
        FAR.toast('Ошибка: ' + e.message, 'error');
    }
};

FAR.WM._jsdosImportState = function (win) {
    if (!win || !win.props) return;
    if (!win.props._jsdosInstance) { FAR.toast('Эмулятор не запущен', 'warning'); return; }
    if (!win.props._jsdosReady) { FAR.toast('Игра ещё загружается', 'warning'); return; }

    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.state,application/octet-stream';
    input.onchange = async function () {
        const f = input.files && input.files[0];
        if (!f) return;
        try {
            const buf = await f.arrayBuffer();
            const state = new Uint8Array(buf);
            if (state.byteLength === 0) { FAR.toast('Файл пустой', 'warning'); return; }

            const ci = win.props._jsdosInstance;
            if (typeof ci.pause === 'function') ci.pause();
            await new Promise(r => setTimeout(r, 300));

            if (typeof ci.restore === 'function') {
                await ci.restore(state);
                FAR.toast('Состояние загружено из файла', 'success');
            } else {
                throw new Error('Метод restore недоступен');
            }
            if (typeof ci.resume === 'function') ci.resume();

            if (win.props.side && win.props.file) {
                await FAR.WM._jsdosSaveStateToDB(win.props.side, win.props.file, state);
            }
        } catch (e) {
            console.error('[JSDOS] import failed:', e);
            FAR.toast('Ошибка загрузки: ' + e.message, 'error');
        }
    };
    input.click();
};

// ============================================================
// WM: монтирование приложения 'jsdos'
// ============================================================

FAR.WM._mountJsdosViewer = async function (win, props) {
    await FAR.WM._stopJsdos(win);
    win.props._jsdosAborted = false;
    win.props._jsdosVisibilityHandler = null;
    win.props._jsdosPendingCleanup = null;

    const item = props.file;
    const side = props.side || FAR.activePanel;

    win.el.querySelector('.wm-title-text').textContent = '🕹️ ' + item.name;

    win.bodyEl.innerHTML =
        '<style>' +
        '  .jsdos-wrapper { width:100%; height:100%; position:relative; background:#000; overflow:hidden; }' +
        '  .jsdos-wrapper > div[data-role="root"] { width:100%; height:100%; position:relative; }' +
        '  .jsdos-wrapper .absolute.pointer-events-none,' +
        '  .jsdos-wrapper .absolute.bg-black\\/70 { display:none !important; }' +
        '  .jsdos-wrapper .w-14.flex-shrink-0,' +
        '  .jsdos-wrapper .background-image { display:none !important; }' +
        '  .jsdos-wrapper .sidebar {' +
        '    position:absolute !important; left:0 !important; top:0 !important; height:100% !important;' +
        '    width:56px !important; z-index:50 !important;' +
        '    transform:translateX(calc(-100% + 3px));' +
        '    transition:transform .3s cubic-bezier(.4,0,.2,1);' +
        '    background-color:transparent !important;' +
        '    border-right:3px solid #f80 !important;' +
        '    box-shadow:none !important; cursor:pointer;' +
        '  }' +
        '  .jsdos-wrapper .sidebar:hover {' +
        '    transform:translateX(0); background-color:#1a1a1a !important;' +
        '    box-shadow:2px 0 5px rgba(0,0,0,.5) !important;' +
        '  }' +
        '  .jsdos-wrapper .window {' +
        '    position:absolute !important; top:0 !important; left:0 !important;' +
        '    width:100% !important; height:100% !important;' +
        '    transition:left .3s cubic-bezier(.4,0,.2,1), width .3s cubic-bezier(.4,0,.2,1) !important;' +
        '  }' +
        '  .jsdos-wrapper.sidebar-open .window { left:56px !important; width:calc(100% - 56px) !important; }' +
        '  .jsdos-wrapper canvas {' +
        '    position:absolute !important; top:50% !important; left:50% !important;' +
        '    transform:translate(-50%,-50%) !important;' +
        '    width:100% !important; height:100% !important;' +
        '    object-fit:contain !important; margin:0 !important; padding:0 !important;' +
        '    image-rendering:pixelated !important; display:block !important;' +
        '  }' +
        '</style>' +
        '<div class="jsdos-wrapper">' +
        '  <div data-role="root" id="jsdos-root-' + win.id + '" tabindex="0"></div>' +
        '</div>';

    const wrapper = win.bodyEl.querySelector('.jsdos-wrapper');
    const root = win.bodyEl.querySelector('[data-role="root"]');

    try {
        await FAR.WM._loadJsdosV8();
    } catch (e) {
        root.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">' +
            FAR.escapeHtml(e.message) + '</div>';
        return;
    }

    if (!window.Dos) {
        root.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">window.Dos не определён</div>';
        return;
    }

    let url = null;
    try {
        const r = await FAR.readFileBodyFromSide(side, item);
        const blob = new Blob([r.data], { type: r.contentType || 'application/octet-stream' });
        url = URL.createObjectURL(blob);
        FAR.WM._trackBlobUrl(win, url);
    } catch (e) {
        root.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">' +
            FAR.escapeHtml(e.message) + '</div>';
        return;
    }

    // ★ Снимок ДО Dos() ★
    win.props._jsdosKillSnap = FAR._jsdosMakeKillSnap();
    console.log('[JSDOS] kill snap:', win.props._jsdosKillSnap);

    const stateBytes = await FAR.WM._jsdosLoadStateFromDB(side, item);

    FAR.WM._installViewerNavButtons(win, item, side);
    FAR.WM._installJsdosStateButtons(win);

    try {
        if (typeof window.emulators === 'undefined') window.emulators = {};
        window.emulators.pathPrefix = "https://v8.js-dos.com/latest/emulators/";

        window.Dos(root, {
            url: url,
            autoStart: true,
            theme: "dark",
            onrun: async function(emulator) {
                if (win.props._jsdosAborted) {
                    FAR._hardSilenceJsdos(emulator, root);
                    FAR._killJsdos(win.props._jsdosKillSnap);
                    try { if (typeof emulator.exit === 'function') emulator.exit(); } catch (e) {}
                    try { if (typeof emulator.stop === 'function') emulator.stop(); } catch (e) {}
                    return;
                }

                win.props._jsdosInstance = emulator;

                if (stateBytes && stateBytes.byteLength > 0) {
                    try {
                        if (typeof emulator.restore === 'function') {
                            await emulator.restore(stateBytes);
                        }
                    } catch (e) {
                        console.warn('[JSDOS] restore failed:', e);
                    }
                }

                if (!FAR.WM.getWindow(win.id)) return;
                win.props._jsdosReady = true;

                try { root.focus(); } catch (e) {}

                if (typeof FAR.VirtualGamepad !== 'undefined') {
                    FAR.VirtualGamepad.mount(root, 'jsdos');
                }

                setTimeout(() => {
                    const sidebar = wrapper.querySelector('.sidebar');
                    if (sidebar && !sidebar._farJsdosBound) {
                        sidebar._farJsdosBound = true;
                        sidebar.addEventListener('mouseenter', () =>
                            wrapper.classList.add('sidebar-open'));
                        sidebar.addEventListener('mouseleave', () =>
                            wrapper.classList.remove('sidebar-open'));
                    }

                    const saveCandidates = [
                        '.sidebar .save-button',
                        '.sidebar button[title*="Save"]',
                        '.sidebar button[aria-label*="Save"]',
                    ];
                    for (const sel of saveCandidates) {
                        const btn = wrapper.querySelector(sel);
                        if (btn && !btn._farJsdosHooked) {
                            btn._farJsdosHooked = true;
                            btn.addEventListener('click', () => {
                                setTimeout(async () => {
                                    try {
                                        const bytes = await emulator.persist();
                                        if (bytes) {
                                            await FAR.WM._jsdosSaveStateToDB(side, item, bytes);
                                        }
                                    } catch (e) {}
                                }, 800);
                            });
                            break;
                        }
                    }
                }, 1000);

                const autoSave = async () => {
                    if (!win.props._jsdosReady) return;
                    try {
                        const bytes = await emulator.persist();
                        if (bytes) {
                            await FAR.WM._jsdosSaveStateToDB(side, item, bytes);
                        }
                    } catch (e) {}
                };
                win.props._jsdosAutoSaveTimer = setInterval(autoSave, 30000);

                const onVisibilityChange = async () => {
                    if (document.hidden) await autoSave();
                };
                document.addEventListener('visibilitychange', onVisibilityChange);
                win.props._jsdosVisibilityHandler = onVisibilityChange;

                if (window.ResizeObserver) {
                    win.props._jsdosResizeObserver = new ResizeObserver(() => {
                        window.dispatchEvent(new Event('resize'));
                    });
                    win.props._jsdosResizeObserver.observe(wrapper);
                }
            },
            onerror: function(err) {
                console.error('[JSDOS] run error:', err);
                root.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">' +
                    FAR.escapeHtml(err.message || String(err)) + '</div>';
            }
        });

        const prevOnClose = win.onClose;
        win.onClose = function (w) {
            try { FAR.WM._stopJsdos(win); } catch (e) {}
            if (typeof prevOnClose === 'function') {
                try { prevOnClose(w); } catch (e) {}
            }
        };
    } catch (e) {
        root.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">' +
            FAR.escapeHtml(e.message) + '</div>';
        console.error('[JSDOS] mount error:', e);
    }
};

// ============================================================
// EmulatorJS (без изменений)
// ============================================================

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