FAR.updateAuthUI = function() {
    const btn = document.getElementById('btnAuth');
    if (FAR.db) {
        btn.textContent = '🔓 LogOut';
        btn.title = 'Выйти и очистить сохранённые данные подключения';
    } else {
        btn.textContent = '🔐 LogIn';
        btn.title = 'Войти в базу данных';
    }
    const ids = ['btnUpload','btnMkdir','btnCopy','btnMove','btnDownload',
                 'btnZip','btnDelete','btnRefresh','btnDebug','btnMigrate'];
    for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (id === 'btnRefresh' || id === 'btnDebug' || id === 'btnMigrate'
            || id === 'btnUpload' || id === 'btnMkdir') {
            el.disabled = !FAR.db;
        } else {
            if (!FAR.db) el.disabled = true;
        }
    }
    if (FAR.db) FAR.updateButtons();
};
FAR.onAuthButton = function () {
    if (FAR.db) {
        if (!confirm('Выйти из системы?\nСохранённые данные подключения будут удалены.')) return;
        FAR.clearConnFromLS();
        try { localStorage.removeItem(FAR.LS_CONN_LEFT); } catch (e) {}
        try { localStorage.removeItem(FAR.LS_CONN_RIGHT); } catch (e) {}

        // Если открыт оконный режим — выходим в панельный
        if (typeof FAR.WM !== 'undefined' && FAR.WM.state && FAR.WM.state.active) {
            try { FAR.WM.exit(); } catch (e) {}
        }
        // Сбрасываем сохранённый режим: следующий вход — с дефолта
        if (typeof FAR.WM !== 'undefined' && typeof FAR.WM.clearMode === 'function') {
            FAR.WM.clearMode();
        }

        FAR.side.left  = FAR.createSideContext('left');
        FAR.side.right = FAR.createSideContext('right');
        FAR.currentConn = null;

        FAR.renderPanel('left');
        FAR.renderPanel('right');
        FAR.updateAuthUI();
        FAR.updateTotalSize();
        FAR.updateConnIndicators();
        FAR.setStatus('🔓 Вы вышли из системы');
        FAR.openConnModal();
    } else {
        FAR.openConnModal();
    }
};