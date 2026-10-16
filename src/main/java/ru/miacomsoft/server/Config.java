package ru.miacomsoft.server;

// ============================================================
// Config.java — разбор config.json.
//
//   http     — { port, host }
//   web      — путь к статике (по умолчанию "www")
//   users[]  — { name, password, quota (МБ, -1 = без лимита) }
//   shares[] — виртуальные «папки/файлы», видимые пользователю.
// ============================================================

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;

public class Config {

    public int port = 8080;
    public String host = "0.0.0.0";
    public String webPath = "www";
    public Map<String, User> users = new LinkedHashMap<>();
    public List<Share> shares = new ArrayList<>();

    // ---------- User ----------

    public static class User {
        public String name = "";
        public String password = "";
        public long quotaMb = -1;

        public boolean hasQuota() { return quotaMb >= 0; }
    }

    // ---------- Share ----------

    public static class Share {
        public String name = "";
        public String physical = "";
        public String type = "folder";
        public Set<String> access = new HashSet<>();
        public boolean anonymous = false;
        public Set<String> users = new HashSet<>();
        public long quotaMb = -1;

        public boolean isFolder() { return "folder".equalsIgnoreCase(type); }
        public boolean isFile()   { return !isFolder(); }

        public boolean hasRead()   { return access.contains("read");   }
        public boolean hasWrite()  { return access.contains("write");  }
        public boolean hasDelete() { return access.contains("delete"); }
        public boolean hasQuota()  { return quotaMb >= 0; }

        public boolean visibleTo(String username, boolean anonymousSession) {
            if (anonymous) return true;
            if (anonymousSession) return false;
            return username != null && users.contains(username);
        }

        public Path physicalPath() {
            return java.nio.file.Paths.get(physical).toAbsolutePath().normalize();
        }
    }

    // ---------- Загрузка ----------

    public static Config load(Path configPath) throws IOException {
        if (!Files.exists(configPath)) {
            throw new IOException("Config file not found: " + configPath);
        }
        String raw = new String(Files.readAllBytes(configPath), StandardCharsets.UTF_8);
        JSONObject root = new JSONObject(raw);

        Config cfg = new Config();

        JSONObject http = root.optJSONObject("http");
        if (http != null) {
            cfg.port = http.optInt("port", cfg.port);
            cfg.host = http.optString("host", cfg.host);
        }

        // web — каталог статики
        String web = root.optString("web", "");
        if (web != null && !web.trim().isEmpty()) {
            cfg.webPath = web.trim();
        }

        JSONArray arrU = root.optJSONArray("users");
        if (arrU != null) {
            for (int i = 0; i < arrU.length(); i++) {
                JSONObject u = arrU.getJSONObject(i);
                User user = new User();
                user.name = u.optString("name", "").trim();
                user.password = u.optString("password", "");
                user.quotaMb = u.optLong("quota", -1);
                if (user.name.isEmpty()) continue;
                cfg.users.put(user.name, user);
            }
        }

        JSONArray arrS = root.optJSONArray("shares");
        if (arrS != null) {
            for (int i = 0; i < arrS.length(); i++) {
                JSONObject s = arrS.getJSONObject(i);
                Share sh = new Share();
                sh.name     = s.optString("name", "").trim();
                sh.physical = s.optString("physical", "").trim();
                sh.type     = s.optString("type", "folder").toLowerCase();
                sh.anonymous = s.optBoolean("anonymous", false);
                sh.quotaMb  = s.optLong("quota", -1);

                JSONArray acc = s.optJSONArray("access");
                if (acc != null) {
                    for (int k = 0; k < acc.length(); k++) {
                        sh.access.add(acc.getString(k).toLowerCase());
                    }
                }
                if (sh.access.isEmpty()) sh.access.add("read");

                JSONArray us = s.optJSONArray("users");
                if (us != null) {
                    for (int k = 0; k < us.length(); k++) {
                        sh.users.add(us.getString(k));
                    }
                }
                if (!sh.name.isEmpty() && !sh.physical.isEmpty()) {
                    cfg.shares.add(sh);
                }
            }
        }

        return cfg;
    }

    public Share findShare(String name) {
        for (Share sh : shares) {
            if (sh.name.equals(name)) return sh;
        }
        return null;
    }
}