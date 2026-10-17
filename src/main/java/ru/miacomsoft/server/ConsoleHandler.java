package ru.miacomsoft.server;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * HTTP-обработчик модуля Console.
 *
 *   GET  /api/console/events?token=…   — SSE-поток вывода
 *   POST /api/console/exec             — запуск команды
 *                                        { "command": "ls -la" }
 *
 * Права: только пользователи с console:true в config.json.
 */
public class ConsoleHandler implements HttpHandler {

    @Override
    public void handle(HttpExchange ex) throws IOException {
        if (FileServer.handleOptions(ex)) return;

        String path = ex.getRequestURI().getPath();
        if ("/api/console/events".equals(path)) {
            handleEvents(ex);
        } else if ("/api/console/exec".equals(path)) {
            handleExec(ex);
        } else {
            FileServer.sendError(ex, 404, "Unknown console endpoint: " + path);
        }
    }

    // ============================================================
    // SSE: /api/console/events
    // ============================================================

    private void handleEvents(HttpExchange ex) throws IOException {
        if (!"GET".equalsIgnoreCase(ex.getRequestMethod())) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }

        AuthService.Session s = FileServer.auth().authenticate(ex);
        if (s == null || s.anonymous || s.user == null) {
            FileServer.sendError(ex, 401, "Unauthorized");
            return;
        }
        if (!s.user.consoleEnabled) {
            FileServer.sendError(ex, 403, "Console is not enabled for this user");
            return;
        }

        FileServer.handleCors(ex);
        ex.getResponseHeaders().set("Content-Type", "text/event-stream; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-cache, no-store, must-revalidate");
        ex.getResponseHeaders().set("Connection", "keep-alive");
        ex.getResponseHeaders().set("X-Accel-Buffering", "no");
        ex.sendResponseHeaders(200, 0);

        SseConnection conn = new SseConnection(ex);
        String key = s.username;

        ConsoleSession session = FileServer.console().getOrCreate(key);
        session.attachSse(conn);

        try {
            // Приветствие
            JSONObject ready = new JSONObject();
            ready.put("user", key);
            ready.put("cwd", System.getProperty("user.dir"));
            conn.send("ready", ready.toString());

            // Держим соединение; клиент отвалится — send кинет IOException
            while (!session.isClosed()) {
                try { Thread.sleep(15000); }
                catch (InterruptedException ie) { break; }

                try {
                    conn.send("ping", "{\"t\":" + System.currentTimeMillis() + "}");
                } catch (IOException io) {
                    break;
                }
            }
        } finally {
            session.detachSse();
            conn.close();
        }
    }

    // ============================================================
    // POST: /api/console/exec
    // ============================================================

    private void handleExec(HttpExchange ex) throws IOException {
        if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }

        AuthService.Session s = FileServer.auth().authenticate(ex);
        if (s == null || s.anonymous || s.user == null) {
            FileServer.sendError(ex, 401, "Unauthorized");
            return;
        }
        if (!s.user.consoleEnabled) {
            FileServer.sendError(ex, 403, "Console is not enabled for this user");
            return;
        }

        // Тело запроса
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        try (InputStream is = ex.getRequestBody()) {
            byte[] tmp = new byte[4096];
            int n;
            while ((n = is.read(tmp)) > 0) buf.write(tmp, 0, n);
        }

        String body = new String(buf.toByteArray(), StandardCharsets.UTF_8).trim();
        String command = "";

        if (body.startsWith("{")) {
            try {
                JSONObject o = new JSONObject(body);
                command = o.optString("command", "").trim();
            } catch (Exception e) {
                FileServer.sendError(ex, 400, "Invalid JSON");
                return;
            }
        } else {
            command = body;
        }

        if (command.isEmpty()) {
            FileServer.sendError(ex, 400, "command is required");
            return;
        }

        // Запускаем асинхронно — ответ отдаётся сразу,
        // а вывод уйдёт в SSE-поток.
        FileServer.console().execute(s.username, command);

        JSONObject ok = new JSONObject();
        ok.put("ok", true);
        ok.put("queued", command);
        FileServer.sendJson(ex, 200, ok.toString());
    }
}