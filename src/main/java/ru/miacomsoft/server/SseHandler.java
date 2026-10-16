package ru.miacomsoft.server;
// ============================================================
// SseHandler.java — Server-Sent Events поток.
// Клиент подписывается: new EventSource('/api/events')
// Сервер шлёт события 'ready', 'change', 'ping'.
// ============================================================

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import java.io.IOException;
import java.util.concurrent.atomic.AtomicLong;

public class SseHandler implements HttpHandler {

    private static final AtomicLong ID_GEN = new AtomicLong();

    @Override
    public void handle(HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }

        FileServer.handleCors(ex);
        ex.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-cache, no-store, must-revalidate");
        ex.getResponseHeaders().set("Connection", "keep-alive");
        ex.getResponseHeaders().set("X-Accel-Buffering", "no");
        ex.sendResponseHeaders(200, 0);   // 0 = chunked, без Content-Length

        String id = "sse-" + ID_GEN.incrementAndGet();
        SseConnection conn = new SseConnection(ex);
        FileServer.sseClients.put(id, conn);

        try {
            // Приветствие
            conn.send("ready", "{\"id\":\"" + id + "\"}");

            // Keep-alive раз в 15 секунд (защищает от таймаутов)
            while (true) {
                try { Thread.sleep(15000); }
                catch (InterruptedException ie) { return; }

                try { conn.send("ping", "{\"t\":" + System.currentTimeMillis() + "}"); }
                catch (IOException io) { return; }
            }
        } finally {
            FileServer.sseClients.remove(id);
            conn.close();
        }
    }
}