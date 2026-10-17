package ru.miacomsoft.server;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Менеджер консольных сессий.
 * Ключ — имя пользователя. Один пользователь = одна сессия.
 */
public class ConsoleService {

    private final Map<String, ConsoleSession> sessions = new ConcurrentHashMap<>();

    private final String defaultShell;
    private final String defaultCwd;
    private final long timeoutSec;
    private final long maxOutputBytes;

    public ConsoleService(String shell, String cwd, long timeoutSec, long maxOutputBytes) {
        this.defaultShell = shell;
        this.defaultCwd = cwd;
        this.timeoutSec = timeoutSec;
        this.maxOutputBytes = maxOutputBytes;
    }

    public ConsoleSession getOrCreate(String key) {
        return sessions.computeIfAbsent(key, ConsoleSession::new);
    }

    public ConsoleSession get(String key) {
        return sessions.get(key);
    }

    public void remove(String key) {
        ConsoleSession s = sessions.remove(key);
        if (s != null) s.close();
    }

    public void execute(String key, String command) {
        ConsoleSession s = getOrCreate(key);
        s.execute(command, defaultCwd, defaultShell, timeoutSec, maxOutputBytes);
    }
}