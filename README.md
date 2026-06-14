# AR Vision for Even Realities G2

Hands-free augmented reality for **Even Realities G2** smart glasses. Keep your phone
in your shirt pocket with the camera facing outward: the app watches what you see,
detects objects, draws **labelled boxes around them on the glasses**, and reasons about
the scene with a vision LLM that acts as a **companion** — it knows it sees what you see
and remarks on it in your language. You can also talk to it: speak into the glasses'
microphone and the assistant answers on the display.

Everything can run **fully local and private**: the LLM (LM Studio) and the speech
recognizer (Whisper) live on your own machine, reachable from the phone over your LAN
or a Tailscale network. No cloud, no audio or images leaving your devices.

---

## How it's built — two tiers + a relay

The project is **not** a single web page. It is split in two halves that talk over a
small pub/sub relay:

```
┌─ phone ──────────────────────────────────────────────┐
│                                                      │
│  AR Vision  (Capacitor Android app = the "brain")    │
│    WebView : camera, object detection, LLM, voice,   │
│              the whole UI            (src/main.ts)   │
│    Native  : RelayHttpd  ── http://localhost:8787 ───┼──┐
│              (NanoHTTPD, SSE pub/sub)                │  │
└──────────────────────────────────────────────────────┘  │ topics: render / input / audio
                                                          │
┌─ Even Realities app (same phone) ───────────────────────│─┐ 
│  WebView : AR Vision "terminal" (.ehpk)  ◄──────────────┘ │
│            dumb renderer, no logic    (src/terminal.ts)   │
│            └── Even Hub SDK bridge ── BLE ──► G2 glasses  │
└───────────────────────────────────────────────────────────┘
```

- **Brain** (`src/main.ts`) — the Capacitor Android app. Holds *all* the logic: camera
  capture, on-device object detection, calls to the LLM, the voice pipeline, and the UI.
  It never touches the glasses directly; it only publishes **render commands**.
- **Terminal** (`src/terminal.ts`) — a tiny generic renderer packaged as the `.ehpk`
  plugin that runs inside the Even Realities app. It has no app logic: it subscribes to
  `render` commands, forwards them verbatim to the Even Hub SDK, and forwards glasses
  **input** events (touchpad) and **audio** (mic PCM) back up.
- **Relay** (`android/app/.../RelayHttpd.java`) — an in-process HTTP + SSE server hosted
  natively by the brain app on `localhost:8787`. A WebView's JavaScript can't open a
  listening socket, so the relay is native. The phone *is* the hub — nothing external to
  run. The wire protocol (3 topics: `render`, `input`, `audio`) is in `src/protocol.ts`.

A pure-Node version of the relay (`relay/server.mjs`) also exists for desktop/dev.

See **CAPACITOR.md** for the native/relay details.

### What runs where

| Piece            | Lives in                                  | Source                          |
| ---------------- | ----------------------------------------- | ------------------------------- |
| Camera + UI      | Capacitor app WebView (phone)             | `src/main.ts`, `src/style.css`  |
| Object detection | same WebView, MediaPipe EfficientDet-Lite | `src/perception.ts`             |
| Glasses renderer | Even Realities app WebView (the `.ehpk`)  | `src/terminal.ts`               |
| Relay            | Native Android, in the Capacitor app      | `android/.../RelayHttpd.java`   |
| LLM (vision/chat)| Your computer                             | LM Studio                       |
| Speech-to-text   | Your computer                             | `asr/server.py` (Whisper)       |
| Server manager   | Your computer (optional GUI)              | `tools/server_manager.py`       |

---

## Features

- **Live scene understanding** — continuous frame capture with two levels: fast on-device
  object detection (MediaPipe) and slower vision-LLM reasoning for richer descriptions.
- **Boxes & labels on the glasses** — each detected object gets a positioned, bordered
  label drawn at its location on the 576×288 display, built from cheap **text** containers
  (an earlier image-tile HUD was too slow over BLE). A bottom caption strip always shows
  the companion's latest remark. The same boxes are mirrored on the phone preview.
- **Vision companion** — the LLM is prompted as a companion that sees the user's view: the
  current frame and a textual summary (detected objects + any OCR'd text) are sent with
  each turn, so it can answer "what is this?" and proactively comment, briefly, in the
  user's language. Applies to both chat and the automatic scene analysis.
- **Stable, low-traffic HUD** — detector flicker is debounced (temporal grace + spatial
  hysteresis) and a scene-change gate means a still object never re-sends. Two runtime
  sliders (refresh floor, jitter threshold) and a live debug readout let you tune it.
- **Voice chat (privacy-first)** — open the glasses' mic, speak, the PCM streams to the
  brain over the relay, gets transcribed by a **local Whisper** server, sent to the LLM,
  and the answer is printed on the glasses.
- **Touchpad events** — click / double-click / scroll are forwarded from the glasses.
- **Local or remote AI** — LM Studio or any OpenAI-compatible endpoint; works over LAN or
  Tailscale.

---

## Prerequisites

On your **computer** (the AI host):

- [LM Studio](https://lmstudio.ai) with a **vision-capable** model loaded (e.g. a
  Qwen-VL / MiniCPM-V / LLaVA variant).
- [`uv`](https://docs.astral.sh/uv/) — runs the Whisper server with its inline deps; no
  manual `pip install` needed.
- *(optional)* [Tailscale](https://tailscale.com) if the phone and computer aren't on the
  same Wi-Fi.

To **build the phone app**:

- Node.js v18+
- Android SDK (Platform 34+) and **JDK 21** — newer JDKs break the Android Gradle plugin's
  `JdkImageTransform`. `android/gradle.properties` already pins `org.gradle.java.home` to
  JDK 21; adjust the path if yours differs.
- `ANDROID_SDK_ROOT` exported in your shell (native-run reads the env, not
  `local.properties`).
- A phone with the **Even Realities app** installed, glasses paired over BLE.

```bash
npm install
```

---

## 1. Start the AI backends (on your computer)

Both servers must bind `0.0.0.0` **and** enable CORS — the brain's WebView is served from
`http://localhost`, so every call to LM Studio / Whisper is cross-origin and a CORS
preflight will otherwise block it.

### Easiest: the Qt manager

```bash
uv run --script tools/server_manager.py
```

A small GUI that starts/stops LM Studio (`lms server start --cors --bind 0.0.0.0`) and the
Whisper server, shows live status dots, and **prints the exact URLs to paste into the app**
(it auto-detects your Tailscale/LAN IP). A `.desktop` launcher is in
`tools/ar-vision-servers.desktop` (installs to `~/.local/share/applications/`).

### Or by hand

```bash
# LM Studio — reachable on the LAN/Tailscale, with CORS
lms server start --cors --bind 0.0.0.0          # default port 1234

# Whisper ASR — OpenAI-compatible /v1/audio/transcriptions, local & private
uv run asr/server.py                            # default model=small, port 8000
# tune it:
WHISPER_MODEL=base WHISPER_PORT=8000 WHISPER_LANGUAGE=it uv run asr/server.py
```

Whisper downloads its weights from Hugging Face on first run, then is fully offline.

---

## 2. Build & install the brain app (the APK)

```bash
export ANDROID_SDK_ROOT=$HOME/Android/Sdk      # your SDK path
npm run cap:run                                 # build web + sync + run on device
# or open in Android Studio:
npm run cap:open
```

`npm run cap:sync` re-syncs the native project after a web change. The native Java (relay
plugin) only needs a rebuild from Android Studio when you touch it.

The brain hosts the relay on `localhost:8787` as soon as it launches.

---

## 3. Build & sideload the glasses terminal (the `.ehpk`)

The Even runtime loads `index.html`, so the terminal must be packed *as* `index.html`. The
script handles the dedicated single-page build, the rename, and the pack:

```bash
# bump the version in BOTH package.json and app.json first, then:
npm run pack:ehpk        # -> ar-vision.ehpk
```

By default the terminal connects to the relay at `http://localhost:8787` (single-phone
setup). For a **two-phone / LAN** setup (brain on phone A, glasses on phone B) point it at
phone A:

```bash
VITE_RELAY_URL=http://<phone-A-ip>:8787 npm run pack:ehpk
```

Sideload `ar-vision.ehpk` through the Even Realities app / Even Hub.

> ⚠️ The terminal runs inside the Even Realities app's WebView, which we don't control. If
> it can't reach a cleartext `http://` relay, expose the relay over HTTPS (tunnel / reverse
> proxy) and rebuild the `.ehpk` with that `https://` URL. See CAPACITOR.md.

---

## 4. Point the app at your servers

Open the brain app on the phone and fill in the config (saved to `localStorage`, so it's a
one-time setup). Use the values the Qt manager prints, or:

- **LM Studio IP / Port** — your computer's Tailscale (`100.x.x.x`) or LAN IP, and `1234`.
- **Model** — the exact model name loaded in LM Studio.
- **Whisper (ASR) URL** — `http://<computer-ip>:8000/v1/audio/transcriptions`.
- *(optional)* **API key** — for an OpenAI-compatible remote endpoint.

Then:

1. **Start Camera** — live preview with object boxes; the brain begins analyzing frames.
2. **Object labels on glasses** (checkbox) — draw the boxes + labels on the glasses. Tune
   the two sliders if needed: *HUD refresh floor* (min ms between redraws) and *Jitter grid*
   (how far a box must move before it redraws). The debug line shows what's detected vs. drawn.
3. **Analyze Now** — one-shot companion remark about the current view.
4. **Start Voice** — opens the glasses mic; speak, then stop to transcribe → LLM → glasses.

### Over Tailscale

Install Tailscale on both the computer and the phone, log in with the same account, and use
the computer's `100.x.x.x` address everywhere above. Because the servers bind `0.0.0.0`,
they're reachable on the Tailscale interface from anywhere — no port forwarding. The relay
stays on `localhost` (it's on the phone).

---

## Project structure

```
even-ar-vision/
├── src/
│   ├── main.ts           # brain: camera, detection, LLM, voice, UI
│   ├── perception.ts     # MediaPipe object detection → Detection[]
│   ├── terminal.ts       # glasses terminal (.ehpk renderer)
│   ├── protocol.ts       # wire protocol: render / input / audio topics
│   ├── relay.ts          # browser-side relay client (SSE + publish)
│   ├── native-relay.ts   # start the native relay (no-op off-device)
│   └── style.css
├── android/              # Capacitor Android project (brain + native relay)
│   └── app/src/main/java/com/even/arvision/
│       ├── RelayHttpd.java        # in-process HTTP + SSE relay
│       ├── RelayServerPlugin.java # Capacitor plugin (start/stop)
│       └── MainActivity.java
├── asr/server.py         # local Whisper ASR (OpenAI-compatible)
├── tools/
│   ├── server_manager.py        # Qt GUI to run LM Studio + Whisper
│   └── ar-vision-servers.desktop
├── relay/server.mjs      # standalone Node relay (desktop/dev)
├── index.html            # brain entrypoint
├── glasses.html          # terminal entrypoint (→ index.html in the .ehpk)
├── app.json              # Even Hub manifest (the .ehpk)
├── capacitor.config.ts   # appId, cleartext http, androidScheme
├── vite.config.ts        # brain build
└── vite.plugin.config.ts # terminal-only build for the .ehpk
```

---

## NPM scripts

| Script                 | What it does                                              |
| ---------------------- | -------------------------------------------------------- |
| `npm run dev`          | Vite dev server (brain, web-only, no glasses).           |
| `npm run build`        | Type-check + build the brain web bundle.                 |
| `npm run cap:run`      | Build web, `cap sync`, run the APK on a device.          |
| `npm run cap:open`     | Open the Android project in Android Studio.              |
| `npm run cap:sync`     | Build web + `cap sync android`.                          |
| `npm run pack:ehpk`    | Build the terminal-only bundle and pack `ar-vision.ehpk`.|
| `npm run relay`        | Run the standalone Node relay (dev).                     |

---

## Troubleshooting

**Glasses show nothing, relay says "connected".** The Even WebView's terminal couldn't get
the SSE stream. Two known causes, both already fixed in this repo but worth re-checking if
you've modified the relay: (1) NanoHTTPD gzipping `text/event-stream` and buffering frames —
`RelayHttpd` overrides `useGzipWhenAccepted` to `false`; (2) a render arriving before the
SDK bridge is ready — the terminal buffers a pending render until `waitForEvenAppBridge`
resolves.

**`'messages' field is required` from LM Studio.** CORS was off, so the cross-origin
preflight `OPTIONS` was rejected and the browser never sent the real `POST`. Start LM Studio
with `--cors --bind 0.0.0.0`.

**`AI service not available: signal is aborted without reason`.** The LLM request timed out.
A vision + reasoning model is slow; the timeout is set to 60 s in `main.ts`.

**`ERR_SDK_NOT_FOUND` on `cap run`.** `native-run` needs `ANDROID_SDK_ROOT` exported in the
shell — it doesn't read `local.properties`.

**Gradle `JdkImageTransform` / `jlink` failure.** Your default JDK is too new. Use JDK 21
(`org.gradle.java.home` in `android/gradle.properties`).

**No transcription / voice does nothing.** Check the Whisper server is up (the Qt manager
dot, or `curl http://<ip>:8000/`) and the ASR URL in the app points to it. Note: the glasses
PCM format is assumed 16 kHz mono 16-bit LE — undocumented, so verify if results are garbled.

---

## Permissions (`app.json`)

- `network` — connect to the relay (and through it, the AI services).
- `g2-microphone` — capture glasses-mic audio for voice chat (via the SDK bridge).

---

## Resources

- [Even Hub Documentation](https://hub.evenrealities.com/docs/getting-started/overview)
- [Even Hub SDK](https://www.npmjs.com/package/@evenrealities/even_hub_sdk)
- [G2 Development Notes](https://github.com/nickustinov/even-g2-notes/blob/main/G2.md)
- [Discord Community](https://discord.gg/Y4jHMCU4sv)

## License

Demonstration project for Even Realities G2 smart glasses.
