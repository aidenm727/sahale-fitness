import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const runtime = `http://127.0.0.1:${process.env.SAHALE_PORT ?? 4310}`

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  // The UI talks to the runtime through /api.
  server: { port: 5173, strictPort: true, proxy: { '/api': { target: runtime } } },
  preview: { proxy: { '/api': { target: runtime } } },
  // One bundle is fine for a single-owner app.
  build: { chunkSizeWarningLimit: 800 },
})
