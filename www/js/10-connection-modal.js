// ============================================================
// 10-connection-modal.js — модалка подключения к FileServer
// ============================================================

FAR._connModalState = {
    required: false,
    side: null,       // 'left' | 'right' | null (обе панели)
    busy: false
};

/**
 * Открывает модалку подключения.
 *
 * @param {boolean} [required] — если true, пользователь не может закрыть
 *                              без успешного подключения (кнопка ✕ и
 *                              «Отмена» скрыты)
 * @param {string}  [side]     — 'left' | 'right' — подключить только эту
 *                              панель. Если не указано — обе.
 */
FAR.openConnModal = function (required, side) {
    FAR._connModalState.required = !!required;
    FAR._connModalState.side     = side || null;
    FAR._connModalState.busy     = false;

    const modal      = document.getElementById('connModal');
    if (!modal) {
        console.error('[conn] #connModal не найден — проверьте modals/connection.html');
        return;
    }

    const titleEl    = document.getElementById('connTitle');
    const targetEl   = document.getElementById('connTarget');
    const targetName = document.getElementById('connTargetName');
    const closeBtn   = document.getElementById('connCloseBtn');
    const cancelBtn  = document.getElementById('connCancelBtn');
    const errorEl    = document.getElementById('connError');
    const urlEl      = document.getElementById('connUrl');
    const userEl     = document.getElementById('connUser');
    const passEl     = document.getElementById('connPass');
    const uiModeEl   = document.getElementById('connUiModeRow');
    const uiModeSel  = document.getElementById('connUiMode');

    // ============================================================
    // Prefill: сохранённое соединение → глобальное → URL по умолчанию
    // ============================================================
    let prefill = null;

    if (side && typeof FAR.loadSideConnFromLS === 'function') {
        prefill = FAR.loadSideConnFromLS(side);
    }
    if (!prefill) {
        prefill = FAR.loadConnFromLS();
    }
    if (!prefill) {
        // Пользователь не авторизован / нет сохранённых данных —
        // подставляем текущий origin + basePath + '/'
        // Например, https://www.smwrap.ru/file/ (без index.html)
        prefill = FAR.getDefaultConn();
        console.log('[conn] prefill default:', prefill.url);
    }

    if (urlEl)  urlEl.value  = prefill.url  || '';
    if (userEl) userEl.value = prefill.user || '';
    if (passEl) passEl.value = prefill.pass || '';

    // ---- Заголовок / target ----
    if (side) {
        if (titleEl)    titleEl.textContent = '🔐 Подключение — ' +
            (side === 'left' ? 'левая панель' : 'правая панель');
        if (targetEl)   targetEl.style.display = '';
        if (targetName) targetName.textContent = (side === 'left' ? 'Левая' : 'Правая');
    } else {
        if (titleEl)    titleEl.textContent = '🔐 Подключение к FileServer';
        if (targetEl)   targetEl.style.display = 'none';
    }

    // ---- Обязательность ----
    if (closeBtn)  closeBtn.style.display  = required ? 'none' : '';
    if (cancelBtn) cancelBtn.style.display = required ? 'none' : '';

    // ---- Выбор UI-режима: показываем только при полном подключении ----
    if (uiModeEl) {
        uiModeEl.style.display = (side ? 'none' : '');
    }
    if (uiModeSel) {
        try {
            const savedMode = localStorage.getItem(FAR.WM && FAR.WM.LS_MODE_KEY || 'filebd_ui_mode');
            uiModeSel.value = (savedMode === 'wm') ? 'wm' : 'panel';
        } catch (e) { uiModeSel.value = 'panel'; }
    }

    if (errorEl) errorEl.textContent = '';

    modal.classList.remove('hidden');

    // Фокус в поле URL — выделяем текст, чтобы можно было сразу править
    setTimeout(function () {
        if (urlEl) { urlEl.focus(); urlEl.select(); }
    }, 50);
};

FAR.closeConnModal = function () {
    if (FAR._connModalState.required) return; // нельзя закрыть при required
    const modal = document.getElementById('connModal');
    if (modal) modal.classList.add('hidden');
    FAR._connModalState.required = false;
    FAR._connModalState.side     = null;
    FAR._connModalState.busy     = false;
};

FAR.submitConnModal = async function () {
    if (FAR._connModalState.busy) return;

    const urlEl      = document.getElementById('connUrl');
    const userEl     = document.getElementById('connUser');
    const passEl     = document.getElementById('connPass');
    const errorEl    = document.getElementById('connError');
    const connectBtn = document.getElementById('connConnectBtn');
    const uiModeSel  = document.getElementById('connUiMode');

    const url  = (urlEl && urlEl.value || '').trim();
    const user = (userEl && userEl.value || '').trim();
    const pass = (passEl && passEl.value || '');

    if (!url) {
        if (errorEl) errorEl.textContent = 'Укажите адрес FileServer';
        if (urlEl) urlEl.focus();
        return;
    }

    FAR._connModalState.busy = true;
    if (connectBtn) { connectBtn.disabled = true; connectBtn.textContent = 'Подключение…'; }
    if (errorEl) errorEl.textContent = '';

    const side = FAR._connModalState.side;
    const cfg  = { url: url, user: user, pass: pass };
    const uiMode = (uiModeSel && uiModeSel.value) || 'panel';

    if (typeof FAR.showLoading === 'function') {
        FAR.showLoading('Подключение к FileServer…', url);
    }

    try {
        const res = await FAR.connectToDb(cfg);

        // ---- Применяем соединение ----
        if (side && typeof FAR.applyConnectionToSide === 'function') {
            FAR.applyConnectionToSide(side, cfg, res.db, res.fullUrl);
            if (typeof FAR.loadFilesForSide === 'function') {
                try {
                    await FAR.loadFilesForSide(side, { path: '/', silent: true });
                } catch (e) { console.warn('[conn] loadFilesForSide:', e); }
            }
            if (typeof FAR.renderPanel === 'function') {
                FAR.renderPanel(side, { skipLoad: true });
            }
            if (typeof FAR.saveSideConnToLS === 'function') {
                FAR.saveSideConnToLS(side, cfg);
            }
        } else if (typeof FAR.applyConnectionToBoth === 'function') {
            FAR.applyConnectionToBoth(cfg, res.db, res.fullUrl);
            if (typeof FAR.loadFilesForSide === 'function') {
                try {
                    await FAR.loadFilesForSide('left',  { path: '/', silent: true });
                    await FAR.loadFilesForSide('right', { path: '/', silent: true });
                } catch (e) { console.warn('[conn] loadFilesForSide:', e); }
            }
            if (typeof FAR.renderPanel === 'function') {
                FAR.renderPanel('left',  { skipLoad: true });
                FAR.renderPanel('right', { skipLoad: true });
            }
        }

        FAR.saveConnToLS(cfg);

        if (typeof FAR.updateAuthUI === 'function')        FAR.updateAuthUI();
        if (typeof FAR.updateConnIndicators === 'function') FAR.updateConnIndicators();
        if (typeof FAR.setStatus === 'function')           FAR.setStatus('✅ Подключено: ' + res.fullUrl);
        if (typeof FAR.toast === 'function')               FAR.toast('Подключение установлено', 'success');

        // Разрешаем закрыть (даже если required — соединение установлено)
        FAR._connModalState.required = false;
        FAR.closeConnModal();

        // ---- WM-режим ----
        if (uiMode === 'wm'
            && typeof FAR.WM !== 'undefined'
            && !FAR.WM.state.active) {
            setTimeout(function () {
                try { FAR.WM.enter(); }
                catch (e) { console.warn('[conn] WM.enter:', e); }
            }, 200);
        }

        // ---- Восстановление UI-состояния ----
        if (typeof FAR.restoreUiState === 'function') {
            try { FAR.restoreUiState(); } catch (e) { /* ignore */ }
        }
    } catch (e) {
        console.error('[conn] failed:', e);
        if (errorEl) errorEl.textContent = e.message || String(e);
        if (typeof FAR.toast === 'function') {
            FAR.toast('Ошибка: ' + (e.message || e), 'error');
        }
    } finally {
        if (typeof FAR.hideLoading === 'function') FAR.hideLoading();
        FAR._connModalState.busy = false;
        if (connectBtn) {
            connectBtn.disabled = false;
            connectBtn.textContent = 'Подключиться';
        }
    }
};