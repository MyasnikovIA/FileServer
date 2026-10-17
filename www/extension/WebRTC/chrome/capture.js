// capture.js — WebRTC-публикатор.
// Сигналинг: WS ws://<host>:8081/ws/publish?room=<room>
// Для каждого зрителя создаётся отдельный RTCPeerConnection.

const params = new URLSearchParams(location.search);
const room = params.get('room') || 'main';
const host = params.get('host') || 'localhost';

const statusEl  = document.getElementById('status');
const viewersEl = document.getElementById('viewers');
const preview   = document.getElementById('preview');
const stopBtn   = document.getElementById('stop');

const setStatus = s => { console.log('[capture]', s); statusEl.textContent = s; };
const setViewers = n => { viewersEl.textContent = n ? `Зрителей: ${n}` : ''; };

// Должен совпадать с videochat.port в config.json
const WS_PORT = 8081;

// viewerId → RTCPeerConnection
const peers = new Map();

let ws = null;
let stream = null;

document.addEventListener('DOMContentLoaded', async () => {
    try {
        setStatus('Запрос доступа к камере...');
        stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
            audio: { echoCancellation: true, noiseSuppression: true }
        });
        preview.srcObject = stream;

        const wsUrl = `ws://${host}:${WS_PORT}/ws/publish?room=${encodeURIComponent(room)}`;
        setStatus(`Подключение к ${wsUrl}...`);

        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            setStatus('Подключено. Ожидание зрителей...');
        };

        ws.onmessage = (event) => {
            if (typeof event.data !== 'string') return;
            let msg;
            try { msg = JSON.parse(event.data); } catch (e) { return; }

            // Новый зритель — создаём peer и отправляем offer
            if (msg.viewerJoined) {
                handleViewerJoined(msg.viewerJoined);
                return;
            }

            // Зритель ушёл — закрываем peer
            if (msg.viewerLeft) {
                closePeer(msg.viewerLeft);
                return;
            }

            // Ответ (SDP answer) от зрителя
            if (msg.viewerId && msg.sdp && msg.sdp.type === 'answer') {
                const pc = peers.get(msg.viewerId);
                if (pc) {
                    pc.setRemoteDescription(msg.sdp)
                        .catch(err => console.warn('[capture] answer error:', err));
                }
                return;
            }

            // ICE-кандидат от зрителя
            if (msg.viewerId && msg.candidate) {
                const pc = peers.get(msg.viewerId);
                if (pc) {
                    pc.addIceCandidate(msg.candidate)
                        .catch(err => console.warn('[capture] candidate error:', err));
                }
                return;
            }
        };

        ws.onclose = () => {
            setStatus('Соединение закрыто');
            cleanup();
        };

        ws.onerror = (err) => {
            setStatus('Ошибка WebSocket. Проверьте IP и порт.');
            console.error(err);
        };

    } catch (err) {
        setStatus('Ошибка камеры: ' + err.message);
    }
});

// ============================================================
// WebRTC
// ============================================================

async function handleViewerJoined(viewerId) {
    closePeer(viewerId);   // на случай переподключения

    const pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    // Добавляем локальные треки
    stream.getTracks().forEach(track => pc.addTrack(track, stream));

    // Отправка ICE-кандидатов конкретному зрителю
    pc.onicecandidate = (event) => {
        if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                target: viewerId,
                candidate: event.candidate.toJSON()
            }));
        }
    };

    pc.onconnectionstatechange = () => {
        console.log('[capture] peer', viewerId, ':', pc.connectionState);
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            closePeer(viewerId);
        }
    };

    peers.set(viewerId, pc);
    setViewers(peers.size);
    setStatus('Зритель подключился: ' + viewerId.substring(0, 8) + '…');

    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        ws.send(JSON.stringify({
            target: viewerId,
            sdp: pc.localDescription.toJSON()
        }));
    } catch (e) {
        console.error('[capture] offer error:', e);
        closePeer(viewerId);
    }
}

function closePeer(viewerId) {
    const pc = peers.get(viewerId);
    if (pc) {
        try { pc.close(); } catch (e) {}
        peers.delete(viewerId);
        setViewers(peers.size);
    }
}

function cleanup() {
    for (const viewerId of Array.from(peers.keys())) {
        closePeer(viewerId);
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.close(); } catch (e) {}
    }
    ws = null;
    if (stream) {
        stream.getTracks().forEach(t => t.stop());
        stream = null;
    }
}

function stop() {
    cleanup();
    setTimeout(() => window.close(), 200);
}

stopBtn.onclick = stop;
window.addEventListener('beforeunload', cleanup);
chrome.runtime.onMessage.addListener((msg) => { if (msg.type === 'stop') stop(); });