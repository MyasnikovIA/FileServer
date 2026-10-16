package ru.miacomsoft.server;

// ============================================================
// ApiHandler.java — REST + fallback /api/<share>/<path>.
//
// Зарезервированные endpoint-ы:
//   /api/login, /api/logout, /api/whoami, /api/info,
//   /api/list, /api/stat, /api/read, /api/write, /api/mkdir,
//   /api/delete, /api/move, /api/copy, /api/public/*
//
// Всё остальное под /api/ — трактуется как /api/<share>/<path>:
//   /api/test/file.sfc          → share "test"
//   /api/test%2Ffile.sfc        → share "test"
//   /api/Documents/report.pdf   → share "Documents"
// ============================================================

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Objects;

public class ApiHandler implements HttpHandler {

    @Override
    public void handle(HttpExchange ex) throws IOException {
        if (FileServer.handleOptions(ex)) return;

        // Для API используем декодированный путь —
        // %2F уже стал / и разбор идёт по реальным сегментам.
        String path = ex.getRequestURI().getPath();
        String method = ex.getRequestMethod().toUpperCase();
        Map<String, String> q = FileServer.parseQuery(ex.getRequestURI().getQuery());

        // ---- Публичные endpoint-ы (без auth) ----
        if (path.startsWith("/api/public/")) {
            handlePublic(ex, path);
            return;
        }
        if ("/api/login".equals(path)) {
            handleLogin(ex, method, q);
            return;
        }
        if ("/api/logout".equals(path)) {
            handleLogout(ex, method, q);
            return;
        }

        // ---- Аутентификация ----
        AuthService.Session session = FileServer.auth().authenticate(ex);
        if (session == null) {
            ex.getResponseHeaders().set("WWW-Authenticate", "Basic realm=\"FileServer\"");
            FileServer.sendError(ex, 401, "Unauthorized");
            return;
        }

        try {
            switch (path) {
                case "/api/info":    handleInfo(ex, method, session);      return;
                case "/api/whoami":  handleWhoami(ex, method, session);    return;
                case "/api/list":    handleList(ex, method, q, session);   return;
                case "/api/stat":    handleStat(ex, method, q, session);   return;
                case "/api/read":    handleRead(ex, method, q, session);   return;
                case "/api/write":   handleWrite(ex, method, q, session);  return;
                case "/api/mkdir":   handleMkdir(ex, method, q, session);  return;
                case "/api/delete":  handleDelete(ex, method, q, session); return;
                case "/api/move":    handleMove(ex, method, q, session);   return;
                case "/api/copy":    handleCopy(ex, method, q, session);   return;

                default:
                    // ---- Fallback: /api/<share>/<path> ----
                    if (tryApiSharePath(ex, path)) return;

                    FileServer.sendError(ex, 404, "Unknown endpoint: " + path);
            }
        } catch (NoSuchFileException e) {
            FileServer.sendError(ex, 404, "Not found: " + e.getFile());
        } catch (java.util.NoSuchElementException e) {
            FileServer.sendError(ex, 404, e.getMessage());
        } catch (SecurityException e) {
            FileServer.sendError(ex, 403, "Forbidden: " + e.getMessage());
        } catch (QuotaService.QuotaExceededException e) {
            JSONObject o = new JSONObject();
            o.put("error", "Quota exceeded");
            o.put("scope", e.scope);
            o.put("quotaMb", e.quotaMb);
            o.put("usedBytes", e.usedBytes);
            o.put("freeBytes", e.freeBytes);
            o.put("deltaBytes", e.deltaBytes);
            o.put("status", 507);
            FileServer.sendJson(ex, 507, o.toString());
        } catch (IllegalArgumentException e) {
            FileServer.sendError(ex, 400, "Bad request: " + e.getMessage());
        } catch (Exception e) {
            e.printStackTrace();
            FileServer.sendError(ex, 500, "Server error: " + e.getMessage());
        }
    }

    // ============================================================
    // Fallback: /api/<share>/<path>
    // ============================================================
    //
    // path — уже декодированный URI (см. getPath()).
    // Работает как прямой URL /<share>/<path>:
    //   • shares с anonymous:true — без авторизации
    //   • приватные shares — с Bearer / Basic / ?token= / ?user=&pass=
    //
    // Возвращает true, если запрос обработан.
    // ============================================================

    private boolean tryApiSharePath(HttpExchange ex, String path) throws IOException {
        if (!path.startsWith("/api/")) return false;

        String after = path.substring("/api/".length());
        if (after.isEmpty()) return false;

        // Разбор "<shareName>/<rest>". После getPath() %2F уже
        // стал '/', так что можно искать обычный слэш.
        int slash = after.indexOf('/');
        String shareName = slash < 0 ? after : after.substring(0, slash);
        String relDecoded = slash < 0 ? "" : after.substring(slash + 1);

        if (shareName.isEmpty()) return false;

        Config.Share share = FileServer.config().findShare(shareName);
        if (share == null) return false;

        RootHandler rh = FileServer.rootHandler();
        if (rh == null) return false;

        // serveFromShare ожидает уже декодированный rel-путь.
        rh.serveFromShare(ex, share, relDecoded);
        return true;
    }

    // ============================================================
    // /api/login — выдача токена
    // ============================================================

    private void handleLogin(HttpExchange ex, String method, Map<String, String> q)
            throws IOException {
        String user = null, pass = null;

        if ("POST".equals(method)) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            try (InputStream is = ex.getRequestBody()) {
                byte[] tmp = new byte[4096];
                int n;
                while ((n = is.read(tmp)) > 0) buf.write(tmp, 0, n);
            }
            String body = new String(buf.toByteArray(), StandardCharsets.UTF_8).trim();

            if (body.startsWith("{")) {
                try {
                    JSONObject jo = new JSONObject(body);
                    user = jo.optString("user", jo.optString("username", ""));
                    pass = jo.optString("pass", jo.optString("password", ""));
                } catch (Exception e) {
                    FileServer.sendError(ex, 400, "Invalid JSON body");
                    return;
                }
            } else {
                Map<String, String> fq = FileServer.parseQuery(body);
                user = fq.get("user");
                if (user == null) user = fq.get("username");
                pass = fq.get("pass");
                if (pass == null) pass = fq.get("password");
            }
        } else if ("GET".equals(method)) {
            user = q.get("user");
            if (user == null) user = q.get("username");
            pass = q.get("pass");
            if (pass == null) pass = q.get("password");
        } else {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }

        if (user == null || user.trim().isEmpty()) {
            FileServer.sendError(ex, 400, "user is required");
            return;
        }
        user = user.trim();
        if (pass == null) pass = "";

        Config.User u = FileServer.config().users.get(user);
        if (u == null || !Objects.equals(u.password == null ? "" : u.password, pass)) {
            FileServer.sendError(ex, 401, "Invalid credentials");
            return;
        }

        TokenService.Token t = FileServer.tokens().issue(user);

        JSONObject resp = new JSONObject();
        resp.put("ok", true);
        resp.put("token", t.value);
        resp.put("user", user);
        resp.put("issuedAt", t.issuedAt);
        resp.put("expiresAt", t.expiresAt);
        resp.put("ttlMs", TokenService.TTL_MS);
        FileServer.sendJson(ex, 200, resp.toString());
    }

    // ============================================================
    // /api/logout — отзыв токена
    // ============================================================

    private void handleLogout(HttpExchange ex, String method, Map<String, String> q)
            throws IOException {
        String token = null;

        if ("POST".equals(method)) {
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            try (InputStream is = ex.getRequestBody()) {
                byte[] tmp = new byte[4096];
                int n;
                while ((n = is.read(tmp)) > 0) buf.write(tmp, 0, n);
            }
            String body = new String(buf.toByteArray(), StandardCharsets.UTF_8).trim();
            if (body.startsWith("{")) {
                try {
                    JSONObject jo = new JSONObject(body);
                    token = jo.optString("token", "");
                } catch (Exception e) { /* ignore */ }
            } else {
                token = FileServer.parseQuery(body).get("token");
            }
        } else if ("GET".equals(method)) {
            token = q.get("token");
        } else {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }

        if (token == null || token.isEmpty()) {
            String h = ex.getRequestHeaders().getFirst("Authorization");
            if (h != null && h.startsWith("Bearer ")) {
                token = h.substring("Bearer ".length()).trim();
            }
        }

        if (token != null && !token.isEmpty()) {
            FileServer.tokens().revoke(token);
        }

        JSONObject ok = new JSONObject();
        ok.put("ok", true);
        FileServer.sendJson(ex, 200, ok.toString());
    }

    // ============================================================
    // /api/whoami
    // ============================================================

    private void handleWhoami(HttpExchange ex, String method, AuthService.Session s)
            throws IOException {
        if (!"GET".equals(method)) { FileServer.sendError(ex, 405, "Method not allowed"); return; }

        JSONObject o = new JSONObject();
        o.put("anonymous", s.anonymous);
        o.put("username", s.username == null ? JSONObject.NULL : s.username);
        if (s.user != null) {
            o.put("quotaMb", s.user.quotaMb);
        }
        FileServer.sendJson(ex, 200, o.toString());
    }

    // ============================================================
    // /api/info
    // ============================================================

    private void handleInfo(HttpExchange ex, String method, AuthService.Session s)
            throws IOException {
        if (!"GET".equals(method)) { FileServer.sendError(ex, 405, "Method not allowed"); return; }

        JSONObject info = new JSONObject();
        info.put("type", "filesystem");
        info.put("version", "1.4");
        info.put("anonymous", s.anonymous);
        info.put("username", s.username == null ? JSONObject.NULL : s.username);

        long userQuotaMb = -1;
        if (s.user != null && s.user.hasQuota()) userQuotaMb = s.user.quotaMb;
        info.put("userQuotaMb", userQuotaMb);
        info.put("userUsedBytes", FileServer.quota().getUserUsedBytes(s));

        JSONArray sharesArr = new JSONArray();
        for (Config.Share sh : FileServer.config().shares) {
            if (!FileServer.auth().shareVisible(s, sh)) continue;

            JSONObject so = new JSONObject();
            so.put("name", sh.name);
            so.put("type", sh.type);
            so.put("access", new JSONArray(sh.access));
            so.put("quotaMb", sh.quotaMb);
            so.put("usedBytes", FileServer.quota().getShareUsedBytes(sh));
            sharesArr.put(so);
        }
        info.put("shares", sharesArr);

        FileServer.sendJson(ex, 200, info.toString());
    }

    // ============================================================
    // /api/list
    // ============================================================

    private void handleList(HttpExchange ex, String method, Map<String, String> q,
                            AuthService.Session s) throws IOException {
        if (!"GET".equals(method)) { FileServer.sendError(ex, 405, "Method not allowed"); return; }

        String vpath = q.getOrDefault("path", "");
        boolean recursive = "1".equals(q.get("recursive")) || "true".equals(q.get("recursive"));
        String norm = FileService.normalize(vpath);

        JSONArray entries;

        if (norm.isEmpty()) {
            entries = listRootShares(s);
        } else {
            VirtualResolver.Resolved r = VirtualResolver.resolve(
                    FileServer.auth(), s, norm, "read");

            if (r.share.isFile()) {
                entries = new JSONArray();
            } else {
                Path root = r.share.physicalPath();
                List<Map<String, Object>> list = FileService.list(root, r.relPath, recursive);
                entries = new JSONArray();
                for (Map<String, Object> e : list) {
                    JSONObject eo = new JSONObject(e);
                    eo.put("path", r.share.name + "/" + e.get("path"));
                    entries.put(eo);
                }
            }
        }

        JSONObject resp = new JSONObject();
        resp.put("path", norm);
        resp.put("recursive", recursive);
        resp.put("entries", entries);
        FileServer.sendJson(ex, 200, resp.toString());
    }

    private JSONArray listRootShares(AuthService.Session s) {
        JSONArray arr = new JSONArray();
        for (Config.Share sh : FileServer.config().shares) {
            if (!FileServer.auth().shareVisible(s, sh)) continue;

            JSONObject e = new JSONObject();
            e.put("name", sh.name);
            e.put("path", sh.name);
            e.put("isFolder", sh.isFolder());
            e.put("mtime", 0);
            e.put("virtual", true);
            e.put("quotaMb", sh.quotaMb);
            e.put("usedBytes", FileServer.quota().getShareUsedBytes(sh));
            e.put("access", new JSONArray(sh.access));

            if (sh.isFile()) {
                try {
                    e.put("size", Files.size(sh.physicalPath()));
                    String ct = Files.probeContentType(sh.physicalPath());
                    e.put("contentType", ct == null ? "application/octet-stream" : ct);
                    e.put("binary", true);
                } catch (IOException io) {
                    e.put("size", 0L);
                    e.put("contentType", "application/octet-stream");
                    e.put("binary", true);
                }
            } else {
                e.put("size", 0L);
                e.put("contentType", "");
                e.put("binary", false);
            }
            arr.put(e);
        }
        return arr;
    }

    // ============================================================
    // /api/stat
    // ============================================================

    private void handleStat(HttpExchange ex, String method, Map<String, String> q,
                            AuthService.Session s) throws IOException {
        if (!"GET".equals(method)) { FileServer.sendError(ex, 405, "Method not allowed"); return; }

        String vpath = q.getOrDefault("path", "");
        String norm = FileService.normalize(vpath);

        if (norm.isEmpty()) {
            JSONObject result = new JSONObject();
            result.put("name", "/");
            result.put("path", "");
            result.put("isFolder", true);
            result.put("size", 0L);
            result.put("mtime", 0);
            FileServer.sendJson(ex, 200, result.toString());
            return;
        }

        VirtualResolver.Resolved r = VirtualResolver.resolve(
                FileServer.auth(), s, norm, "read");

        if (r.relPath.isEmpty()) {
            JSONObject e = new JSONObject();
            e.put("name", r.share.name);
            e.put("path", r.share.name);
            e.put("isFolder", r.share.isFolder());
            e.put("mtime", 0);
            e.put("virtual", true);
            e.put("quotaMb", r.share.quotaMb);
            e.put("usedBytes", FileServer.quota().getShareUsedBytes(r.share));
            e.put("access", new JSONArray(r.share.access));
            if (r.share.isFile()) {
                try {
                    e.put("size", Files.size(r.physicalPath));
                    String ct = Files.probeContentType(r.physicalPath);
                    e.put("contentType", ct == null ? "application/octet-stream" : ct);
                    e.put("binary", true);
                } catch (IOException io) {
                    e.put("size", 0L);
                    e.put("contentType", "application/octet-stream");
                    e.put("binary", true);
                }
            } else {
                e.put("size", 0L);
                e.put("contentType", "");
                e.put("binary", false);
            }
            FileServer.sendJson(ex, 200, e.toString());
            return;
        }

        Map<String, Object> stat = FileService.stat(r.share.physicalPath(), r.relPath);
        JSONObject eo = new JSONObject(stat);
        eo.put("path", r.share.name + "/" + stat.get("path"));
        FileServer.sendJson(ex, 200, eo.toString());
    }

    // ============================================================
    // /api/read
    // ============================================================

    private void handleRead(HttpExchange ex, String method, Map<String, String> q,
                            AuthService.Session s) throws IOException {
        if (!"GET".equals(method)) { FileServer.sendError(ex, 405, "Method not allowed"); return; }

        String vpath = q.getOrDefault("path", "");
        String norm = FileService.normalize(vpath);
        if (norm.isEmpty()) { FileServer.sendError(ex, 400, "path is required"); return; }

        VirtualResolver.Resolved r = VirtualResolver.resolve(
                FileServer.auth(), s, norm, "read");

        if (r.share.isFile() && r.relPath.isEmpty()) {
            serveFile(ex, r.physicalPath);
            return;
        }
        if (r.share.isFolder()) {
            Path fsPath = r.physicalPath;
            if (!Files.isRegularFile(fsPath)) {
                FileServer.sendError(ex, 404, "Not a file");
                return;
            }
            serveFile(ex, fsPath);
            return;
        }
        FileServer.sendError(ex, 400, "Cannot read");
    }

    private void serveFile(HttpExchange ex, Path fsPath) throws IOException {
        if (!Files.isRegularFile(fsPath)) {
            FileServer.sendError(ex, 404, "Not a file");
            return;
        }
        String ct = Files.probeContentType(fsPath);
        if (ct == null) ct = StaticHandler.guessMime(fsPath.getFileName().toString());
        long size = Files.size(fsPath);

        FileServer.handleCors(ex);
        ex.getResponseHeaders().set("Content-Type", ct);
        ex.sendResponseHeaders(200, size);
        try (InputStream is = Files.newInputStream(fsPath);
             OutputStream os = ex.getResponseBody()) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
        }
    }

    // ============================================================
    // /api/write
    // ============================================================

    private void handleWrite(HttpExchange ex, String method, Map<String, String> q,
                             AuthService.Session s)
            throws IOException, QuotaService.QuotaExceededException {
        if (!"PUT".equals(method) && !"POST".equals(method)) {
            FileServer.sendError(ex, 405, "Method not allowed"); return;
        }

        String vpath = q.getOrDefault("path", "");
        String norm = FileService.normalize(vpath);
        if (norm.isEmpty()) { FileServer.sendError(ex, 400, "path is required"); return; }

        VirtualResolver.Resolved r = VirtualResolver.resolve(
                FileServer.auth(), s, norm, "write");

        if (r.share.isFile() && !r.relPath.isEmpty()) {
            FileServer.sendError(ex, 400, "Cannot write into a file share");
            return;
        }

        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        try (InputStream is = ex.getRequestBody()) {
            byte[] tmp = new byte[16384];
            int n;
            while ((n = is.read(tmp)) > 0) buf.write(tmp, 0, n);
        }
        byte[] data = buf.toByteArray();

        long existingSize = 0;
        if (Files.isRegularFile(r.physicalPath)) existingSize = Files.size(r.physicalPath);
        long delta = data.length - existingSize;

        FileServer.quota().checkWriteQuota(r.share, s, delta);

        Path parent = r.physicalPath.getParent();
        if (parent != null && !Files.exists(parent)) Files.createDirectories(parent);
        Files.write(r.physicalPath, data,
                java.nio.file.StandardOpenOption.CREATE,
                java.nio.file.StandardOpenOption.TRUNCATE_EXISTING,
                java.nio.file.StandardOpenOption.WRITE);

        FileServer.quota().invalidate(r.share);

        JSONObject ok = new JSONObject();
        ok.put("ok", true);
        ok.put("path", norm);
        ok.put("size", data.length);
        FileServer.sendJson(ex, 200, ok.toString());
    }

    // ============================================================
    // /api/mkdir
    // ============================================================

    private void handleMkdir(HttpExchange ex, String method, Map<String, String> q,
                             AuthService.Session s) throws IOException {
        if (!"POST".equals(method)) { FileServer.sendError(ex, 405, "Method not allowed"); return; }

        String vpath = q.getOrDefault("path", "");
        String norm = FileService.normalize(vpath);
        if (norm.isEmpty()) { FileServer.sendError(ex, 400, "path is required"); return; }

        VirtualResolver.Resolved r = VirtualResolver.resolve(
                FileServer.auth(), s, norm, "write");

        if (!r.share.isFolder()) {
            FileServer.sendError(ex, 400, "Cannot create inside file share");
            return;
        }

        Files.createDirectories(r.physicalPath);
        FileServer.quota().invalidate(r.share);

        JSONObject ok = new JSONObject();
        ok.put("ok", true);
        ok.put("path", norm);
        FileServer.sendJson(ex, 200, ok.toString());
    }

    // ============================================================
    // /api/delete
    // ============================================================

    private void handleDelete(HttpExchange ex, String method, Map<String, String> q,
                              AuthService.Session s) throws IOException {
        if (!"DELETE".equals(method) && !"POST".equals(method)) {
            FileServer.sendError(ex, 405, "Method not allowed"); return;
        }

        String vpath = q.getOrDefault("path", "");
        String norm = FileService.normalize(vpath);
        if (norm.isEmpty()) { FileServer.sendError(ex, 400, "path is required"); return; }

        VirtualResolver.Resolved r = VirtualResolver.resolve(
                FileServer.auth(), s, norm, "delete");

        if (r.relPath.isEmpty()) {
            FileServer.sendError(ex, 400, "Cannot delete share root");
            return;
        }

        if (Files.exists(r.physicalPath)) {
            FileService.delete(r.share.physicalPath(), r.relPath);
        }
        FileServer.quota().invalidate(r.share);

        JSONObject ok = new JSONObject();
        ok.put("ok", true);
        ok.put("path", norm);
        FileServer.sendJson(ex, 200, ok.toString());
    }

    // ============================================================
    // /api/move
    // ============================================================

    private void handleMove(HttpExchange ex, String method, Map<String, String> q,
                            AuthService.Session s) throws IOException {
        if (!"POST".equals(method)) { FileServer.sendError(ex, 405, "Method not allowed"); return; }

        String fromV = FileService.normalize(q.getOrDefault("from", ""));
        String toV   = FileService.normalize(q.getOrDefault("to", ""));
        if (fromV.isEmpty() || toV.isEmpty()) {
            FileServer.sendError(ex, 400, "from and to are required"); return;
        }

        VirtualResolver.Resolved rf = VirtualResolver.resolve(
                FileServer.auth(), s, fromV, "delete");
        VirtualResolver.Resolved rt = VirtualResolver.resolve(
                FileServer.auth(), s, toV, "write");

        if (rf.share != rt.share) {
            copyAcrossShares(rf, rt);
            FileService.delete(rf.share.physicalPath(), rf.relPath);
        } else {
            FileService.move(rf.share.physicalPath(), rf.relPath, rt.relPath);
        }

        FileServer.quota().invalidate(rf.share);
        FileServer.quota().invalidate(rt.share);

        JSONObject ok = new JSONObject();
        ok.put("ok", true);
        ok.put("from", fromV);
        ok.put("to", toV);
        FileServer.sendJson(ex, 200, ok.toString());
    }

    // ============================================================
    // /api/copy
    // ============================================================

    private void handleCopy(HttpExchange ex, String method, Map<String, String> q,
                            AuthService.Session s) throws IOException {
        if (!"POST".equals(method)) { FileServer.sendError(ex, 405, "Method not allowed"); return; }

        String fromV = FileService.normalize(q.getOrDefault("from", ""));
        String toV   = FileService.normalize(q.getOrDefault("to", ""));
        if (fromV.isEmpty() || toV.isEmpty()) {
            FileServer.sendError(ex, 400, "from and to are required"); return;
        }

        VirtualResolver.Resolved rf = VirtualResolver.resolve(
                FileServer.auth(), s, fromV, "read");
        VirtualResolver.Resolved rt = VirtualResolver.resolve(
                FileServer.auth(), s, toV, "write");

        if (rf.share != rt.share) {
            copyAcrossShares(rf, rt);
        } else {
            FileService.copy(rf.share.physicalPath(), rf.relPath, rt.relPath);
        }

        FileServer.quota().invalidate(rt.share);

        JSONObject ok = new JSONObject();
        ok.put("ok", true);
        ok.put("from", fromV);
        ok.put("to", toV);
        FileServer.sendJson(ex, 200, ok.toString());
    }

    private void copyAcrossShares(VirtualResolver.Resolved rf,
                                  VirtualResolver.Resolved rt) throws IOException {
        Path src = rf.physicalPath;
        Path dst = rt.physicalPath;

        if (Files.isDirectory(src)) {
            Files.createDirectories(dst);
            try (java.nio.file.DirectoryStream<Path> stream = Files.newDirectoryStream(src)) {
                for (Path child : stream) {
                    Path target = dst.resolve(child.getFileName().toString());
                    if (Files.isDirectory(child)) {
                        Files.createDirectories(target);
                        copyDirRecursive(child, target);
                    } else {
                        Files.copy(child, target,
                                java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                    }
                }
            }
        } else {
            Path parent = dst.getParent();
            if (parent != null && !Files.exists(parent)) Files.createDirectories(parent);
            Files.copy(src, dst, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
    }

    private void copyDirRecursive(Path src, Path dst) throws IOException {
        try (java.nio.file.DirectoryStream<Path> stream = Files.newDirectoryStream(src)) {
            for (Path child : stream) {
                Path target = dst.resolve(child.getFileName().toString());
                if (Files.isDirectory(child)) {
                    Files.createDirectories(target);
                    copyDirRecursive(child, target);
                } else {
                    Files.copy(child, target,
                            java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                }
            }
        }
    }

    // ============================================================
    // /api/public/<shareName>/<rest>
    // ============================================================

    private void handlePublic(HttpExchange ex, String path) throws IOException {
        String after = path.substring("/api/public/".length());
        int slash = after.indexOf('/');
        String shareName = slash < 0 ? after : after.substring(0, slash);
        String rel  = slash < 0 ? "" : after.substring(slash + 1);

        try { shareName = FileServer.urlDecode(shareName); } catch (Exception ignored) {}
        try { rel = FileServer.urlDecode(rel); } catch (Exception ignored) {}

        Config.Share sh = FileServer.auth().findPublicShare(shareName);
        if (sh == null) {
            FileServer.sendError(ex, 403, "Not public: " + shareName);
            return;
        }

        Path fsPath;
        if (sh.isFile() && rel.isEmpty()) {
            fsPath = sh.physicalPath();
        } else if (sh.isFolder()) {
            Path root = sh.physicalPath();
            Path resolved = rel.isEmpty() ? root : root.resolve(rel).normalize();
            if (!resolved.startsWith(root)) {
                FileServer.sendError(ex, 403, "Path escapes share");
                return;
            }
            fsPath = resolved;
        } else {
            FileServer.sendError(ex, 404, "Not a file");
            return;
        }

        if (!Files.isRegularFile(fsPath)) {
            FileServer.sendError(ex, 404, "Not a file");
            return;
        }
        serveFile(ex, fsPath);
    }
}