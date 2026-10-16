package ru.miacomsoft.server;

// ============================================================
// VirtualResolver.java — перевод виртуального пути в
// (share + относительный путь внутри физического пути).
//
//   ""                      → корень (список shares)
//   "Documents"             → share "Documents", rel=""
//   "Documents/sub/file.txt"→ share "Documents", rel="sub/file.txt"
// ============================================================

import java.nio.file.NoSuchFileException;
import java.nio.file.Path;

public class VirtualResolver {

    public static class Resolved {
        public Config.Share share;      // null для корня
        public String relPath = "";     // путь внутри share
        public Path   physicalPath;     // абсолютный путь на диске
        public boolean isRoot = false;
    }

    /**
     * Разрешает виртуальный путь.
     *
     * @param auth        AuthService для проверки прав
     * @param session     текущая сессия
     * @param virtualPath путь "Documents/sub/file.txt" (без ведущего слэша)
     * @param action      "read" | "write" | "delete"
     * @return Resolved с физическим путём и share
     * @throws SecurityException        — если доступ запрещён
     * @throws NoSuchFileException      — если share не найден / путь некорректен
     * @throws java.util.NoSuchElementException — если share не описан в конфиге
     */
    public static Resolved resolve(AuthService auth, AuthService.Session session,
                                   String virtualPath, String action)
            throws NoSuchFileException {

        String norm = FileService.normalize(virtualPath);

        // Корень
        if (norm.isEmpty()) {
            Resolved r = new Resolved();
            r.isRoot = true;
            return r;
        }

        // Разбор "shareName/rest"
        String shareName;
        String rest;
        int slash = norm.indexOf('/');
        if (slash < 0) { shareName = norm; rest = ""; }
        else           { shareName = norm.substring(0, slash); rest = norm.substring(slash + 1); }

        Config.Share share = auth.config().findShare(shareName);
        if (share == null) {
            throw new java.util.NoSuchElementException("Unknown share: " + shareName);
        }

        // Права
        boolean ok;
        switch (action) {
            case "read":   ok = auth.canRead(session, share);   break;
            case "write":  ok = auth.canWrite(session, share);  break;
            case "delete": ok = auth.canDelete(session, share); break;
            default:       ok = false;
        }
        if (!ok) {
            throw new SecurityException("Access denied to share: " + shareName +
                    " (" + action + ")");
        }

        // Файловый share не имеет детей
        if (share.isFile() && !rest.isEmpty()) {
            throw new NoSuchFileException("File share has no children: " + virtualPath);
        }

        Path physical = share.physicalPath();
        if (!rest.isEmpty()) {
            physical = physical.resolve(rest).normalize();
            if (!physical.startsWith(share.physicalPath())) {
                throw new SecurityException("Path escapes share: " + virtualPath);
            }
        }

        Resolved r = new Resolved();
        r.share = share;
        r.relPath = rest;
        r.physicalPath = physical;
        return r;
    }
}