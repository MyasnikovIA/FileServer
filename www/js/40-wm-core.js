// ============================================================
// 40-wm-core.js — ядро оконного менеджера
// ============================================================
//
// Отвечает за:
//   • создание/закрытие/фокус/сворачивание/разворачивание окон
//   • перетаскивание и ресайз (8 ручек), Aero Snap к краям
//   • стек z-index, активное окно
//   • сохранение позиций иконок рабочего стола
//   • сериализацию состояния окон (для localStorage)
//
// Не знает о приложениях — только о «форме окна». Реестр
// приложений — в 44-wm-apps.js.

FAR.WM = FAR.WM || {};
FAR.WM.LS_MODE_KEY = 'filebd_ui_mode';
FAR.WM.LS_WINDOWS_KEY = 'filebd_wm_windows';

FAR.WM._SKIP_RESTORE_APPS = {
    'jsdos': 1,
    'nes': 1,
    'emulator': 1
};

FAR.WM.state = {
    active: false,
    windows: [],           // [{ id, title, icon, el, bodyEl, x, y, w, h,
                           //    minimized, maximized, prevRect, snap,
                           //    modalParent, onClose, appId, props }]
    nextId: 1,
    activeWindowId: null,
    zTop: 6000,
    dragState: null,
    resizeState: null,
    snapZone: 40,          // px от края, при которых срабатывает снап
    snapPreviewEl: null,
    taskbarHeight: 48,
    lastDesktopIconPos: 0
};

// ============================================================
// Публичный API
// ============================================================

/**
 * Включает оконный режим. Перед входом закрывает все модалки.
 */
FAR.WM.enter = function () {
    if (FAR.WM.state.active) return;

    // M1: принудительно закрываем все модалки-оверлеи
    FAR.WM._closeAllModals();

    const root = document.getElementById('wmRoot');
    if (!root) {
        console.error('[WM] #wmRoot не найден. Проверь modals/desktop.html и injectModals.');
        return;
    }
    root.classList.add('active');
    FAR.WM.state.active = true;

    // Запоминаем режим для следующей сессии
    FAR.WM.saveMode('wm');

    FAR.WM._bindGlobalEvents();
    FAR.WM._renderDesktopIcons();
    FAR.WM._renderStartMenu();
    FAR.WM._startClock();

    // ============================================================
    // Восстанавливаем окна из прошлой сессии.
    //
    // • Ключа нет → первый вход, открываем Проводник.
    // • Ключ есть, пустой массив → пользователь закрыл все
    //   окна ранее, оставляем стол пустым.
    // • Ключ есть, есть окна → восстанавливаем все.
    // ============================================================
    FAR.WM._restoreWindows().catch(function (e) {
        console.warn('[WM restore] failed:', e);
    });

    FAR.toast('Оконный режим включён', 'info');
};

FAR.WM.exit = function () {
    if (!FAR.WM.state.active) return;

    // ВАЖНО: сохраняем состояние окон ПЕРЕД закрытием,
    // иначе closeWindow(force=true) перезапишет его пустым
    // массивом.
    FAR.WM._saveWindowState();

    // Закрываем все окна без подтверждения
    const ids = FAR.WM.state.windows.map(w => w.id);
    for (const id of ids) FAR.WM.closeWindow(id, true);

    const root = document.getElementById('wmRoot');
    if (root) root.classList.remove('active');

    FAR.WM.state.active = false;
    FAR.WM.state.activeWindowId = null;
    FAR.WM.state.zTop = 6000;

    // Запоминаем режим
    FAR.WM.saveMode('panel');

    FAR.WM._stopClock();
    FAR.toast('Возврат в классический режим', 'info');
};

FAR.WM.toggle = function () {
    if (FAR.WM.state.active) FAR.WM.exit();
    else FAR.WM.enter();
};

// ============================================================
// Создание окна
// ============================================================

/**
 * Открывает окно.
 *
 * @param {Object} opts
 *   @param {string}  opts.title       — заголовок
 *   @param {string} [opts.icon]       — эмодзи-иконка
 *   @param {number} [opts.width]      — ширина (px), по умолчанию 900
 *   @param {number} [opts.height]     — высота (px), по умолчанию 600
 *   @param {number} [opts.x]          — левый верхний угол, авто если не задано
 *   @param {number} [opts.y]
 *   @param {HTMLElement|string} [opts.content] — DOM-элемент или HTML-строка
 *   @param {string} [opts.appId]      — id приложения (для панели задач)
 *   @param {Function} [opts.onClose]  — колбэк при закрытии
 *   @param {Object} [opts.props]      — произвольные данные приложения
 *   @param {boolean} [opts.modal]     — если true, окно модально (нет — обычное)
 *   @param {number} [opts.parentId]   — id родительского окна для модальных
 *
 * @returns {Object} дескриптор окна
 */

FAR.WM.openWindow = function (opts) {
    opts = opts || {};
    const id = 'wm-win-' + (FAR.WM.state.nextId++);

    const desktop = document.getElementById('wmDesktop');
    const layer = document.getElementById('wmWindowsLayer') || desktop;
    const rect = FAR.WM._getDesktopRect();

    const w = opts.width  || Math.min(1000, rect.width  - 80);
    const h = opts.height || Math.min(680,  rect.height - 80);

    // Если x/y не заданы — каскадом со смещением
    let x = opts.x, y = opts.y;
    if (x === undefined || y === undefined) {
        const offset = (FAR.WM.state.windows.length % 8) * 24;
        x = Math.max(20, Math.round((rect.width  - w) / 2) - 80 + offset);
        y = Math.max(20, Math.round((rect.height - h) / 2) - 60 + offset);
    }

    const el = document.createElement('div');
    el.className = 'wm-window';
    el.id = id;
    el.style.left = x + 'px';
    el.style.top  = y + 'px';
    el.style.width  = w + 'px';
    el.style.height = h + 'px';

    const icon = opts.icon || '🪟';
    const title = opts.title || 'Окно';

    el.innerHTML =
        '<div class="wm-titlebar" data-role="titlebar">' +
        '<span class="wm-title-icon">' + FAR.escapeHtml(icon) + '</span>' +
        '<span class="wm-title-text">' + FAR.escapeHtml(title) + '</span>' +
        '<div class="wm-title-actions">' +
        '<button class="wm-title-btn wm-btn-min" title="Свернуть">─</button>' +
        '<button class="wm-title-btn wm-btn-max" title="Развернуть">□</button>' +
        '<button class="wm-title-btn wm-btn-close" title="Закрыть">✕</button>' +
        '</div>' +
        '</div>' +
        '<div class="wm-body" data-role="body"></div>' +
        // 8 ручек ресайза
        '<div class="wm-resize wm-resize-n"  data-dir="n"></div>' +
        '<div class="wm-resize wm-resize-s"  data-dir="s"></div>' +
        '<div class="wm-resize wm-resize-w"  data-dir="w"></div>' +
        '<div class="wm-resize wm-resize-e"  data-dir="e"></div>' +
        '<div class="wm-resize wm-resize-nw" data-dir="nw"></div>' +
        '<div class="wm-resize wm-resize-ne" data-dir="ne"></div>' +
        '<div class="wm-resize wm-resize-sw" data-dir="sw"></div>' +
        '<div class="wm-resize wm-resize-se" data-dir="se"></div>';

    const bodyEl = el.querySelector('[data-role="body"]');
    FAR.WM._fillBody(bodyEl, opts.content);

    // Обработчики кнопок заголовка
    el.querySelector('.wm-btn-min').addEventListener('click', function (e) {
        e.stopPropagation();
        FAR.WM.minimizeWindow(id);
    });
    el.querySelector('.wm-btn-max').addEventListener('click', function (e) {
        e.stopPropagation();
        FAR.WM.toggleMaximize(id);
    });
    el.querySelector('.wm-btn-close').addEventListener('click', function (e) {
        e.stopPropagation();
        FAR.WM.closeWindow(id);
    });

    // Фокус по клику
    el.addEventListener('mousedown', function () {
        FAR.WM.focusWindow(id);
    }, true);

    // Drag за заголовок
    const titlebar = el.querySelector('[data-role="titlebar"]');
    titlebar.addEventListener('mousedown', function (e) {
        if (e.target.closest('.wm-title-btn')) return;
        FAR.WM._startDrag(e, id);
    });
    titlebar.addEventListener('dblclick', function (e) {
        if (e.target.closest('.wm-title-btn')) return;
        FAR.WM.toggleMaximize(id);
    });

    // Resize
    el.querySelectorAll('.wm-resize').forEach(function (handle) {
        handle.addEventListener('mousedown', function (e) {
            FAR.WM._startResize(e, id, handle.dataset.dir);
        });
    });

    layer.appendChild(el);

    const win = {
        id: id,
        title: title,
        icon: icon,
        appId: opts.appId || null,
        el: el,
        bodyEl: bodyEl,
        x: x, y: y, w: w, h: h,
        prevRect: null,
        minimized: false,
        maximized: false,
        snap: null,
        modalParent: opts.parentId || null,
        onClose: opts.onClose || null,
        props: opts.props || {},
        createdAt: Date.now()
    };
    FAR.WM.state.windows.push(win);

    FAR.WM.focusWindow(id);
    FAR.WM._renderTaskbar();

    // Если модальное — блокируем родителя
    if (opts.modal && opts.parentId) {
        const parent = FAR.WM.getWindow(opts.parentId);
        if (parent) parent.el.classList.add('modal-locked');
    }

    // Сохраняем состояние окон (debounce)
    FAR.WM._saveWindowStateDebounced();

    return win;
};

/**
 * Закрывает окно.
 * @param {string} id
 * @param {boolean} [force] — без колбэка onClose (при выходе из режима)
 */
FAR.WM.closeWindow = function (id, force) {
    const idx = FAR.WM.state.windows.findIndex(w => w.id === id);
    if (idx < 0) return;
    const win = FAR.WM.state.windows[idx];

    // Снимаем блокировку родителя, если был модальным
    if (win.modalParent) {
        const parent = FAR.WM.getWindow(win.modalParent);
        if (parent) parent.el.classList.remove('modal-locked');
    }

    // Возвращаем id оригинальной модалке (если был стеш)
    if (win.props && win.props._stash && typeof FAR.WM._unstashModalIds === 'function') {
        FAR.WM._unstashModalIds(win.props._stash);
        win.props._stash = null;
    }

    // Возвращаем id оригинальной панели Проводника
    if (win.appId === 'explorer' && typeof FAR.WM._cleanupExplorerPanel === 'function') {
        try { FAR.WM._cleanupExplorerPanel(win); } catch (e) { /* ignore */ }
    }

    if (!force && typeof win.onClose === 'function') {
        try { win.onClose(win); } catch (e) { console.warn('[WM] onClose:', e); }
    }

    win.el.remove();
    FAR.WM.state.windows.splice(idx, 1);

    if (FAR.WM.state.activeWindowId === id) {
        const next = FAR.WM.state.windows
            .filter(w => !w.minimized)
            .sort((a, b) => (b.zTop || 0) - (a.zTop || 0))[0];
        FAR.WM.state.activeWindowId = next ? next.id : null;
        if (next) FAR.WM.focusWindow(next.id);
    }

    FAR.WM._renderTaskbar();

    // Сохраняем состояние окон, КРОМЕ force-закрытия
    // (force вызывается при выходе из WM — там состояние
    // уже сохранено в exit до закрытия).
    if (!force) {
        FAR.WM._saveWindowStateDebounced();
    }
};

// ============================================================
// Перетаскивание
// ============================================================

FAR.WM._startDrag = function (e, id) {
    const win = FAR.WM.getWindow(id);
    if (!win || win.maximized) return;
    if (e.button !== 0) return;

    // Если окно было snapped — при перетаскивании возвращаем размер
    let startX = e.clientX, startY = e.clientY;
    let origX = win.x, origY = win.y;
    let wasSnapped = win.snap;

    if (wasSnapped) {
        // Восстанавливаем размер, но позиционируем так, чтобы
        // курсор оказался примерно в центре
        const r = win.prevRect || { x: 100, y: 100, w: 800, h: 600 };
        FAR.WM._applyRect(win, { x: e.clientX - r.w / 2, y: e.clientY - 15, w: r.w, h: r.h });
        win.el.classList.remove('snapped-left', 'snapped-right');
        win.snap = null;
        origX = win.x; origY = win.y;
    }

    FAR.WM.state.dragState = {
        id: id,
        offsetX: startX - origX,
        offsetY: startY - origY,
        snapCandidate: null
    };
    win.el.classList.add('dragging');

    const onMove = FAR.WM._onDragMove;
    const onUp = FAR.WM._onDragUp;

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
};

FAR.WM._onDragMove = function (e) {
    const st = FAR.WM.state.dragState;
    if (!st) return;
    const win = FAR.WM.getWindow(st.id);
    if (!win) return;

    const rect = FAR.WM._getDesktopRect();
    let newX = e.clientX - st.offsetX;
    let newY = e.clientY - st.offsetY;

    // Ограничиваем, чтобы заголовок не ушёл за края
    newX = Math.max(-win.w + 100, Math.min(rect.width  - 100, newX));
    newY = Math.max(0, Math.min(rect.height - 30, newY));

    win.x = newX;
    win.y = newY;
    win.el.style.left = newX + 'px';
    win.el.style.top  = newY + 'px';

    // Снап-превью у краёв
    const zone = FAR.WM.state.snapZone;
    let snap = null;
    if (e.clientX < zone) snap = 'left';
    else if (e.clientX > rect.width - zone + rect.left) snap = 'right';

    st.snapCandidate = snap;
    FAR.WM._showSnapPreview(snap);
};

FAR.WM._onDragUp = function () {
    const st = FAR.WM.state.dragState;
    document.removeEventListener('mousemove', FAR.WM._onDragMove);
    document.removeEventListener('mouseup',   FAR.WM._onDragUp);
    if (!st) return;
    const win = FAR.WM.getWindow(st.id);
    if (win) win.el.classList.remove('dragging');

    const snap = st.snapCandidate;
    FAR.WM.state.dragState = null;
    FAR.WM._hideSnapPreview();

    if (snap && win) FAR.WM.snapWindow(win.id, snap);
};

FAR.WM._showSnapPreview = function (side) {
    const el = document.getElementById('wmSnapPreview');
    if (!el) return;
    if (!side) {
        el.style.display = 'none';
        return;
    }
    const rect = FAR.WM._getDesktopRect();
    if (side === 'left') {
        el.style.left = '0px';
        el.style.top  = '0px';
        el.style.width  = Math.floor(rect.width / 2) + 'px';
        el.style.height = rect.height + 'px';
    } else {
        el.style.left = Math.floor(rect.width / 2) + 'px';
        el.style.top  = '0px';
        el.style.width  = Math.ceil(rect.width / 2) + 'px';
        el.style.height = rect.height + 'px';
    }
    el.style.display = 'block';
};

FAR.WM._hideSnapPreview = function () {
    const el = document.getElementById('wmSnapPreview');
    if (el) el.style.display = 'none';
};

// ============================================================
// Ресайз
// ============================================================

FAR.WM._startResize = function (e, id, dir) {
    const win = FAR.WM.getWindow(id);
    if (!win || win.maximized) return;
    if (e.button !== 0) return;

    e.preventDefault();
    e.stopPropagation();

    FAR.WM.state.resizeState = {
        id: id,
        dir: dir,
        startX: e.clientX,
        startY: e.clientY,
        origX: win.x, origY: win.y,
        origW: win.w, origH: win.h
    };
    win.el.classList.add('resizing');
    FAR.WM.focusWindow(id);

    document.addEventListener('mousemove', FAR.WM._onResizeMove);
    document.addEventListener('mouseup',   FAR.WM._onResizeUp);
};

FAR.WM._onResizeMove = function (e) {
    const st = FAR.WM.state.resizeState;
    if (!st) return;
    const win = FAR.WM.getWindow(st.id);
    if (!win) return;

    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    const minW = 320, minH = 180;

    let nx = st.origX, ny = st.origY, nw = st.origW, nh = st.origH;

    if (st.dir.includes('e')) nw = Math.max(minW, st.origW + dx);
    if (st.dir.includes('s')) nh = Math.max(minH, st.origH + dy);
    if (st.dir.includes('w')) {
        nw = Math.max(minW, st.origW - dx);
        nx = st.origX + (st.origW - nw);
    }
    if (st.dir.includes('n')) {
        nh = Math.max(minH, st.origH - dy);
        ny = st.origY + (st.origH - nh);
    }

    FAR.WM._applyRect(win, { x: nx, y: ny, w: nw, h: nh });
};

FAR.WM._onResizeUp = function () {
    document.removeEventListener('mousemove', FAR.WM._onResizeMove);
    document.removeEventListener('mouseup',   FAR.WM._onResizeUp);
    const st = FAR.WM.state.resizeState;
    if (st) {
        const win = FAR.WM.getWindow(st.id);
        if (win) win.el.classList.remove('resizing');
    }
    FAR.WM.state.resizeState = null;
};

// ============================================================
// Вспомогательные
// ============================================================

FAR.WM._applyRect = function (win, r) {
    win.x = r.x; win.y = r.y; win.w = r.w; win.h = r.h;
    win.el.style.left   = r.x + 'px';
    win.el.style.top    = r.y + 'px';
    win.el.style.width  = r.w + 'px';
    win.el.style.height = r.h + 'px';

    // Приложение может хотеть перерисоваться
    if (typeof win.props.onResize === 'function') {
        try { win.props.onResize(win, r); } catch (e) {}
    }
};

FAR.WM._getDesktopRect = function () {
    const el = document.getElementById('wmDesktop');
    if (!el) return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight - 48, left: 0, top: 0 };
    const r = el.getBoundingClientRect();
    return {
        x: 0, y: 0,
        left: r.left, top: r.top,
        width: r.width, height: r.height
    };
};

FAR.WM._fillBody = function (bodyEl, content) {
    if (!content) return;
    if (typeof content === 'string') {
        bodyEl.innerHTML = content;
    } else if (content instanceof HTMLElement) {
        bodyEl.appendChild(content);
    }
};

// ============================================================
// Глобальные события (keydown, resize)
// ============================================================

FAR.WM._bound = false;

FAR.WM._bindGlobalEvents = function () {
    if (FAR.WM._bound) return;
    FAR.WM._bound = true;

    // Alt+Tab — переключение окон
    document.addEventListener('keydown', function (e) {
        if (!FAR.WM.state.active) return;

        // Alt+Tab
        if (e.altKey && e.key === 'Tab') {
            e.preventDefault();
            FAR.WM._cycleWindows(e.shiftKey ? -1 : +1);
            return;
        }

        // Alt+F4 — закрыть активное окно
        if (e.altKey && (e.key === 'F4' || e.keyCode === 115)) {
            e.preventDefault();
            if (FAR.WM.state.activeWindowId) {
                FAR.WM.closeWindow(FAR.WM.state.activeWindowId);
            }
            return;
        }

        // Ctrl+Esc — Пуск
        if (e.ctrlKey && e.key === 'Escape') {
            e.preventDefault();
            FAR.WM.toggleStartMenu();
            return;
        }

        // Win+E (эмулируем через Ctrl+Shift+E) — Проводник
        if (e.ctrlKey && e.shiftKey && (e.key === 'E' || e.key === 'e')) {
            e.preventDefault();
            FAR.WM.openApp('explorer');
            return;
        }

        // Win+D (Ctrl+Shift+D) — свернуть все
        if (e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
            e.preventDefault();
            FAR.WM.state.windows.forEach(w => FAR.WM.minimizeWindow(w.id));
            return;
        }

        // Escape — закрыть контекстное меню и Пуск
        if (e.key === 'Escape') {
            FAR.WM._hideContextMenu();
            FAR.WM.closeStartMenu();
        }
    }, true);

    // Ресайз окна браузера — подтянуть развёрнутые окна и снапы
    window.addEventListener('resize', function () {
        if (!FAR.WM.state.active) return;
        const rect = FAR.WM._getDesktopRect();
        FAR.WM.state.windows.forEach(function (w) {
            if (w.maximized) {
                FAR.WM._applyRect(w, { x: 0, y: 0, w: rect.width, h: rect.height });
            } else if (w.snap === 'left') {
                FAR.WM.snapWindow(w.id, 'left');
            } else if (w.snap === 'right') {
                FAR.WM.snapWindow(w.id, 'right');
            }
        });
    });

    // Клик вне меню Пуск и контекстного меню — закрыть
    document.addEventListener('mousedown', function (e) {
        if (!FAR.WM.state.active) return;
        const sm = document.getElementById('wmStartMenu');
        const btn = document.getElementById('wmStartBtn');
        if (sm && sm.classList.contains('open') &&
            !sm.contains(e.target) && !btn.contains(e.target)) {
            FAR.WM.closeStartMenu();
        }
        const cm = document.getElementById('wmContextMenu');
        if (cm && cm.classList.contains('open') && !cm.contains(e.target)) {
            FAR.WM._hideContextMenu();
        }
    }, true);
};

FAR.WM._cycleWindows = function (dir) {
    const list = FAR.WM.state.windows.filter(w => !w.minimized);
    if (list.length < 2) return;
    list.sort((a, b) => (b.zTop || 0) - (a.zTop || 0));
    const curIdx = list.findIndex(w => w.id === FAR.WM.state.activeWindowId);
    let nextIdx = (curIdx + dir + list.length) % list.length;
    FAR.WM.focusWindow(list[nextIdx].id);
};

// ============================================================
// Закрытие всех модалок-оверлеев (перед входом в WM)
// ============================================================

FAR.WM._closeAllModals = function () {
    const closers = [
        'closeViewer', 'closePanoramaViewer', 'closePdfViewer',
        'closeMp3Viewer', 'closeVideoViewer', 'closeJsdosViewer',
        'closeNesViewer', 'closeEmulatorViewer', 'closeDbPicker',
        'closePanoramaEditor', 'closeGamepadSetup', 'closeConnModal'
    ];
    for (const fn of closers) {
        try {
            if (typeof FAR[fn] === 'function') FAR[fn]();
        } catch (e) { /* ignore */ }
    }
    // Прячем все .modal-overlay на всякий случай
    document.querySelectorAll('.modal-overlay').forEach(function (el) {
        el.classList.add('hidden');
    });
};

// ============================================================
// Часы
// ============================================================

FAR.WM._clockTimer = null;

FAR.WM._startClock = function () {
    FAR.WM._stopClock();
    FAR.WM._tickClock();
    FAR.WM._clockTimer = setInterval(FAR.WM._tickClock, 1000);
};

FAR.WM._stopClock = function () {
    if (FAR.WM._clockTimer) {
        clearInterval(FAR.WM._clockTimer);
        FAR.WM._clockTimer = null;
    }
};

FAR.WM._tickClock = function () {
    const el = document.getElementById('wmTrayClock');
    if (!el) return;
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const yy = d.getFullYear();
    el.innerHTML = '<div>' + hh + ':' + mm + '</div>' +
        '<div class="wm-clock-date">' + dd + '.' + mo + '.' + yy + '</div>';
};

FAR.WM.updateTray = function () {
    // БД
    const dbEl = document.getElementById('wmTrayDb');
    if (dbEl) {
        const ctx = FAR.side[FAR.activePanel];
        const txt = ctx && ctx.conn
            ? ctx.conn.db + '@' + (ctx.conn.url || '').replace(/^https?:\/\//, '')
            : '— нет —';
        dbEl.querySelector('span').textContent = txt;
        dbEl.title = 'БД активной панели: ' + txt;
    }
    // Джойстик
    const gpEl = document.getElementById('wmTrayGamepad');
    if (gpEl) {
        const mode = (typeof FAR.getGamepadMode === 'function') ? FAR.getGamepadMode() : 'files';
        const label = (typeof FAR.gamepadModeLabel === 'function')
            ? FAR.gamepadModeLabel(mode) : mode;
        gpEl.querySelector('span').textContent = label;
    }
    // Прогресс
    const prEl = document.getElementById('wmTrayProgress');
    if (prEl) {
        const p = FAR.progress;
        if (p && p.active) {
            prEl.style.display = '';
            const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
            prEl.querySelector('span').textContent = pct + '%';
        } else {
            prEl.style.display = 'none';
        }
    }
};


FAR.WM.getSavedMode = function () {
    try {
        const v = localStorage.getItem(FAR.WM.LS_MODE_KEY);
        if (v === 'wm' || v === 'panel') return v;
    } catch (e) { /* ignore */ }
    return 'panel';
};


FAR.WM.saveMode = function (mode) {
    try {
        if (mode === 'wm' || mode === 'panel') {
            localStorage.setItem(FAR.WM.LS_MODE_KEY, mode);
        }
    } catch (e) { /* ignore */ }
};

FAR.WM.clearMode = function () {
    try { localStorage.removeItem(FAR.WM.LS_MODE_KEY); } catch (e) {}
    try { FAR.WM.clearWindowState(); } catch (e) {}
    try { localStorage.removeItem(FAR.WM.PICKER_LAST_DIR); } catch (e) {}
};

/**
 * Переключает в панельный режим. Вызывается из меню Пуск
 * кнопкой «🗔 Панельный режим».
 */
FAR.WM.exitToPanelMode = function () {
    try { FAR.WM.closeStartMenu(); } catch (e) { /* ignore */ }
    FAR.WM.saveMode('panel');
    if (FAR.WM.state.active) {
        FAR.WM.exit();
    }
    FAR.toast('Режим: панельный', 'info');
};

/**
 * Приводит props окна к сериализуемому виду.
 * Сохраняем минимум: side + метаданные файла (без blob,
 * без ссылок на DOM/fileIndex).
 */
FAR.WM._serializableProps = function (props) {
    const out = {};
    if (!props) return out;

    if (props.side === 'left' || props.side === 'right') {
        out.side = props.side;
    }

    if (props.file && typeof props.file === 'object') {
        out.file = {
            _id: props.file._id || '',
            name: props.file.name || '',
            path: props.file.path || '',
            size: props.file.size || 0,
            isFolder: !!props.file.isFolder,
            docType: props.file.docType || 'file',
            binary: !!props.file.binary,
            contentType: props.file.contentType || '',
            children: Array.isArray(props.file.children) ? props.file.children.slice() : []
        };
    }

    if (props.filter) out.filter = String(props.filter);

    return out;
};

/**
 * Сериализует одно окно. Возвращает null, если окно
 * сохранять не нужно.
 */
FAR.WM._serializeWindow = function (win) {
    if (!win || !win.appId) return null;
    if (win.modalParent) return null;
    if (FAR.WM._SKIP_RESTORE_APPS[win.appId]) return null;

    return {
        appId: win.appId,
        title: win.title || '',
        icon: win.icon || '🪟',
        x: win.x,
        y: win.y,
        w: win.w,
        h: win.h,
        minimized: !!win.minimized,
        maximized: !!win.maximized,
        snap: win.snap || null,
        zTop: win.zTop || 0,
        props: FAR.WM._serializableProps(win.props)
    };
};

/**
 * Синхронно сохраняет текущее состояние всех окон.
 */
FAR.WM._saveWindowState = function () {
    try {
        const snaps = [];
        FAR.WM.state.windows.forEach(function (w) {
            const s = FAR.WM._serializeWindow(w);
            if (s) snaps.push(s);
        });
        localStorage.setItem(FAR.WM.LS_WINDOWS_KEY, JSON.stringify(snaps));
    } catch (e) { /* ignore */ }
};

/**
 * Debounce-версия: не чаще одного сохранения в 200 мс.
 * Используется при drag/resize/focus, чтобы не спамить
 * localStorage на каждое движение мыши.
 */
FAR.WM._saveWindowStateTimer = null;
FAR.WM._saveWindowStateDebounced = function () {
    if (FAR.WM._saveWindowStateTimer) return;
    FAR.WM._saveWindowStateTimer = setTimeout(function () {
        FAR.WM._saveWindowStateTimer = null;
        FAR.WM._saveWindowState();
    }, 200);
};

/**
 * Читает состояние окон из localStorage.
 * Возвращает:
 *   • null — ключа нет (первый запуск)
 *   • []   — ключ есть, окон не было
 *   • [snap,...] — список сохранённых окон
 */
FAR.WM._loadWindowState = function () {
    try {
        const raw = localStorage.getItem(FAR.WM.LS_WINDOWS_KEY);
        if (raw === null) return null;
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) return null;
        return arr;
    } catch (e) {
        return null;
    }
};

/**
 * Полностью очищает сохранённое состояние окон.
 * Вызывается при LogOut.
 */
FAR.WM.clearWindowState = function () {
    try { localStorage.removeItem(FAR.WM.LS_WINDOWS_KEY); } catch (e) {}
};

/**
 * Восстанавливает окна из localStorage.
 *
 * Алгоритм:
 *   1. Читаем сохранённый список.
 *   2. Если ключа нет — это первый вход, открываем Проводник.
 *   3. Если ключ есть и пуст — ничего не открываем.
 *   4. Если есть окна — восстанавливаем по одному в порядке
 *      возрастания zTop (сначала нижние, потом верхние),
 *      применяем геометрию, флаги и фокусируем последнее.
 *
 * Порядок восстановления последовательный (await), чтобы
 * не было параллельных загрузок одного и того же.
 */
FAR.WM._restoreWindows = async function () {
    const snaps = FAR.WM._loadWindowState();

    // Первый запуск в WM — открываем Проводник (дефолт)
    if (snaps === null) {
        FAR.WM.openApp('explorer');
        return;
    }

    // Пользователь закрыл все окна ранее — оставляем пустой стол
    if (snaps.length === 0) {
        return;
    }

    // Сортируем по zTop: снизу вверх. Последнее будет сверху.
    snaps.sort(function (a, b) {
        return (a.zTop || 0) - (b.zTop || 0);
    });

    // Флаг, чтобы избежать промежуточных сохранений
    FAR.WM._restoring = true;

    for (const snap of snaps) {
        try {
            // ---- Резолвим item файла из сохранённых метаданных ----
            const props = Object.assign({}, snap.props || {});
            if (props.file && props.file._id && props.side) {
                const ctx = FAR.side[props.side];
                if (ctx && Array.isArray(ctx.fileIndex)) {
                    const found = ctx.fileIndex.find(function (f) {
                        return f && f._id === props.file._id;
                    });
                    if (found) {
                        // Используем «живой» элемент панели
                        props.file = found;
                    }
                }
            }

            // ---- Открываем приложение ----
            const win = await FAR.WM.openApp(snap.appId, {
                props: props,
                x: snap.x,
                y: snap.y,
                width: snap.w,
                height: snap.h,
                title: snap.title || undefined,
                _restoring: true
            });

            if (!win) continue;

            // ---- Применяем флаги ----
            if (snap.maximized) {
                FAR.WM.toggleMaximize(win.id);
            } else if (snap.snap === 'left' || snap.snap === 'right') {
                FAR.WM.snapWindow(win.id, snap.snap);
            }
            if (snap.minimized) {
                FAR.WM.minimizeWindow(win.id);
            }

            // Восстанавливаем zTop (приблизительно — точный
            // порядок обеспечим через focusWindow ниже)
            if (snap.zTop) win.zTop = snap.zTop;
        } catch (e) {
            console.warn('[WM restore] failed:', snap.appId, e);
        }
    }

    FAR.WM._restoring = false;

    // После восстановления — сохраняем ещё раз (актуализируем),
    // но не дёргаем debounce, чтобы не было лишних срабатываний
    FAR.WM._saveWindowState();
};
FAR.WM.focusWindow = function (id) {
    const win = FAR.WM.getWindow(id);
    if (!win) return;

    // Никакое другое окно не должно быть «выше» модального родителя
    if (win.modalParent) {
        const parent = FAR.WM.getWindow(win.modalParent);
        if (parent) {
            FAR.WM.state.zTop++;
            parent.el.style.zIndex = FAR.WM.state.zTop;
        }
    }

    FAR.WM.state.zTop++;
    win.el.style.zIndex = FAR.WM.state.zTop;
    win.zTop = FAR.WM.state.zTop;

    FAR.WM.state.windows.forEach(function (w) {
        w.el.classList.toggle('focused', w.id === id);
    });

    if (win.minimized) {
        win.minimized = false;
        win.el.classList.remove('minimized');
    }

    FAR.WM.state.activeWindowId = id;
    FAR.WM._renderTaskbar();

    // Синхронизация активной панели с окном Проводника.
    if (win.appId === 'explorer' && win.props && win.props.side) {
        FAR.activePanel = win.props.side;
        try {
            const pl = document.getElementById('panelLeft');
            const pr = document.getElementById('panelRight');
            if (pl && pr) {
                pl.classList.toggle('active', FAR.activePanel === 'left');
                pr.classList.toggle('active', FAR.activePanel === 'right');
            }
        } catch (e) { /* ignore */ }
    }

    if (typeof win.props.onFocus === 'function') {
        try { win.props.onFocus(win); } catch (e) {}
    }

    // Сохраняем состояние (debounce)
    FAR.WM._saveWindowStateDebounced();
};
FAR.WM.minimizeWindow = function (id) {
    const win = FAR.WM.getWindow(id);
    if (!win) return;
    win.minimized = true;
    win.el.classList.add('minimized');

    if (FAR.WM.state.activeWindowId === id) {
        const next = FAR.WM.state.windows
            .filter(w => !w.minimized)
            .sort((a, b) => (b.zTop || 0) - (a.zTop || 0))[0];
        FAR.WM.state.activeWindowId = next ? next.id : null;
        if (next) FAR.WM.focusWindow(next.id);
    }
    FAR.WM._renderTaskbar();
    FAR.WM._saveWindowStateDebounced();
};
FAR.WM.restoreWindow = function (id) {
    const win = FAR.WM.getWindow(id);
    if (!win) return;
    win.minimized = false;
    win.el.classList.remove('minimized');
    FAR.WM.focusWindow(id);
    FAR.WM._saveWindowStateDebounced();
};

FAR.WM.toggleMaximize = function (id) {
    const win = FAR.WM.getWindow(id);
    if (!win) return;

    if (win.maximized) {
        const r = win.prevRect || { x: 100, y: 100, w: 800, h: 600 };
        FAR.WM._applyRect(win, r);
        win.el.classList.remove('maximized');
        win.maximized = false;
    } else {
        win.prevRect = { x: win.x, y: win.y, w: win.w, h: win.h };
        const rect = FAR.WM._getDesktopRect();
        FAR.WM._applyRect(win, { x: 0, y: 0, w: rect.width, h: rect.height });
        win.el.classList.add('maximized');
        win.maximized = true;
    }
    FAR.WM.focusWindow(id);
    FAR.WM._saveWindowStateDebounced();
};

FAR.WM.snapWindow = function (id, side) {
    const win = FAR.WM.getWindow(id);
    if (!win) return;

    if (side === 'restore') {
        const r = win.prevRect || { x: 100, y: 100, w: 800, h: 600 };
        FAR.WM._applyRect(win, r);
        win.el.classList.remove('snapped-left', 'snapped-right');
        win.snap = null;
        FAR.WM._saveWindowStateDebounced();
        return;
    }

    if (!win.snap) {
        win.prevRect = { x: win.x, y: win.y, w: win.w, h: win.h };
    }
    const rect = FAR.WM._getDesktopRect();
    if (side === 'left') {
        FAR.WM._applyRect(win, { x: 0, y: 0, w: Math.floor(rect.width / 2), h: rect.height });
        win.el.classList.add('snapped-left');
        win.el.classList.remove('snapped-right');
        win.snap = 'left';
    } else if (side === 'right') {
        FAR.WM._applyRect(win, { x: Math.floor(rect.width / 2), y: 0,
            w: Math.ceil(rect.width / 2), h: rect.height });
        win.el.classList.add('snapped-right');
        win.el.classList.remove('snapped-left');
        win.snap = 'right';
    }
    FAR.WM.focusWindow(id);
    FAR.WM._saveWindowStateDebounced();
};

FAR.WM._applyRect = function (win, r) {
    win.x = r.x; win.y = r.y; win.w = r.w; win.h = r.h;
    win.el.style.left   = r.x + 'px';
    win.el.style.top    = r.y + 'px';
    win.el.style.width  = r.w + 'px';
    win.el.style.height = r.h + 'px';

    if (typeof win.props.onResize === 'function') {
        try { win.props.onResize(win, r); } catch (e) {}
    }

    // Debounce-сохранение (drag/resize двигают много раз)
    FAR.WM._saveWindowStateDebounced();
};


// Сохраняем состояние окон при выгрузке страницы,
// чтобы debounce не «потерял» последнее изменение.
window.addEventListener('beforeunload', function () {
    if (FAR.WM.state.active) {
        FAR.WM._saveWindowState();
    }
});

FAR.WM.getWindow = function (id) {
    return FAR.WM.state.windows.find(function (w) {
        return w.id === id;
    }) || null;
};

FAR.WM.getActiveWindow = function () {
    return FAR.WM.getWindow(FAR.WM.state.activeWindowId);
};