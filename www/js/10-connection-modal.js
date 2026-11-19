// ============================================================
// 10-connection-modal.js — модалка подключения к FileServer
// ============================================================

FAR._connModalState = {
    required: false,
    side: null,
    busy: false
};

FAR.openConnModal = function (required, side) {
    FAR._connModalState.required = !!required;
    FAR._connModalState.side     = side || null;
    FAR._connModalState.busy     = false;

    const modal = document.getElementById('connModal');
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

    // ---- Prefill ----
    let prefill = null;
    if (side && typeof FAR.loadSideConnFromLS === 'function') {
        prefill = FAR.loadSideConnFromLS(side);
    }
    if (!prefill && typeof FAR.loadConnFromLS === 'function') {
        prefill = FAR.loadConnFromLS();
    }
    if (!prefill && typeof FAR.getDefaultConn === 'function') {
        prefill = FAR.getDefaultConn();
    }
    if (!prefill) prefill = { url: '', user: '', pass: '' };

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

    if (errorEl) errorEl.textContent = '';

    // ============================================================
    // СКРЫВАЕМ экран Login, чтобы модалка отобразилась поверх всего
    // ============================================================
    if (typeof FAR.hideLoginScreen === 'function') {
        FAR.hideLoginScreen();
    }

    modal.classList.remove('hidden');

    setTimeout(function () {
        if (urlEl) { urlEl.focus(); urlEl.select(); }
    }, 50);
};

FAR.closeConnModal = function () {
    if (FAR._connModalState.required) return;

    const modal = document.getElementById('connModal');
    if (modal) modal.classList.add('hidden');

    FAR._connModalState.required = false;
    FAR._connModalState.side     = null;
    FAR._connModalState.busy     = false;

    // ============================================================
    // ВОЗВРАЩАЕМ экран Login, если пользователь не авторизовался
    // (например, нажал «Отмена» или крестик)
    // ============================================================
    if (!FAR.db && typeof FAR.showLoginScreen === 'function') {
        FAR.showLoginScreen();
    }
};

FAR.submitConnModal = async function () {
    if (FAR._connModalState.busy) return;

    const urlEl      = document.getElementById('connUrl');
    const userEl     = document.getElementById('connUser');
    const passEl     = document.getElementById('connPass');
    const errorEl    = document.getElementById('connError');
    const connectBtn = document.getElementById('connConnectBtn');

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

    if (typeof FAR.showLoading === 'function') {
        FAR.showLoading('Подключение к FileServer…', url);
    }

    try {
        const res = await FAR.connectToDb(cfg);

        // ---- Применяем соединение ----
        if (side && typeof FAR.applyConnectionToSide === 'function') {
            FAR.applyConnectionToSide(side, cfg, res.db, res.fullUrl);
            if (typeof FAR.loadFilesForSide === 'function') {
                try { await FAR.loadFilesForSide(side, { path: '/', silent: true }); }
                catch (e) { console.warn('[conn] loadFilesForSide:', e); }
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

        if (typeof FAR.saveConnToLS === 'function') FAR.saveConnToLS(cfg);

        if (typeof FAR.updateAuthUI === 'function')         FAR.updateAuthUI();
        if (typeof FAR.updateConnIndicators === 'function') FAR.updateConnIndicators();
        if (typeof FAR.setStatus === 'function')            FAR.setStatus('✅ Подключено: ' + res.fullUrl);
        if (typeof FAR.toast === 'function')                FAR.toast('Подключение установлено', 'success');

        FAR._connModalState.required = false;

        // Закрываем модалку. Так как FAR.db теперь задан,
        // closeConnModal НЕ покажет экран Login.
        FAR.closeConnModal();

        // ============================================================
        // Успешная авторизация: скрываем экран Login и входим в WM
        // ============================================================
        if (typeof FAR.hideLoginScreen === 'function') {
            FAR.hideLoginScreen();
        }

        if (typeof FAR.WM !== 'undefined') {
            setTimeout(function () {
                try {
                    if (FAR.WM.state.active) {
                        if (typeof FAR.WM._renderDesktopIcons === 'function') FAR.WM._renderDesktopIcons();
                        if (typeof FAR.WM._renderStartMenu   === 'function') FAR.WM._renderStartMenu('');
                        if (typeof FAR.WM.updateTray         === 'function') FAR.WM.updateTray();
                    } else {
                        FAR.WM.enter();
                    }
                } catch (e) {
                    console.warn('[conn] WM.enter:', e);
                }
            }, 200);
        }

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