package ru.miacomsoft.server;

// ============================================================
// FileServer.java — HTTP-сервер файлового доступа + статика.
//
// Контексты:
//   /api/events  — SSE (самый длинный префикс, регистрируется первым)
//   /api         — REST API + fallback /api/<share>/<path>
//   /            — RootHandler (статика → share)
// ============================================================

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.json.JSONObject;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;

public class FileServer {

    private static Config config;
    private static TokenService tokens;
    private static AuthService auth;
    private static QuotaService quota;
    private static FileWatcher fileWatcher;
    private static Path webRoot;

    // Сохраняем как статические поля, чтобы ApiHandler мог
    // вызвать RootHandler.serveFromShare для /api/<share>/<path>.
    private static StaticHandler staticHandler;
    private static RootHandler   rootHandler;

    static final Map<String, SseConnection> sseClients = new ConcurrentHashMap<>();

    public static void main(String[] args) throws Exception {
        int port = -1;
        String host = null;
        Path configPath = Paths.get("config.json");
        String webOverride = null;

        for (int i = 0; i < args.length - 1; i++) {
            switch (args[i]) {
                case "--port":   port = Integer.parseInt(args[++i]); break;
                case "--host":   host = args[++i]; break;
                case "--config": configPath = Paths.get(args[++i]); break;
                case "--web":    webOverride = args[++i]; break;
            }
        }

        config = Config.load(configPath);
        if (port > 0) config.port = port;
        if (host != null) config.host = host;

        // ---- Каталог статики ----
        String webPathStr = (webOverride != null) ? webOverride : config.webPath;
        webRoot = Paths.get(webPathStr).toAbsolutePath().normalize();
        if (!Files.isDirectory(webRoot)) {
            System.err.println("[FileServer] WARNING: web directory not found: " + webRoot);
            System.err.println("[FileServer] Static files will return 404. " +
                    "Create the directory or fix 'web' in config.json.");
        }

        tokens = new TokenService();
        auth   = new AuthService(config, tokens);
        quota  = new QuotaService(auth);

        HttpServer server = HttpServer.create(
                new InetSocketAddress(config.host, config.port), 0);

        staticHandler = new StaticHandler(webRoot);
        rootHandler   = new RootHandler(staticHandler);

        // Порядок неважен — HttpServer выбирает самый длинный префикс.
        server.createContext("/api/events", new SseHandler());
        server.createContext("/api",        new ApiHandler());
        server.createContext("/",           rootHandler);

        server.setExecutor(Executors.newFixedThreadPool(16));
        server.start();

        startWatcher();

        System.out.println("[FileServer] started");
        System.out.println("  listen   : http://" + config.host + ":" + config.port);
        System.out.println("  web root : " + webRoot +
                (Files.isDirectory(webRoot) ? "" : "  [NOT FOUND]"));
        System.out.println("  users    : " + config.users.keySet());
        System.out.println("  shares   : " + config.shares.size());

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            try { server.stop(0); } catch (Exception ignored) {}
            try { if (fileWatcher != null) fileWatcher.stop(); } catch (Exception ignored) {}
            for (SseConnection c : sseClients.values()) c.close();
        }));
    }

    private static void startWatcher() {
        for (Config.Share sh : config.shares) {
            if (sh.isFolder()) {
                Path p = sh.physicalPath();
                if (Files.isDirectory(p)) {
                    try {
                        fileWatcher = new FileWatcher(p, data -> broadcastEvent("change", data));
                        fileWatcher.start();
                    } catch (IOException e) {
                        System.err.println("Watcher failed: " + e.getMessage());
                    }
                    break;
                }
            }
        }
    }

    static Config config() { return config; }
    static AuthService auth() { return auth; }
    static TokenService tokens() { return tokens; }
    static QuotaService quota() { return quota; }
    static Path webRoot() { return webRoot; }

    /** Доступ к RootHandler для ApiHandler (fallback /api/<share>/<path>). */
    static RootHandler rootHandler() { return rootHandler; }

    /** Доступ к StaticHandler для переиспользования в ApiHandler при необходимости. */
    static StaticHandler staticHandler() { return staticHandler; }

    static void broadcastEvent(String event, String data) {
        for (Map.Entry<String, SseConnection> e : sseClients.entrySet()) {
            try { e.getValue().send(event, data); }
            catch (IOException io) { sseClients.remove(e.getKey()); }
        }
    }

    // ---------- HTTP utilities ----------

    static void handleCors(HttpExchange ex) {
        ex.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        ex.getResponseHeaders().set("Access-Control-Allow-Methods",
                "GET, POST, PUT, DELETE, OPTIONS, HEAD");
        ex.getResponseHeaders().set("Access-Control-Allow-Headers",
                "Content-Type, Authorization, X-Auth-Token, X-Requested-With");
        ex.getResponseHeaders().set("Access-Control-Max-Age", "86400");
    }

    static boolean handleOptions(HttpExchange ex) throws IOException {
        if ("OPTIONS".equalsIgnoreCase(ex.getRequestMethod())) {
            handleCors(ex);
            ex.sendResponseHeaders(204, -1);
            ex.close();
            return true;
        }
        return false;
    }

    static void sendJson(HttpExchange ex, int status, String json) throws IOException {
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        handleCors(ex);
        ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
        ex.sendResponseHeaders(status, body.length);
        try (OutputStream os = ex.getResponseBody()) { os.write(body); }
    }

    static void sendError(HttpExchange ex, int status, String message) throws IOException {
        JSONObject obj = new JSONObject();
        obj.put("error", message == null ? "" : message);
        obj.put("status", status);
        sendJson(ex, status, obj.toString());
    }

    static Map<String, String> parseQuery(String query) {
        Map<String, String> result = new HashMap<>();
        if (query == null || query.isEmpty()) return result;
        for (String pair : query.split("&")) {
            int idx = pair.indexOf('=');
            if (idx < 0) result.put(urlDecode(pair), "");
            else result.put(urlDecode(pair.substring(0, idx)),
                    urlDecode(pair.substring(idx + 1)));
        }
        return result;
    }

    static String urlDecode(String s) {
        try { return URLDecoder.decode(s, "UTF-8"); }
        catch (Exception e) { return s; }
    }
}