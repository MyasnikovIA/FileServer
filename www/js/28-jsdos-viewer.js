// ============================================================
// 28-jsdos-viewer.js — Модальный просмотрщик JSDOS (KillNet v3)
// ============================================================
// Порядок DESTROY (как просил пользователь):
//   1. Sync silence — suspend всех AudioContext → тишина <1 мс
//   2. Sync kill    — close ctx, terminate workers, kill media
//   3. Sync hide modal — DOM убирается ПОСЛЕ kill
//   4. Sync clear DOM
//   5. Async persist — в фоне, не блокирует
// ============================================================

FAR.isJsdos = function (item) {
    if (!item || item.isFolder) return false;
    const name = item.name || item.path || '';
    const ext = (name.split('.').pop() || '').toLowerCase();
    return ext === 'jsdos' || ext === 'dosz';
};

FAR._jsdosModalState = {
    ci: null,
    item: null,
    side: null,
    blobUrl: null,
    loadToken: 0,
    autoSaveTimer: null,
    visibilityHandler: null,
    beforeUnloadHandler: null,
    killSnap: null
};

FAR.openJsdosViewer = async function (item, side) {
    side = side || FAR.activePanel;
    if (!FAR.ensureDb()) return;
    if (typeof FAR._ensureItemName === 'function') FAR._ensureItemName(item);

    try { FAR.closeViewer(); } catch (e) {}
    try { FAR.closePanoramaViewer(); } catch (e) {}
    try { FAR.closePdfViewer(); } catch (e) {}
    try { FAR.closeMp3Viewer(); } catch (e) {}
    try { FAR.closeVideoViewer(); } catch (e) {}
    try { FAR.closeEmulatorViewer(); } catch (e) {}

    await FAR._jsdosModalDestroy(false);

    FAR._jsdosModalState.item = item;
    FAR._jsdosModalState.side = side;

    const modal       = document.getElementById('jsdosViewerModal');
    const title       = document.getElementById('jsdosViewerTitle');
    const info        = document.getElementById('jsdosViewerInfo');
    const loading     = document.getElementById('jsdosLoading');
    const loadingText = document.getElementById('jsdosLoadingText');
    const root        = document.getElementById('jsdosRoot');

    title.textContent = '🕹️ ' + (item.name || item.path);
    info.textContent = '';
    modal.classList.remove('hidden');
    loading.classList.remove('hidden');
    loadingText.textContent = 'Загрузка библиотеки js-dos…';

    root.innerHTML = '';

    try {
        if (typeof FAR.WM._loadJsdosV8 === 'function') {
            await FAR.WM._loadJsdosV8();
        }
    } catch (e) {
        loading.classList.add('hidden');
        FAR.toast('Не удалось загрузить js-dos: ' + e.message, 'error');
        return;
    }

    if (typeof window.Dos !== 'function') {
        loading.classList.add('hidden');
        FAR.toast('window.Dos не определён', 'error');
        return;
    }

    let blob;
    try {
        loadingText.textContent = 'Загрузка образа .jsdos…';
        const { data, contentType } = await FAR.readFileBodyFromSide(side, item);
        blob = new Blob([data], { type: contentType || 'application/octet-stream' });
        info.textContent = `📁 ${FAR.formatSize(data.length)}`;
    } catch (e) {
        loading.classList.add('hidden');
        FAR.toast('Не удалось прочитать файл: ' + e.message, 'error');
        return;
    }

    const blobUrl = URL.createObjectURL(blob);
    FAR._jsdosModalState.blobUrl = blobUrl;

    let stateBytes = null;
    try {
        if (typeof FAR.WM._jsdosLoadStateFromDB === 'function') {
            stateBytes = await FAR.WM._jsdosLoadStateFromDB(side, item);
        }
    } catch (e) {
        console.warn('[JSDOS modal] load state failed:', e);
    }

    // ★ Снимок ДО Dos() ★
    FAR._jsdosModalState.killSnap = FAR._jsdosMakeKillSnap();
    console.log('[JSDOS modal] kill snap:', FAR._jsdosModalState.killSnap);

    const myToken = ++FAR._jsdosModalState.loadToken;
    let handled = false;

    const onReady = async function (emulator) {
        if (handled) return;
        handled = true;

        if (myToken !== FAR._jsdosModalState.loadToken) {
            FAR._hardSilenceJsdos(emulator, root);
            FAR._killJsdos(FAR._jsdosModalState.killSnap);
            try { if (typeof emulator.exit === 'function') emulator.exit(); } catch (e) {}
            try { if (typeof emulator.stop === 'function') emulator.stop(); } catch (e) {}
            return;
        }

        FAR._jsdosModalState.ci = emulator;

        if (stateBytes && stateBytes.byteLength > 0) {
            try {
                if (typeof emulator.restore === 'function') {
                    await emulator.restore(stateBytes);
                    console.log('[JSDOS modal] state restored');
                }
            } catch (e) {
                console.warn('[JSDOS modal] restore failed:', e);
            }
        }

        if (loading) loading.classList.add('hidden');
        FAR.setStatus('🕹️ JSDOS запущен');

        setTimeout(function () {
            const sidebar = root.querySelector('.sidebar');
            if (sidebar && !sidebar._farJsdosBound) {
                sidebar._farJsdosBound = true;
                sidebar.addEventListener('mouseenter', function () {
                    root.classList.add('sidebar-open');
                });
                sidebar.addEventListener('mouseleave', function () {
                    root.classList.remove('sidebar-open');
                });
            }

            const saveCandidates = [
                '.sidebar .save-button',
                '.sidebar button[title*="Save"]',
                '.sidebar button[aria-label*="Save"]',
            ];
            for (const sel of saveCandidates) {
                const btn = root.querySelector(sel);
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

        FAR._jsdosModalSetupAutoSave(emulator, side, item);
    };

    try {
        if (typeof window.emulators === 'undefined') window.emulators = {};
        window.emulators.pathPrefix = 'https://v8.js-dos.com/latest/emulators/';

        const result = window.Dos(root, {
            url: blobUrl,
            autoStart: true,
            theme: 'dark',
            onrun: function (ci) { onReady(ci); },
            onerror: function (err) {
                console.error('[JSDOS modal] onerror:', err);
                if (loading) loading.classList.add('hidden');
                FAR.toast('Ошибка js-dos: ' + (err && err.message ? err.message : err), 'error');
            }
        });

        if (result && typeof result.then === 'function') {
            const ciP = await result;
            if (ciP) onReady(ciP);
        } else if (result && typeof result.persist === 'function') {
            onReady(result);
        }
    } catch (e) {
        console.error('openJsdosViewer: Dos() failed:', e);
        if (loading) loading.classList.add('hidden');
        FAR.toast('Ошибка запуска: ' + e.message, 'error');
    }
};

// ---------- Автосохранение ----------

FAR._jsdosModalSetupAutoSave = function (emulator, side, item) {
    FAR._jsdosModalClearAutoSave();

    const doSave = async function () {
        try {
            if (emulator && typeof emulator.persist === 'function') {
                const bytes = await emulator.persist();
                if (bytes && bytes.byteLength > 0 &&
                    typeof FAR.WM._jsdosSaveStateToDB === 'function') {
                    await FAR.WM._jsdosSaveStateToDB(side, item, bytes);
                }
            }
        } catch (e) {
            console.warn('[JSDOS modal] auto-save error:', e);
        }
    };

    FAR._jsdosModalState.autoSaveTimer = setInterval(doSave, 30000);

    FAR._jsdosModalState.visibilityHandler = function () {
        if (document.hidden) doSave();
    };
    document.addEventListener('visibilitychange', FAR._jsdosModalState.visibilityHandler);

    FAR._jsdosModalState.beforeUnloadHandler = function () { doSave(); };
    window.addEventListener('beforeunload', FAR._jsdosModalState.beforeUnloadHandler);
};

FAR._jsdosModalClearAutoSave = function () {
    if (FAR._jsdosModalState.autoSaveTimer) {
        clearInterval(FAR._jsdosModalState.autoSaveTimer);
        FAR._jsdosModalState.autoSaveTimer = null;
    }
    if (FAR._jsdosModalState.visibilityHandler) {
        document.removeEventListener('visibilitychange', FAR._jsdosModalState.visibilityHandler);
        FAR._jsdosModalState.visibilityHandler = null;
    }
    if (FAR._jsdosModalState.beforeUnloadHandler) {
        window.removeEventListener('beforeunload', FAR._jsdosModalState.beforeUnloadHandler);
        FAR._jsdosModalState.beforeUnloadHandler = null;
    }
};

// ---------- Уничтожение ----------
//
// ★ Порядок: kill ДО hide modal ★
//   1. clear timers, invalidate token
//   2. sync silence — suspend AudioContext (тишина <1 мс)
//   3. sync kill    — close ctx, terminate worker, kill media
//   4. sync hide modal — ТОЛЬКО ТЕПЕРЬ
//   5. sync clear DOM
//   6. async persist — в фоне

FAR._jsdosModalDestroy = async function (hideModal) {
    // 1. Clear timers, invalidate token
    FAR._jsdosModalClearAutoSave();
    FAR._jsdosModalState.loadToken++;

    const ci   = FAR._jsdosModalState.ci;
    const snap = FAR._jsdosModalState.killSnap;
    const side = FAR._jsdosModalState.side;
    const item = FAR._jsdosModalState.item;

    FAR._jsdosModalState.ci = null;
    FAR._jsdosModalState.killSnap = null;

    const rootEl = document.getElementById('jsdosRoot');

    if (!ci && !snap) {
        if (hideModal) {
            const modal = document.getElementById('jsdosViewerModal');
            if (modal) modal.classList.add('hidden');
        }
        if (rootEl) rootEl.innerHTML = '';
        if (FAR._jsdosModalState.blobUrl) {
            try { URL.revokeObjectURL(FAR._jsdosModalState.blobUrl); } catch (e) {}
            FAR._jsdosModalState.blobUrl = null;
        }
        FAR._jsdosModalState.item = null;
        FAR._jsdosModalState.side = null;
        return;
    }

    // 2. ★ Sync: мгновенная тишина ★
    if (typeof FAR._hardSilenceJsdos === 'function') {
        try { FAR._hardSilenceJsdos(ci, rootEl); } catch (e) {}
    }

    // 3. ★ Sync: KILL ★
    if (typeof FAR._killJsdos === 'function') {
        try { FAR._killJsdos(snap); } catch (e) {}
    }

    // 4. Sync: best effort dos methods
    if (ci) {
        try { if (typeof ci.exit === 'function') ci.exit(); } catch (e) {}
        try { if (typeof ci.stop === 'function') ci.stop(); } catch (e) {}
    }

    // 5. ★ NOW hide modal ★
    if (hideModal) {
        const modal = document.getElementById('jsdosViewerModal');
        if (modal) modal.classList.add('hidden');
    }

    // 6. Clear DOM
    if (rootEl) {
        try {
            while (rootEl.firstChild) rootEl.removeChild(rootEl.firstChild);
        } catch (e) {}
        rootEl.innerHTML = '';
    }

    // 7. Revoke blob
    if (FAR._jsdosModalState.blobUrl) {
        try { URL.revokeObjectURL(FAR._jsdosModalState.blobUrl); } catch (e) {}
        FAR._jsdosModalState.blobUrl = null;
    }

    FAR._jsdosModalState.item = null;
    FAR._jsdosModalState.side = null;

    // 8. Async: persist (fire and forget)
    if (ci && typeof ci.persist === 'function' && side && item) {
        Promise.race([
            ci.persist(),
            new Promise(function (r) { setTimeout(r, 5000); })
        ]).then(function (bytes) {
            if (bytes && bytes.byteLength > 0 &&
                typeof FAR.WM._jsdosSaveStateToDB === 'function') {
                return FAR.WM._jsdosSaveStateToDB(side, item, bytes);
            }
        }).catch(function (e) {
            console.warn('[JSDOS modal] persist failed:', e);
        });
    }

    console.log('[JSDOS modal] DESTROYED');
};

// ---------- Публичное API ----------

FAR.closeJsdosViewer = function () {
    FAR._jsdosModalDestroy(true);
};

FAR.closeJsdosViewerOutside = function (e) {
    if (e.target === e.currentTarget) FAR.closeJsdosViewer();
};

FAR.jsdosManualPersist = async function () {
    const ci   = FAR._jsdosModalState.ci;
    const side = FAR._jsdosModalState.side;
    const item = FAR._jsdosModalState.item;
    if (!ci) {
        FAR.toast('Нет активной игры', 'warning');
        return;
    }
    try {
        const bytes = await ci.persist();
        if (bytes && bytes.byteLength > 0) {
            const ok = await FAR.WM._jsdosSaveStateToDB(side, item, bytes);
            if (ok) FAR.toast('Состояние сохранено на сервер', 'success');
            else FAR.toast('Не удалось сохранить', 'warning');
        } else {
            FAR.toast('Пустое состояние', 'warning');
        }
    } catch (e) {
        FAR.toast('Ошибка сохранения: ' + e.message, 'error');
    }
};

FAR.downloadCurrentJsdos = async function () {
    if (!FAR._jsdosModalState.item) {
        FAR.toast('Нет активной игры', 'warning');
        return;
    }
    const side = FAR._jsdosModalState.side || FAR.activePanel;
    try {
        const { data, contentType } = await FAR.readFileBodyFromSide(side, FAR._jsdosModalState.item);
        const blob = new Blob([data], { type: contentType || 'application/octet-stream' });
        FAR.saveBlobAs(blob, FAR.sanitizeFileName(FAR._jsdosModalState.item.name));
        FAR.toast('Файл сохранён', 'success');
    } catch (e) {
        FAR.toast('Ошибка скачивания: ' + e.message, 'error');
    }
};