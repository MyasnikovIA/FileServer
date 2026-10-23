package ru.miacomsoft.server;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.Deque;

/**
 * Буфер событий консоли для fallback-поллинга.
 *
 * Используется, когда браузер не может держать открытым SSE-поток:
 *   • HttpsServer в JDK буферизует мелкие записи — SSE «висит»;
 *   • mixed content (страница HTTPS, а baseUrl HTTP) — SSE молча
 *     блокируется.
 *
 * В этом случае клиент опрашивает /api/console/events?poll=1&since=N
 * и получает накопленные события из этого буфера.
 *
 * Буфер хранится в памяти процесса и ограничен MAX_BUFFER последними
 * записями (старые вытесняются). Это защищает от роста памяти при
 * долгой работе консоли.
 *
 * Потокобезопасен: все публичные методы synchronized.
 */
public class ConsoleEventBuffer {

    /** Максимум событий в буфере. */
    private static final int MAX_BUFFER = 4096;

    /** Одно событие с монотонным номером. */
    public static class Event {
        public final long seq;
        public final String type;
        public final String text;

        public Event(long seq, String type, String text) {
            this.seq  = seq;
            this.type = type;
            this.text = text;
        }
    }

    private final Deque<Event> events = new ArrayDeque<>();
    private long nextSeq = 1;

    /** Добавить событие в буфер. */
    public synchronized void add(String type, String text) {
        events.addLast(new Event(nextSeq++, type, text));
        while (events.size() > MAX_BUFFER) {
            events.removeFirst();
        }
    }

    /** Вернуть все события, у которых seq > sinceSeq. */
    public synchronized JSONArray since(long sinceSeq) {
        JSONArray arr = new JSONArray();
        for (Event e : events) {
            if (e.seq <= sinceSeq) continue;
            JSONObject o = new JSONObject();
            o.put("seq",  e.seq);
            o.put("type", e.type);
            if (e.text != null) o.put("text", e.text);
            arr.put(o);
        }
        return arr;
    }

    /** Следующий порядковый номер (для клиента: «забирай с этого момента»). */
    public synchronized long nextSeq() {
        return nextSeq;
    }
}