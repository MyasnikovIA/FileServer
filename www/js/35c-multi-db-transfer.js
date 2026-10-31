// ============================================================
// 35c-multi-db-transfer.js — server-side copy/move
// ============================================================
//
// Использует /api/server-copy вместо старого /api/copy:
//   • Same server         → mode:'local'  (копирование на сервере)
//   • Разные серверы      → mode:'pull'   (приёмник тянет с источника)
//
// Файлы НЕ проходят через браузер. Браузер только:
//   1. POST /api/server-copy,
//   2. опрашивает /api/server-copy/status,
//   3. логирует прогресс в FAR.startProgress.
//
// Для move исходники удаляются только если копирование полностью
// успешно (err === 0) — чтобы избежать потери данных.
// ============================================================

FAR.transferBetweenSides = async function (mode) {
    const src = FAR.activePanel;
    const dst = src === 'left' ? 'right' : 'left';
    const sSrc = FAR.side[src];
    const sDst = FAR.side[dst];

    if (!sSrc.db) { FAR.toast('Исходная панель не подключена', 'warning'); return; }
    if (!sDst.db) { FAR.toast('Целевая панель не подключена', 'warning'); return; }

    const selected = FAR.getSelectedItemsFromActivePanel();
    if (selected.length === 0) { FAR.toast('Ничего не выбрано', 'warning'); return; }

    const items = selected.map(function (s) { return s.item; });
    return FAR.transferBetweenContexts(sSrc, sDst, items, sDst.path, mode);
};

FAR.transferBetweenContexts = async function (sSrc, sDst, items, targetPath, mode) {
    if (!sSrc || !sSrc.db) { FAR.toast('Источник не подключён', 'warning'); return; }
    if (!sDst || !sDst.db) { FAR.toast('Цель не подключена', 'warning'); return; }

    // Сравниваем реальные URL (в обход прокси) — иначе две панели
    // к одному серверу через разные прокси-URL казались бы разными.
    const srcRealUrl = sSrc.db._originalUrl || sSrc.db.baseUrl;
    const dstRealUrl = sDst.db._originalUrl || sDst.db.baseUrl;
    const sameServer = (srcRealUrl === dstRealUrl);

    if (sameServer) {
        return FAR._transferSameServerViaServerCopy(mode, items, sSrc, sDst, targetPath);
    }
    FAR._warnIfUnreachableUrl(srcRealUrl, 'Источник');
    FAR._warnIfUnreachableUrl(dstRealUrl, 'Приёмник');
    return FAR._transferCrossServerViaServerCopy(mode, items, sSrc, sDst, targetPath);
};

// ============================================================
// Обёртки над /api/server-copy
// ============================================================

FAR._serverCopyStart = async function (serverDb, request) {
    const res = await serverDb._fetch(serverDb._url('/api/server-copy'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
    });
    if (!res.ok) {
        const msg = await FAR.FsClient._errorFromResponse(res);
        const e = new Error(msg);
        e.status = res.status;
        throw e;
    }
    return await res.json();
};

FAR._serverCopyStatus = async function (serverDb, taskId) {
    try {
        const url = serverDb._url('/api/server-copy/status', { taskId: taskId });
        const res = await serverDb._fetch(url, { method: 'GET' });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) {
        return null;
    }
};

FAR._serverCopyCancel = async function (serverDb, taskId) {
    try {
        const url = serverDb._url('/api/server-copy/cancel', { taskId: taskId });
        await serverDb._fetch(url, { method: 'POST' });
    } catch (e) { /* ignore */ }
};

/**
 * Опрашивает статус каждые 500 мс, логирует байты в prog.
 * Бросает при status=error/canceled или отмене пользователем.
 */
FAR._serverCopyWait = async function (serverDb, taskId, prog, label) {
    let lastDone = -1, lastTotal = -1;

    while (true) {
        if (prog.state.cancelled) {
            try { await FAR._serverCopyCancel(serverDb, taskId); } catch (e) {}
            throw new Error('Отменено пользователем');
        }

        const st = await FAR._serverCopyStatus(serverDb, taskId);
        if (!st) {
            await new Promise(function (r) { setTimeout(r, 1000); });
            continue;
        }

        if (st.bytesDone !== lastDone || st.bytesTotal !== lastTotal) {
            lastDone  = st.bytesDone;
            lastTotal = st.bytesTotal;
            const totalStr = lastTotal > 0 ? FAR.formatSize(lastTotal) : '—';
            prog.log('📊 ' + label + ': ' + FAR.formatSize(lastDone) +
                ' / ' + totalStr, 'info');
        }

        if (st.status === 'done')     return st;
        if (st.status === 'error')    throw new Error(st.error || 'Ошибка копирования на сервере');
        if (st.status === 'canceled') throw new Error('Отменено');

        await new Promise(function (r) { setTimeout(r, 500); });
    }
};

// ============================================================
// Same server → mode:'local'
// ============================================================

FAR._transferSameServerViaServerCopy = async function (mode, items, sSrc, sDst, targetPath) {
    const actionLabel = mode === 'move' ? 'Перенос' : 'Копирование';
    const serverDb = sDst.db;

    const prog = FAR.startProgress(
        mode === 'move' ? '✂️' : '📋',
        actionLabel + ': ' + items.length + ' элем. (сервер)',
        items.length,
        function () {}
    );
    await FAR._nextPaint();

    let ok = 0, err = 0;

    for (let i = 0; i < items.length; i++) {
        if (prog.state.cancelled) break;

        const item     = items[i];
        const srcPath  = FAR.normPath(item.path);
        const itemName = item.name || srcPath.split('/').pop();
        const dstPath  = FAR.normPath(targetPath ? targetPath + '/' + itemName : itemName);

        prog.update(i, items.length, srcPath, err);
        prog.log('📋 ' + srcPath + ' → ' + dstPath, 'info');

        try {
            const { taskId } = await FAR._serverCopyStart(serverDb, {
                mode:    'local',
                srcPath: srcPath,
                dstPath: dstPath
            });
            prog.log('📡 задача ' + taskId + ' запущена', 'info');

            await FAR._serverCopyWait(serverDb, taskId, prog, srcPath);

            // Move = удалить исходник (серверная операция, атомарна
            // по каждому item — эта копия уже полностью успешна).
            if (mode === 'move') {
                try {
                    const delRes = await serverDb._fetch(
                        serverDb._url('/api/delete', { path: srcPath }),
                        { method: 'DELETE' }
                    );
                    if (!delRes.ok && delRes.status !== 404) {
                        prog.log('⚠ удаление ' + srcPath +
                            ': HTTP ' + delRes.status, 'warn');
                    }
                } catch (e) {
                    prog.log('⚠ удаление ' + srcPath + ': ' + e.message, 'warn');
                }
            }

            ok++;
            prog.log('✅ ' + dstPath, 'ok');
        } catch (e) {
            err++;
            prog.log('❌ ' + srcPath + ': ' + e.message, 'err');
        }

        prog.update(i + 1, items.length, srcPath, err);
    }

    prog.finish(err);
    prog.log('━━━ ' + actionLabel + ': ' + ok + ' из ' + items.length +
        (err ? ', ошибок ' + err : ''), ok > 0 ? 'ok' : 'err');
    FAR.toast(actionLabel + ': ' + ok + ' из ' + items.length,
        ok > 0 ? 'success' : 'error');
};

// ============================================================
// Разные серверы → mode:'pull' на приёмнике
// ============================================================
//
// 1. Клиент рекурсивно перечисляет детей через /api/list источника.
// 2. Создаёт папки на приёмнике через /api/mkdir.
// 3. Для каждого файла запускает pull-задачу:
//        POST /api/server-copy {mode:'pull', srcUrl, srcPath, srcToken, dstPath}
//    Приёмник сам скачивает с источника.
// 4. Move = удалить исходники, ТОЛЬКО если err === 0
//    (иначе оставляем как есть, чтобы не потерять данные).
// ============================================================

FAR._transferCrossServerViaServerCopy = async function (mode, items, sSrc, sDst, targetPath) {
    const actionLabel = mode === 'move' ? 'Перенос' : 'Копирование';
    const sourceSide  = FAR._findSideForDb(sSrc);

    // --- 1. Разворачиваем папки в плоский список ---
    const folderTasks = [];   // { srcPath, dstPath }
    const fileTasks   = [];   // { srcPath, dstPath }

    for (const item of items) {
        const srcPath  = FAR.normPath(item.path);
        const itemName = item.name || srcPath.split('/').pop();
        const dstPath  = FAR.normPath(targetPath ? targetPath + '/' + itemName : itemName);

        if (item.isFolder) {
            folderTasks.push({ srcPath: srcPath, dstPath: dstPath });
            try {
                const children = await FAR.listRecursiveFromSide(sourceSide, srcPath);
                const prefix = srcPath + '/';
                for (const c of children) {
                    const rel = FAR.normPath(c.path).substring(prefix.length);
                    if (!rel) continue;
                    const childDst = FAR.normPath(dstPath + '/' + rel);
                    if (c.isFolder || c.docType === 'folder') {
                        folderTasks.push({ srcPath: c.path, dstPath: childDst });
                    } else {
                        fileTasks.push({ srcPath: c.path, dstPath: childDst });
                    }
                }
            } catch (e) {
                FAR.toast('Ошибка обхода ' + srcPath + ': ' + e.message, 'error');
            }
        } else {
            fileTasks.push({ srcPath: srcPath, dstPath: dstPath });
        }
    }

    const totalSteps = folderTasks.length + fileTasks.length;
    const prog = FAR.startProgress(
        mode === 'move' ? '✂️' : '📋',
        actionLabel + ': ' + items.length + ' элем. (разные серверы)',
        totalSteps,
        function () {}
    );
    await FAR._nextPaint();

    let ok = 0, err = 0, step = 0;

    // --- 2. Создаём папки на приёмнике (родители раньше детей) ---
    folderTasks.sort(function (a, b) { return a.dstPath.length - b.dstPath.length; });

    for (const f of folderTasks) {
        if (prog.state.cancelled) break;
        step++;
        prog.update(step - 1, totalSteps, '📁 ' + f.dstPath, err);

        try {
            const res = await sDst.db._fetch(
                sDst.db._url('/api/mkdir', { path: f.dstPath }),
                { method: 'POST' }
            );
            if (!res.ok) {
                const msg = await FAR.FsClient._errorFromResponse(res);
                const isExists = res.status === 409 || /exist/i.test(msg);
                if (!isExists) throw new Error(msg);
            }
            ok++;
            prog.log('📁 ✅ ' + f.dstPath, 'ok');
        } catch (e) {
            err++;
            prog.log('📁 ❌ ' + f.dstPath + ': ' + e.message, 'err');
        }
        prog.update(step, totalSteps, '📁 ' + f.dstPath, err);
    }

    // --- 3. Копируем файлы через mode:'pull' на приёмнике ---
    const srcRealUrl = sSrc.db._originalUrl || sSrc.db.baseUrl;
    const srcToken   = sSrc.db.token || null;

    for (const t of fileTasks) {
        if (prog.state.cancelled) break;
        step++;
        prog.update(step - 1, totalSteps, t.dstPath, err);
        prog.log('📋 ' + t.srcPath + ' → ' + t.dstPath, 'info');

        try {
            const { taskId } = await FAR._serverCopyStart(sSrc.db, {
                mode:    'push',
                srcPath: t.srcPath,
                dstUrl:  dstRealUrl,
                dstPath: t.dstPath,
                dstToken: sDst.db.token
            });
            await FAR._serverCopyWait(sSrc.db, taskId, prog, t.srcPath);
            prog.log('📡 задача ' + taskId + ' запущена', 'info');

            await FAR._serverCopyWait(sDst.db, taskId, prog, t.srcPath);

            ok++;
            prog.log('✅ ' + t.dstPath, 'ok');
        } catch (e) {
            err++;
            prog.log('❌ ' + t.dstPath + ': ' + e.message, 'err');
        }
        prog.update(step, totalSteps, t.dstPath, err);
    }

    // --- 4. Move: удаляем исходники только при полном успехе ---
    if (mode === 'move') {
        if (prog.state.cancelled) {
            prog.log('✂️ Move отменён — исходники сохранены', 'warn');
        } else if (err > 0) {
            prog.log('⚠ Move: ' + err + ' ошибок копирования — ' +
                'исходники ОСТАВЛЕНЫ, чтобы не потерять данные', 'warn');
        } else if (ok > 0) {
            prog.log('✂️ Удаление исходников…', 'info');

            // 1. Файлы (в любом порядке)
            for (const t of fileTasks) {
                try {
                    await sSrc.db._fetch(
                        sSrc.db._url('/api/delete', { path: t.srcPath }),
                        { method: 'DELETE' }
                    );
                } catch (e) { /* ignore */ }
            }

            // 2. Папки — от самых глубоких к корню
            folderTasks.sort(function (a, b) { return b.srcPath.length - a.srcPath.length; });
            for (const f of folderTasks) {
                try {
                    await sSrc.db._fetch(
                        sSrc.db._url('/api/delete', { path: f.srcPath }),
                        { method: 'DELETE' }
                    );
                } catch (e) { /* ignore */ }
            }
        }
    }

    prog.finish(err);
    prog.log('━━━ ' + actionLabel + ': ' + ok + ' из ' + totalSteps +
        (err ? ', ошибок ' + err : ''), ok > 0 ? 'ok' : 'err');
    FAR.toast(actionLabel + ': ' + ok + ' из ' + totalSteps,
        ok > 0 ? 'success' : 'error');

    if (typeof FAR.reloadPanel === 'function') {
        await FAR.reloadPanel('left');
        await FAR.reloadPanel('right');
    }
};

// ============================================================
// Утилиты
// ============================================================

FAR._findSideForDb = function (db) {
    if (FAR.side.left  && FAR.side.left.db  === db) return 'left';
    if (FAR.side.right && FAR.side.right.db === db) return 'right';
    return FAR.activePanel;
};

/**
 * Предупреждает, если URL локальный — приёмник может не достать
 * источник по такому адресу.
 */
FAR._warnIfUnreachableUrl = function (url, label) {
    if (!url) return;
    try {
        const u = new URL(url);
        const h = u.hostname;
        if (h === '127.0.0.1' || h === 'localhost' ||
            h === '0.0.0.0'   || h === '::1') {
            FAR.toast(
                '⚠ ' + label + ': «' + url + '» — локальный адрес. ' +
                'Прямое серверное копирование может не сработать. ' +
                'Используйте сетевой IP.',
                'warning'
            );
        }
    } catch (e) { /* ignore */ }
};

// Оставлен для совместимости — старое имя используется в других модулях.
FAR._transferIsFatalError = function (e) {
    if (!e) return false;
    if (e.status === 404) return true;
    if (e.status === 507) return true;
    if (e.status === 403) return true;
    const msg = String(e.message || '').toLowerCase();
    return (
        msg.includes('failed to fetch') ||
        msg.includes('not available')   ||
        msg.includes('not found')       ||
        msg.includes('no such')         ||
        msg.includes('share ')          ||
        msg.includes('invalid argument')||
        msg.includes('einval')          ||
        msg.includes('quota exceeded')  ||
        msg.includes('access denied')   ||
        msg.includes('forbidden')
    );
};