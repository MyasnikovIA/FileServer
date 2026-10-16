// ============================================================
// Drag&drop файлов/папок из Проводника в панель.
// ============================================================
//
// ЛЕНИВАЯ ЗАГРУЗКА: после загрузки панель перечитывает свою
// директорию через FAR.reloadPanel.

FAR._dragCounter = 0;

FAR.getDropTargetPath = function(panelId) {
    const side = panelId === 'panelLeft' ? 'left' : 'right';
    const ctx = FAR.side[side];
    return ctx ? ctx.path : '/';
};

FAR.setupPanelDragDrop = function(panelId) {
    const panel = document.getElementById(panelId);
    if (!panel) return;

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function(evt) {
        document.addEventListener(evt, function(e) {
            if (e.target.closest && e.target.closest('.panel')) return;
            e.preventDefault();
        });
    });

    panel.addEventListener('dragenter', function(e) {
        e.preventDefault();
        e.stopPropagation();
        FAR._dragCounter++;
        if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
            panel.classList.add('drag-over');
            const hint = panel.querySelector('.drop-path');
            if (hint) hint.textContent = FAR.getDropTargetPath(panelId);
        }
    });

    panel.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        if (!panel.classList.contains('drag-over') &&
            e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
            panel.classList.add('drag-over');
            const hint = panel.querySelector('.drop-path');
            if (hint) hint.textContent = FAR.getDropTargetPath(panelId);
        }
    });

    panel.addEventListener('dragleave', function(e) {
        e.preventDefault();
        e.stopPropagation();
        FAR._dragCounter--;
        if (FAR._dragCounter <= 0) {
            FAR._dragCounter = 0;
            panel.classList.remove('drag-over');
        }
    });

    panel.addEventListener('drop', async function(e) {
        e.preventDefault();
        e.stopPropagation();
        FAR._dragCounter = 0;
        panel.classList.remove('drag-over');

        if (!FAR.ensureDb()) return;

        const targetPath = FAR.getDropTargetPath(panelId);
        const files = await FAR.collectFilesFromDataTransfer(e.dataTransfer);

        if (files.length === 0) {
            FAR.toast('Не удалось получить файлы из перетаскивания', 'warning');
            return;
        }

        FAR.setActivePanel(panelId === 'panelLeft' ? 'left' : 'right');
        await FAR.uploadFilesToPath(files, targetPath);
    });
};

FAR.collectFilesFromDataTransfer = async function(dataTransfer) {
    const result = [];
    if (!dataTransfer) return result;

    if (dataTransfer.items && dataTransfer.items.length > 0) {
        const items = Array.from(dataTransfer.items);
        const hasEntries = items.some(it => typeof it.webkitGetAsEntry === 'function');

        if (hasEntries) {
            const promises = items.map(function(it) {
                if (typeof it.webkitGetAsEntry !== 'function') return Promise.resolve();
                const entry = it.webkitGetAsEntry();
                if (!entry) return Promise.resolve();
                return FAR.traverseEntry(entry, '', result);
            });
            await Promise.all(promises);
            return result;
        }
    }

    if (dataTransfer.files && dataTransfer.files.length > 0) {
        for (const file of Array.from(dataTransfer.files)) {
            result.push({
                name: file.name,
                blob: file,
                contentType: file.type || 'application/octet-stream',
                relativePath: ''
            });
        }
    }

    return result;
};

FAR.traverseEntry = function(entry, relativePath, result) {
    return new Promise(function(resolve) {
        if (entry.isFile) {
            entry.file(function(file) {
                result.push({
                    name: file.name,
                    blob: file,
                    contentType: file.type || 'application/octet-stream',
                    relativePath: relativePath
                });
                resolve();
            }, function(err) {
                console.warn('file error:', entry.name, err);
                resolve();
            });
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            const allEntries = [];

            const readBatch = function() {
                reader.readEntries(function(entries) {
                    if (entries.length === 0) {
                        const newRelative = relativePath
                            ? relativePath + '/' + entry.name
                            : entry.name;
                        Promise.all(allEntries.map(function(e) {
                            return FAR.traverseEntry(e, newRelative, result);
                        })).then(function() { resolve(); });
                        return;
                    }
                    allEntries.push(...entries);
                    readBatch();
                }, function(err) {
                    console.warn('readEntries error:', entry.name, err);
                    resolve();
                });
            };
            readBatch();
        } else {
            resolve();
        }
    });
};