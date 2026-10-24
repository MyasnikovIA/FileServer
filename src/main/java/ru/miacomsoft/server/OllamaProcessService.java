package ru.miacomsoft.server;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * OllamaProcessService — работа с Ollama ТОЛЬКО через CLI (ProcessBuilder).
 *
 * Способы вызова:
 *
 *   1. ТЕКСТ (без картинок):
 *        echo "prompt" | ollama run <model>
 *
 *   2. ТЕКСТ + КАРТИНКИ:
 *        ollama run <model> --image /tmp/a.png --image /tmp/b.png "<prompt>"
 *
 * Порт 11434 (Ollama HTTP API) НЕ используется. Никаких curl,
 * HttpURLConnection и apiUrl. Единственный сетевой endpoint — FileServer
 * на :8080. Ollama запускается как локальный subprocess.
 *
 * Тип модели:
 *   • txt   — обычная LLM (принимает только текст)
 *   • img   — vision-модель (текст + изображения)
 *   • embed — эмбеддинги (только векторный поиск, для чата не годятся)
 */
public class OllamaProcessService {

    private static final int MAX_OUTPUT_BYTES     = 8 * 1024 * 1024;
    private static final long MAX_EXEC_MS         = 30L * 60L * 1000L;

    // Лимит prompt для arg-режима (с images):
    //   Linux  — MAX_ARG_STRLEN = 128 KB
    //   Windows — CreateProcessW ≈ 32 KB
    //   15 KB — безопасно для обеих ОС.
    private static final int MAX_PROMPT_ARG_BYTES = 15 * 1024;

    private static final Pattern ANSI_ESC =
            Pattern.compile("\\x1B\\[[0-?]*[ -/]*[@-~]");
    private static final Pattern ANSI_OSC =
            Pattern.compile("\\x1B\\][^\\x07]*\\x07");
    private static final Pattern CTRL_CHARS =
            Pattern.compile("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]");

    // ============================================================
    // Определение типа модели: txt | img | embed
    // ============================================================

    /** Vision-модели (принимают изображения). */
    private static final Pattern VISION_MODEL_RE = Pattern.compile(
            "(?i)^(llava|bakllava|moondream|llama3\\.2-vision|llama4|" +
                    "qwen2\\.?5?-vl|qwen2-vl|qwen3-vl|minicpm-v|gemma3|" +
                    "granite3\\.2-vision|granite-vision|internvl|pixtral|bunny|molmo|llama-vision)"
    );

    /** Embedding-модели (только для векторного поиска / RAG). */
    private static final Pattern EMBED_MODEL_RE = Pattern.compile(
            "(?i)(embed|minilm|nomic-embed|bge-|mxbai-embed|jina-embed|" +
                    "snowflake-arctic-embed|text-embedding|^e5-)"
    );

    private final String binary;
    private final String workDir;

    public OllamaProcessService(String binary, String workDir) {
        this.binary = (binary == null || binary.trim().isEmpty())
                ? "ollama"
                : binary.trim();
        this.workDir = (workDir == null) ? "" : workDir.trim();
    }

    public String getBinary() { return binary; }

    /**
     * Определяет тип модели по её имени.
     * @return "txt" | "img" | "embed"
     */
    public String detectModelType(String name) {
        if (name == null || name.trim().isEmpty()) return "txt";
        String base = name.split(":")[0].trim();
        // embed проверяем первым: имена вроде "qwen3-embedding"
        // могут содержать подстроки, неоднозначные для vision-паттерна
        if (EMBED_MODEL_RE.matcher(base).find()) return "embed";
        if (VISION_MODEL_RE.matcher(base).find()) return "img";
        return "txt";
    }

    public boolean isVisionModel(String model) {
        return "img".equals(detectModelType(model));
    }

    private boolean hasImagesInMessages(JSONArray messages) {
        if (messages == null) return false;
        for (int i = 0; i < messages.length(); i++) {
            JSONObject m;
            try { m = messages.getJSONObject(i); }
            catch (Exception e) { continue; }
            JSONArray imgs = m.optJSONArray("images");
            if (imgs != null && imgs.length() > 0) return true;
        }
        return false;
    }

    // ============================================================
    // ping / version / list / ps / stop
    // ============================================================

    public boolean isAvailable() {
        try {
            ExecResult r = exec(5, binary, "--version");
            return r.exitCode == 0;
        } catch (Exception e) {
            return false;
        }
    }

    public JSONObject listModels() throws IOException {
        ExecResult r = exec(15, binary, "list");
        if (r.exitCode != 0) {
            throw new IOException("ollama list exit " + r.exitCode + ": " + r.stderr);
        }
        JSONArray models = new JSONArray();
        String[] lines = r.stdout.split("\\r?\\n");
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i].trim();
            if (line.isEmpty()) continue;
            if (i == 0 && line.startsWith("NAME")) continue;

            String[] parts = line.split("\\s{2,}");
            if (parts.length < 3) continue;

            String name = parts[0].trim();
            String type = detectModelType(name);

            JSONObject m = new JSONObject();
            m.put("name",      name);
            m.put("model",     name);
            m.put("type",      type);                        // "txt" | "img" | "embed"
            m.put("vision",    "img".equals(type));          // backward compat
            m.put("embedding", "embed".equals(type));        // backward compat

            if (parts.length >= 2) m.put("id", parts[1].trim());
            if (parts.length >= 3) {
                m.put("size_str", parts[2].trim());
                m.put("size", parseSizeBytes(parts[2].trim()));
            }
            if (parts.length >= 4) {
                StringBuilder mod = new StringBuilder();
                for (int k = 3; k < parts.length; k++) {
                    if (mod.length() > 0) mod.append(' ');
                    mod.append(parts[k].trim());
                }
                m.put("modified", mod.toString());
            }
            models.put(m);
        }
        JSONObject res = new JSONObject();
        res.put("models", models);
        return res;
    }

    public JSONObject listRunning() throws IOException {
        ExecResult r = exec(15, binary, "ps");
        if (r.exitCode != 0) {
            throw new IOException("ollama ps exit " + r.exitCode + ": " + r.stderr);
        }
        JSONArray models = new JSONArray();
        String[] lines = r.stdout.split("\\r?\\n");
        for (int i = 0; i < lines.length; i++) {
            String line = lines[i].trim();
            if (line.isEmpty()) continue;
            if (i == 0 && line.startsWith("NAME")) continue;

            String[] parts = line.split("\\s{2,}");
            if (parts.length < 2) continue;

            JSONObject m = new JSONObject();
            m.put("name",  parts[0].trim());
            m.put("model", parts[0].trim());
            if (parts.length >= 2) m.put("id", parts[1].trim());
            if (parts.length >= 3) {
                m.put("size_str",  parts[2].trim());
                m.put("size_vram", parseSizeBytes(parts[2].trim()));
            }
            if (parts.length >= 4) m.put("processor", parts[3].trim());
            if (parts.length >= 5) m.put("until",     parts[4].trim());
            models.put(m);
        }
        JSONObject res = new JSONObject();
        res.put("models", models);
        return res;
    }

    public JSONObject stopModel(String model) throws IOException {
        if (model == null || model.trim().isEmpty()) {
            throw new IOException("model is required");
        }
        String trimmed = model.trim();
        ExecResult r = exec(30, binary, "stop", trimmed);
        JSONObject res = new JSONObject();
        res.put("model", trimmed);
        if (r.exitCode == 0) {
            res.put("ok", true);
            res.put("message", r.stdout.trim());
        } else {
            res.put("ok", false);
            String err = r.stderr.trim();
            if (err.isEmpty()) err = "exit " + r.exitCode;
            res.put("error", err);
        }
        return res;
    }

    public JSONObject stopAllRunning() throws IOException {
        JSONObject ps;
        try {
            ps = listRunning();
        } catch (IOException io) {
            JSONObject err = new JSONObject();
            err.put("ok", false);
            err.put("error", "Cannot get running models: " + io.getMessage());
            err.put("stopped", new JSONArray());
            err.put("errors", new JSONArray());
            err.put("count", 0);
            return err;
        }
        JSONArray models = ps.optJSONArray("models");
        JSONArray stopped = new JSONArray();
        JSONArray errors  = new JSONArray();
        if (models != null) {
            for (int i = 0; i < models.length(); i++) {
                JSONObject m = models.getJSONObject(i);
                String name = m.optString("name", m.optString("model", "")).trim();
                if (name.isEmpty()) continue;
                try {
                    JSONObject r = stopModel(name);
                    if (r.optBoolean("ok", false)) {
                        stopped.put(name);
                    } else {
                        JSONObject err = new JSONObject();
                        err.put("model", name);
                        err.put("error", r.optString("error", "unknown"));
                        errors.put(err);
                    }
                } catch (IOException io) {
                    JSONObject err = new JSONObject();
                    err.put("model", name);
                    err.put("error", io.getMessage());
                    errors.put(err);
                }
            }
        }
        JSONObject result = new JSONObject();
        result.put("ok",      errors.length() == 0);
        result.put("stopped", stopped);
        result.put("errors",  errors);
        result.put("count",   stopped.length());
        return result;
    }

    // ============================================================
    // chatStreaming — диспетчеризация text / image
    // ============================================================

    public void chatStreaming(String model, JSONArray messages,
                              JSONObject options,
                              Consumer<JSONObject> onChunk) throws IOException {

        if (model == null || model.trim().isEmpty()) {
            throw new IOException("model is required");
        }
        if (!modelExists(model)) {
            throw new IOException("Model not installed: " + model
                    + ". Run `ollama pull " + model + "` on the server first.");
        }
        if (hasImagesInMessages(messages)) {
            chatViaCliWithImages(model, messages, options, onChunk);
        } else {
            chatViaCli(model, messages, options, onChunk);
        }
    }

    // ============================================================
    // 1. Текстовый чат — `ollama run <model>` + stdin
    // ============================================================

    private void chatViaCli(String model, JSONArray messages,
                            JSONObject options,
                            Consumer<JSONObject> onChunk) throws IOException {
        String prompt = buildPrompt(messages);

        ProcessBuilder pb = new ProcessBuilder(binary, "run", model);
        if (!workDir.isEmpty()) pb.directory(new File(workDir));
        pb.redirectErrorStream(false);
        pb.environment().put("TERM", "dumb");
        pb.environment().put("NO_COLOR", "1");
        pb.environment().put("CLICOLOR", "0");

        Process proc;
        try {
            proc = pb.start();
        } catch (IOException io) {
            throw new IOException("Cannot start `" + binary + " run " + model
                    + "`: " + io.getMessage(), io);
        }

        try {
            try (OutputStream stdin = proc.getOutputStream()) {
                stdin.write(prompt.getBytes(StandardCharsets.UTF_8));
                stdin.flush();
            } catch (IOException io) {
                throw new IOException("stdin write failed: " + io.getMessage(), io);
            }

            long start = System.currentTimeMillis();
            long totalBytes = 0;

            try (BufferedReader br = new BufferedReader(
                    new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) {
                    if (System.currentTimeMillis() - start > MAX_EXEC_MS) {
                        proc.destroyForcibly();
                        throw new IOException("ollama run timeout");
                    }
                    String clean = sanitize(line);
                    if (clean.isEmpty()) continue;
                    totalBytes += clean.length();
                    if (totalBytes > MAX_OUTPUT_BYTES) {
                        proc.destroyForcibly();
                        throw new IOException("output exceeds " + MAX_OUTPUT_BYTES + " bytes");
                    }
                    JSONObject chunk = new JSONObject();
                    chunk.put("message", new JSONObject()
                            .put("role", "assistant")
                            .put("content", clean + "\n"));
                    chunk.put("done", false);
                    try {
                        onChunk.accept(chunk);
                    } catch (RuntimeException rt) {
                        proc.destroyForcibly();
                        throw rt;
                    }
                }
            }

            int exit;
            try {
                if (!proc.waitFor(60, TimeUnit.SECONDS)) {
                    proc.destroyForcibly();
                    throw new IOException("ollama run not finished");
                }
                exit = proc.exitValue();
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                proc.destroyForcibly();
                throw new IOException("ollama run interrupted");
            }

            if (exit != 0) {
                String err = readAll(proc.getErrorStream()).trim();
                throw new IOException("ollama run exit " + exit
                        + (err.isEmpty() ? "" : ": " + err));
            }

            JSONObject done = new JSONObject();
            done.put("done", true);
            done.put("model", model);
            try { onChunk.accept(done); } catch (RuntimeException ignored) {}

        } finally {
            if (proc.isAlive()) proc.destroyForcibly();
        }
    }

    // ============================================================
    // 2. Чат с картинками — `ollama run <model> --image <f> … <prompt>`
    // ============================================================

    private void chatViaCliWithImages(String model, JSONArray messages,
                                      JSONObject options,
                                      Consumer<JSONObject> onChunk) throws IOException {
        String prompt = buildPromptForVision(messages);
        // Null-bytes недопустимы в args
        prompt = prompt.replace('\0', ' ');

        List<Path> tempFiles = new ArrayList<>();
        try {
            // Берём картинки только из ПОСЛЕДНЕГО user-сообщения с images
            JSONArray lastImages = null;
            for (int i = messages.length() - 1; i >= 0; i--) {
                JSONObject m = messages.getJSONObject(i);
                JSONArray imgs = m.optJSONArray("images");
                if (imgs != null && imgs.length() > 0) {
                    lastImages = imgs;
                    break;
                }
            }

            if (lastImages != null) {
                for (int i = 0; i < lastImages.length(); i++) {
                    String b64 = lastImages.optString(i, "");
                    if (b64.isEmpty()) continue;
                    try {
                        byte[] bytes = Base64.getDecoder().decode(b64);
                        if (bytes.length == 0) continue;
                        String ext = guessImageExt(bytes);
                        Path tmp = Files.createTempFile("ollama-img-", ext);
                        Files.write(tmp, bytes);
                        tempFiles.add(tmp);
                    } catch (IllegalArgumentException iae) {
                        System.err.println("[Ollama] bad base64 image: " + iae.getMessage());
                    }
                }
            }

            if (tempFiles.isEmpty()) {
                throw new IOException("Не удалось декодировать ни одной картинки");
            }

            List<String> cmd = new ArrayList<>();
            cmd.add(binary);
            cmd.add("run");
            cmd.add(model);
            for (Path t : tempFiles) {
                cmd.add("--image");
                cmd.add(t.toAbsolutePath().toString());
            }
            cmd.add(prompt);

            ProcessBuilder pb = new ProcessBuilder(cmd);
            if (!workDir.isEmpty()) pb.directory(new File(workDir));
            pb.redirectErrorStream(false);
            pb.environment().put("TERM", "dumb");
            pb.environment().put("NO_COLOR", "1");
            pb.environment().put("CLICOLOR", "0");

            Process proc;
            try {
                proc = pb.start();
            } catch (IOException io) {
                throw new IOException("Cannot start `" + binary + " run --image`: "
                        + io.getMessage(), io);
            }

            try {
                long start = System.currentTimeMillis();
                long totalBytes = 0;

                try (BufferedReader br = new BufferedReader(
                        new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = br.readLine()) != null) {
                        if (System.currentTimeMillis() - start > MAX_EXEC_MS) {
                            proc.destroyForcibly();
                            throw new IOException("ollama run --image timeout");
                        }
                        String clean = sanitize(line);
                        if (clean.isEmpty()) continue;
                        totalBytes += clean.length();
                        if (totalBytes > MAX_OUTPUT_BYTES) {
                            proc.destroyForcibly();
                            throw new IOException("output exceeds " + MAX_OUTPUT_BYTES + " bytes");
                        }
                        JSONObject chunk = new JSONObject();
                        chunk.put("message", new JSONObject()
                                .put("role", "assistant")
                                .put("content", clean + "\n"));
                        chunk.put("done", false);
                        try {
                            onChunk.accept(chunk);
                        } catch (RuntimeException rt) {
                            proc.destroyForcibly();
                            throw rt;
                        }
                    }
                }

                int exit;
                try {
                    if (!proc.waitFor(60, TimeUnit.SECONDS)) {
                        proc.destroyForcibly();
                        throw new IOException("ollama run --image not finished");
                    }
                    exit = proc.exitValue();
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    proc.destroyForcibly();
                    throw new IOException("interrupted");
                }

                if (exit != 0) {
                    String err = readAll(proc.getErrorStream()).trim();
                    if (err.toLowerCase().contains("unknown flag")
                            || err.toLowerCase().contains("flag provided but not defined")) {
                        throw new IOException(
                                "Ваша версия `ollama` не поддерживает флаг --image. " +
                                        "Обновите Ollama до 0.1.34 или новее. " +
                                        "(stderr: " + err + ")");
                    }
                    throw new IOException("ollama run exit " + exit
                            + (err.isEmpty() ? "" : ": " + err));
                }

                JSONObject done = new JSONObject();
                done.put("done", true);
                done.put("model", model);
                try { onChunk.accept(done); } catch (RuntimeException ignored) {}

            } finally {
                if (proc.isAlive()) proc.destroyForcibly();
            }

        } finally {
            for (Path t : tempFiles) {
                try { Files.deleteIfExists(t); }
                catch (Exception ignored) {}
            }
        }
    }

    // ============================================================
    // Построение prompt
    // ============================================================

    /**
     * Полный prompt для stdin-режима (без обрезки).
     */
    private String buildPrompt(JSONArray messages) {
        StringBuilder sb = new StringBuilder();
        if (messages == null) messages = new JSONArray();
        for (int i = 0; i < messages.length(); i++) {
            JSONObject m;
            try { m = messages.getJSONObject(i); }
            catch (Exception e) { continue; }
            String role = m.optString("role", "user");
            String content = m.optString("content", "");
            if (content.isEmpty()) continue;
            switch (role) {
                case "system":    sb.append("System: ").append(content).append("\n\n"); break;
                case "assistant": sb.append("Assistant: ").append(content).append("\n"); break;
                case "user":
                default:          sb.append("User: ").append(content).append("\n"); break;
            }
        }
        sb.append("Assistant:");
        return sb.toString();
    }

    /**
     * Prompt для arg-режима (--image). Укладывается в MAX_PROMPT_ARG_BYTES.
     *
     * Стратегия:
     *   1. Первое system-сообщение сохраняется всегда (обрезается до 2000).
     *   2. Остальные сообщения добавляются С КОНЦА (сначала свежие),
     *      пока не кончится бюджет.
     *   3. Длинное сообщение обрезается под остаток бюджета.
     */
    private String buildPromptForVision(JSONArray messages) {
        if (messages == null) messages = new JSONArray();

        int budget = MAX_PROMPT_ARG_BYTES - 20; // запас на "Assistant:"

        String systemSnippet = null;
        if (messages.length() > 0) {
            JSONObject first = messages.optJSONObject(0);
            if (first != null && "system".equals(first.optString("role"))) {
                String sc = first.optString("content", "");
                if (sc.length() > 2000) {
                    sc = sc.substring(0, 2000) + "\n[...truncated]";
                }
                systemSnippet = "System: " + sc + "\n\n";
                budget -= systemSnippet.length();
            }
        }

        StringBuilder tail = new StringBuilder();
        for (int i = messages.length() - 1; i >= 0; i--) {
            JSONObject m = messages.optJSONObject(i);
            if (m == null) continue;
            String role = m.optString("role", "user");
            if (systemSnippet != null && i == 0 && "system".equals(role)) continue;

            String content = m.optString("content", "");
            if (content.isEmpty()) continue;

            String prefix = "assistant".equals(role) ? "Assistant: " : "User: ";
            String line = prefix + content + "\n";

            if (line.length() > budget) {
                int take = budget - prefix.length() - 5;
                if (take > 20) {
                    tail.insert(0, prefix + content.substring(0, take) + "…\n");
                }
                break;
            }
            tail.insert(0, line);
            budget -= line.length();
        }

        StringBuilder sb = new StringBuilder();
        if (systemSnippet != null) sb.append(systemSnippet);
        sb.append(tail);
        sb.append("Assistant:");
        return sb.toString();
    }

    // ============================================================
    // Утилиты
    // ============================================================

    private boolean modelExists(String model) {
        try {
            ExecResult r = exec(15, binary, "list");
            if (r.exitCode != 0) return false;
            String needle1 = model + " ";
            String needle2 = model + ":";
            String needle3 = "\n" + model + "\n";
            String hay = "\n" + r.stdout + "\n";
            return hay.contains(needle1)
                    || hay.contains(needle2)
                    || hay.contains(needle3);
        } catch (Exception e) {
            return false;
        }
    }

    private String sanitize(String s) {
        if (s == null) return "";
        String r = ANSI_ESC.matcher(s).replaceAll("");
        r = ANSI_OSC.matcher(r).replaceAll("");
        r = CTRL_CHARS.matcher(r).replaceAll("");
        String trimmed = r.trim();
        if (trimmed.startsWith(">>> Send a message")) return "";
        if (trimmed.equals(">>>")) return "";
        if (trimmed.matches("^[.\\-•·☆★⠁⠂⠄⡀⢀⠠⠐⠈⠙⠹⠸⠼⠴⠦⠧⠇⠏]+$")) return "";
        return r;
    }

    private String guessImageExt(byte[] bytes) {
        if (bytes == null || bytes.length < 4) return ".bin";
        if ((bytes[0] & 0xFF) == 0x89 && bytes[1] == 'P'
                && bytes[2] == 'N' && bytes[3] == 'G') {
            return ".png";
        }
        if ((bytes[0] & 0xFF) == 0xFF && (bytes[1] & 0xFF) == 0xD8
                && (bytes[2] & 0xFF) == 0xFF) {
            return ".jpg";
        }
        if (bytes[0] == 'G' && bytes[1] == 'I' && bytes[2] == 'F') {
            return ".gif";
        }
        if (bytes.length >= 12
                && bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == 'F'
                && bytes[8] == 'W' && bytes[9] == 'E' && bytes[10] == 'B' && bytes[11] == 'P') {
            return ".webp";
        }
        return ".png";
    }

    private static class ExecResult {
        int exitCode;
        String stdout;
        String stderr;
    }

    private ExecResult exec(int timeoutSec, String... cmd) throws IOException {
        ProcessBuilder pb = new ProcessBuilder(cmd);
        pb.redirectErrorStream(false);
        if (!workDir.isEmpty()) pb.directory(new File(workDir));

        Process proc;
        try {
            proc = pb.start();
        } catch (IOException io) {
            throw new IOException("Cannot start `" + String.join(" ", cmd) + "`: "
                    + io.getMessage(), io);
        }

        ByteArrayOutputStream outBuf = new ByteArrayOutputStream();
        ByteArrayOutputStream errBuf = new ByteArrayOutputStream();

        Thread outT = new Thread(() -> {
            try (InputStream is = proc.getInputStream()) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = is.read(buf)) > 0) outBuf.write(buf, 0, n);
            } catch (IOException ignored) {}
        });
        Thread errT = new Thread(() -> {
            try (InputStream is = proc.getErrorStream()) {
                byte[] buf = new byte[4096];
                int n;
                while ((n = is.read(buf)) > 0) errBuf.write(buf, 0, n);
            } catch (IOException ignored) {}
        });
        outT.setDaemon(true);
        errT.setDaemon(true);
        outT.start();
        errT.start();

        try {
            if (!proc.waitFor(timeoutSec, TimeUnit.SECONDS)) {
                proc.destroyForcibly();
                throw new IOException("`" + String.join(" ", cmd) + "` timeout");
            }
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            proc.destroyForcibly();
            throw new IOException("interrupted");
        }

        try { outT.join(2000); } catch (InterruptedException ignored) {}
        try { errT.join(2000); } catch (InterruptedException ignored) {}

        ExecResult r = new ExecResult();
        r.exitCode = proc.exitValue();
        r.stdout = new String(outBuf.toByteArray(), StandardCharsets.UTF_8);
        r.stderr = new String(errBuf.toByteArray(), StandardCharsets.UTF_8);
        return r;
    }

    private String readAll(InputStream is) {
        if (is == null) return "";
        try (BufferedReader br = new BufferedReader(
                new InputStreamReader(is, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line).append('\n');
            return sb.toString();
        } catch (IOException e) {
            return "";
        }
    }

    private long parseSizeBytes(String s) {
        if (s == null) return 0L;
        String t = s.trim().toUpperCase().replace(",", ".");
        try {
            if (t.endsWith("GB")) return (long) (Double.parseDouble(t.substring(0, t.length() - 2).trim()) * 1_073_741_824L);
            if (t.endsWith("MB")) return (long) (Double.parseDouble(t.substring(0, t.length() - 2).trim()) * 1_048_576L);
            if (t.endsWith("KB")) return (long) (Double.parseDouble(t.substring(0, t.length() - 2).trim()) * 1024L);
            if (t.endsWith("B"))  return (long) Double.parseDouble(t.substring(0, t.length() - 1).trim());
            return (long) Double.parseDouble(t);
        } catch (Exception e) {
            return 0L;
        }
    }
}