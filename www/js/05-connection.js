// ============================================================
// 05-connection.js — подключение к FileServer.
// ============================================================
//
// Клиент работает ТОЛЬКО с FileServer (REST + SSE).
// Все запросы идут через FAR.FsClient с Bearer-токеном.
// PouchDB / CouchDB не поддерживаются.
// ============================================================

FAR.getDefaultConn = function () {
    const proto = location.protocol === 'file:' ? 'http:' : location.protocol;
    const host  = location.hostname || '127.0.0.1';
    return {
        url:  proto + '//' + host + ':8080',
        user: '',
        pass: ''
    };
};

FAR.loadConnFromLS = function () {
    try {
        const raw = localStorage.getItem(FAR.LS_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || !obj.url) return null;
        // Старые конфиги CouchDB содержали поле "db" — игнорируем их
        if (obj.db) return null;
        return obj;
    } catch (e) {
        return null;
    }
};

FAR.saveConnToLS = function (cfg) {
    // Токен НЕ сохраняем — он короткоживущий, при перезапуске
    // клиент заново вызовет /api/login.
    const safe = {
        url:  cfg.url,
        user: cfg.user || '',
        pass: cfg.pass || ''
    };
    try {
        localStorage.setItem(FAR.LS_KEY, JSON.stringify(safe));
    } catch (e) { /* ignore */ }
};

FAR.clearConnFromLS = function () {
    try { localStorage.removeItem(FAR.LS_KEY); } catch (e) {}
};

FAR.ensureDb = function () {
    if (!FAR.db) {
        FAR.toast('Нет подключения к FileServer. Войдите в систему.', 'warning');
        FAR.openConnModal();
        return false;
    }
    return true;
};

/**
 * Подключение к FileServer.
 *
 * @param {Object} cfg — { url, user, pass }
 * @returns {Promise<{db: FsClient, info: Object, fullUrl: string, token: string}>}
 */
FAR.connectToDb = async function (cfg) {
    if (typeof FAR.FsClient !== 'function') {
        throw new Error('FsClient не загружен (js/04a-fs-client.js)');
    }

    const baseUrl = String(cfg.url || '').replace(/\/+$/, '');
    if (!baseUrl) throw new Error('Не указан адрес FileServer');

    let token = '';

    // Если указан пользователь — логинимся и получаем токен
    if (cfg.user) {
        let loginRes;
        try {
            loginRes = await FAR.FsClient.login(baseUrl, cfg.user, cfg.pass || '');
        } catch (e) {
            if (e.status === 401) {
                const err = new Error('Неверный логин или пароль (401)');
                err.status = 401;
                throw err;
            }
            if (e.name === 'NetworkError') {
                const err = new Error('Не удалось подключиться (сеть/CORS). Проверьте адрес.');
                err.name = 'NetworkError';
                throw err;
            }
            throw e;
        }
        token = loginRes.token || '';
        if (!token) throw new Error('Сервер не выдал токен');
    }

    const client = new FAR.FsClient(baseUrl, {
        user:  cfg.user || '',
        pass:  cfg.pass || '',
        token: token
    });

    const info = await client.info();
    await client.allDocs({ limit: 1 });

    return {
        db:      client,
        info:    info,
        fullUrl: FAR.connLabel({ url: baseUrl, user: cfg.user || '' }),
        token:   token
    };
};