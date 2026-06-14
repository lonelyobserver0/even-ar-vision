import { defineConfig } from 'vite'

// Two entry points:
//   index.html   -> the brain app (camera + AI + UI), runs in a browser / PWA
//   glasses.html -> the generic terminal, packaged as the .ehpk entrypoint
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        glasses: 'glasses.html',
      },
    },
  },
})
