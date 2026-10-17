// ============================================================
// 51-console.js — встроенный терминал Console (xterm.js + PTY)
// ============================================================

FAR.WM = FAR.WM || {};

FAR._consoleXtermLoaded = false;
FAR._xtermLoadingPromise = null;

FAR._loadXterm = function() {
    if (window.Terminal && window.FitAddon) return Promise.resolve();
    if (FAR._consoleXtermLoaded) return Promise.resolve();
    if (FAR._xtermLoadingPromise) return FAR._xtermLoadingPromise;

    FAR._xtermLoadingPromise = new Promise(function(resolve, reject) {
        // Подключаем локальный CSS из lib/xterm/xterm.css
        if (!document.getElementById('xterm-css')) {
            const link = document.createElement('link');
            link.id = 'xterm-css';
            link.rel = 'stylesheet';
            link.href = 'lib/xterm/xterm.css';
            document.head.appendChild(link);
        }

        const loadScript = (src) => {
            return new Promise((res, rej) => {
                const s = document.createElement('script');
                s.src = src;

                // Временно прячем module/exports для корректной работы UMD-обертки xterm.js
                const savedExports = window.exports;
                const savedModule = window.module;
                try { window.exports = undefined; window.module = undefined; } catch(e) {}

                s.onload = () => {
                    try { window.exports = savedExports; window.module = savedModule; } catch(e) {}
                    res();
                };
                s.onerror = () => {
                    try { window.exports = savedExports; window.module = savedModule; } catch(e) {}
                    rej(new Error('Ошибка загрузки ' + src));
                };
                document.head.appendChild(s);
            });
        };

        // Загружаем СТРОГО ПОСЛЕДОВАТЕЛЬНО локальные файлы
        loadScript('lib/xterm/xterm.js')
            .then(() => {
                if (!window.Terminal) throw new Error('xterm.js загружен, но window.Terminal не создан');
                return loadScript('lib/xterm/xterm-addon-fit.js');
            })
            .then(() => {
                if (!window.FitAddon) throw new Error('xterm-addon-fit.js загружен, но window.FitAddon не создан');
                FAR._consoleXtermLoaded = true;
                resolve();
            })
            .catch(reject);
    });

    return FAR._xtermLoadingPromise;
};

FAR.openConsole = function (opts) {
    opts = opts || {};
    if (!FAR.consoleEnabled) {
        FAR.toast('Console недоступен для этого пользователя', 'warning');
        return;
    }
    if (typeof FAR.WM !== 'undefined' && FAR.WM.state && FAR.WM.state.active) {
        return FAR.WM.openApp('console');
    }
    FAR._openConsoleModal();
};

FAR._openConsoleModal = function () {
    const modal = document.getElementById('consoleModal');
    const host  = document.getElementById('consoleModalHost');
    if (!modal || !host) return;

    if (FAR._consoleModalApi) {
        try { FAR._consoleModalApi.destroy(); } catch (e) {}
        FAR._consoleModalApi = null;
    }

    FAR._consoleModalApi = FAR._createConsole(host, {});
    modal.classList.remove('hidden');
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

// ============================================================
// ЯДРО: FAR._createConsole(hostEl, opts)
// ============================================================

FAR._createConsole = function (hostEl, opts) {
    if (!hostEl) throw new Error('_createConsole: hostEl required');

    hostEl.innerHTML =
        '<div class="console-toolbar">' +
        '<div class="console-status loading" data-role="status">' +
        '<span class="dot"></span>' +
        '<span data-role="statusText">Подключение…</span>' +
        '</div>' +
        '<button class="console-btn" data-role="clear" title="Очистить экран">🧹 Очистить</button>' +
        '<button class="console-btn" data-role="kill" title="Прервать (Ctrl+C)">⛔ Прервать</button>' +
        '<button class="console-btn" data-role="disconnect" title="Разорвать соединение">🔌 Отключиться</button>' +
        '</div>' +
        '<div class="console-body" data-role="terminal" style="padding: 4px; background: #0b0b12; overflow: hidden;"></div>';

    const elStatus = hostEl.querySelector('[data-role="status"]');
    const elStatusTxt = hostEl.querySelector('[data-role="statusText"]');
    const elClear = hostEl.querySelector('[data-role="clear"]');
    const elKill = hostEl.querySelector('[data-role="kill"]');
    const elDisc = hostEl.querySelector('[data-role="disconnect"]');
    const elTermHost = hostEl.querySelector('[data-role="terminal"]');

    const S = { es: null, connected: false, destroyed: false };
    let term = null;
    let fitAddon = null;
    let resizeObserver = null;
    let resizeTimer = null;

    function setStatus(text, cls) {
        elStatusTxt.textContent = text || '';
        elStatus.className = 'console-status' + (cls ? ' ' + cls : '');
    }

    async function initTerminal() {
        try {
            await FAR._loadXterm();
        } catch (e) {
            elTermHost.innerHTML = '<div style="color:#f38ba8; padding:20px;">Ошибка загрузки xterm.js: ' + FAR.escapeHtml(e.message) + '</div>';
            return;
        }

        term = new Terminal({
            cursorBlink: true,
            fontFamily: 'Consolas, "Courier New", monospace',
            fontSize: 13,
            theme: {
                background: '#0b0b12',
                foreground: '#cdd6f4',
                cursor: '#a6e3a1',
                selectionBackground: '#45475a'
            }
        });

        fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);

        term.open(elTermHost);

        // Даем DOM время отрисоваться и высчитываем точный размер
        setTimeout(() => {
            fitAddon.fit();
            term.focus();
            connect();
        }, 100);

        const ctx = FAR.side && FAR.side[FAR.activePanel];
        const baseUrl = (ctx && ctx.conn && ctx.conn.url) ? String(ctx.conn.url).replace(/\/+$/, '') : location.origin;
        const token = FAR.authToken || FAR.readCookieToken();

        // Отправляем каждое нажатие клавиши
        term.onData(async (data) => {
            if (!S.connected) return;
            try {
                await fetch(baseUrl + '/api/console/input', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({ data: data })
                });
            } catch (e) {}
        });

        // Отправляем размер при каждом изменении окна
        term.onResize(async (size) => {
            try {
                await fetch(baseUrl + '/api/console/resize', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + token
                    },
                    body: JSON.stringify({ cols: size.cols, rows: size.rows })
                });
            } catch (e) {}
        });

        // Возвращаем фокус при клике мимо терминала
        hostEl.addEventListener('mousedown', function (e) {
            if (term && !e.target.closest('button')) {
                setTimeout(() => term.focus(), 10);
            }
        });

        // ResizeObserver: следим за изменением размера контейнера
        resizeObserver = new ResizeObserver(() => {
            if (resizeTimer) clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                try { fitAddon.fit(); } catch (e) {}
            }, 100);
        });
        resizeObserver.observe(elTermHost);
    }

    function connect() {
        if (S.destroyed) return;

        const ctx = FAR.side && FAR.side[FAR.activePanel];
        const baseUrl = (ctx && ctx.conn && ctx.conn.url) ? String(ctx.conn.url).replace(/\/+$/, '') : location.origin;
        const token = FAR.authToken || FAR.readCookieToken();

        if (!token) {
            setStatus('Нет токена', 'error');
            if (term) term.writeln('\x1b[31m✗ Не авторизован. Войдите заново.\x1b[0m');
            return;
        }

        const url = baseUrl + '/api/console/events?token=' + encodeURIComponent(token);
        setStatus('Подключение…', 'loading');

        const es = new EventSource(url);
        S.es = es;

        es.addEventListener('ready', function () {
            S.connected = true;
            setStatus('Подключено', 'online');
        });

        es.addEventListener('output', function (e) {
            let data;
            try { data = JSON.parse(e.data); } catch (err) { return; }
            if (term && data.text) term.write(data.text);
        });

        es.addEventListener('error', function (e) {
            if (e.data) {
                try {
                    const d = JSON.parse(e.data);
                    if (d.error && term) term.writeln('\x1b[31m✗ ' + d.error + '\x1b[0m');
                } catch (err) {}
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
        if (term) term.writeln('\x1b[31m✗ Соединение закрыто пользователем.\x1b[0m');
    }

    elClear.addEventListener('click', function () { if (term) term.clear(); });

    elKill.addEventListener('click', async function () {
        if (!S.connected) return;
        const ctx = FAR.side && FAR.side[FAR.activePanel];
        const baseUrl = (ctx && ctx.conn && ctx.conn.url) ? String(ctx.conn.url).replace(/\/+$/, '') : location.origin;
        const token = FAR.authToken || FAR.readCookieToken();
        try {
            await fetch(baseUrl + '/api/console/input', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
                body: JSON.stringify({ data: '\x03' }) // Ctrl+C
            });
        } catch (e) {}
    });

    elDisc.addEventListener('click', disconnect);

    initTerminal();

    return {
        getState: function () { return S; },
        destroy: function () {
            S.destroyed = true;
            if (resizeTimer) clearTimeout(resizeTimer);
            if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
            if (S.es) { try { S.es.close(); } catch (e) {} S.es = null; }
            if (term) { try { term.dispose(); } catch (e) {} term = null; }
        }
    };
};

FAR.initConsole = function () {
    document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        const modal = document.getElementById('consoleModal');
        if (!modal || modal.classList.contains('hidden')) return;
        const t = e.target;
        if (t && t.classList.contains('xterm-helper-textarea')) return;
        FAR.closeConsole();
    }, true);
};

FAR.WM.registerConsoleApp = function () {
    if (FAR.WM.getApp && FAR.WM.getApp('console')) return;

    if (typeof FAR.WM.registerApp !== 'function') return;

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
    if (FAR.WM.state && FAR.WM.state.windows) {
        FAR.WM.state.windows
            .filter(w => w.appId === 'console')
            .forEach(w => {
                try { FAR.WM.closeWindow(w.id, true); } catch (e) {}
            });
    }
};