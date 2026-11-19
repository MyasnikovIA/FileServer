window.FAR = window.FAR || {};

FAR.LS_KEY     = 'filebd_conn';
FAR.UI         = 'v1';
FAR.MI         = 210000;
FAR.ET         = 16;
FAR.IT         = 12;
FAR.LS_UI_KEY  = 'filebd_ui_state';

// ============================================================
// Базовый путь приложения, вычисляемый из текущего URL.
//
// Примеры:
//   https://host/index.html        → ''      (корень)
//   https://host/                  → ''      (корень)
//   https://host/file/index.html   → '/file' (subpath за nginx)
//   http://127.0.0.1:8080/         → ''      (прямое подключение)
//
// Используется:
//   • в FAR.getDefaultConn()           — URL по умолчанию для модалки входа
//   • в FAR.connectToDb()              — автодополнение URL того же origin
//   • в FAR.buildProxyUrl()            — путь к /api/proxy
//   • в FAR._consoleResolveBaseUrl()   — fallback при отсутствии ctx.db
//   • в buildWsUrl() видеочата         — путь к /ws/{subscribe,publish}
// ============================================================
FAR.basePath = (function () {
    var p = location.pathname || '/';
    var i = p.lastIndexOf('/');
    if (i >= 0) p = p.substring(0, i);
    return p === '/' ? '' : p;
})();