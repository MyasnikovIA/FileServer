// ============================================================
// 53-videochat-broadcaster.js — запуск трансляции через плагин
// «Video Chat Broadcaster (WebRTC) 3.0.0».
// ============================================================
// Добавлена поддержка трансляции экрана (Screen Sharing).

FAR.Broadcaster = FAR.Broadcaster || {};

FAR.Broadcaster.state = {
    detected: false,        // плагин обнаружен
    detecting: false,       // идёт ping
    started: false,         // start-broadcast успешно отправлен
    room: 'main',           // комната, в которой вещаем
    source: 'camera',       // 'camera' | 'screen'
    _msgId: 0,
    _pending: new Map(),    // __id → { resolve, reject, timer }
    _listenerInstalled: false
};

// Колбэк для UI — переопределяется в _createBroadcasterUI
FAR.Broadcaster.onStateChange = null;

// ============================================================
// Связь с плагином
// ============================================================

FAR.Broadcaster._ensureListener = function () {
    if (FAR.Broadcaster.state._listenerInstalled) return;
    FAR.Broadcaster.state._listenerInstalled = true;

    window.addEventListener('message', function (e) {
        if (e.source !== window) return;
        const d = e.data;
        if (!d || typeof d !== 'object') return;

        // Приветствие от bridge.js при загрузке content-script
        if (d.__extReady) {
            FAR.Broadcaster.state.detected = true;
            console.log('[Broadcaster] plugin ready (extReady)');
            if (typeof FAR.Broadcaster.onStateChange === 'function') {
                try { FAR.Broadcaster.onStateChange(); } catch (err) {}
            }
            return;
        }

        // Ответ на наш запрос
        if (d.__replyTo !== undefined) {
            const pending = FAR.Broadcaster.state._pending.get(d.__replyTo);
            if (pending) {
                clearTimeout(pending.timer);
                FAR.Broadcaster.state._pending.delete(d.__replyTo);
                pending.resolve(d);
            }
        }
    });
};

FAR.Broadcaster._send = function (type, payload, timeoutMs) {
    FAR.Broadcaster._ensureListener();

    return new Promise(function (resolve, reject) {
        const id = 'bc-' + (++FAR.Broadcaster.state._msgId) + '-' + Date.now();
        const timer = setTimeout(function () {
            FAR.Broadcaster.state._pending.delete(id);
            reject(new Error('Плагин не ответил (таймаут)'));
        }, timeoutMs || 2000);

        FAR.Broadcaster.state._pending.set(id, { resolve: resolve, reject: reject, timer: timer });

        try {
            window.postMessage({
                __toExt: true,
                type: type,
                payload: payload || {},
                __id: id
            }, '*');
        } catch (e) {
            clearTimeout(timer);
            FAR.Broadcaster.state._pending.delete(id);
            reject(e);
        }
    });
};

FAR.Broadcaster.detect = async function (timeoutMs) {
    if (FAR.Broadcaster.state.detecting) {
        await new Promise(function (r) { setTimeout(r, 400); });
        return FAR.Broadcaster.state.detected;
    }

    FAR.Broadcaster.state.detecting = true;
    try {
        const resp = await FAR.Broadcaster._send('ext-ping', {}, timeoutMs || 1500);
        if (resp && resp.ok) {
            FAR.Broadcaster.state.detected = true;
            return true;
        }
        return false;
    } catch (e) {
        FAR.Broadcaster.state.detected = false;
        return false;
    } finally {
        FAR.Broadcaster.state.detecting = false;
    }
};

FAR.Broadcaster.start = async function (room, source) {
    room = String(room || 'main').trim() || 'main';
    source = source || 'camera'; // 'camera' или 'screen'

    if (!FAR.Broadcaster.state.detected) {
        const ok = await FAR.Broadcaster.detect();
        if (!ok) {
            throw new Error(
                'Плагин «Video Chat Broadcaster (WebRTC)» не обнаружен. ' +
                'Установите расширение в Chrome/Edge и перезагрузите страницу.'
            );
        }
    }

    const resp = await FAR.Broadcaster._send('start-broadcast', {
        room: room,
        source: source
    }, 5000);

    if (!resp || !resp.ok) {
        throw new Error(
            (resp && resp.error) ||
            'Не удалось запустить трансляцию.'
        );
    }

    FAR.Broadcaster.state.started = true;
    FAR.Broadcaster.state.room = room;
    FAR.Broadcaster.state.source = source;

    try { localStorage.setItem('filebd_vc_broadcast_room', room); } catch (e) {}

    return resp;
};

FAR.Broadcaster.stop = async function () {
    try {
        const resp = await FAR.Broadcaster._send('stop-broadcast', {}, 3000);
        FAR.Broadcaster.state.started = false;
        return resp;
    } catch (e) {
        FAR.Broadcaster.state.started = false;
        throw e;
    }
};

FAR.Broadcaster.getDefaultRoom = function () {
    try {
        return localStorage.getItem('filebd_vc_broadcast_room') || 'main';
    } catch (e) { return 'main'; }
};

// ============================================================
// Публичное API: открыть лаунчер
// ============================================================

FAR.openBroadcaster = function (opts) {
    opts = opts || {};

    if (!FAR.videoChatEnabled) {
        FAR.toast('Трансляции отключены на сервере (videochat.enabled = false)', 'warning');
        return;
    }

    if (typeof FAR.WM !== 'undefined' && FAR.WM.state && FAR.WM.state.active
        && FAR.WM.getApp && FAR.WM.getApp('broadcaster')) {
        return FAR.WM.openApp('broadcaster', { props: opts });
    }

    FAR._openBroadcasterModal(opts);
};

FAR._bcModalApi = null;

FAR._openBroadcasterModal = function (opts) {
    const modal = document.getElementById('videoChatBroadcasterModal');
    const host  = document.getElementById('videoChatBroadcasterHost');
    const title = document.getElementById('videoChatBroadcasterTitle');

    if (!modal || !host) return;

    if (FAR._bcModalApi) {
        try { FAR._bcModalApi.destroy(); } catch (e) {}
        FAR._bcModalApi = null;
    }

    if (title) title.textContent = '🎥 Начать трансляцию';

    FAR._bcModalApi = FAR._createBroadcasterUI(host, opts);
    modal.classList.remove('hidden');
};

FAR.closeBroadcaster = function () {
    const modal = document.getElementById('videoChatBroadcasterModal');
    if (modal) modal.classList.add('hidden');

    if (FAR._bcModalApi) {
        try { FAR._bcModalApi.destroy(); } catch (e) {}
        FAR._bcModalApi = null;
    }
};

FAR.closeBroadcasterOutside = function (e) {
    if (e.target === e.currentTarget) FAR.closeBroadcaster();
};

// ============================================================
// Shared-core: UI лаунчера
// ============================================================

FAR._createBroadcasterUI = function (hostEl, opts) {
    opts = opts || {};
    if (!hostEl) throw new Error('_createBroadcasterUI: hostEl required');

    const wsPort = FAR.videoChatPort || 8081;

    hostEl.innerHTML =
        '<div class="vc-bc-block">' +

        '<div class="vc-bc-status-row" data-role="status-row">' +
        '<span class="vc-bc-status-icon" data-role="status-icon">⏳</span>' +
        '<div class="vc-bc-status-text" data-role="status-text">Проверка плагина…</div>' +
        '</div>' +

        '<div class="vc-bc-field">' +
        '<label for="vcBcSource">Источник видео</label>' +
        '<select id="vcBcSource" class="vc-bc-input">' +
        '<option value="camera">📷 Веб-камера</option>' +
        '<option value="screen">🖥️ Экран монитора</option>' +
        '</select>' +
        '</div>' +

        '<div class="vc-bc-field">' +
        '<label for="vcBcRoom">Комната (Room)</label>' +
        '<input type="text" id="vcBcRoom" class="vc-bc-input" autocomplete="off" spellcheck="false">' +
        '</div>' +

        '<div class="vc-bc-actions">' +
        '<button class="vc-bc-btn vc-bc-start" data-role="start">▶ Начать трансляцию</button>' +
        '<button class="vc-bc-btn vc-bc-stop"  data-role="stop" disabled>■ Остановить</button>' +
        '<button class="vc-bc-btn vc-bc-watch" data-role="watch" disabled>📺 Смотреть</button>' +
        '</div>' +

        '<div class="vc-bc-hint">' +
        '💡 Трансляция идёт через P2P WebRTC: медиа передаётся напрямую ' +
        'зрителям, сервер используется только для сигналинга. ' +
        'Порт <code>' + FAR.escapeHtml(String(wsPort)) + '</code> должен быть открыт.' +
        '</div>' +

        '</div>';

    const statusRow  = hostEl.querySelector('[data-role="status-row"]');
    const statusIcon = hostEl.querySelector('[data-role="status-icon"]');
    const statusText = hostEl.querySelector('[data-role="status-text"]');
    const sourceSelect = hostEl.querySelector('#vcBcSource');
    const roomInput  = hostEl.querySelector('#vcBcRoom');
    const startBtn   = hostEl.querySelector('[data-role="start"]');
    const stopBtn    = hostEl.querySelector('[data-role="stop"]');
    const watchBtn   = hostEl.querySelector('[data-role="watch"]');

    roomInput.value = opts.room || FAR.Broadcaster.getDefaultRoom();
    if (opts.source) sourceSelect.value = opts.source;

    function setStatus(icon, textHtml, cls) {
        statusIcon.textContent = icon;
        statusText.innerHTML = textHtml;
        statusRow.className = 'vc-bc-status-row' + (cls ? ' ' + cls : '');
    }

    function updateButtons() {
        const detected = FAR.Broadcaster.state.detected;
        const started = FAR.Broadcaster.state.started;

        startBtn.disabled = !detected || started;
        stopBtn.disabled  = !started;
        watchBtn.disabled = !started;
        roomInput.disabled = started;
        sourceSelect.disabled = started;
    }

    function render() {
        const detected = FAR.Broadcaster.state.detected;
        const started = FAR.Broadcaster.state.started;
        const room = FAR.Broadcaster.state.room || roomInput.value || 'main';
        const src = FAR.Broadcaster.state.source === 'screen' ? 'Экран' : 'Камера';

        if (started) {
            setStatus(
                '🔴',
                'Трансляция (' + src + ') запущена в комнате <b>' + FAR.escapeHtml(room) + '</b>.' +
                '<br><small>Окно с захватом открылось отдельно. Разрешите доступ.</small>',
                'ok'
            );
        } else if (detected) {
            setStatus('✅', 'Плагин <b>Video Chat Broadcaster</b> обнаружен.', 'ok');
        } else {
            setStatus(
                '❌',
                'Плагин <b>Video Chat Broadcaster</b> не обнаружен.' +
                '<br><small>Установите расширение и перезагрузите страницу.</small>',
                'err'
            );
        }
        updateButtons();
    }

    async function detectWithRetries() {
        if (FAR.Broadcaster.state.detected) { render(); return; }
        for (let i = 0; i < 4; i++) {
            const ok = await FAR.Broadcaster.detect(1000);
            if (ok) break;
            await new Promise(function (r) { setTimeout(r, 400); });
        }
        render();
    }

    startBtn.addEventListener('click', async function () {
        const room = (roomInput.value || '').trim() || 'main';
        const source = sourceSelect.value;
        startBtn.disabled = true;
        startBtn.textContent = '⏳ Запуск…';

        try {
            await FAR.Broadcaster.start(room, source);
            FAR.toast('Трансляция запущена', 'success');
            render();
        } catch (e) {
            FAR.toast(e.message, 'error');
            setStatus('❌', FAR.escapeHtml(e.message), 'err');
            startBtn.disabled = false;
            startBtn.textContent = '▶ Начать трансляцию';
        }
    });

    stopBtn.addEventListener('click', async function () {
        stopBtn.disabled = true;
        try {
            await FAR.Broadcaster.stop();
            FAR.toast('Трансляция остановлена', 'info');
            render();
        } catch (e) {
            FAR.toast('Не удалось остановить: ' + e.message, 'warning');
            stopBtn.disabled = false;
        }
    });

    watchBtn.addEventListener('click', function () {
        const room = FAR.Broadcaster.state.room || roomInput.value || 'main';
        FAR.openVideoChat({ room: room, autoConnect: true });
    });

    roomInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            if (!startBtn.disabled) startBtn.click();
        }
    });

    FAR.Broadcaster.onStateChange = function () { render(); };

    render();
    detectWithRetries();

    return {
        destroy: function () {
            FAR.Broadcaster.onStateChange = null;
            hostEl.innerHTML = '';
        }
    };
};

// ============================================================
// WM-приложение 'broadcaster'
// ============================================================

FAR._registerBroadcasterWmApp = function () {
    if (typeof FAR.WM === 'undefined' || typeof FAR.WM.registerApp !== 'function') return;
    if (FAR.WM.getApp && FAR.WM.getApp('broadcaster')) return;

    FAR.WM.registerApp({
        id: 'broadcaster',
        title: 'Начать трансляцию',
        icon: '🎥',
        keywords: 'трансляция вещание broadcast camera screen экран',
        singleton: true,
        width: 560,
        height: 520, // Чуть увеличили высоту для нового поля
        open: async function (win, props) {
            win.el.querySelector('.wm-title-text').textContent = '🎥 Начать трансляцию';
            win.bodyEl.innerHTML = '';
            win.bodyEl.style.cssText = 'display:flex;flex-direction:column;min-height:0;padding:16px;overflow:auto;background:#1e1e2e;';

            if (win.props._bcApi) {
                try { win.props._bcApi.destroy(); } catch (e) {}
            }
            win.props._bcApi = FAR._createBroadcasterUI(win.bodyEl, props || {});
        },
        onClose: function (win) {
            if (win.props && win.props._bcApi) {
                try { win.props._bcApi.destroy(); } catch (e) {}
                win.props._bcApi = null;
            }
        }
    });
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', FAR._registerBroadcasterWmApp);
} else {
    FAR._registerBroadcasterWmApp();
}

FAR.Broadcaster._ensureListener();

setTimeout(function () {
    FAR.Broadcaster.detect(1000).catch(function () {});
}, 500);

document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('videoChatBroadcasterModal');
    if (!modal || modal.classList.contains('hidden')) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) return;
    FAR.closeBroadcaster();
}, true);