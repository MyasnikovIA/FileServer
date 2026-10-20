package ru.miacomsoft.server;

import org.json.JSONObject;

import javax.net.ssl.SSLContext;
import java.io.*;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public class VideoChatServer {

    private final int port;
    private final String wsGuid;
    private final SSLContext sslContext; // Может быть null
    private ServerSocket server;
    private volatile boolean running = false;

    private final ConcurrentHashMap<String, Room> ROOMS = new ConcurrentHashMap<>();
    private static final int MAX_FRAME = 16 * 1024 * 1024;

    public VideoChatServer(int port, String wsGuid, SSLContext sslContext) {
        this.port = port;
        this.wsGuid = wsGuid;
        this.sslContext = sslContext;
    }

    public void start() throws Exception {
        // Если передан SSLContext, используем защищенный сокет
        if (sslContext != null) {
            server = sslContext.getServerSocketFactory().createServerSocket(port);
            System.out.println("[VideoChat] WSS mode enabled on port " + port);
        } else {
            server = new ServerSocket(port);
            System.out.println("[VideoChat] WS (plain) mode enabled on port " + port);
        }

        running = true;

        Thread t = new Thread(() -> {
            while (running) {
                try {
                    Socket socket = server.accept();
                    Thread.ofVirtual()
                            .name("vc-" + socket.getPort())
                            .start(() -> handleConnection(socket));
                } catch (Exception e) {
                    if (running) {
                        System.err.println("[VideoChat] Accept error: " + e.getMessage());
                    }
                }
            }
        }, "VideoChat-Acceptor");

        t.setDaemon(true);
        t.start();
    }

    public void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (Exception ignored) {}
    }

    private void handleConnection(Socket socket) {
        try (socket) {
            BufferedInputStream in  = new BufferedInputStream(socket.getInputStream());
            OutputStream        out = socket.getOutputStream();

            String requestLine = readHttpLine(in);
            if (requestLine == null || requestLine.isBlank()) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 3) return;

            Map<String, String> headers = new HashMap<>();
            String hline;
            while ((hline = readHttpLine(in)) != null && !hline.isEmpty()) {
                int idx = hline.indexOf(':');
                if (idx > 0) {
                    headers.put(hline.substring(0, idx).trim().toLowerCase(),
                            hline.substring(idx + 1).trim());
                }
            }

            String target = parts[1];
            String path  = target;
            String query = "";
            int q = target.indexOf('?');
            if (q >= 0) {
                path  = target.substring(0, q);
                query = target.substring(q + 1);
            }

            String upgrade = headers.getOrDefault("upgrade", "");
            if ("websocket".equalsIgnoreCase(upgrade) && path.startsWith("/ws/")) {
                handleWebSocket(socket, in, out, path, query, headers);
            } else {
                writeSimpleResponse(out, 404, "Not Found");
            }
        } catch (Exception ignored) {
        }
    }

    private void writeSimpleResponse(OutputStream out, int code, String msg) throws IOException {
        String resp = "HTTP/1.1 " + code + " " + msg + "\r\nConnection: close\r\n\r\n";
        out.write(resp.getBytes(StandardCharsets.US_ASCII));
        out.flush();
    }

    private String readHttpLine(InputStream in) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        int b;
        boolean any = false;
        while ((b = in.read()) != -1) {
            any = true;
            if (b == '\n') {
                byte[] arr = baos.toByteArray();
                int len = arr.length;
                if (len > 0 && arr[len - 1] == '\r') len--;
                return new String(arr, 0, len, StandardCharsets.ISO_8859_1);
            }
            baos.write(b);
        }
        return any ? baos.toString(StandardCharsets.ISO_8859_1) : null;
    }

    private void handleWebSocket(Socket socket, BufferedInputStream in, OutputStream out,
                                 String path, String query, Map<String, String> headers)
            throws Exception {
        String key = headers.get("sec-websocket-key");
        if (key == null) return;

        String accept = base64Sha1(key + wsGuid);
        String resp = "HTTP/1.1 101 Switching Protocols\r\n" +
                "Upgrade: websocket\r\n" +
                "Connection: Upgrade\r\n" +
                "Sec-WebSocket-Accept: " + accept + "\r\n\r\n";
        out.write(resp.getBytes(StandardCharsets.ISO_8859_1));
        out.flush();

        Map<String, String> params = parseQuery(query);
        String roomId = params.getOrDefault("room", "main");

        WsConnection ws = new WsConnection(socket, in, out);

        switch (path) {
            case "/ws/publish"   -> handlePublisher(ws, roomId);
            case "/ws/subscribe" -> handleSubscriber(ws, roomId);
            default              -> ws.close(1008, "unknown endpoint");
        }
    }

    private void handlePublisher(WsConnection ws, String roomId) {
        Room room = ROOMS.computeIfAbsent(roomId, Room::new);

        synchronized (room) {
            if (room.publisherWs != null) {
                room.publisherWs.close(1000, "replaced");
            }
            room.publisherWs = ws;
            for (WsConnection v : room.viewers.values()) {
                v.close(1000, "publisher restarted");
            }
            room.viewers.clear();
        }
        System.out.println("[publish] +room=" + roomId + " " + ws.remote());

        try {
            while (!ws.isClosed()) {
                WsFrame frame = ws.readFrame();
                if (frame == null) break;

                switch (frame.opcode) {
                    case 0x8 -> { ws.close(1000, "bye"); return; }
                    case 0x9 -> ws.sendPong(frame.payload);
                    case 0x1 -> {
                        String text = new String(frame.payload, StandardCharsets.UTF_8);
                        try {
                            JSONObject msg = new JSONObject(text);
                            String target = msg.optString("target");
                            synchronized (room) {
                                WsConnection v = room.viewers.get(target);
                                if (v != null) v.sendText(text);
                            }
                        } catch (Exception e) {}
                    }
                }
            }
        } catch (IOException ignored) {
        } finally {
            synchronized (room) {
                if (room.publisherWs == ws) room.publisherWs = null;
            }
            ws.close(1000, "bye");
            System.out.println("[publish] -room=" + roomId);
        }
    }

    private void handleSubscriber(WsConnection ws, String roomId) {
        Room room = ROOMS.computeIfAbsent(roomId, Room::new);
        String viewerId = UUID.randomUUID().toString();

        try {
            synchronized (room) {
                room.viewers.put(viewerId, ws);
                ws.sendText(new JSONObject().put("viewerId", viewerId).toString());

                if (room.publisherWs != null) {
                    room.publisherWs.sendText(new JSONObject().put("viewerJoined", viewerId).toString());
                }
            }
            System.out.println("[subscribe] +room=" + roomId + " viewer=" + viewerId);

            while (!ws.isClosed()) {
                WsFrame frame = ws.readFrame();
                if (frame == null) break;

                switch (frame.opcode) {
                    case 0x8 -> { ws.close(1000, "bye"); return; }
                    case 0x9 -> ws.sendPong(frame.payload);
                    case 0x1 -> {
                        String text = new String(frame.payload, StandardCharsets.UTF_8);
                        try {
                            JSONObject msg = new JSONObject(text);
                            if ("publisher".equals(msg.optString("target"))) {
                                msg.put("viewerId", viewerId);
                                synchronized (room) {
                                    if (room.publisherWs != null) {
                                        room.publisherWs.sendText(msg.toString());
                                    }
                                }
                            }
                        } catch (Exception e) {}
                    }
                }
            }
        } catch (IOException ignored) {
        } finally {
            synchronized (room) {
                room.viewers.remove(viewerId);
                if (room.publisherWs != null) {
                    try { room.publisherWs.sendText(new JSONObject().put("viewerLeft", viewerId).toString()); } catch(Exception e){}
                }
            }
            ws.close(1000, "bye");
            System.out.println("[subscribe] -room=" + roomId + " viewer=" + viewerId);
        }
    }

    private String base64Sha1(String s) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-1");
        return Base64.getEncoder().encodeToString(
                md.digest(s.getBytes(StandardCharsets.ISO_8859_1)));
    }

    private Map<String, String> parseQuery(String query) {
        Map<String, String> map = new HashMap<>();
        if (query == null || query.isEmpty()) return map;
        for (String pair : query.split("&")) {
            int idx = pair.indexOf('=');
            if (idx >= 0) {
                map.put(urlDecode(pair.substring(0, idx)),
                        urlDecode(pair.substring(idx + 1)));
            } else {
                map.put(urlDecode(pair), "");
            }
        }
        return map;
    }

    private String urlDecode(String s) {
        try { return URLDecoder.decode(s, StandardCharsets.UTF_8); }
        catch (Exception e) { return s; }
    }

    private static class Room {
        final String id;
        volatile WsConnection publisherWs;
        final Map<String, WsConnection> viewers = new ConcurrentHashMap<>();
        Room(String id) { this.id = id; }
    }

    private static class WsFrame {
        int opcode;
        byte[] payload;
    }

    private static class RawFrame {
        boolean fin;
        int opcode;
        boolean masked;
        byte[] payload;
    }

    private static class WsConnection {
        final Socket socket;
        final BufferedInputStream in;
        final OutputStream out;
        final Object writeLock = new Object();
        volatile boolean closed = false;

        WsConnection(Socket socket, BufferedInputStream in, OutputStream out) {
            this.socket = socket;
            this.in = in;
            this.out = out;
        }

        String remote() { return socket.getRemoteSocketAddress().toString(); }
        boolean isClosed() { return closed || socket.isClosed(); }

        int readByte() throws IOException {
            int b = in.read();
            if (b == -1) throw new EOFException();
            return b;
        }

        void readFully(byte[] buf, int off, int len) throws IOException {
            int got = 0;
            while (got < len) {
                int r = in.read(buf, off + got, len - got);
                if (r == -1) throw new EOFException();
                got += r;
            }
        }

        RawFrame readRawFrame() throws IOException {
            int b0 = in.read();
            if (b0 == -1) return null;
            int b1 = in.read();
            if (b1 == -1) return null;

            RawFrame f = new RawFrame();
            f.fin    = (b0 & 0x80) != 0;
            f.opcode = b0 & 0x0F;
            f.masked = (b1 & 0x80) != 0;

            long len = b1 & 0x7F;
            if (len == 126)      len = ((long) readByte() << 8) | readByte();
            else if (len == 127) { len = 0; for (int i = 0; i < 8; i++) len = (len << 8) | readByte(); }

            if (len < 0 || len > MAX_FRAME) throw new IOException("frame too big: " + len);

            byte[] mask = null;
            if (f.masked) { mask = new byte[4]; readFully(mask, 0, 4); }

            byte[] payload = new byte[(int) len];
            if (payload.length > 0) readFully(payload, 0, payload.length);
            if (mask != null) {
                for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
            }
            f.payload = payload;
            return f;
        }

        WsFrame readFrame() throws IOException {
            RawFrame first = readRawFrame();
            if (first == null) return null;

            if (first.opcode >= 0x8) {
                WsFrame f = new WsFrame();
                f.opcode = first.opcode;
                f.payload = first.payload;
                return f;
            }

            if (first.fin) {
                WsFrame f = new WsFrame();
                f.opcode = first.opcode;
                f.payload = first.payload;
                return f;
            }

            ByteArrayOutputStream acc = new ByteArrayOutputStream();
            acc.write(first.payload);
            while (true) {
                RawFrame nxt = readRawFrame();
                if (nxt == null) return null;
                if ((long) acc.size() + nxt.payload.length > MAX_FRAME) {
                    throw new IOException("message too big");
                }
                acc.write(nxt.payload);
                if (nxt.fin) break;
            }
            WsFrame f = new WsFrame();
            f.opcode = first.opcode;
            f.payload = acc.toByteArray();
            return f;
        }

        void sendText(String text) throws IOException {
            sendFrame(0x1, text.getBytes(StandardCharsets.UTF_8));
        }

        void sendPong(byte[] payload) throws IOException {
            sendFrame(0xA, payload);
        }

        void sendFrame(int opcode, byte[] payload) throws IOException {
            synchronized (writeLock) {
                if (closed) return;
                try {
                    ByteArrayOutputStream frame = new ByteArrayOutputStream(payload.length + 14);
                    frame.write(0x80 | opcode);
                    int len = payload.length;
                    if (len < 126) {
                        frame.write(len);
                    } else if (len < 65536) {
                        frame.write(126);
                        frame.write((len >>> 8) & 0xFF);
                        frame.write(len & 0xFF);
                    } else {
                        frame.write(127);
                        for (int i = 7; i >= 0; i--) {
                            frame.write((int) (((long) len >>> (8 * i)) & 0xFF));
                        }
                    }
                    frame.write(payload);
                    out.write(frame.toByteArray());
                    out.flush();
                } catch (IOException e) {
                    closed = true;
                    throw e;
                }
            }
        }

        void close(int code, String reason) {
            if (closed) return;
            synchronized (writeLock) {
                if (!closed) {
                    try {
                        ByteArrayOutputStream payload = new ByteArrayOutputStream();
                        payload.write((code >>> 8) & 0xFF);
                        payload.write(code & 0xFF);
                        if (reason != null) {
                            payload.write(reason.getBytes(StandardCharsets.UTF_8));
                        }
                        sendFrame(0x8, payload.toByteArray());
                    } catch (IOException ignored) { }
                }
                closed = true;
                try { socket.close(); } catch (IOException ignored) { }
            }
        }
    }
}