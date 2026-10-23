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
// Единая точка вычисления baseUrl/token для консоли
// с защитой от mixed content
// ============================================================

FAR._consoleResolveBaseUrl = function () {
    const ctx = FAR.side && FAR.side[FAR.activePanel];
    let base = '';
    if (ctx && ctx.db && ctx.db.baseUrl) {
        base = String(ctx.db.baseUrl).replace(/\/+$/, '');
    } else {
        base = location.origin;
    }

    // Если страница HTTPS, а baseUrl HTTP — это mixed content.
    // EventSource будет заблокирован браузером МОЛЧА.
    // Заменяем на текущий origin (он точно HTTPS).
    if (location.protocol === 'https:' && base.startsWith('http://')) {
        console.warn('[console] Mixed content: baseUrl=' + base +
            ' → заменяю на ' + location.origin);
        base = location.origin;
    }

    return base;
};

FAR._consoleResolveToken = function () {
    const ctx = FAR.side && FAR.side[FAR.activePanel];
    if (ctx && ctx.db && ctx.db.token) return ctx.db.token;
    if (FAR.authToken) return FAR.authToken;
    try { return FAR.readCookieToken(); } catch (e) { return ''; }
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
        '<button class="console-btn" data-role="reconnect" title="Переподключиться">🔁 Переподключить</button>' +
        '<button class="console-btn" data-role="disconnect" title="Разорвать соединение">🔌 Отключиться</button>' +
        '</div>' +
        '<div class="console-body" data-role="terminal" style="padding: 4px; background: #0b0b12; overflow: hidden;"></div>';

    const elStatus = hostEl.querySelector('[data-role="status"]');
    const elStatusTxt = hostEl.querySelector('[data-role="statusText"]');
    const elClear = hostEl.querySelector('[data-role="clear"]');
    const elKill = hostEl.querySelector('[data-role="kill"]');
    const elReconnect = hostEl.querySelector('[data-role="reconnect"]');
    const elDisc = hostEl.querySelector('[data-role="disconnect"]');
    const elTermHost = hostEl.querySelector('[data-role="terminal"]');

    const S = {
        es: null,
        connected: false,
        destroyed: false,
        pollTimer: null,
        lastEventSeq: 0
    };

    const sessionId = (window.crypto && window.crypto.randomUUID)
        ? window.crypto.randomUUID()
        : 'sess_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

    let term = null;
    let fitAddon = null;
    let resizeObserver = null;
    let resizeTimer = null;
    let sseConnectTimer = null;
    let sseOpenedOk = false;

    const doFit = () => {
        if (!term || S.destroyed) return;
        try { fitAddon.fit(); } catch (e) {}
    };

    const onWindowResize = () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(doFit, 100);
    };

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
                background: '#0b0b12', foreground: '#cdd6f4', cursor: '#a6e3a1', selectionBackground: '#45475a'
            }
        });

        fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(elTermHost);

        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                doFit();
                term.focus();
                connect();
            });
        });

        term.onData(async (data) => {
            if (!S.connected) return;
            await postJson('/api/console/input?sessionId=' + encodeURIComponent(sessionId),
                { data: data });
        });

        term.onResize(async (size) => {
            if (size.cols === 0 || size.rows === 0) return;
            await postJson('/api/console/resize?sessionId=' + encodeURIComponent(sessionId),
                { cols: size.cols, rows: size.rows });
        });

        const focusTerminal = (e) => {
            if (term && !e.target.closest('button')) setTimeout(() => term.focus(), 10);
        };
        hostEl.addEventListener('mousedown', focusTerminal);
        hostEl.addEventListener('touchstart', focusTerminal, { passive: true });

        if (window.ResizeObserver) {
            resizeObserver = new ResizeObserver(() => {
                if (resizeTimer) clearTimeout(resizeTimer);
                resizeTimer = setTimeout(doFit, 100);
            });
            resizeObserver.observe(elTermHost);
        }

        window.addEventListener('resize', onWindowResize);
        setTimeout(doFit, 300);
        setTimeout(doFit, 800);
    }

    async function postJson(pathSuffix, body) {
        const baseUrl = FAR._consoleResolveBaseUrl();
        const token = FAR._consoleResolveToken();
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = 'Bearer ' + token;

        try {
            const res = await fetch(baseUrl + pathSuffix, {
                method: 'POST',
                headers: headers,
                credentials: 'include',
                body: JSON.stringify(body)
            });
            if (!res.ok) {
                console.warn('[console] POST ' + pathSuffix + ' → ' + res.status);
            }
            return res.ok;
        } catch (e) {
            console.error('[console] POST error:', e);
            return false;
        }
    }

    // ============================================================
    // SSE + fallback-поллинг
    // ============================================================

    function connect() {
        if (S.destroyed) return;

        const baseUrl = FAR._consoleResolveBaseUrl();
        const token = FAR._consoleResolveToken();

        if (!token) {
            setStatus('Нет токена', 'error');
            if (term) term.writeln('\x1b[31m✗ Не авторизован. Войдите заново.\x1b[0m');
            return;
        }

        const url = baseUrl + '/api/console/events?token=' +
            encodeURIComponent(token) + '&sessionId=' + encodeURIComponent(sessionId);

        setStatus('Подключение…', 'loading');
        sseOpenedOk = false;

        let es;
        try {
            es = new EventSource(url);
        } catch (e) {
            setStatus('Не удалось создать EventSource: ' + e.message, 'error');
            if (term) term.writeln('\x1b[31m✗ ' + e.message + '\x1b[0m');
            startPollingFallback();
            return;
        }

        S.es = es;

        // Таймаут: если за 5 секунд не пришёл `ready` — значит SSE
        // молча не открылся (mixed content / TLS). Переходим на polling.
        sseConnectTimer = setTimeout(function () {
            if (sseOpenedOk) return;
            if (S.destroyed) return;
            console.warn('[console] SSE не открылся за 5с, переключаюсь на polling');
            try { es.close(); } catch (err) {}
            S.es = null;
            if (term) {
                term.writeln('\x1b[33m⚠ SSE не открылся — использую polling (медленнее).\x1b[0m');
            }
            startPollingFallback();
        }, 5000);

        es.addEventListener('ready', function (e) {
            sseOpenedOk = true;
            if (sseConnectTimer) {
                clearTimeout(sseConnectTimer);
                sseConnectTimer = null;
            }
            S.connected = true;
            setStatus('Подключено (SSE)', 'online');
            setTimeout(doFit, 100);
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

    function startPollingFallback() {
        if (S.pollTimer || S.destroyed) return;

        setStatus('Подключение (polling)…', 'loading');

        let pollAfterSeq = 0;

        const tick = async function () {
            if (S.destroyed) return;

            const baseUrl = FAR._consoleResolveBaseUrl();
            const token = FAR._consoleResolveToken();
            if (!token) {
                setStatus('Нет токена', 'error');
                return;
            }

            const url = baseUrl + '/api/console/events?token=' +
                encodeURIComponent(token) +
                '&sessionId=' + encodeURIComponent(sessionId) +
                '&poll=1&since=' + pollAfterSeq;

            try {
                const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
                if (!res.ok) {
                    setStatus('Polling HTTP ' + res.status, 'error');
                    return;
                }
                const data = await res.json();
                if (data && Array.isArray(data.events)) {
                    if (!S.connected) {
                        S.connected = true;
                        setStatus('Подключено (polling)', 'online');
                        setTimeout(doFit, 100);
                    }
                    for (const ev of data.events) {
                        if (ev.seq > pollAfterSeq) pollAfterSeq = ev.seq;
                        if (ev.type === 'output' && ev.text && term) {
                            term.write(ev.text);
                        }
                    }
                }
                if (typeof data.nextSeq === 'number') {
                    pollAfterSeq = Math.max(pollAfterSeq, data.nextSeq);
                }
            } catch (e) {
                setStatus('Polling error: ' + e.message, 'error');
            }
        };

        tick();
        S.pollTimer = setInterval(tick, 700);
    }

    function stopPolling() {
        if (S.pollTimer) {
            clearInterval(S.pollTimer);
            S.pollTimer = null;
        }
    }

    function disconnect() {
        if (sseConnectTimer) { clearTimeout(sseConnectTimer); sseConnectTimer = null; }
        if (S.es) { try { S.es.close(); } catch (e) {} S.es = null; }
        stopPolling();
        S.connected = false;
        setStatus('Отключено', 'error');
        if (term) term.writeln('\x1b[31m✗ Соединение закрыто пользователем.\x1b[0m');
    }

    elClear.addEventListener('click', function () { if (term) term.clear(); });

    elKill.addEventListener('click', async function () {
        if (!S.connected) return;
        await postJson('/api/console/input?sessionId=' + encodeURIComponent(sessionId),
            { data: '\x03' });
    });

    elReconnect.addEventListener('click', function () {
        disconnect();
        setTimeout(connect, 100);
    });

    elDisc.addEventListener('click', disconnect);

    initTerminal();

    return {
        getState: function () { return S; },
        destroy: function () {
            S.destroyed = true;
            if (resizeTimer) clearTimeout(resizeTimer);
            if (sseConnectTimer) clearTimeout(sseConnectTimer);
            window.removeEventListener('resize', onWindowResize);
            if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
            if (S.es) { try { S.es.close(); } catch (e) {} S.es = null; }
            stopPolling();
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
        singleton: false,
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