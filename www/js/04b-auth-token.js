// ============================================================
// 04b-auth-token.js — глобальный менеджер токена авторизации.
// ============================================================

FAR.authToken = '';
FAR._knownServers = new Set();

FAR.AUTH_COOKIE_NAME = 'filebd_token';

FAR._writeAuthCookie = function (token) {
    try {
        if (token) {
            document.cookie = FAR.AUTH_COOKIE_NAME + '=' +
                encodeURIComponent(token) +
                '; Path=/; Max-Age=86400; SameSite=Lax';
        } else {
            document.cookie = FAR.AUTH_COOKIE_NAME +
                '=; Path=/; Max-Age=0; SameSite=Lax';
        }
    } catch (e) { /* ignore */ }
};

FAR.readCookieToken = function () {
    try {
        const name = FAR.AUTH_COOKIE_NAME + '=';
        const parts = (document.cookie || '').split(';');
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i].trim();
            if (p.indexOf(name) === 0) {
                return decodeURIComponent(p.substring(name.length));
            }
        }
    } catch (e) { /* ignore */ }
    return '';
};

FAR.registerServer = function (url) {
    if (!url) return;
    const clean = String(url).replace(/\/+$/, '');
    if (clean) FAR._knownServers.add(clean);
};

FAR.unregisterServer = function (url) {
    if (!url) return;
    const clean = String(url).replace(/\/+$/, '');
    FAR._knownServers.delete(clean);
};

FAR._isOurServer = function (url) {
    if (!url || typeof url !== 'string') return false;
    for (const srv of FAR._knownServers) {
        if (url === srv || url.startsWith(srv + '/') || url.startsWith(srv + '?')) {
            return true;
        }
    }
    return false;
};

FAR.setAuthToken = function (token) {
    FAR.authToken = token || '';
    FAR._writeAuthCookie(FAR.authToken);

    if (FAR.side) {
        ['left', 'right'].forEach(function (side) {
            const ctx = FAR.side[side];
            if (ctx && ctx.db && typeof ctx.db === 'object') {
                try { ctx.db.token = FAR.authToken; } catch (e) {}
            }
        });
    }

    console.log('[auth] token ' +
        (FAR.authToken
            ? 'set (' + FAR.authToken.substring(0, 8) + '…)'
            : 'cleared'));
};

FAR.clearAuthToken = function () {
    FAR.setAuthToken('');
};

FAR.restoreAuthTokenFromCookie = function () {
    const fromCookie = FAR.readCookieToken();
    if (fromCookie) {
        FAR.authToken = fromCookie;
        console.log('[auth] token restored from cookie (' +
            fromCookie.substring(0, 8) + '…)');
        return true;
    }
    return false;
};

// ============================================================
// Глобальная обёртка над window.fetch
// ============================================================

(function installFetchAuthWrapper() {
    if (window._farFetchWrapped) return;
    window._farFetchWrapped = true;

    const origFetch = window.fetch.bind(window);
    const LOCAL_PROTO = /^(blob:|data:|file:|about:)/i;

    window.fetch = function (input, init) {
        init = init || {};

        const url = (typeof input === 'string')
            ? input
            : (input && input.url) || '';

        // ---- Локальные протоколы: не трогаем ----
        if (LOCAL_PROTO.test(url)) {
            return origFetch(input, init);
        }

        const isOur = FAR._isOurServer(url);

        // ---- HTTP(S) к нашему FileServer ----
        if (isOur) {
            const headers = new Headers(init.headers || {});
            if (FAR.authToken && !headers.has('Authorization')) {
                headers.set('Authorization', 'Bearer ' + FAR.authToken);
            }
            init.headers = headers;

            // Ставим credentials: include ТОЛЬКО для наших серверов
            if (!init.credentials) {
                init.credentials = 'include';
            }
        }
        // Для сторонних сайтов (CDN) оставляем дефолтные настройки,
        // чтобы браузер не блокировал запросы из-за CORS.

        return origFetch(input, init);
    };
})();