// Minimal client for the topic-based SSE relay (see relay/server.mjs).
//
//   publish(topic, data)  -> POST /pub/:topic   (one-shot send)
//   subscribe(topic, cb)  -> GET  /sub/:topic   (EventSource, auto-reconnecting)

export class RelayClient {
  private readonly base: string
  private readonly sources = new Map<string, EventSource>()

  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/$/, '')
  }

  /** Send a JSON payload to a topic. `retain` keeps it as the topic's last value, replayed to late subscribers. */
  async publish(topic: string, data: unknown, retain = false): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/pub/${topic}${retain ? '?retain=1' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      return res.ok
    } catch (err) {
      console.warn(`Relay publish [${topic}] failed:`, err instanceof Error ? err.message : err)
      return false
    }
  }

  /**
   * Subscribe to a topic. Returns an unsubscribe function. EventSource reconnects on its own.
   * `onStatus` (optional) is called with the live connection state (true=connected).
   */
  subscribe<T>(
    topic: string,
    onMessage: (data: T) => void,
    onStatus?: (connected: boolean) => void,
  ): () => void {
    this.sources.get(topic)?.close()
    const es = new EventSource(`${this.base}/sub/${topic}`)
    let warned = false // log once per disconnection episode, not on every retry
    es.onopen = () => {
      warned = false
      onStatus?.(true)
      console.log(`Relay subscribe [${topic}] connected`)
    }
    es.onmessage = (e) => {
      warned = false
      onStatus?.(true)
      try {
        onMessage(JSON.parse(e.data) as T)
      } catch (err) {
        console.warn(`Bad relay payload [${topic}]:`, err instanceof Error ? err.message : err)
      }
    }
    es.onerror = () => {
      onStatus?.(false)
      if (!warned) {
        warned = true
        console.warn(`Relay [${topic}] not reachable at ${this.base} — is the relay running? (auto-retrying)`)
      }
    }
    this.sources.set(topic, es)
    return () => {
      es.close()
      this.sources.delete(topic)
    }
  }

  closeAll() {
    for (const es of this.sources.values()) es.close()
    this.sources.clear()
  }
}
