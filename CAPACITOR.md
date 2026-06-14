# AR Vision — Native brain (Capacitor) with embedded relay

This wraps the **brain** app (camera + AI + UI) into a native Android app that **hosts
the relay in-process**. The glasses terminal then connects straight to the phone — no
separate relay machine.

```
┌─ phone ───────────────────────────────────────────┐
│  AR Vision (Capacitor app)                         │
│    WebView: brain (camera + AI + UI)               │
│    Native:  RelayHttpd  ── http://localhost:8787 ──┼──► Even app WebView
│                                                    │      = glasses terminal (.ehpk)
└────────────────────────────────────────────────────┘   ── BLE ──► G2 glasses
```

The relay runs natively (Android `RelayServerPlugin` / `RelayHttpd`, NanoHTTPD) because a
WebView's JavaScript cannot open a listening socket. The web layer just calls
`RelayServer.start({port})` on launch (see `src/native-relay.ts`).

## Why native, not the Node relay

`relay/server.mjs` (Node) is still fine for desktop/dev. The native relay exists so the
**phone is the hub**: nothing external to run, and the glasses reach it over loopback.

## Prerequisites (on your machine — not buildable in this sandbox)

- Android Studio + Android SDK (Platform 34+) and a JDK 17
- A device or emulator; for real glasses, the phone with the Even Realities app

## Build & run

```bash
npm install
npm run cap:run        # builds web, syncs, runs on a connected device/emulator
# or open the project and run from the IDE:
npm run cap:open
```

`npm run cap:sync` (build + `cap sync android`) refreshes the native project after any
web change. The native Java (relay plugin) only needs a rebuild from Android Studio.

## Topology & the terminal's relay URL

**Single phone (recommended):** the Capacitor brain app and the Even Realities app run on
the same phone. The terminal reaches the relay at `http://localhost:8787`. Build the
`.ehpk` so the terminal points there:

```bash
VITE_RELAY_URL=http://localhost:8787 npm run build
evenhub pack app.json dist -o ar-vision.ehpk   # bump app version first!
```

**Two phones / LAN:** brain on phone A, glasses on phone B. Point the terminal at phone A's
LAN IP (`VITE_RELAY_URL=http://<A-ip>:8787`). The native server binds all interfaces.

## ⚠️ The one thing to verify on-device

The brain app's own WebView is configured for cleartext + `http://localhost` (see
`capacitor.config.ts`), so it reaches the relay fine. The **glasses terminal runs inside
the Even Realities app's WebView, which we don't control** — whether it allows cleartext
HTTP to `localhost`/LAN depends on that app's network config. If the terminal can't reach
the relay, the fallback is to expose the relay over HTTPS (reverse proxy / tunnel) and
build the `.ehpk` with that `https://` URL.

## Files

- `capacitor.config.ts` — appId, `webDir: dist`, `androidScheme: http`, `cleartext: true`
- `android/app/src/main/java/com/even/arvision/RelayHttpd.java` — embedded HTTP+SSE relay
- `…/RelayServerPlugin.java` — Capacitor plugin (start/stop)
- `…/MainActivity.java` — registers the plugin
- `android/app/build.gradle` — adds `org.nanohttpd:nanohttpd:2.3.1`
- `src/native-relay.ts` — web-side start helper (no-op on non-native)
