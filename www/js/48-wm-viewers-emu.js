// ============================================================
// 48-wm-viewers-emu.js — WM-режим для JSDOS и EmulatorJS.
// ============================================================

FAR.WM = FAR.WM || {};
FAR.WM._emu = FAR.WM._emu || {};

// ============================================================
// JSDOS
// ============================================================
FAR.WM._mountJsdosViewer = async function (win, props) {
    props = props || {};
    const item = props.file;
    const side = props.side || FAR.activePanel;

    win.bodyEl.innerHTML = '';
    win.bodyEl.style.background = '#000';
    win.bodyEl.style.display = 'flex';
    win.bodyEl.style.flexDirection = 'column';
    win.bodyEl.style.minHeight = '0';
    win.bodyEl.style.position = 'relative';

    const host = document.createElement('div');
    host.className = 'jsdos-root';
    host.style.cssText =
        'flex:1; min-height:0; width:100%; height:100%;' +
        'background:#000; overflow:hidden; position:relative;';
    win.bodyEl.appendChild(host);

    const loading = document.createElement('div');
    loading.className = 'jsdos-loading';
    loading.innerHTML =
        '<div class="spinner"></div>' +
        '<div class="jsdos-loading-text">Загрузка игры…</div>';
    host.appendChild(loading);

    if (!item || !FAR.side[side] || !FAR.side[side].db) {
        loading.innerHTML = '<div class="jsdos-loading-text">Файл не выбран или нет БД</div>';
        return;
    }

    if (typeof FAR._ensureItemName === 'function') FAR._ensureItemName(item);
    if (!window.Dos) {
        loading.innerHTML = '<div class="jsdos-loading-text">JS-DOS не загружен</div>';
        return;
    }

    let blobUrl = '';
    try {
        const { data, contentType } = await FAR.readFileBodyFromSide(side, item);
        const blob = new Blob([data], { type: contentType || 'application/octet-stream' });
        blobUrl = URL.createObjectURL(blob);
        if (!win.props._jsdosBlobUrls) win.props._jsdosBlobUrls = [];
        win.props._jsdosBlobUrls.push(blobUrl);
    } catch (e) {
        loading.innerHTML = '<div class="jsdos-loading-text">Ошибка чтения файла</div>';
        return;
    }

    await new Promise(r => setTimeout(r, 50));

    try {
        const pathPrefix = new URL('lib/js-dos/', window.location.href).href;
        if (typeof window.emulators !== 'undefined') {
            window.emulators.pathPrefix = pathPrefix;
        }

        const instance = window.Dos(host, {
            wdosboxUrl: pathPrefix + 'wdosbox.js',
            pathPrefix: pathPrefix
        });
        win.props._jsdosInstance = instance;

        try {
            instance.events().onStdout(line => console.log('[jsdos wm]', line));
        } catch (e) {}

        instance.run(blobUrl).catch(e => console.error('[WM JSDOS] run error:', e));

        const checkCanvas = setInterval(() => {
            const canvas = host.querySelector('canvas');
            if (canvas && canvas.width > 0) {
                clearInterval(checkCanvas);
                loading.classList.add('hidden');
                window.dispatchEvent(new Event('resize'));
            }
        }, 100);

        setTimeout(() => {
            clearInterval(checkCanvas);
            loading.classList.add('hidden');
            window.dispatchEvent(new Event('resize'));
        }, 2000);

        if (typeof ResizeObserver !== 'undefined') {
            if (win.props._resizeObserver) {
                try { win.props._resizeObserver.disconnect(); } catch (e) {}
            }
            win.props._resizeObserver = new ResizeObserver(function () {
                const canvas = host.querySelector('canvas');
                if (canvas) {
                    canvas.style.removeProperty('top');
                    canvas.style.removeProperty('left');
                    canvas.style.removeProperty('width');
                    canvas.style.removeProperty('height');
                    canvas.style.removeProperty('position');
                }
                window.dispatchEvent(new Event('resize'));
            });
            win.props._resizeObserver.observe(win.bodyEl);
        }

        try {
            host.setAttribute('tabindex', '0');
            host.focus();
            const canvas = host.querySelector('canvas');
            if (canvas) { canvas.setAttribute('tabindex', '0'); canvas.focus(); }
        } catch (e) {}

        FAR.setStatus('🕹️ JSDOS: ' + (item.name || item.path));
    } catch (e) {
        console.error('[WM JSDOS] failed:', e);
        loading.innerHTML = '<div class="jsdos-loading-text">Ошибка запуска</div>';
    }
};

// ============================================================
// EmulatorJS
// ============================================================
FAR.WM._mountEmulatorViewer = async function (win, props) {
    props = props || {};
    const item = props.file;
    const side = props.side || FAR.activePanel;

    win.bodyEl.innerHTML = '';
    win.bodyEl.style.background = '#000';
    win.bodyEl.style.display = 'flex';
    win.bodyEl.style.flexDirection = 'column';
    win.bodyEl.style.minHeight = '0';
    win.bodyEl.style.position = 'relative';

    const host = document.createElement('div');
    host.className = 'emulator-root';
    host.style.cssText =
        'flex:1; min-height:0; width:100%; height:100%;' +
        'background:#000; overflow:hidden; position:relative;' +
        'display:flex; align-items:center; justify-content:center;';
    win.bodyEl.appendChild(host);

    const loading = document.createElement('div');
    loading.className = 'emulator-loading';
    loading.innerHTML =
        '<div class="spinner"></div>' +
        '<div class="emulator-loading-text">Загрузка эмулятора…</div>';
    host.appendChild(loading);

    if (!item || !FAR.side[side] || !FAR.side[side].db) {
        loading.innerHTML = '<div class="emulator-loading-text">Ошибка: нет файла или БД</div>';
        return;
    }

    if (typeof FAR._ensureItemName === 'function') FAR._ensureItemName(item);
    if (typeof FAR.isEmulatorFile === 'function' && !FAR.isEmulatorFile(item)) {
        loading.innerHTML = '<div class="emulator-loading-text">Не ROM-файл</div>';
        return;
    }

    let data = null;
    let contentType = 'application/octet-stream';
    try {
        const r = await FAR.readFileBodyFromSide(side, item);
        data = r.data;
        contentType = r.contentType || 'application/octet-stream';
    } catch (e) {
        loading.innerHTML = '<div class="emulator-loading-text">Ошибка чтения</div>';
        return;
    }

    const blob = new Blob([data], { type: contentType });
    const blobUrl = URL.createObjectURL(blob);
    if (!win.props._emuBlobUrls) win.props._emuBlobUrls = [];
    win.props._emuBlobUrls.push(blobUrl);

    const ext = (item.name.split('.').pop() || '').toLowerCase();
    const core = FAR._emuGetCore(ext);

    const ejsHost = document.createElement('div');
    ejsHost.id = 'ejs_' + win.id + '_' + Math.random().toString(36).substr(2, 6);
    ejsHost.style.cssText = 'width:100%; height:100%; display:flex; align-items:center; justify-content:center;';
    host.appendChild(ejsHost);

    await new Promise(r => setTimeout(r, 30));

    try {
        window.EJS_player = '#' + ejsHost.id;
        window.EJS_core = core;
        window.EJS_gameName = item.name.replace(/\.[^.]+$/, '');
        window.EJS_biosUrl = '';
        window.EJS_gameUrl = blobUrl;
        window.EJS_pathtodata = new URL('lib/emulatorjs/data/', window.location.href).href;
        window.EJS_startOnLoaded = true;
        window.EJS_color = '#89b4fa';

        if (!window.EJS_emulator) {
            await FAR.loadScriptOnce(window.EJS_pathtodata + 'loader.js');
        } else if (typeof window.EJS_emulator !== 'undefined' && typeof window.EJS_emulator.play === 'function') {
            try { window.EJS_emulator.play(); } catch (e) {}
        }

        const waitStart = Date.now();
        while (!host.querySelector('canvas') && Date.now() - waitStart < 5000) {
            await new Promise(r => setTimeout(r, 100));
        }

        const canvas = host.querySelector('canvas');
        if (canvas) {
            canvas.style.maxWidth  = '100%';
            canvas.style.maxHeight = '100%';
            canvas.style.width     = '100%';
            canvas.style.height    = '100%';
            canvas.style.objectFit = 'contain';
            canvas.style.imageRendering = 'pixelated';
        }

        loading.classList.add('hidden');

        if (typeof ResizeObserver !== 'undefined') {
            if (win.props._resizeObserver) {
                try { win.props._resizeObserver.disconnect(); } catch (e) {}
            }
            win.props._resizeObserver = new ResizeObserver(function () {
                window.dispatchEvent(new Event('resize'));
            });
            win.props._resizeObserver.observe(win.bodyEl);
        }

        FAR.setStatus('🕹️ EmulatorJS: ' + item.name);
    } catch (e) {
        console.error('[WM Emu] failed:', e);
        loading.innerHTML = '<div class="emulator-loading-text">Ошибка запуска</div>';
    }
};

FAR._emuGetCore = function (ext) {
    ext = String(ext || '').toLowerCase();
    switch (ext) {
        case 'nes': case 'fds': return 'nes';
        case 'smc': case 'sfc': case 'fig': case 'swc': case 'bsx': return 'snes';
        case 'gba': return 'gba';
        case 'gb':  case 'gbc': return 'gb';
        case 'n64': case 'z64': case 'v64': return 'n64';
        case 'nds': return 'nds';
        case 'md':  case 'gen': case 'smd': case 'bin': return 'segaMD';
        case 'sms': case 'gg':  return 'segaMS';
        case 'pce': return 'pce';
        case 'ws':  case 'wsc': return 'ws';
        case 'col': return 'coleco';
        case 'a26': return 'atari2600';
        case 'a78': return 'atari7800';
        case 'j64': case 'jag': return 'jaguar';
        case 'vb':  case 'vboy': return 'vb';
        case 'psx': case 'pbp': case 'cue': case 'chd': case 'iso': return 'psx';
        default: return 'nes';
    }
};

FAR.WM._finalizeViewer = function (win) {
    if (!win || !win.props) return;

    if (win.props._resizeObserver) {
        try { win.props._resizeObserver.disconnect(); } catch (e) {}
        win.props._resizeObserver = null;
    }

    if (win.props._jsdosInstance) {
        try { win.props._jsdosInstance.stop(); } catch (e) {}
        win.props._jsdosInstance = null;
    }

    if (window.EJS_emulator && typeof window.EJS_emulator.pause === 'function') {
        try { window.EJS_emulator.pause(); } catch (e) {}
    }
    try { window.EJS_emulator = null; } catch (e) {}
    try { window.EJS_gameUrl = ''; } catch (e) {}

    if (Array.isArray(win.props._jsdosBlobUrls)) {
        win.props._jsdosBlobUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
        win.props._jsdosBlobUrls = [];
    }

    if (Array.isArray(win.props._emuBlobUrls)) {
        win.props._emuBlobUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) {} });
        win.props._emuBlobUrls = [];
    }

    if (win.bodyEl) {
        try { win.bodyEl.innerHTML = ''; } catch (e) {}
    }

    try {
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        document.body.focus();
    } catch (e) {}
};