package ru.miacomsoft.server;

// ============================================================
// StaticHandler.java — раздача статики из webRoot.
//
//   tryResolve(cleanPath) → Path или null (если файла нет / блок)
//   serveFile(ex, file)   → отдаёт файл (с Content-Type, CORS)
//   handle(ex)            → полноценный HttpHandler для "/"
// ============================================================

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URLDecoder;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Set;

public class StaticHandler implements HttpHandler {

    /** Сегменты пути, которые НИКОГДА не отдаются клиенту. */
    private static final Set<String> BLOCKED_SEGMENTS = Set.of(
            ".idea",
            ".git",
            ".gitignore",
            "config.json"
    );

    private final Path webRoot;

    public StaticHandler(Path webRoot) {
        this.webRoot = webRoot.toAbsolutePath().normalize();
    }

    public Path getWebRoot() { return webRoot; }

    // ---------- resolve ----------

    /**
     * Проверяет, есть ли такой файл в webRoot.
     * Возвращает Path или null.
     * cleanPath — без ведущего слэша, в оригинальном (декодированном) виде.
     */
    public Path tryResolve(String cleanPath) {
        if (cleanPath == null) return null;
        if (cleanPath.isEmpty()) cleanPath = "index.html";

        // Блок-сегменты
        String[] parts = cleanPath.split("/");
        for (String part : parts) {
            if (BLOCKED_SEGMENTS.contains(part)) return null;
        }

        Path target = webRoot.resolve(cleanPath).normalize();
        if (!target.startsWith(webRoot)) return null;
        if (!Files.isRegularFile(target)) return null;
        return target;
    }

    // ---------- serve ----------

    public void serveFile(HttpExchange ex, Path file) throws IOException {
        String method = ex.getRequestMethod().toUpperCase();
        boolean isHead = "HEAD".equals(method);
        if (!isHead && !"GET".equals(method)) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }

        String ct = Files.probeContentType(file);
        if (ct == null) ct = guessMime(file.getFileName().toString());
        long size = Files.size(file);

        FileServer.handleCors(ex);
        ex.getResponseHeaders().set("Content-Type", ct);
        ex.getResponseHeaders().set("Cache-Control", "no-cache");
        ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");

        if (isHead) {
            ex.getResponseHeaders().set("Content-Length", String.valueOf(size));
            ex.sendResponseHeaders(200, -1);
            ex.close();
            return;
        }

        ex.sendResponseHeaders(200, size);
        try (InputStream is = Files.newInputStream(file);
             OutputStream os = ex.getResponseBody()) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
        }
    }

    // ---------- full handler ----------

    @Override
    public void handle(HttpExchange ex) throws IOException {
        if (FileServer.handleOptions(ex)) return;

        String uriPath = ex.getRequestURI().getRawPath();
        if (uriPath == null || uriPath.isEmpty() || "/".equals(uriPath)) {
            uriPath = "/index.html";
        }

        String decoded;
        try { decoded = URLDecoder.decode(uriPath, "UTF-8"); }
        catch (Exception e) { decoded = uriPath; }

        String clean = decoded.replace('\\', '/');
        while (clean.startsWith("/")) clean = clean.substring(1);

        Path file = tryResolve(clean);
        if (file == null) {
            FileServer.sendError(ex, 404, "Not found: " + clean);
            return;
        }
        serveFile(ex, file);
    }

    // ---------- MIME fallback ----------

    public static String guessMime(String name) {
        String lower = name.toLowerCase(Locale.ROOT);

        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
        if (lower.endsWith(".js")   || lower.endsWith(".mjs")) return "application/javascript; charset=utf-8";
        if (lower.endsWith(".css"))                            return "text/css; charset=utf-8";
        if (lower.endsWith(".json"))                           return "application/json; charset=utf-8";
        if (lower.endsWith(".xml"))                            return "application/xml; charset=utf-8";
        if (lower.endsWith(".txt") || lower.endsWith(".md"))   return "text/plain; charset=utf-8";
        if (lower.endsWith(".svg"))                            return "image/svg+xml";
        if (lower.endsWith(".png"))                            return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".gif"))                            return "image/gif";
        if (lower.endsWith(".webp"))                           return "image/webp";
        if (lower.endsWith(".ico"))                            return "image/x-icon";
        if (lower.endsWith(".woff"))                           return "font/woff";
        if (lower.endsWith(".woff2"))                          return "font/woff2";
        if (lower.endsWith(".ttf"))                            return "font/ttf";
        if (lower.endsWith(".otf"))                            return "font/otf";
        if (lower.endsWith(".wasm"))                           return "application/wasm";
        if (lower.endsWith(".map"))                            return "application/json; charset=utf-8";

        return "application/octet-stream";
    }
}