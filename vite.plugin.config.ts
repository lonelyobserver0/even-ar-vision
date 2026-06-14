import { defineConfig } from 'vite'

// Plugin-only build: just the terminal, emitted into dist-plugin/.
// The .ehpk must expose the terminal as index.html, because the Even runtime loads
// index.html (the `entrypoint` field is not reliably honored). The pack:ehpk script
// renames glasses.html -> index.html after this build.
export default defineConfig({
  build: {
    outDir: 'dist-plugin',
    emptyOutDir: true,
    rollupOptions: {
      input: 'glasses.html',
    },
  },
})
