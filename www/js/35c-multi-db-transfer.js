// ============================================================
// Мульти-БД: операции между панелями (в т.ч. между разными БД).
// Универсальный transferBetweenSides('copy' | 'move').
// ============================================================
//
// ВАЖНО:
//   • Файлы записываются ОДНИМ запросом PUT /api/write
//     (FsClient.putAttachment). Раньше было два шага:
//     put(пустой_doc) + putAttachment, из-за чего при 507
//     (превышение квоты) на диске оставался пустой файл.
//   • Файловая система работает через атомарную запись:
//     либо файл создан полностью, либо не создан вовсе.

// ============================================================
// Мульти-БД: операции между панелями.
//
// Если обе панели на ОДНОМ сервере — используем серверный
// /api/copy или /api/move (нативный Files.copy / Files.move).
// Это быстрее, атомарнее и корректно считает квоту.
//
// Если серверы разные (или на одном сервере разные токены/сессии,
// дающие разный уровень доступа) — старый путь через
// readFileBodyFromSide + putAttachment (клиентский round-trip).
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

    const sameServer = (sSrc.db.baseUrl && sDst.db.baseUrl &&
        sSrc.db.baseUrl === sDst.db.baseUrl);

    // ============================================================
    // Быстрый путь: один сервер — серверный /api/copy | /api/move
    // ============================================================
    if (sameServer) {
        return FAR._transferViaServerApi(mode, selected, sSrc, sDst, src, dst);
    }

    // ============================================================
    // Медленный путь: разные серверы — читаем и пишем пофайлово
    // ============================================================
    return FAR._transferViaClient(mode, selected, sSrc, sDst, src, dst);
};

// ============================================================
// Быстрый путь: серверный /api/copy | /api/move
// ============================================================
FAR._transferViaServerApi = async function (mode, selected, sSrc, sDst, src, dst) {
    const targetPath = FAR.normPath(sDst.path);
    const actionLabel = mode === 'move' ? 'Перенос' : 'Копирование';
    const endpoint = mode === 'move' ? '/api/move' : '/api/copy';

    // Для каждого выбранного элемента — один POST /api/copy|move
    FAR.startProgress(
        mode === 'move' ? '✂️' : '📋',
        actionLabel + ': ' + selected.length + ' элем. → ' +
        (dst === 'left' ? 'левая' : 'правая') + ' (сервер)',
        selected.length,
        function () {}
    );
    await FAR._nextPaint();

    let ok = 0, err = 0;

    for (let i = 0; i < selected.length; i++) {
        if (FAR.progress.cancelled) break;
        const item = selected[i].item;
        const srcPath = FAR.normPath(item.path);
        const itemName = item.name || srcPath.split('/').pop();
        const dstPath = FAR.normPath(
            targetPath ? targetPath + '/' + itemName : itemName
        );

        FAR.updateProgress(i, selected.length, srcPath, err);
        FAR.progressLog((mode === 'move' ? '✂️ ' : '📋 ') + srcPath, 'info');

        try {
            const url = sDst.db._url(endpoint, { from: srcPath, to: dstPath });
            const res = await sDst.db._fetch(url, { method: 'POST' });
            if (!res.ok) {
                const msg = await FAR.FsClient._errorFromResponse(res);
                const e = new Error(msg);
                e.status = res.status;
                throw e;
            }
            ok++;
            FAR.progressLog('✅ ' + dstPath, 'ok');
        } catch (e) {
            err++;
            FAR.progressLog('❌ ' + srcPath + ': ' + e.message, 'err');
        }
        FAR.updateProgress(i + 1, selected.length, srcPath, err);
    }

    // Сброс выделения и перезагрузка панелей
    if (mode === 'move') {
        sSrc.selectedIdx.clear();
        sSrc.anchor = -1;
        sSrc.cursor = -1;
    }

    FAR.finishProgress(err);
    FAR.progressLog('━━━ Готово: ' + ok + ', ошибок: ' + err, ok > 0 ? 'ok' : 'err');

    await FAR.reloadPanel('left');
    await FAR.reloadPanel('right');

    FAR.setStatus('✅ ' + actionLabel + ': ' + ok + ', ошибок: ' + err);
    FAR.toast(actionLabel + ' ' + ok + ' из ' + selected.length, ok ? 'success' : 'error');
};

// ============================================================
// Медленный путь: разные серверы — read + write через клиент
// ============================================================
FAR._transferViaClient = async function (mode, selected, sSrc, sDst, src, dst) {
    const targetPath = FAR.normPath(sDst.path);

    // Разворачиваем выделение в список задач
    const folderTasks = [];
    const fileTasks   = [];
    const srcItemsToRemove = [];

    for (const sel of selected) {
        const item = sel.item;

        if (item.isFolder) {
            const srcFolderPath = FAR.normPath(item.path);
            const folderName = item.name || srcFolderPath.split('/').pop();
            const dstFolderPath = FAR.normPath(
                targetPath ? targetPath + '/' + folderName : folderName
            );

            folderTasks.push({ srcPath: srcFolderPath, dstPath: dstFolderPath });

            const children = await FAR.listRecursiveFromSide(src, srcFolderPath);
            const prefix = srcFolderPath + '/';

            for (const idxItem of children) {
                const ip = FAR.normPath(idxItem.path);
                if (!ip.startsWith(prefix)) continue;

                const rel = ip.substring(prefix.length);
                const dstPath = FAR.normPath(dstFolderPath + '/' + rel);

                if (idxItem.docType === 'folder' || idxItem.isFolder) {
                    folderTasks.push({ srcPath: ip, dstPath: dstPath });
                } else if (idxItem.docType === 'file' || !idxItem.isFolder) {
                    fileTasks.push({ srcItem: idxItem, srcPath: ip, dstPath: dstPath });
                }
            }
        } else {
            const fileName = item.name;
            const dstPath = FAR.normPath(
                targetPath ? targetPath + '/' + fileName : fileName
            );
            fileTasks.push({ srcItem: item, srcPath: FAR.normPath(item.path), dstPath: dstPath });
        }
    }

    // Убираем дубли папок
    const folderSeen = new Set();
    const uniqueFolders = [];
    for (const f of folderTasks) {
        if (folderSeen.has(f.dstPath)) continue;
        folderSeen.add(f.dstPath);
        uniqueFolders.push(f);
    }
    uniqueFolders.sort(function (a, b) { return a.dstPath.length - b.dstPath.length; });

    const totalSteps = uniqueFolders.length + fileTasks.length;
    const actionLabel = mode === 'move' ? 'Перенос' : 'Копирование';

    FAR.startProgress(
        mode === 'move' ? '✂️' : '📋',
        actionLabel + ': ' + selected.length + ' элем. → ' +
        (dst === 'left' ? 'левая' : 'правая') + ' (разные серверы)',
        totalSteps,
        function () {}
    );
    await FAR._nextPaint();

    let ok = 0, err = 0, step = 0;

    // 1. Папки
    for (const f of uniqueFolders) {
        if (FAR.progress.cancelled) break;
        step++;
        FAR.updateProgress(step - 1, totalSteps, '📁 ' + f.dstPath, err);

        try {
            const docId = 'd:' + encodeURIComponent(f.dstPath);
            const folderName = f.dstPath.split('/').pop();
            let rev = null;
            try { const existing = await sDst.db.get(docId); rev = existing._rev; }
            catch (e) { if (e.status !== 404) throw e; }
            const doc = { _id: docId, type: 'folder', path: f.dstPath, name: folderName, mtime: Date.now() };
            if (rev) doc._rev = rev;
            await sDst.db.put(doc);
            ok++;
            FAR.progressLog('✅ ' + f.dstPath, 'ok');
        } catch (e) {
            err++;
            FAR.progressLog('❌ ' + f.dstPath + ': ' + e.message, 'err');
        }
        FAR.updateProgress(step, totalSteps, '📁 ' + f.dstPath, err);
    }

    // 2. Файлы
    for (let i = 0; i < fileTasks.length; i++) {
        if (FAR.progress.cancelled) break;
        const t = fileTasks[i];
        step++;
        FAR.updateProgress(step - 1, totalSteps, t.dstPath, err);
        FAR.progressLog((mode === 'move' ? '✂️ ' : '📋 ') + t.dstPath, 'info');

        try {
            const res = await FAR.readFileBodyFromSide(src, t.srcItem);
            const blob = new Blob([res.data], { type: res.contentType });
            const newId = 'f:' + encodeURIComponent(t.dstPath);
            await sDst.db.putAttachment(newId, 'b', null, blob,
                res.contentType || 'application/octet-stream');

            if (mode === 'move') srcItemsToRemove.push(t.srcItem._id);
            ok++;
            FAR.progressLog('✅ ' + t.dstPath, 'ok');
        } catch (e) {
            err++;
            FAR.progressLog('❌ ' + t.dstPath + ': ' + e.message, 'err');
        }
        FAR.updateProgress(step, totalSteps, t.dstPath, err);
    }

    // 3. Для move — удаление из источника
    if (mode === 'move' && !FAR.progress.cancelled && srcItemsToRemove.length > 0) {
        FAR.progressLog('🗑️ Удаление из источника: ' + srcItemsToRemove.length + ' док.', 'info');
        for (const srcId of srcItemsToRemove) {
            try {
                const doc = await sSrc.db.get(srcId);
                await sSrc.db.remove(doc);
            } catch (e) {
                err++;
                FAR.progressLog('⚠️ не удалён ' + srcId + ': ' + e.message, 'warn');
            }
        }
        const folderIdsToRemove = selected
            .filter(function (sel) { return sel.item.isFolder; })
            .map(function (sel) { return sel.item._id; });
        folderIdsToRemove.sort(function (a, b) { return b.length - a.length; });
        for (const fid of folderIdsToRemove) {
            try { const doc = await sSrc.db.get(fid); await sSrc.db.remove(doc); }
            catch (e) { /* уже удалена */ }
        }
        sSrc.selectedIdx.clear();
        sSrc.anchor = -1;
        sSrc.cursor = -1;
    }

    FAR.finishProgress(err);
    FAR.progressLog('━━━ Готово: ' + ok + ', ошибок: ' + err, ok > 0 ? 'ok' : 'err');

    await FAR.reloadPanel('left');
    await FAR.reloadPanel('right');

    FAR.setStatus('✅ ' + actionLabel + ': ' + ok + ', ошибок: ' + err);
    FAR.toast(actionLabel + ' ' + ok + ' из ' + totalSteps, ok ? 'success' : 'error');
};