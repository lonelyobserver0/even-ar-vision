// Generic glasses terminal — the .ehpk entrypoint.
//
// Thin proxy: it owns the Even SDK bridge, applies render commands coming DOWN from the
// brain app, and forwards glasses input events UP. All real logic (camera, AI, preview)
// lives in the brain app — NOT here. The only on-device UI is a tiny diagnostic panel:
// relay status, an editable relay URL, and a console of what the terminal is doing.

import './style.css'
import {
  waitForEvenAppBridge,
  EvenAppBridge,
  OsEventTypeList,
  StartUpPageCreateResult,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerUpgrade,
  ImageRawDataUpdate,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { RelayClient } from './relay'
import {
  RENDER_TOPIC,
  INPUT_TOPIC,
  AUDIO_TOPIC,
  type RenderCommand,
  type InputMessage,
  type AudioMessage,
  type PageSpec,
} from './protocol'

// Build-time default; overridden at runtime by the on-device field (persisted in localStorage).
const DEFAULT_RELAY = (import.meta.env.VITE_RELAY_URL as string | undefined) || 'http://localhost:8787'

class GlassesTerminal {
  private bridge: EvenAppBridge | null = null
  private relayUrl = localStorage.getItem('relayUrl') || DEFAULT_RELAY
  private relay!: RelayClient
  private pageReady = false
  private lastTextContainerId: number | null = null
  private logLines: string[] = []
  // Last render received before the bridge was ready (the 'render' topic is retained, so it
  // arrives immediately on subscribe — often before waitForEvenAppBridge resolves). Without
  // this we'd drop it and the glasses would stay blank until the brain happens to republish.
  private pendingRender: RenderCommand | null = null
  // Render commands must be applied strictly in order: e.g. a 'mic' (audioControl) requires the
  // page to exist first, and the SDK calls aren't safe to interleave. Chain them on one promise.
  private renderQueue: Promise<void> = Promise.resolve()

  async start() {
    this.buildUI()
    // Connect the relay first so the panel works even before/without the glasses bridge.
    this.connectRelay()
    this.bridge = await waitForEvenAppBridge()
    this.log('Glasses bridge ready')
    this.forwardInput()
    // Flush any render that arrived (retained) before the bridge existed.
    if (this.pendingRender) {
      const cmd = this.pendingRender
      this.pendingRender = null
      this.log(`render (deferred) ← ${this.describe(cmd)}`)
      this.enqueueRender(cmd)
    }
  }

  /** Apply render commands one at a time, preserving order (page must precede mic, etc.). */
  private enqueueRender(cmd: RenderCommand) {
    this.renderQueue = this.renderQueue
      .then(() => this.applyRender(cmd))
      .catch(err => this.log(`render error: ${err instanceof Error ? err.message : err}`))
  }

  // ── On-device diagnostic panel ──────────────────────────────────────────────
  private buildUI() {
    const root = document.querySelector<HTMLDivElement>('#terminal-root')!
    root.innerHTML = `
      <div class="ar-container">
        <h1>AR Vision — Terminal</h1>
        <p>Headless glasses renderer · diagnostic panel</p>

        <div class="config-item">
          <label>Relay status:</label>
          <span id="relayStatus" class="relay-badge relay-down">○ disconnected</span>
        </div>
        <div class="config-item">
          <label for="relayUrl">Relay URL:</label>
          <input type="text" id="relayUrl" placeholder="http://host:8787">
        </div>
        <button id="saveRelay" class="btn btn-secondary">Save</button>

        <h3>Terminal</h3>
        <div id="termLog" class="log-container"><p class="log-empty">Waiting…</p></div>
      </div>
    `
    document.querySelector<HTMLInputElement>('#relayUrl')!.value = this.relayUrl
    document.querySelector<HTMLButtonElement>('#saveRelay')!.addEventListener('click', () => this.saveRelay())
  }

  private saveRelay() {
    const value = document.querySelector<HTMLInputElement>('#relayUrl')!.value.trim()
    if (!value) return
    this.relayUrl = value
    localStorage.setItem('relayUrl', value)
    this.log(`Relay URL set to ${value}`)
    this.connectRelay() // reconnect against the new relay (no rebuild needed)
  }

  private setStatus(connected: boolean) {
    const badge = document.querySelector<HTMLSpanElement>('#relayStatus')
    if (!badge) return
    badge.textContent = `${connected ? '●' : '○'} ${connected ? 'connected' : 'disconnected'} — ${this.relayUrl}`
    badge.className = `relay-badge ${connected ? 'relay-up' : 'relay-down'}`
  }

  private log(line: string) {
    const time = new Date().toLocaleTimeString()
    this.logLines.push(`${time}  ${line}`)
    if (this.logLines.length > 80) this.logLines = this.logLines.slice(-80)
    const el = document.querySelector<HTMLDivElement>('#termLog')
    if (!el) return
    el.innerHTML = this.logLines
      .map(l => `<div class="log-entry"><span class="log-message">${this.escape(l)}</span></div>`)
      .join('')
    el.scrollTop = el.scrollHeight
  }

  private escape(text: string): string {
    const d = document.createElement('div')
    d.textContent = text
    return d.innerHTML
  }

  // ── Relay ───────────────────────────────────────────────────────────────────
  private connectRelay() {
    this.relay?.closeAll()
    this.relay = new RelayClient(this.relayUrl)
    this.setStatus(false)
    this.relay.subscribe<RenderCommand>(
      RENDER_TOPIC,
      (cmd) => {
        this.log(`render ← ${this.describe(cmd)}`)
        this.enqueueRender(cmd)
      },
      (connected) => this.setStatus(connected),
    )
    void this.relay.publish(INPUT_TOPIC, { kind: 'hello' } satisfies InputMessage)
  }

  private describe(cmd: RenderCommand): string {
    switch (cmd.op) {
      case 'page': {
        const text = cmd.page.textObject?.[0]?.content ?? ''
        return `page "${text.replace(/\n/g, ' ').slice(0, 40)}"`
      }
      case 'text': return `text "${(cmd.upgrade.content ?? '').replace(/\n/g, ' ').slice(0, 40)}"`
      case 'image': return 'image'
      case 'exit': return `exit(${cmd.exitMode ?? 1})`
      case 'mic': return `mic(${cmd.on ? 'on' : 'off'})`
    }
  }

  // ── Render proxy (brain → glasses) ──────────────────────────────────────────
  private async applyRender(cmd: RenderCommand) {
    if (!this.bridge) {
      // Bridge not ready yet: remember the latest command and apply it once it is.
      this.pendingRender = cmd
      return
    }
    try {
      switch (cmd.op) {
        case 'page':
          await this.applyPage(cmd.page)
          break
        case 'text':
          await this.bridge.textContainerUpgrade(TextContainerUpgrade.fromJson(cmd.upgrade))
          break
        case 'image':
          await this.bridge.updateImageRawData(ImageRawDataUpdate.fromJson(cmd.image))
          break
        case 'exit':
          await this.bridge.shutDownPageContainer(cmd.exitMode ?? 1)
          this.pageReady = false
          break
        case 'mic': {
          const ok = await this.bridge.audioControl(cmd.on)
          this.log(`audioControl(${cmd.on ? 'on' : 'off'}) → ${ok}`)
          break
        }
      }
    } catch (err) {
      this.log(`render error: ${err instanceof Error ? err.message : err}`)
    }
  }

  private async applyPage(page: PageSpec) {
    if (!this.bridge) return

    const onlyOneText =
      page.textObject?.length === 1 &&
      !page.imageObject?.length &&
      !page.listObject?.length
    const textId = page.textObject?.[0]?.containerID ?? null

    // Flicker-free fast path: same single-text layout → update the text in place.
    if (this.pageReady && onlyOneText && textId !== null && textId === this.lastTextContainerId) {
      const t = page.textObject![0]
      await this.bridge.textContainerUpgrade(TextContainerUpgrade.fromJson({
        containerID: t.containerID,
        containerName: t.containerName,
        content: t.content,
      }))
      return
    }

    // fromJson builds the SDK container classes (incl. nested list/image) from our plain specs.
    if (!this.pageReady) {
      const result = await this.bridge.createStartUpPageContainer(CreateStartUpPageContainer.fromJson(page))
      this.pageReady = result === StartUpPageCreateResult.success
      if (!this.pageReady) {
        this.log(`createStartUpPageContainer failed: ${result}`)
        return
      }
    } else {
      await this.bridge.rebuildPageContainer(RebuildPageContainer.fromJson(page))
    }
    this.lastTextContainerId = onlyOneText ? textId : null
  }

  // ── Input forwarding (glasses → brain) ──────────────────────────────────────
  private forwardInput() {
    if (!this.bridge) return
    const send = (msg: InputMessage) => {
      this.log(`input → ${msg.kind === 'event' ? msg.action : msg.kind}`)
      void this.relay.publish(INPUT_TOPIC, msg)
    }

    this.bridge.onEvenHubEvent((event: EvenHubEvent) => {
      const textEvent = event.textEvent
      if (textEvent) {
        switch (textEvent.eventType) {
          case OsEventTypeList.CLICK_EVENT:
          case undefined:
            send({ kind: 'event', action: 'click' })
            break
          case OsEventTypeList.DOUBLE_CLICK_EVENT:
            send({ kind: 'event', action: 'double-click' })
            break
          case OsEventTypeList.SCROLL_TOP_EVENT:
            send({ kind: 'event', action: 'scroll-up' })
            break
          case OsEventTypeList.SCROLL_BOTTOM_EVENT:
            send({ kind: 'event', action: 'scroll-down' })
            break
        }
      }

      // Glasses-mic PCM: forward it up to the brain (which buffers + transcribes it).
      const pcm = event.audioEvent?.audioPcm
      if (pcm != null) {
        const b64 = this.pcmToBase64(pcm)
        if (b64) void this.relay.publish(AUDIO_TOPIC, { pcm: b64 } satisfies AudioMessage)
      }

      // OS exit request: tell the brain, then confirm locally so the system dialog appears.
      if (event.sysEvent?.eventType === OsEventTypeList.SYSTEM_EXIT_EVENT) {
        send({ kind: 'exit-request' })
        void this.bridge?.shutDownPageContainer(1)
      }
    })
  }

  /** Normalise the host's PCM payload (Uint8Array | number[] | base64 string) to base64. */
  private pcmToBase64(pcm: unknown): string | null {
    if (typeof pcm === 'string') return pcm // host already serialised it as base64
    let bytes: Uint8Array | null = null
    if (pcm instanceof Uint8Array) bytes = pcm
    else if (Array.isArray(pcm)) bytes = Uint8Array.from(pcm as number[])
    if (!bytes || bytes.length === 0) return null
    let bin = ''
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return btoa(bin)
  }
}

new GlassesTerminal().start().catch(err =>
  console.error('Terminal failed to start:', err instanceof Error ? err.message : err),
)
