package ru.miacomsoft.server;

import org.json.JSONObject;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/**
 * Одна консольная сессия (на пользователя).
 *
 * Команды выполняются в отдельном потоке; вывод строк
 * построчно уходит подписанному SSE-соединению.
 */
public class ConsoleSession {

    public final String key;
    private SseConnection sse;
    private Process currentProcess;
    private volatile boolean closed = false;
    private final Object lock = new Object();

    public ConsoleSession(String key) {
        this.key = key;
    }

    public void attachSse(SseConnection conn) {
        synchronized (lock) { this.sse = conn; }
    }

    public void detachSse() {
        synchronized (lock) { this.sse = null; }
    }

    public boolean isClosed() { return closed; }

    public void close() {
        closed = true;
        Process p;
        synchronized (lock) { p = currentProcess; }
        if (p != null && p.isAlive()) p.destroyForcibly();
    }

    // ---------- Отправка в SSE ----------

    private void sendEvent(String event, String data) {
        SseConnection s;
        synchronized (lock) { s = sse; }
        if (s == null) return;
        try { s.send(event, data); }
        catch (IOException e) { /* соединение упало — ничего не делаем */ }
    }

    private void sendOutput(String stream, String text) {
        JSONObject o = new JSONObject();
        o.put("stream", stream);
        o.put("text", text);
        sendEvent("output", o.toString());
    }

    private void sendExit(int code) {
        JSONObject o = new JSONObject();
        o.put("code", code);
        sendEvent("exit", o.toString());
    }

    private void sendError(String msg) {
        JSONObject o = new JSONObject();
        o.put("error", msg);
        sendEvent("error", o.toString());
    }

    // ---------- Выполнение ----------

    public void execute(String command, String cwd, String shell, long timeoutSec, long maxBytes) {
        // Убиваем предыдущий процесс, если он ещё жив
        synchronized (lock) {
            if (currentProcess != null && currentProcess.isAlive()) {
                currentProcess.destroyForcibly();
            }
        }

        Thread t = new Thread(
                () -> runCommand(command, cwd, shell, timeoutSec, maxBytes),
                "ConsoleExec-" + key);
        t.setDaemon(true);
        t.start();
    }

    private void runCommand(String command, String cwd, String shell, long timeoutSec, long maxBytes) {

        // Отправляем эхо команды — с префиксом $
        sendOutput("system", "$ " + command + "\n");

        // Параметры запуска
        ProcessBuilder pb;
        String os = System.getProperty("os.name", "").toLowerCase();
        boolean isWindows = os.contains("win");

        String realShell = (shell == null || shell.isEmpty())
                ? (isWindows ? "cmd.exe" : "bash")
                : shell;

        if (isWindows && realShell.equalsIgnoreCase("cmd.exe")) {
            pb = new ProcessBuilder(realShell, "/c", command);
        } else {
            pb = new ProcessBuilder(realShell, "-c", command);
        }

        if (cwd != null && !cwd.isEmpty()) {
            File dir = new File(cwd);
            if (dir.isDirectory()) pb.directory(dir);
        }
        pb.redirectErrorStream(false);

        try {
            Process proc = pb.start();
            synchronized (lock) { currentProcess = proc; }

            Thread outT = streamReader(proc.getInputStream(), "stdout", maxBytes);
            Thread errT = streamReader(proc.getErrorStream(), "stderr", maxBytes);
            outT.setDaemon(true);
            errT.setDaemon(true);
            outT.start();
            errT.start();

            boolean finished = proc.waitFor(timeoutSec, TimeUnit.SECONDS);
            if (!finished) {
                proc.destroyForcibly();
                sendError("Превышен таймаут (" + timeoutSec + " сек)");
            }

            try { outT.join(2000); } catch (InterruptedException ignored) {}
            try { errT.join(2000); } catch (InterruptedException ignored) {}

            int code = finished ? proc.exitValue() : -1;
            sendExit(code);

            synchronized (lock) { currentProcess = null; }

        } catch (Exception e) {
            sendError("Ошибка запуска: " + e.getMessage());
            sendExit(-1);
        }
    }

    private Thread streamReader(InputStream is, String streamName, long maxBytes) {
        return new Thread(() -> {
            long total = 0;
            try (BufferedReader br = new BufferedReader(
                    new InputStreamReader(is, StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) {
                    sendOutput(streamName, line + "\n");
                    total += line.length() + 1;
                    if (total > maxBytes) {
                        sendError("Превышен лимит вывода (" + maxBytes + " байт)");
                        break;
                    }
                }
            } catch (IOException ignored) {}
        });
    }
}