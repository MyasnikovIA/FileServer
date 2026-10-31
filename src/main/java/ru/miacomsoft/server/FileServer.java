package ru.miacomsoft.server;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.sun.net.httpserver.HttpsConfigurator;
import com.sun.net.httpserver.HttpsServer;
import org.json.JSONObject;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.KeyFactory;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.spec.PKCS8EncodedKeySpec;
import java.util.Base64;
import java.util.Collection;
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
    private static ConsoleService consoleService;
    private static ServerCopyService serverCopy;
    private static VideoChatServer videoChatServer;
    private static OllamaProcessService ollamaService;

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

        String webPathStr = (webOverride != null) ? webOverride : config.webPath;
        webRoot = Paths.get(webPathStr).toAbsolutePath().normalize();
        if (!Files.isDirectory(webRoot)) {
            System.err.println("[FileServer] WARNING: web directory not found: " + webRoot);
        }

        tokens = new TokenService();
        auth   = new AuthService(config, tokens);
        quota  = new QuotaService(auth);
        serverCopy = new ServerCopyService();

        consoleService = new ConsoleService(
                config.consoleShell,
                config.consoleCwd,
                config.consoleTimeoutSec,
                config.consoleMaxOutputBytes);

        // ---- Hermes Agent (профиль консоли) ----
        consoleService.configureHermes(
                config.hermesEnabled,
                config.hermesShell,
                config.hermesCwd,
                config.hermesCommands,
                config.hermesStartupDelayMs,
                config.hermesCommandDelayMs);

        // ---- Ollama через консоль (subprocess `ollama run`) ----
        ollamaService = new OllamaProcessService(
                config.ollamaBinary,
                config.ollamaCwd
        );

        HttpServer server;
        InetSocketAddress addr = new InetSocketAddress(config.host, config.port);
        SSLContext sslContext = null;

        if (config.httpsEnabled && (!config.httpsKeystore.isEmpty() || !config.httpsCert.isEmpty())) {
            sslContext = createSSLContext();
            HttpsServer httpsServer = HttpsServer.create(addr, 0);
            httpsServer.setHttpsConfigurator(new HttpsConfigurator(sslContext));
            server = httpsServer;
            System.out.println("[FileServer] HTTPS mode enabled");
        } else {
            server = HttpServer.create(addr, 0);
            System.out.println("[FileServer] HTTP mode enabled");
        }

        staticHandler = new StaticHandler(webRoot);
        rootHandler   = new RootHandler(staticHandler);

        server.createContext("/api/events",  new SseHandler());
        server.createContext("/api",         new ApiHandler());
        server.createContext("/",            rootHandler);
        server.createContext("/api/console", new ConsoleHandler());
        server.createContext("/api/gpu",     new GpuHandler());
        server.createContext("/api/ollama",  new OllamaHandler(ollamaService));
        server.createContext("/api/proxy",   ex -> ProxyHandler.handle(ex));

        server.setExecutor(Executors.newFixedThreadPool(16));
        server.start();

        if (config.videoChatEnabled) {
            videoChatServer = new VideoChatServer(config.videoChatPort, config.wsGuid, sslContext);
            try {
                videoChatServer.start();
            } catch (Exception e) {
                System.err.println("[FileServer] Failed to start VideoChat: " + e.getMessage());
            }
        }

        startWatcher();

        System.out.println("[FileServer] started");
        String proto = config.httpsEnabled ? "https" : "http";
        System.out.println("  listen   : " + proto + "://" + config.host + ":" + config.port);
        System.out.println("  web root : " + webRoot + (Files.isDirectory(webRoot) ? "" : "  [NOT FOUND]"));
        System.out.println("  users    : " + config.users.keySet());
        System.out.println("  shares   : " + config.shares.size());
        System.out.println("  ollama   : " + config.ollamaBinary +
                (config.ollamaEnabled ? " (via process)" : "  [DISABLED]"));
        System.out.println("  hermes   : " + (config.hermesEnabled
                ? ("enabled (" + config.hermesCommands.size() + " cmds)")
                : "disabled"));

        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            try { server.stop(0); } catch (Exception ignored) {}
            try { if (fileWatcher != null) fileWatcher.stop(); } catch (Exception ignored) {}
            try { if (videoChatServer != null) videoChatServer.stop(); } catch (Exception ignored) {}
            try { if (serverCopy != null) serverCopy.shutdown(); } catch (Exception ignored) {}
            for (SseConnection c : sseClients.values()) c.close();
        }));
    }

    private static SSLContext createSSLContext() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("PKCS12");

        if (!config.httpsKeystore.isEmpty()) {
            try (InputStream is = Files.newInputStream(Paths.get(config.httpsKeystore))) {
                keyStore.load(is, config.httpsPassword.toCharArray());
            }
        } else {
            String certPem = new String(Files.readAllBytes(Paths.get(config.httpsCert)), StandardCharsets.UTF_8);
            CertificateFactory cf = CertificateFactory.getInstance("X.509");
            Collection<? extends Certificate> certs = cf.generateCertificates(new ByteArrayInputStream(certPem.getBytes(StandardCharsets.UTF_8)));
            Certificate[] certChain = certs.toArray(new Certificate[0]);

            String keyPem = new String(Files.readAllBytes(Paths.get(config.httpsKey)), StandardCharsets.UTF_8);
            String privateKeyPEM = keyPem.replaceAll("-----(BEGIN|END) (RSA )?PRIVATE KEY-----", "").replaceAll("\\s", "");
            byte[] encoded = Base64.getDecoder().decode(privateKeyPEM);

            KeyFactory kf = KeyFactory.getInstance("RSA");
            PrivateKey privateKey = kf.generatePrivate(new PKCS8EncodedKeySpec(encoded));

            keyStore.load(null, null);
            keyStore.setKeyEntry("server", privateKey, new char[0], certChain);
        }

        KeyManagerFactory kmf = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
        kmf.init(keyStore, config.httpsPassword.isEmpty() ? null : config.httpsPassword.toCharArray());

        SSLContext sslContext = SSLContext.getInstance("TLS");
        sslContext.init(kmf.getKeyManagers(), null, null);
        return sslContext;
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
    static RootHandler rootHandler() { return rootHandler; }
    static StaticHandler staticHandler() { return staticHandler; }
    static OllamaProcessService ollama() { return ollamaService; }
    static ServerCopyService serverCopy() { return serverCopy; }

    static void broadcastEvent(String event, String data) {
        for (Map.Entry<String, SseConnection> e : sseClients.entrySet()) {
            try { e.getValue().send(event, data); }
            catch (IOException io) { sseClients.remove(e.getKey()); }
        }
    }

    static void handleCors(HttpExchange ex) {
        String origin = ex.getRequestHeaders().getFirst("Origin");
        if (origin != null && !origin.isEmpty()) {
            ex.getResponseHeaders().set("Access-Control-Allow-Origin", origin);
            ex.getResponseHeaders().set("Vary", "Origin");
        } else {
            ex.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
        }

        ex.getResponseHeaders().set("Access-Control-Allow-Credentials", "true");
        ex.getResponseHeaders().set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS, HEAD");
        ex.getResponseHeaders().set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Auth-Token, X-Requested-With");
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
            else result.put(urlDecode(pair.substring(0, idx)), urlDecode(pair.substring(idx + 1)));
        }
        return result;
    }

    static String urlDecode(String s) {
        try { return java.net.URLDecoder.decode(s, "UTF-8"); }
        catch (Exception e) { return s; }
    }
    static ConsoleService console() { return consoleService; }
}