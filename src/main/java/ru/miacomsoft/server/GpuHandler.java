package ru.miacomsoft.server;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpHandler;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * GpuHandler — серверный endpoint /api/gpu.
 *
 * Запускает на сервере `nvidia-smi`, парсит результат и отдаёт JSON:
 *
 *   {
 *     "timestamp": 1234567890,
 *     "available": true,
 *     "gpus": [
 *       { "index":0, "uuid":"...", "name":"NVIDIA P106-100",
 *         "fanSpeed":0, "temperature":32, "pstate":"P8",
 *         "powerDraw":5, "powerLimit":120, "powerPercent":4,
 *         "memoryUsed":5, "memoryTotal":6144, "memoryPercent":0,
 *         "utilizationGpu":0, "utilizationMemory":0,
 *         "persistenceMode":"Off", "displayActive":"Off" }
 *     ],
 *     "processes": [
 *       { "gpuIndex":0, "pid":1791, "type":"G",
 *         "name":"/usr/lib/xorg/Xorg", "usedMemory":4 }
 *     ]
 *   }
 *
 * Данные процессов (в т.ч. графических, не только compute) берутся
 * из полного `nvidia-smi` — так же, как в примере пользователя.
 */
public class GpuHandler implements HttpHandler {

    private static final int TIMEOUT_SEC = 5;

    private static final Pattern PROC_ROW = Pattern.compile(
            "^\\s*\\|\\s*(\\d+)\\s+(\\S+)\\s+(\\S+)\\s+(\\d+)\\s+([A-Z+]+)\\s+(.+?)\\s+([\\d.]+)\\s*([KMGT]?iB)\\s*\\|\\s*$"
    );

    @Override
    public void handle(HttpExchange ex) throws IOException {
        if (FileServer.handleOptions(ex)) return;

        String path = ex.getRequestURI().getPath();
        String method = ex.getRequestMethod().toUpperCase();

        if (!"/api/gpu".equals(path)) {
            FileServer.sendError(ex, 404, "Unknown endpoint: " + path);
            return;
        }
        if (!"GET".equals(method)) {
            FileServer.sendError(ex, 405, "Method not allowed");
            return;
        }

        AuthService.Session session = FileServer.auth().authenticate(ex);
        if (session == null) {
            ex.getResponseHeaders().set("WWW-Authenticate", "Basic realm=\"FileServer\"");
            FileServer.sendError(ex, 401, "Unauthorized");
            return;
        }

        try {
            JSONObject result = queryGpuInfo();
            FileServer.sendJson(ex, 200, result.toString());
        } catch (Exception e) {
            e.printStackTrace();
            JSONObject err = new JSONObject();
            err.put("available", false);
            err.put("error", "Server error: " + e.getMessage());
            err.put("timestamp", System.currentTimeMillis());
            err.put("gpus", new JSONArray());
            err.put("processes", new JSONArray());
            FileServer.sendJson(ex, 200, err.toString());
        }
    }

    // ============================================================
    // Основная логика
    // ============================================================

    private JSONObject queryGpuInfo() throws Exception {
        JSONObject out = new JSONObject();
        out.put("timestamp", System.currentTimeMillis());

        String gpuCsv = runNvidiaSmi(new String[]{
                "nvidia-smi",
                "--query-gpu=index,uuid,name,fan.speed,temperature.gpu,pstate," +
                        "power.draw,power.limit,memory.used,memory.total," +
                        "utilization.gpu,utilization.memory," +
                        "persistence_mode,display_active",
                "--format=csv,noheader,nounits"
        });

        if (gpuCsv == null || gpuCsv.trim().isEmpty()) {
            out.put("available", false);
            out.put("error", "nvidia-smi не найден или не вернул данных");
            out.put("gpus", new JSONArray());
            out.put("processes", new JSONArray());
            return out;
        }

        JSONArray gpus = new JSONArray();

        for (String line : gpuCsv.split("\\r?\\n")) {
            String trimmed = line.trim();
            if (trimmed.isEmpty()) continue;

            String[] parts = splitCsv(trimmed);
            if (parts.length < 3) continue;

            JSONObject gpu = new JSONObject();
            gpu.put("index", parseIntSafe(getAt(parts, 0)));
            gpu.put("uuid", safeStr(getAt(parts, 1)));
            gpu.put("name", safeStr(getAt(parts, 2)));
            gpu.put("fanSpeed", parseNullableNumber(getAt(parts, 3)));
            gpu.put("temperature", parseNullableNumber(getAt(parts, 4)));
            gpu.put("pstate", safeStr(getAt(parts, 5)));
            gpu.put("powerDraw", parseNullableNumber(getAt(parts, 6)));
            gpu.put("powerLimit", parseNullableNumber(getAt(parts, 7)));
            gpu.put("memoryUsed", parseNullableNumber(getAt(parts, 8)));
            gpu.put("memoryTotal", parseNullableNumber(getAt(parts, 9)));
            gpu.put("utilizationGpu", parseNullableNumber(getAt(parts, 10)));
            gpu.put("utilizationMemory", parseNullableNumber(getAt(parts, 11)));
            gpu.put("persistenceMode", safeStr(getAt(parts, 12)));
            gpu.put("displayActive", safeStr(getAt(parts, 13)));

            double memUsed = parseNullableNumber(getAt(parts, 8));
            double memTotal = parseNullableNumber(getAt(parts, 9));
            gpu.put("memoryPercent", memTotal > 0
                    ? (int) Math.round(memUsed / memTotal * 100)
                    : 0);

            double powerDraw = parseNullableNumber(getAt(parts, 6));
            double powerLimit = parseNullableNumber(getAt(parts, 7));
            gpu.put("powerPercent", powerLimit > 0
                    ? (int) Math.round(powerDraw / powerLimit * 100)
                    : 0);

            gpus.put(gpu);
        }

        out.put("available", true);
        out.put("gpus", gpus);

        // Процессы — из полного nvidia-smi (включая графические,
        // как Xorg, а не только compute).
        JSONArray processes = new JSONArray();
        String plain = runNvidiaSmi(new String[]{"nvidia-smi"});
        if (plain != null) {
            JSONArray parsed = parseProcessesFromPlain(plain);
            for (int i = 0; i < parsed.length(); i++) {
                processes.put(parsed.getJSONObject(i));
            }
        }
        out.put("processes", processes);

        return out;
    }

    // ============================================================
    // Парсинг блока "Processes:" из полного вывода nvidia-smi
    // ============================================================

    private JSONArray parseProcessesFromPlain(String output) {
        JSONArray arr = new JSONArray();
        if (output == null) return arr;

        for (String line : output.split("\\r?\\n")) {
            Matcher m = PROC_ROW.matcher(line);
            if (!m.matches()) continue;

            try {
                JSONObject p = new JSONObject();
                p.put("gpuIndex", parseIntSafe(m.group(1)));
                p.put("pid", parseIntSafe(m.group(4)));
                p.put("type", m.group(5));
                p.put("name", m.group(6).trim());

                double memVal = Double.parseDouble(m.group(7));
                String memUnit = m.group(8);
                double memMib = memVal;
                if (memUnit.startsWith("KiB")) memMib = memVal / 1024.0;
                else if (memUnit.startsWith("GiB")) memMib = memVal * 1024.0;
                else if (memUnit.startsWith("TiB")) memMib = memVal * 1024.0 * 1024.0;

                p.put("usedMemory", Math.round(memMib));
                arr.put(p);
            } catch (Exception ignored) {
                // Пропускаем некорректные строки
            }
        }

        return arr;
    }

    // ============================================================
    // Запуск nvidia-smi
    // ============================================================

    private String runNvidiaSmi(String[] cmd) {
        Process proc;
        try {
            proc = new ProcessBuilder(cmd).start();
        } catch (IOException e) {
            return null;
        }

        final StringBuilder stdout = new StringBuilder();
        Thread reader = new Thread(() -> {
            try (BufferedReader br = new BufferedReader(
                    new InputStreamReader(proc.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) {
                    stdout.append(line).append('\n');
                }
            } catch (IOException ignored) { /* ignore */ }
        });
        reader.setDaemon(true);
        reader.start();

        try {
            boolean finished = proc.waitFor(TIMEOUT_SEC, TimeUnit.SECONDS);
            if (!finished) {
                proc.destroyForcibly();
                return null;
            }
            reader.join(1000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            proc.destroyForcibly();
            return null;
        }

        if (proc.exitValue() != 0) return null;
        return stdout.toString();
    }

    // ============================================================
    // Вспомогательные
    // ============================================================

    private String[] splitCsv(String line) {
        String[] raw = line.split(",");
        String[] out = new String[raw.length];
        for (int i = 0; i < raw.length; i++) {
            out[i] = raw[i].trim();
        }
        return out;
    }

    private String getAt(String[] arr, int idx) {
        return (idx < arr.length) ? arr[idx] : "";
    }

    private int parseIntSafe(String s) {
        try { return Integer.parseInt(s.trim()); }
        catch (Exception e) { return 0; }
    }

    private double parseNullableNumber(String s) {
        if (s == null) return 0;
        String t = s.trim();
        if (t.isEmpty()
                || t.equalsIgnoreCase("[N/A]") || t.equalsIgnoreCase("N/A")
                || t.equalsIgnoreCase("[Not Supported]") || t.equalsIgnoreCase("Not Supported")) {
            return 0;
        }
        try { return Double.parseDouble(t); }
        catch (Exception e) { return 0; }
    }

    private String safeStr(String s) {
        if (s == null) return "";
        String t = s.trim();
        if (t.equalsIgnoreCase("[N/A]") || t.equalsIgnoreCase("N/A")
                || t.equalsIgnoreCase("[Not Supported]") || t.equalsIgnoreCase("Not Supported")) {
            return "";
        }
        return t;
    }
}