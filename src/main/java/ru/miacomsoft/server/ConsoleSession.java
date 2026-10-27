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
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicLong;

public class ConsoleSession {

    private Process process;
    private OutputStream stdin;
    private InputStream stdout;
    private boolean useNativePty = false;
    private volatile boolean closed = false;

    private String ttyFilePath = null;

    private final List<SseConnection> sseList = new CopyOnWriteArrayList<>();
    private final AtomicLong lastActivity = new AtomicLong(System.currentTimeMillis());

    /**
     * Буфер для polling-клиентов. Может быть null (тогда только SSE).
     * Устанавливается из ConsoleHandler при первом SSE или poll-запросе.
     */
    private volatile ConsoleEventBuffer eventBuffer = null;

    public ConsoleSession() {
    }

    public ConsoleSession(String shell) {
    }

    /** Позволяет ConsoleHandler-у привязать буфер для polling. */
    public void setEventBuffer(ConsoleEventBuffer buf) {
        this.eventBuffer = buf;
    }

    public void startShell(String shell, String cwd) throws IOException {
        Map<String, String> env = new HashMap<>(System.getenv());
        env.put("TERM", "xterm-256color");
        env.put("LANG", "C.UTF-8");

        try {
            PtyProcessBuilder ptyBuilder = new PtyProcessBuilder(new String[]{shell})
                    .setEnvironment(env)
                    .setDirectory(cwd);
            process = ptyBuilder.start();
            useNativePty = true;
            System.out.println("[Console] Используется нативный PTY.");
        } catch (Throwable t) {
            System.err.println("[Console] Нативный PTY не поддерживается: " + t.getMessage());
            System.err.println("[Console] Используем встроенную утилиту 'script'.");

            try {
                String tempDir = System.getProperty("java.io.tmpdir");
                ttyFilePath = tempDir + "/far_tty_" + System.nanoTime() + ".txt";

                String cmd = "tty > " + ttyFilePath + "; exec " + shell + " -i";
                ProcessBuilder pb = new ProcessBuilder("script", "-q", "-c", cmd, "/dev/null");
                pb.directory(new File(cwd));
                pb.environment().putAll(env);
                pb.redirectErrorStream(true);
                process = pb.start();
                useNativePty = false;
            } catch (Exception e) {
                System.err.println("[Console] Утилита 'script' не найдена. Запуск без TTY: " + e.getMessage());
                ProcessBuilder pb = new ProcessBuilder(shell);
                pb.directory(new File(cwd));
                pb.environment().putAll(env);
                pb.redirectErrorStream(true);
                process = pb.start();
                useNativePty = false;
                ttyFilePath = null;
            }
        }

        stdin = process.getOutputStream();
        stdout = process.getInputStream();

        startReaderThread();
    }

    /**
     * Отправляет набор команд в shell как начальный ввод.
     * Используется профилями (например, Hermes Agent).
     *
     * Работает в отдельном daemon-потоке, не блокирует вызывающего.
     */
    public void sendInitialCommands(final List<String> commands,
                                    final long startupDelayMs,
                                    final long commandDelayMs) {
        if (commands == null || commands.isEmpty()) return;
        final List<String> copy = List.copyOf(commands);

        Thread t = new Thread(() -> {
            try {
                if (startupDelayMs > 0) Thread.sleep(startupDelayMs);

                for (String cmd : copy) {
                    if (closed) return;
                    OutputStream out = stdin;
                    if (out == null) return;

                    out.write((cmd + "\n").getBytes(StandardCharsets.UTF_8));
                    out.flush();
                    lastActivity.set(System.currentTimeMillis());

                    if (commandDelayMs > 0) Thread.sleep(commandDelayMs);
                }
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
            } catch (IOException e) {
                System.err.println("[ConsoleSession] sendInitialCommands: " + e.getMessage());
            }
        }, "InitialCommands-" + System.identityHashCode(this));
        t.setDaemon(true);
        t.start();
    }

    private void startReaderThread() {
        Thread t = new Thread(() -> {
            byte[] buffer = new byte[8192];
            int read;
            try {
                while (!closed && (read = stdout.read(buffer)) != -1) {
                    String text = new String(buffer, 0, read, StandardCharsets.UTF_8);

                    // 1. Пишем всем SSE-клиентам
                    String eventData = "{\"text\":" + JSONObject.quote(text) + "}";
                    for (SseConnection sse : sseList) {
                        try {
                            sse.send("output", eventData);
                        } catch (Exception e) {
                            System.err.println("[Console] SSE send error: " + e.getMessage());
                        }
                    }

                    // 2. Дублируем в polling-буфер
                    ConsoleEventBuffer buf = eventBuffer;
                    if (buf != null) {
                        buf.add("output", text);
                    }
                }
            } catch (IOException e) {
                System.err.println("[Console] Reader thread: " + e.getMessage());
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
        if (cols <= 0 || rows <= 0) return;

        if (useNativePty && process instanceof PtyProcess) {
            try {
                ((PtyProcess) process).setWinSize(new WinSize(cols, rows));
            } catch (Throwable t) {}
        } else if (ttyFilePath != null) {
            try {
                Path p = Paths.get(ttyFilePath);
                if (Files.exists(p)) {
                    String tty = new String(Files.readAllBytes(p), StandardCharsets.UTF_8).trim();
                    if (!tty.isEmpty() && tty.startsWith("/dev/")) {
                        new ProcessBuilder("stty", "-F", tty,
                                "rows", String.valueOf(rows),
                                "cols", String.valueOf(cols)).start();
                    }
                }
            } catch (Exception e) {
                // Игнорируем ошибки изменения размера
            }
        }
    }

    public void writeInput(String data) throws IOException {
        if (stdin != null) {
            lastActivity.set(System.currentTimeMillis());
            stdin.write(data.getBytes(StandardCharsets.UTF_8));
            stdin.flush();
        }
    }

    public void attachSse(SseConnection sse) {
        sseList.add(sse);
        lastActivity.set(System.currentTimeMillis());
    }

    public void detachSse(SseConnection sse) {
        sseList.remove(sse);
        lastActivity.set(System.currentTimeMillis());
    }

    public int getSseCount() {
        return sseList.size();
    }

    public long getLastActivity() {
        return lastActivity.get();
    }

    public boolean isClosed() {
        return closed || process == null || !process.isAlive();
    }

    public void close() {
        closed = true;
        if (process != null) {
            process.destroy();
            try {
                Thread.sleep(100);
            } catch (InterruptedException ignored) {}
            if (process.isAlive()) {
                process.destroyForcibly();
            }
        }
        sseList.clear();
        if (ttyFilePath != null) {
            try { Files.deleteIfExists(Paths.get(ttyFilePath)); } catch (Exception e) {}
        }
    }
}