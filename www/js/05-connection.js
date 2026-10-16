// ============================================================
// 05-connection.js — подключение к БД: CouchDB или FileServer.
// ============================================================

FAR.getDefaultConn = function() {
    const proto = location.protocol === 'file:' ? 'http:' : location.protocol;
    const host  = location.hostname || 'localhost';
    return {
        type: 'couchdb',
        url:  proto + '//' + host + ':5984',
        db:   'FileBD',
        user: '',
        pass: ''
    };
};

FAR.getDefaultConnForType = function(type) {
    if (type === 'filesystem') {
        const proto = location.protocol === 'file:' ? 'http:' : location.protocol;
        const host  = location.hostname || 'localhost';
        return {
            type: 'filesystem',
            url:  proto + '//' + host + ':8080',
            db:   '',
            user: '',
            pass: ''
        };
    }
    return FAR.getDefaultConn();
};

FAR.loadConnFromLS = function() {
    try {
        const raw = localStorage.getItem(FAR.LS_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (!obj || !obj.url) return null;
        if (!obj.type) obj.type = 'couchdb';
        if (obj.type === 'couchdb' && !obj.db) return null;
        return obj;
    } catch (e) {
        return null;
    }
};

FAR.saveConnToLS = function(cfg) {
    localStorage.setItem(FAR.LS_KEY, JSON.stringify(cfg));
};

FAR.clearConnFromLS = function() {
    localStorage.removeItem(FAR.LS_KEY);
};

FAR.ensureDb = function() {
    if (!FAR.db) {
        FAR.toast('Нет подключения к БД. Войдите в систему.', 'warning');
        FAR.openConnModal();
        return false;
    }
    return true;
};

FAR.connectToDb = async function(cfg) {
    const type = cfg.type || 'couchdb';

    if (type === 'filesystem') {
        if (typeof FAR.FsClient !== 'function') {
            throw new Error('FsClient не загружен (js/04a-fs-client.js)');
        }
        const baseUrl = String(cfg.url || '').replace(/\/+$/, '');
        if (!baseUrl) throw new Error('Не указан адрес FileServer');

        const client = new FAR.FsClient(baseUrl, {
            user: cfg.user || '',
            pass: cfg.pass || ''
        });

        const info = await client.info();
        await client.allDocs({ limit: 1 });   // проверка доступности

        return {
            db: client,
            info: info,
            fullUrl: baseUrl + (cfg.user ? ' (' + cfg.user + ')' : ''),
            type: 'filesystem'
        };
    }

    // CouchDB / PouchDB
    const url = String(cfg.url).replace(/\/+$/, '');
    const fullUrl = url + '/' + cfg.db;
    const pouchOpts = {};
    if (cfg.user) pouchOpts.auth = { username: cfg.user, password: cfg.pass || '' };

    const testDb = new PouchDB(fullUrl, pouchOpts);
    const info = await testDb.info();
    await testDb.allDocs({ limit: 1 });
    return { db: testDb, info, fullUrl, type: 'couchdb' };
};