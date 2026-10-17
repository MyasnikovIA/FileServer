package ru.miacomsoft.server;

import com.pty4j.PtyProcess;
import com.pty4j.PtyProcessBuilder;
import com.pty4j.WinSize;
import org.json.JSONObject;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

public class ConsoleSession {

    public final String key;
    private SseConnection sse;
    private PtyProcess process;
    private volatile boolean closed = false;
    private final Object lock = new Object();

    public ConsoleSession(String key) {
        this.key = key;
    }

    public void attachSse(SseConnection conn) {
        synchronized (lock) {
            // Если старое соединение зависло, закрываем его, чтобы не было утечек
            if (this.sse != null && this.sse != conn) {
                try { this.sse.close(); } catch (Exception e) {}
            }
            this.sse = conn;
        }
    }

    // Теперь detachSse принимает соединение, чтобы старое не сбрасывало новое
    public void detachSse(SseConnection conn) {
        synchronized (lock) {
            if (this.sse == conn) {
                this.sse = null;
            }
        }
    }

    public boolean isClosed() { return closed; }

    public void close() {
        closed = true;
        synchronized (lock) {
            if (process != null && process.isAlive()) {
                process.destroyForcibly();
            }
        }
    }

    private void sendEvent(String event, String data) {
        SseConnection s;
        synchronized (lock) { s = sse; }
        if (s == null) return;
        try { s.send(event, data); }
        catch (IOException e) { /* соединение упало */ }
    }

    private void sendOutput(String text) {
        JSONObject o = new JSONObject();
        o.put("text", text);
        sendEvent("output", o.toString());
    }

    private void sendError(String msg) {
        JSONObject o = new JSONObject();
        o.put("error", msg);
        sendEvent("error", o.toString());
    }

    public void startShell(String cwd, String shell) {
        synchronized (lock) {
            if (process != null && process.isAlive()) return;

            String os = System.getProperty("os.name", "").toLowerCase();
            boolean isWindows = os.contains("win");

            String realShell = (shell == null || shell.isEmpty())
                    ? (isWindows ? "cmd.exe" : "bash")
                    : shell;

            String[] cmd = { realShell };

            try {
                Map<String, String> env = new HashMap<>(System.getenv());

                if (!isWindows) {
                    env.put("TERM", "xterm-256color");
                    env.put("LANG", "C.UTF-8");
                    env.put("LC_ALL", "C.UTF-8");
                }

                PtyProcessBuilder pb = new PtyProcessBuilder(cmd)
                        .setEnvironment(env)
                        .setInitialColumns(80)
                        .setInitialRows(24);

                if (cwd != null && !cwd.isEmpty()) {
                    File dir = new File(cwd);
                    if (dir.isDirectory()) pb.setDirectory(cwd);
                }

                process = pb.start();

                Thread readThread = new Thread(() -> {
                    // ИСПОЛЬЗУЕМ InputStreamReader - он не разрывает UTF-8 символы,
                    // а собирает их целиком, даже если они пришли разными кусками.
                    try (Reader reader = new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8)) {
                        char[] buf = new char[4096];
                        int n;
                        while ((n = reader.read(buf)) > 0) {
                            String text = new String(buf, 0, n);
                            sendOutput(text);
                        }
                    } catch (IOException e) {
                        // ignore
                    }
                });
                readThread.setDaemon(true);
                readThread.start();

            } catch (Throwable e) {
                sendError("Ошибка запуска оболочки: " + e.getMessage());
                e.printStackTrace();
            }
        }
    }

    public void writeInput(String data) {
        synchronized (lock) {
            if (process == null || !process.isAlive()) return;
            try {
                OutputStream os = process.getOutputStream();
                os.write(data.getBytes(StandardCharsets.UTF_8));
                os.flush();
            } catch (IOException e) {
                sendError("Ошибка записи: " + e.getMessage());
            }
        }
    }

    public void resize(int cols, int rows) {
        synchronized (lock) {
            if (process != null && process.isAlive()) {
                try {
                    process.setWinSize(new WinSize(cols, rows));
                } catch (Throwable ignored) {}
            }
        }
    }
}