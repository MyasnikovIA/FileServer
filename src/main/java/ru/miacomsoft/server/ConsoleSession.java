package ru.miacomsoft.server;

import com.pty4j.PtyProcess;
import com.pty4j.PtyProcessBuilder;
import com.pty4j.WinSize;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;

public class ConsoleSession {
    private Process process;
    private OutputStream stdin;
    private InputStream stdout;
    private boolean isPty = false;
    private boolean closed = false;

    private final List<SseConnection> sseList = new CopyOnWriteArrayList<>();

    public ConsoleSession() {
    }

    public ConsoleSession(String shell) {
    }

    public void startShell(String shell, String cwd) throws IOException {
        Map<String, String> env = new HashMap<>(System.getenv());
        env.put("TERM", "xterm-256color");
        env.put("LANG", "C.UTF-8");

        try {
            // 1. Пытаемся запустить через PTY (Linux Mint, Windows, macOS)
            PtyProcessBuilder ptyBuilder = new PtyProcessBuilder(new String[]{shell})
                    .setEnvironment(env)
                    .setDirectory(cwd);
            process = ptyBuilder.start();
            isPty = true;
            System.out.println("[Console] Используется PTY.");
        } catch (Throwable t) {
            // 2. Фолбэк для Termux / Android
            System.err.println("[Console] Внимание: PTY не поддерживается на этой ОС.");
            System.err.println("[Console] Переключение на ProcessBuilder (без TTY).");

            try {
                // Используем stdbuf, чтобы отключить буферизацию вывода (-i0 -o0 -e0)
                ProcessBuilder pb = new ProcessBuilder("stdbuf", "-i0", "-o0", "-e0", shell, "-i");
                pb.directory(new File(cwd));
                pb.environment().putAll(env);
                pb.redirectErrorStream(true);
                process = pb.start();
            } catch (Exception e) {
                System.err.println("[Console] stdbuf не найден, запуск без него. Вывод может быть с задержкой.");
                ProcessBuilder pb = new ProcessBuilder(shell);
                pb.directory(new File(cwd));
                pb.environment().putAll(env);
                pb.redirectErrorStream(true);
                process = pb.start();
            }
            isPty = false;
        }

        stdin = process.getOutputStream();
        stdout = process.getInputStream();

        startReaderThread();
    }

    private void startReaderThread() {
        Thread t = new Thread(() -> {
            byte[] buffer = new byte[8192];
            int read;
            try {
                while (!closed && (read = stdout.read(buffer)) != -1) {
                    String text = new String(buffer, 0, read, StandardCharsets.UTF_8);
                    String eventData = "{\"text\":" + JSONObject.quote(text) + "}";

                    for (SseConnection sse : sseList) {
                        try {
                            sse.send("output", eventData);
                        } catch (Exception e) {}
                    }
                }
            } catch (IOException e) {
                // Поток закрыт
            } finally {
                closed = true;
                if (process != null) process.destroy();
                sseList.clear();
            }
        });
        t.setDaemon(true);
        t.start();
    }

    public void resize(int cols, int rows) {
        if (isPty && process instanceof PtyProcess) {
            try {
                ((PtyProcess) process).setWinSize(new WinSize(cols, rows));
            } catch (Throwable t) {}
        }
    }

    public void writeInput(String data) throws IOException {
        if (stdin != null) {
            stdin.write(data.getBytes(StandardCharsets.UTF_8));
            stdin.flush();
        }
    }

    public void attachSse(SseConnection sse) {
        sseList.add(sse);
    }

    public void detachSse(SseConnection sse) {
        sseList.remove(sse);
    }

    public boolean isClosed() {
        return closed || process == null || !process.isAlive();
    }

    public void close() {
        closed = true;
        if (process != null) process.destroy();
        sseList.clear();
    }
}