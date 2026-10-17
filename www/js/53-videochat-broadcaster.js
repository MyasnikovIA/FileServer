// ============================================================
// 53-videochat-broadcaster.js — запуск трансляции через плагин
// «Video Chat Broadcaster (WebRTC) 3.0.0».
// ============================================================
//
// Плагин состоит из:
//   • bridge.js (content-script) — пробрасывает postMessage
//     со страницы в background.js;
//   • background.js — открывает окно capture.html с камерой;
//   • capture.js — WebRTC-публикатор, сигналинг через
//     ws://<host>:<videochat.port>/ws/publish?room=<room>.
//
// Протокол bridge ↔ страница:
//   → { __toExt: true, type: 'ext-ping',         __id }
//   → { __toExt: true, type: 'start-broadcast',  __id, payload:{room} }
//   → { __toExt: true, type: 'stop-broadcast',   __id }
//   ← { __extReady: true }                          // при загрузке
//   ← { __replyTo: __id, ok: true }                 // ответ на ping/start/stop
//
// Модуль даёт:
//   • FAR.Broadcaster.* — низкоуровневый API (detect/start/stop);
//   • FAR.openBroadcaster(opts) — UI-лаунчер (модалка или WM-окно);
//   • WM-приложение 'broadcaster'.

FAR.Broadcaster = FAR.Broadcaster || {};

FAR.Broadcaster.state = {
    detected: false,        // плагин обнаружен
    detecting: false,       // идёт ping
    started: false,         // start-broadcast успешно отправлен
    room: 'main',           // комната, в которой вещаем
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

/**
 * Проверить наличие плагина. Возвращает Promise<boolean>.
 */
FAR.Broadcaster.detect = async function (timeoutMs) {
    if (FAR.Broadcaster.state.detecting) {
        // Уже идёт — подождём и вернём текущее состояние
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

/**
 * Запустить трансляцию в комнате.
 * @param {string} room
 * @returns {Promise<{ok:boolean}>}
 * @throws Error если плагин не обнаружен или start-broadcast провалился
 */
FAR.Broadcaster.start = async function (room) {
    room = String(room || 'main').trim() || 'main';

    if (!FAR.Broadcaster.state.detected) {
        const ok = await FAR.Broadcaster.detect();
        if (!ok) {
            throw new Error(
                'Плагин «Video Chat Broadcaster (WebRTC)» не обнаружен. ' +
                'Установите расширение в Chrome/Edge и перезагрузите страницу. ' +
                'В режиме инкогнито расширения по умолчанию отключены.'
            );
        }
    }

    const resp = await FAR.Broadcaster._send('start-broadcast', { room: room }, 5000);
    if (!resp || !resp.ok) {
        throw new Error(
            (resp && resp.error) ||
            'Не удалось запустить трансляцию. Проверьте, что плагин активен и разрешён на этой странице.'
        );
    }

    FAR.Broadcaster.state.started = true;
    FAR.Broadcaster.state.room = room;
    try { localStorage.setItem('filebd_vc_broadcast_room', room); } catch (e) {}

    return resp;
};

/**
 * Остановить трансляцию.
 */
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

    // Оконный режим — WM-приложение
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

    if (!modal || !host) {
        console.error('[Broadcaster] #videoChatBroadcasterModal или #videoChatBroadcasterHost не найден');
        FAR.toast('Модалка трансляции не найдена', 'error');
        return;
    }

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
        '<div class="vc-bc-status-text" data-role="status-text">' +
        'Проверка плагина…' +
        '</div>' +
        '</div>' +

        '<div class="vc-bc-field">' +
        '<label for="vcBcRoom">Комната</label>' +
        '<input type="text" id="vcBcRoom" class="vc-bc-input" ' +
        'autocomplete="off" spellcheck="false">' +
        '</div>' +

        '<div class="vc-bc-actions">' +
        '<button class="vc-bc-btn vc-bc-start" data-role="start">▶ Начать трансляцию</button>' +
        '<button class="vc-bc-btn vc-bc-stop"  data-role="stop" disabled>■ Остановить</button>' +
        '<button class="vc-bc-btn vc-bc-watch" data-role="watch" disabled>📺 Смотреть</button>' +
        '</div>' +

        '<div class="vc-bc-hint">' +
        '💡 Трансляция идёт через P2P WebRTC: медиа передаётся напрямую ' +
        'зрителям, сервер используется только для сигналинга. ' +
        'Убедитесь, что порт <code>' + FAR.escapeHtml(String(wsPort)) + '</code> ' +
        'открыт для зрителей (это <code>videochat.port</code> в config.json).' +
        '</div>' +

        '</div>';

    const statusRow  = hostEl.querySelector('[data-role="status-row"]');
    const statusIcon = hostEl.querySelector('[data-role="status-icon"]');
    const statusText = hostEl.querySelector('[data-role="status-text"]');
    const roomInput  = hostEl.querySelector('#vcBcRoom');
    const startBtn   = hostEl.querySelector('[data-role="start"]');
    const stopBtn    = hostEl.querySelector('[data-role="stop"]');
    const watchBtn   = hostEl.querySelector('[data-role="watch"]');

    roomInput.value = opts.room || FAR.Broadcaster.getDefaultRoom();

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
    }

    function render() {
        const detected = FAR.Broadcaster.state.detected;
        const started = FAR.Broadcaster.state.started;
        const room = FAR.Broadcaster.state.room || roomInput.value || 'main';

        if (started) {
            setStatus(
                '🔴',
                'Трансляция запущена в комнате <b>' + FAR.escapeHtml(room) + '</b>.' +
                '<br><small>Окно с камерой открылось отдельно. ' +
                'Разрешите доступ к камере и микрофону в появившемся окне.</small>',
                'ok'
            );
        } else if (detected) {
            setStatus(
                '✅',
                'Плагин <b>Video Chat Broadcaster (WebRTC)</b> обнаружен.',
                'ok'
            );
        } else {
            setStatus(
                '❌',
                'Плагин <b>Video Chat Broadcaster (WebRTC) 3.0.0</b> не обнаружен.' +
                '<br><small>Установите расширение в Chrome/Edge и перезагрузите страницу. ' +
                'В режиме инкогнито расширения по умолчанию отключены.</small>',
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
        startBtn.disabled = true;
        startBtn.textContent = '⏳ Запуск…';

        try {
            await FAR.Broadcaster.start(room);
            FAR.toast('Трансляция запущена в комнате «' + room + '»', 'success');
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

    // Подписка на отложенный __extReady (content-script мог загрузиться позже)
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
        keywords: 'трансляция вещание broadcast camera stream webrtc камера',
        singleton: true,
        width: 560,
        height: 500,
        open: async function (win, props) {
            win.el.querySelector('.wm-title-text').textContent = '🎥 Начать трансляцию';

            win.bodyEl.innerHTML = '';
            win.bodyEl.style.display = 'flex';
            win.bodyEl.style.flexDirection = 'column';
            win.bodyEl.style.minHeight = '0';
            win.bodyEl.style.padding = '16px';
            win.bodyEl.style.overflow = 'auto';
            win.bodyEl.style.background = '#1e1e2e';

            if (win.props._bcApi) {
                try { win.props._bcApi.destroy(); } catch (e) {}
                win.props._bcApi = null;
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

// ============================================================
// Инициализация
// ============================================================

// Слушаем сообщения от bridge.js с самого начала.
FAR.Broadcaster._ensureListener();

// Первичная попытка обнаружить плагин (может сработать __extReady,
// если content-script уже успел загрузиться к моменту выполнения модуля).
setTimeout(function () {
    FAR.Broadcaster.detect(1000).catch(function () {});
}, 500);

// ESC — закрыть модалку
document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    const modal = document.getElementById('videoChatBroadcasterModal');
    if (!modal || modal.classList.contains('hidden')) return;

    const t = e.target;
    const tag = (t && t.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;

    FAR.closeBroadcaster();
}, true);