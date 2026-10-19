// background.js — версия для Microsoft Edge (Chromium MV3).
//
// Edge полностью совместим с Chrome MV3:
//   • chrome.runtime / chrome.windows / chrome.storage — те же API;
//   • service_worker запускается так же;
//   • все промисы (chrome.windows.create, chrome.runtime.sendMessage)
//     работают начиная с Edge 88 (Chromium 88).
//
// Единственное отличие от Chrome-файла — этот комментарий.

let captureWindowId = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'start') {
        startCapture(msg.room, msg.host, msg.source)
            .then(r => sendResponse(r))
            .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    if (msg.type === 'page-start-broadcast') {
        startCapture(msg.room || 'main', msg.host || 'localhost', msg.source)
            .then(r => sendResponse(r))
            .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }

    if (msg.type === 'stop') {
        stopAll()
            .then(() => sendResponse({ ok: true }))
            .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
    }
});

async function startCapture(room, host, source) {
    // Закрываем предыдущее окно захвата, если оно было
    if (captureWindowId !== null) {
        try { await chrome.windows.remove(captureWindowId); } catch (e) { /* ignore */ }
        captureWindowId = null;
    }

    const url = chrome.runtime.getURL(
        `capture.html?room=${encodeURIComponent(room)}&host=${encodeURIComponent(host)}&source=${encodeURIComponent(source || 'camera')}`
    );

    const win = await chrome.windows.create({
        url,
        type: 'popup',
        width: 640,
        height: 480
    });

    captureWindowId = win.id;
    return { ok: true };
}

async function stopAll() {
    if (captureWindowId !== null) {
        try { await chrome.windows.remove(captureWindowId); } catch (e) { /* ignore */ }
        captureWindowId = null;
    }
}

chrome.windows.onRemoved.addListener((id) => {
    if (id === captureWindowId) {
        captureWindowId = null;
    }
});