FAR.setStatus = function(t) {
    document.getElementById('statusText').textContent = t;
};

FAR.showLoading = function(text, sub) {
    document.getElementById('loadingOverlay').classList.remove('hidden');
    document.getElementById('loadingText').textContent = text || '';
    document.getElementById('loadingSub').textContent = sub || '';
};
FAR.updateLoadingSub = function(text) {
    document.getElementById('loadingSub').textContent = text || '';
};
FAR.hideLoading = function() {
    document.getElementById('loadingOverlay').classList.add('hidden');
};

FAR.formatSize = function(b) {
    if (!b) return '0 B';
    if (b > 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
    if (b > 1048576) return (b / 1048576).toFixed(2) + ' MB';
    if (b > 1024) return (b / 1024).toFixed(1) + ' KB';
    return b + ' B';
};

FAR.escapeHtml = function(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
};

FAR.hexPreview = function(data) {
    return Array.from(data.slice(0, 256))
        .map(b => b.toString(16).padStart(2, '0')).join(' ');
};

FAR.toast = function(msg, type) {
    type = type || 'info';
    const c = document.getElementById('toastContainer');
    const el = document.createElement('div');
    el.className = 'toast ' + type;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 300);
    }, 3000);
};

FAR.sanitizeFileName = function(name) {
    return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+$/, '_');
};

FAR.normPath = function(p) {
    if (p === null || p === undefined) return '';
    let s = String(p).trim();
    if (!s) return '';
    s = s.replace(/\\/g, '/');
    s = s.replace(/^\/+|\/+$/g, '');
    s = s.replace(/\/+/g, '/');
    return s;
};

/**
 * Загружает внешний скрипт ровно один раз.
 * Возвращает Promise, который резолвится после загрузки.
 * Повторные вызовы с тем же src возвращают тот же Promise.
 */
FAR._loadedScripts = FAR._loadedScripts || {};

FAR.loadScriptOnce = function (src) {
    if (FAR._loadedScripts[src]) return FAR._loadedScripts[src];

    FAR._loadedScripts[src] = new Promise(function (resolve, reject) {
        const s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = function () { resolve(); };
        s.onerror = function () {
            delete FAR._loadedScripts[src];
            reject(new Error('Не удалось загрузить ' + src));
        };
        document.head.appendChild(s);
    });

    return FAR._loadedScripts[src];
};

// ============================================================
// Сохранение/восстановление положения курсора (localStorage)
// ============================================================

/**
 * Сохраняет текущее состояние панелей в localStorage.
 * Вызывается при любом изменении активной панели, пути или курсора.
 */
FAR.saveUiState = function() {
    try {
        const state = {
            activePanel: FAR.activePanel,
            leftPath: FAR.leftPath,
            rightPath: FAR.rightPath,
            leftCursor: FAR.leftCursor,
            rightCursor: FAR.rightCursor,
            // Запоминаем и имя файла — на случай, если порядок
            // элементов поменялся (например, после удаления/создания)
            leftFile: FAR._getFileAt(FAR.leftFiles, FAR.leftCursor),
            rightFile: FAR._getFileAt(FAR.rightFiles, FAR.rightCursor)
        };
        localStorage.setItem(FAR.LS_UI_KEY, JSON.stringify(state));
    } catch (e) {
        /* localStorage может быть недоступен — молча игнорируем */
    }
};

/**
 * Читает сохранённое состояние панелей из localStorage.
 * Возвращает объект или null.
 */
FAR.loadUiState = function() {
    try {
        const raw = localStorage.getItem(FAR.LS_UI_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object') return null;
        return obj;
    } catch (e) {
        return null;
    }
};

/**
 * Возвращает имя файла в списке по индексу или '' если индекса нет.
 * Нужно, чтобы запомнить не только позицию, но и имя.
 */
FAR._getFileAt = function(list, idx) {
    if (!list || idx === null || idx === undefined) return '';
    if (idx < 0 || idx >= list.length) return '';
    const item = list[idx];
    if (!item) return '';
    return item.name || '';
};

/**
 * Восстанавливает состояние панелей из localStorage.
 * Вызывается после того, как загружены файлы (FAR.loadFiles).
 * Возвращает true, если что-то было восстановлено.
 */
FAR.restoreUiState = function() {
    const st = FAR.loadUiState();
    if (!st) return false;

    if (st.activePanel === 'left' || st.activePanel === 'right') {
        FAR.activePanel = st.activePanel;
        const pl = document.getElementById('panelLeft');
        const pr = document.getElementById('panelRight');
        if (pl && pr) {
            pl.classList.toggle('active', st.activePanel === 'left');
            pr.classList.toggle('active', st.activePanel === 'right');
        }
    }

    // Восстанавливаем пути и (опционально) грузим их
    const restorePromises = [];
    if (typeof st.leftPath === 'string' && st.leftPath) {
        FAR.side.left.path = st.leftPath;
        FAR.side.left._loadedDir = null;
        restorePromises.push(FAR.ensureDirLoaded('left', st.leftPath, { silent: true }));
    }
    if (typeof st.rightPath === 'string' && st.rightPath) {
        FAR.side.right.path = st.rightPath;
        FAR.side.right._loadedDir = null;
        restorePromises.push(FAR.ensureDirLoaded('right', st.rightPath, { silent: true }));
    }

    return Promise.all(restorePromises).then(function() {
        FAR.renderPanel('left',  { skipLoad: true });
        FAR.renderPanel('right', { skipLoad: true });

        FAR._restoreCursor('left',  st.leftFile,  st.leftCursor);
        FAR._restoreCursor('right', st.rightFile, st.rightCursor);

        FAR.renderPanel('left',  { skipLoad: true });
        FAR.renderPanel('right', { skipLoad: true });

        return true;
    });
};

/**
 * Ставит курсор на панели.
 * Приоритет: файл с заданным именем; если такого нет — индекс.
 */
FAR._restoreCursor = function(side, fileName, cursorIdx) {
    const files = side === 'left' ? FAR.leftFiles : FAR.rightFiles;
    let idx = -1;

    if (fileName) {
        idx = files.findIndex(function(f) { return f.name === fileName; });
    }

    if (idx === -1 && typeof cursorIdx === 'number' && cursorIdx >= 0 && cursorIdx < files.length) {
        idx = cursorIdx;
    }

    if (idx < 0) {
        if (side === 'left') {
            FAR.leftCursor = -1;
            FAR.leftSelectedIdx.clear();
            FAR.leftAnchor = -1;
        } else {
            FAR.rightCursor = -1;
            FAR.rightSelectedIdx.clear();
            FAR.rightAnchor = -1;
        }
        return;
    }

    if (side === 'left') {
        FAR.leftCursor = idx;
        FAR.leftSelectedIdx.clear();
        FAR.leftSelectedIdx.add(idx);
        FAR.leftAnchor = idx;
    } else {
        FAR.rightCursor = idx;
        FAR.rightSelectedIdx.clear();
        FAR.rightSelectedIdx.add(idx);
        FAR.rightAnchor = idx;
    }
};

/**
 * Сохраняет Blob как файл через временный <a download>.
 * Единая точка для всех скачиваний в проекте.
 *
 * @param {Blob} blob         — данные файла
 * @param {string} fileName   — имя файла для сохранения
 */
FAR.saveBlobAs = function (blob, fileName) {
    if (!(blob instanceof Blob)) {
        throw new Error('saveBlobAs: ожидался Blob, получено ' +
            (blob && blob.constructor && blob.constructor.name));
    }

    const name = String(fileName || 'file.bin');

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';

    document.body.appendChild(a);
    a.click();

    // Убираем <a> и освобождаем URL асинхронно, чтобы
    // Firefox/Chrome гарантированно успели начать скачивание.
    setTimeout(function () {
        try { document.body.removeChild(a); } catch (e) {}
        try { URL.revokeObjectURL(url); } catch (e) {}
    }, 1000);
};