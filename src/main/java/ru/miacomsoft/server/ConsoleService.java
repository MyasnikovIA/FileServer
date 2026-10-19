package ru.miacomsoft.server;

import java.io.File;
import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class ConsoleService {
    private final String defaultShell;
    private final String defaultCwd;
    private final long timeoutSec;
    private final long maxOutputBytes;

    private final Map<String, ConsoleSession> sessions = new ConcurrentHashMap<>();

    public ConsoleService(String shell, String cwd, long timeoutSec, long maxOutputBytes) {
        this.defaultShell = shell;
        this.defaultCwd = cwd;
        this.timeoutSec = timeoutSec;
        this.maxOutputBytes = maxOutputBytes;
    }

    public ConsoleSession getOrCreate(String sessionId) {
        return sessions.computeIfAbsent(sessionId, id -> new ConsoleSession());
    }

    // Автоматически определяет оболочку, если в конфиге пусто
    private String resolveShell() {
        if (defaultShell != null && !defaultShell.trim().isEmpty()) {
            return defaultShell;
        }

        String os = System.getProperty("os.name").toLowerCase();
        if (os.contains("win")) {
            return "cmd.exe";
        }

        // Ищем доступные оболочки (Linux Mint, Termux, Android)
        String[] candidates = {
                "/bin/bash",
                "/usr/bin/bash",
                "/bin/sh",
                "/usr/bin/sh",
                "/data/data/com.termux/files/usr/bin/bash", // Termux
                "/system/bin/sh" // Android
        };

        for (String c : candidates) {
            if (new File(c).exists()) {
                return c;
            }
        }

        return "sh"; // Если ничего не найдено, пробуем через переменную PATH
    }

    // Автоматически определяет рабочую директорию, если в конфиге пусто или путь не существует
    private String resolveCwd() {
        if (defaultCwd != null && !defaultCwd.trim().isEmpty()) {
            File dir = new File(defaultCwd);
            if (dir.exists() && dir.isDirectory()) {
                return defaultCwd;
            }
        }
        return System.getProperty("user.dir");
    }

    public void startShell(String sessionId) {
        ConsoleSession session = getOrCreate(sessionId);
        if (session.isClosed()) {
            try {
                session.startShell(resolveShell(), resolveCwd());
            } catch (IOException e) {
                System.err.println("[ConsoleService] Ошибка запуска оболочки: " + e.getMessage());
                e.printStackTrace();
            }
        }
    }

    public void startShell(String sessionId, String shell, String cwd) {
        ConsoleSession session = getOrCreate(sessionId);
        if (session.isClosed()) {
            try {
                session.startShell(shell, cwd);
            } catch (IOException e) {
                System.err.println("[ConsoleService] Ошибка запуска оболочки: " + e.getMessage());
            }
        }
    }

    public void writeInput(String sessionId, String data) {
        ConsoleSession session = sessions.get(sessionId);
        if (session != null && !session.isClosed()) {
            try {
                session.writeInput(data);
            } catch (IOException e) {
                System.err.println("[ConsoleService] Ошибка записи в оболочку: " + e.getMessage());
            }
        }
    }

    public void resize(String sessionId, int cols, int rows) {
        ConsoleSession session = sessions.get(sessionId);
        if (session != null && !session.isClosed()) {
            session.resize(cols, rows);
        }
    }

    public void closeSession(String sessionId) {
        ConsoleSession session = sessions.remove(sessionId);
        if (session != null) {
            session.close();
        }
    }
}