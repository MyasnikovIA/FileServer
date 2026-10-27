package ru.miacomsoft.server;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public class ConsoleHandler implements HttpHandler {

    // ============================================================
    // Буферы событий для fallback-поллинга, по одному на сессию.
    // Ключ — username + "_" + sessionId.
    // ============================================================

    private static final Map<String, ConsoleEventBuffer> BUFFERS = new ConcurrentHashMap<>();

    @Override
    public void handle(HttpExchange ex) throws IOException {
        if (FileServer.handleOptions(ex)) return;

        String path = ex.getRequestURI().getPath();
        if ("/api/console/events".equals(path)) {
            handleEvents(ex);
        } else if ("/api/console/input".equals(path)) {
            handleInput(ex);
        } else if ("/api/console/resize".equals(path)) {
            handleResize(ex);
        } else if ("/api/console/hermes".equals(path)) {
            handleHermesStart(ex);
        } else if ("/api/console/hermes/status".equals(path)) {
            handleHermesStatus(ex);
        } else {
            FileServer.sendError(ex, 404, "Unknown console endpoint: " + path);
        }
    }

    private AuthService.Session auth(HttpExchange ex) throws IOException {
        AuthService.Session s = FileServer.auth().authenticate(ex);
        if (s == null || s.anonymous || s.user == null) {
            FileServer.sendError(ex, 401, "Unauthorized");
            return null;
        }
        if (!s.user.consoleEnabled) {
            FileServer.sendError(ex, 403, "Console is not enabled for this user");
            return null;
        }
        return s;
    }

    private String getSessionId(HttpExchange ex, boolean generateIfMissing) {
        Map<String, String> q = FileServer.parseQuery(ex.getRequestURI().getQuery());
        String sessionId = q.get("sessionId");
        if (sessionId == null || sessionId.isEmpty()) {
            if (generateIfMissing) {
                return UUID.randomUUID().toString();
            }
            return null;
        }
        return sessionId;
    }

    // ============================================================
    // /api/console/events
    //   без ?poll — SSE-стрим (как раньше)
    //   с ?poll=1&since=N — JSON с накопленными событиями
    // ============================================================

    private void handleEvents(HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }

        AuthService.Session s = auth(ex);
        if (s == null) return;

        String sessionId = getSessionId(ex, true);
        String key = s.username + "_" + sessionId;

        Map<String, String> q = FileServer.parseQuery(ex.getRequestURI().getQuery());
        boolean pollMode = "1".equals(q.get("poll"));

        if (pollMode) {
            handleEventsPoll(ex, key, q);
            return;
        }

        // ---- Обычный SSE-режим ----
        FileServer.handleCors(ex);
        ex.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-cache, no-store, must-revalidate");
        ex.getResponseHeaders().set("X-Accel-Buffering", "no");
        ex.sendResponseHeaders(200, 0);

        SseConnection conn = new SseConnection(ex);

        ConsoleSession session = FileServer.console().getOrCreate(key);
        FileServer.console().startShell(key);
        session.attachSse(conn);

        // Гарантируем существование буфера — на случай, если клиент
        // решит перейти на polling.
        ConsoleEventBuffer buf = BUFFERS.computeIfAbsent(key, k -> new ConsoleEventBuffer());
        session.setEventBuffer(buf);

        try {
            JSONObject ready = new JSONObject();
            ready.put("user", s.username);
            ready.put("sessionId", sessionId);
            ready.put("cwd", System.getProperty("user.dir"));
            conn.send("ready", ready.toString());

            // Пинг сразу, чтобы HttpsServer не откладывал flush
            try {
                conn.send("ping", "{\"t\":" + System.currentTimeMillis() + "}");
            } catch (IOException ignored) {}

            while (!session.isClosed()) {
                try {
                    Thread.sleep(5000);
                } catch (InterruptedException ie) {
                    break;
                }
                try {
                    conn.send("ping", "{\"t\":" + System.currentTimeMillis() + "}");
                } catch (IOException io) {
                    break;
                }
            }
        } finally {
            session.detachSse(conn);
            conn.close();
        }
    }

    private void handleEventsPoll(HttpExchange ex, String key, Map<String, String> q)
            throws IOException {
        long since = 0;
        try {
            since = Long.parseLong(q.getOrDefault("since", "0"));
        } catch (Exception ignored) {}

        ConsoleEventBuffer buf = BUFFERS.computeIfAbsent(key, k -> new ConsoleEventBuffer());

        // Гарантируем, что shell запущен — иначе событий не будет.
        FileServer.console().startShell(key);

        JSONObject resp = new JSONObject();
        resp.put("events", buf.since(since));
        resp.put("nextSeq", buf.nextSeq());

        FileServer.sendJson(ex, 200, resp.toString());
    }

    // ============================================================
    // /api/console/input
    // ============================================================

    private void handleInput(HttpExchange ex) throws IOException {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }
        AuthService.Session s = auth(ex);
        if (s == null) return;

        String sessionId = getSessionId(ex, false);
        if (sessionId == null) {
            FileServer.sendError(ex, 400, "sessionId is required");
            return;
        }
        String key = s.username + "_" + sessionId;

        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        try (InputStream is = ex.getRequestBody()) {
            byte[] tmp = new byte[4096];
            int n;
            while ((n = is.read(tmp)) > 0) buf.write(tmp, 0, n);
        }
        String body = new String(buf.toByteArray(), StandardCharsets.UTF_8).trim();
        String data = "";
        if (body.startsWith("{")) {
            try {
                JSONObject o = new JSONObject(body);
                data = o.optString("data", "");
            } catch (Exception e) { /* ignore */ }
        } else {
            data = body;
        }

        // ВАЖНО: создаём сессию и запускаем shell, даже если SSE не
        // открылся. Иначе input уходил бы в никуда.
        FileServer.console().getOrCreate(key);
        FileServer.console().startShell(key);
        FileServer.console().writeInput(key, data);

        JSONObject ok = new JSONObject();
        ok.put("ok", true);
        FileServer.sendJson(ex, 200, ok.toString());
    }

    // ============================================================
    // /api/console/resize
    // ============================================================

    private void handleResize(HttpExchange ex) throws IOException {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }
        AuthService.Session s = auth(ex);
        if (s == null) return;

        String sessionId = getSessionId(ex, false);
        if (sessionId == null) {
            FileServer.sendError(ex, 400, "sessionId is required");
            return;
        }
        String key = s.username + "_" + sessionId;

        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        try (InputStream is = ex.getRequestBody()) {
            byte[] tmp = new byte[4096];
            int n;
            while ((n = is.read(tmp)) > 0) buf.write(tmp, 0, n);
        }
        String body = new String(buf.toByteArray(), StandardCharsets.UTF_8).trim();
        int cols = 80, rows = 24;
        if (body.startsWith("{")) {
            try {
                JSONObject o = new JSONObject(body);
                cols = o.optInt("cols", 80);
                rows = o.optInt("rows", 24);
            } catch (Exception e) { /* ignore */ }
        }

        FileServer.console().getOrCreate(key);
        FileServer.console().startShell(key);
        FileServer.console().resize(key, cols, rows);

        JSONObject ok = new JSONObject();
        ok.put("ok", true);
        FileServer.sendJson(ex, 200, ok.toString());
    }

    // ============================================================
    // /api/console/hermes — запуск профиля Hermes
    // ============================================================

    private void handleHermesStart(HttpExchange ex) throws IOException {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }
        AuthService.Session s = auth(ex);
        if (s == null) return;

        Config cfg = FileServer.config();
        if (cfg == null || !cfg.hermesEnabled) {
            FileServer.sendError(ex, 503, "Hermes module disabled");
            return;
        }

        String sessionId = getSessionId(ex, true);
        String key = s.username + "_" + sessionId;

        FileServer.console().startHermes(key);

        JSONObject resp = new JSONObject();
        resp.put("ok", true);
        resp.put("sessionId", sessionId);
        resp.put("commands", FileServer.console().getHermesCommands().size());
        FileServer.sendJson(ex, 200, resp.toString());
    }

    // ============================================================
    // /api/console/hermes/status
    // ============================================================

    private void handleHermesStatus(HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }
        AuthService.Session s = FileServer.auth().authenticate(ex);
        if (s == null) {
            FileServer.sendError(ex, 401, "Unauthorized");
            return;
        }

        Config cfg = FileServer.config();
        boolean enabled    = cfg != null && cfg.hermesEnabled;
        boolean userCanUse = s.user != null && s.user.consoleEnabled;

        JSONObject resp = new JSONObject();
        resp.put("enabled",    enabled);
        resp.put("userCanUse", userCanUse);
        resp.put("title",      cfg != null ? cfg.hermesTitle : "Hermes Agent");
        resp.put("icon",       cfg != null ? cfg.hermesIcon  : "☤");
        resp.put("commands",   cfg != null ? cfg.hermesCommands.size() : 0);
        FileServer.sendJson(ex, 200, resp.toString());
    }
}