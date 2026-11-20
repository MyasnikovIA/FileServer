// ============================================================
// 23-main.js — точка входа: загрузка модалок, инициализация,
// автоподключение, управление экраном Login.
// ============================================================

// ============================================================
// Экран Login — безопасные функции
// ============================================================

FAR.showLoginScreen = function () {
    const el = document.getElementById('loginScreen');
    if (el) el.classList.remove('hidden');

    if (typeof FAR.WM !== 'undefined' && FAR.WM.state && FAR.WM.state.active) {
        try { FAR.WM.exit(); } catch (e) { /* ignore */ }
    }
};

FAR.hideLoginScreen = function () {
    const el = document.getElementById('loginScreen');
    if (el) el.classList.add('hidden');
};

// ============================================================
// Загрузка модалок (ТЕПЕРЬ АСИНХРОННАЯ)
// ============================================================

FAR.loadModalFragment = async function (path) {
    try {
        const res = await fetch(path, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.text();
    } catch (e) {
        console.error('[main] Не удалось загрузить ' + path + ':', e);
        return '<!-- Ошибка загрузки ' + path + ' -->';
    }
};

FAR.injectModals = async function () {
    const root = document.getElementById('modalRoot');
    if (!root) {
        console.error('[main] #modalRoot не найден');
        return;
    }

    const files = [
        'modals/connection.html',
        'modals/viewer.html',
        'modals/panorama-viewer.html',
        'modals/panorama-editor.html',
        'modals/db-picker.html',
        'modals/mp3-viewer.html',
        'modals/video-viewer.html',
        'modals/jsdos-viewer.html',
        'modals/console.html',
        'modals/videochat-viewer.html',
        'modals/videochat-broadcaster.html',
        'modals/emulator-viewer.html',
        'modals/pdf-viewer.html',
        'modals/lbrn2-viewer.html',
        'modals/gcode-viewer.html',
        'modals/browser.html',
        'modals/gamepad-setup.html',
        'modals/gpu-monitor.html',
        'modals/ollama.html',
        'modals/progress.html',
        'modals/loading.html',
        'modals/debug.html',
        'modals/desktop.html',
        'modals/wm-file-dialog.html'
    ];

    let html = '';
    for (const f of files) {
        html += await FAR.loadModalFragment(f) + '\n';
    }
    root.innerHTML = html;
};

// ============================================================
// [JSDOS-FIX] Последняя линия обороны при уходе со страницы:
// гасим все активные JSDOS-инстансы (и модалку, и WM-окна),
// чтобы звук не продолжался после закрытия/перезагрузки вкладки.
// ============================================================

FAR._emergencyStopAllJsdos = function () {
    // 1. Модалка (28-jsdos-viewer.js)
    try {
        if (FAR._jsdosModalState && FAR._jsdosModalState.ci) {
            const ci = FAR._jsdosModalState.ci;
            if (typeof FAR._hardSilenceJsdos === 'function') {
                try {
                    FAR._hardSilenceJsdos(
                        ci,
                        document.getElementById('jsdosRoot')
                    );
                } catch (e) {}
            }
            try { if (typeof ci.stop === 'function') ci.stop(); } catch (e) {}
            try {
                if (ci.dosWorker) ci.dosWorker.terminate();
            } catch (e) {}
            try {
                if (ci.worker) ci.worker.terminate();
            } catch (e) {}
        }
    } catch (e) { /* ignore */ }

    // 2. Все WM-окна (48-wm-viewers-emu.js)
    try {
        if (typeof FAR.WM !== 'undefined'
            && FAR.WM.state
            && Array.isArray(FAR.WM.state.windows)) {
            for (const w of FAR.WM.state.windows) {
                if (w && w.props && w.props._jsdosInstance) {
                    try {
                        if (typeof FAR.WM._stopJsdos === 'function') {
                            FAR.WM._stopJsdos(w);
                        } else {
                            const ci = w.props._jsdosInstance;
                            if (typeof FAR._hardSilenceJsdos === 'function') {
                                try { FAR._hardSilenceJsdos(ci, w.bodyEl); } catch (e) {}
                            }
                            try { if (typeof ci.stop === 'function') ci.stop(); } catch (e) {}
                        }
                    } catch (e) { /* ignore */ }
                }
            }
        }
    } catch (e) { /* ignore */ }
};

// Регистрируем один раз. pagehide вызывается и при закрытии вкладки,
// и при bfcache-navigation. beforeunload — на всякий случай для
// старых браузеров.
(function installJsdosEmergencyStop() {
    if (window._farJsdosEmergencyInstalled) return;
    window._farJsdosEmergencyInstalled = true;

    const handler = function () {
        try { FAR._emergencyStopAllJsdos(); } catch (e) { /* ignore */ }
    };

    window.addEventListener('pagehide', handler);
    window.addEventListener('beforeunload', handler);
})();

// ============================================================
// Старт
// ============================================================
document.addEventListener('DOMContentLoaded', async function () {
    // Ждём, пока все модалки загрузятся в DOM
    await FAR.injectModals();

    if (typeof FAR.setupPanelDbSwitcher === 'function') {
        FAR.setupPanelDbSwitcher();
    }
    if (typeof FAR.updateConnIndicators === 'function') {
        FAR.updateConnIndicators();
    }

    if (typeof FAR.updateAuthUI === 'function') {
        FAR.updateAuthUI();
    }

    FAR.setupPanelDragDrop('panelLeft');
    FAR.setupPanelDragDrop('panelRight');

    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop',     function (e) { e.preventDefault(); });

    if (typeof FAR.setupKeyboard === 'function') FAR.setupKeyboard();
    if (typeof FAR.setupGamepadAuto === 'function') FAR.setupGamepadAuto();
    if (typeof FAR.setupPanelContextMenu === 'function') FAR.setupPanelContextMenu();

    if (typeof FAR.initBrowser === 'function') FAR.initBrowser();
    if (typeof FAR.initConsole === 'function') FAR.initConsole();

    if (typeof FAR._installPannellumDbWrapper === 'function') FAR._installPannellumDbWrapper();

    if (typeof FAR.restoreAuthTokenFromCookie === 'function') {
        FAR.restoreAuthTokenFromCookie();
    }

    const savedGlobal = (typeof FAR.loadConnFromLS === 'function') ? FAR.loadConnFromLS() : null;
    const savedLeft   = (typeof FAR.loadSideConnFromLS === 'function')
        ? FAR.loadSideConnFromLS('left')  : null;
    const savedRight  = (typeof FAR.loadSideConnFromLS === 'function')
        ? FAR.loadSideConnFromLS('right') : null;

    const saved = savedGlobal || savedLeft || savedRight;

    // ============================================================
    // Пользователь не авторизован → только кнопка Login по центру
    // ============================================================
    if (!saved) {
        if (typeof FAR.setStatus === 'function') FAR.setStatus('🔐 Требуется вход');
        FAR.showLoginScreen();
        return;
    }

    // ============================================================
    // Есть сохранённое соединение → пробуем автологин
    // ============================================================
    if (typeof FAR.setStatus === 'function') {
        FAR.setStatus('🔌 Подключение с сохранёнными данными…');
    }
    if (typeof FAR.showLoading === 'function') {
        FAR.showLoading('Подключение к FileServer…', saved.url);
    }

    try {
        const res = await FAR.connectToDb(saved);

        if (typeof FAR.applyConnectionToBoth === 'function') {
            FAR.applyConnectionToBoth(saved, res.db, res.fullUrl);
        }

        if (typeof FAR.hideLoading === 'function') FAR.hideLoading();
        FAR.hideLoginScreen();

        if (typeof FAR.updateAuthUI === 'function') FAR.updateAuthUI();
        if (typeof FAR.setStatus === 'function') FAR.setStatus('✅ Подключено: ' + res.fullUrl);
        if (typeof FAR.toast === 'function') FAR.toast('Подключение восстановлено', 'success');

        if (typeof FAR.loadFilesForSide === 'function') {
            try {
                await FAR.loadFilesForSide('left',  { path: '/', silent: true });
                await FAR.loadFilesForSide('right', { path: '/', silent: true });
            } catch (e) { console.warn('[main] loadFilesForSide:', e); }
        }

        if (typeof FAR.renderPanel === 'function') {
            FAR.renderPanel('left',  { skipLoad: true });
            FAR.renderPanel('right', { skipLoad: true });
        }

        if (typeof FAR.restoreUiState === 'function') {
            try { FAR.restoreUiState(); } catch (e) { /* ignore */ }
        }

        if (typeof FAR.updateConnIndicators === 'function') {
            FAR.updateConnIndicators();
        }

        // === Входим в WM (единственный режим проекта) ===
        if (typeof FAR.WM !== 'undefined') {
            try { FAR.WM.enter(); }
            catch (e) { console.warn('[main] WM.enter:', e); }
        }
    } catch (e) {
        if (typeof FAR.hideLoading === 'function') FAR.hideLoading();
        console.error('[main] auto-connect error:', e);

        FAR.side.left  = FAR.createSideContext('left');
        FAR.side.right = FAR.createSideContext('right');
        FAR.currentConn = null;

        if (typeof FAR.updateAuthUI === 'function') FAR.updateAuthUI();
        if (typeof FAR.setStatus === 'function') FAR.setStatus('❌ Ошибка автоподключения: ' + e.message);
        if (typeof FAR.toast === 'function') FAR.toast('Не удалось подключиться с сохранёнными данными', 'error');

        FAR.showLoginScreen();
    }
});