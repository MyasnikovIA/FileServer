package ru.miacomsoft.server;

// ============================================================
// StaticHandler.java — раздача статики из webRoot.
//
//   tryResolve(cleanPath) → Path или null (если файла нет / блок)
//   serveFile(ex, file)   → отдаёт файл (Content-Type, CORS)
//   handle(ex)            → HttpHandler для "/"
//
//   detectContentType()   → сначала по расширению, потом probeContentType
//   guessMime(name)       → таблица MIME по расширению
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

    // ============================================================
    // Определение Content-Type
    // ============================================================

    /**
     * Определяет MIME-тип для файла.
     *
     * Порядок:
     *   1. Таблица по расширению (детерминировано, не зависит от ОС).
     *   2. Files.probeContentType (системный детектор, если расширение
     *      неизвестно). Полезно для специфичных форматов.
     *   3. application/octet-stream.
     */
    public static String detectContentType(Path file) {
        if (file == null) return "application/octet-stream";

        String name = file.getFileName().toString();

        // 1. По расширению
        String byExt = guessMime(name);
        if (!"application/octet-stream".equals(byExt)) {
            return byExt;
        }

        // 1a. ROM-расширения НЕ должны попадать в probeContentType,
        //     потому что Windows registry может вернуть мусор.
        if (isRomExtension(name)) {
            return "application/octet-stream";
        }

        // 2. Системный детектор — только для того, что не опознали по расширению
        try {
            String ct = Files.probeContentType(file);
            if (ct != null && !ct.isEmpty() && !"content/unknown".equals(ct)) {
                return ct;
            }
        } catch (IOException ignored) { }

        // 3. Ничего не знаем
        return "application/octet-stream";
    }

    private static boolean isRomExtension(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        String[] romExts = {
                ".smc", ".sfc", ".fig", ".swc", ".bsx", ".gd3", ".gd7", ".dx2",
                ".nes",
                ".gb", ".gbc", ".gba", ".nds",
                ".z64", ".n64", ".v64",
                ".md", ".gen", ".smd", ".sms", ".gg", ".32x",
                ".pce", ".ngp", ".ngc", ".ws", ".wsc",
                ".col", ".cv", ".d64", ".a26", ".a78", ".lnx", ".j64", ".jag", ".vb", ".vboy",
                ".bin", ".cue", ".iso", ".img", ".pbp", ".chd",
                ".jsdos", ".dosz"
        };
        for (String ext : romExts) {
            if (lower.endsWith(ext)) return true;
        }
        return false;
    }

    /**
     * MIME-тип по расширению файла.
     * Возвращает "application/octet-stream" для неизвестных расширений.
     */
    public static String guessMime(String name) {
        if (name == null) return "application/octet-stream";
        String lower = name.toLowerCase(Locale.ROOT);

        // ============================================================
        // ROM-образы консолей — ВСЕГДА application/octet-stream.
        //
        // Windows registry может вернуть неожиданный MIME
        // (text/plain, application/x-snes-rom и т.п.), который
        // ломает EmulatorJS (Snes9x не находит ROM и показывает
        // своё внутреннее меню). Явно перечисляем все расширения,
        // чтобы поведение было детерминированным.
        // ============================================================

        // SNES
        if (lower.endsWith(".smc") || lower.endsWith(".sfc") || lower.endsWith(".fig")
                || lower.endsWith(".swc") || lower.endsWith(".bsx") || lower.endsWith(".gd3")
                || lower.endsWith(".gd7") || lower.endsWith(".dx2"))   return "application/octet-stream";

        // NES
        if (lower.endsWith(".nes"))                                return "application/octet-stream";

        // GameBoy / GBC / GBA / NDS
        if (lower.endsWith(".gb") || lower.endsWith(".gbc"))       return "application/octet-stream";
        if (lower.endsWith(".gba"))                                return "application/octet-stream";
        if (lower.endsWith(".nds"))                                return "application/octet-stream";

        // N64
        if (lower.endsWith(".z64") || lower.endsWith(".n64")
                || lower.endsWith(".v64"))                                return "application/octet-stream";

        // Sega MD / Genesis / Master System / Game Gear / 32X
        if (lower.endsWith(".md")  || lower.endsWith(".gen")
                || lower.endsWith(".smd") || lower.endsWith(".sms")
                || lower.endsWith(".gg")  || lower.endsWith(".32x"))      return "application/octet-stream";

        // PC Engine / NeoGeo Pocket / WonderSwan
        if (lower.endsWith(".pce") || lower.endsWith(".ngp")
                || lower.endsWith(".ngc") || lower.endsWith(".ws")
                || lower.endsWith(".wsc"))                                return "application/octet-stream";

        // Coleco / Commodore / Atari / Lynx / Jaguar / Virtual Boy
        if (lower.endsWith(".col") || lower.endsWith(".cv")
                || lower.endsWith(".d64") || lower.endsWith(".a26")
                || lower.endsWith(".a78") || lower.endsWith(".lnx")
                || lower.endsWith(".j64") || lower.endsWith(".jag")
                || lower.endsWith(".vb")  || lower.endsWith(".vboy"))      return "application/octet-stream";

        // PSX / generic disc images
        if (lower.endsWith(".bin") || lower.endsWith(".cue")
                || lower.endsWith(".iso") || lower.endsWith(".img")
                || lower.endsWith(".pbp") || lower.endsWith(".chd"))       return "application/octet-stream";

        // JSDOS-архивы
        if (lower.endsWith(".jsdos") || lower.endsWith(".dosz"))    return "application/octet-stream";

        // ============================================================
        // Web
        // ============================================================
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html; charset=utf-8";
        if (lower.endsWith(".js")   || lower.endsWith(".mjs")) return "application/javascript; charset=utf-8";
        if (lower.endsWith(".css"))                            return "text/css; charset=utf-8";
        if (lower.endsWith(".json"))                           return "application/json; charset=utf-8";
        if (lower.endsWith(".xml"))                            return "application/xml; charset=utf-8";
        if (lower.endsWith(".map"))                            return "application/json; charset=utf-8";
        if (lower.endsWith(".wasm"))                           return "application/wasm";

        // --- Текст ---
        if (lower.endsWith(".txt"))                            return "text/plain; charset=utf-8";
        if (lower.endsWith(".md"))                             return "text/markdown; charset=utf-8";
        if (lower.endsWith(".csv"))                            return "text/csv; charset=utf-8";
        if (lower.endsWith(".log"))                            return "text/plain; charset=utf-8";
        if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "application/x-yaml; charset=utf-8";
        if (lower.endsWith(".ini")  || lower.endsWith(".cfg")) return "text/plain; charset=utf-8";

        // --- Изображения ---
        if (lower.endsWith(".png"))                            return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".gif"))                            return "image/gif";
        if (lower.endsWith(".webp"))                           return "image/webp";
        if (lower.endsWith(".svg"))                            return "image/svg+xml";
        if (lower.endsWith(".bmp"))                            return "image/bmp";
        if (lower.endsWith(".ico"))                            return "image/x-icon";
        if (lower.endsWith(".tif") || lower.endsWith(".tiff")) return "image/tiff";
        if (lower.endsWith(".avif"))                           return "image/avif";

        // --- Аудио ---
        if (lower.endsWith(".mp3"))                            return "audio/mpeg";
        if (lower.endsWith(".m4a"))                            return "audio/mp4";
        if (lower.endsWith(".aac"))                            return "audio/aac";
        if (lower.endsWith(".ogg") || lower.endsWith(".oga"))  return "audio/ogg";
        if (lower.endsWith(".opus"))                           return "audio/opus";
        if (lower.endsWith(".wav"))                            return "audio/wav";
        if (lower.endsWith(".flac"))                           return "audio/flac";

        // --- Видео ---
        if (lower.endsWith(".mp4") || lower.endsWith(".m4v"))  return "video/mp4";
        if (lower.endsWith(".webm"))                           return "video/webm";
        if (lower.endsWith(".mkv"))                            return "video/x-matroska";
        if (lower.endsWith(".mov"))                            return "video/quicktime";
        if (lower.endsWith(".ogv"))                            return "video/ogg";
        if (lower.endsWith(".avi"))                            return "video/x-msvideo";
        if (lower.endsWith(".ts"))                             return "video/mp2t";

        // --- Документы / архивы ---
        if (lower.endsWith(".pdf"))                            return "application/pdf";
        if (lower.endsWith(".zip"))                            return "application/zip";
        if (lower.endsWith(".rar"))                            return "application/vnd.rar";
        if (lower.endsWith(".7z"))                             return "application/x-7z-compressed";
        if (lower.endsWith(".tar"))                            return "application/x-tar";
        if (lower.endsWith(".gz"))                             return "application/gzip";
        if (lower.endsWith(".bz2"))                            return "application/x-bzip2";

        // --- Шрифты ---
        if (lower.endsWith(".woff"))                           return "font/woff";
        if (lower.endsWith(".woff2"))                          return "font/woff2";
        if (lower.endsWith(".ttf"))                            return "font/ttf";
        if (lower.endsWith(".otf"))                            return "font/otf";
        if (lower.endsWith(".eot"))                            return "application/vnd.ms-fontobject";

        return "application/octet-stream";
    }

    // ============================================================
    // resolve
    // ============================================================

    /**
     * Проверяет, есть ли такой файл в webRoot.
     * Возвращает Path или null.
     */
    public Path tryResolve(String cleanPath) {
        if (cleanPath == null) return null;
        if (cleanPath.isEmpty()) cleanPath = "index.html";

        String[] parts = cleanPath.split("/");
        for (String part : parts) {
            if (BLOCKED_SEGMENTS.contains(part)) return null;
        }

        Path target = webRoot.resolve(cleanPath).normalize();
        if (!target.startsWith(webRoot)) return null;
        if (!Files.isRegularFile(target)) return null;
        return target;
    }

    // ============================================================
    // serve
    // ============================================================

    public void serveFile(HttpExchange ex, Path file) throws IOException {
        String method = ex.getRequestMethod().toUpperCase();
        boolean isHead = "HEAD".equals(method);
        if (!isHead && !"GET".equals(method)) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }

        String ct = detectContentType(file);
        long size = Files.size(file);

        FileServer.handleCors(ex);
        ex.getResponseHeaders().set("Content-Type", ct);
        ex.getResponseHeaders().set("Content-Length", String.valueOf(size));
        ex.getResponseHeaders().set("Cache-Control", "no-cache");
        ex.getResponseHeaders().set("X-Content-Type-Options", "nosniff");

        if (isHead) {
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

    // ============================================================
    // full handler
    // ============================================================

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
}