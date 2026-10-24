package ru.miacomsoft.server;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

public class OllamaHandler implements HttpHandler {

    private static final int MAX_BODY_BYTES = 512 * 1024;

    private static class ClientGoneException extends RuntimeException {
        ClientGoneException(Throwable cause) { super(cause); }
    }

    private final OllamaProcessService service;

    public OllamaHandler(OllamaProcessService service) {
        this.service = service;
    }

    @Override
    public void handle(HttpExchange ex) throws IOException {
        if (FileServer.handleOptions(ex)) return;

        String path   = ex.getRequestURI().getPath();
        String method = ex.getRequestMethod().toUpperCase();

        if ("/api/ollama/ping".equals(path)) {
            handlePing(ex, method);
            return;
        }

        AuthService.Session session = FileServer.auth().authenticate(ex);
        if (session == null) {
            ex.getResponseHeaders().set("WWW-Authenticate", "Basic realm=\"FileServer\"");
            FileServer.sendError(ex, 401, "Unauthorized");
            return;
        }

        Config cfg = FileServer.config();
        if (cfg != null && !cfg.ollamaEnabled) {
            FileServer.sendError(ex, 503, "Ollama integration disabled");
            return;
        }

        try {
            switch (path) {
                case "/api/ollama/models":
                    handleModels(ex, method);
                    return;
                case "/api/ollama/running":
                    handleRunning(ex, method);
                    return;
                case "/api/ollama/chat":
                    handleChat(ex, method);
                    return;
                case "/api/ollama/stop":
                    handleStop(ex, method);
                    return;
                case "/api/ollama/stop-all":
                    handleStopAll(ex, method);
                    return;
                default:
                    FileServer.sendError(ex, 404, "Unknown ollama endpoint: " + path);
            }
        } catch (IOException io) {
            io.printStackTrace();
            FileServer.sendError(ex, 502, "Ollama error: " + io.getMessage());
        } catch (Exception e) {
            e.printStackTrace();
            FileServer.sendError(ex, 500, "Server error: " + e.getMessage());
        }
    }

    private void handlePing(HttpExchange ex, String method) throws IOException {
        if (!"GET".equals(method)) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }
        JSONObject res = new JSONObject();
        res.put("available", service.isAvailable());
        res.put("binary", service.getBinary());
        res.put("timestamp", System.currentTimeMillis());
        FileServer.sendJson(ex, 200, res.toString());
    }

    private void handleModels(HttpExchange ex, String method) throws IOException {
        if (!"GET".equals(method)) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }
        FileServer.sendJson(ex, 200, service.listModels().toString());
    }

    private void handleRunning(HttpExchange ex, String method) throws IOException {
        if (!"GET".equals(method)) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }
        FileServer.sendJson(ex, 200, service.listRunning().toString());
    }

    // ============================================================
    // ← НОВОЕ: stop / stop-all
    // ============================================================

    private void handleStop(HttpExchange ex, String method) throws IOException {
        if (!"POST".equals(method)) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }
        String bodyText;
        try {
            bodyText = readBody(ex);
        } catch (IOException io) {
            FileServer.sendError(ex, 400, "Cannot read body: " + io.getMessage());
            return;
        }
        JSONObject req;
        try {
            req = new JSONObject(bodyText);
        } catch (Exception e) {
            FileServer.sendError(ex, 400, "Invalid JSON");
            return;
        }
        String model = req.optString("model", "").trim();
        if (model.isEmpty()) {
            FileServer.sendError(ex, 400, "model is required");
            return;
        }
        JSONObject res = service.stopModel(model);
        FileServer.sendJson(ex, res.optBoolean("ok", false) ? 200 : 502, res.toString());
    }

    private void handleStopAll(HttpExchange ex, String method) throws IOException {
        if (!"POST".equals(method)) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }
        JSONObject res = service.stopAllRunning();
        FileServer.sendJson(ex, res.optBoolean("ok", false) ? 200 : 207, res.toString());
    }

    // ============================================================
    // chat
    // ============================================================

    private void handleChat(HttpExchange ex, String method) throws IOException {
        if (!"POST".equals(method)) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }
        String bodyText;
        try {
            bodyText = readBody(ex);
        } catch (IOException io) {
            FileServer.sendError(ex, 400, "Cannot read body: " + io.getMessage());
            return;
        }
        if (bodyText.length() > MAX_BODY_BYTES) {
            FileServer.sendError(ex, 413, "Request body too large");
            return;
        }
        JSONObject req;
        try {
            req = new JSONObject(bodyText);
        } catch (Exception e) {
            FileServer.sendError(ex, 400, "Invalid JSON: " + e.getMessage());
            return;
        }
        String model = req.optString("model", "").trim();
        if (model.isEmpty()) {
            FileServer.sendError(ex, 400, "model is required");
            return;
        }
        JSONArray messages = req.optJSONArray("messages");
        if (messages == null) messages = new JSONArray();
        JSONObject options = req.optJSONObject("options");

        FileServer.handleCors(ex);
        ex.getResponseHeaders().set("Content-Type", "application/x-ndjson; charset=utf-8");
        ex.getResponseHeaders().set("Cache-Control", "no-cache, no-store, must-revalidate");
        ex.getResponseHeaders().set("X-Accel-Buffering", "no");
        ex.sendResponseHeaders(200, 0);

        OutputStream os = ex.getResponseBody();
        try {
            service.chatStreaming(model, messages, options, chunk -> {
                try {
                    os.write((chunk.toString() + "\n").getBytes(StandardCharsets.UTF_8));
                    os.flush();
                } catch (IOException io) {
                    throw new ClientGoneException(io);
                }
            });
        } catch (ClientGoneException ce) {
            // клиент отвалился — норма
        } catch (IOException io) {
            try {
                JSONObject err = new JSONObject();
                err.put("error", io.getMessage() == null ? "unknown" : io.getMessage());
                err.put("done", true);
                os.write((err.toString() + "\n").getBytes(StandardCharsets.UTF_8));
                os.flush();
            } catch (Exception ignored) {}
        } finally {
            try { os.close(); } catch (IOException ignored) {}
        }
    }

    private String readBody(HttpExchange ex) throws IOException {
        try (InputStream is = ex.getRequestBody()) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] tmp = new byte[4096];
            int n;
            while ((n = is.read(tmp)) > 0) {
                buf.write(tmp, 0, n);
                if (buf.size() > MAX_BODY_BYTES) throw new IOException("Body too large");
            }
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}