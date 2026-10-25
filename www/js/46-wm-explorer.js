// ============================================================
// 46-wm-explorer.js — Проводник (панель, контекстное меню)
// ============================================================

FAR.WM._mountExplorerPanel = async function (win, props) {
    const used = FAR.WM.state.windows
        .filter(w => w.appId === 'explorer' && w.id !== win.id)
        .map(w => w.props.side)
        .filter(Boolean);

    let side = props.side;
    if (!side) {
        if (!used.includes('left')) side = 'left';
        else if (!used.includes('right')) side = 'right';
        else side = FAR.activePanel;
    }
    win.props.side = side;

    win.bodyEl.innerHTML = '';
    win.bodyEl.style.display = 'flex';
    win.bodyEl.style.flexDirection = 'column';

    const pathBar = document.createElement('div');
    pathBar.className = 'wm-explorer-pathbar';
    pathBar.style.cssText =
        'display:flex; align-items:center; gap:4px; ' +
        'padding:8px 12px; background:#232333; ' +
        'border-bottom:1px solid #2b2b3c; font-family:monospace; ' +
        'font-size:12px; color:#a6e3a1; flex-shrink:0; ' +
        'overflow-x:auto; white-space:nowrap; user-select:none;';
    win.bodyEl.appendChild(pathBar);

    const panelHost = document.createElement('div');
    panelHost.style.cssText = 'flex:1; min-height:0; display:flex; overflow:hidden; position:relative;';
    win.bodyEl.appendChild(panelHost);

    const dropOverlay = document.createElement('div');
    dropOverlay.className = 'wm-explorer-drop-overlay';
    dropOverlay.style.cssText =
        'position:absolute; inset:0; pointer-events:none; ' +
        'background:rgba(166,227,161,0.10); ' +
        'border:3px dashed #a6e3a1; border-radius:6px; ' +
        'display:none; align-items:center; justify-content:center; ' +
        'flex-direction:column; gap:10px; ' +
        'color:#a6e3a1; font-size:15px; font-weight:bold; z-index:10;';
    dropOverlay.innerHTML =
        '<div style="font-size:48px;">📥</div>' +
        '<div>Отпустите, чтобы загрузить в</div>' +
        '<div data-role="droppath" style="font-family:monospace;font-size:12px;' +
        'color:#cdd6f4;background:rgba(0,0,0,0.4);padding:4px 12px;border-radius:5px;' +
        'max-width:90%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></div>';
    panelHost.appendChild(dropOverlay);

    const renderPathBar = function () {
        if (!FAR.side[side]) return;
        const c = FAR.side[side];
        const norm = FAR.normPath(c.path || '');
        const dbLabel = c.conn ? FAR.connLabel(c.conn) : '— не подключено —';
        const parts = norm ? norm.split('/').filter(Boolean) : [];

        pathBar.innerHTML = '';

        const dbBadge = document.createElement('span');
        dbBadge.textContent = '🗄️ ' + dbLabel;
        dbBadge.title = 'Текущий источник этой панели: ' + dbLabel;
        dbBadge.style.cssText =
            'color:#89b4fa; padding:2px 8px; background:#1a1a2a; ' +
            'border-radius:3px; flex-shrink:0; ' +
            'font-family:monospace; font-size:12px;';
        pathBar.appendChild(dbBadge);

        const dbBtn = document.createElement('button');
        dbBtn.className = 'wm-explorer-db-btn';
        dbBtn.type = 'button';
        dbBtn.textContent = '⇄ Сменить БД';
        dbBtn.title = 'Подключить эту панель к другой БД';
        dbBtn.style.cssText =
            'color:#1e1e2e; padding:3px 10px; ' +
            'background:#89b4fa; border:none; ' +
            'border-radius:3px; margin:0 6px; flex-shrink:0; ' +
            'cursor:pointer; font-family:inherit; font-size:11px; ' +
            'font-weight:bold; line-height:1.3;';
        dbBtn.addEventListener('mouseenter', function () { dbBtn.style.background = '#74c7ec'; });
        dbBtn.addEventListener('mouseleave', function () { dbBtn.style.background = '#89b4fa'; });
        dbBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            FAR.WM._openExplorerConnDialog(win, side);
        });
        pathBar.appendChild(dbBtn);

        const sep0 = document.createElement('span');
        sep0.textContent = '›';
        sep0.style.cssText = 'color:#6c7086; margin:0 2px;';
        pathBar.appendChild(sep0);

        const rootSeg = document.createElement('span');
        rootSeg.textContent = '🏠';
        rootSeg.title = 'В корень';
        rootSeg.style.cssText = 'cursor:pointer; padding:2px 6px; border-radius:3px;';
        rootSeg.addEventListener('mouseenter', function () { rootSeg.style.background = 'rgba(74,163,255,0.18)'; });
        rootSeg.addEventListener('mouseleave', function () { rootSeg.style.background = 'transparent'; });
        rootSeg.addEventListener('click', function () { FAR.WM._explorerNavigate(win, side, '/'); });
        pathBar.appendChild(rootSeg);

        if (parts.length === 0) return;

        let acc = '';
        parts.forEach(function (p, idx) {
            acc = acc ? acc + '/' + p : p;
            const thisPath = acc;

            const sep = document.createElement('span');
            sep.textContent = '›';
            sep.style.cssText = 'color:#6c7086; margin:0 2px;';
            pathBar.appendChild(sep);

            const seg = document.createElement('span');
            seg.textContent = p;
            seg.style.cssText = 'cursor:pointer; padding:2px 6px; border-radius:3px;';
            if (idx === parts.length - 1) {
                seg.style.color = '#cdd6f4';
                seg.style.cursor = 'default';
                seg.title = 'Текущий каталог';
            } else {
                seg.title = 'Перейти в /' + thisPath;
                seg.addEventListener('mouseenter', function () { seg.style.background = 'rgba(74,163,255,0.18)'; });
                seg.addEventListener('mouseleave', function () { seg.style.background = 'transparent'; });
                seg.addEventListener('click', function () { FAR.WM._explorerNavigate(win, side, '/' + thisPath); });
            }
            pathBar.appendChild(seg);
        });

        setTimeout(function () { pathBar.scrollLeft = pathBar.scrollWidth; }, 0);
    };

    FAR.WM._cloneFarPanelInto(panelHost, side);
    renderPathBar();

    const pathWatcher = setInterval(function () {
        if (!FAR.WM.getWindow(win.id) || !document.body.contains(win.el)) {
            clearInterval(pathWatcher);
            return;
        }
        try { renderPathBar(); } catch (e) {}
    }, 400);
    win.props._pathWatcher = pathWatcher;

    panelHost.addEventListener('click', function (e) {
        const itemEl = e.target.closest('.file-item');
        if (!itemEl) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        const idx = parseInt(itemEl.dataset.index, 10);
        if (isNaN(idx)) return;
        FAR.activePanel = side;
        FAR.handleItemClick(e, side, idx);
        renderPathBar();
    }, true);

    panelHost.addEventListener('dblclick', async function (e) {
        const itemEl = e.target.closest('.file-item');
        if (!itemEl) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        const idx = parseInt(itemEl.dataset.index, 10);
        if (isNaN(idx)) return;
        FAR.activePanel = side;

        if (idx === -1) {
            FAR.goToParent(side);
            renderPathBar();
            return;
        }

        const files = FAR.side[side].files || [];
        const item = files[idx];
        if (!item) return;

        if (item.isFolder) {
            FAR.side[side].path = '/' + FAR.normPath(item.path);
            FAR.side[side].selectedIdx.clear();
            FAR.side[side].anchor = -1;
            FAR.side[side].cursor = -1;
            FAR.side[side]._loadedDir = null;
            await FAR.renderPanel(side);
            renderPathBar();
        } else {
            try {
                await FAR.openFile(item, side, idx);
            } catch (err) {
                console.error('[WM explorer] openFile failed:', err);
                FAR.toast('Не удалось открыть файл: ' + err.message, 'error');
            }
        }
    }, true);

    panelHost.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();

        FAR.activePanel = side;
        FAR.renderPanel(side);

        const itemEl = e.target.closest('.file-item');
        if (itemEl) {
            const idx = parseInt(itemEl.dataset.index, 10);
            if (!isNaN(idx) && idx >= 0) {
                const selSet = FAR.side[side].selectedIdx;
                if (!selSet.has(idx)) {
                    selSet.clear();
                    selSet.add(idx);
                    FAR.side[side].anchor = idx;
                    FAR.side[side].cursor = idx;
                    FAR.renderPanel(side);
                }
            }
        }

        FAR.WM._showExplorerContextMenu(e.clientX, e.clientY, win, side);
    }, true);

    panelHost.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        const itemEl = e.target.closest('.file-item');
        if (!itemEl) return;

        const idx = parseInt(itemEl.dataset.index, 10);
        if (isNaN(idx) || idx < 0) return;

        const startX = e.clientX;
        const startY = e.clientY;
        let dragging = false;

        const onMove = function (ev) {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            if (!dragging && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
                dragging = true;
                FAR.activePanel = side;
                const ctx = FAR.side[side];
                const selSet = ctx.selectedIdx;
                if (!selSet.has(idx)) {
                    selSet.clear();
                    selSet.add(idx);
                    ctx.anchor = idx;
                    ctx.cursor = idx;
                    FAR.renderPanel(side);
                }
                FAR.WM._beginDragFromExplorer(win, side, ev.clientX, ev.clientY);
            }
            if (dragging) {
                FAR.WM._updateDragGhost(ev.clientX, ev.clientY);
                FAR.WM._updateDropTargetUnderCursor(ev.clientX, ev.clientY, win.id);
            }
        };

        const onUp = function (ev) {
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp);

            if (!dragging) return;

            const ext = (typeof FAR._findExternalDropTarget === 'function')
                ? FAR._findExternalDropTarget(ev.clientX, ev.clientY)
                : null;

            if (ext && FAR.WM._dragPayload && typeof ext.acceptDrop === 'function') {
                const payload = FAR.WM._dragPayload;
                const items = payload.items.slice();
                const srcSide = payload.sourceSide;
                FAR.WM._endDrag();
                FAR.setStatus('');
                try {
                    const ret = ext.acceptDrop(items, srcSide);
                    if (ret && typeof ret.catch === 'function') {
                        ret.catch(function (err) { FAR.toast('Не удалось принять файлы: ' + err.message, 'error'); });
                    }
                } catch (err) {
                    FAR.toast('Не удалось принять файлы: ' + err.message, 'error');
                }
                return;
            }

            if (FAR.WM._dragPayload) {
                FAR.WM._endDrag();
                FAR.setStatus('');
            }
        };

        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp);
    });

    panelHost.addEventListener('mouseup', function (e) {
        if (!FAR.WM._dragPayload) return;
        if (FAR.WM._dragPayload.sourceWinId === win.id) return;

        const rect = panelHost.getBoundingClientRect();
        if (e.clientX < rect.left || e.clientX > rect.right ||
            e.clientY < rect.top  || e.clientY > rect.bottom) return;

        const payload = FAR.WM._dragPayload;
        if (e.shiftKey) payload.mode = 'move';
        else payload.mode = 'copy';

        FAR.WM._performDrop(win, side);
    });

    let osDragCounter = 0;
    const hasFiles = function (dt) {
        if (!dt || !dt.types) return false;
        for (let i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
        return false;
    };

    panelHost.addEventListener('dragenter', function (e) {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault(); e.stopPropagation();
        osDragCounter++;
        const c = FAR.side[side];
        const pathEl = dropOverlay.querySelector('[data-role="droppath"]');
        if (pathEl) pathEl.textContent = '/' + FAR.normPath(c.path);
        dropOverlay.style.display = 'flex';
    });

    panelHost.addEventListener('dragover', function (e) {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault(); e.stopPropagation();
        try { e.dataTransfer.dropEffect = 'copy'; } catch (err) {}
    });

    panelHost.addEventListener('dragleave', function (e) {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault(); e.stopPropagation();
        osDragCounter--;
        if (osDragCounter <= 0) {
            osDragCounter = 0;
            dropOverlay.style.display = 'none';
        }
    });

    panelHost.addEventListener('drop', async function (e) {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault(); e.stopPropagation();

        osDragCounter = 0;
        dropOverlay.style.display = 'none';

        let files = [];
        try {
            if (typeof FAR.collectFilesFromDataTransfer === 'function') {
                files = await FAR.collectFilesFromDataTransfer(e.dataTransfer);
            } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                files = Array.from(e.dataTransfer.files).map(function (f) {
                    return { name: f.name, blob: f, contentType: f.type || 'application/octet-stream', relativePath: '' };
                });
            }
        } catch (err) { FAR.toast('Не удалось прочитать файлы', 'error'); return; }

        if (!files.length) { FAR.toast('Файлы не найдены в перетаскивании', 'warning'); return; }

        const ctx = FAR.side[side];
        if (!ctx || !ctx.db) { FAR.toast('Панель не подключена к БД', 'warning'); return; }

        const targetPath = ctx.path || '/';
        const prevActive = FAR.activePanel;
        FAR.activePanel = side;

        try { await FAR.uploadFilesToPath(files, targetPath); }
        catch (err) { FAR.toast('Ошибка загрузки: ' + err.message, 'error'); }
        finally { FAR.activePanel = prevActive; }
    });
};

FAR.WM._cleanupExplorerPanel = function (win) {
    if (win && win.props && win.props._pathWatcher) {
        clearInterval(win.props._pathWatcher);
        win.props._pathWatcher = null;
    }
    const side = win && win.props ? win.props.side : null;
    if (!side) return;

    const origListId = side === 'left' ? 'listLeft' : 'listRight';
    const stashed = document.getElementById(origListId + '__wm_stash');
    const cloneAlive = document.getElementById(origListId);

    if (stashed) {
        if (cloneAlive) cloneAlive.id = origListId + '__dead';
        stashed.id = origListId;
    }
};

FAR.WM._explorerNavigate = async function (win, side, targetPath) {
    const ctx = FAR.side[side];
    if (!ctx) return;
    const norm = FAR.normPath(targetPath);
    ctx.path = '/' + norm;
    ctx.selectedIdx.clear();
    ctx.anchor = -1;
    ctx.cursor = -1;
    ctx._loadedDir = null;
    FAR.activePanel = side;
    await FAR.renderPanel(side);
};

FAR.WM._showExplorerContextMenu = function (x, y, win, side) {
    const menu = document.getElementById('wmContextMenu');
    if (!menu) return;

    menu.style.position = 'fixed';
    menu.style.zIndex = '99999';
    menu.innerHTML = '';

    const selSet = FAR.side[side].selectedIdx;
    const selCount = selSet ? selSet.size : 0;
    const hasDb = !!FAR.side[side].db;

    const add = function (label, enabled, onClick) {
        const el = document.createElement('div');
        el.className = 'wm-ctx-item' + (enabled ? '' : ' disabled');
        el.textContent = label;
        if (enabled) {
            el.addEventListener('click', function (ev) {
                ev.stopPropagation();
                FAR.WM._hideContextMenu();
                try { onClick(); } catch (e) { FAR.toast('Ошибка: ' + e.message, 'error'); }
            });
        }
        menu.appendChild(el);
    };

    const addSep = function () {
        const s = document.createElement('div');
        s.className = 'wm-ctx-sep';
        menu.appendChild(s);
    };

    const withSide = function (fn) {
        return function () {
            const prevActive = FAR.activePanel;
            FAR.activePanel = side;
            try { fn(); } finally { setTimeout(function () { FAR.activePanel = prevActive; }, 0); }
        };
    };

    const getSelectedItem = function () {
        const c = FAR.side[side];
        if (!c || c.selectedIdx.size === 0) return null;
        const firstIdx = Array.from(c.selectedIdx).sort((a, b) => a - b)[0];
        return (c.files || [])[firstIdx] || null;
    };

    const selectedItem = getSelectedItem();
    const isFile = !!(selectedItem && !selectedItem.isFolder);
    const isHtml = isFile && typeof FAR.isHtmlFile === 'function' && FAR.isHtmlFile(selectedItem);
    const isText = isFile && typeof FAR.isTextFile === 'function' && FAR.isTextFile(selectedItem);

    // ============================================================
    // «Открыть» (эмуляция Enter) — работает и на файлах, и на папках.
    // Необходимо для мобильных устройств, где нет физической клавиши Enter.
    // Берёт текущий курсор, а если ничего не выделено — открывает
    // родительский каталог (эквивалент Enter на «..»).
    // ============================================================
    add('📂 Открыть', hasDb, withSide(function () {
        const c = FAR.side[side];
        if (!c) return;
        let idx = -1;
        if (c.selectedIdx && c.selectedIdx.size > 0) {
            idx = Array.from(c.selectedIdx).sort((a, b) => a - b)[0];
        } else {
            idx = c.cursor;
        }
        if (idx === -1) {
            FAR.goToParent(side);
        } else if (idx >= 0 && idx < (c.files || []).length) {
            FAR.handleItemDblClick(side, idx);
        }
    }));

    add('📤 Загрузить',     hasDb, withSide(function () { FAR.uploadFile(); }));
    add('📁 Создать папку', hasDb, withSide(function () { FAR.createFolder(); }));
    add('📝 Редактировать (Notepad++)', hasDb && isText, withSide(function () {
        const it = getSelectedItem(); if (it) FAR.WM.openApp('texteditor', { props: { file: it, side: side } });
    }));
    add('🌐 Открыть в браузере', hasDb && isHtml, withSide(function () {
        const it = getSelectedItem(); if (it) FAR.openBrowserFromItem(it, side);
    }));
    add('🪟 Открыть в новом окне', hasDb && isFile, withSide(function () {
        const it = getSelectedItem(); if (it) FAR.openFileInNewWindow(it, side);
    }));

    addSep();

    add('📋 Копировать',    hasDb && selCount > 0, withSide(function () { FAR.copySelected(); }));
    add('✂️ Перенести',      hasDb && selCount > 0, withSide(function () { FAR.moveSelected(); }));
    add('📥 Скачать',       hasDb && selCount > 0, withSide(function () { FAR.downloadSelectedUncompressed(); }));
    add('🗜️ Скачать ZIP',   hasDb && selCount > 0, withSide(function () { FAR.downloadSelectedAsZip(); }));
    add('🗑️ Удалить',       hasDb && selCount > 0, withSide(function () { FAR.deleteSelected(); }));

    addSep();

    add('🔄 Обновить',      hasDb, withSide(function () { FAR.reloadPanel(side); }));
    add('⬆ Вверх',          true,  withSide(function () { FAR.navigatePanel(side, '..'); }));
    add('🏠 В корень',      true,  withSide(function () { FAR.navigatePanel(side, '/'); }));

    FAR.WM._positionContextMenu(menu, x, y);
};

FAR.WM._cloneFarPanelInto = function (host, side) {
    const origListId = side === 'left' ? 'listLeft' : 'listRight';
    const origList = document.getElementById(origListId);

    if (origList && !origList.id.endsWith('__wm_stash')) origList.id = origListId + '__wm_stash';

    const clone = document.createElement('div');
    clone.className = 'file-list';
    clone.id = origListId;

    const spacer = document.createElement('div');
    spacer.className = 'file-list-spacer';
    spacer.style.position = 'relative';
    clone.appendChild(spacer);

    host.innerHTML = '';
    host.appendChild(clone);
    clone._farVirtualBound = false;

    FAR.renderPanel(side);

    clone.addEventListener('scroll', function () { FAR._renderPanelDOM(side); });
};

FAR.WM._openExplorerConnDialog = function (parentWin, side) {
    if (!side) return;

    const dialogWin = FAR.WM.openWindow({
        title: '🔐 Подключение панели (' + (side === 'left' ? 'Левая' : 'Правая') + ')',
        icon: '🗄️',
        width: 480,
        height: 540,
        appId: 'conn-side-' + side,
        modal: true,
        parentId: parentWin ? parentWin.id : null,
        props: { side: side }
    });

    FAR.WM._mountSideConnUI(dialogWin, side);
};

FAR.WM._mountSideConnUI = function (win, side) {
    win.bodyEl.innerHTML =
        '<div style="padding:20px;background:#1e1e2e;color:#cdd6f4;height:100%;box-sizing:border-box;overflow:auto;">' +
        '<div style="display:flex;flex-direction:column;gap:12px;">' +
        '<div style="padding:8px 10px;background:#313244;border-left:3px solid #89b4fa;border-radius:4px;font-size:13px;"><b style="color:#89b4fa;"></b></div>' +
        '<label style="font-size:12px;color:#a6adc8;">Адрес FileServer' +
        '<input data-role="url" type="text" placeholder="http://127.0.0.1:8080" style="width:100%;margin-top:4px;padding:8px;background:#313244;border:1px solid #45475a;border-radius:5px;color:#cdd6f4;font-family:monospace;"></label>' +
        '<label style="font-size:12px;color:#a6adc8;">Имя пользователя' +
        '<input data-role="user" type="text" placeholder="admin" style="width:100%;margin-top:4px;padding:8px;background:#313244;border:1px solid #45475a;border-radius:5px;color:#cdd6f4;font-family:monospace;"></label>' +
        '<label style="font-size:12px;color:#a6adc8;">Пароль' +
        '<input data-role="pass" type="password" placeholder="••••••••" style="width:100%;margin-top:4px;padding:8px;background:#313244;border:1px solid #45475a;border-radius:5px;color:#cdd6f4;font-family:monospace;"></label>' +
        '<div style="font-size:11px;color:#a6adc8;padding:6px 10px;background:#181825;border-left:2px solid #89b4fa;border-radius:4px;margin-top:4px;">Если сервер в локальной сети и недоступен напрямую — соединение пойдёт через прокси текущего сервера автоматически.</div>' +
        '<div data-role="error" style="color:#f38ba8;font-size:12px;min-height:16px;"></div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">' +
        '<button data-role="cancel" style="padding:8px 18px;background:#585b70;color:#cdd6f4;border:none;border-radius:5px;cursor:pointer;">Отмена</button>' +
        '<button data-role="connect" style="padding:8px 18px;background:#a6e3a1;color:#1e1e2e;border:none;border-radius:5px;cursor:pointer;font-weight:bold;">Подключиться</button>' +
        '</div></div></div>';

    const urlEl  = win.bodyEl.querySelector('[data-role="url"]');
    const userEl = win.bodyEl.querySelector('[data-role="user"]');
    const passEl = win.bodyEl.querySelector('[data-role="pass"]');
    const errEl  = win.bodyEl.querySelector('[data-role="error"]');
    const cancelBtn  = win.bodyEl.querySelector('[data-role="cancel"]');
    const connectBtn = win.bodyEl.querySelector('[data-role="connect"]');

    const ctx = FAR.side[side];
    let def = (ctx && ctx.conn) ? ctx.conn : (typeof FAR.getConnDefaultsForSide === 'function' ? FAR.getConnDefaultsForSide(side) : FAR.getDefaultConn());
    if (!def) def = { url: '', user: '', pass: '' };

    urlEl.value  = def.url  || '';
    userEl.value = def.user || '';
    passEl.value = def.pass || '';

    cancelBtn.onclick = function () { FAR.WM.closeWindow(win.id); };

    connectBtn.onclick = async function () {
        const cfg = { url: urlEl.value.trim(), user: userEl.value.trim(), pass: passEl.value };
        if (!cfg.url) { errEl.textContent = 'Укажите URL FileServer'; return; }

        connectBtn.disabled = true;
        connectBtn.textContent = 'Подключение…';
        errEl.textContent = '';

        let res;
        try { res = await FAR.connectToDb(cfg); }
        catch (e) {
            errEl.textContent = '❌ ' + (e.message || String(e));
            connectBtn.disabled = false;
            connectBtn.textContent = 'Подключиться';
            return;
        }

        try { FAR.applyConnectionToSide(side, cfg, res.db, res.fullUrl); }
        catch (e) {
            errEl.textContent = '❌ Не удалось применить: ' + e.message;
            connectBtn.disabled = false;
            connectBtn.textContent = 'Подключиться';
            return;
        }

        try { if (typeof FAR.saveSideConnToLS === 'function') FAR.saveSideConnToLS(side, cfg); } catch (e) {}

        FAR.updateAuthUI();
        FAR.setStatus('✅ Панель «' + (side === 'left' ? 'Левая' : 'Правая') + '» подключена: ' + res.fullUrl);
        FAR.toast('Панель подключена', 'success');

        try { await FAR.loadFilesForSide(side, { path: '/', silent: true }); } catch (e) {}
        try { FAR.renderPanel(side); } catch (e) {}

        if (typeof FAR.WM.updateTray === 'function') FAR.WM.updateTray();
        if (typeof FAR.updateConnIndicators === 'function') FAR.updateConnIndicators();

        FAR.WM.closeWindow(win.id);
    };
};