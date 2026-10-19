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

public class ConsoleSession {
    private Process process;
    private OutputStream stdin;
    private InputStream stdout;
    private boolean useNativePty = false;
    private boolean closed = false;

    // Путь к файлу, в котором утилита script сохранит имя псевдотерминала
    private String ttyFilePath = null;

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
            // 1. Пытаемся запустить через нативный PTY (Linux Mint, Windows)
            PtyProcessBuilder ptyBuilder = new PtyProcessBuilder(new String[]{shell})
                    .setEnvironment(env)
                    .setDirectory(cwd);
            process = ptyBuilder.start();
            useNativePty = true;
            System.out.println("[Console] Используется нативный PTY.");
        } catch (Throwable t) {
            // 2. Фолбэк для Termux / Android с использованием встроенной утилиты script
            System.err.println("[Console] Нативный PTY не поддерживается. Используем встроенную утилиту 'script'.");

            try {
                String tempDir = System.getProperty("java.io.tmpdir");
                ttyFilePath = tempDir + "/far_tty_" + System.nanoTime() + ".txt";

                // Команда: script создает TTY, записывает его имя в файл и запускает bash
                String cmd = "tty > " + ttyFilePath + "; exec " + shell + " -i";

                ProcessBuilder pb = new ProcessBuilder("script", "-q", "-c", cmd, "/dev/null");
                pb.directory(new File(cwd));
                pb.environment().putAll(env);
                pb.redirectErrorStream(true);
                process = pb.start();
                useNativePty = false;
            } catch (Exception e) {
                // Если утилита script недоступна, запускаем просто без TTY (mc не будет масштабироваться)
                System.err.println("[Console] Утилита 'script' не найдена. Запуск без TTY.");
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
        // Если размер нулевой (окно свернули) - игнорируем
        if (cols <= 0 || rows <= 0) return;

        if (useNativePty && process instanceof PtyProcess) {
            // Для Windows и Linux Mint
            try {
                ((PtyProcess) process).setWinSize(new WinSize(cols, rows));
            } catch (Throwable t) {}
        } else if (ttyFilePath != null) {
            // Для Termux / Android: читаем имя терминала и меняем его размер через stty
            try {
                Path p = Paths.get(ttyFilePath);
                if (Files.exists(p)) {
                    String tty = new String(Files.readAllBytes(p), StandardCharsets.UTF_8).trim();
                    if (!tty.isEmpty() && tty.startsWith("/dev/")) {
                        // Встроенная команда stty меняет размер PTY.
                        // Android ядро само пошлет SIGWINCH программе (mc/vim).
                        new ProcessBuilder("stty", "-F", tty, "rows", String.valueOf(rows), "cols", String.valueOf(cols)).start();
                    }
                }
            } catch (Exception e) {
                // Игнорируем ошибки изменения размера
            }
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
        if (ttyFilePath != null) {
            try { Files.deleteIfExists(Paths.get(ttyFilePath)); } catch (Exception e) {}
        }
    }
}