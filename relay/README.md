# AR Vision Relay

Tiny zero-dependency SSE relay that links the two parts of AR Vision:

```
Camera app (browser/PWA, live preview + AI)        Glasses plugin (.ehpk, Even WebView)
        │  POST /publish  {scene,objects,confidence}        ▲  EventSource /events
        └───────────────────────────►  RELAY  ─────────────┘
```

The camera app has the live camera + AI but no Even bridge; the glasses plugin has the
bridge but no camera (the Even WebView blocks `getUserMedia`). They never connect directly —
the relay forwards each analysis result from the publisher to all subscribers.

## Run

```bash
npm run relay            # default port 8787
RELAY_PORT=9000 npm run relay
```

No `npm install` needed — pure Node (`node:http`), Node ≥ 18.

## Endpoints

| Method | Path       | Who         | Purpose                                   |
|--------|------------|-------------|-------------------------------------------|
| POST   | `/publish` | camera app  | Send a JSON `ARAnalysis` result           |
| GET    | `/events`  | glasses app | SSE stream of results (auto-reconnecting) |
| GET    | `/`        | anyone      | Health check                              |

The last published payload is replayed to new subscribers, so a glasses client that
connects late immediately shows the current state.

## Configuring the apps

Both the camera app and the glasses plugin take a **Relay URL** in the LM Studio
Configuration section (default `http://192.168.1.100:8787`). Point both at this server.

## ⚠️ HTTPS / mixed content

- `getUserMedia` (live preview) needs a **secure context** → the camera app must run on
  `localhost` or **HTTPS**.
- A page served over HTTPS cannot `POST` to an `http://` relay (mixed content blocked).
- So for a real phone setup, expose the relay over **HTTPS** too (e.g. `cloudflared tunnel`,
  Tailscale Serve, or a reverse proxy) and set the Relay URL to the `https://` address.
- For local dev over plain `http://` on the same LAN, everything works as-is.

Inside the Even WebView the relay origin must also be allowed by `app.json`'s `network`
whitelist (currently `["*"]`).
