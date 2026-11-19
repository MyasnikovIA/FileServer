// ============================================================
// 49-wm-dialogs.js — Диалоги WM (выбор файла)
// ============================================================

/**
 * Открывает диалоговое окно выбора файла из БД.
 *
 * @param {Object} opts
 * @param {string} [opts.title]    — заголовок окна
 * @param {string} [opts.side]     — 'left' | 'right' (из какой панели брать файлы)
 * @param {string} [opts.parentId] — ID родительского окна (для modal-режима)
 * @returns {Promise<Object|null>} — выбранный файл (fileIndex-элемент) или null
 */
FAR.WM.openFileDialog = function (opts) {
    opts = opts || {};

    return new Promise(function (resolve) {
        let resolved = false;

        // Открываем окно приложения 'dbpick'
        FAR.WM.openApp('dbpick', {
            title: opts.title || 'Выбор файла из БД',
            side: opts.side || FAR.activePanel,
            parentId: opts.parentId || null,
            modal: !!opts.parentId,

            // Колбэк для возврата результата
            onConfirm: function (file) {
                if (resolved) return;
                resolved = true;
                resolve(file);
            },

            // Колбэк при закрытии (если нажали "Отмена" или крестик)
            onClose: function () {
                if (resolved) return;
                resolved = true;
                resolve(null);
            }
        });
    });
};

/**
 * Монтирует интерфейс диалога выбора файла внутрь переданного окна.
 * Вызывается из 44-wm-apps.js при открытии приложения 'dbpick'.
 */
FAR.WM._mountFileDialogAsApp = async function (win, props) {
    const side = props.side || FAR.activePanel;

    // Проверяем, есть ли подключение к БД
    if (!FAR.side[side] || !FAR.side[side].db) {
        win.bodyEl.innerHTML = '<div style="padding:20px;color:#f38ba8;text-align:center;">Нет подключения к БД для этой панели.</div>';
        return;
    }

    // 1. Загружаем HTML-шаблон
    const templateEl = document.querySelector('.wm-file-dialog-template');
    if (!templateEl) {
        console.error('[WM dialog] Шаблон .wm-file-dialog-template не найден в DOM!');
        win.bodyEl.innerHTML = '<div style="padding:20px;color:#f38ba8;">Ошибка: шаблон диалога не загружен.</div>';
        return;
    }

    // 2. Клонируем его в тело окна и ПРИНУДИТЕЛЬНО ДЕЛАЕМ ВИДИМЫМ
    const clone = templateEl.cloneNode(true);
    clone.style.display = 'flex';
    clone.style.flex = '1';
    clone.style.minHeight = '0';
    win.bodyEl.appendChild(clone);

    // 3. Находим элементы управления
    const pathBar     = win.bodyEl.querySelector('[data-role="path"]');
    const listEl      = win.bodyEl.querySelector('[data-role="list"]');
    const previewEl   = win.bodyEl.querySelector('[data-role="preview"]');
    const infoEl      = win.bodyEl.querySelector('[data-role="info"]');
    const btnCancel   = win.bodyEl.querySelector('[data-role="cancel"]');
    const btnOk       = win.bodyEl.querySelector('[data-role="ok"]');

    // 4. Состояние диалога
    let currentPath = '/';
    let items = [];
    let selectedFile = null;
    let previewUrl = null;

    // --- Очистка Blob URL при закрытии ---
    win.onClose = function () {
        if (previewUrl) {
            try { URL.revokeObjectURL(previewUrl); } catch (e) {}
            previewUrl = null;
        }
        if (typeof win.props.onClose === 'function') {
            try { win.props.onClose(win); } catch (e) {}
        }
    };

    // --- Вспомогательная функция: обновить превью ---
    const updatePreview = async function (item) {
        if (previewUrl) {
            try { URL.revokeObjectURL(previewUrl); } catch (e) {}
            previewUrl = null;
        }

        if (!item) {
            if (previewEl) previewEl.innerHTML = '';
            if (infoEl) infoEl.textContent = '';
            if (btnOk) btnOk.disabled = true;
            return;
        }

        if (infoEl) {
            infoEl.textContent = item.path + (item.size ? ' (' + FAR.formatSize(item.size) + ')' : '');
        }

        if (!item.isFolder && item.contentType && item.contentType.startsWith('image/')) {
            if (previewEl) previewEl.innerHTML = '<div style="color:#a6adc8;">Загрузка...</div>';
            try {
                const res = await FAR.readFileBodyFromSide(side, item);
                const blob = new Blob([res.data], { type: item.contentType });
                previewUrl = URL.createObjectURL(blob);
                if (previewEl) {
                    previewEl.innerHTML = `<img src="${previewUrl}" style="max-width:100%; max-height:100%; object-fit:contain;" alt="preview">`;
                }
            } catch (e) {
                if (previewEl) previewEl.innerHTML = `<div style="color:#f38ba8;">Ошибка загрузки превью</div>`;
            }
        } else {
            if (previewEl) {
                previewEl.innerHTML = `<div style="color:#6c7086; text-align:center;">
                    ${item.isFolder ? '📁 Папка' : '📄 Файл'}<br>
                    <small>Превью недоступно</small>
                </div>`;
            }
        }

        // Кнопка "Открыть" активна, только если выбран файл (не папка)
        if (btnOk) {
            btnOk.disabled = item.isFolder;
        }
    };

    // --- Рендер списка файлов ---
    const renderList = function () {
        if (pathBar) pathBar.textContent = currentPath || '/';
        if (!listEl) return;

        listEl.innerHTML = '';

        // Кнопка ".."
        if (currentPath !== '/') {
            const parentItem = document.createElement('div');
            parentItem.className = 'wm-fd-item';
            parentItem.innerHTML = `<span>📁</span> <span class="wm-fd-name">..</span>`;
            parentItem.onclick = () => loadDir(currentPath.split('/').slice(0, -1).join('/') || '/');
            listEl.appendChild(parentItem);
        }

        if (items.length === 0) {
            listEl.innerHTML += '<div style="padding:10px;color:#6c7086;text-align:center;">Папка пуста</div>';
            return;
        }

        items.forEach(function (item) {
            const el = document.createElement('div');
            el.className = 'wm-fd-item';
            if (selectedFile && selectedFile.path === item.path) {
                el.classList.add('selected');
            }

            const icon = item.isFolder ? '📁' : '📄';
            const sizeStr = item.isFolder ? '' : FAR.formatSize(item.size);

            el.innerHTML = `
                <span>${icon}</span>
                <span class="wm-fd-name">${FAR.escapeHtml(item.name)}</span>
                <span class="wm-fd-size">${sizeStr}</span>
            `;

            el.onclick = function () {
                selectedFile = item;
                renderList(); // Перерисовываем для обновления выделения
                updatePreview(item);
            };

            el.ondblclick = function () {
                if (item.isFolder) {
                    loadDir(item.path);
                } else {
                    selectedFile = item;
                    if (btnOk) btnOk.disabled = false;
                    btnOk.click();
                }
            };

            listEl.appendChild(el);
        });
    };

    // --- Загрузка директории ---
    const loadDir = async function (path) {
        currentPath = FAR.normPath(path) || '';
        selectedFile = null;
        updatePreview(null);

        if (listEl) listEl.innerHTML = '<div style="padding:10px;color:#a6adc8;text-align:center;">Загрузка...</div>';

        try {
            const dirItems = await FAR.listDirFromSide(side, currentPath, { includeDocs: true });
            items = dirItems || [];

            // Сортировка: сначала папки, потом файлы, по алфавиту
            items.sort(function (a, b) {
                if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
                return a.name.localeCompare(b.name);
            });

            renderList();
        } catch (e) {
            console.error('[WM dialog] loadDir error:', e);
            if (listEl) listEl.innerHTML = `<div style="padding:10px;color:#f38ba8;text-align:center;">Ошибка: ${e.message}</div>`;
        }
    };

    // --- Обработчики кнопок ---
    if (btnCancel) {
        btnCancel.onclick = function () {
            // Просто закрываем окно. onClose сработает автоматически.
            FAR.WM.closeWindow(win.id);
        };
    }

    if (btnOk) {
        btnOk.onclick = function () {
            if (!selectedFile || selectedFile.isFolder) return;

            // Вызываем колбэк из props (если есть)
            if (typeof win.props.onConfirm === 'function') {
                win.props.onConfirm(selectedFile);
            }

            // Закрываем окно
            FAR.WM.closeWindow(win.id);
        };
    }

    // --- Инициализация: загружаем корень ---
    loadDir('/');
};