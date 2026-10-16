// ============================================================
// 42-wm-startmenu.js — меню Пуск
// ============================================================

FAR.WM.toggleStartMenu = function () {
    const sm = document.getElementById('wmStartMenu');
    if (!sm) return;
    if (sm.classList.contains('open')) FAR.WM.closeStartMenu();
    else FAR.WM.openStartMenu();
};

FAR.WM.openStartMenu = function () {
    const sm = document.getElementById('wmStartMenu');
    const btn = document.getElementById('wmStartBtn');
    if (!sm) return;
    sm.classList.add('open');
    if (btn) btn.classList.add('open');
    FAR.WM._renderStartMenu();

    const search = document.getElementById('wmStartSearch');
    if (search) {
        search.value = '';
        setTimeout(function () { search.focus(); }, 30);
    }
    // Показываем полный список
    FAR.WM._renderStartMenu('');
};

FAR.WM.closeStartMenu = function () {
    const sm = document.getElementById('wmStartMenu');
    const btn = document.getElementById('wmStartBtn');
    if (sm) sm.classList.remove('open');
    if (btn) btn.classList.remove('open');
};

// Рендерит список приложений в меню Пуск. Если задан `query` —
// фильтрует по названию и keywords.
//
// ВАЖНО: некоторые приложения НЕ показываются в Пуске, потому
// что они имеют смысл только при программном вызове из других
// приложений. Сейчас это:
//   • 'dbpick' — диалог выбора файла из БД. Открывается
//     программно через FAR.WM.openFileDialog() из
//     просмотрщика, редактора панорам и т.д.
// Само приложение остаётся зарегистрированным в 44-wm-apps.js
// и полностью работоспособным — мы только скрываем его
// плитку в меню Пуск.

FAR.WM._renderStartMenu = function (query) {
    const list = document.getElementById('wmStartList');
    if (!list) return;

    // Приложения, которые НЕ показываем в Пуске
    const HIDDEN_IN_START = { 'dbpick': true };

    const apps = FAR.WM.getApps ? FAR.WM.getApps() : [];
    const q = (query || '').toLowerCase().trim();

    const filtered = apps.filter(function (a) {
        if (!a || !a.id) return false;
        if (HIDDEN_IN_START[a.id]) return false;
        if (!q) return true;
        return a.title.toLowerCase().includes(q) ||
            (a.keywords || '').toLowerCase().includes(q);
    });

    list.innerHTML = '';

    if (filtered.length === 0) {
        list.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; color:#6c7086; padding: 20px; font-size: 12px;">Ничего не найдено</div>';
        return;
    }

    filtered.forEach(function (app) {
        const item = document.createElement('div');
        item.className = 'wm-start-item';
        item.innerHTML =
            '<span class="wm-si-emoji">' + FAR.escapeHtml(app.icon || '📦') + '</span>' +
            '<span class="wm-si-label">' + FAR.escapeHtml(app.title) + '</span>';
        item.title = app.title;
        item.addEventListener('click', function () {
            FAR.WM.closeStartMenu();
            FAR.WM.openApp(app.id);
        });
        list.appendChild(item);
    });
};

// ============================================================
// Привязка UI
// ============================================================

FAR.WM._bindStartMenuUI = function () {
    const btn = document.getElementById('wmStartBtn');
    if (btn && !btn._wmBound) {
        btn._wmBound = true;
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            FAR.WM.toggleStartMenu();
        });
    }

    const search = document.getElementById('wmStartSearch');
    if (search && !search._wmBound) {
        search._wmBound = true;
        search.addEventListener('input', function () {
            FAR.WM._renderStartMenu(search.value);
        });
        search.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                FAR.WM.closeStartMenu();
            } else if (e.key === 'Enter') {
                // Запуск первого отфильтрованного
                const first = document.querySelector('#wmStartList .wm-start-item');
                if (first) first.click();
            }
        });
    }
};

// Вызываем при инициализации WM
FAR.WM._origEnter = FAR.WM.enter;
FAR.WM.enter = function () {
    FAR.WM._origEnter.apply(this, arguments);
    FAR.WM._bindStartMenuUI();
};

// ============================================================
// Logout
// ============================================================

FAR.WM.logout = function () {
    FAR.WM.closeStartMenu();
    if (typeof FAR.onAuthButton === 'function') {
        FAR.WM.exit();
        FAR.onAuthButton();
    }
};