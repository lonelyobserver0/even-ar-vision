import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.even.arvision',
  appName: 'AR Vision',
  webDir: 'dist',
  // Serve the app over http://localhost so it shares a scheme with the in-app relay
  // (avoids mixed-content when the brain fetches http://localhost:8787). http://localhost
  // is still a secure context, so getUserMedia (live camera) keeps working.
  server: {
    androidScheme: 'http',
    cleartext: true,
  },
}

export default config
