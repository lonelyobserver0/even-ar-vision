import './style.css'
import { loadObjectDetector, detectObjects, loadTextReader, readText, type Detection } from './perception'
import { RelayClient } from './relay'
import { startNativeRelay } from './native-relay'
import {
  RENDER_TOPIC,
  INPUT_TOPIC,
  AUDIO_TOPIC,
  type RenderCommand,
  type InputMessage,
  type AudioMessage,
  type PageSpec,
} from './protocol'

declare const __APP_VERSION__: string // injected by Vite from package.json

interface ARAnalysis {
  objects: string[]
  scene: string
  confidence: number
  say: string // the companion's short spoken-style remark about the scene
}

interface LMStudioConfig {
  baseUrl: string
  model: string
  maxTokens: number
  temperature: number
  apiKey?: string
  useApiKey: boolean
}

interface LogEntry {
  level: 'info' | 'warn' | 'error'
  message: string
  timestamp: Date
}

// AR Vision "brain": camera + AI + UI. It has no Even bridge — it drives the glasses
// indirectly by publishing render commands to the relay, and reacts to glasses input
// events that the terminal (.ehpk) forwards back. See src/terminal.ts and relay/.
class ARVisionApp {
  private static readonly GLASSES_CONTAINER_ID = 1
  private static readonly GLASSES_CONTAINER_NAME = 'main'
  // Level 1 (cheap on-device detection) tick; Level 2 (the vision-LLM) is gated below it.
  private static readonly LEVEL1_INTERVAL_MS = 800
  // Don't escalate to the LLM more often than this, even when new objects appear.
  private static readonly LEVEL2_MIN_INTERVAL_MS = 4000
  // Cadence for Level 2 when no on-device detector is available (fallback).
  private static readonly ANALYSIS_INTERVAL_MS = 3000
  // Abort an LLM call after this long. Vision + reasoning models are slow (model load,
  // image projector, thinking tokens), so this must be generous — 5s aborts almost every call.
  private static readonly LLM_REQUEST_TIMEOUT_MS = 60000
  // Glasses-mic PCM format (assumed — verify on-device): 16 kHz, mono, signed 16-bit LE.
  private static readonly MIC_SAMPLE_RATE = 16000
  // Ignore a "recording" shorter than this many bytes (= silence / accidental tap).
  private static readonly MIC_MIN_BYTES = 16000 // ~0.5 s of 16-bit @ 16 kHz
  // OCR is much heavier than object detection — run it on its own slow cadence.
  private static readonly OCR_INTERVAL_MS = 5000
  private static readonly OCR_ENABLED = true
  // OCR is noisy: only accept text once it reads consistently across this many passes,
  // judged by normalized similarity (1 = identical) — filters out flickering garbage.
  private static readonly OCR_CONSISTENCY = 2
  private static readonly OCR_SIMILARITY = 0.8
  // Longest side sent to the model: fewer pixels = far fewer tokens = much faster inference.
  private static readonly ANALYSIS_MAX_DIM = 768
  // Frame-diff gating (Level-2 fallback): NxN grayscale signature, and the mean per-cell
  // change (0..1) below which the scene counts as "unchanged" and the model call is skipped.
  private static readonly DIFF_GRID = 16
  private static readonly DIFF_THRESHOLD = 0.04

  // ── Positioned-label HUD (boxes drawn with bordered TEXT containers) ─────────
  // Images over BLE are too slow (4 tiles ≈ seconds). Text is light, and a text container
  // takes xPosition/yPosition/width/height + a border — so one bordered container per object,
  // sized to its box and holding the label, draws the bounding box AND the name, fast.
  private static readonly HUD_W = 576    // glasses display width  (for video→display mapping)
  private static readonly HUD_H = 288    // glasses display height
  // SDK cap is 8 "other" (text) containers: a full-screen bg (input) + a caption strip + up to 6 labels.
  private static readonly HUD_MAX_LABELS = 6
  private static readonly HUD_LABEL_MIN_W = 48
  private static readonly HUD_LABEL_MIN_H = 28
  private static readonly HUD_CAPTION_ID = 2     // bottom strip holding the companion's remark
  private static readonly HUD_CAPTION_H = 48      // px tall, at the bottom of the 288-high display
  // Throttle redraws, and gate on a scene signature so detector jitter doesn't trigger one.
  // Both the throttle (ms) and the jitter grid (px) are user-tunable — see hudIntervalMs /
  // hudPosQuant below. Detectors also flicker (a box near the confidence threshold blinks in
  // and out); keep an object until it's been missing this many ticks so a 1-frame dropout
  // never causes a redraw.
  private static readonly HUD_MISS_GRACE = 3

  // Persona for the chat AI: it's the companion living in the glasses, seeing the user's view.
  private static readonly COMPANION_SYSTEM_PROMPT = [
    "You are the AR companion that lives in the user's Even Realities G2 smart glasses.",
    "The user wears the glasses and keeps their phone camera facing outward, so you literally",
    "see what they see: the live view is described to you (detected objects, any readable text)",
    "and the current frame may be attached as an image. Act like a knowledgeable friend at the",
    "user's side — proactive, warm, never robotic.",
    "",
    "Rules:",
    "- Reply in the user's language.",
    "- Your answer is shown on a tiny 576×288 glasses display and may be read aloud: keep it very",
    "  short (1–2 sentences, ideally under 200 characters), plain text — no markdown, lists or emoji.",
    "- When they say 'this/that/what is this', ground your answer in the current view and image.",
    "- If the view is unclear or the camera is off, say so briefly instead of guessing.",
    "- Don't mention being an AI/model, prompts, or JSON. Just talk naturally.",
  ].join('\n')

  private canvasElement: HTMLCanvasElement | null = null
  private diffCanvas: HTMLCanvasElement | null = null
  private lastFrameSignature: Uint8ClampedArray | null = null
  private chatHistory: Array<{role: string, content: string}> = []
  private logs: LogEntry[] = []
  private logFilter: 'all' | 'info' | 'warn' | 'error' = 'all'
  private aiConnected = false

  private relayUrl = 'http://localhost:8787'
  private relay!: RelayClient

  // Voice chat: glasses mic → relay (PCM) → here → local Whisper (ASR) → LLM.
  // Default points at the PC over Tailscale (works on any network); override in the UI.
  private asrUrl = 'http://100.120.191.29:8000/v1/audio/transcriptions'
  private asrModel = 'whisper-1'
  private isListening = false
  private audioUnsub: (() => void) | null = null
  private audioChunks: Uint8Array[] = []
  private audioBytes = 0

  private isStreaming = false
  private isAnalyzing = false
  private usingFallbackCamera = false
  private mediaStream: MediaStream | null = null
  private analysisTimer: number | null = null

  // Two-tier perception state.
  private objectDetector: Awaited<ReturnType<typeof loadObjectDetector>> | null = null
  private textReader: Awaited<ReturnType<typeof loadTextReader>> | null = null
  private detectorLoading = false
  private level1Busy = false
  private ocrBusy = false
  private lastOcrAt = 0
  private ocrCandidate = ''
  private ocrStreak = 0
  private level1Objects = new Set<string>()
  private level1Text = ''
  private textChanged = false
  private ocrCanvas: HTMLCanvasElement | null = null
  private lastLevel2At = 0

  // Positioned-label HUD state: when on, the glasses show bordered text labels at each object.
  private hudEnabled = false
  private hudBusy = false         // serialize page sends
  private lastHudAt = 0
  private lastDrawnDets: Detection[] = [] // labels actually on the glasses, for hysteresis gating
  private stableDets: Array<Detection & { miss: number }> = [] // flicker-debounced detections for the HUD
  private lastHudSentAt = 0       // when a HUD page last actually reached the relay
  private lastCaption = ''       // last text shown (non-HUD mode)
  // Runtime-tunable HUD knobs (sliders in the UI, persisted to localStorage).
  private hudIntervalMs = 1500   // min ms between redraws when the scene changes
  private hudPosQuant = 24       // jitter threshold (px on the 576×288 display)

  private lmStudioConfig: LMStudioConfig = {
    baseUrl: 'http://100.120.191.29:1234/v1', // PC over Tailscale (works on any network); override in the UI
    model: 'local-model', // Sostituisci con il nome del tuo modello in LM Studio
    maxTokens: 500,
    temperature: 0.7,
    useApiKey: false
  }

  constructor() {
    try {
      this.initializeUI()
      console.log('AR Vision app initialized')
    } catch (error) {
      console.error('Failed to initialize app:', error)
      const app = document.querySelector<HTMLDivElement>('#app')
      if (app) {
        app.innerHTML = `<div class="ar-container"><h1>AR Vision</h1><p>Error loading app. Check console.</p></div>`
      }
    }
  }

  private initializeUI() {
    const app = document.querySelector<HTMLDivElement>('#app')!
    app.innerHTML = `
      <div class="ar-container">
        <h1>AR Vision <span class="version">v${__APP_VERSION__}</span></h1>
        <p>Camera-based environment analysis for Even G2 glasses</p>

        <div class="camera-section">
          <canvas id="capture" style="display:none;"></canvas>
          <input type="file" id="cameraInput" accept="image/*" capture="environment" style="display:none;">
          <video id="cameraView" autoplay playsinline muted style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:1;display:none;"></video>
          <canvas id="overlay" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:2;pointer-events:none;display:none;"></canvas>
          <img id="capturedImg" style="position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover;z-index:1;display:none;">
          <div class="camera-overlay" id="cameraOverlay">
            <span class="camera-idle">Tap Start Camera</span>
          </div>
          <div class="ai-badge" id="aiBadge">AI: disconnected</div>
        </div>

        <div class="controls">
          <button id="startCamera" class="btn btn-primary">Start Camera</button>
          <button id="stopCamera" class="btn btn-secondary" disabled>Stop Camera</button>
          <button id="requestPermission" class="btn btn-accent">Request Permission</button>
          <button id="analyze" class="btn btn-accent" disabled>Analyze Now</button>
          <label class="hud-toggle"><input type="checkbox" id="hudToggle"> Object labels on glasses</label>
        </div>

        <div class="hud-tuning">
          <div class="slider-row">
            <label for="hudInterval">HUD refresh floor: <b id="hudIntervalVal">1500</b> ms</label>
            <input type="range" id="hudInterval" min="200" max="4000" step="100" value="1500">
          </div>
          <div class="slider-row">
            <label for="hudQuant">Jitter grid (redraw threshold): <b id="hudQuantVal">24</b> px</label>
            <input type="range" id="hudQuant" min="4" max="64" step="4" value="24">
          </div>
          <div class="hud-debug" id="hudDebug">HUD idle</div>
        </div>

        <div class="status">
          <p id="status">Ready to start</p>
        </div>

        <div class="config-section">
          <h3>LM Studio Configuration</h3>
          <div class="config-item">
            <label for="lmStudioIp">LM Studio IP:</label>
            <input type="text" id="lmStudioIp" value="100.120.191.29" placeholder="100.x.y.z (Tailscale) or LAN IP">
          </div>
          <div class="config-item">
            <label for="lmStudioPort">Port:</label>
            <input type="text" id="lmStudioPort" value="1234" placeholder="1234">
          </div>
          <div class="config-item">
            <label for="lmStudioModel">Model:</label>
            <input type="text" id="lmStudioModel" value="local-model" placeholder="model-name">
          </div>
          <div class="config-item">
            <label for="useApiKey">Use API Key:</label>
            <input type="checkbox" id="useApiKey">
          </div>
          <div class="config-item">
            <label for="apiKey">API Key (OpenAI-compatible):</label>
            <input type="password" id="apiKey" placeholder="sk-..." autocomplete="off">
          </div>
          <div class="config-item">
            <label for="relayUrl">Relay URL:</label>
            <input type="text" id="relayUrl" value="http://localhost:8787" placeholder="http://host:8787">
          </div>
          <div class="config-item">
            <label for="asrUrl">Whisper (ASR) URL:</label>
            <input type="text" id="asrUrl" placeholder="http://host:8000/v1/audio/transcriptions">
          </div>
          <div class="config-item">
            <label for="asrModel">Whisper model:</label>
            <input type="text" id="asrModel" value="whisper-1" placeholder="whisper-1">
          </div>
          <div class="config-item">
            <label>Relay status:</label>
            <span id="relayStatus" class="relay-badge relay-down">○ disconnected</span>
          </div>
          <button id="saveConfig" class="btn btn-secondary">Save Configuration</button>
        </div>

        <div class="chat-section">
          <h3>Chat with AI</h3>
          <div class="chat-controls">
            <button id="startVoice" class="btn btn-primary">🎤 Start Voice</button>
            <button id="stopVoice" class="btn btn-secondary" disabled>⏹️ Stop Voice</button>
          </div>
          <div class="chat-status">
            <p id="voiceStatus">Type a message below to chat with the AI</p>
          </div>
          <div class="chat-history" id="chatHistory">
            <p class="chat-placeholder">Chat history will appear here...</p>
          </div>
          <div class="chat-input">
            <input type="text" id="textInput" placeholder="Or type your message here...">
            <button id="sendText" class="btn btn-accent">Send</button>
          </div>
        </div>

        <div class="analysis-result">
          <h3>Analysis Results</h3>
          <div id="level1Labels" class="level1-labels">Level 1: idle</div>
          <div id="results">
            <p>No analysis yet</p>
          </div>
        </div>

        <div class="glasses-preview">
          <h3>Glasses Display Preview</h3>
          <div id="glassesDisplay" class="glasses-display">
            <p>Waiting for data...</p>
          </div>
        </div>

        <div class="log-section">
          <div class="log-header">
            <h3>Logs</h3>
            <div class="log-controls">
              <select id="logFilter">
                <option value="all">All</option>
                <option value="info">Info</option>
                <option value="warn">Warnings</option>
                <option value="error">Errors</option>
              </select>
              <button id="clearLogs" class="btn btn-secondary btn-sm">Clear</button>
            </div>
          </div>
          <div class="log-container" id="logContainer">
            <p class="log-empty">No logs yet...</p>
          </div>
        </div>
      </div>
    `

    this.canvasElement = document.querySelector<HTMLCanvasElement>('#capture')!

    document.querySelector<HTMLButtonElement>('#startCamera')!.addEventListener('click', () => this.startCamera())
    document.querySelector<HTMLButtonElement>('#stopCamera')!.addEventListener('click', () => this.stopCamera())
    document.querySelector<HTMLButtonElement>('#requestPermission')!.addEventListener('click', () => this.requestCameraPermission())
    document.querySelector<HTMLButtonElement>('#analyze')!.addEventListener('click', () => this.analyzeScene())
    document.querySelector<HTMLInputElement>('#hudToggle')!.addEventListener('change', (e) =>
      void this.onHudToggle((e.target as HTMLInputElement).checked))
    document.querySelector<HTMLInputElement>('#hudInterval')!.addEventListener('input', (e) => {
      this.hudIntervalMs = Number((e.target as HTMLInputElement).value)
      document.querySelector<HTMLElement>('#hudIntervalVal')!.textContent = String(this.hudIntervalMs)
      localStorage.setItem('hudIntervalMs', String(this.hudIntervalMs))
    })
    document.querySelector<HTMLInputElement>('#hudQuant')!.addEventListener('input', (e) => {
      this.hudPosQuant = Number((e.target as HTMLInputElement).value)
      document.querySelector<HTMLElement>('#hudQuantVal')!.textContent = String(this.hudPosQuant)
      localStorage.setItem('hudPosQuant', String(this.hudPosQuant))
      this.lastDrawnDets = [] // re-evaluate the gate against the new threshold on the next frame
    })
    document.querySelector<HTMLButtonElement>('#saveConfig')!.addEventListener('click', () => this.saveConfig())
    document.querySelector<HTMLButtonElement>('#startVoice')!.addEventListener('click', () => this.startGlassesAudio())
    document.querySelector<HTMLButtonElement>('#stopVoice')!.addEventListener('click', () => this.stopGlassesAudio())
    document.querySelector<HTMLButtonElement>('#sendText')!.addEventListener('click', () => this.sendTextMessage())
    document.querySelector<HTMLInputElement>('#textInput')!.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') this.sendTextMessage()
    })

    this.loadConfig()
    this.initializeLogging()
    this.initializeRelay()
    this.testAiConnection()
  }

  // ── Relay (brain side) ─────────────────────────────────────────────────────
  // Down: publish render commands so the glasses terminal draws them.
  // Up: subscribe to input events the terminal forwards from the glasses.

  private async initializeRelay() {
    // Native (Capacitor) build: host the relay in-process and talk to it over localhost,
    // so the glasses terminal can reach it directly on the phone — no external relay.
    const nativeUrl = await startNativeRelay(8787)
    if (nativeUrl) {
      this.relayUrl = nativeUrl
      const input = document.querySelector<HTMLInputElement>('#relayUrl')
      if (input) input.value = nativeUrl
      console.log('Embedded relay running at', nativeUrl)
    }

    this.relay?.closeAll()
    this.relay = new RelayClient(this.relayUrl)
    this.updateRelayBadge(false)
    this.relay.subscribe<InputMessage>(
      INPUT_TOPIC,
      (msg) => this.handleGlassesInput(msg),
      (connected) => this.updateRelayBadge(connected),
    )
    console.log('Relay configured:', this.relayUrl)
    this.updateStatus(`Relay: ${this.relayUrl}. Start the camera to begin.`)
  }

  private updateRelayBadge(connected: boolean) {
    const badge = document.querySelector<HTMLSpanElement>('#relayStatus')
    if (!badge) return
    badge.textContent = `${connected ? '●' : '○'} ${connected ? 'connected' : 'disconnected'} — ${this.relayUrl}`
    badge.className = `relay-badge ${connected ? 'relay-up' : 'relay-down'}`
  }

  private handleGlassesInput(msg: InputMessage) {
    switch (msg.kind) {
      case 'hello':
        console.log('Glasses terminal online', msg.launchSource ? `(via ${msg.launchSource})` : '')
        this.updateStatus('👓 Glasses terminal connected.')
        break
      case 'event':
        console.log('Glasses input:', msg.action)
        // A click on the glasses asks the brain to analyse the current view now.
        if (msg.action === 'click') void this.analyzeScene()
        break
      case 'exit-request':
        console.log('Glasses requested exit')
        break
    }
  }

  private glassesPage(content: string): PageSpec {
    return {
      containerTotalNum: 1,
      textObject: [{
        xPosition: 0,
        yPosition: 0,
        width: 576,
        height: 288,
        borderWidth: 2,
        borderColor: 5,
        paddingLength: 8,
        containerID: ARVisionApp.GLASSES_CONTAINER_ID,
        containerName: ARVisionApp.GLASSES_CONTAINER_NAME,
        content,
        isEventCapture: 1,
      }],
    }
  }

  /** Show text on the glasses by publishing a render command (retained for late terminals). */
  private async publishToGlasses(content: string) {
    const cmd: RenderCommand = { op: 'page', page: this.glassesPage(content) }
    const ok = await this.relay.publish(RENDER_TOPIC, cmd, true)
    if (!ok) {
      // The in-app preview below is purely local — it updates regardless of delivery. Surface the
      // failed publish so a misconfigured Relay URL doesn't masquerade as a working pipeline.
      console.warn(`Render NOT delivered — relay rejected the publish at ${this.relayUrl} (check the Relay URL points at the relay, not LM Studio).`)
    }
    this.updateGlassesPreview(content)
  }

  private async requestCameraPermission() {
    if (!navigator.mediaDevices?.getUserMedia) {
      this.updateStatus('📷 Camera API unavailable here — the app falls back to photo capture.')
      return
    }
    try {
      // Triggers the OS permission prompt; we immediately release the stream.
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } })
      stream.getTracks().forEach(track => track.stop())
      this.updateStatus('✅ Camera permission granted. Tap "Start Camera".')
    } catch (err) {
      this.updateStatus('⚠️ Camera permission denied or unavailable.')
      console.warn('Camera permission request failed:', err instanceof Error ? err.message : err)
    }
  }

  private async startCamera() {
    this.isStreaming = true
    const video = document.querySelector<HTMLVideoElement>('#cameraView')!

    // Preferred path: keep a live camera stream always on and preview it continuously.
    // navigator.mediaDevices is undefined in insecure contexts and getUserMedia is
    // rejected by the Even WebView, so we fall back to native photo capture there.
    if (navigator.mediaDevices?.getUserMedia) {
      try {
        this.mediaStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
        video.srcObject = this.mediaStream
        await video.play()
        video.style.display = 'block'
        document.querySelector<HTMLCanvasElement>('#overlay')!.style.display = 'block'
        document.querySelector<HTMLDivElement>('#cameraOverlay')!.style.display = 'none'

        this.usingFallbackCamera = false
        this.setCameraButtons(true)
        this.updateStatus('📷 Live camera active.')

        // Level 1 (cheap, local) runs continuously and escalates to Level 2 (the LLM)
        // only when it spots something new. The preview itself keeps streaming live.
        void this.loadDetectors()
        this.analysisTimer = window.setInterval(() => {
          void this.level1Tick()
        }, ARVisionApp.LEVEL1_INTERVAL_MS)
        return
      } catch (err) {
        console.warn('Live camera unavailable, falling back to photo capture:', err instanceof Error ? err.message : err)
        this.mediaStream = null
      }
    }

    this.startCameraFallback()
  }

  /** Fallback for the Even WebView: native photo capture re-opened in a loop. */
  private startCameraFallback() {
    this.usingFallbackCamera = true
    this.setCameraButtons(true)

    const cameraInput = document.querySelector<HTMLInputElement>('#cameraInput')!
    const capturedImg = document.querySelector<HTMLImageElement>('#capturedImg')!

    cameraInput.onchange = async () => {
      const file = cameraInput.files?.[0]
      if (!file || !this.isStreaming) {
        this.stopCamera()
        return
      }

      const url = URL.createObjectURL(file)
      capturedImg.onload = () => URL.revokeObjectURL(url)
      capturedImg.src = url
      capturedImg.style.display = 'block'
      document.querySelector<HTMLDivElement>('#cameraOverlay')!.style.display = 'none'

      this.updateStatus('📸 Analyzing...')
      await this.runLevel2(true) // a fresh photo is an intentional capture

      // Auto-reopen camera for next capture
      if (this.isStreaming) {
        setTimeout(() => {
          if (this.isStreaming) cameraInput.click()
        }, 1500)
      }
    }

    cameraInput.click()
    this.updateStatus('📷 Live preview unavailable here — using photo capture.')
  }

  private stopCamera() {
    this.isStreaming = false

    if (this.analysisTimer !== null) {
      clearInterval(this.analysisTimer)
      this.analysisTimer = null
    }
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop())
      this.mediaStream = null
    }

    this.lastFrameSignature = null // next session re-analyses its first frame
    this.level1Objects.clear()
    this.level1Text = ''
    this.textChanged = false
    this.ocrCandidate = ''
    this.ocrStreak = 0
    this.lastLevel2At = 0
    this.lastOcrAt = 0
    this.lastHudAt = 0
    this.lastDrawnDets = []
    this.stableDets = []
    const labels = document.querySelector<HTMLDivElement>('#level1Labels')
    if (labels) labels.textContent = 'Level 1: idle'

    const video = document.querySelector<HTMLVideoElement>('#cameraView')!
    video.srcObject = null
    video.style.display = 'none'

    const overlay = document.querySelector<HTMLCanvasElement>('#overlay')!
    overlay.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height)
    overlay.style.display = 'none'

    const capturedImg = document.querySelector<HTMLImageElement>('#capturedImg')!
    capturedImg.style.display = 'none'
    capturedImg.src = ''

    document.querySelector<HTMLDivElement>('#cameraOverlay')!.style.display = 'flex'
    this.setCameraButtons(false)
    this.updateStatus('Camera stopped.')
  }

  private setCameraButtons(active: boolean) {
    const startBtn = document.querySelector<HTMLButtonElement>('#startCamera')!
    startBtn.textContent = active ? 'Active' : 'Start Camera'
    startBtn.disabled = active
    document.querySelector<HTMLButtonElement>('#stopCamera')!.disabled = !active
    document.querySelector<HTMLButtonElement>('#analyze')!.disabled = !active
  }

  // ── Level 1: cheap on-device perception + escalation policy ─────────────────

  /** Lazy-load the on-device detectors on first camera start (models fetched from CDN). */
  private async loadDetectors() {
    if (this.objectDetector || this.detectorLoading) return
    this.detectorLoading = true
    try {
      this.updateStatus('🧠 Loading on-device detectors…')
      // The brain runs in a normal browser / Capacitor WebView, where dynamic import works
      // (unlike the Even WebView). Objects are required; OCR is best-effort.
      this.objectDetector = await loadObjectDetector()
      console.log('On-device object detector ready (MediaPipe EfficientDet-Lite)')
      this.updateStatus('🧠 Object detector ready.')
      if (ARVisionApp.OCR_ENABLED) {
        loadTextReader()
          .then(w => { this.textReader = w; console.log('OCR reader ready (Tesseract)') })
          .catch(err => console.warn('OCR unavailable:', err instanceof Error ? err.message : err))
      }
    } catch (err) {
      console.warn('On-device detector unavailable — Level 2 only:', err instanceof Error ? err.message : err)
      this.objectDetector = null
    } finally {
      this.detectorLoading = false
    }
  }

  /** Level-1 tick: cheap local detection → labels; escalate to Level 2 on new objects/text. */
  private async level1Tick() {
    if (this.level1Busy || !this.isStreaming || this.usingFallbackCamera) return
    const video = document.querySelector<HTMLVideoElement>('#cameraView')!
    if (!video.videoWidth) return

    this.level1Busy = true
    try {
      // Detector not ready (still loading or failed) → fall back to periodic, diff-gated Level 2.
      if (!this.objectDetector) {
        if (Date.now() - this.lastLevel2At >= ARVisionApp.ANALYSIS_INTERVAL_MS) {
          void this.runLevel2(false) // don't block the tick on the slow LLM call
        }
        return
      }

      let detections: Detection[]
      try {
        detections = detectObjects(this.objectDetector, video, performance.now())
      } catch (err) {
        console.warn('Level-1 detect failed:', err instanceof Error ? err.message : err)
        return
      }
      // Debounce detector flicker once per tick, then draw the STABLE boxes on the preview too
      // (not the raw, jittery ones) so the phone shows the same locked boxes as the glasses.
      this.updateStableDets(detections, video.videoWidth, video.videoHeight)
      this.drawDetections(video, this.stableDets)
      const objects = new Set(detections.map(d => d.label))
      const newObjects = [...objects].filter(o => !this.level1Objects.has(o))

      // Kick off OCR on its own slow cadence (async, non-blocking).
      if (this.textReader && !this.ocrBusy && Date.now() - this.lastOcrAt >= ARVisionApp.OCR_INTERVAL_MS) {
        void this.runOcr(video)
      }

      // Show labels immediately when objects or text change — local, works with the LLM offline.
      const objectsChanged = !this.sameSet(objects, this.level1Objects)
      if (objectsChanged || this.textChanged) {
        this.displayLevel1(objects, this.level1Text)
        // HUD off: text labels on the glasses. HUD on: the bitmap carries the boxes, so the
        // glasses get a short caption instead (full pixel push happens below, throttled).
        void this.showGlassesText(this.formatLevel1(objects, this.level1Text))
      }
      // HUD on: push the graphical bounding-box frame (throttled, serialized internally).
      if (this.hudEnabled) void this.pushHud(video, detections)
      this.level1Objects = objects

      // Escalation: a NEW object class or newly-read text triggers a rich Level-2
      // description, rate-capped, and only when the AI backend is reachable.
      const capOk = Date.now() - this.lastLevel2At >= ARVisionApp.LEVEL2_MIN_INTERVAL_MS
      const escalate = newObjects.length > 0 || this.textChanged
      this.textChanged = false
      if (escalate && capOk && this.aiConnected) {
        console.log(`Level 1 → Level 2 (objects: ${newObjects.join(', ') || '—'})`)
        // Fire-and-forget: the LLM call is slow (seconds), but Level 1 must keep ticking so the
        // live boxes stay fluid. runLevel2 grabs its frame up-front and guards against overlap.
        void this.runLevel2(true)
      }
    } finally {
      this.level1Busy = false
    }
  }

  /** Heavy OCR pass on a downscaled frame; updates level1Text and flags new text. */
  private async runOcr(video: HTMLVideoElement) {
    if (!this.textReader || this.ocrBusy) return
    this.ocrBusy = true
    this.lastOcrAt = Date.now()
    try {
      if (!this.ocrCanvas) this.ocrCanvas = document.createElement('canvas')
      const maxW = 960
      const scale = Math.min(1, maxW / video.videoWidth)
      this.ocrCanvas.width = Math.max(1, Math.round(video.videoWidth * scale))
      this.ocrCanvas.height = Math.max(1, Math.round(video.videoHeight * scale))
      const ctx = this.ocrCanvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(video, 0, 0, this.ocrCanvas.width, this.ocrCanvas.height)
      const text = (await readText(this.textReader, this.ocrCanvas)).slice(0, 80)
      this.considerOcrText(text)
    } catch (err) {
      console.warn('OCR failed:', err instanceof Error ? err.message : err)
    } finally {
      this.ocrBusy = false
    }
  }

  /** Accept OCR text only once it reads consistently across OCR_CONSISTENCY passes. */
  private considerOcrText(raw: string) {
    const norm = this.normalizeText(raw)
    if (norm.length < 3) { // empty / too short → noise, reset the streak
      this.ocrCandidate = ''
      this.ocrStreak = 0
      return
    }

    // Same (or near-same) as the running candidate → it's holding steady.
    if (this.ocrCandidate && this.textSimilarity(norm, this.normalizeText(this.ocrCandidate)) >= ARVisionApp.OCR_SIMILARITY) {
      this.ocrStreak++
    } else {
      this.ocrCandidate = raw
      this.ocrStreak = 1
    }

    // Consistent enough, and different from the text we already accepted → commit + escalate.
    if (this.ocrStreak >= ARVisionApp.OCR_CONSISTENCY &&
        this.textSimilarity(norm, this.normalizeText(this.level1Text)) < ARVisionApp.OCR_SIMILARITY) {
      this.level1Text = this.ocrCandidate
      this.textChanged = true // consumed by the next level1Tick
    }
  }

  private normalizeText(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
  }

  /** Similarity of two strings in 0..1 (1 = identical), via normalized Levenshtein distance. */
  private textSimilarity(a: string, b: string): number {
    if (!a && !b) return 1
    if (!a || !b) return 0
    const dist = this.levenshtein(a, b)
    return 1 - dist / Math.max(a.length, b.length)
  }

  private levenshtein(a: string, b: string): number {
    const m = a.length, n = b.length
    if (!m) return n
    if (!n) return m
    const dp: number[] = []
    for (let j = 0; j <= n; j++) dp[j] = j
    for (let i = 1; i <= m; i++) {
      let prev = dp[0]
      dp[0] = i
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j]
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
        prev = tmp
      }
    }
    return dp[n]
  }

  private displayLevel1(objects: Set<string>, text: string) {
    const el = document.querySelector<HTMLDivElement>('#level1Labels')
    if (!el) return
    const parts: string[] = []
    if (objects.size) parts.push([...objects].join(', '))
    if (text) parts.push(`“${text}”`)
    el.textContent = `Level 1: ${parts.join(' · ') || '(nothing detected)'}`
  }

  private formatLevel1(objects: Set<string>, text: string): string {
    let body = [...objects].slice(0, 8).join(', ') || 'scanning…'
    if (text) body += `\n\nText: ${text}`
    return `━ LIVE VIEW ━\n\n${body}`
  }

  private sameSet(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false
    for (const x of a) if (!b.has(x)) return false
    return true
  }

  /** Draw each detection's bounding box + label onto the overlay canvas above the live preview. */
  private drawDetections(video: HTMLVideoElement, detections: Detection[]) {
    const canvas = document.querySelector<HTMLCanvasElement>('#overlay')
    if (!canvas) return
    const w = video.videoWidth, h = video.videoHeight
    if (!w || !h) return
    // Match the canvas buffer to the video's native frame: both elements share the same
    // intrinsic aspect and object-fit:cover, so boxes land exactly over the cropped preview.
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w
      canvas.height = h
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)

    // Scale stroke + text to the frame so boxes read well at any camera resolution.
    const lineWidth = Math.max(2, Math.round(w / 320))
    const fontSize = Math.max(14, Math.round(w / 36))
    const pad = Math.round(fontSize * 0.25)
    ctx.lineWidth = lineWidth
    ctx.font = `${fontSize}px system-ui, sans-serif`
    ctx.textBaseline = 'top'

    for (const d of detections) {
      const { x, y, width, height } = d.box
      ctx.strokeStyle = '#00e5ff'
      ctx.strokeRect(x, y, width, height)

      const label = `${d.label} ${(d.score * 100) | 0}%`
      const tw = ctx.measureText(label).width
      const labelH = fontSize + pad * 2
      // Keep the label band inside the frame: drop it below the top edge if it would clip.
      const ly = y - labelH >= 0 ? y - labelH : y
      ctx.fillStyle = '#00e5ff'
      ctx.fillRect(x, ly, tw + pad * 2, labelH)
      ctx.fillStyle = '#001014'
      ctx.fillText(label, x + pad, ly + pad)
    }
  }

  // ── Positioned-label HUD: bordered text containers at each object ────────────
  // One bordered text container per stable detection, positioned & sized to its box (mapped
  // video → 576×288 display), holding the label. Text is cheap over BLE, so this is fast — a
  // whole page rebuilds in well under what four PNG tiles cost. Only rebuilt when the scene
  // changes (stable-set hysteresis), so a still object never re-sends.

  /** Toggle the HUD at runtime. */
  private async onHudToggle(enabled: boolean) {
    this.hudEnabled = enabled
    localStorage.setItem('hudEnabled', String(enabled))
    this.lastHudAt = 0
    this.lastDrawnDets = []
    if (!this.isStreaming) return
    if (!enabled) {
      // Back to the plain full-screen text page.
      await this.publishToGlasses(this.lastCaption || ' ')
    }
    // When enabling, the next level1Tick pushes the labels page (gate sees lastDrawnDets=[]).
  }

  /** Route the companion's words to the glasses. Non-HUD mode: a full-screen text page. HUD
   *  mode: update the caption strip IN PLACE (no rebuild) so it shows under the object labels. */
  private async showGlassesText(content: string) {
    this.lastCaption = content
    this.updateGlassesPreview(content)
    if (!this.hudEnabled) { await this.publishToGlasses(content); return }
    if (!this.isStreaming) return
    // The labels page owns the caption container; if it isn't up yet, push it once so the
    // container exists, then the in-place text update lands on it.
    if (!this.lastDrawnDets.length) await this.publishLabels()
    await this.relay.publish(RENDER_TOPIC, {
      op: 'text',
      upgrade: {
        containerID: ARVisionApp.HUD_CAPTION_ID,
        containerName: 'caption',
        content: content || ' ',
      },
    } satisfies RenderCommand)
  }

  /** A page of text containers: full-screen bg (captures input) + a bottom caption strip (the
   *  companion's remark) + one bordered box per object, positioned/sized to it on the display. */
  private labelsPage(dets: Array<Detection & { miss: number }>, vw: number, vh: number): PageSpec {
    const sx = ARVisionApp.HUD_W / vw, sy = ARVisionApp.HUD_H / vh
    const clamp = (v: number, lo: number, hi: number) => v < lo ? lo : v > hi ? hi : v

    const boxes = dets.slice(0, ARVisionApp.HUD_MAX_LABELS).map((d, i) => {
      const w = clamp(d.box.width * sx, ARVisionApp.HUD_LABEL_MIN_W, ARVisionApp.HUD_W)
      const h = clamp(d.box.height * sy, ARVisionApp.HUD_LABEL_MIN_H, ARVisionApp.HUD_H)
      const x = clamp(d.box.x * sx, 0, ARVisionApp.HUD_W - w)
      const y = clamp(d.box.y * sy, 0, ARVisionApp.HUD_H - h)
      return {
        xPosition: Math.round(x), yPosition: Math.round(y),
        width: Math.round(w), height: Math.round(h),
        borderWidth: 2, borderColor: 5, borderRadius: 4, paddingLength: 2,
        containerID: i + 3, containerName: `obj${i}`,
        content: d.label,
      }
    })

    return {
      containerTotalNum: 2 + boxes.length,
      textObject: [
        { // full-screen background: captures touch input, stays out of the way
          xPosition: 0, yPosition: 0, width: ARVisionApp.HUD_W, height: ARVisionApp.HUD_H,
          containerID: ARVisionApp.GLASSES_CONTAINER_ID, containerName: ARVisionApp.GLASSES_CONTAINER_NAME,
          content: ' ', isEventCapture: 1,
        },
        { // bottom caption strip: the companion's remark, always visible under the labels
          xPosition: 0, yPosition: ARVisionApp.HUD_H - ARVisionApp.HUD_CAPTION_H,
          width: ARVisionApp.HUD_W, height: ARVisionApp.HUD_CAPTION_H, paddingLength: 4,
          containerID: ARVisionApp.HUD_CAPTION_ID, containerName: 'caption',
          content: this.lastCaption || ' ',
        },
        ...boxes,
      ],
    }
  }

  /** Build + publish the labels page (with the current caption). No gating — callers decide. */
  private async publishLabels(): Promise<boolean> {
    const video = document.querySelector<HTMLVideoElement>('#cameraView')
    const vw = video?.videoWidth ?? 0, vh = video?.videoHeight ?? 0
    if (!vw || !vh) return false
    // Retain so a late-connecting terminal gets the current labels + caption too.
    const page = this.labelsPage(this.stableDets, vw, vh)
    const ok = await this.relay.publish(RENDER_TOPIC, { op: 'page', page } satisfies RenderCommand, true)
    if (ok) {
      this.lastDrawnDets = this.stableDets.map(d => ({ label: d.label, score: d.score, box: { ...d.box } }))
      this.lastHudSentAt = Date.now()
    } else {
      console.warn('HUD labels NOT delivered — relay rejected the publish.')
    }
    return ok
  }

  /** Rebuild the positioned-labels page when the stable scene changes (gated + throttled). */
  private async pushHud(video: HTMLVideoElement, detections: Detection[]) {
    if (!this.hudEnabled) return
    const labels = detections.map(d => d.label).join(',') || '—'
    // Watchdog: never let a hung send freeze the HUD forever.
    if (this.hudBusy) {
      if (Date.now() - this.lastHudAt > 10000) this.hudBusy = false
      else { this.setHudDebug(`busy | det:${labels}`); return }
    }
    const vw = video.videoWidth, vh = video.videoHeight
    if (!vw || !vh) { this.setHudDebug(`no video`); return }

    // The stable set is maintained once per tick (level1Tick). Gate on hysteresis vs. drawn.
    const stable = this.stableDets.map(d => d.label).join(',') || '—'
    const changed = this.sceneChanged(this.stableDets, vw, vh)
    const drawn = this.lastDrawnDets.map(d => d.label).join(',') || '—'
    const age = ((Date.now() - this.lastHudSentAt) / 1000) | 0
    this.setHudDebug(`det:${labels} | stable:${stable} | drawn:${drawn} | ${changed ? 'CHANGED' : 'same'} | ${age}s`)
    if (!changed) return
    if (Date.now() - this.lastHudAt < this.hudIntervalMs) return // rate floor for real changes

    this.hudBusy = true
    this.lastHudAt = Date.now()
    try {
      await this.publishLabels()
    } finally {
      this.hudBusy = false
    }
  }

  /** Fold this frame's raw detections into the flicker-debounced stable set:
   *  - a stable box only MOVES when it shifts past the threshold (spatial hysteresis);
   *  - an object only LEAVES after HUD_MISS_GRACE consecutive misses (temporal hysteresis);
   *  - a genuinely new object is added immediately. */
  private updateStableDets(curr: Detection[], vw: number, vh: number) {
    const sx = ARVisionApp.HUD_W / vw, sy = ARVisionApp.HUD_H / vh
    const tol = this.hudPosQuant                 // movement threshold, HUD px
    const matchDist = Math.max(tol * 3, ARVisionApp.HUD_W * 0.2) // "same object" radius, HUD px
    const used = new Array(curr.length).fill(false)
    const cx = (b: Detection['box']) => (b.x + b.width / 2) * sx
    const cy = (b: Detection['box']) => (b.y + b.height / 2) * sy

    for (const s of this.stableDets) {
      // Match to the nearest unused current detection of the same class.
      let best = -1, bestD = Infinity
      for (let i = 0; i < curr.length; i++) {
        if (used[i] || curr[i].label !== s.label) continue
        const d = Math.hypot(cx(curr[i].box) - cx(s.box), cy(curr[i].box) - cy(s.box))
        if (d < bestD) { bestD = d; best = i }
      }
      if (best >= 0 && bestD <= matchDist) {
        used[best] = true
        s.miss = 0
        const b = curr[best].box
        const moved = Math.abs((b.x - s.box.x) * sx) > tol || Math.abs((b.y - s.box.y) * sy) > tol ||
          Math.abs((b.width - s.box.width) * sx) > tol || Math.abs((b.height - s.box.height) * sy) > tol
        if (moved) s.box = { ...b } // only then do we let the drawn box follow the object
      } else {
        s.miss++
      }
    }
    // Drop objects gone for too long; add brand-new ones.
    this.stableDets = this.stableDets.filter(s => s.miss <= ARVisionApp.HUD_MISS_GRACE)
    for (let i = 0; i < curr.length; i++) {
      if (!used[i]) this.stableDets.push({ ...curr[i], box: { ...curr[i].box }, miss: 0 })
    }
  }

  /** Hysteresis gate: true if the scene meaningfully differs from what's drawn on the glasses
   *  — a class appeared/left, or some box moved/resized more than hudPosQuant (in HUD px) from
   *  its last-drawn position. Comparing against the last DRAWN boxes (not a global grid) means
   *  sub-threshold jitter never flips the gate, so a still object never triggers a redraw. */
  private sceneChanged(curr: Detection[], vw: number, vh: number): boolean {
    const prev = this.lastDrawnDets
    if (prev.length !== curr.length) return true
    const sx = ARVisionApp.HUD_W / vw, sy = ARVisionApp.HUD_H / vh
    const tol = this.hudPosQuant

    // Group boxes by class (HUD coords), each group sorted, so we compare like-for-like
    // regardless of the order the detector returns them in.
    const group = (arr: Detection[]) => {
      const m = new Map<string, number[][]>()
      for (const d of arr) {
        const g = m.get(d.label) ?? []
        g.push([d.box.x * sx, d.box.y * sy, d.box.width * sx, d.box.height * sy])
        m.set(d.label, g)
      }
      for (const g of m.values()) g.sort((a, b) => a[0] - b[0] || a[1] - b[1])
      return m
    }
    const pm = group(prev), cm = group(curr)
    if (pm.size !== cm.size) return true
    for (const [label, cg] of cm) {
      const pg = pm.get(label)
      if (!pg || pg.length !== cg.length) return true
      for (let i = 0; i < cg.length; i++) {
        for (let k = 0; k < 4; k++) {
          if (Math.abs(cg[i][k] - pg[i][k]) > tol) return true
        }
      }
    }
    return false
  }

  // ── Level 2: rich description from the vision-LLM ───────────────────────────
  private async runLevel2(force = false) {
    if (!this.canvasElement || !this.isStreaming) return
    // Skip if a previous analysis is still in flight (frames may arrive faster than the AI responds).
    if (this.isAnalyzing) return

    const ctx = this.canvasElement.getContext('2d')
    if (!ctx) return

    // Pick the current source (live video or captured photo) and its native size.
    let source: CanvasImageSource
    let sw: number
    let sh: number
    if (this.mediaStream && !this.usingFallbackCamera) {
      const video = document.querySelector<HTMLVideoElement>('#cameraView')!
      if (!video.videoWidth) return
      source = video
      sw = video.videoWidth
      sh = video.videoHeight
    } else {
      const img = document.querySelector<HTMLImageElement>('#capturedImg')!
      if (!img.src || img.style.display === 'none') return
      source = img
      sw = img.naturalWidth || 640
      sh = img.naturalHeight || 480
    }

    // Downscale: cap the longest side so we send a small image to the model.
    const scale = Math.min(1, ARVisionApp.ANALYSIS_MAX_DIM / Math.max(sw, sh))
    const w = Math.max(1, Math.round(sw * scale))
    const h = Math.max(1, Math.round(sh * scale))
    this.canvasElement.width = w
    this.canvasElement.height = h
    ctx.drawImage(source, 0, 0, w, h)

    // Frame-diff gating (used when the call isn't forced, e.g. the no-detector fallback):
    // skip the model when the view hasn't meaningfully changed.
    const signature = this.frameSignature()
    if (!force && signature && this.lastFrameSignature) {
      const diff = this.signatureDiff(signature, this.lastFrameSignature)
      if (diff < ARVisionApp.DIFF_THRESHOLD) {
        console.log(`Scene unchanged (Δ=${diff.toFixed(3)}) — skipping Level 2`)
        return
      }
    }
    if (signature) this.lastFrameSignature = signature

    this.isAnalyzing = true
    this.lastLevel2At = Date.now()
    try {
      const imageData = this.canvasElement.toDataURL('image/jpeg', 0.8)
      const analysis = await this.performImageAnalysis(imageData)
      this.displayResults(analysis)
      await this.sendToGlasses(analysis)
      this.updateStatus(`✅ ${analysis.scene} (${analysis.confidence.toFixed(0)}%)`)
    } finally {
      this.isAnalyzing = false
    }
  }

  /** Cheap NxN grayscale fingerprint of the current analysis canvas, for change detection. */
  private frameSignature(): Uint8ClampedArray | null {
    if (!this.canvasElement) return null
    const n = ARVisionApp.DIFF_GRID
    if (!this.diffCanvas) {
      this.diffCanvas = document.createElement('canvas')
      this.diffCanvas.width = n
      this.diffCanvas.height = n
    }
    const dctx = this.diffCanvas.getContext('2d', { willReadFrequently: true })
    if (!dctx) return null
    dctx.drawImage(this.canvasElement, 0, 0, n, n)
    const { data } = dctx.getImageData(0, 0, n, n)
    const sig = new Uint8ClampedArray(n * n)
    for (let i = 0; i < n * n; i++) {
      const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2]
      sig[i] = (r * 0.299 + g * 0.587 + b * 0.114) | 0
    }
    return sig
  }

  /** Mean absolute per-cell difference of two signatures, normalised to 0..1. */
  private signatureDiff(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
    let sum = 0
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
    return sum / (a.length * 255)
  }

  private async analyzeScene() {
    if (!this.isStreaming) {
      this.updateStatus('⚠️ Start the camera first.')
      return
    }
    // Live mode: grab the current frame immediately. Fallback: trigger a new photo.
    if (this.usingFallbackCamera) {
      document.querySelector<HTMLInputElement>('#cameraInput')!.click()
    } else {
      this.updateStatus('📸 Analyzing...')
      await this.runLevel2(true) // forced: bypass the change-detection gate
    }
  }

  private async performImageAnalysis(imageData: string): Promise<ARAnalysis> {
    try {
      // Call LM Studio API (OpenAI-compatible)
      const headers: { [key: string]: string } = {
        'Content-Type': 'application/json',
      }

      if (this.lmStudioConfig.useApiKey && this.lmStudioConfig.apiKey) {
        headers['Authorization'] = `Bearer ${this.lmStudioConfig.apiKey}`
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(`LLM request timed out after ${ARVisionApp.LLM_REQUEST_TIMEOUT_MS}ms`),
        ARVisionApp.LLM_REQUEST_TIMEOUT_MS,
      )

      try {
        const view = this.buildVisionContext()
        const systemContent = ARVisionApp.COMPANION_SYSTEM_PROMPT +
          (view ? `\n\nCurrent view — ${view}.` : '') +
          "\n\nRight now you are glancing at the scene on your own — the user has NOT asked anything. " +
          "Offer one short, natural remark about what you see (useful or interesting), as a companion would."
        const response = await fetch(`${this.lmStudioConfig.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: this.lmStudioConfig.model,
            messages: [
              { role: 'system', content: systemContent },
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'Look at my current view and reply ONLY with JSON: {"say": "<your one short companion remark, in my language>", "scene": "<2-3 word setting>", "objects": ["<up to 5 notable things>"]}'
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url: imageData
                    }
                  }
                ]
              }
            ],
            max_tokens: this.lmStudioConfig.maxTokens,
            temperature: this.lmStudioConfig.temperature
          })
        })

        clearTimeout(timeoutId)

        if (!response.ok) {
          throw new Error(`LM Studio API error: ${response.status}`)
        }

        const data = await response.json()
        const content = data.choices[0].message.content

        this.updateAiBadge(true)

        // Parse the AI response. If it didn't return JSON, treat the whole reply as the remark.
        const jsonMatch = content.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0])
          return {
            scene: parsed.scene || 'unknown',
            objects: parsed.objects || [],
            confidence: 1,
            say: (parsed.say || '').trim() || String(content).trim(),
          }
        }
        return { scene: 'unknown', objects: [], confidence: 1, say: String(content).trim() }
      } catch (e: any) {
        clearTimeout(timeoutId)
        throw e
      }
    } catch (error) {
      console.warn('AI service not available:', error instanceof Error ? error.message : error)
      this.updateAiBadge(false)
      // Return fallback without AI - camera still works
      return {
        objects: [],
        scene: 'AI offline',
        confidence: 0,
        say: '',
      }
    }
  }

  private displayResults(analysis: ARAnalysis) {
    const resultsDiv = document.querySelector<HTMLDivElement>('#results')!

    if (!this.aiConnected && analysis.confidence === 0) {
      resultsDiv.innerHTML = `
        <div class="result-item result-offline">
          <strong>Camera active</strong>
          <p>AI service not connected. Camera and preview work independently.</p>
          <p>Configure LM Studio in the settings above to enable scene analysis.</p>
        </div>
      `
      return
    }

    resultsDiv.innerHTML = `
      ${analysis.say ? `<div class="result-item"><strong>Companion:</strong> ${this.escapeHtml(analysis.say)}</div>` : ''}
      <div class="result-item">
        <strong>Scene:</strong> ${this.escapeHtml(analysis.scene)}
      </div>
      <div class="result-item">
        <strong>Objects detected:</strong>
        <ul>
          ${analysis.objects.map(obj => `<li>${this.escapeHtml(obj)}</li>`).join('')}
        </ul>
      </div>
    `
  }

  private async sendToGlasses(analysis: ARAnalysis) {
    // Don't push to glasses if AI is offline (nothing meaningful to show)
    if (!this.aiConnected && analysis.confidence === 0) {
      return
    }
    await this.showGlassesText(this.formatForGlasses(analysis))
  }

  private formatForGlasses(analysis: ARAnalysis): string {
    // The companion's own words read best on the tiny display; fall back to the scene/objects
    // if the model gave no remark.
    if (analysis.say) return analysis.say
    const objs = analysis.objects.slice(0, 4).join(', ')
    return objs ? `${analysis.scene} — ${objs}` : analysis.scene
  }

  private updateGlassesPreview(content: string) {
    const preview = document.querySelector<HTMLDivElement>('#glassesDisplay')!
    preview.innerHTML = `<pre>${this.escapeHtml(content)}</pre>`
  }

  /** Live one-line HUD diagnostics (what the detector sees vs. what's drawn, gate, send age). */
  private setHudDebug(text: string) {
    const el = document.querySelector<HTMLDivElement>('#hudDebug')
    if (el) el.textContent = text
  }

  private updateStatus(message: string) {
    const statusElement = document.querySelector<HTMLParagraphElement>('#status')!
    statusElement.textContent = message
    statusElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }

  private saveConfig() {
    const ip = document.querySelector<HTMLInputElement>('#lmStudioIp')!.value
    const port = document.querySelector<HTMLInputElement>('#lmStudioPort')!.value
    const model = document.querySelector<HTMLInputElement>('#lmStudioModel')!.value
    const useApiKey = document.querySelector<HTMLInputElement>('#useApiKey')!.checked
    const apiKey = document.querySelector<HTMLInputElement>('#apiKey')!.value

    this.lmStudioConfig = {
      baseUrl: `http://${ip}:${port}/v1`,
      model: model,
      maxTokens: 500,
      temperature: 0.7,
      useApiKey: useApiKey,
      apiKey: useApiKey ? apiKey : undefined
    }

    localStorage.setItem('lmStudioConfig', JSON.stringify(this.lmStudioConfig))

    const asrUrl = document.querySelector<HTMLInputElement>('#asrUrl')!.value.trim()
    if (asrUrl) { this.asrUrl = asrUrl; localStorage.setItem('asrUrl', asrUrl) }
    const asrModel = document.querySelector<HTMLInputElement>('#asrModel')!.value.trim()
    if (asrModel) { this.asrModel = asrModel; localStorage.setItem('asrModel', asrModel) }

    const relayUrl = document.querySelector<HTMLInputElement>('#relayUrl')!.value.trim()
    if (relayUrl && relayUrl !== this.relayUrl) {
      this.relayUrl = relayUrl
      localStorage.setItem('relayUrl', relayUrl)
      this.initializeRelay() // reconnect against the new relay
    }

    this.updateStatus('Configuration saved.')
    this.testAiConnection()
  }

  private loadConfig() {
    const savedRelay = localStorage.getItem('relayUrl')
    if (savedRelay) {
      this.relayUrl = savedRelay
      document.querySelector<HTMLInputElement>('#relayUrl')!.value = savedRelay
    }

    this.hudEnabled = localStorage.getItem('hudEnabled') === 'true'
    document.querySelector<HTMLInputElement>('#hudToggle')!.checked = this.hudEnabled

    const savedInterval = localStorage.getItem('hudIntervalMs')
    if (savedInterval) this.hudIntervalMs = Number(savedInterval)
    document.querySelector<HTMLInputElement>('#hudInterval')!.value = String(this.hudIntervalMs)
    document.querySelector<HTMLElement>('#hudIntervalVal')!.textContent = String(this.hudIntervalMs)
    const savedQuant = localStorage.getItem('hudPosQuant')
    if (savedQuant) this.hudPosQuant = Number(savedQuant)
    document.querySelector<HTMLInputElement>('#hudQuant')!.value = String(this.hudPosQuant)
    document.querySelector<HTMLElement>('#hudQuantVal')!.textContent = String(this.hudPosQuant)

    const savedAsr = localStorage.getItem('asrUrl')
    if (savedAsr) this.asrUrl = savedAsr
    document.querySelector<HTMLInputElement>('#asrUrl')!.value = this.asrUrl
    const savedAsrModel = localStorage.getItem('asrModel')
    if (savedAsrModel) this.asrModel = savedAsrModel
    document.querySelector<HTMLInputElement>('#asrModel')!.value = this.asrModel

    const saved = localStorage.getItem('lmStudioConfig')
    if (saved) {
      try {
        const config = JSON.parse(saved)
        this.lmStudioConfig = config

        // Update UI
        const url = new URL(config.baseUrl)
        document.querySelector<HTMLInputElement>('#lmStudioIp')!.value = url.hostname
        document.querySelector<HTMLInputElement>('#lmStudioPort')!.value = url.port || '1234'
        document.querySelector<HTMLInputElement>('#lmStudioModel')!.value = config.model
        document.querySelector<HTMLInputElement>('#useApiKey')!.checked = config.useApiKey || false
        document.querySelector<HTMLInputElement>('#apiKey')!.value = config.apiKey || ''

        this.updateStatus('Configuration loaded from storage.')
      } catch (error) {
        console.error('Error loading config:', error)
      }
    }
  }

  private initializeLogging() {
    // Intercept console methods
    const originalLog = console.log.bind(console)
    const originalWarn = console.warn.bind(console)
    const originalError = console.error.bind(console)

    console.log = (...args: any[]) => {
      originalLog(...args)
      this.addLog('info', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '))
    }

    console.warn = (...args: any[]) => {
      originalWarn(...args)
      this.addLog('warn', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '))
    }

    console.error = (...args: any[]) => {
      originalError(...args)
      this.addLog('error', args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '))
    }

    // Wire up UI controls
    document.querySelector<HTMLSelectElement>('#logFilter')!.addEventListener('change', (e) => {
      this.logFilter = (e.target as HTMLSelectElement).value as any
      this.renderLogs()
    })

    document.querySelector<HTMLButtonElement>('#clearLogs')!.addEventListener('click', () => {
      this.logs = []
      this.renderLogs()
    })

    this.addLog('info', 'Logging system initialized')
  }

  private addLog(level: LogEntry['level'], message: string) {
    this.logs.push({ level, message, timestamp: new Date() })

    // Keep max 500 entries
    if (this.logs.length > 500) {
      this.logs = this.logs.slice(-500)
    }

    // Only re-render if the filter matches
    if (this.logFilter === 'all' || this.logFilter === level) {
      this.renderLogs()
    }
  }

  private renderLogs() {
    const container = document.querySelector<HTMLDivElement>('#logContainer')!
    const filtered = this.logFilter === 'all'
      ? this.logs
      : this.logs.filter(l => l.level === this.logFilter)

    if (filtered.length === 0) {
      container.innerHTML = '<p class="log-empty">No logs yet...</p>'
      return
    }

    container.innerHTML = filtered.map(entry => {
      const time = entry.timestamp.toLocaleTimeString()
      return `<div class="log-entry log-${entry.level}">
        <span class="log-time">${time}</span>
        <span class="log-level">${entry.level.toUpperCase()}</span>
        <span class="log-message">${this.escapeHtml(entry.message)}</span>
      </div>`
    }).join('')

    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight
  }

  private escapeHtml(text: string): string {
    const div = document.createElement('div')
    div.textContent = text
    return div.innerHTML
  }

  private updateAiBadge(connected: boolean) {
    this.aiConnected = connected
    const badge = document.querySelector<HTMLDivElement>('#aiBadge')!
    badge.textContent = connected ? 'AI: connected' : 'AI: disconnected'
    badge.className = `ai-badge ${connected ? 'ai-connected' : 'ai-disconnected'}`
  }

  private async testAiConnection() {
    try {
      const headers: { [key: string]: string } = {}
      if (this.lmStudioConfig.useApiKey && this.lmStudioConfig.apiKey) {
        headers['Authorization'] = `Bearer ${this.lmStudioConfig.apiKey}`
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 3000)

      const response = await fetch(`${this.lmStudioConfig.baseUrl}/models`, {
        headers,
        signal: controller.signal
      })

      clearTimeout(timeoutId)
      this.updateAiBadge(response.ok)
      if (response.ok) {
        console.log('AI service connected successfully')
      } else {
        console.warn('AI service responded with status:', response.status)
      }
    } catch {
      this.updateAiBadge(false)
      console.log('AI service not reachable - camera works independently')
    }
  }

  // ── Voice chat: glasses mic → relay (PCM) → local Whisper (ASR) → LLM ────────────

  /** Open the glasses mic and start buffering the PCM the terminal forwards up. */
  private async startGlassesAudio() {
    if (this.isListening) return
    if (!this.relay) {
      this.updateVoiceStatus('Relay not connected — cannot reach the glasses.')
      return
    }
    this.audioChunks = []
    this.audioBytes = 0
    this.isListening = true
    this.setVoiceButtons(true)

    // Buffer every PCM chunk the terminal publishes while we're listening.
    this.audioUnsub = this.relay.subscribe<AudioMessage>(AUDIO_TOPIC, (msg) => this.onAudioChunk(msg))
    // audioControl requires a created page first (SDK prerequisite); the render queue keeps order.
    await this.showGlassesText('🎤 Listening…')
    // Tell the terminal to switch the glasses mic on (transient — not retained).
    await this.relay.publish(RENDER_TOPIC, { op: 'mic', on: true } satisfies RenderCommand)
    this.updateVoiceStatus('🎤 Listening… speak, then press Stop Voice.')
  }

  /** Close the mic, assemble the PCM into a WAV, transcribe it, and chat the result. */
  private async stopGlassesAudio() {
    if (!this.isListening) return
    this.isListening = false
    this.setVoiceButtons(false)

    this.audioUnsub?.()
    this.audioUnsub = null
    if (this.relay) {
      await this.relay.publish(RENDER_TOPIC, { op: 'mic', on: false } satisfies RenderCommand)
    }

    if (this.audioBytes < ARVisionApp.MIC_MIN_BYTES) {
      this.updateVoiceStatus(`No speech captured (${this.audioBytes} bytes). Is the glasses mic working?`)
      return
    }

    const pcm = this.concatChunks(this.audioChunks, this.audioBytes)
    this.audioChunks = []
    const wav = this.pcmToWav(pcm, ARVisionApp.MIC_SAMPLE_RATE)
    this.updateVoiceStatus(`📝 Transcribing ${(pcm.length / 1024).toFixed(0)} KB of audio…`)

    try {
      const text = await this.transcribe(wav)
      if (!text) {
        this.updateVoiceStatus('Transcription was empty — try speaking longer/louder.')
        return
      }
      this.updateVoiceStatus(`You said: “${text}”`)
      this.addChatMessage('user', text)
      await this.sendToAI()
    } catch (err) {
      console.error('Transcription failed:', err instanceof Error ? err.message : err)
      this.updateVoiceStatus('Transcription failed — check the Whisper (ASR) URL.')
    }
  }

  private onAudioChunk(msg: AudioMessage) {
    if (!this.isListening || !msg?.pcm) return
    const bytes = this.base64ToBytes(msg.pcm)
    if (bytes.length === 0) return
    this.audioChunks.push(bytes)
    this.audioBytes += bytes.length
  }

  private setVoiceButtons(listening: boolean) {
    document.querySelector<HTMLButtonElement>('#startVoice')!.disabled = listening
    document.querySelector<HTMLButtonElement>('#stopVoice')!.disabled = !listening
  }

  /** POST the WAV to a local Whisper server (OpenAI /v1/audio/transcriptions). Returns the text. */
  private async transcribe(wav: Uint8Array): Promise<string> {
    const form = new FormData()
    form.append('file', new Blob([wav.buffer as ArrayBuffer], { type: 'audio/wav' }), 'speech.wav')
    form.append('model', this.asrModel)
    form.append('response_format', 'json')

    const controller = new AbortController()
    const timeoutId = setTimeout(
      () => controller.abort(`ASR request timed out after ${ARVisionApp.LLM_REQUEST_TIMEOUT_MS}ms`),
      ARVisionApp.LLM_REQUEST_TIMEOUT_MS,
    )
    try {
      const res = await fetch(this.asrUrl, { method: 'POST', body: form, signal: controller.signal })
      if (!res.ok) throw new Error(`ASR HTTP ${res.status}`)
      const data = await res.json()
      return (data.text || '').trim()
    } finally {
      clearTimeout(timeoutId)
    }
  }

  private base64ToBytes(b64: string): Uint8Array {
    try {
      const bin = atob(b64)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
      return out
    } catch {
      return new Uint8Array(0)
    }
  }

  private concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
    const out = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) { out.set(c, offset); offset += c.length }
    return out
  }

  /** Wrap raw signed-16-bit-LE mono PCM in a minimal WAV container. */
  private pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
    const numChannels = 1
    const bitsPerSample = 16
    const blockAlign = (numChannels * bitsPerSample) >> 3
    const byteRate = sampleRate * blockAlign
    const buffer = new ArrayBuffer(44 + pcm.length)
    const view = new DataView(buffer)
    const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }

    writeStr(0, 'RIFF')
    view.setUint32(4, 36 + pcm.length, true)
    writeStr(8, 'WAVE')
    writeStr(12, 'fmt ')
    view.setUint32(16, 16, true)        // PCM fmt chunk size
    view.setUint16(20, 1, true)         // audio format = PCM
    view.setUint16(22, numChannels, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, byteRate, true)
    view.setUint16(32, blockAlign, true)
    view.setUint16(34, bitsPerSample, true)
    writeStr(36, 'data')
    view.setUint32(40, pcm.length, true)
    new Uint8Array(buffer, 44).set(pcm)
    return new Uint8Array(buffer)
  }

  private async sendTextMessage() {
    const input = document.querySelector<HTMLInputElement>('#textInput')!
    const text = input.value.trim()
    if (!text) return

    input.value = ''
    this.addChatMessage('user', text)
    await this.sendToAI()
  }

  private addChatMessage(role: string, content: string) {
    this.chatHistory.push({ role, content })
    this.updateChatDisplay()
  }

  private updateChatDisplay() {
    const chatDiv = document.querySelector<HTMLDivElement>('#chatHistory')!
    if (this.chatHistory.length === 0) {
      chatDiv.innerHTML = '<p class="chat-placeholder">Chat history will appear here...</p>'
      return
    }

    chatDiv.innerHTML = this.chatHistory.map(msg => `
      <div class="chat-message ${msg.role === 'user' ? 'user' : 'assistant'}">
        <strong>${msg.role === 'user' ? 'You' : 'AI'}:</strong>
        <span>${this.escapeHtml(msg.content)}</span>
      </div>
    `).join('')

    chatDiv.scrollTop = chatDiv.scrollHeight
  }

  private updateVoiceStatus(message: string) {
    const statusElement = document.querySelector<HTMLParagraphElement>('#voiceStatus')!
    statusElement.textContent = message
  }

  /** A short textual summary of what the glasses currently perceive, for the companion's context. */
  private buildVisionContext(): string {
    const objs = [...new Set(this.stableDets.map(d => d.label))]
    const parts: string[] = []
    if (objs.length) parts.push(`objects in view: ${objs.join(', ')}`)
    if (this.level1Text) parts.push(`readable text: "${this.level1Text}"`)
    return parts.join('; ')
  }

  /** Downscaled JPEG data URL of the current frame (live video or captured photo), or null. */
  private captureFrameDataUrl(): string | null {
    if (!this.canvasElement || !this.isStreaming) return null
    const ctx = this.canvasElement.getContext('2d')
    if (!ctx) return null
    let source: CanvasImageSource, sw: number, sh: number
    if (this.mediaStream && !this.usingFallbackCamera) {
      const video = document.querySelector<HTMLVideoElement>('#cameraView')!
      if (!video.videoWidth) return null
      source = video; sw = video.videoWidth; sh = video.videoHeight
    } else {
      const img = document.querySelector<HTMLImageElement>('#capturedImg')!
      if (!img.src || img.style.display === 'none') return null
      source = img; sw = img.naturalWidth || 640; sh = img.naturalHeight || 480
    }
    const scale = Math.min(1, ARVisionApp.ANALYSIS_MAX_DIM / Math.max(sw, sh))
    const w = Math.max(1, Math.round(sw * scale)), h = Math.max(1, Math.round(sh * scale))
    this.canvasElement.width = w; this.canvasElement.height = h
    ctx.drawImage(source, 0, 0, w, h)
    return this.canvasElement.toDataURL('image/jpeg', 0.7)
  }

  private async sendToAI() {
    this.updateVoiceStatus('Sending to AI...')

    try {
      const headers: { [key: string]: string } = {
        'Content-Type': 'application/json',
      }

      if (this.lmStudioConfig.useApiKey && this.lmStudioConfig.apiKey) {
        headers['Authorization'] = `Bearer ${this.lmStudioConfig.apiKey}`
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(`LLM request timed out after ${ARVisionApp.LLM_REQUEST_TIMEOUT_MS}ms`),
        ARVisionApp.LLM_REQUEST_TIMEOUT_MS,
      )

      // Companion framing: persona + what's currently in view. The user message is already the
      // last entry in chatHistory (addChatMessage runs before this), so don't append it again.
      const view = this.buildVisionContext()
      const systemContent = ARVisionApp.COMPANION_SYSTEM_PROMPT +
        (view ? `\n\nCurrent view — ${view}.` : '\n\nThe camera is not active right now.')

      const history: Array<{ role: string; content: unknown }> = [...this.chatHistory]
      // Attach the current frame to the latest user turn so a vision model actually sees it.
      const frame = this.captureFrameDataUrl()
      const last = history[history.length - 1]
      if (frame && last && last.role === 'user' && typeof last.content === 'string') {
        history[history.length - 1] = {
          role: 'user',
          content: [
            { type: 'text', text: last.content },
            { type: 'image_url', image_url: { url: frame } },
          ],
        }
      }

      try {
        const response = await fetch(`${this.lmStudioConfig.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: this.lmStudioConfig.model,
            messages: [
              { role: 'system', content: systemContent },
              ...history,
            ],
            max_tokens: this.lmStudioConfig.maxTokens,
            temperature: this.lmStudioConfig.temperature
          })
        })

        clearTimeout(timeoutId)

      if (!response.ok) {
        throw new Error(`AI API error: ${response.status}`)
      }

      const data = await response.json()
        const aiResponse = data.choices[0].message.content

        this.addChatMessage('assistant', aiResponse)
        this.updateVoiceStatus('Response received')

        // Also show the response on the glasses terminal.
        await this.showGlassesText(`AI: ${aiResponse.substring(0, 200)}`)
      } catch (e: any) {
        clearTimeout(timeoutId)
        throw e
      }
    } catch (error) {
      console.error('Error sending to AI:', error)
      this.updateVoiceStatus('Error communicating with AI')
      this.addChatMessage('assistant', 'Sorry, I encountered an error. Please try again.')
    }
  }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  new ARVisionApp()
})
