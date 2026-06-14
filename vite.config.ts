import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8'))

// Two entry points:
//   index.html   -> the brain app (camera + AI + UI), runs in a browser / PWA
//   glasses.html -> the generic terminal, packaged as the .ehpk entrypoint
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version), // shown in the brain's title
  },
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        glasses: 'glasses.html',
      },
    },
  },
})
