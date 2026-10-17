package ru.miacomsoft.server;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

public class ConsoleService {

    private final Map<String, ConsoleSession> sessions = new ConcurrentHashMap<>();

    private final String defaultShell;
    private final String defaultCwd;

    public ConsoleService(String shell, String cwd, long timeoutSec, long maxOutputBytes) {
        this.defaultShell = shell;
        this.defaultCwd = cwd;
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

    public void startShell(String key) {
        ConsoleSession s = getOrCreate(key);
        s.startShell(defaultCwd, defaultShell);
    }

    public void writeInput(String key, String data) {
        ConsoleSession s = get(key);
        if (s != null) s.writeInput(data);
    }

    public void resize(String key, int cols, int rows) {
        ConsoleSession s = get(key);
        if (s != null) s.resize(cols, rows);
    }
}