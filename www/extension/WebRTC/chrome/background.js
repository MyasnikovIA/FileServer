// background.js
let captureWindowId = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
    stopAll();
    sendResponse({ ok: true });
    return;
  }
});

async function startCapture(room, host, source) {
  if (captureWindowId !== null) {
    try { await chrome.windows.remove(captureWindowId); } catch {}
    captureWindowId = null;
  }

  const url = chrome.runtime.getURL(
      `capture.html?room=${encodeURIComponent(room)}&host=${encodeURIComponent(host)}&source=${encodeURIComponent(source || 'camera')}`
  );
  const win = await chrome.windows.create({
    url, type: 'popup', width: 640, height: 480
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