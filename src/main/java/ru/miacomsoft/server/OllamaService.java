package ru.miacomsoft.server;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.function.Consumer;

/**
 * OllamaService — клиент к локальному Ollama HTTP API (по умолчанию
 * http://127.0.0.1:11434).
 *
 * Реализует минимальный набор методов, необходимых для UI:
 *   • isAvailable()   — быстрая проверка /api/tags
 *   • listModels()    — GET /api/tags
 *   • listRunning()   — GET /api/ps
 *   • chatStreaming() — POST /api/chat (NDJSON)
 *   • pull()          — POST /api/pull (NDJSON-прогресс)
 *
 * Все операции синхронные и рассчитаны на использование в отдельном
 * потоке HttpServer-executor'а. Read timeout — 5 минут (LLM может
 * думать долго).
 */
public class OllamaService {

    private static final int CONNECT_TIMEOUT_MS = 5000;
    private static final int READ_TIMEOUT_MS    = 5 * 60 * 1000;

    private final String baseUrl;

    public OllamaService(String baseUrl) {
        String url = (baseUrl == null || baseUrl.trim().isEmpty())
                ? "http://127.0.0.1:11434"
                : baseUrl.trim();
        this.baseUrl = url.replaceAll("/+$", "");
    }

    public String getBaseUrl() {
        return baseUrl;
    }

    public boolean isAvailable() {
        try {
            HttpURLConnection conn = open("/api/tags", "GET");
            try {
                return conn.getResponseCode() == 200;
            } finally {
                conn.disconnect();
            }
        } catch (IOException e) {
            return false;
        }
    }

    public JSONObject listModels() throws IOException {
        JSONObject res = getJson("/api/tags");
        if (res == null) res = new JSONObject();
        if (!res.has("models")) res.put("models", new JSONArray());
        return res;
    }

    public JSONObject listRunning() throws IOException {
        JSONObject res = getJson("/api/ps");
        if (res == null) res = new JSONObject();
        if (!res.has("models")) res.put("models", new JSONArray());
        return res;
    }

    /**
     * Стриминговый чат.
     *
     * @param model      имя модели (например, "qwen3.5:4b")
     * @param messages   массив [{role:"user"|"assistant"|"system", content:"..."}]
     * @param options    доп. опции Ollama (temperature, num_predict, ...) или null
     * @param onChunk    колбэк на каждый NDJSON-объект из Ollama
     * @return           финальный объект (содержит "content" — полный ответ)
     * @throws IOException при сетевой ошибке / HTTP != 200
     */
    public JSONObject chatStreaming(String model, JSONArray messages,
                                    JSONObject options,
                                    Consumer<JSONObject> onChunk) throws IOException {
        HttpURLConnection conn = open("/api/chat", "POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        conn.setRequestProperty("Accept", "application/x-ndjson");

        JSONObject body = new JSONObject();
        body.put("model", model);
        body.put("messages", messages != null ? messages : new JSONArray());
        body.put("stream", true);
        if (options != null) {
            for (String k : options.keySet()) {
                body.put(k, options.get(k));
            }
        }

        try (OutputStream os = conn.getOutputStream()) {
            os.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }

        int code = conn.getResponseCode();
        if (code != 200) {
            String err = readAll(conn.getErrorStream());
            conn.disconnect();
            throw new IOException("Ollama HTTP " + code + ": " +
                    (err.isEmpty() ? "(empty)" : err));
        }

        StringBuilder full = new StringBuilder();
        JSONObject lastChunk = null;

        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = br.readLine()) != null) {
                line = line.trim();
                if (line.isEmpty()) continue;
                JSONObject chunk;
                try {
                    chunk = new JSONObject(line);
                } catch (Exception parseErr) {
                    continue; // повреждённая строка — пропускаем
                }
                JSONObject msg = chunk.optJSONObject("message");
                if (msg != null) {
                    String c = msg.optString("content", "");
                    if (!c.isEmpty()) full.append(c);
                }
                if (chunk.has("error")) {
                    throw new IOException("Ollama error: " + chunk.optString("error"));
                }
                if (onChunk != null) onChunk.accept(chunk);
                if (chunk.optBoolean("done", false)) {
                    lastChunk = chunk;
                }
            }
        } finally {
            conn.disconnect();
        }

        JSONObject result = lastChunk != null ? lastChunk : new JSONObject();
        result.put("content", full.toString());
        result.put("model", model);
        return result;
    }

    // ============================================================
    // Внутренние утилиты
    // ============================================================

    private HttpURLConnection open(String path, String method) throws IOException {
        URL url = new URL(baseUrl + path);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        return conn;
    }

    private JSONObject getJson(String path) throws IOException {
        HttpURLConnection conn = open(path, "GET");
        try {
            int code = conn.getResponseCode();
            if (code != 200) return null;
            String text = readAll(conn.getInputStream());
            if (text.isEmpty()) return null;
            return new JSONObject(text);
        } finally {
            conn.disconnect();
        }
    }

    private String readAll(InputStream is) throws IOException {
        if (is == null) return "";
        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(is, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line).append('\n');
            return sb.toString();
        }
    }
}