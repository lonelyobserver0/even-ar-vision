package com.even.arvision;

import fi.iki.elonen.NanoHTTPD;

import java.io.PipedInputStream;
import java.io.PipedOutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * In-app topic pub/sub relay (HTTP + Server-Sent Events), the native port of
 * relay/server.mjs. Running it inside the phone app lets the glasses terminal
 * connect straight to the device (localhost) — no separate relay machine.
 *
 *   POST /pub/:topic[?retain=1]   publish JSON
 *   GET  /sub/:topic              subscribe (SSE, auto-reconnecting client side)
 *   GET  /                        health
 */
public class RelayHttpd extends NanoHTTPD {
    private final Map<String, CopyOnWriteArraySet<PipedOutputStream>> subscribers = new ConcurrentHashMap<>();
    private final Map<String, String> retained = new ConcurrentHashMap<>();
    private final ScheduledExecutorService pinger = Executors.newSingleThreadScheduledExecutor();

    public RelayHttpd(int port) {
        super(port); // binds to all interfaces: reachable via 127.0.0.1 and the LAN IP
        pinger.scheduleAtFixedRate(this::pingAll, 25, 25, TimeUnit.SECONDS);
    }

    /**
     * Never gzip. NanoHTTPD compresses responses whose mime-type contains "text/", and
     * "text/event-stream" matches — but GZIPOutputStream buffers our small SSE frames and
     * never flushes them to the socket, so subscribers connect (headers arrive) yet receive
     * no `data:` frames. Disabling gzip lets each chunk reach the client immediately.
     */
    @Override
    protected boolean useGzipWhenAccepted(Response r) {
        return false;
    }

    private CopyOnWriteArraySet<PipedOutputStream> subs(String topic) {
        return subscribers.computeIfAbsent(topic, k -> new CopyOnWriteArraySet<>());
    }

    @Override
    public Response serve(IHTTPSession session) {
        List<String> parts = new ArrayList<>();
        for (String p : session.getUri().split("/")) {
            if (!p.isEmpty()) parts.add(p);
        }

        if (session.getMethod() == Method.OPTIONS) {
            return cors(newFixedLengthResponse(Response.Status.NO_CONTENT, "text/plain", ""));
        }

        // Subscribe: GET /sub/:topic  (Server-Sent Events)
        if (session.getMethod() == Method.GET && parts.size() == 2 && parts.get(0).equals("sub")) {
            String topic = parts.get(1);
            try {
                PipedOutputStream sink = new PipedOutputStream();
                PipedInputStream source = new PipedInputStream(sink, 64 * 1024);
                subs(topic).add(sink);
                sink.write("retry: 2000\n\n".getBytes());
                String last = retained.get(topic);
                if (last != null) sink.write(("data: " + last + "\n\n").getBytes());
                sink.flush();
                Response res = newChunkedResponse(Response.Status.OK, "text/event-stream", source);
                res.addHeader("Cache-Control", "no-cache");
                res.addHeader("Connection", "keep-alive");
                return cors(res);
            } catch (Exception e) {
                return cors(newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain", "sse error"));
            }
        }

        // Publish: POST /pub/:topic[?retain=1]
        if (session.getMethod() == Method.POST && parts.size() == 2 && parts.get(0).equals("pub")) {
            String topic = parts.get(1);
            List<String> retainParam = session.getParameters().get("retain");
            boolean retain = retainParam != null && retainParam.contains("1");
            String body = readBody(session);
            if (retain) retained.put(topic, body);
            broadcast(topic, body);
            return cors(newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}"));
        }

        // Health check
        if (session.getMethod() == Method.GET && parts.isEmpty()) {
            return cors(newFixedLengthResponse(Response.Status.OK, "application/json", "{\"ok\":true}"));
        }

        return cors(newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", ""));
    }

    private String readBody(IHTTPSession session) {
        Map<String, String> files = new HashMap<>();
        try {
            session.parseBody(files);
        } catch (Exception e) {
            return "";
        }
        // application/json (what the brain sends) lands here as the raw body.
        String data = files.get("postData");
        if (data != null && !data.isEmpty()) return data;
        // Fallback: a urlencoded POST (e.g. `curl -d '{...}'`) parses the raw JSON as a lone
        // parameter key with no value — recover it so no publish silently loses its body.
        Map<String, List<String>> params = session.getParameters();
        if (params != null) {
            for (String key : params.keySet()) {
                if (key != null && (key.startsWith("{") || key.startsWith("["))) return key;
            }
        }
        return "";
    }

    private void broadcast(String topic, String json) {
        byte[] frame = ("data: " + json + "\n\n").getBytes();
        List<PipedOutputStream> dead = new ArrayList<>();
        for (PipedOutputStream out : subs(topic)) {
            try {
                out.write(frame);
                out.flush();
            } catch (Exception e) {
                dead.add(out);
            }
        }
        removeDead(topic, dead);
    }

    private void pingAll() {
        byte[] frame = ": ping\n\n".getBytes();
        for (Map.Entry<String, CopyOnWriteArraySet<PipedOutputStream>> entry : subscribers.entrySet()) {
            List<PipedOutputStream> dead = new ArrayList<>();
            for (PipedOutputStream out : entry.getValue()) {
                try {
                    out.write(frame);
                    out.flush();
                } catch (Exception e) {
                    dead.add(out);
                }
            }
            removeDead(entry.getKey(), dead);
        }
    }

    private void removeDead(String topic, List<PipedOutputStream> dead) {
        for (PipedOutputStream out : dead) {
            subs(topic).remove(out);
            try { out.close(); } catch (Exception ignored) {}
        }
    }

    private Response cors(Response res) {
        res.addHeader("Access-Control-Allow-Origin", "*");
        res.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.addHeader("Access-Control-Allow-Headers", "Content-Type");
        res.addHeader("Access-Control-Max-Age", "86400");
        return res;
    }

    @Override
    public void stop() {
        pinger.shutdownNow();
        super.stop();
    }
}
