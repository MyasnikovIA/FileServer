// ============================================================
// Скачивание выделенных файлов по отдельности (без сжатия).
// ============================================================
//
// ЛЕНИВАЯ ЗАГРУЗКА: функция работает с выделенными элементами
// напрямую — им не нужен обход дерева. Читаем тело из
// конкретной стороны через FAR.readFileBodyFromSide.

FAR.downloadSelectedUncompressed = async function() {
    if (!FAR.ensureDb()) return;

    const side = FAR.activePanel;
    const ctx = FAR.side[side];
    if (!ctx || !ctx.db) { FAR.toast('Панель не подключена', 'warning'); return; }

    const selected = FAR.getSelectedItemsFromActivePanel();
    if (selected.length === 0) { FAR.toast('Ничего не выбрано', 'warning'); return; }

    const filesOnly = selected.filter(x => !x.item.isFolder);
    const foldersCount = selected.length - filesOnly.length;

    if (filesOnly.length === 0) {
        FAR.toast('Выбраны только папки — используйте «Скачать ZIP»', 'warning');
        return;
    }

    if (foldersCount > 0) {
        if (!confirm(`Выбрано ${selected.length} элементов, из них ${foldersCount} папок.\n` +
                     `Папки будут пропущены (используйте «Скачать ZIP» для них).\n` +
                     `Скачать ${filesOnly.length} файлов по отдельности?`)) return;
    }

    FAR.startProgress('📥', `Скачивание ${filesOnly.length} файлов (без сжатия)`, filesOnly.length, function() {});

    let ok = 0, err = 0;
    for (let i = 0; i < filesOnly.length; i++) {
        if (FAR.progress.cancelled) break;
        const item = filesOnly[i].item;
        FAR.updateProgress(i, filesOnly.length, item.name, err);
        FAR.progressLog(`📥 ${item.name}`, 'info');
        try {
            const res = await FAR.readFileBodyFromSide(side, item);
            const blob = new Blob([res.data], { type: res.contentType });
            FAR.saveBlobAs(blob, FAR.sanitizeFileName(item.name));
            ok++;
            FAR.progressLog(`✅ ${item.name} (${FAR.formatSize(res.data.length)})`, 'ok');
            await new Promise(r => setTimeout(r, 250));
        } catch (e) {
            err++;
            FAR.progressLog(`❌ ${item.name}: ${e.message}`, 'err');
        }
        FAR.updateProgress(i + 1, filesOnly.length, item.name, err);
    }

    FAR.finishProgress(err);
    FAR.progressLog(`━━━ Готово: ${ok} скачано, ${err} ошибок`, ok > 0 ? 'ok' : 'err');
    FAR.setStatus(`✅ Скачано: ${ok}, ошибок: ${err}`);
    FAR.toast(`Скачано ${ok} из ${filesOnly.length}`, ok ? 'success' : 'error');
};