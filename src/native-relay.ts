// Bridge to the native embedded relay (Android RelayServerPlugin).
// On a Capacitor native build, the phone app hosts the relay in-process; everything
// else (browser/PWA) returns null and falls back to an external relay URL.

import { registerPlugin, Capacitor } from '@capacitor/core'

interface RelayServerPlugin {
  start(options: { port: number }): Promise<{ url: string }>
  stop(): Promise<void>
}

const RelayServer = registerPlugin<RelayServerPlugin>('RelayServer')

/** Starts the embedded relay when running natively. Returns its localhost URL, or null on web. */
export async function startNativeRelay(port = 8787): Promise<string | null> {
  if (!Capacitor.isNativePlatform()) return null
  try {
    const { url } = await RelayServer.start({ port })
    return url
  } catch (err) {
    console.error('Embedded relay failed to start:', err instanceof Error ? err.message : err)
    return null
  }
}
