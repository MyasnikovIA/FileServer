// ============================================================
// 43-wm-desktop.js — рабочий стол: иконки, drag, контекстное меню
// ============================================================

FAR.WM.LS_ICONS_KEY = 'filebd_wm_desktop_icons';

// Какие приложения выводим иконками на рабочем столе по умолчанию
FAR.WM.DESKTOP_DEFAULT = [
    { id: 'explorer',  x: 20,  y: 20  },
    { id: 'viewer',    x: 20,  y: 130 },
    { id: 'panorama',  x: 20,  y: 240 },
    { id: 'pdf',       x: 20,  y: 350 },
    { id: 'mp3',       x: 20,  y: 460 },
    { id: 'video',     x: 130, y: 20  },
    { id: 'connect',   x: 130, y: 130 },
    { id: 'debug',     x: 130, y: 240 }
];

FAR.WM._loadDesktopIcons = function () {
    try {
        const raw = localStorage.getItem(FAR.WM.LS_ICONS_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!Array.isArray(obj)) return null;
        return obj;
    } catch (e) {
        return null;
    }
};

FAR.WM._saveDesktopIcons = function (list) {
    try {
        localStorage.setItem(FAR.WM.LS_ICONS_KEY, JSON.stringify(list));
    } catch (e) { /* ignore */ }
};

FAR.WM._renderDesktopIcons = function () {
    const container = document.getElementById('wmDesktopIcons');
    if (!container) return;

    // Иконки, которые НЕ должны появляться на рабочем столе,
    // даже если они сохранены в localStorage от старых версий.
    // 'dbpick' — диалог выбора файла, открывается только
    // программно из других приложений.
    const HIDDEN_ON_DESKTOP = { 'dbpick': true };

    let layout = FAR.WM._loadDesktopIcons();
    if (!layout) {
        layout = FAR.WM.DESKTOP_DEFAULT.slice();
        FAR.WM._saveDesktopIcons(layout);
    } else {
        // Фильтруем сохранённый layout: убираем скрытые иконки.
        // Если что-то убрали — сохраняем почищенный вариант,
        // чтобы при следующей загрузке не делать этого снова.
        const filtered = layout.filter(function (entry) {
            return entry && entry.id && !HIDDEN_ON_DESKTOP[entry.id];
        });
        if (filtered.length !== layout.length) {
            layout = filtered;
            FAR.WM._saveDesktopIcons(layout);
        }
    }

    container.innerHTML = '';

    layout.forEach(function (entry, idx) {
        const app = FAR.WM.getApp ? FAR.WM.getApp(entry.id) : null;
        if (!app) return;
        // Ещё одна страховка: даже если каким-то чудом
        // скрытый id попал в layout — не рисуем.
        if (HIDDEN_ON_DESKTOP[entry.id]) return;

        const el = document.createElement('div');
        el.className = 'wm-desktop-icon';
        el.style.left = entry.x + 'px';
        el.style.top  = entry.y + 'px';
        el.dataset.appId = entry.id;
        el.dataset.iconIndex = idx;
        el.innerHTML =
            '<span class="wm-di-emoji">' + FAR.escapeHtml(app.icon || '📦') + '</span>' +
            '<span class="wm-di-label">' + FAR.escapeHtml(app.title) + '</span>';

        // Двойной клик — открыть
        el.addEventListener('dblclick', function () {
            FAR.WM.openApp(entry.id);
        });

        // Одиночный клик — выделить
        el.addEventListener('mousedown', function (e) {
            e.stopPropagation();
            document.querySelectorAll('.wm-desktop-icon.selected').forEach(function (x) {
                x.classList.remove('selected');
            });
            el.classList.add('selected');
        });

        // Перетаскивание иконки
        el.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            FAR.WM._startIconDrag(e, el, idx);
        });

        // ПКМ по иконке
        el.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            e.stopPropagation();
            FAR.WM._showIconContextMenu(e.clientX, e.clientY, entry.id);
        });

        container.appendChild(el);
    });
};

// ============================================================
// Перетаскивание иконки
// ============================================================

FAR.WM._startIconDrag = function (e, el, idx) {
    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = parseInt(el.style.left, 10) || 0;
    const origTop  = parseInt(el.style.top, 10)  || 0;
    let moved = false;

    const onMove = function (ev) {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
            moved = true;
            el.classList.add('dragging');
        }
        if (!moved) return;

        const nx = Math.max(0, origLeft + dx);
        const ny = Math.max(0, origTop + dy);
        el.style.left = nx + 'px';
        el.style.top  = ny + 'px';
    };

    const onUp = function () {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        el.classList.remove('dragging');

        if (moved) {
            const layout = FAR.WM._loadDesktopIcons() || FAR.WM.DESKTOP_DEFAULT.slice();
            const entry = layout[idx];
            if (entry) {
                entry.x = parseInt(el.style.left, 10) || 0;
                entry.y = parseInt(el.style.top, 10)  || 0;
                FAR.WM._saveDesktopIcons(layout);
            }
        }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
};

// ============================================================
// Контекстное меню рабочего стола
// ============================================================

FAR.WM._showDesktopContextMenu = function (x, y) {
    const menu = document.getElementById('wmContextMenu');
    if (!menu) return;
    menu.innerHTML = '';

    FAR.WM._addCtxItem(menu, '🔄 Обновить', function () {
        FAR.WM._renderDesktopIcons();
    });
    FAR.WM._addCtxItem(menu, '📁 Открыть Проводник', function () {
        FAR.WM.openApp('explorer');
    });
    FAR.WM._addCtxSep(menu);
    FAR.WM._addCtxItem(menu, '🗄️ Подключение к БД', function () {
        FAR.WM.openApp('connect');
    });
    FAR.WM._addCtxItem(menu, '🎮 Настройка джойстика', function () {
        FAR.WM.openApp('gamepad');
    });

    // ============================================================
    // Обои рабочего стола (модуль 48-wm-wallpaper.js)
    // ============================================================
    if (typeof FAR.WMWallpaper !== 'undefined') {
        FAR.WM._addCtxSep(menu);

        FAR.WM._addCtxItem(menu, '🖼 Обои из URL…', function () {
            FAR.WMWallpaper.promptUrl();
        });
        FAR.WM._addCtxItem(menu, '🖼 Обои из БД…', function () {
            FAR.WMWallpaper.pickFromDb();
        });

        // «Убрать обои» показываем только если установлены не дефолтные
        const st = FAR.WMWallpaper._load();
        if (st.source !== 'default') {
            FAR.WM._addCtxItem(menu, '🗑 Убрать обои', function () {
                FAR.WMWallpaper.reset();
            });
        }
    }

    FAR.WM._addCtxSep(menu);
    FAR.WM._addCtxItem(menu, '⚙ Сбросить расположение иконок', function () {
        FAR.WM._saveDesktopIcons(FAR.WM.DESKTOP_DEFAULT.slice());
        FAR.WM._renderDesktopIcons();
    });

    FAR.WM._positionContextMenu(menu, x, y);
};

FAR.WM._showIconContextMenu = function (x, y, appId) {
    const menu = document.getElementById('wmContextMenu');
    if (!menu) return;
    menu.innerHTML = '';

    FAR.WM._addCtxItem(menu, '📂 Открыть', function () {
        FAR.WM.openApp(appId);
    });
    FAR.WM._addCtxItem(menu, '🪟 Открыть в новом окне', function () {
        FAR.WM.openApp(appId, { forceNew: true });
    });

    FAR.WM._positionContextMenu(menu, x, y);
};

FAR.WM._addCtxItem = function (menu, label, onClick) {
    const el = document.createElement('div');
    el.className = 'wm-ctx-item';
    el.textContent = label;
    el.addEventListener('click', function () {
        FAR.WM._hideContextMenu();
        try { onClick(); } catch (e) {
            console.error('[WM ctx]', e);
            FAR.toast('Ошибка: ' + e.message, 'error');
        }
    });
    menu.appendChild(el);
};

FAR.WM._addCtxSep = function (menu) {
    const s = document.createElement('div');
    s.className = 'wm-ctx-sep';
    menu.appendChild(s);
};

FAR.WM._positionContextMenu = function (menu, x, y) {
    menu.style.left = x + 'px';
    menu.style.top  = y + 'px';
    menu.classList.add('open');
    // Не вылезать за пределы
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth - 4) menu.style.left = (window.innerWidth - rect.width - 4) + 'px';
    if (rect.bottom > window.innerHeight - 4) menu.style.top = (window.innerHeight - rect.height - 4) + 'px';
};

FAR.WM._hideContextMenu = function () {
    const menu = document.getElementById('wmContextMenu');
    if (menu) menu.classList.remove('open');
};

// ============================================================
// Привязка событий рабочего стола
// ============================================================

FAR.WM._bindDesktopUI = function () {
    const desktop = document.getElementById('wmDesktop');
    if (!desktop || desktop._wmBound) return;
    desktop._wmBound = true;

    // Клик по пустому месту — снять выделение
    desktop.addEventListener('mousedown', function (e) {
        if (e.target === desktop || e.target.classList.contains('wm-desktop-icons')) {
            document.querySelectorAll('.wm-desktop-icon.selected').forEach(function (x) {
                x.classList.remove('selected');
            });
        }
    });

    // ПКМ по пустому месту
    desktop.addEventListener('contextmenu', function (e) {
        if (e.target.closest('.wm-window')) return;
        if (e.target.closest('.wm-desktop-icon')) return;
        e.preventDefault();
        FAR.WM._showDesktopContextMenu(e.clientX, e.clientY);
    });
};

// Расширяем enter — добавим привязку после рендера
FAR.WM._origEnter2 = FAR.WM.enter;
FAR.WM.enter = function () {
    FAR.WM._origEnter2.apply(this, arguments);
    FAR.WM._bindDesktopUI();
    FAR.WM._renderDesktopIcons();
};

