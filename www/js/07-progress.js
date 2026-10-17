// ============================================================
// 07-progress.js — модальное окно прогресса операций.
//
// Возможности:
//   • показывается в центре экрана, поверх окон WM (z-index: 99999);
//   • перетаскивается за заголовок (drag);
//   • кнопка ✕ в заголовке: во время работы — «Свернуть»,
//     после завершения — «Закрыть»;
//   • кнопка «▼ Свернуть» превращает окно в мини-индикатор;
//   • мини-индикатор кликом возвращается в полноразмерный вид;
//   • для быстрых операций перед стартом принудительно
//     отдаём кадр браузеру (FAR._nextPaint), чтобы пользователь
//     увидел прогресс-бар хотя бы на один кадр.
// ============================================================

// ============================================================
// Принудительная перерисовка: даём браузеру отрисовать DOM.
// Полезно для мгновенных операций — прогресс-бар не «прыгает»
// из 0% в 100% без визуальной обратной связи.
// ============================================================
FAR._nextPaint = function () {
    return new Promise(function (resolve) {
        requestAnimationFrame(function () {
            setTimeout(resolve, 0);
        });
    });
};

// ============================================================
// Позиция окна прогресса (для drag). Сбрасывается при каждом
// новом запуске операции.
// ============================================================
FAR._progressPos = { x: null, y: null };

// ============================================================
// Устанавливает drag окна прогресса за заголовок.
// Вызывается из startProgress при каждом открытии окна;
// сам обработчик вешается один раз (guard в header._farDragBound).
// ============================================================
FAR._installProgressDrag = function () {
    const overlay = document.getElementById('progressOverlay');
    if (!overlay) return;
    const content = overlay.querySelector('.progress-content');
    const header  = overlay.querySelector('.progress-header');
    if (!content || !header) return;

    header.style.cursor = 'move';
    header.style.userSelect = 'none';

    if (header._farDragBound) {
        // при повторном показе восстанавливаем сохранённую позицию
        if (FAR._progressPos.x !== null) {
            content.style.position = 'fixed';
            content.style.left = FAR._progressPos.x + 'px';
            content.style.top  = FAR._progressPos.y + 'px';
            content.style.margin = '0';
        }
        return;
    }
    header._farDragBound = true;

    header.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        // Не начинаем drag, если клик пришёлся по кнопке
        if (e.target.closest('button')) return;

        const startX = e.clientX;
        const startY = e.clientY;
        const rect = content.getBoundingClientRect();

        // Фиксируем текущие размеры и позицию
        content.style.position = 'fixed';
        content.style.left = rect.left + 'px';
        content.style.top  = rect.top + 'px';
        content.style.width = rect.width + 'px';
        content.style.maxHeight = '80vh';
        content.style.margin = '0';

        const onMove = function (ev) {
            let nx = rect.left + (ev.clientX - startX);
            let ny = rect.top  + (ev.clientY - startY);
            nx = Math.max(0, Math.min(window.innerWidth  - rect.width,  nx));
            ny = Math.max(0, Math.min(window.innerHeight - 40,          ny));
            content.style.left = nx + 'px';
            content.style.top  = ny + 'px';
            FAR._progressPos = { x: nx, y: ny };
        };

        const onUp = function () {
            document.removeEventListener('mousemove', onMove, true);
            document.removeEventListener('mouseup', onUp, true);
        };

        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
    });
};

// ============================================================
// Кнопка ✕ в заголовке:
//   • если операция ещё идёт — сворачиваем (не отменяем!);
//   • если завершена — закрываем окно.
// ============================================================
FAR.closeProgressOrMinimize = function () {
    if (FAR.progress.active) {
        FAR.minimizeProgress();
    } else {
        FAR.closeProgress();
    }
};

// ============================================================
// startProgress — открывает окно операции.
//
// После установки всех значений НЕ вызываем принудительно
// _nextPaint — это делает вызывающий код (transfer, upload)
// через await FAR._nextPaint(). Так модуль остаётся синхронным
// API и не ломает старые вызовы.
// ============================================================
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

    // Сброс позиции drag-окна
    FAR._progressPos = { x: null, y: null };
    const overlay = document.getElementById('progressOverlay');
    const content = overlay ? overlay.querySelector('.progress-content') : null;
    if (content) {
        content.style.position = '';
        content.style.left = '';
        content.style.top = '';
        content.style.width = '';
        content.style.maxHeight = '';
        content.style.margin = '';
    }

    document.getElementById('progressOverlay').classList.remove('hidden');
    document.getElementById('progressMini').classList.add('hidden');

    document.getElementById('miniIcon').textContent = icon;
    document.getElementById('miniTitle').textContent = title;

    // Включаем drag + кнопка закрытия
    FAR._installProgressDrag();
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