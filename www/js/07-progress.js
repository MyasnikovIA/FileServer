FAR.startProgress = function(icon, title, total, onCancel) {
    const p = FAR.progress;
    if (p.autoCloseTimer) { clearTimeout(p.autoCloseTimer); p.autoCloseTimer = null; }

    p.active = true; p.cancelled = false; p.current = 0; p.total = total;
    p.errors = 0; p.title = title; p.icon = icon; p.logLines = [];
    p.onCancel = onCancel || null; p.minimized = false;

    document.getElementById('progressIcon').textContent = icon;
    document.getElementById('progressTitle').textContent = title;
    document.getElementById('progressDone').textContent = '0';
    document.getElementById('progressTotal').textContent = String(total);
    document.getElementById('progressErrors').textContent = '';
    document.getElementById('progressPercent').textContent = '0%';
    document.getElementById('progressFill').style.width = '0%';
    document.getElementById('progressFill').className = 'progress-bar-fill';
    document.getElementById('progressCurrent').textContent = '—';
    document.getElementById('progressLog').innerHTML = '';
    document.getElementById('progressCancelBtn').disabled = false;
    document.getElementById('progressCancelBtn').style.display = '';
    document.getElementById('progressCloseBtn').disabled = true;
    document.getElementById('progressCloseBtn').style.display = 'none';

    document.getElementById('progressOverlay').classList.remove('hidden');
    document.getElementById('progressMini').classList.add('hidden');

    document.getElementById('miniIcon').textContent = icon;
    document.getElementById('miniTitle').textContent = title;
};

FAR.updateProgress = function(current, total, currentItem, errorCount) {
    const p = FAR.progress;
    p.current = current; p.total = total;
    if (typeof errorCount === 'number') p.errors = errorCount;

    const pct = total > 0 ? Math.round((current / total) * 100) : 0;
    document.getElementById('progressDone').textContent = String(current);
    document.getElementById('progressTotal').textContent = String(total);
    document.getElementById('progressPercent').textContent = pct + '%';
    document.getElementById('progressFill').style.width = pct + '%';

    if (p.errors > 0) {
        document.getElementById('progressErrors').textContent = ` (ошибок: ${p.errors})`;
    } else {
        document.getElementById('progressErrors').textContent = '';
    }

    if (currentItem) document.getElementById('progressCurrent').textContent = currentItem;

    document.getElementById('miniProgress').textContent = `${current} / ${total}`;
    document.getElementById('miniPercent').textContent = pct + '%';
    document.getElementById('miniFill').style.width = pct + '%';
};

FAR.progressLog = function(msg, type) {
    const cls = type || 'info';
    const log = document.getElementById('progressLog');
    const line = document.createElement('div');
    line.className = 'log-line ' + cls;
    const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
    line.textContent = `[${time}] ${msg}`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
    FAR.progress.logLines.push(line.textContent);
};

FAR.finishProgress = function(errorCount) {
    const p = FAR.progress;
    p.active = false;
    if (typeof errorCount === 'number') p.errors = errorCount;

    document.getElementById('progressPercent').textContent = '100%';
    document.getElementById('progressFill').style.width = '100%';

    if (p.errors > 0) {
        document.getElementById('progressFill').className = 'progress-bar-fill error';
        document.getElementById('progressErrors').textContent = ` (ошибок: ${p.errors})`;
    }

    document.getElementById('progressCurrent').textContent = 'Завершено';
    document.getElementById('progressCancelBtn').disabled = true;
    document.getElementById('progressCancelBtn').style.display = 'none';
    document.getElementById('progressCloseBtn').disabled = false;
    document.getElementById('progressCloseBtn').style.display = '';

    document.getElementById('miniProgress').textContent = `${p.current} / ${p.total}`;
    document.getElementById('miniPercent').textContent = '100%';
    document.getElementById('miniFill').style.width = '100%';

    if (p.autoCloseTimer) clearTimeout(p.autoCloseTimer);
    p.autoCloseTimer = setTimeout(function() {
        FAR.closeProgress();
        p.autoCloseTimer = null;
    }, 1200);
};

FAR.cancelProgress = function() {
    const p = FAR.progress;
    if (!p.active) return;
    if (!confirm('Отменить операцию? Уже выполненные действия останутся.')) return;
    p.cancelled = true;
    FAR.progressLog('⛔ Отмена запрошена пользователем', 'warn');
    document.getElementById('progressCancelBtn').disabled = true;
    if (p.onCancel) p.onCancel();
};

FAR.closeProgress = function() {
    const p = FAR.progress;
    if (p.active) return;
    if (p.autoCloseTimer) { clearTimeout(p.autoCloseTimer); p.autoCloseTimer = null; }
    document.getElementById('progressOverlay').classList.add('hidden');
    document.getElementById('progressMini').classList.add('hidden');
};

FAR.minimizeProgress = function() {
    FAR.progress.minimized = true;
    document.getElementById('progressOverlay').classList.add('hidden');
    document.getElementById('progressMini').classList.remove('hidden');
};

FAR.restoreProgress = function() {
    FAR.progress.minimized = false;
    document.getElementById('progressMini').classList.add('hidden');
    document.getElementById('progressOverlay').classList.remove('hidden');
};