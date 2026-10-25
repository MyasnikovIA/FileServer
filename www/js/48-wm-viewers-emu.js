// ============================================================
// 48-wm-viewers-emu.js — Эмуляторы и консоль
// ============================================================

FAR.WM._mountJsdosViewer = async function (win, props) {
    const item = props.file;
    const side = props.side || FAR.activePanel;

    win.el.querySelector('.wm-title-text').textContent = '🕹️ ' + item.name;
    win.bodyEl.innerHTML =
        '<div style="height:100%;position:relative;background:#000;">' +
        '<div data-role="root" style="width:100%;height:100%;min-height:400px;outline:none;" tabindex="0"></div>' +
        '<div data-role="loading" style="position:absolute;inset:0;background:rgba(0,0,0,0.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#a6adc8;z-index:10;">' +
        '<div style="width:50px;height:50px;border:4px solid #313244;border-top-color:#89b4fa;border-radius:50%;animation:spin 1s linear infinite;"></div>' +
        '<div data-role="status" style="font-size:14px;">Загрузка игры…</div></div></div>';

    const root = win.bodyEl.querySelector('[data-role="root"]');
    const loadingEl = win.bodyEl.querySelector('[data-role="loading"]');
    const statusEl = win.bodyEl.querySelector('[data-role="status"]');

    if (!window.Dos) { loadingEl.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">Библиотека JS-DOS не загружена.</div>'; return; }

    let url = null;
    try {
        const r = await FAR.readFileBodyFromSide(side, item);
        const blob = new Blob([r.data], { type: r.contentType || 'application/octet-stream' });
        url = URL.createObjectURL(blob);
        FAR.WM._trackBlobUrl(win, url);
    } catch (e) { loadingEl.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">Ошибка чтения: ' + FAR.escapeHtml(e.message) + '</div>'; return; }

    await new Promise(r => setTimeout(r, 50));

    try {
        const pathPrefix = new URL('lib/js-dos/', window.location.href).href;
        if (typeof window.emulators !== 'undefined') window.emulators.pathPrefix = pathPrefix;

        const instance = window.Dos(root, { wdosboxUrl: pathPrefix + 'wdosbox.js', pathPrefix: pathPrefix });
        win.props._jsdosInstance = instance;
        statusEl.textContent = 'Запуск…';
        try { instance.events().onStdout(line => console.log('[WM jsdos]', line)); } catch (e) {}

        await instance.run(url);
        loadingEl.style.display = 'none';
        FAR.setStatus('🕹️ JSDOS: ' + item.name);
        try { root.setAttribute('tabindex', '0'); root.focus(); const canvas = root.querySelector('canvas'); if (canvas) { canvas.setAttribute('tabindex', '0'); canvas.focus(); } } catch (e) {}
        FAR.WM._installViewerNavButtons(win, item, side);
    } catch (e) { loadingEl.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">Ошибка запуска: ' + FAR.escapeHtml(e.message) + '</div>'; }
};

FAR.WM._mountNesViewer = async function (win, props) {
    const item = props.file;
    const side = props.side || FAR.activePanel;

    win.el.querySelector('.wm-title-text').textContent = '🎮 ' + item.name;
    win.bodyEl.innerHTML =
        '<div style="height:100%;position:relative;background:#000;display:flex;align-items:center;justify-content:center;">' +
        '<div data-role="root" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;min-height:400px;"></div>' +
        '<div data-role="loading" style="position:absolute;inset:0;background:rgba(0,0,0,0.88);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#a6adc8;z-index:10;">' +
        '<div style="width:50px;height:50px;border:4px solid #313244;border-top-color:#89b4fa;border-radius:50%;animation:spin 1s linear infinite;"></div>' +
        '<div data-role="status" style="font-size:14px;">Загрузка эмулятора…</div></div></div>';

    const root = win.bodyEl.querySelector('[data-role="root"]');
    const loadingEl = win.bodyEl.querySelector('[data-role="loading"]');
    const statusEl = win.bodyEl.querySelector('[data-role="status"]');

    let jsnesLib = null;
    try {
        if (typeof FAR._loadJsnesDynamically !== 'function') throw new Error('Модуль 29-nes-viewer.js не загружен');
        jsnesLib = await FAR._loadJsnesDynamically();
    } catch (e) { loadingEl.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">Ошибка JSNES: ' + FAR.escapeHtml(e.message) + '</div>'; return; }

    let romBuffer = null;
    try {
        statusEl.textContent = 'Загрузка ROM…';
        const r = await FAR.readFileBodyFromSide(side, item);
        romBuffer = r.data;
    } catch (e) { loadingEl.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">Ошибка ROM: ' + FAR.escapeHtml(e.message) + '</div>'; return; }

    await new Promise(r => setTimeout(r, 30));

    try {
        statusEl.textContent = 'Инициализация…';
        const browser = new jsnesLib.Browser({
            container: root,
            onError: function (e) { FAR.toast('Ошибка NES: ' + (e && e.message ? e.message : e), 'error'); }
        });
        win.props._nesBrowser = browser;
        browser.loadROM(romBuffer);
        setTimeout(() => { try { browser.fitInParent(); } catch (e) {} }, 100);
        setTimeout(() => { try { browser.fitInParent(); } catch (e) {} }, 400);
        loadingEl.style.display = 'none';
        FAR.setStatus('🎮 NES: ' + item.name);
        FAR.WM._installViewerNavButtons(win, item, side);
    } catch (e) { loadingEl.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">Ошибка запуска: ' + FAR.escapeHtml(e.message) + '</div>'; }
};

FAR.WM._mountEmulatorViewer = async function (win, props) {
    const others = FAR.WM.state.windows.filter(w => w.appId === 'emulator' && w.id !== win.id);
    for (const other of others) { try { FAR.WM._finalizeViewer(other); FAR.WM.closeWindow(other.id, true); } catch (e) {} }

    const item = props.file;
    const side = props.side || FAR.activePanel;
    const core = (typeof FAR._getEmulatorCore === 'function') ? FAR._getEmulatorCore(item) : null;

    if (!core) {
        win.el.querySelector('.wm-title-text').textContent = '🕹️ ' + item.name;
        FAR.WM._mountNotice(win, '🕹️', 'Формат файла не поддерживается EmulatorJS.');
        return;
    }

    win.el.querySelector('.wm-title-text').textContent = '🕹️ ' + item.name + ' (' + core + ')';
    win.bodyEl.innerHTML =
        '<div style="height:100%;position:relative;background:#000;">' +
        '<div data-role="root" style="width:100%;height:100%;min-height:400px;"></div>' +
        '<div data-role="loading" style="position:absolute;inset:0;background:rgba(0,0,0,0.9);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:#a6adc8;z-index:10;">' +
        '<div style="width:50px;height:50px;border:4px solid #313244;border-top-color:#89b4fa;border-radius:50%;animation:spin 1s linear infinite;"></div>' +
        '<div data-role="status" style="font-size:14px;">Загрузка эмулятора…</div></div></div>';

    const root = win.bodyEl.querySelector('[data-role="root"]');
    const loadingEl = win.bodyEl.querySelector('[data-role="loading"]');
    const statusEl = win.bodyEl.querySelector('[data-role="status"]');

    win.props._emuSeq = (win.props._emuSeq || 0) + 1;
    const containerId = 'wm-emu-' + win.id + '-' + win.props._emuSeq;
    root.id = containerId;

    let blobUrl = null;
    try {
        statusEl.textContent = 'Загрузка ROM…';
        const r = await FAR.readFileBodyFromSide(side, item);
        const blob = new Blob([r.data], { type: r.contentType || 'application/octet-stream' });
        blobUrl = URL.createObjectURL(blob);
        FAR.WM._trackBlobUrl(win, blobUrl);
    } catch (e) { loadingEl.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">Ошибка ROM: ' + FAR.escapeHtml(e.message) + '</div>'; return; }

    if (typeof window.EmulatorJS !== 'function') {
        statusEl.textContent = 'Загрузка библиотеки…';
        const tempContainer = document.createElement('div');
        tempContainer.id = 'ejs-temp-' + win.id;
        tempContainer.style.cssText = 'position:absolute;left:-99999px;top:-99999px;width:1px;height:1px;overflow:hidden;pointer-events:none;';
        document.body.appendChild(tempContainer);

        window.EJS_player = '#' + tempContainer.id;
        window.EJS_core = core; window.EJS_gameUrl = blobUrl; window.EJS_gameName = item.name;
        window.EJS_pathtodata = 'lib/js-emulator/'; window.EJS_color = '#89b4fa'; window.EJS_startOnLoaded = false;

        try {
            if (typeof FAR._loadEmulatorLoader !== 'function') throw new Error('Модуль 30-emulator-viewer.js не загружен');
            await FAR._loadEmulatorLoader();
        } catch (e) {
            try { tempContainer.remove(); } catch (e2) {}
            loadingEl.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">Ошибка библиотеки: ' + FAR.escapeHtml(e.message) + '</div>';
            return;
        }
        setTimeout(() => { try { tempContainer.remove(); } catch (e2) {} }, 200);
    }

    if (typeof window.EmulatorJS !== 'function') { loadingEl.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">window.EmulatorJS не определён</div>'; return; }

    window.EJS_player = '#' + containerId;
    window.EJS_core = core; window.EJS_gameUrl = blobUrl; window.EJS_gameName = item.name;
    window.EJS_pathtodata = 'lib/js-emulator/'; window.EJS_color = '#89b4fa'; window.EJS_startOnLoaded = true;

    statusEl.textContent = 'Запуск ядра ' + core + '…';

    try {
        const emu = new window.EmulatorJS('#' + containerId, {
            gameUrl: blobUrl, gameName: item.name, dataPath: 'lib/js-emulator/',
            system: core, color: '#89b4fa', startOnLoad: true
        });
        win.props._emulatorInstance = emu;
        setTimeout(() => { if (loadingEl) loadingEl.style.display = 'none'; }, 3000);
        FAR.setStatus('🕹️ EmulatorJS: ' + item.name + ' (' + core + ')');
        FAR.WM._installViewerNavButtons(win, item, side);
    } catch (e) { loadingEl.innerHTML = '<div style="color:#f38ba8;padding:20px;text-align:center;">Ошибка запуска: ' + FAR.escapeHtml(e.message) + '</div>'; }
};

FAR.WM._mountConsoleViewer = async function (win, props) {
    win.el.querySelector('.wm-title-text').textContent = '🖥 Console';
    if (win.props._consoleApi) { try { win.props._consoleApi.destroy(); } catch (e) {} win.props._consoleApi = null; }
    win.bodyEl.innerHTML = '';
    win.bodyEl.style.display = 'flex'; win.bodyEl.style.flexDirection = 'column'; win.bodyEl.style.minHeight = '0';
    win.props._consoleApi = FAR._createConsole(win.bodyEl, {});
    setTimeout(() => { const ta = win.bodyEl.querySelector('.xterm-helper-textarea'); if (ta) try { ta.focus(); } catch (e) {} }, 100);
};