// ============================================================
// 51-console.js — встроенный терминал Console.
// ============================================================
//
// Открывается:
//   • в панельном режиме  — как модалка на весь экран;
//   • в оконном режиме WM — как обычное WM-окно.
//
// Обмен с сервером:
//   • EventSource  на /api/console/events?token=…  — получаем вывод;
//   • POST         на /api/console/exec            — отправляем команду.
//
// Регистрация приложения в WM выполняется динамически
// (после логина) через FAR.WM.registerConsoleApp() — только
// если сервер вернул console:true в /api/info.
// ============================================================

// ------------------------------------------------------------
// Публичный вход
// ------------------------------------------------------------
FAR.WM = FAR.WM || {};

FAR.openConsole = function (opts) {
    opts = opts || {};

    if (!FAR.consoleEnabled) {
        FAR.toast('Console недоступен для этого пользователя', 'warning');
        return;
    }

    // ---- WM ----
    if (typeof FAR.WM !== 'undefined' && FAR.WM.state && FAR.WM.state.active) {
        return FAR.WM.openApp('console');
    }

    // ---- Модалка ----
    FAR._openConsoleModal();
};

FAR._openConsoleModal = function () {
    const modal = document.getElementById('consoleModal');
    const host  = document.getElementById('consoleModalHost');
    if (!modal || !host) {
        console.error('[console] #consoleModal/#consoleModalHost не найдены');
        FAR.toast('Модалка Console не найдена', 'error');
        return;
    }

    if (FAR._consoleModalApi) {
        try { FAR._consoleModalApi.destroy(); } catch (e) {}
        FAR._consoleModalApi = null;
    }

    FAR._consoleModalApi = FAR._createConsole(host, {});

    modal.classList.remove('hidden');

    setTimeout(function () {
        const inp = host.querySelector('.console-input');
        if (inp) inp.focus();
    }, 50);
};

FAR.closeConsole = function () {
    const modal = document.getElementById('consoleModal');
    if (modal) modal.classList.add('hidden');
    if (FAR._consoleModalApi) {
        try { FAR._consoleModalApi.destroy(); } catch (e) {}
        FAR._consoleModalApi = null;
    }
};

FAR.closeConsoleOutside = function (e) {
    if (e.target === e.currentTarget) FAR.closeConsole();
};

// ------------------------------------------------------------
// ЯДРО: FAR._createConsole(hostEl, opts)
// ------------------------------------------------------------
//
// Строит UI и подключает EventSource. Возвращает API-объект.

// ------------------------------------------------------------
// ЯДРО: FAR._createConsole(hostEl, opts)
// ------------------------------------------------------------
//
// Строит UI и подключает EventSource. Возвращает API-объект.

FAR._createConsole = function (hostEl, opts) {
    if (!hostEl) throw new Error('_createConsole: hostEl required');
    opts = opts || {};

    // ---- Разметка ----
    hostEl.innerHTML =
        '<div class="console-toolbar">' +
        '<div class="console-status loading" data-role="status">' +
        '<span class="dot"></span>' +
        '<span data-role="statusText">Подключение…</span>' +
        '</div>' +
        '<button class="console-btn" data-role="copy" title="Скопировать весь диалог в буфер обмена">📋 Скопировать</button>' +
        '<button class="console-btn" data-role="clear" title="Очистить">🧹 Очистить</button>' +
        '<button class="console-btn" data-role="kill" title="Прервать текущую команду">⛔ Прервать</button>' +
        '<button class="console-btn" data-role="disconnect" title="Разорвать соединение">🔌 Отключиться</button>' +
        '</div>' +
        '<div class="console-body">' +
        '<pre class="console-output" data-role="output"></pre>' +
        '</div>' +
        '<div class="console-inputbar">' +
        '<span class="console-prompt">$</span>' +
        '<input type="text" class="console-input" data-role="input" ' +
        'placeholder="Введите команду и нажмите Enter…" ' +
        'autocomplete="off" spellcheck="false">' +
        '</div>';

    const $ = (sel) => hostEl.querySelector(sel);
    const elStatus    = $('[data-role="status"]');
    const elStatusTxt = $('[data-role="statusText"]');
    const elCopy      = $('[data-role="copy"]');
    const elClear     = $('[data-role="clear"]');
    const elKill      = $('[data-role="kill"]');
    const elDisc      = $('[data-role="disconnect"]');
    const elOutput    = $('[data-role="output"]');
    const elInput     = $('[data-role="input"]');

    // ---- Состояние ----
    const S = {
        es: null,
        connected: false,
        destroyed: false,
        history: [],
        historyIdx: -1,
        busy: false
    };

    // ---- Утилиты ----
    function setStatus(text, cls) {
        elStatusTxt.textContent = text || '';
        elStatus.className = 'console-status' + (cls ? ' ' + cls : '');
    }

    function appendLine(text, cls) {
        const span = document.createElement('span');
        span.className = 'line-' + (cls || 'stdout');
        span.textContent = text;
        elOutput.appendChild(span);

        const nearBottom = (elOutput.scrollHeight - elOutput.scrollTop - elOutput.clientHeight) < 40;
        if (nearBottom) elOutput.scrollTop = elOutput.scrollHeight;
    }

    // ---- Копирование диалога в буфер обмена ----
    function copyTranscript() {
        // Берём весь текст из output (там уже есть и эхо команд "$ cmd",
        // которое присылает сервер, и весь вывод, и сообщения об ошибках).
        const text = (elOutput.innerText || elOutput.textContent || '');
        if (!text.trim()) {
            FAR.toast('Нечего копировать', 'info');
            return;
        }

        const done = function () {
            FAR.toast('Диалог скопирован в буфер обмена', 'success');
            // Небольшая визуальная обратная связь
            const old = elCopy.textContent;
            elCopy.textContent = '✓ Скопировано';
            setTimeout(function () { elCopy.textContent = old; }, 1200);
        };

        const fallback = function () {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-99999px;top:-99999px;';
            document.body.appendChild(ta);
            ta.select();
            let ok = false;
            try { ok = document.execCommand('copy'); } catch (e) {}
            document.body.removeChild(ta);
            if (ok) done();
            else FAR.toast('Не удалось скопировать', 'error');
        };

        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(text).then(done).catch(fallback);
        } else {
            fallback();
        }
    }

    // ---- EventSource ----
    function connect() {
        if (S.destroyed) return;

        const ctx = FAR.side && FAR.side[FAR.activePanel];
        const baseUrl = (ctx && ctx.conn && ctx.conn.url)
            ? String(ctx.conn.url).replace(/\/+$/, '')
            : location.origin;

        const token = FAR.authToken || FAR.readCookieToken();
        if (!token) {
            setStatus('Нет токена', 'error');
            appendLine('✗ Не авторизован. Войдите заново.\n', 'error');
            return;
        }

        const url = baseUrl + '/api/console/events?token=' + encodeURIComponent(token);
        setStatus('Подключение…', 'loading');

        const es = new EventSource(url);
        S.es = es;

        es.addEventListener('ready', function (e) {
            S.connected = true;
            setStatus('Подключено', 'online');
            try {
                const data = JSON.parse(e.data);
                appendLine('✓ Console готова. Пользователь: ' + data.user + '\n', 'system');
                if (data.cwd) appendLine('✓ Рабочий каталог: ' + data.cwd + '\n', 'system');
            } catch (err) { /* ignore */ }
        });

        es.addEventListener('output', function (e) {
            let data;
            try { data = JSON.parse(e.data); }
            catch (err) { return; }
            const stream = data.stream || 'stdout';
            const text = data.text || '';
            appendLine(text, stream);
        });

        es.addEventListener('exit', function (e) {
            let data;
            try { data = JSON.parse(e.data); } catch (err) { data = {}; }
            appendLine('── exit ' + (data.code | 0) + ' ──\n', 'exit');
            S.busy = false;
        });

        es.addEventListener('error', function (e) {
            if (e.data) {
                try {
                    const d = JSON.parse(e.data);
                    if (d.error) appendLine('✗ ' + d.error + '\n', 'error');
                } catch (err) { /* ignore */ }
                return;
            }
            if (S.connected) {
                setStatus('Переподключение…', 'loading');
                S.connected = false;
            }
        });

        es.onerror = function () {
            if (S.destroyed) return;
            if (S.connected) {
                setStatus('Соединение потеряно', 'error');
                S.connected = false;
            }
        };
    }

    function disconnect() {
        if (S.es) {
            try { S.es.close(); } catch (e) {}
            S.es = null;
        }
        S.connected = false;
        setStatus('Отключено', 'error');
        appendLine('✗ Соединение закрыто пользователем.\n', 'system');
    }

    // ---- Отправка команды ----
    async function sendCommand(command) {
        if (!command || !command.trim()) return;

        const ctx = FAR.side && FAR.side[FAR.activePanel];
        const baseUrl = (ctx && ctx.conn && ctx.conn.url)
            ? String(ctx.conn.url).replace(/\/+$/, '')
            : location.origin;

        const token = FAR.authToken || FAR.readCookieToken();
        if (!token) {
            FAR.toast('Нет токена', 'error');
            return;
        }

        S.busy = true;

        try {
            const res = await fetch(baseUrl + '/api/console/exec', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + token
                },
                body: JSON.stringify({ command: command })
            });

            if (!res.ok) {
                const body = await res.text().catch(() => '');
                appendLine('✗ Ошибка отправки: HTTP ' + res.status + ' ' + body + '\n', 'error');
                S.busy = false;
            }
        } catch (e) {
            appendLine('✗ Сеть: ' + e.message + '\n', 'error');
            S.busy = false;
        }
    }

    // ---- Поле ввода ----
    elInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            const cmd = elInput.value;
            elInput.value = '';
            if (cmd.trim()) {
                S.history.push(cmd);
                S.historyIdx = S.history.length;
                sendCommand(cmd);
            }
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (S.history.length === 0) return;
            if (S.historyIdx > 0) S.historyIdx--;
            elInput.value = S.history[S.historyIdx] || '';
            setTimeout(() => {
                elInput.selectionStart = elInput.selectionEnd = elInput.value.length;
            }, 0);
            return;
        }
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (S.history.length === 0) return;
            if (S.historyIdx < S.history.length - 1) {
                S.historyIdx++;
                elInput.value = S.history[S.historyIdx] || '';
            } else {
                S.historyIdx = S.history.length;
                elInput.value = '';
            }
            return;
        }
    });

    // ---- Кнопки ----
    elCopy.addEventListener('click', copyTranscript);

    elClear.addEventListener('click', function () {
        elOutput.innerHTML = '';
    });

    elKill.addEventListener('click', function () {
        FAR.toast('Функция «Прервать» пока не поддерживается сервером', 'info');
    });

    elDisc.addEventListener('click', function () {
        disconnect();
    });

    // ---- Старт ----
    connect();

    // ---- API ----
    return {
        getState: function () { return S; },
        copyTranscript: copyTranscript,
        destroy: function () {
            S.destroyed = true;
            if (S.es) { try { S.es.close(); } catch (e) {} S.es = null; }
        }
    };
};

// ------------------------------------------------------------
// Инициализация
// ------------------------------------------------------------

FAR.initConsole = function () {
    // ESC — закрыть модалку
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        const modal = document.getElementById('consoleModal');
        if (!modal || modal.classList.contains('hidden')) return;
        const t = e.target;
        const tag = (t && t.tagName) || '';
        if (tag === 'TEXTAREA') return;   // не мешаем многострочному вводу
        FAR.closeConsole();
    }, true);
};

// ------------------------------------------------------------
// Динамическая регистрация в WM (после логина)
// ------------------------------------------------------------

FAR.WM.registerConsoleApp = function () {
    if (FAR.WM.getApp && FAR.WM.getApp('console')) return;   // уже есть

    // На момент ВЫЗОВА (после логина) все модули уже загружены —
    // FAR.WM.registerApp и FAR.WM.getApp гарантированно доступны.
    if (typeof FAR.WM.registerApp !== 'function') {
        console.warn('[console] FAR.WM.registerApp ещё не готов');
        return;
    }

    FAR.WM.registerApp({
        id: 'console',
        title: 'Console',
        icon: '🖥',
        keywords: 'консоль терминал shell command console',
        singleton: true,
        width: 900,
        height: 600,
        open: async function (win, props) {
            await FAR.WM._mountConsoleViewer(win, props);
        },
        onClose: function (win) {
            if (win.props && win.props._consoleApi) {
                try { win.props._consoleApi.destroy(); } catch (e) {}
                win.props._consoleApi = null;
            }
        }
    });
};


FAR.WM.unregisterConsoleApp = function () {
    if (FAR.WM._apps && FAR.WM._apps['console']) {
        delete FAR.WM._apps['console'];
    }
    // На случай, если окно уже открыто — закрываем
    if (FAR.WM.state && FAR.WM.state.windows) {
        FAR.WM.state.windows
            .filter(w => w.appId === 'console')
            .forEach(w => {
                try { FAR.WM.closeWindow(w.id, true); } catch (e) {}
            });
    }
};