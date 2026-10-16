// ============================================================
// 47-fullscreen.js — управление полноэкранным режимом
// ============================================================
//
// Возможности:
//   • кнопка «⛶ Fullscreen» в тулбаре (панельный режим);
//   • кнопка «⛶ Fullscreen» в трее панели задач (оконный режим);
//   • F11 — переключатель;
//   • автоматическая попытка войти в fullscreen при входе
//     в оконный режим (клик по «🖥 Рабочий стол» — это
//     user gesture, браузер разрешит);
//   • после перезагрузки, если пользователь ранее был
//     в fullscreen — восстановление при ПЕРВОМ user gesture
//     (клик / keydown / touchstart), т.к. браузеры не
//     разрешают requestFullscreen() без жеста.
//
// Флаг «желаю fullscreen» (localStorage: filebd_fullscreen)
// НЕ сбрасывается при выходе по Esc. Это сделано специально:
// если пользователь случайно нажал Esc и перезагрузил
// страницу — fullscreen восстановится при первом клике.

FAR.FS = FAR.FS || {};

FAR.FS.LS_KEY = 'filebd_fullscreen';

// ------------------------------------------------------------
// Утилиты определения поддержки
// ------------------------------------------------------------

FAR.FS._isSupported = function () {
    return !!(
        document.fullscreenEnabled ||
        document.webkitFullscreenEnabled ||
        document.mozFullScreenEnabled ||
        document.msFullscreenEnabled
    );
};

FAR.FS._isActive = function () {
    return !!(
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement
    );
};

FAR.FS._request = function (el) {
    el = el || document.documentElement;
    if (el.requestFullscreen) return el.requestFullscreen();
    if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
    if (el.mozRequestFullScreen) return el.mozRequestFullScreen();
    if (el.msRequestFullscreen) return el.msRequestFullscreen();
    return Promise.reject(new Error('Fullscreen API не поддерживается'));
};

FAR.FS._exit = function () {
    if (document.exitFullscreen) return document.exitFullscreen();
    if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
    if (document.mozCancelFullScreen) return document.mozCancelFullScreen();
    if (document.msExitFullscreen) return document.msExitFullscreen();
    return Promise.reject(new Error('Fullscreen API не поддерживается'));
};

// ------------------------------------------------------------
// Публичное API
// ------------------------------------------------------------

FAR.FS.enter = async function () {
    if (!FAR.FS._isSupported()) return false;
    if (FAR.FS._isActive()) return true;
    try {
        await FAR.FS._request();
        return true;
    } catch (e) {
        // NotAllowedError — браузер не увидел user gesture.
        // Это нормально при автозапуске. Молчим.
        if (!e || e.name !== 'NotAllowedError') {
            console.warn('[FS] enter failed:', e && e.name, e && e.message);
        }
        return false;
    }
};

FAR.FS.exit = async function () {
    if (!FAR.FS._isActive()) return true;
    FAR.FS._saveWanted(false);   // ← добавить
    try {
        await FAR.FS._exit();
        return true;
    } catch (e) {
        console.warn('[FS] exit failed:', e);
        return false;
    }
};

FAR.FS.toggle = async function () {
    if (FAR.FS._isActive()) return FAR.FS.exit();
    return FAR.FS.enter();
};

// ------------------------------------------------------------
// Сохранение желания пользователя
// ------------------------------------------------------------

FAR.FS._saveWanted = function (flag) {
    try {
        if (flag) localStorage.setItem(FAR.FS.LS_KEY, '1');
        else localStorage.removeItem(FAR.FS.LS_KEY);
    } catch (e) {}
};

FAR.FS._loadWanted = function () {
    try { return localStorage.getItem(FAR.FS.LS_KEY) === '1'; }
    catch (e) { return false; }
};

// ------------------------------------------------------------
// Слежение за состоянием
// ------------------------------------------------------------
//
// ВАЖНО: НЕ сбрасываем флаг при выходе из fullscreen.
// Флаг = «пользователь хочет fullscreen при перезагрузке».
// Он ставится при успешном входе и больше не сбрасывается
// автоматически. Снимается только явным действием —
// например, выключением через toggle() (см. ниже).

FAR.FS._watchState = function () {
    const onChange = function () {
        if (FAR.FS._isActive()) {
            FAR.FS._saveWanted(true);
        }
        FAR.FS._updateAllButtons();
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    document.addEventListener('mozfullscreenchange', onChange);
    document.addEventListener('MSFullscreenChange', onChange);
};

// ------------------------------------------------------------
// Автовосстановление после перезагрузки
// ------------------------------------------------------------
//
// Если флаг стоит, а fullscreen не активен — ждём ПЕРВОГО
// user gesture (клик / keydown / touchstart) и пробуем
// войти. Как только вошли — снимаем все обработчики.

FAR.FS._installAutoRestore = function () {
    if (!FAR.FS._loadWanted()) return;
    if (FAR.FS._isActive()) return;
    if (!FAR.FS._isSupported()) return;

    const removeHandlers = function () {
        document.removeEventListener('click', handler, true);
        document.removeEventListener('keydown', handler, true);
        document.removeEventListener('touchstart', handler, true);
        document.removeEventListener('pointerdown', handler, true);
    };

    const handler = async function (e) {
        // Не перехватываем, если фокус в поле ввода
        const t = e.target;
        const tag = (t && t.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) {
            return;
        }

        const ok = await FAR.FS.enter();
        if (ok) {
            removeHandlers();
        }
    };

    document.addEventListener('click', handler, true);
    document.addEventListener('keydown', handler, true);
    document.addEventListener('touchstart', handler, true);
    document.addEventListener('pointerdown', handler, true);
};

// ------------------------------------------------------------
// Обновление текста на всех кнопках
// ------------------------------------------------------------

FAR.FS._updateAllButtons = function () {
    const isFs = FAR.FS._isActive();

    // --- Кнопка в тулбаре ---
    const tbBtn = document.getElementById('btnFullscreen');
    if (tbBtn) {
        tbBtn.textContent = isFs ? '⛶ Exit Fullscreen' : '⛶ Fullscreen';
        tbBtn.title = isFs
            ? 'Выйти из полноэкранного режима (F11)'
            : 'Войти в полноэкранный режим (F11)';
    }

    // --- Кнопка в трее WM ---
    const trayEl = document.getElementById('wmTrayFullscreen');
    if (trayEl) {
        const spanEl = trayEl.querySelector('span');
        if (spanEl) spanEl.textContent = isFs ? 'On' : 'Off';
        trayEl.title = isFs
            ? 'Выйти из полноэкранного режима (F11)'
            : 'Войти в полноэкранный режим (F11)';
        trayEl.style.cursor = 'pointer';
    }
};

// ------------------------------------------------------------
// Кнопка в тулбаре
// ------------------------------------------------------------

FAR.FS.installToolbarButton = function () {
    const toolbar = document.querySelector('.toolbar');
    if (!toolbar) return;
    if (document.getElementById('btnFullscreen')) {
        FAR.FS._updateAllButtons();
        return;
    }

    const btn = document.createElement('button');
    btn.id = 'btnFullscreen';
    btn.type = 'button';
    btn.title = 'Полноэкранный режим (F11)';
    btn.textContent = '⛶ Fullscreen';
    btn.addEventListener('click', function () {
        FAR.FS.toggle();
    });

    const authBtn = document.getElementById('btnAuth');
    if (authBtn && authBtn.parentNode === toolbar) {
        toolbar.insertBefore(btn, authBtn);
    } else {
        toolbar.appendChild(btn);
    }
    FAR.FS._updateAllButtons();
};

// ------------------------------------------------------------
// Кнопка в трее WM
// ------------------------------------------------------------

FAR.FS.installWmTrayButton = function () {
    const trayEl = document.getElementById('wmTrayFullscreen');
    if (!trayEl) return;
    if (trayEl._farFsBound) {
        FAR.FS._updateAllButtons();
        return;
    }
    trayEl._farFsBound = true;

    trayEl.style.cursor = 'pointer';
    trayEl.addEventListener('click', function (e) {
        e.stopPropagation();
        FAR.FS.toggle();
    });

    FAR.FS._updateAllButtons();
};

// ------------------------------------------------------------
// F11 — переключатель
// ------------------------------------------------------------

document.addEventListener('keydown', function (e) {
    if (e.key === 'F11') {
        e.preventDefault();
        e.stopPropagation();
        FAR.FS.toggle();
    }
}, true);

// ------------------------------------------------------------
// Обёртка над FAR.WM.enter: при входе в оконный режим
// сразу пробуем включить fullscreen. Пользователь только
// что кликнул — это user gesture.
// ------------------------------------------------------------

(function wrapWMEnter() {
    if (typeof FAR.WM === 'undefined' || typeof FAR.WM.enter !== 'function') {
        // WM.enter появится позже — попробуем через таймер.
        setTimeout(wrapWMEnter, 50);
        return;
    }
    if (FAR.WM._fsWrapped) return;
    FAR.WM._fsWrapped = true;

    const origEnter = FAR.WM.enter;
    FAR.WM.enter = function () {
        const r = origEnter.apply(this, arguments);

        // Пытаемся войти в fullscreen. Внутри setTimeout —
        // уже не user gesture, но попытка бесплатная. Если
        // не получится — сработает _installAutoRestore при
        // первом клике.
        try { FAR.FS.enter().catch(function () {}); } catch (e) {}

        // Устанавливаем кнопку в трее при входе в WM
        setTimeout(function () {
            FAR.FS.installWmTrayButton();
            FAR.FS._updateAllButtons();
        }, 50);

        return r;
    };
})();

// ------------------------------------------------------------
// Восстановление при загрузке страницы
// ------------------------------------------------------------

FAR.FS.init = function () {
    FAR.FS._watchState();
    FAR.FS._installAutoRestore();
    FAR.FS._updateAllButtons();
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
        FAR.FS.init();
        FAR.FS.installToolbarButton();
        FAR.FS.installWmTrayButton();
    });
} else {
    FAR.FS.init();
    FAR.FS.installToolbarButton();
    FAR.FS.installWmTrayButton();
}