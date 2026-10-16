// ============================================================
// Загрузка файлов и папок в текущую директорию панели.
// ============================================================
//
// ЛЕНИВАЯ ЗАГРУЗКА: после операции перечитываем директорию
// через FAR.reloadPanel(side), а не перерисовываем из
// глобального fileIndex.

FAR.uploadFilesToPath = async function(files, targetPath) {
    if (!FAR.ensureDb()) return { ok: 0, err: 0 };
    if (!files.length) return { ok: 0, err: 0 };

    const side = FAR.activePanel;
    const ctx = FAR.side[side];
    if (!ctx || !ctx.db) { FAR.toast('Панель не подключена', 'warning'); return { ok: 0, err: 0 }; }

    const baseTarget = FAR.normPath(targetPath);
    const targetName = baseTarget === '' ? 'корень' : baseTarget;

    const foldersToCreate = new Set();
    for (const f of files) {
        const rel = FAR.normPath(f.relativePath || '');
        if (!rel) continue;
        const parts = rel.split('/').filter(Boolean);
        let acc = '';
        for (const p of parts) { acc = acc ? acc + '/' + p : p; foldersToCreate.add(acc); }
    }

    const totalSteps = foldersToCreate.size + files.length;

    FAR.startProgress(
        '📤',
        `Загрузка ${files.length} файлов${foldersToCreate.size ? ` + ${foldersToCreate.size} папок` : ''} в "${targetName}"`,
        totalSteps,
        function() {}
    );

    let ok = 0, err = 0, step = 0;

    const sortedFolders = Array.from(foldersToCreate).sort((a, b) => a.length - b.length);
    for (const relFolder of sortedFolders) {
        if (FAR.progress.cancelled) break;
        step++;
        const fullPath = FAR.normPath(baseTarget === '' ? relFolder : baseTarget + '/' + relFolder);
        const docId = 'd:' + encodeURIComponent(fullPath);
        const folderName = relFolder.split('/').pop();
        FAR.updateProgress(step - 1, totalSteps, `📁 ${fullPath}`, err);

        try {
            let rev = null;
            try { const existing = await ctx.db.get(docId); rev = existing._rev; }
            catch (e) { if (e.status !== 404) throw e; }
            const doc = { _id: docId, type: 'folder', path: fullPath, name: folderName, mtime: Date.now() };
            if (rev) doc._rev = rev;
            await ctx.db.put(doc);
            FAR.progressLog(`📁 ✅ ${fullPath}`, 'ok');
        } catch (e) {
            err++;
            FAR.progressLog(`📁 ❌ ${fullPath}: ${e.message}`, 'err');
        }
    }

    for (let i = 0; i < files.length; i++) {
        if (FAR.progress.cancelled) break;
        const f = files[i]; step++;
        const rel = FAR.normPath(f.relativePath || '');
        const parts = [];
        if (baseTarget) parts.push(baseTarget);
        if (rel) parts.push(rel);
        parts.push(f.name);
        const cleanPath = FAR.normPath(parts.filter(Boolean).join('/'));
        FAR.updateProgress(step - 1, totalSteps, cleanPath, err);
        FAR.progressLog(`↑ ${cleanPath} (${FAR.formatSize(f.blob.size)})`, 'info');

        try {
            const arrayBuffer = await f.blob.arrayBuffer();
            const data = new Uint8Array(arrayBuffer);
            const contentType = f.contentType || f.blob.type || 'application/octet-stream';
            const docId = 'f:' + encodeURIComponent(cleanPath);

            let rev = null;
            try { const existing = await ctx.db.get(docId); rev = existing._rev; }
            catch (e) { if (e.status !== 404) throw e; }

            const doc = {
                _id: docId, type: 'file', path: cleanPath, name: f.name,
                size: data.length, mtime: Date.now(),
                binary: !contentType.startsWith('text'), contentType
            };
            if (rev) doc._rev = rev;
            await ctx.db.put(doc);
            const fresh = await ctx.db.get(docId);
            await ctx.db.putAttachment(docId, 'b', fresh._rev, f.blob, contentType);

            ok++;
            FAR.progressLog(`✅ ${cleanPath}`, 'ok');
        } catch (e) {
            err++;
            FAR.progressLog(`❌ ${f.name}: ${e.message}`, 'err');
        }
        FAR.updateProgress(step, totalSteps, cleanPath, err);
    }

    FAR.finishProgress(err);
    FAR.progressLog(`━━━ Готово: ${ok} файлов, ${foldersToCreate.size} папок, ${err} ошибок`, ok > 0 ? 'ok' : 'err');

    await FAR.reloadPanel(side);
    FAR.setStatus(`✅ Загружено: ${ok} файлов, ${err} ошибок`);
    FAR.toast(`Загружено ${ok} файлов, ${err} ошибок`, ok ? 'success' : 'error');
    return { ok, err };
};

FAR.uploadFile = function() {
    if (!FAR.ensureDb()) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async function(e) {
        const files = Array.from(e.target.files);
        if (!files.length) return;
        const side = FAR.activePanel;
        const ctx = FAR.side[side];
        const targetPath = ctx ? ctx.path : '/';
        const converted = files.map(function(f) {
            return {
                name: f.name, blob: f,
                contentType: f.type || 'application/octet-stream',
                relativePath: ''
            };
        });
        await FAR.uploadFilesToPath(converted, targetPath);
    };
    input.click();
};