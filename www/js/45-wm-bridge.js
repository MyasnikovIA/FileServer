// ============================================================
// 45-wm-bridge.js — оконный мост (независимые проигрыватели)
// ============================================================

FAR.WM._orig = FAR.WM._orig || {};
FAR.WM.PICKER_LAST_DIR = 'filebd_wm_picker_last_dir';

// ============================================================
// Drag&drop между окнами Проводника
// ============================================================

FAR.WM._dragPayload = null;
FAR.WM._dragGhostEl = null;

FAR.WM._beginDragFromExplorer = function (win, side, startX, startY) {
    const ctx = FAR.side[side];
    if (!ctx) return;

    const selSet = ctx.selectedIdx;
    const files = ctx.files || [];
    let items = [];

    if (selSet && selSet.size > 0) {
        for (const idx of Array.from(selSet).sort((a, b) => a - b)) {
            if (idx >= 0 && idx < files.length) {
                const f = files[idx];
                if (f) items.push({ _id: f._id, name: f.name, path: f.path, isFolder: f.isFolder });
            }
        }
    }
    if (items.length === 0) return;

    FAR.WM._dragPayload = {
        sourceWinId: win.id,
        sourceSide: side,
        items: items,
        mode: 'copy'
    };

    const ghost = document.createElement('div');
    ghost.className = 'wm-drag-ghost';
    ghost.textContent = items.length === 1
        ? '📦 ' + items[0].name
        : '📦 ' + items.length + ' элементов';
    ghost.style.cssText =
        'position:fixed;pointer-events:none;z-index:99999;' +
        'background:rgba(74,163,255,0.92);color:#fff;' +
        'padding:6px 12px;border-radius:5px;font-size:12px;' +
        'box-shadow:0 4px 12px rgba(0,0,0,0.5);' +
        'transform:translate(12px,12px);';
    ghost.style.left = startX + 'px';
    ghost.style.top = startY + 'px';
    document.body.appendChild(ghost);
    FAR.WM._dragGhostEl = ghost;

    FAR.WM.state.windows.forEach(function (w) {
        if (w.appId === 'explorer') {
            w.el.classList.add('wm-drop-target-candidate');
        }
    });

    FAR.setStatus('Перетаскивание: ' + items.length +
        ' элемент(ов). Отпустите в окне Проводника, Ollama или другом приёмнике.');
};

FAR.WM._updateDragGhost = function (x, y) {
    if (FAR.WM._dragGhostEl) {
        FAR.WM._dragGhostEl.style.left = x + 'px';
        FAR.WM._dragGhostEl.style.top  = y + 'px';
    }
};

FAR.WM._endDrag = function () {
    const payload = FAR.WM._dragPayload;
    FAR.WM._dragPayload = null;

    if (FAR.WM._dragGhostEl) {
        try { FAR.WM._dragGhostEl.remove(); } catch (e) {}
        FAR.WM._dragGhostEl = null;
    }

    // Снимаем hover с внешних приёмников (например, Ollama)
    if (typeof FAR._setExternalHover === 'function') {
        FAR._setExternalHover(null);
    }

    FAR.WM.state.windows.forEach(function (w) {
        w.el.classList.remove('wm-drop-target-candidate', 'wm-drop-target-hover');
    });

    return payload;
};

FAR.WM._performDrop = async function (targetWin, targetSide) {
    const payload = FAR.WM._endDrag();
    if (!payload) return;

    if (targetWin.id === payload.sourceWinId) {
        FAR.toast('Перетащите в другое окно Проводника', 'info');
        return;
    }

    const srcSide = payload.sourceSide;
    const dstSide = targetSide;

    if (srcSide === dstSide) {
        FAR.toast('Источник и цель — одна панель. Откройте второе окно Проводника.', 'warning');
        return;
    }

    const sSrc = FAR.side[srcSide];
    const sDst = FAR.side[dstSide];
    if (!sSrc || !sSrc.db) { FAR.toast('Источник не подключён', 'warning'); return; }
    if (!sDst || !sDst.db) { FAR.toast('Цель не подключена', 'warning'); return; }

    const mode = payload.mode || 'copy';

    const srcFiles = sSrc.files || [];
    const wantedIds = new Set(payload.items.map(it => it._id));
    const indices = [];
    srcFiles.forEach(function (f, idx) {
        if (f && wantedIds.has(f._id)) indices.push(idx);
    });

    if (indices.length === 0) {
        FAR.toast('Перетаскиваемые файлы не найдены в текущей папке источника', 'warning');
        return;
    }

    const prevActive = FAR.activePanel;
    FAR.activePanel = srcSide;

    const prevSel = Array.from(sSrc.selectedIdx);
    const prevAnchor = sSrc.anchor;
    sSrc.selectedIdx.clear();
    indices.forEach(i => sSrc.selectedIdx.add(i));
    sSrc.anchor = indices[0];

    try {
        await FAR.transferBetweenSides(mode);
    } catch (e) {
        console.error('[WM drop] transfer failed:', e);
        FAR.toast('Ошибка переноса: ' + e.message, 'error');
    } finally {
        FAR.activePanel = prevActive;
        sSrc.selectedIdx.clear();
        prevSel.forEach(i => sSrc.selectedIdx.add(i));
        sSrc.anchor = prevAnchor;
    }

    await FAR.reloadPanel('left');
    await FAR.reloadPanel('right');
    FAR.renderPanel('left');
    FAR.renderPanel('right');

    FAR.toast(
        (mode === 'move' ? 'Перенесено' : 'Скопировано') +
        ': ' + payload.items.length + ' элемент(ов)',
        'success'
    );
};

// ============================================================
// Проводник FileBD
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

    // Оверлей для приёма файлов из ОС.
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
        dbBtn.addEventListener('mouseenter', function () {
            dbBtn.style.background = '#74c7ec';
        });
        dbBtn.addEventListener('mouseleave', function () {
            dbBtn.style.background = '#89b4fa';
        });
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
        rootSeg.addEventListener('mouseenter', function () {
            rootSeg.style.background = 'rgba(74,163,255,0.18)';
        });
        rootSeg.addEventListener('mouseleave', function () {
            rootSeg.style.background = 'transparent';
        });
        rootSeg.addEventListener('click', function () {
            FAR.WM._explorerNavigate(win, side, '/');
        });
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
                seg.addEventListener('mouseenter', function () {
                    seg.style.background = 'rgba(74,163,255,0.18)';
                });
                seg.addEventListener('mouseleave', function () {
                    seg.style.background = 'transparent';
                });
                seg.addEventListener('click', function () {
                    FAR.WM._explorerNavigate(win, side, '/' + thisPath);
                });
            }
            pathBar.appendChild(seg);
        });

        setTimeout(function () {
            pathBar.scrollLeft = pathBar.scrollWidth;
        }, 0);
    };

    FAR.WM._cloneFarPanelInto(panelHost, side);
    renderPathBar();

    const pathWatcher = setInterval(function () {
        if (!FAR.WM.getWindow(win.id) || !document.body.contains(win.el)) {
            clearInterval(pathWatcher);
            return;
        }
        try {
            renderPathBar();
        } catch (e) {
            console.warn('[WM explorer] pathWatcher error:', e);
        }
    }, 400);
    win.props._pathWatcher = pathWatcher;

    // Клик по элементу — выделение.
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

    // Двойной клик — открытие файла / вход в папку.
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

    // Контекстное меню (ПКМ).
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

    // Drag & drop: НАЧАЛО перетаскивания из этого окна
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

            // Сначала проверяем внешние приёмники (Ollama и др.)
            const ext = (typeof FAR._findExternalDropTarget === 'function')
                ? FAR._findExternalDropTarget(ev.clientX, ev.clientY)
                : null;

            if (ext && FAR.WM._dragPayload
                && typeof ext.acceptDrop === 'function') {
                const payload = FAR.WM._dragPayload;
                const items = payload.items.slice();
                const srcSide = payload.sourceSide;
                FAR.WM._endDrag();
                FAR.setStatus('');
                try {
                    const ret = ext.acceptDrop(items, srcSide);
                    if (ret && typeof ret.catch === 'function') {
                        ret.catch(function (err) {
                            console.error('[WM external drop]', err);
                            FAR.toast('Не удалось принять файлы: ' + err.message, 'error');
                        });
                    }
                } catch (err) {
                    console.error('[WM external drop]', err);
                    FAR.toast('Не удалось принять файлы: ' + err.message, 'error');
                }
                return;
            }

            // Стандартное поведение: drop в другое окно Проводника
            if (FAR.WM._dragPayload) {
                FAR.WM._endDrag();
                FAR.setStatus('');
            }
        };

        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp);
    });

    // Drag & drop: ПРИЁМ файлов из другого WM-окна.
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

    // Drag & drop из ОС
    let osDragCounter = 0;

    const hasFiles = function (dt) {
        if (!dt || !dt.types) return false;
        for (let i = 0; i < dt.types.length; i++) {
            if (dt.types[i] === 'Files') return true;
        }
        return false;
    };

    panelHost.addEventListener('dragenter', function (e) {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        osDragCounter++;

        const c = FAR.side[side];
        const pathEl = dropOverlay.querySelector('[data-role="droppath"]');
        if (pathEl) pathEl.textContent = '/' + FAR.normPath(c.path);
        dropOverlay.style.display = 'flex';
    });

    panelHost.addEventListener('dragover', function (e) {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        try { e.dataTransfer.dropEffect = 'copy'; } catch (err) {}
    });

    panelHost.addEventListener('dragleave', function (e) {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        osDragCounter--;
        if (osDragCounter <= 0) {
            osDragCounter = 0;
            dropOverlay.style.display = 'none';
        }
    });

    panelHost.addEventListener('drop', async function (e) {
        if (!hasFiles(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();

        osDragCounter = 0;
        dropOverlay.style.display = 'none';

        let files = [];
        try {
            if (typeof FAR.collectFilesFromDataTransfer === 'function') {
                files = await FAR.collectFilesFromDataTransfer(e.dataTransfer);
            } else {
                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    files = Array.from(e.dataTransfer.files).map(function (f) {
                        return {
                            name: f.name,
                            blob: f,
                            contentType: f.type || 'application/octet-stream',
                            relativePath: ''
                        };
                    });
                }
            }
        } catch (err) {
            console.error('[WM explorer drop] collect failed:', err);
            FAR.toast('Не удалось прочитать файлы', 'error');
            return;
        }

        if (!files.length) {
            FAR.toast('Файлы не найдены в перетаскивании', 'warning');
            return;
        }

        const ctx = FAR.side[side];
        if (!ctx || !ctx.db) {
            FAR.toast('Панель не подключена к БД', 'warning');
            return;
        }

        const targetPath = ctx.path || '/';

        const prevActive = FAR.activePanel;
        FAR.activePanel = side;

        try {
            await FAR.uploadFilesToPath(files, targetPath);
        } catch (err) {
            console.error('[WM explorer drop] upload failed:', err);
            FAR.toast('Ошибка загрузки: ' + err.message, 'error');
        } finally {
            FAR.activePanel = prevActive;
        }
    });
};

FAR.WM._updateDropTargetUnderCursor = function (x, y, sourceWinId) {
    // Сначала — внешние приёмники (Ollama и др.)
    const ext = (typeof FAR._findExternalDropTarget === 'function')
        ? FAR._findExternalDropTarget(x, y)
        : null;
    if (typeof FAR._setExternalHover === 'function') {
        FAR._setExternalHover(ext);
    }

    FAR.WM.state.windows.forEach(function (w) {
        if (w.appId !== 'explorer') return;
        if (w.id === sourceWinId) return;

        const rect = w.el.getBoundingClientRect();
        const isInside = x >= rect.left && x <= rect.right &&
            y >= rect.top  && y <= rect.bottom;

        // Если над внешним приёмником — не подсвечиваем Проводник
        if (isInside && FAR.WM._dragPayload && !ext) {
            w.el.classList.add('wm-drop-target-hover');
        } else {
            w.el.classList.remove('wm-drop-target-hover');
        }
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
        if (cloneAlive) {
            cloneAlive.id = origListId + '__dead';
        }
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

// ============================================================
// Контекстное меню (ПКМ) в окне Проводника (WM-режим).
// ============================================================
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
                try { onClick(); } catch (e) {
                    console.error('[WM explorer ctx]', e);
                    FAR.toast('Ошибка: ' + e.message, 'error');
                }
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
            try { fn(); } finally {
                setTimeout(function () { FAR.activePanel = prevActive; }, 0);
            }
        };
    };

    const getSelectedItem = function () {
        const c = FAR.side[side];
        if (!c) return null;
        if (c.selectedIdx.size === 0) return null;
        const firstIdx = Array.from(c.selectedIdx).sort(function (a, b) { return a - b; })[0];
        const files = c.files || [];
        return files[firstIdx] || null;
    };

    const selectedItem = getSelectedItem();
    const isFile = !!(selectedItem && !selectedItem.isFolder);
    const isHtml = isFile
        && typeof FAR.isHtmlFile === 'function'
        && FAR.isHtmlFile(selectedItem);
    const isText = isFile
        && typeof FAR.isTextFile === 'function'
        && FAR.isTextFile(selectedItem);

    add('📤 Загрузить',     hasDb, withSide(function () { FAR.uploadFile(); }));
    add('📁 Создать папку', hasDb, withSide(function () { FAR.createFolder(); }));

    add('📝 Редактировать (Notepad++)', hasDb && isText, withSide(function () {
        const it = getSelectedItem();
        if (it) FAR.WM.openApp('texteditor', { props: { file: it, side: side } });
    }));

    add('🌐 Открыть в браузере', hasDb && isHtml, withSide(function () {
        const it = getSelectedItem();
        if (it) FAR.openBrowserFromItem(it, side);
    }));

    add('🪟 Открыть в новом окне', hasDb && isFile, withSide(function () {
        const it = getSelectedItem();
        if (it) FAR.openFileInNewWindow(it, side);
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

    if (origList && !origList.id.endsWith('__wm_stash')) {
        origList.id = origListId + '__wm_stash';
    }

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

    clone.addEventListener('scroll', function () {
        FAR._renderPanelDOM(side);
    });
};

// ============================================================
// Оконные просмотрщики
// ============================================================

FAR.WM._finalizeViewer = function (win) {
    if (!win.props) return;

    if (win.props._blobUrls && Array.isArray(win.props._blobUrls)) {
        win.props._blobUrls.forEach(function (u) {
            try { URL.revokeObjectURL(u); } catch (e) {}
        });
        win.props._blobUrls = [];
    }

    if (win.props._pannellumViewer) {
        try { win.props._pannellumViewer.destroy(); } catch (e) {}
        win.props._pannellumViewer = null;
    }

    if (win.props._audioEl) {
        try {
            win.props._audioEl.pause();
            win.props._audioEl.removeAttribute('src');
            win.props._audioEl.load();
        } catch (e) {}
        win.props._audioEl = null;
    }

    if (win.props._videoEl) {
        try {
            win.props._videoEl.pause();
            win.props._videoEl.removeAttribute('src');
            win.props._videoEl.load();
        } catch (e) {}
        win.props._videoEl = null;
    }

    if (win.props._jsdosInstance) {
        try { win.props._jsdosInstance.stop(); } catch (e) {}
        win.props._jsdosInstance = null;
    }

    if (win.props._nesBrowser) {
        try { win.props._nesBrowser.destroy(); } catch (e) {}
        win.props._nesBrowser = null;
    }

    if (win.props._emulatorInstance) {
        const emu = win.props._emulatorInstance;
        try {
            if (emu.Module && emu.Module.AL && emu.Module.AL.currentCtx &&
                emu.Module.AL.currentCtx.audioCtx) {
                emu.Module.AL.currentCtx.audioCtx.close();
            }
        } catch (e) {}
        try {
            if (emu.gameManager && typeof emu.gameManager.toggleMainLoop === 'function') {
                emu.gameManager.toggleMainLoop(0);
            }
        } catch (e) {}
        try {
            if (emu.Module && typeof emu.Module.pauseMainLoop === 'function') {
                emu.Module.pauseMainLoop();
            }
        } catch (e) {}
        try { if (typeof emu.pause === 'function') emu.pause(true); } catch (e) {}
        try { if (typeof emu.destroy === 'function') emu.destroy(); } catch (e) {}
        win.props._emulatorInstance = null;
    }
};

FAR.WM._trackBlobUrl = function (win, url) {
    if (!win.props._blobUrls) win.props._blobUrls = [];
    win.props._blobUrls.push(url);
};

// ---- Универсальный просмотрщик ----

FAR.WM._mountFileViewer = async function (win, props) {
    const item = props.file;
    const side = props.side || FAR.activePanel;

    win.el.querySelector('.wm-title-text').textContent = '👁 ' + item.name;

    win.bodyEl.innerHTML =
        '<div style="padding:14px;height:100%;box-sizing:border-box;overflow:auto;background:#1e1e2e;color:#cdd6f4;">' +
        '<div style="text-align:center;padding:40px;color:#a6adc8;">Загрузка…</div>' +
        '</div>';

    const host = win.bodyEl.firstChild;

    try {
        const r = await FAR.readFileBodyFromSide(side, item);
        const data = r.data;
        const ct = r.contentType || item.contentType || 'application/octet-stream';
        const ext = (item.name.split('.').pop() || '').toLowerCase();
        const imgExts = ['jpg','jpeg','png','gif','webp','svg','bmp','ico'];
        const txtExts = ['txt','md','json','xml','csv','log','html','css','js','py','java','c','cpp','h','ini','cfg','yaml','yml'];

        if (imgExts.includes(ext)) {
            const blob = new Blob([data], {
                type: ct.startsWith('image/') ? ct : 'image/' + (ext === 'jpg' ? 'jpeg' : ext)
            });
            const url = URL.createObjectURL(blob);
            FAR.WM._trackBlobUrl(win, url);
            host.innerHTML =
                '<div style="text-align:center;padding:6px;">' +
                '<img src="' + url + '" style="max-width:100%;max-height:calc(100vh - 200px);border-radius:4px;">' +
                '</div>' +
                '<div style="text-align:center;color:#a6adc8;font-size:12px;">📷 ' + FAR.formatSize(data.length) + '</div>';
        } else if (txtExts.includes(ext) || !item.binary) {
            try {
                const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
                host.innerHTML = '<pre style="white-space:pre-wrap;word-break:break-all;font-size:12px;color:#a6e3a1;margin:0;">' +
                    FAR.escapeHtml(text) + '</pre>';
            } catch (e) {
                host.innerHTML = '<pre style="white-space:pre-wrap;word-break:break-all;font-size:12px;color:#a6e3a1;margin:0;">' +
                    FAR.hexPreview(data) + '</pre>';
            }
        } else {
            host.innerHTML = '<div style="color:#f9e2af;margin-bottom:8px;">Бинарный файл (' + FAR.formatSize(data.length) + ')</div>' +
                '<pre style="white-space:pre-wrap;word-break:break-all;font-size:12px;color:#a6e3a1;margin:0;">' +
                FAR.hexPreview(data) + '</pre>';
        }

        FAR.WM._installViewerNavButtons(win, item, side);
    } catch (e) {
        host.innerHTML = '<div style="color:#f38ba8;padding:20px;">Ошибка: ' + FAR.escapeHtml(e.message) + '</div>';
    }
};

// ---- Аудио ----

FAR.WM._mountMp3Viewer = async function (win, props) {
    const item = props.file;
    const side = props.side || FAR.activePanel;

    win.el.querySelector('.wm-title-text').textContent = '🎵 ' + item.name;
    win.bodyEl.innerHTML =
        '<div style="padding:30px;height:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;background:#1e1e2e;color:#cdd6f4;">' +
        '<div style="font-size:60px;">🎵</div>' +
        '<div style="font-size:14px;color:#a6adc8;text-align:center;word-break:break-all;">' + FAR.escapeHtml(item.name) + '</div>' +
        '<div data-role="player" style="width:100%;max-width:600px;"></div>' +
        '<div data-role="status" style="font-size:12px;color:#6c7086;"></div>' +
        '</div>';

    const playerHost = win.bodyEl.querySelector('[data-role="player"]');
    const statusEl = win.bodyEl.querySelector('[data-role="status"]');

    statusEl.textContent = 'Загрузка…';

    try {
        const r = await FAR.readFileBodyFromSide(side, item);
        const blob = new Blob([r.data], { type: r.contentType || 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        FAR.WM._trackBlobUrl(win, url);

        const audio = document.createElement('audio');
        audio.controls = true;
        audio.autoplay = true;
        audio.src = url;
        audio.style.width = '100%';
        playerHost.appendChild(audio);

        win.props._audioEl = audio;

        statusEl.textContent = FAR.formatSize(r.data.length) +
            ' • ' + (r.contentType || 'audio/mpeg');

        audio.addEventListener('error', function () {
            const err = audio.error;
            let reason = 'неизвестная ошибка';
            if (err) {
                switch (err.code) {
                    case 1: reason = 'воспроизведение прервано'; break;
                    case 2: reason = 'сетевая ошибка'; break;
                    case 3: reason = 'ошибка декодирования'; break;
                    case 4: reason = 'формат не поддерживается'; break;
                }
            }
            if (err && err.code === 1) return;
            FAR.toast('Ошибка аудио: ' + reason, 'error');
        });

        FAR.WM._installViewerNavButtons(win, item, side);
    } catch (e) {
        statusEl.textContent = 'Ошибка: ' + e.message;
        statusEl.style.color = '#f38ba8';
    }
};

// ---- Видео ----

FAR.WM._mountVideoViewer = async function (win, props) {
    const item = props.file;
    const side = props.side || FAR.activePanel;

    win.el.querySelector('.wm-title-text').textContent = '🎬 ' + item.name;

    win.bodyEl.innerHTML =
        '<div style="height:100%;background:#000;display:flex;flex-direction:column;">' +
        '<div data-role="stage" style="flex:1;display:flex;align-items:stretch;justify-content:stretch;min-height:0;position:relative;background:#000;">' +
        '</div>' +
        '<div data-role="status" style="padding:6px 12px;background:#111;color:#a6adc8;font-size:11px;text-align:center;">Загрузка…</div>' +
        '</div>';

    const stage    = win.bodyEl.querySelector('[data-role="stage"]');
    const statusEl = win.bodyEl.querySelector('[data-role="status"]');

    const directUrl = FAR.buildDirectFileUrl(item, side);
    if (!directUrl) {
        statusEl.textContent = 'Не удалось построить URL';
        statusEl.style.color = '#f38ba8';
        return;
    }

    let isCrossOrigin = false;
    try { isCrossOrigin = new URL(directUrl).origin !== location.origin; } catch (e) {}

    let url = directUrl;
    if (isCrossOrigin && FAR.authToken) {
        url += (url.includes('?') ? '&' : '?') +
            'token=' + encodeURIComponent(FAR.authToken);
    }

    const sizeStr = (item.size > 0) ? ' • ' + FAR.formatSize(item.size) : '';
    const ctStr = item.contentType || 'video/mp4';
    statusEl.textContent = ctStr + sizeStr;

    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    if (isCrossOrigin) video.crossOrigin = 'anonymous';
    video.src = url;

    video.style.cssText =
        'width:100%;' +
        'height:100%;' +
        'object-fit:contain;' +
        'display:block;' +
        'background:#000;' +
        'outline:none;';

    stage.appendChild(video);

    win.props._videoEl = video;

    video.addEventListener('error', function () {
        const err = video.error;
        if (err && err.code === 1) return;
        let reason = 'неизвестная ошибка';
        if (err) {
            switch (err.code) {
                case 2: reason = 'сетевая ошибка'; break;
                case 3: reason = 'ошибка декодирования'; break;
                case 4: reason = 'формат не поддерживается'; break;
            }
        }
        FAR.toast('Ошибка видео: ' + reason, 'error');
        statusEl.textContent = 'Ошибка: ' + reason;
        statusEl.style.color = '#f38ba8';
    });

    video.addEventListener('progress', function () {
        const dur = video.duration;
        if (!isFinite(dur) || dur <= 0) return;
        let bufEnd = 0;
        for (let i = 0; i < video.buffered.length; i++) {
            bufEnd = Math.max(bufEnd, video.buffered.end(i));
        }
        const pct = Math.round((bufEnd / dur) * 100);
        statusEl.textContent =
            ctStr + sizeStr +
            ' • буферизовано: ' + FAR._videoFormatTime(bufEnd) +
            ' / ' + FAR._videoFormatTime(dur) +
            ' (' + pct + '%)';
    });

    FAR.WM._installViewerNavButtons(win, item, side);
};

// ---- PDF ----

FAR.WM._mountPdfViewer = async function (win, props) {
    const item = props.file;
    const side = props.side || FAR.activePanel;

    win.el.querySelector('.wm-title-text').textContent = '📄 ' + item.name;
    win.bodyEl.innerHTML =
        '<div style="height:100%;display:flex;flex-direction:column;background:#181825;">' +
        '<div data-role="host" style="flex:1;position:relative;min-height:0;"></div>' +
        '<div data-role="status" style="padding:6px 12px;background:#232333;color:#a6adc8;font-size:11px;text-align:center;"></div>' +
        '</div>';

    const host = win.bodyEl.querySelector('[data-role="host"]');
    const statusEl = win.bodyEl.querySelector('[data-role="status"]');

    statusEl.textContent = 'Загрузка…';

    try {
        const r = await FAR.readFileBodyFromSide(side, item);
        const blob = new Blob([r.data], { type: 'application/pdf' });
        const url = URL.createObjectURL(blob);
        FAR.WM._trackBlobUrl(win, url);

        const iframe = document.createElement('iframe');
        iframe.src = url;
        iframe.style.cssText = 'width:100%;height:100%;border:none;background:#fff;';
        host.appendChild(iframe);

        statusEl.textContent = FAR.formatSize(r.data.length) + ' • application/pdf';

        FAR.WM._installViewerNavButtons(win, item, side);
    } catch (e) {
        statusEl.textContent = 'Ошибка: ' + e.message;
        statusEl.style.color = '#f38ba8';
    }
};

// ---- Браузер (WM-окно) ----

FAR.WM._mountBrowserViewer = async function (win, props) {
    const url = props.url || '';
    const homeUrl = props.homeUrl || url;
    const trusted = !!props.trusted;

    win.bodyEl.innerHTML = '';
    win.bodyEl.style.display = 'flex';
    win.bodyEl.style.flexDirection = 'column';
    win.bodyEl.style.minHeight = '0';

    if (win.props._browserApi) {
        try { win.props._browserApi.destroy(); } catch (e) {}
        win.props._browserApi = null;
    }

    const titleEl = win.el.querySelector('.wm-title-text');
    if (titleEl) titleEl.textContent = '🌐 ' + (props.title || 'Браузер');

    const api = FAR._createBrowser(win.bodyEl, {
        url: url,
        homeUrl: homeUrl,
        trusted: trusted,
        onChangeTitle: function (t) {
            const tEl = win.el.querySelector('.wm-title-text');
            if (tEl) tEl.textContent = t;
            win.title = t;
            if (typeof FAR.WM._renderTaskbar === 'function') {
                FAR.WM._renderTaskbar();
            }
        }
    });

    win.props._browserApi = api;

    if (!url) {
        setTimeout(function () {
            try {
                const input = win.bodyEl.querySelector('.browser-url-input');
                if (input) input.focus();
            } catch (e) {}
        }, 50);
    }
};

// ---- Панорама ----

FAR.WM._mountPanoramaViewer = async function (win, props) {
    const item = props.file;
    const side = props.side || FAR.activePanel;

    win.el.querySelector('.wm-title-text').textContent = '🌐 ' + item.name;
    win.bodyEl.innerHTML =
        '<div style="height:100%;position:relative;background:#000;">' +
        '<div data-role="canvas" style="width:100%;height:100%;"></div>' +
        '<div data-role="loading" style="position:absolute;inset:0;background:rgba(0,0,0,0.85);' +
        'display:flex;align-items:center;justify-content:center;color:#a6adc8;font-size:14px;">' +
        'Загрузка панорамы…</div>' +
        '</div>';

    const canvasHost = win.bodyEl.querySelector('[data-role="canvas"]');
    const loadingEl = win.bodyEl.querySelector('[data-role="loading"]');

    win.props._panoSeq = (win.props._panoSeq || 0) + 1;
    const uniqueId = 'wm-pano-' + win.id + '-' + win.props._panoSeq;
    canvasHost.id = uniqueId;
    win.props._panoContainerId = uniqueId;

    try {
        const r = await FAR.readFileBodyFromSide(side, item);
        const blob = new Blob([r.data], { type: r.contentType || 'image/jpeg' });
        const url = URL.createObjectURL(blob);
        FAR.WM._trackBlobUrl(win, url);

        const basePath = item.path.includes('/')
            ? item.path.substring(0, item.path.lastIndexOf('/'))
            : '';
        let hotspots = [];

        if (props._hotspotsOverride) {
            hotspots = FAR._jsonToPannellumHotspots({ hotSpots: props._hotspotsOverride }, basePath, url);
        } else {
            try {
                const jsonData = await FAR._findPanoramaJson(item, side);
                hotspots = FAR._jsonToPannellumHotspots(jsonData, basePath, url);
            } catch (e) {
                console.warn('[WM pano] hotspots:', e);
            }
        }

        if (typeof window.pannellum === 'undefined') {
            loadingEl.textContent = 'Pannellum не загружен';
            return;
        }

        const initialPitch = props._initialPitch !== undefined ? props._initialPitch : 0;
        const initialYaw   = props._initialYaw   !== undefined ? props._initialYaw   : 0;

        const viewer = window.pannellum.viewer(uniqueId, {
            type: 'equirectangular',
            panorama: url,
            autoLoad: true,
            autoRotate: false,
            showControls: true,
            showFullscreenCtrl: true,
            showZoomCtrl: true,
            mouseZoom: true,
            keyboardZoom: true,
            doubleClickZoom: false,
            compass: false,
            hfov: 100,
            pitch: initialPitch,
            yaw: initialYaw,
            hotSpots: hotspots
        });

        win.props._pannellumViewer = viewer;

        viewer.on('load', function () {
            loadingEl.style.display = 'none';
            setTimeout(function () {
                FAR.WM._attachWmHotspotHandlers(win);
                if (typeof FAR.WM._attachPanoEditorDblClick === 'function') {
                    FAR.WM._attachPanoEditorDblClick(win, uniqueId, item, side);
                }
            }, 50);
        });
        viewer.on('error', function (msg) {
            loadingEl.textContent = 'Ошибка: ' + msg;
            loadingEl.style.color = '#f38ba8';
        });

        FAR.WM._installViewerNavButtons(win, item, side);
    } catch (e) {
        loadingEl.textContent = 'Ошибка: ' + e.message;
        loadingEl.style.color = '#f38ba8';
    }
};

FAR.WM._attachWmHotspotHandlers = function (win) {
    const viewer = win.props._pannellumViewer;
    if (!viewer) return;

    const containerId = win.props._panoContainerId;
    const container = containerId ? document.getElementById(containerId) : null;
    if (!container) return;

    let hotspots = [];
    try {
        const cfg = viewer.getConfig();
        if (cfg && Array.isArray(cfg.hotSpots)) {
            hotspots = cfg.hotSpots;
        }
    } catch (e) {}

    const divs = container.querySelectorAll('.pnlm-hotspot-base');
    const divsArr = Array.from(divs);

    divsArr.forEach(function (div) {
        if (div._wmIntercepted) return;
        div._wmIntercepted = true;

        let matchedHs = null;
        for (let i = 0; i < hotspots.length; i++) {
            if (hotspots[i] && hotspots[i].div === div) {
                matchedHs = hotspots[i];
                break;
            }
        }
        if (!matchedHs) {
            const idx = divsArr.indexOf(div);
            if (idx >= 0 && idx < hotspots.length) {
                matchedHs = hotspots[idx];
            }
        }
        if (!matchedHs) {
            console.warn('[WM pano] хотспот не сопоставлен с конфигом');
            return;
        }

        try { div.onclick = null; } catch (e) {}
        try { div.ontouchend = null; } catch (e) {}

        const handler = function (e) {
            e.stopImmediatePropagation();
            e.preventDefault();
            FAR.WM._onWmPanoramaHotspotClick(win, matchedHs);
        };
        div.addEventListener('click', handler, true);
        div.addEventListener('touchend', handler, true);
    });
};

FAR.WM._onWmPanoramaHotspotClick = async function (win, hs) {
    if (!hs) return;

    if (win.props._panoNavigating) return;
    win.props._panoNavigating = true;

    try {
        const side = win.props.side;
        let targetItem = null;

        const dbPath = hs.dbPath || hs._origDbPath;

        if (hs.source === 'db' && dbPath) {
            targetItem = await FAR._findDbImageByPath(dbPath, side);
        } else if (hs.panorama_url && !/^blob:/i.test(hs.panorama_url)) {
            const norm = FAR.normPath(hs.panorama_url);
            targetItem = FAR.fileIndex.find(f =>
                f.docType === 'file' && FAR.normPath(f.path) === norm
            );
            if (!targetItem) {
                targetItem = await FAR._findDbImageByPath(norm, side);
            }
        } else if (hs._origDbPath) {
            targetItem = await FAR._findDbImageByPath(hs._origDbPath, side);
        }

        if (!targetItem) {
            FAR.toast('Файл панорамы не найден: ' + (dbPath || hs.panorama_url || '?'), 'error');
            win.props._panoNavigating = false;
            return;
        }

        if (win.props._pannellumViewer) {
            try { win.props._pannellumViewer.destroy(); } catch (e) {}
            win.props._pannellumViewer = null;
        }

        const targetPitch = hs.targetPitch !== undefined
            ? hs.targetPitch
            : (hs.point_pitch !== undefined ? hs.point_pitch : 0);
        const targetYaw = hs.targetYaw !== undefined
            ? hs.targetYaw
            : (hs.point_yaw !== undefined ? hs.point_yaw : 0);

        win.props.file = targetItem;
        win.props._initialPitch = targetPitch;
        win.props._initialYaw   = targetYaw;

        await FAR.WM._mountPanoramaViewer(win, win.props);

        FAR.setStatus('🌐 Панорама: ' + targetItem.name);

        if (typeof FAR._selectFileInPanel === 'function') {
            try { FAR._selectFileInPanel(targetItem, side); } catch (e) {}
        }
    } catch (e) {
        console.error('[WM pano] hotspot click:', e);
        FAR.toast('Переход не выполнен: ' + e.message, 'error');
    } finally {
        win.props._panoNavigating = false;
    }
};

// ---- JSDOS ----

FAR.WM._mountJsdosViewer = async function (win, props) {
    const item = props.file;
    const side = props.side || FAR.activePanel;

    win.el.querySelector('.wm-title-text').textContent = '🕹️ ' + item.name;

    win.bodyEl.innerHTML =
        '<div style="height:100%;position:relative;background:#000;">' +
        '<div data-role="root" style="width:100%;height:100%;min-height:400px;outline:none;" tabindex="0"></div>' +
        '<div data-role="loading" style="position:absolute;inset:0;background:rgba(0,0,0,0.88);' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#a6adc8;z-index:10;">' +
        '<div style="width:50px;height:50px;border:4px solid #313244;border-top-color:#89b4fa;border-radius:50%;animation:spin 1s linear infinite;"></div>' +
        '<div data-role="status" style="font-size:14px;">Загрузка игры…</div>' +
        '</div>' +
        '</div>';

    const root = win.bodyEl.querySelector('[data-role="root"]');
    const loadingEl = win.bodyEl.querySelector('[data-role="loading"]');
    const statusEl = win.bodyEl.querySelector('[data-role="status"]');

    if (!window.Dos) {
        loadingEl.innerHTML =
            '<div style="color:#f38ba8;padding:20px;text-align:center;">' +
            'Библиотека JS-DOS не загружена.<br>Проверьте lib/js-dos/js-dos.js</div>';
        return;
    }

    let url = null;
    try {
        const r = await FAR.readFileBodyFromSide(side, item);
        const blob = new Blob([r.data], { type: r.contentType || 'application/octet-stream' });
        url = URL.createObjectURL(blob);
        FAR.WM._trackBlobUrl(win, url);
    } catch (e) {
        loadingEl.innerHTML =
            '<div style="color:#f38ba8;padding:20px;text-align:center;">' +
            'Ошибка чтения: ' + FAR.escapeHtml(e.message) + '</div>';
        return;
    }

    await new Promise(function (resolve) { setTimeout(resolve, 50); });

    try {
        const pathPrefix = new URL('lib/js-dos/', window.location.href).href;
        if (typeof window.emulators !== 'undefined') {
            window.emulators.pathPrefix = pathPrefix;
        }

        const instance = window.Dos(root, {
            wdosboxUrl: pathPrefix + 'wdosbox.js',
            pathPrefix: pathPrefix
        });
        win.props._jsdosInstance = instance;

        statusEl.textContent = 'Запуск…';

        try {
            instance.events().onStdout(function (line) {
                console.log('[WM jsdos]', line);
            });
        } catch (e) {}

        await instance.run(url);

        loadingEl.style.display = 'none';
        FAR.setStatus('🕹️ JSDOS: ' + item.name);

        try {
            root.setAttribute('tabindex', '0');
            root.focus();
            const canvas = root.querySelector('canvas');
            if (canvas) {
                canvas.setAttribute('tabindex', '0');
                canvas.focus();
            }
        } catch (e) {}

        FAR.WM._installViewerNavButtons(win, item, side);
    } catch (e) {
        console.error('[WM jsdos]', e);
        loadingEl.innerHTML =
            '<div style="color:#f38ba8;padding:20px;text-align:center;">' +
            'Ошибка запуска: ' + FAR.escapeHtml(e.message) + '</div>';
    }
};

// ---- NES ----

FAR.WM._mountNesViewer = async function (win, props) {
    const item = props.file;
    const side = props.side || FAR.activePanel;

    win.el.querySelector('.wm-title-text').textContent = '🎮 ' + item.name;

    win.bodyEl.innerHTML =
        '<div style="height:100%;position:relative;background:#000;display:flex;align-items:center;justify-content:center;">' +
        '<div data-role="root" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;min-height:400px;"></div>' +
        '<div data-role="loading" style="position:absolute;inset:0;background:rgba(0,0,0,0.88);' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#a6adc8;z-index:10;">' +
        '<div style="width:50px;height:50px;border:4px solid #313244;border-top-color:#89b4fa;border-radius:50%;animation:spin 1s linear infinite;"></div>' +
        '<div data-role="status" style="font-size:14px;">Загрузка эмулятора…</div>' +
        '</div>' +
        '</div>';

    const root = win.bodyEl.querySelector('[data-role="root"]');
    const loadingEl = win.bodyEl.querySelector('[data-role="loading"]');
    const statusEl = win.bodyEl.querySelector('[data-role="status"]');

    let jsnesLib = null;
    try {
        if (typeof FAR._loadJsnesDynamically !== 'function') {
            throw new Error('Модуль 29-nes-viewer.js не загружен');
        }
        jsnesLib = await FAR._loadJsnesDynamically();
    } catch (e) {
        loadingEl.innerHTML =
            '<div style="color:#f38ba8;padding:20px;text-align:center;">' +
            'Ошибка загрузки JSNES: ' + FAR.escapeHtml(e.message) + '</div>';
        return;
    }

    let romBuffer = null;
    try {
        statusEl.textContent = 'Загрузка ROM…';
        const r = await FAR.readFileBodyFromSide(side, item);
        romBuffer = r.data;
    } catch (e) {
        loadingEl.innerHTML =
            '<div style="color:#f38ba8;padding:20px;text-align:center;">' +
            'Ошибка ROM: ' + FAR.escapeHtml(e.message) + '</div>';
        return;
    }

    try {
        const head = Array.from(romBuffer.slice(0, 16))
            .map(b => b.toString(16).padStart(2, '0')).join(' ');
        console.log('[WM nes] ROM header:', head);
    } catch (e) {}

    await new Promise(function (resolve) { setTimeout(resolve, 30); });

    try {
        statusEl.textContent = 'Инициализация…';

        const browser = new jsnesLib.Browser({
            container: root,
            onError: function (e) {
                console.error('JSNES error:', e);
                FAR.toast('Ошибка NES: ' + (e && e.message ? e.message : e), 'error');
            }
        });
        win.props._nesBrowser = browser;

        let romData = romBuffer;
        browser.loadROM(romData);

        setTimeout(function () { try { browser.fitInParent(); } catch (e) {} }, 100);
        setTimeout(function () { try { browser.fitInParent(); } catch (e) {} }, 400);

        loadingEl.style.display = 'none';
        FAR.setStatus('🎮 NES: ' + item.name);

        FAR.WM._installViewerNavButtons(win, item, side);
    } catch (e) {
        console.error('[WM nes]', e);
        loadingEl.innerHTML =
            '<div style="color:#f38ba8;padding:20px;text-align:center;">' +
            'Ошибка запуска: ' + FAR.escapeHtml(e.message) + '</div>';
    }
};

// ---- EmulatorJS ----

FAR.WM._mountEmulatorViewer = async function (win, props) {
    const others = FAR.WM.state.windows.filter(function (w) {
        return w.appId === 'emulator' && w.id !== win.id;
    });
    for (const other of others) {
        try {
            FAR.WM._finalizeViewer(other);
            FAR.WM.closeWindow(other.id, true);
        } catch (e) {}
    }

    const item = props.file;
    const side = props.side || FAR.activePanel;

    const core = (typeof FAR._getEmulatorCore === 'function')
        ? FAR._getEmulatorCore(item)
        : null;

    if (!core) {
        win.el.querySelector('.wm-title-text').textContent = '🕹️ ' + item.name;
        FAR.WM._mountNotice(win, '🕹️',
            'Формат файла не поддерживается EmulatorJS.');
        return;
    }

    win.el.querySelector('.wm-title-text').textContent =
        '🕹️ ' + item.name + ' (' + core + ')';

    win.bodyEl.innerHTML =
        '<div style="height:100%;position:relative;background:#000;">' +
        '<div data-role="root" style="width:100%;height:100%;min-height:400px;"></div>' +
        '<div data-role="loading" style="position:absolute;inset:0;background:rgba(0,0,0,0.9);' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#a6adc8;z-index:10;">' +
        '<div style="width:50px;height:50px;border:4px solid #313244;border-top-color:#89b4fa;border-radius:50%;animation:spin 1s linear infinite;"></div>' +
        '<div data-role="status" style="font-size:14px;">Загрузка эмулятора…</div>' +
        '</div>' +
        '</div>';

    const root = win.bodyEl.querySelector('[data-role="root"]');
    const loadingEl = win.bodyEl.querySelector('[data-role="loading"]');
    const statusEl = win.bodyEl.querySelector('[data-role="status"]');

    win.props._emuSeq = (win.props._emuSeq || 0) + 1;
    const containerId = 'wm-emu-' + win.id + '-' + win.props._emuSeq;
    root.id = containerId;

    let blobUrl = null;
    try {
        statusEl.textContent = 'Загрузка ROM…';
        const r = await FAR.readFileBodyFromSide(side, item);
        const blob = new Blob([r.data], { type: r.contentType || 'application/octet-stream' });
        blobUrl = URL.createObjectURL(blob);
        FAR.WM._trackBlobUrl(win, blobUrl);
    } catch (e) {
        loadingEl.innerHTML =
            '<div style="color:#f38ba8;padding:20px;text-align:center;">' +
            'Ошибка ROM: ' + FAR.escapeHtml(e.message) + '</div>';
        return;
    }

    if (typeof window.EmulatorJS !== 'function') {
        statusEl.textContent = 'Загрузка библиотеки…';

        const tempContainer = document.createElement('div');
        tempContainer.id = 'ejs-temp-' + win.id;
        tempContainer.style.cssText =
            'position:absolute;left:-99999px;top:-99999px;' +
            'width:1px;height:1px;overflow:hidden;pointer-events:none;';
        document.body.appendChild(tempContainer);

        window.EJS_player        = '#' + tempContainer.id;
        window.EJS_core          = core;
        window.EJS_gameUrl       = blobUrl;
        window.EJS_gameName      = item.name;
        window.EJS_pathtodata    = 'lib/js-emulator/';
        window.EJS_color         = '#89b4fa';
        window.EJS_startOnLoaded = false;

        try {
            if (typeof FAR._loadEmulatorLoader !== 'function') {
                throw new Error('Модуль 30-emulator-viewer.js не загружен');
            }
            await FAR._loadEmulatorLoader();
        } catch (e) {
            try { tempContainer.remove(); } catch (e2) {}
            loadingEl.innerHTML =
                '<div style="color:#f38ba8;padding:20px;text-align:center;">' +
                'Ошибка библиотеки: ' + FAR.escapeHtml(e.message) + '</div>';
            return;
        }

        setTimeout(function () {
            try { tempContainer.remove(); } catch (e2) {}
        }, 200);
    }

    if (typeof window.EmulatorJS !== 'function') {
        loadingEl.innerHTML =
            '<div style="color:#f38ba8;padding:20px;text-align:center;">' +
            'window.EmulatorJS не определён после загрузки библиотеки</div>';
        return;
    }

    window.EJS_player        = '#' + containerId;
    window.EJS_core          = core;
    window.EJS_gameUrl       = blobUrl;
    window.EJS_gameName      = item.name;
    window.EJS_pathtodata    = 'lib/js-emulator/';
    window.EJS_color         = '#89b4fa';
    window.EJS_startOnLoaded = true;

    statusEl.textContent = 'Запуск ядра ' + core + '…';

    try {
        const config = {
            gameUrl:     blobUrl,
            gameName:    item.name,
            dataPath:    'lib/js-emulator/',
            system:      core,
            color:       '#89b4fa',
            startOnLoad: true
        };

        const emu = new window.EmulatorJS('#' + containerId, config);
        win.props._emulatorInstance = emu;

        setTimeout(function () {
            if (loadingEl) loadingEl.style.display = 'none';
        }, 3000);

        FAR.setStatus('🕹️ EmulatorJS: ' + item.name + ' (' + core + ')');
        FAR.WM._installViewerNavButtons(win, item, side);
    } catch (e) {
        console.error('[WM emu]', e);
        loadingEl.innerHTML =
            '<div style="color:#f38ba8;padding:20px;text-align:center;">' +
            'Ошибка запуска: ' + FAR.escapeHtml(e.message) + '</div>';
    }
};

// ============================================================
// Навигация ◀ ▶ в шапке окна
// ============================================================

FAR.WM._installViewerNavButtons = function (win, item, side) {
    const titlebar = win.el.querySelector('.wm-titlebar');
    if (!titlebar) return;

    const actions = titlebar.querySelector('.wm-title-actions');
    if (!actions) return;

    if (win.appId === 'panorama' && !actions.querySelector('.wm-nav-edit')) {
        const editBtn = document.createElement('button');
        editBtn.className = 'wm-title-btn wm-nav-edit';
        editBtn.textContent = '✏️';
        editBtn.title = 'Редактор точек перехода';
        editBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            FAR.WM.openPanoEditor({ item: item, side: side, coords: null });
        });
        actions.insertBefore(editBtn, actions.firstChild);
    }

    if (titlebar.querySelector('.wm-nav-prev')) return;

    const ctx = FAR.side[side];
    const files = (ctx && ctx.files) || [];
    const cur = files.findIndex(f => f._id === item._id);
    let prevIdx = -1, nextIdx = -1;
    for (let i = cur - 1; i >= 0; i--) if (!files[i].isFolder) { prevIdx = i; break; }
    for (let i = cur + 1; i < files.length; i++) if (!files[i].isFolder) { nextIdx = i; break; }

    const mkBtn = function (label, targetIdx, dir) {
        const b = document.createElement('button');
        b.className = 'wm-title-btn wm-nav-' + (dir < 0 ? 'prev' : 'next');
        b.textContent = label;
        b.title = dir < 0 ? 'Предыдущий' : 'Следующий';
        if (targetIdx < 0) {
            b.style.visibility = 'hidden';
            b.disabled = true;
        } else {
            b.addEventListener('click', function (e) {
                e.stopPropagation();
                FAR.WM._navigateViewerGeneric(win, dir);
            });
        }
        return b;
    };

    actions.insertBefore(mkBtn('◀', prevIdx, -1), actions.firstChild);
    actions.insertBefore(mkBtn('▶', nextIdx, +1), actions.firstChild.nextSibling);
};

FAR.WM._navigateViewerGeneric = async function (win, dir) {
    const side = win.props.side;
    const ctx = FAR.side[side];
    if (!ctx) return;
    const files = ctx.files || [];
    const cur = files.findIndex(f => f._id === win.props.file._id);
    if (cur < 0) return;
    let next = cur + dir;
    while (next >= 0 && next < files.length) {
        if (!files[next].isFolder) {
            const newItem = files[next];
            const appId = win.appId;

            const saved = {
                x:      win.x,
                y:      win.y,
                width:  win.w,
                height: win.h,
                maximized: !!win.maximized,
                snap: win.snap || null
            };
            if (win.prevRect) {
                saved.x      = win.prevRect.x;
                saved.y      = win.prevRect.y;
                saved.width  = win.prevRect.w;
                saved.height = win.prevRect.h;
            }

            FAR.WM._finalizeViewer(win);
            FAR.WM.closeWindow(win.id, true);

            const newWin = await FAR.WM.openApp(appId, {
                props: { file: newItem, side: side },
                x:      saved.x,
                y:      saved.y,
                width:  saved.width,
                height: saved.height
            });

            if (newWin) {
                if (saved.maximized) {
                    FAR.WM.toggleMaximize(newWin.id);
                } else if (saved.snap === 'left' || saved.snap === 'right') {
                    FAR.WM.snapWindow(newWin.id, saved.snap);
                }
            }
            return;
        }
        next += dir;
    }
};

// ============================================================
// Вспомогательные приложения
// ============================================================

FAR.WM._mountConnectionUI = function (win) {
    win.bodyEl.innerHTML =
        '<div style="padding:20px;background:#1e1e2e;color:#cdd6f4;height:100%;box-sizing:border-box;overflow:auto;">' +
        '<div style="display:flex;flex-direction:column;gap:12px;">' +
        '<label style="font-size:12px;color:#a6adc8;">Адрес БД<input id="wm-connUrl" type="text" style="width:100%;margin-top:4px;padding:8px;background:#313244;border:1px solid #45475a;border-radius:5px;color:#cdd6f4;font-family:monospace;"></label>' +
        '<label style="font-size:12px;color:#a6adc8;">Имя БД<input id="wm-connDb" type="text" style="width:100%;margin-top:4px;padding:8px;background:#313244;border:1px solid #45475a;border-radius:5px;color:#cdd6f4;font-family:monospace;"></label>' +
        '<label style="font-size:12px;color:#a6adc8;">Пользователь<input id="wm-connUser" type="text" style="width:100%;margin-top:4px;padding:8px;background:#313244;border:1px solid #45475a;border-radius:5px;color:#cdd6f4;font-family:monospace;"></label>' +
        '<label style="font-size:12px;color:#a6adc8;">Пароль<input id="wm-connPass" type="password" style="width:100%;margin-top:4px;padding:8px;background:#313244;border:1px solid #45475a;border-radius:5px;color:#cdd6f4;font-family:monospace;"></label>' +
        '<div data-role="error" style="color:#f38ba8;font-size:12px;min-height:16px;"></div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">' +
        '<button data-role="cancel" style="padding:8px 18px;background:#585b70;color:#cdd6f4;border:none;border-radius:5px;cursor:pointer;">Отмена</button>' +
        '<button data-role="connect" style="padding:8px 18px;background:#a6e3a1;color:#1e1e2e;border:none;border-radius:5px;cursor:pointer;font-weight:bold;">Подключиться</button>' +
        '</div>' +
        '</div>' +
        '</div>';

    const urlEl = win.bodyEl.querySelector('#wm-connUrl');
    const dbEl = win.bodyEl.querySelector('#wm-connDb');
    const userEl = win.bodyEl.querySelector('#wm-connUser');
    const passEl = win.bodyEl.querySelector('#wm-connPass');
    const errEl = win.bodyEl.querySelector('[data-role="error"]');
    const cancelBtn = win.bodyEl.querySelector('[data-role="cancel"]');
    const connectBtn = win.bodyEl.querySelector('[data-role="connect"]');

    const def = FAR.getConnDefaultsForSide ? FAR.getConnDefaultsForSide(null) : FAR.getDefaultConn();
    urlEl.value = def.url || '';
    dbEl.value = def.db || '';
    userEl.value = def.user || '';
    passEl.value = def.pass || '';

    cancelBtn.onclick = function () { FAR.WM.closeWindow(win.id); };

    connectBtn.onclick = async function () {
        const cfg = {
            url: urlEl.value.trim(),
            db: dbEl.value.trim(),
            user: userEl.value.trim(),
            pass: passEl.value
        };
        if (!cfg.url || !cfg.db) {
            errEl.textContent = 'Укажите URL и имя БД';
            return;
        }
        connectBtn.disabled = true;
        connectBtn.textContent = 'Подключение…';
        errEl.textContent = '';
        try {
            const res = await FAR.connectToDb(cfg);
            FAR.applyConnectionToBoth(cfg, res.db, res.fullUrl);
            FAR.saveConnToLS(cfg);
            FAR.updateAuthUI();
            FAR.setStatus('✅ Подключено: ' + res.fullUrl);
            FAR.toast('Подключение установлено', 'success');

            await FAR.loadFilesForSide('left',  { path: '/', silent: true });
            await FAR.loadFilesForSide('right', { path: '/', silent: true });
            FAR.renderPanel('left',  { skipLoad: true });
            FAR.renderPanel('right', { skipLoad: true });

            FAR.WM.updateTray();
            FAR.WM.closeWindow(win.id);
        } catch (e) {
            errEl.textContent = '❌ ' + (e.message || String(e));
            connectBtn.disabled = false;
            connectBtn.textContent = 'Подключиться';
        }
    };
};

FAR.WM._mountGamepadSetupUI = function (win) {
    FAR.WM._mountNotice(win, '🎮',
        'Настройка джойстика доступна в классическом режиме ' +
        '(кнопка 🎮 в тулбаре).');
};

FAR.WM._mountDebugUI = async function (win) {
    win.bodyEl.innerHTML = '<div style="padding:20px;background:#1e1e2e;color:#cdd6f4;height:100%;box-sizing:border-box;overflow:auto;"><pre data-role="out" style="white-space:pre-wrap;font-size:12px;">Загрузка…</pre></div>';
    const pre = win.bodyEl.querySelector('[data-role="out"]');
    if (!FAR.db) { pre.textContent = 'Нет подключения к БД.'; return; }
    try {
        const all = await FAR.db.allDocs({ include_docs: true, limit: 200 });
        let out = '=== ПЕРВЫЕ 200 ДОКУМЕНТОВ ===\n';
        all.rows.forEach(r => out += r.id + '\n');
        pre.textContent = out;
    } catch (e) {
        pre.textContent = 'Ошибка: ' + e.message;
    }
};

FAR.WM._mountLogUI = function (win) {
    const lines = FAR.progress.logLines || [];
    win.bodyEl.innerHTML = '<pre style="padding:14px;overflow:auto;height:100%;font-size:12px;color:#cdd6f4;box-sizing:border-box;">' +
        (lines.length ? lines.map(l => FAR.escapeHtml(l)).join('\n') : 'Журнал пуст') +
        '</pre>';
};

FAR.WM._mountFilePickerPrompt = function (win, message) {
    win.bodyEl.innerHTML = '';
    const box = document.createElement('div');
    box.style.cssText = 'padding:40px; text-align:center; color:#a6adc8;';
    box.innerHTML =
        '<div style="font-size:60px; margin-bottom:16px;">🗂️</div>' +
        '<div style="font-size:14px; margin-bottom:20px;">' + FAR.escapeHtml(message) + '</div>';

    const btn = document.createElement('button');
    btn.textContent = '📂 Выбрать файл из БД';
    btn.style.cssText = 'padding:10px 24px; background:#4aa3ff; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:13px;';
    btn.onclick = async function () {
        const picked = await FAR.WM.openFileDialog({
            parentId: win.id,
            title: 'Выбор файла',
            side: FAR.activePanel
        });
        if (picked) {
            const appId = win.appId;
            FAR.WM._finalizeViewer(win);
            FAR.WM.closeWindow(win.id, true);
            FAR.WM.openApp(appId, { props: { file: picked, side: FAR.activePanel } });
        }
    };
    box.appendChild(btn);
    win.bodyEl.appendChild(box);
};

FAR.WM._mountNotice = function (win, icon, text) {
    win.bodyEl.innerHTML = '<div style="padding:40px; text-align:center; color:#a6adc8;">' +
        '<div style="font-size:60px; margin-bottom:16px;">' + icon + '</div>' +
        '<div style="font-size:14px;">' + FAR.escapeHtml(text) + '</div></div>';
};

FAR.WM.openFileDialog = function (opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
        const side = opts.side || FAR.activePanel;
        let resolved = false;
        const done = function (val) {
            if (resolved) return;
            resolved = true;
            resolve(val);
        };

        const win = FAR.WM.openWindow({
            title: opts.title || 'Выбор файла из БД',
            icon: '🗂️',
            width: 1000, height: 620,
            appId: 'dbpick',
            modal: !!opts.parentId,
            parentId: opts.parentId || null,
            props: { side: side, filter: opts.filter || null },
            onClose: function () { done(null); }
        });

        FAR.WM._mountFileDialog(win, side, opts).then(function (picked) {
            done(picked || null);
            FAR.WM.closeWindow(win.id, true);
        });
    });
};

FAR.WM._mountFileDialog = async function (win, side, opts) {
    return new Promise(function (resolve) {

        let onKeyDown = null;

        const removeKeyListener = function () {
            if (!onKeyDown) return;
            try { document.removeEventListener('keydown', onKeyDown, true); }
            catch (e) {}
            onKeyDown = null;
        };

        const origOnClose = win.onClose;
        win.onClose = function (w) {
            removeKeyListener();
            if (typeof origOnClose === 'function') {
                try { origOnClose(w); } catch (e) {}
            }
        };

        win.bodyEl.innerHTML = '';
        win.bodyEl.style.display = 'flex';
        win.bodyEl.style.flexDirection = 'row';

        const state = {
            side: side,
            path: '/',
            items: [],
            cursor: -1,
            selected: null,
            previewUrl: null,
            filter: opts.filter || null
        };

        const colList = document.createElement('div');
        colList.className = 'wm-fd-col-list';
        colList.innerHTML =
            '<div class="wm-fd-pathbar" data-role="path">/</div>' +
            '<input type="text" data-role="filter" placeholder="🔍 Фильтр…" style="margin:6px; padding:6px 10px; background:#12121c; border:1px solid #2b2b3c; border-radius:4px; color:#e6e6e6; font-size:12px;">' +
            '<div class="wm-fd-list" data-role="list" tabindex="0"></div>';

        const colPreview = document.createElement('div');
        colPreview.className = 'wm-fd-col-preview';
        colPreview.innerHTML =
            '<div class="wm-fd-preview" data-role="preview"></div>' +
            '<div class="wm-fd-footer">' +
            '<span class="wm-fd-info" data-role="info"></span>' +
            '<button class="wm-fd-cancel" data-role="cancel">Отмена</button>' +
            '<button class="wm-fd-ok" data-role="ok" disabled>Открыть</button>' +
            '</div>';

        win.bodyEl.appendChild(colList);
        win.bodyEl.appendChild(colPreview);

        const pathEl = colList.querySelector('[data-role="path"]');
        const listEl = colList.querySelector('[data-role="list"]');
        const filterEl = colList.querySelector('[data-role="filter"]');
        const previewEl = colPreview.querySelector('[data-role="preview"]');
        const infoEl = colPreview.querySelector('[data-role="info"]');
        const okBtn = colPreview.querySelector('[data-role="ok"]');
        const cancelBtn = colPreview.querySelector('[data-role="cancel"]');

        const saveLastDir = function (path) {
            try {
                localStorage.setItem(FAR.WM.PICKER_LAST_DIR, '/' + FAR.normPath(path));
            } catch (e) {}
        };

        const loadLastDir = function () {
            try {
                return localStorage.getItem(FAR.WM.PICKER_LAST_DIR) || '';
            } catch (e) {
                return '';
            }
        };

        const clearLastDir = function () {
            try { localStorage.removeItem(FAR.WM.PICKER_LAST_DIR); } catch (e) {}
        };

        const getVisible = function () {
            let items = state.items.slice();
            if (state.filter) {
                const q = state.filter.toLowerCase();
                items = items.filter(function (it) {
                    if (it.isFolder) return true;
                    return it.name.toLowerCase().indexOf(q) !== -1;
                });
            }
            return items;
        };

        const goUp = function () {
            const cur = FAR.normPath(state.path);
            if (!cur) return;
            const parts = cur.split('/').filter(Boolean);
            parts.pop();
            const parent = parts.length ? '/' + parts.join('/') : '/';
            loadDir(parent);
        };

        const scrollCursorIntoView = function () {
            if (state.cursor < 0) return;
            const rows = listEl.querySelectorAll('.wm-fd-item');
            if (state.cursor < rows.length) {
                try { rows[state.cursor].scrollIntoView({ block: 'nearest' }); }
                catch (e) {}
            }
        };

        const render = function () {
            pathEl.textContent = state.path;
            listEl.innerHTML = '';

            const items = getVisible();

            if (items.length === 0) state.cursor = -1;
            else if (state.cursor < 0) state.cursor = 0;
            else if (state.cursor >= items.length) state.cursor = items.length - 1;

            items.forEach(function (it, idx) {
                const row = document.createElement('div');
                row.className = 'wm-fd-item' +
                    (idx === state.cursor ? ' focused' : '') +
                    (state.selected && state.selected.path === it.path ? ' selected' : '');

                let icon = '📄';
                if (it._up || it.isFolder) icon = '📁';
                else if (it.isImage) icon = '🖼️';

                row.innerHTML =
                    '<span>' + icon + '</span>' +
                    '<span class="wm-fd-name">' + FAR.escapeHtml(it.name) + '</span>' +
                    '<span class="wm-fd-size">' + (it.isFolder ? '' : FAR.formatSize(it.size)) + '</span>';

                row.onclick = function () {
                    state.cursor = idx;
                    if (it._up) {
                        state.selected = null;
                        goUp();
                    } else if (it.isFolder) {
                        state.selected = null;
                        loadDir(it.path);
                    } else {
                        state.selected = it;
                        loadPreview(it);
                    }
                    render();
                };

                row.ondblclick = function () {
                    if (it._up) {
                        goUp();
                    } else if (it.isFolder) {
                        loadDir(it.path);
                    } else {
                        state.selected = it;
                        resolve(state.selected);
                    }
                };

                listEl.appendChild(row);
            });
        };

        const loadDir = async function (path, opts) {
            opts = opts || {};
            const norm = FAR.normPath(path);
            state.path = '/' + norm;
            state.cursor = -1;
            state.selected = null;
            okBtn.disabled = true;
            infoEl.textContent = '';
            previewEl.innerHTML = '';
            listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#6c7086;">Загрузка…</div>';

            try {
                const children = await FAR.listDirFromSide(state.side, norm, { includeDocs: true });

                state.items = children.map(function (it) {
                    if (it.docType === 'folder' || it.isFolder) {
                        return Object.assign({}, it, {
                            isFolder: true,
                            size: 0
                        });
                    }
                    const ext = (it.name.split('.').pop() || '').toLowerCase();
                    const isImage = ['jpg','jpeg','png','webp','gif','bmp','svg'].indexOf(ext) !== -1;
                    return Object.assign({}, it, {
                        isFolder: false,
                        size: it.size || 0,
                        isImage: isImage,
                        _item: it
                    });
                });

                if (norm !== '') {
                    state.items.unshift({
                        isFolder: true,
                        name: '..',
                        path: '..',
                        size: 0,
                        _up: true
                    });
                }

                state.cursor = getVisible().length > 0 ? 0 : -1;
                render();

                if (!opts.fromFallback) {
                    saveLastDir(norm);
                }
            } catch (e) {
                if (opts.attemptedRestore && norm !== '') {
                    console.warn('[WM picker] сохранённый каталог недоступен:', norm, e.message);
                    clearLastDir();
                    return loadDir('/', { fromFallback: true });
                }

                listEl.innerHTML = '<div style="padding:20px;color:#f38ba8;">Ошибка: ' + FAR.escapeHtml(e.message) + '</div>';
            }
        };

        const loadPreview = async function (item) {
            if (state.previewUrl) {
                try { URL.revokeObjectURL(state.previewUrl); } catch (e) {}
                state.previewUrl = null;
            }
            previewEl.innerHTML = '';
            infoEl.textContent = item.path;
            okBtn.disabled = false;

            if (!item.isImage) {
                previewEl.innerHTML = '<div style="color:#6c7086;padding:20px;">Превью недоступно</div>';
                return;
            }
            try {
                const r = await FAR.readFileBodyFromSide(state.side, item);
                const blob = new Blob([r.data], { type: r.contentType || 'image/jpeg' });
                const url = URL.createObjectURL(blob);
                state.previewUrl = url;
                previewEl.innerHTML = '<img src="' + url + '">';
            } catch (e) {
                previewEl.innerHTML = '<div style="color:#f38ba8;padding:20px;">' + FAR.escapeHtml(e.message) + '</div>';
            }
        };

        cancelBtn.onclick = function () { resolve(null); };
        okBtn.onclick = function () { if (state.selected) resolve(state.selected); };

        filterEl.addEventListener('input', function () {
            state.filter = filterEl.value;
            state.cursor = 0;
            render();
        });

        onKeyDown = function (e) {
            if (FAR.WM.state.activeWindowId !== win.id) return;
            if (!FAR.WM.getWindow(win.id)) {
                removeKeyListener();
                return;
            }

            const inFilter = (e.target === filterEl);
            const visible = getVisible();

            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                resolve(null);
                return;
            }

            if (inFilter) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (state.selected) resolve(state.selected);
                }
                return;
            }

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                e.stopPropagation();
                if (visible.length === 0) return;
                state.cursor = Math.min(visible.length - 1,
                    (state.cursor < 0 ? 0 : state.cursor + 1));
                const it = visible[state.cursor];
                if (it && !it.isFolder) { state.selected = it; loadPreview(it); }
                else if (it) {
                    state.selected = null;
                    previewEl.innerHTML = '';
                    infoEl.textContent = '';
                    okBtn.disabled = true;
                }
                render();
                scrollCursorIntoView();
                return;
            }

            if (e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                if (visible.length === 0) return;
                state.cursor = Math.max(0,
                    (state.cursor < 0 ? 0 : state.cursor - 1));
                const it = visible[state.cursor];
                if (it && !it.isFolder) { state.selected = it; loadPreview(it); }
                else if (it) {
                    state.selected = null;
                    previewEl.innerHTML = '';
                    infoEl.textContent = '';
                    okBtn.disabled = true;
                }
                render();
                scrollCursorIntoView();
                return;
            }

            if (e.key === 'Home') {
                e.preventDefault();
                e.stopPropagation();
                if (visible.length === 0) return;
                state.cursor = 0;
                const it = visible[0];
                if (it && !it.isFolder) { state.selected = it; loadPreview(it); }
                render();
                scrollCursorIntoView();
                return;
            }

            if (e.key === 'End') {
                e.preventDefault();
                e.stopPropagation();
                if (visible.length === 0) return;
                state.cursor = visible.length - 1;
                const it = visible[state.cursor];
                if (it && !it.isFolder) { state.selected = it; loadPreview(it); }
                render();
                scrollCursorIntoView();
                return;
            }

            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                const it = visible[state.cursor];
                if (!it) return;
                if (it._up) {
                    goUp();
                } else if (it.isFolder) {
                    loadDir(it.path);
                } else {
                    state.selected = it;
                    resolve(it);
                }
                return;
            }

            if (e.key === 'Backspace') {
                e.preventDefault();
                e.stopPropagation();
                goUp();
                return;
            }
        };

        document.addEventListener('keydown', onKeyDown, true);

        setTimeout(function () {
            try { listEl.focus(); } catch (e) {}
        }, 50);

        const lastDir = loadLastDir();
        if (lastDir && FAR.normPath(lastDir) !== '') {
            loadDir(lastDir, { attemptedRestore: true });
        } else {
            loadDir('/', { fromFallback: false });
        }
    });
};

FAR.WM._mountFileDialogAsApp = async function (win, props) {
    await FAR.WM._mountFileDialog(win, props.side || FAR.activePanel, {});
};

// ============================================================
// Обёртка ТОЛЬКО на FAR.openFile
// ============================================================

FAR.WM._installOpenFileWrapper = function () {
    if (FAR.WM._openFileWrapped) return;
    FAR.WM._openFileWrapped = true;

    FAR.WM._orig.openFile = FAR.openFile;

    FAR.openFile = async function (item, side, index) {
        if (!FAR.WM.state.active) {
            return FAR.WM._orig.openFile.apply(this, arguments);
        }

        side = side || FAR.activePanel;
        try {
            if (typeof FAR.WM.isFbmp3 === 'function' && FAR.WM.isFbmp3(item)) {
                return FAR.WM.openApp('mp3', {
                    props: { file: item, side: side, playlistPath: item.path }
                });
            }

            if (typeof FAR.isJsdos === 'function' && FAR.isJsdos(item)) {
                return FAR.WM.openApp('jsdos', { props: { file: item, side: side } });
            }

            if (typeof FAR.isNes === 'function' && FAR.isNes(item)) {
                return FAR.WM.openApp('nes', { props: { file: item, side: side } });
            }

            if (typeof FAR.isEmulatorFile === 'function' && FAR.isEmulatorFile(item)) {
                return FAR.WM.openApp('emulator', { props: { file: item, side: side } });
            }

            if (typeof FAR.isMp3 === 'function' && FAR.isMp3(item)) {
                return FAR.WM.openApp('mp3', { props: { file: item, side: side } });
            }

            if (typeof FAR.isVideo === 'function' && FAR.isVideo(item)) {
                return FAR.WM.openApp('video', { props: { file: item, side: side } });
            }

            if (typeof FAR.isPdf === 'function' && FAR.isPdf(item)) {
                return FAR.WM.openApp('pdf', { props: { file: item, side: side } });
            }

            if (typeof FAR.isLbrn2 === 'function' && FAR.isLbrn2(item)) {
                return FAR.WM.openApp('lbrn2', { props: { file: item, side: side } });
            }

            if (typeof FAR.isGcode === 'function' && FAR.isGcode(item)) {
                return FAR.WM.openApp('gcode', { props: { file: item, side: side } });
            }

            if (typeof FAR.isHtmlFile === 'function' && FAR.isHtmlFile(item)) {
                if (typeof FAR.openBrowserFromItem === 'function') {
                    FAR.openBrowserFromItem(item, side);
                    return;
                }
                console.warn('[WM openFile] FAR.openBrowserFromItem не загружен');
            }

            if (typeof FAR.isPanorama === 'function') {
                let isPano = false;
                try { isPano = await FAR.isPanorama(item, side); } catch (e) {}
                if (isPano) {
                    return FAR.WM.openApp('panorama', { props: { file: item, side: side } });
                }
            }

            if (typeof FAR.isTextFile === 'function' && FAR.isTextFile(item)) {
                return FAR.WM.openApp('texteditor', { props: { file: item, side: side } });
            }
        } catch (e) {
            console.warn('[WM openFile] проверка типа:', e);
        }

        return FAR.WM.openApp('viewer', { props: { file: item, side: side } });
    };
};

FAR.WM._openExplorerConnDialog = function (parentWin, side) {
    if (!side) return;

    const dialogWin = FAR.WM.openWindow({
        title: '🔐 Подключение панели (' +
            (side === 'left' ? 'Левая' : 'Правая') + ')',
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

        '<div style="padding:8px 10px;background:#313244;border-left:3px solid #89b4fa;border-radius:4px;font-size:13px;">' +
        '<b style="color:#89b4fa;"></b></div>' +
        '<label style="font-size:12px;color:#a6adc8;">Адрес FileServer' +
        '<input data-role="url" type="text" placeholder="http://127.0.0.1:8080" ' +
        'style="width:100%;margin-top:4px;padding:8px;background:#313244;border:1px solid #45475a;border-radius:5px;color:#cdd6f4;font-family:monospace;"></label>' +

        '<label style="font-size:12px;color:#a6adc8;">Имя пользователя' +
        '<input data-role="user" type="text" placeholder="admin" ' +
        'style="width:100%;margin-top:4px;padding:8px;background:#313244;border:1px solid #45475a;border-radius:5px;color:#cdd6f4;font-family:monospace;"></label>' +

        '<label style="font-size:12px;color:#a6adc8;">Пароль' +
        '<input data-role="pass" type="password" placeholder="••••••••" ' +
        'style="width:100%;margin-top:4px;padding:8px;background:#313244;border:1px solid #45475a;border-radius:5px;color:#cdd6f4;font-family:monospace;"></label>' +

        '<div style="font-size:11px;color:#a6adc8;padding:6px 10px;background:#181825;border-left:2px solid #89b4fa;border-radius:4px;margin-top:4px;">' +
        'Если сервер в локальной сети и недоступен напрямую — соединение пойдёт через прокси текущего сервера автоматически.' +
        '</div>' +

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
    let def = null;
    if (ctx && ctx.conn) def = ctx.conn;
    else if (typeof FAR.getConnDefaultsForSide === 'function') def = FAR.getConnDefaultsForSide(side);
    else if (typeof FAR.getDefaultConn === 'function') def = FAR.getDefaultConn();
    if (!def) def = { url: '', user: '', pass: '' };

    urlEl.value  = def.url  || '';
    userEl.value = def.user || '';
    passEl.value = def.pass || '';

    cancelBtn.onclick = function () { FAR.WM.closeWindow(win.id); };

    connectBtn.onclick = async function () {
        const cfg = {
            url:  urlEl.value.trim(),
            user: userEl.value.trim(),
            pass: passEl.value
        };
        if (!cfg.url) { errEl.textContent = 'Укажите URL FileServer'; return; }

        connectBtn.disabled = true;
        connectBtn.textContent = 'Подключение…';
        errEl.textContent = '';

        let res;
        try {
            res = await FAR.connectToDb(cfg);
        } catch (e) {
            errEl.textContent = '❌ ' + (e.message || String(e));
            connectBtn.disabled = false;
            connectBtn.textContent = 'Подключиться';
            return;
        }

        try {
            FAR.applyConnectionToSide(side, cfg, res.db, res.fullUrl);
        } catch (e) {
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

// ============================================================
// Множественный выбор файлов из БД
// ============================================================

FAR.WM.openFileDialogMulti = function (opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
        const side = opts.side || FAR.activePanel;
        let resolved = false;
        const done = function (val) {
            if (resolved) return;
            resolved = true;
            resolve(val);
        };

        const win = FAR.WM.openWindow({
            title: opts.title || 'Выбор файлов из БД',
            icon: '🗂️',
            width: 1000, height: 680,
            appId: 'dbpick-multi',
            modal: !!opts.parentId,
            parentId: opts.parentId || null,
            props: { side: side, filter: opts.filter || null },
            onClose: function () { done(null); }
        });

        FAR.WM._mountFileDialogMulti(win, side, opts).then(function (picked) {
            done(picked || null);
            FAR.WM.closeWindow(win.id, true);
        });
    });
};

FAR.WM._mountFileDialogMulti = async function (win, side, opts) {
    return new Promise(function (resolve) {

        let onKeyDown = null;
        const removeKeyListener = function () {
            if (!onKeyDown) return;
            try { document.removeEventListener('keydown', onKeyDown, true); }
            catch (e) {}
            onKeyDown = null;
        };
        const origOnClose = win.onClose;
        win.onClose = function (w) {
            removeKeyListener();
            if (typeof origOnClose === 'function') {
                try { origOnClose(w); } catch (e) {}
            }
        };

        win.bodyEl.innerHTML = '';
        win.bodyEl.style.display = 'flex';
        win.bodyEl.style.flexDirection = 'row';

        const state = {
            side: side,
            path: '/',
            items: [],
            cursor: -1,
            ordered: [],
            anchorIdx: -1,
            previewUrl: null,
            filter: opts.filter || null
        };

        const colList = document.createElement('div');
        colList.className = 'wm-fd-col-list';
        colList.innerHTML =
            '<div class="wm-fd-pathbar" data-role="path">/</div>' +
            '<input type="text" data-role="filter" placeholder="🔍 Фильтр…" style="margin:6px; padding:6px 10px; background:#12121c; border:1px solid #2b2b3c; border-radius:4px; color:#e6e6e6; font-size:12px;">' +
            '<div class="wm-fd-list" data-role="list" tabindex="0"></div>';

        const colPreview = document.createElement('div');
        colPreview.className = 'wm-fd-col-preview';
        colPreview.innerHTML =
            '<div class="wm-fd-preview" data-role="preview"></div>' +
            '<div class="wm-fd-footer">' +
            '<span class="wm-fd-info" data-role="info"></span>' +
            '<button class="wm-fd-cancel" data-role="cancel">Отмена</button>' +
            '<button class="wm-fd-ok" data-role="ok" disabled>✓ Выбрать</button>' +
            '</div>';

        win.bodyEl.appendChild(colList);
        win.bodyEl.appendChild(colPreview);

        const pathEl = colList.querySelector('[data-role="path"]');
        const listEl = colList.querySelector('[data-role="list"]');
        const filterEl = colList.querySelector('[data-role="filter"]');
        const previewEl = colPreview.querySelector('[data-role="preview"]');
        const infoEl = colPreview.querySelector('[data-role="info"]');
        const okBtn = colPreview.querySelector('[data-role="ok"]');
        const cancelBtn = colPreview.querySelector('[data-role="cancel"]');

        const saveLastDir = function (path) {
            try {
                localStorage.setItem(FAR.WM.PICKER_LAST_DIR, '/' + FAR.normPath(path));
            } catch (e) {}
        };
        const loadLastDir = function () {
            try { return localStorage.getItem(FAR.WM.PICKER_LAST_DIR) || ''; }
            catch (e) { return ''; }
        };
        const clearLastDir = function () {
            try { localStorage.removeItem(FAR.WM.PICKER_LAST_DIR); } catch (e) {}
        };

        const getVisible = function () {
            let items = state.items.slice();
            if (state.filter) {
                const q = state.filter.toLowerCase();
                items = items.filter(function (it) {
                    if (it.isFolder) return true;
                    return it.name.toLowerCase().indexOf(q) !== -1;
                });
            }
            return items;
        };

        const indexInOrdered = function (path) {
            const norm = FAR.normPath(path);
            for (let i = 0; i < state.ordered.length; i++) {
                if (FAR.normPath(state.ordered[i].path) === norm) return i;
            }
            return -1;
        };

        const addToOrdered = function (item) {
            if (!item || item.isFolder) return false;
            if (indexInOrdered(item.path) >= 0) return false;
            state.ordered.push(item);
            return true;
        };

        const removeFromOrdered = function (path) {
            const idx = indexInOrdered(path);
            if (idx < 0) return false;
            state.ordered.splice(idx, 1);
            return true;
        };

        const goUp = function () {
            const cur = FAR.normPath(state.path);
            if (!cur) return;
            const parts = cur.split('/').filter(Boolean);
            parts.pop();
            const parent = parts.length ? '/' + parts.join('/') : '/';
            loadDir(parent);
        };

        const scrollCursorIntoView = function () {
            if (state.cursor < 0) return;
            const rows = listEl.querySelectorAll('.wm-fd-item');
            if (state.cursor < rows.length) {
                try { rows[state.cursor].scrollIntoView({ block: 'nearest' }); }
                catch (e) {}
            }
        };

        const updateFooter = function () {
            okBtn.disabled = state.ordered.length === 0;
            okBtn.textContent = state.ordered.length > 1
                ? ('✓ Выбрать (' + state.ordered.length + ')')
                : '✓ Выбрать';

            const cur = getVisible()[state.cursor];
            if (cur && !cur.isFolder && !cur._up) {
                infoEl.textContent = cur.path;
            } else if (state.ordered.length > 0) {
                infoEl.textContent = 'Выбрано файлов: ' + state.ordered.length;
            } else {
                infoEl.textContent = '';
            }
        };

        const render = function () {
            pathEl.textContent = state.path;
            listEl.innerHTML = '';

            const items = getVisible();

            if (items.length === 0) state.cursor = -1;
            else if (state.cursor < 0) state.cursor = 0;
            else if (state.cursor >= items.length) state.cursor = items.length - 1;

            items.forEach(function (it, idx) {
                const row = document.createElement('div');
                const isFolder = it._up || it.isFolder;
                const orderIdx = !isFolder ? indexInOrdered(it.path) : -1;

                row.className = 'wm-fd-item' +
                    (idx === state.cursor ? ' focused' : '') +
                    (orderIdx >= 0 ? ' selected' : '');

                let icon = '📄';
                if (it._up || it.isFolder) icon = '📁';
                else if (it.isImage) icon = '🖼️';

                const badge = orderIdx >= 0
                    ? '<span style="display:inline-block;min-width:22px;text-align:center;' +
                    'background:#4aa3ff;color:#1e1e2e;border-radius:3px;padding:0 4px;' +
                    'font-weight:bold;font-size:11px;margin-right:4px;">' +
                    (orderIdx + 1) + '</span>'
                    : '';

                row.innerHTML =
                    '<span>' + icon + '</span>' +
                    '<span class="wm-fd-name">' + badge + FAR.escapeHtml(it.name) + '</span>' +
                    '<span class="wm-fd-size">' + (it.isFolder ? '' : FAR.formatSize(it.size)) + '</span>';

                row.onclick = function (e) {
                    state.cursor = idx;

                    if (it._up) {
                        goUp();
                        return;
                    }
                    if (it.isFolder) {
                        loadDir(it.path);
                        return;
                    }

                    if (e.ctrlKey || e.metaKey) {
                        if (orderIdx >= 0) removeFromOrdered(it.path);
                        else addToOrdered(it);
                        state.anchorIdx = idx;
                    } else if (e.shiftKey && state.anchorIdx >= 0) {
                        const a = Math.min(state.anchorIdx, idx);
                        const b = Math.max(state.anchorIdx, idx);
                        state.ordered = [];
                        for (let i = a; i <= b; i++) {
                            const cand = items[i];
                            if (cand && !cand.isFolder && !cand._up) {
                                addToOrdered(cand);
                            }
                        }
                    } else {
                        state.ordered = [it];
                        state.anchorIdx = idx;
                    }

                    loadPreview(it);
                    render();
                    updateFooter();
                };

                row.ondblclick = function () {
                    if (it._up) {
                        goUp();
                    } else if (it.isFolder) {
                        loadDir(it.path);
                    } else {
                        addToOrdered(it);
                        resolve(state.ordered.slice());
                    }
                };

                listEl.appendChild(row);
            });

            updateFooter();
        };

        const loadDir = async function (path, opts2) {
            opts2 = opts2 || {};
            const norm = FAR.normPath(path);
            state.path = '/' + norm;
            state.cursor = -1;
            state.anchorIdx = -1;
            infoEl.textContent = '';
            previewEl.innerHTML = '';
            listEl.innerHTML = '<div style="padding:20px;text-align:center;color:#6c7086;">Загрузка…</div>';

            try {
                const children = await FAR.listDirFromSide(state.side, norm, { includeDocs: true });

                state.items = children.map(function (it) {
                    if (it.docType === 'folder' || it.isFolder) {
                        return Object.assign({}, it, { isFolder: true, size: 0 });
                    }
                    const ext = (it.name.split('.').pop() || '').toLowerCase();
                    const isImage = ['jpg','jpeg','png','webp','gif','bmp','svg'].indexOf(ext) !== -1;
                    return Object.assign({}, it, {
                        isFolder: false,
                        size: it.size || 0,
                        isImage: isImage,
                        _item: it
                    });
                });

                if (norm !== '') {
                    state.items.unshift({
                        isFolder: true, name: '..', path: '..', size: 0, _up: true
                    });
                }

                state.cursor = getVisible().length > 0 ? 0 : -1;
                render();

                if (!opts2.fromFallback) saveLastDir(norm);
            } catch (e) {
                if (opts2.attemptedRestore && norm !== '') {
                    console.warn('[WM picker multi] сохранённый каталог недоступен:', norm, e.message);
                    clearLastDir();
                    return loadDir('/', { fromFallback: true });
                }
                listEl.innerHTML = '<div style="padding:20px;color:#f38ba8;">Ошибка: ' + FAR.escapeHtml(e.message) + '</div>';
            }
        };

        const loadPreview = async function (item) {
            if (state.previewUrl) {
                try { URL.revokeObjectURL(state.previewUrl); } catch (e) {}
                state.previewUrl = null;
            }
            previewEl.innerHTML = '';
            if (!item || item.isFolder) return;

            if (!item.isImage) {
                previewEl.innerHTML = '<div style="color:#6c7086;padding:20px;text-align:center;">Превью недоступно</div>';
                return;
            }
            try {
                const r = await FAR.readFileBodyFromSide(state.side, item);
                const blob = new Blob([r.data], { type: r.contentType || 'image/jpeg' });
                const url = URL.createObjectURL(blob);
                state.previewUrl = url;
                previewEl.innerHTML = '<img src="' + url + '">';
            } catch (e) {
                previewEl.innerHTML = '<div style="color:#f38ba8;padding:20px;">' + FAR.escapeHtml(e.message) + '</div>';
            }
        };

        cancelBtn.onclick = function () { resolve(null); };
        okBtn.onclick = function () {
            if (state.ordered.length === 0) return;
            resolve(state.ordered.slice());
        };

        filterEl.addEventListener('input', function () {
            state.filter = filterEl.value;
            state.cursor = 0;
            render();
        });

        onKeyDown = function (e) {
            if (FAR.WM.state.activeWindowId !== win.id) return;
            if (!FAR.WM.getWindow(win.id)) {
                removeKeyListener();
                return;
            }

            const inFilter = (e.target === filterEl);
            const visible = getVisible();

            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                resolve(null);
                return;
            }

            if (inFilter) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (state.ordered.length > 0) resolve(state.ordered.slice());
                }
                return;
            }

            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopPropagation();
                if (visible.length === 0) return;
                const dir = e.key === 'ArrowDown' ? 1 : -1;
                state.cursor = Math.max(0, Math.min(visible.length - 1,
                    (state.cursor < 0 ? 0 : state.cursor + dir)));
                const it = visible[state.cursor];
                if (it && !it.isFolder) loadPreview(it);
                render();
                scrollCursorIntoView();
                return;
            }

            if (e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                e.stopPropagation();
                if (visible.length === 0) return;
                state.cursor = e.key === 'Home' ? 0 : visible.length - 1;
                const it = visible[state.cursor];
                if (it && !it.isFolder) loadPreview(it);
                render();
                scrollCursorIntoView();
                return;
            }

            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                const it = visible[state.cursor];
                if (!it) return;
                if (it._up) { goUp(); return; }
                if (it.isFolder) { loadDir(it.path); return; }
                addToOrdered(it);
                if (e.shiftKey || state.ordered.length > 1) {
                    render();
                    updateFooter();
                } else {
                    resolve(state.ordered.slice());
                }
                return;
            }

            if (e.key === 'Backspace') {
                e.preventDefault();
                e.stopPropagation();
                goUp();
                return;
            }
        };

        document.addEventListener('keydown', onKeyDown, true);

        setTimeout(function () {
            try { listEl.focus(); } catch (e) {}
        }, 50);

        const lastDir = loadLastDir();
        if (lastDir && FAR.normPath(lastDir) !== '') {
            loadDir(lastDir, { attemptedRestore: true });
        } else {
            loadDir('/', { fromFallback: false });
        }
    });
};

FAR.WM._mountConsoleViewer = async function (win, props) {
    win.el.querySelector('.wm-title-text').textContent = '🖥 Console';

    if (win.props._consoleApi) {
        try { win.props._consoleApi.destroy(); } catch (e) {}
        win.props._consoleApi = null;
    }

    win.bodyEl.innerHTML = '';
    win.bodyEl.style.display = 'flex';
    win.bodyEl.style.flexDirection = 'column';
    win.bodyEl.style.minHeight = '0';

    win.props._consoleApi = FAR._createConsole(win.bodyEl, {});

    setTimeout(function () {
        const ta = win.bodyEl.querySelector('.xterm-helper-textarea');
        if (ta) try { ta.focus(); } catch (e) {}
    }, 100);
};

FAR.WM._installOpenFileWrapper();