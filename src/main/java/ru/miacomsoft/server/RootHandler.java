package ru.miacomsoft.server;

// ============================================================
// RootHandler.java — обработчик "/".
//
// Логика:
//   1. Пробуем статику из webRoot.
//   2. Если нет — первый сегмент как имя share.
//   3. Иначе — 404.
//
//   /                          → www/index.html
//   /index.html                → www/index.html
//   /js/23-main.js             → www/js/23-main.js
//   /test/file.sfc             → share "test", rel="file.sfc"
//   /Documents/report.pdf      → share "Documents", rel="report.pdf"
//
// serveFromShare() — public, используется также в ApiHandler
// для пути /api/<share>/<path>.
// ============================================================

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;

import java.io.IOException;
import java.net.URLDecoder;
import java.nio.file.Files;
import java.nio.file.Path;

public class RootHandler implements HttpHandler {

    private final StaticHandler staticHandler;

    public RootHandler(StaticHandler staticHandler) {
        this.staticHandler = staticHandler;
    }

    @Override
    public void handle(HttpExchange ex) throws IOException {
        if (FileServer.handleOptions(ex)) return;

        // getRawPath → сырой (закодированный) URI.
        // Декодируем один раз, чтобы %20 → пробел, %2F → слэш, и т.д.
        String rawPath = ex.getRequestURI().getRawPath();
        if (rawPath == null || rawPath.isEmpty() || "/".equals(rawPath)) {
            rawPath = "/index.html";
        }

        String decoded;
        try { decoded = URLDecoder.decode(rawPath, "UTF-8"); }
        catch (Exception e) { decoded = rawPath; }

        // Убираем ведущие слэши, нормализуем обратные.
        String clean = decoded.replace('\\', '/');
        while (clean.startsWith("/")) clean = clean.substring(1);

        // 1. Статика
        Path staticFile = staticHandler.tryResolve(clean);
        if (staticFile != null) {
            staticHandler.serveFile(ex, staticFile);
            return;
        }

        // 2. Share — первый сегмент
        int slash = clean.indexOf('/');
        String firstSeg = slash < 0 ? clean : clean.substring(0, slash);

        Config.Share share = FileServer.config().findShare(firstSeg);
        if (share != null) {
            // rel уже декодирован (clean получен через URLDecoder).
            String rel = slash < 0 ? "" : clean.substring(slash + 1);
            serveFromShare(ex, share, rel);
            return;
        }

        // 3. 404
        FileServer.sendError(ex, 404, "Not found: " + clean);
    }

    // ============================================================
    // Публичный метод — можно вызывать из ApiHandler.
    //
    // @param relDecoded — уже декодированный путь внутри share
    //                     (например, "sub/file.sfc"; "" для корня).
    //                     НЕ декодируется повторно.
    // ============================================================

    public void serveFromShare(HttpExchange ex, Config.Share share, String relDecoded)
            throws IOException {

        String method = ex.getRequestMethod().toUpperCase();
        if (!"GET".equals(method) && !"HEAD".equals(method)) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }

        // Нормализация пути (уборка ../, ./ и т.д.)
        String rel = FileService.normalize(relDecoded == null ? "" : relDecoded);

        // Проверка права на чтение в самом share
        if (!share.hasRead()) {
            FileServer.sendError(ex, 403, "Read not allowed for share " + share.name);
            return;
        }

        // Аутентификация: Bearer / Basic / X-Auth-Token / ?token= / ?user=&pass=
        AuthService.Session session = FileServer.auth().authenticate(ex);
        if (session == null) {
            ex.getResponseHeaders().set("WWW-Authenticate", "Basic realm=\"FileServer\"");
            FileServer.sendError(ex, 401, "Unauthorized");
            return;
        }

        // Видимость share для этой сессии
        if (!share.visibleTo(session.username, session.anonymous)) {
            FileServer.sendError(ex, 403, "Access denied to share " + share.name);
            return;
        }

        // Резолвим физический путь
        Path shareRoot = share.physicalPath();
        Path target;

        if (share.isFile()) {
            if (!rel.isEmpty()) {
                FileServer.sendError(ex, 404, "File share has no children");
                return;
            }
            target = shareRoot;
        } else {
            if (rel.isEmpty()) {
                FileServer.sendError(ex, 404,
                        "Directory listing not available via direct URL");
                return;
            }
            target = shareRoot.resolve(rel).normalize();
            if (!target.startsWith(shareRoot)) {
                FileServer.sendError(ex, 403, "Path escapes share");
                return;
            }
        }

        if (!Files.isRegularFile(target)) {
            FileServer.sendError(ex, 404, "Not a file: " + rel);
            return;
        }

        staticHandler.serveFile(ex, target);
    }
}