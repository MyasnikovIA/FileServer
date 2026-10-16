package ru.miacomsoft.server;

// ============================================================
// AuthService.java — аутентификация запроса.
//
// Порядок проверки:
//   1. Authorization: Bearer <token>
//   2. X-Auth-Token: <token>
//   3. Authorization: Basic <base64>
//   4. ?token=<token>
//   5. ?user=<u>&pass=<p>
//   6. Анонимная сессия
// ============================================================

import com.sun.net.httpserver.HttpExchange;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Map;
import java.util.Objects;

public class AuthService {

    public static class Session {
        public String username;      // null для анонима
        public boolean anonymous;
        public Config.User user;     // null для анонима
    }

    private final Config config;
    private final TokenService tokens;

    public AuthService(Config config, TokenService tokens) {
        this.config = config;
        this.tokens = tokens;
    }

    public Config config() { return config; }
    public TokenService tokens() { return tokens; }

    // ---------- Аутентификация ----------

    public Session authenticate(HttpExchange ex) {
        String authHeader  = ex.getRequestHeaders().getFirst("Authorization");
        String tokenHeader = ex.getRequestHeaders().getFirst("X-Auth-Token");

        // 1. Bearer <token>
        if (authHeader != null && authHeader.startsWith("Bearer ")) {
            String tok = authHeader.substring("Bearer ".length()).trim();
            return sessionFromToken(tok);
        }

        // 2. X-Auth-Token
        if (tokenHeader != null && !tokenHeader.isEmpty()) {
            Session s = sessionFromToken(tokenHeader.trim());
            if (s != null) return s;
            // Токен невалиден — не падаем в Basic, продолжаем
        }

        // 3. Basic <base64>
        if (authHeader != null && authHeader.startsWith("Basic ")) {
            return sessionFromBasic(authHeader);
        }

        // 4-5. Query-параметры
        String query = ex.getRequestURI().getQuery();
        Map<String, String> q = FileServer.parseQuery(query);

        String qToken = q.get("token");
        if (qToken != null && !qToken.isEmpty()) {
            Session s = sessionFromToken(qToken);
            if (s == null) return null;   // токен явно указан, но невалиден
            return s;
        }

        String qUser = q.get("user");
        if (qUser == null) qUser = q.get("username");
        if (qUser != null && !qUser.isEmpty()) {
            String qPass = q.get("pass");
            if (qPass == null) qPass = q.get("password");
            return sessionFromCredentials(qUser, qPass == null ? "" : qPass);
        }

        // 6. Аноним
        Session anon = new Session();
        anon.anonymous = true;
        return anon;
    }

    // ---------- Хелперы ----------

    private Session sessionFromToken(String token) {
        if (token == null || token.isEmpty()) return null;
        TokenService.Token t = tokens.validate(token);
        if (t == null) return null;
        return sessionFromUsername(t.username);
    }

    private Session sessionFromBasic(String header) {
        try {
            String b64 = header.substring("Basic ".length()).trim();
            byte[] decoded = Base64.getDecoder().decode(b64);
            String creds = new String(decoded, StandardCharsets.UTF_8);
            int idx = creds.indexOf(':');
            if (idx < 0) return null;
            return sessionFromCredentials(
                    creds.substring(0, idx),
                    creds.substring(idx + 1));
        } catch (Exception e) {
            return null;
        }
    }

    private Session sessionFromUsername(String username) {
        if (username == null) {
            Session s = new Session();
            s.anonymous = true;
            return s;
        }
        Config.User u = config.users.get(username);
        if (u == null) return null;
        Session s = new Session();
        s.username = username;
        s.anonymous = false;
        s.user = u;
        return s;
    }

    private Session sessionFromCredentials(String user, String pass) {
        if (user == null) return null;
        Config.User u = config.users.get(user);
        if (u == null) return null;
        String expected = u.password == null ? "" : u.password;
        if (!Objects.equals(expected, pass == null ? "" : pass)) return null;
        Session s = new Session();
        s.username = user;
        s.anonymous = false;
        s.user = u;
        return s;
    }

    // ---------- Видимость / права ----------

    public boolean shareVisible(Session s, Config.Share sh) {
        if (sh == null || s == null) return false;
        return sh.visibleTo(s.username, s.anonymous);
    }

    public boolean canRead(Session s, Config.Share sh) {
        return shareVisible(s, sh) && sh.hasRead();
    }
    public boolean canWrite(Session s, Config.Share sh) {
        return shareVisible(s, sh) && sh.hasWrite();
    }
    public boolean canDelete(Session s, Config.Share sh) {
        return shareVisible(s, sh) && sh.hasDelete();
    }

    public Config.Share findPublicShare(String shareName) {
        Config.Share sh = config.findShare(shareName);
        if (sh == null) return null;
        if (!sh.anonymous) return null;
        if (!sh.hasRead()) return null;
        return sh;
    }
}