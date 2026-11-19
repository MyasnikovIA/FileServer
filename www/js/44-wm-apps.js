// ============================================================
// 44-wm-apps.js — реестр приложений
// ============================================================

FAR.WM._apps = {};

FAR.WM.registerApp = function (def) {
    FAR.WM._apps[def.id] = def;
};

FAR.WM.getApps = function () {
    return Object.values(FAR.WM._apps);
};

FAR.WM.getApp = function (id) {
    return FAR.WM._apps[id] || null;
};

FAR.WM.openApp = async function (appId, opts) {
    opts = opts || {};
    const def = FAR.WM.getApp(appId);
    if (!def) {
        FAR.toast('Приложение не найдено: ' + appId, 'error');
        return null;
    }

    if (def.singleton && !opts.forceNew && !opts._restoring) {
        const existing = FAR.WM.state.windows.find(function (w) {
            return w.appId === appId;
        });
        if (existing) {
            FAR.WM.restoreWindow(existing.id);
            FAR.WM.focusWindow(existing.id);

            if (typeof def.onReopen === 'function' && opts.props) {
                try {
                    def.onReopen(existing, opts.props);
                } catch (e) {
                    console.warn('[WM app onReopen]', appId, e);
                }
            }
            return existing;
        }
    }

    const title = opts.title || def.title;
    const icon  = def.icon || '📦';

    const win = FAR.WM.openWindow({
        title: title,
        icon: icon,
        width: opts.width || def.width || 900,
        height: opts.height || def.height || 600,
        x: opts.x, y: opts.y,
        appId: appId,
        content: null,
        props: Object.assign({}, def.defaultProps || {}, opts.props || {}),
        onClose: function (w) {
            if (typeof def.onClose === 'function') {
                try { def.onClose(w); } catch (e) { console.warn('[WM app onClose]', e); }
            }
        }
    });

    try {
        await def.open(win, win.props);
    } catch (e) {
        console.error('[WM app open]', appId, e);
        win.bodyEl.innerHTML =
            '<div style="padding: 24px; color: #f38ba8;">Ошибка открытия: ' +
            FAR.escapeHtml(e.message) + '</div>';
    }

    return win;
};

// ============================================================
// Переиспользование окна при навигации ◀ / ▶
// ============================================================
//
// Используется из 47-wm-viewers.js (_installViewerNavButtons) и
// из 11-viewer.js (FAR.viewerNavigate). Позволяет переключать
// файлы в одном и том же окне, СОХРАНЯЯ его позицию, размер,
// maximized-флаг, minimized-флаг, className и фокус.
//
// Раньше кнопки ◀/▶ в titlebar вызывали closeWindow + openFile,
// что приводило к созданию НОВОГО окна с дефолтным размером
// в исходной позиции. Это главная причина «прыгающего» окна.

/**
 * Найти WM-окно, в котором открыт указанный файл.
 */
FAR.WM._findWindowForFile = function (item, side) {
    if (!item || !FAR.WM.state || !FAR.WM.state.windows) return null;

    const itemPath = FAR.normPath(item.path || '');
    const itemId   = item._id || '';

    for (const win of FAR.WM.state.windows) {
        if (!win.props || !win.props.file) continue;
        if (side && win.props.side && win.props.side !== side) continue;

        const f = win.props.file;
        const winId   = f._id   || '';
        const winPath = FAR.normPath(f.path || '');

        if (itemId && winId && itemId === winId) return win;
        if (itemPath && winPath && itemPath === winPath) return win;
    }
    return null;
};

/**
 * Определить, какое WM-приложение должно открыть указанный файл.
 */
FAR.WM._detectAppForItem = async function (item, side) {
    if (!item) return null;

    if (typeof FAR.WM.isFbmp3 === 'function' && FAR.WM.isFbmp3(item)) return 'mp3';
    if (typeof FAR.isJsdos === 'function' && FAR.isJsdos(item)) return 'jsdos';
    if (typeof FAR.isEmulatorFile === 'function' && FAR.isEmulatorFile(item)) return 'emulator';
    if (typeof FAR.isMp3 === 'function' && FAR.isMp3(item)) return 'mp3';
    if (typeof FAR.isVideo === 'function' && FAR.isVideo(item)) return 'video';
    if (typeof FAR.isPdf === 'function' && FAR.isPdf(item)) return 'pdf';
    if (typeof FAR.isLbrn2 === 'function' && FAR.isLbrn2(item)) return 'lbrn2';
    if (typeof FAR.isGcode === 'function' && FAR.isGcode(item)) return 'gcode';

    if (typeof FAR.isHtmlFile === 'function' && FAR.isHtmlFile(item)) return null;

    if (typeof FAR.isPanorama === 'function') {
        let isPano = false;
        try { isPano = await FAR.isPanorama(item, side); } catch (e) {}
        if (isPano) return 'panorama';
    }

    if (typeof FAR.isTextFile === 'function' && FAR.isTextFile(item)) return 'texteditor';

    return 'viewer';
};

/**
 * Переоткрыть приложение внутри СУЩЕСТВУЮЩЕГО окна.
 *
 * Сохраняет:
 *   • позицию (left/top) — точные inline-стили
 *   • размер (width/height) — точные inline-стили
 *   • maximized / minimized / snapped-* — className
 *   • focused
 *   • порядок в taskbar
 *
 * Меняет только:
 *   • appId (если тип файла сменился — например panorama → video)
 *   • win.props
 *   • содержимое win.bodyEl
 *   • заголовок и иконку — если сменилось приложение
 *
 * ВАЖНО: НЕ вызываем FAR.WM.maximizeWindow() повторно —
 * не знаем, идемпотентна ли она. Вместо этого сохраняем
 * className и inline-стили целиком и восстанавливаем их после
 * монтирования. Это гарантирует, что окно останется ровно там
 * и с тем же размером, где пользователь его оставил.
 */
FAR.WM._reopenAppInWindow = async function (win, newProps) {
    if (!win) throw new Error('_reopenAppInWindow: win required');
    newProps = newProps || {};

    // === 1. Снимок состояния окна ДО любых манипуляций ===
    const saved = {
        left:      win.el.style.left       || '',
        top:       win.el.style.top        || '',
        width:     win.el.style.width      || '',
        height:    win.el.style.height     || '',
        right:     win.el.style.right      || '',
        bottom:    win.el.style.bottom     || '',
        transform: win.el.style.transform  || '',
        className: win.el.className,
        maximized: !!win.maximized,
        minimized: !!win.minimized,
        focused:   (FAR.WM.state && FAR.WM.state.activeWindowId === win.id)
    };

    const oldAppId = win.appId;

    // === 2. Какое приложение должно открыть новый файл? ===
    let targetAppId = oldAppId;
    if (newProps.file) {
        try {
            const detected = await FAR.WM._detectAppForItem(newProps.file, newProps.side);
            if (detected) targetAppId = detected;
        } catch (e) {
            console.warn('[WM _reopenAppInWindow] detect app failed:', e);
        }
    }

    const oldDef = FAR.WM.getApp(oldAppId);
    const newDef = FAR.WM.getApp(targetAppId);
    if (!newDef) {
        throw new Error('App not found: ' + targetAppId);
    }

    // === 3. Cleanup старого содержимого (Pannellum, audio, blob URLs) ===
    if (oldDef && typeof oldDef.onClose === 'function') {
        try {
            oldDef.onClose(win);
        } catch (e) {
            console.warn('[WM _reopenAppInWindow] onClose:', e);
        }
    }

    // === 4. Очищаем body, обновляем appId и props ===
    win.bodyEl.innerHTML = '';
    win.appId = targetAppId;
    win.props = Object.assign({}, newDef.defaultProps || {}, newProps);

    // === 5. Если приложение изменилось — обновляем заголовок/иконку ===
    if (targetAppId !== oldAppId) {
        win.title = newDef.title;
        const titleText = win.el.querySelector('.wm-title-text');
        if (titleText) titleText.textContent = win.title;
        const titleIcon = win.el.querySelector('.wm-title-icon');
        if (titleIcon) titleIcon.textContent = newDef.icon || '📦';

        if (typeof FAR.WM._renderTaskbar === 'function') {
            try { FAR.WM._renderTaskbar(); } catch (e) {}
        }
    }

    // === 6. Монтируем новое содержимое ===
    await newDef.open(win, win.props);

    // === 7. ВОССТАНАВЛИВАЕМ снимок окна ===
    // (после open — на случай, если какой-нибудь монтер
    //  случайно перезаписал inline-стили или classList)
    win.el.className = saved.className;

    if (saved.left)      win.el.style.left      = saved.left;      else win.el.style.left      = '';
    if (saved.top)       win.el.style.top       = saved.top;       else win.el.style.top       = '';
    if (saved.width)     win.el.style.width     = saved.width;     else win.el.style.width     = '';
    if (saved.height)    win.el.style.height    = saved.height;    else win.el.style.height    = '';
    if (saved.right)     win.el.style.right     = saved.right;     else win.el.style.right     = '';
    if (saved.bottom)    win.el.style.bottom    = saved.bottom;    else win.el.style.bottom    = '';
    if (saved.transform) win.el.style.transform = saved.transform; else win.el.style.transform = '';

    win.maximized = saved.maximized;
    win.minimized = saved.minimized;

    // === 8. Фокус ===
    if (saved.focused && typeof FAR.WM.focusWindow === 'function') {
        try { FAR.WM.focusWindow(win.id); } catch (e) {}
    } else if (typeof FAR.WM.focusWindow === 'function') {
        try { FAR.WM.focusWindow(win.id); } catch (e) {}
    }

    return win;
};

// ============================================================
// Приложение: Проводник FileBD
// ============================================================

FAR.WM.registerApp({
    id: 'explorer',
    title: 'Проводник FileBD',
    icon: '📁',
    keywords: 'проводник файлы папки explorer',
    singleton: false,
    width: 1100,
    height: 700,
    open: async function (win, props) {
        await FAR.WM._mountExplorerPanel(win, props);
    },
    onClose: function (win) {
        FAR.WM._cleanupExplorerPanel(win);
    }
});

// ============================================================
// Приложение: Текстовый редактор (Notepad++)
// ============================================================

FAR.WM.registerApp({
    id: 'texteditor',
    title: 'Текстовый редактор',
    icon: '📝',
    keywords: 'текст редактор notepad код code',
    singleton: false,
    width: 900,
    height: 650,
    open: async function (win, props) {
        await FAR.WM._mountTextEditor(win, props);
    },
    onClose: function (win) {
        // Очистка при необходимости
    }
});

// ============================================================
// Приложение: Браузер (внутри WM-окна)
// ============================================================

FAR.WM.registerApp({
    id: 'browser',
    title: 'Браузер',
    icon: '🌐',
    keywords: 'браузер browser web iframe html',
    singleton: false,
    width: 1100,
    height: 720,
    open: async function (win, props) {
        await FAR.WM._mountBrowserViewer(win, props);
    },
    onClose: function (win) {
        if (win.props && win.props._browserApi) {
            try { win.props._browserApi.destroy(); } catch (e) {}
            win.props._browserApi = null;
        }
    }
});

// ============================================================
// Приложение: Универсальный просмотрщик
// ============================================================

FAR.WM.registerApp({
    id: 'viewer',
    title: 'Просмотрщик',
    icon: '👁',
    keywords: 'просмотр файл изображение текст viewer',
    singleton: false,
    width: 900,
    height: 640,
    open: async function (win, props) {
        if (props && props.file) {
            await FAR.WM._mountFileViewer(win, props);
        } else {
            FAR.WM._mountFilePickerPrompt(win, 'Выберите файл для просмотра');
        }
    },
    onClose: function (win) { FAR.WM._finalizeViewer(win); }
});

// ============================================================
// Приложение: Панорама
// ============================================================

FAR.WM.registerApp({
    id: 'panorama',
    title: 'Панорама 360°',
    icon: '🌐',
    keywords: 'панорама 360 panorama',
    singleton: false,
    width: 1100,
    height: 720,
    open: async function (win, props) {
        if (props && props.file) {
            await FAR.WM._mountPanoramaViewer(win, props);
        } else {
            FAR.WM._mountFilePickerPrompt(win, 'Выберите панораму (jpg/png)');
        }
    },
    onClose: function (win) { FAR.WM._finalizeViewer(win); }
});

// ============================================================
// Приложение: Редактор панорам
// ============================================================

FAR.WM.registerApp({
    id: 'panoeditor',
    title: 'Редактор панорам',
    icon: '✏️',
    keywords: 'редактор панорама точки hotspots',
    singleton: true,
    width: 1300,
    height: 800,
    open: async function (win) {
        FAR.WM._mountNotice(win, '✏️',
            'Редактор точек перехода открывается из просмотрщика панорам ' +
            'кнопкой «✏️ Редактор точек» или двойным кликом по панораме.');
    }
});

// ============================================================
// Приложение: PDF
// ============================================================

FAR.WM.registerApp({
    id: 'pdf',
    title: 'PDF',
    icon: '📄',
    keywords: 'pdf документ',
    singleton: false,
    width: 1000,
    height: 720,
    open: async function (win, props) {
        if (props && props.file) {
            await FAR.WM._mountPdfViewer(win, props);
        } else {
            FAR.WM._mountFilePickerPrompt(win, 'Выберите PDF-файл');
        }
    },
    onClose: function (win) { FAR.WM._finalizeViewer(win); }
});

// ============================================================
// Приложение: MP3
// ============================================================

FAR.WM.registerApp({
    id: 'mp3',
    title: 'MP3-плеер',
    icon: '🎵',
    keywords: 'музыка mp3 audio плеер',
    singleton: true,
    width: 900,
    height: 620,
    open: async function (win, props) {
        if (props && props.file) {
            await FAR.WM._mountMp3Viewer(win, props);
        } else {
            FAR.WM._mountFilePickerPrompt(win, 'Выберите аудиофайл');
        }
    },
    onClose: function (win) { FAR.WM._finalizeViewer(win); }
});

// ============================================================
// Приложение: Видео
// ============================================================

FAR.WM.registerApp({
    id: 'video',
    title: 'Видео',
    icon: '🎬',
    keywords: 'видео фильм movie video',
    singleton: true,
    width: 1100,
    height: 700,
    open: async function (win, props) {
        if (props && props.file) {
            await FAR.WM._mountVideoViewer(win, props);
        } else {
            FAR.WM._mountFilePickerPrompt(win, 'Выберите видеофайл');
        }
    },
    onClose: function (win) { FAR.WM._finalizeViewer(win); }
});

// ============================================================
// Приложение: JSDOS
// ============================================================

FAR.WM.registerApp({
    id: 'jsdos',
    title: 'JSDOS',
    icon: '🕹️',
    keywords: 'jsdos dos игра game',
    singleton: false,
    width: 900,
    height: 700,
    open: async function (win, props) {
        if (props && props.file) {
            await FAR.WM._mountJsdosViewer(win, props);
        } else {
            FAR.WM._mountFilePickerPrompt(win, 'Выберите .jsdos-архив');
        }
    },
    onClose: function (win) { FAR.WM._finalizeViewer(win); }
});

// ПРИЛОЖЕНИЕ NES УДАЛЕНО

// ============================================================
// Приложение: EmulatorJS
// ============================================================

FAR.WM.registerApp({
    id: 'emulator',
    title: 'EmulatorJS',
    icon: '🕹️',
    keywords: 'эмулятор snes n64 psx gba sega nes dendy',
    singleton: false,
    width: 1000,
    height: 720,
    open: async function (win, props) {
        if (props && props.file) {
            await FAR.WM._mountEmulatorViewer(win, props);
        } else {
            FAR.WM._mountFilePickerPrompt(win, 'Выберите ROM-файл');
        }
    },
    onClose: function (win) { FAR.WM._finalizeViewer(win); }
});

// ============================================================
// Приложение: Подключение
// ============================================================

FAR.WM.registerApp({
    id: 'connect',
    title: 'Подключение к БД',
    icon: '🔐',
    keywords: 'подключение база login conn',
    singleton: true,
    width: 460,
    height: 460,
    open: async function (win) {
        FAR.WM._mountConnectionUI(win);
    }
});

// ============================================================
// Приложение: Настройка джойстика
// ============================================================

FAR.WM.registerApp({
    id: 'gamepad',
    title: 'Настройка джойстика',
    icon: '🎮',
    keywords: 'джойстик gamepad геймпад',
    singleton: true,
    width: 860,
    height: 700,
    open: async function (win) {
        FAR.WM._mountGamepadSetupUI(win);
    }
});

// ============================================================
// Приложение: Debug
// ============================================================

FAR.WM.registerApp({
    id: 'debug',
    title: 'Debug',
    icon: '🔍',
    keywords: 'debug отладка db структура',
    singleton: true,
    width: 800,
    height: 600,
    open: async function (win) {
        FAR.WM._mountDebugUI(win);
    }
});

// ============================================================
// Приложение: Выбор файла из БД (диалог)
// ============================================================

FAR.WM.registerApp({
    id: 'dbpick',
    title: 'Выбор файла из БД',
    icon: '🗂️',
    keywords: 'выбор файл db picker диалог',
    singleton: false,
    width: 1000,
    height: 620,
    open: async function (win, props) {
        await FAR.WM._mountFileDialogAsApp(win, props);
    }
});

// ============================================================
// Приложение: Лог операций
// ============================================================

FAR.WM.registerApp({
    id: 'log',
    title: 'Лог операций',
    icon: '📋',
    keywords: 'лог журнал операции log',
    singleton: true,
    width: 760,
    height: 500,
    open: async function (win) {
        FAR.WM._mountLogUI(win);
    }
});