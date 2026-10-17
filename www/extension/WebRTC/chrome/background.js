// background.js — открывает окно capture.html с параметрами.
// Сигналинг WebRTC теперь выполняется в capture.js.

let captureWindowId = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'start') {
    startCapture(msg.room, msg.host)
        .then(r => sendResponse(r))
        .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'page-start-broadcast') {
    // Вызов из bridge.js (content script в FAR-приложении)
    startCapture(msg.room || 'main', msg.host || 'localhost')
        .then(r => sendResponse(r))
        .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'stop') {
    stopAll();
    sendResponse({ ok: true });
    return;
  }
});

async function startCapture(room, host) {
  if (captureWindowId !== null) {
    try { await chrome.windows.remove(captureWindowId); } catch {}
    captureWindowId = null;
  }

  const url = chrome.runtime.getURL(
      `capture.html?room=${encodeURIComponent(room)}&host=${encodeURIComponent(host)}`
  );
  const win = await chrome.windows.create({
    url, type: 'popup', width: 480, height: 420
  });
  captureWindowId = win.id;
  return { ok: true };
}

function stopAll() {
  if (captureWindowId !== null) {
    chrome.windows.remove(captureWindowId).catch(() => {});
    captureWindowId = null;
  }
}

chrome.windows.onRemoved.addListener((id) => {
  if (id === captureWindowId) {
    captureWindowId = null;
  }
});