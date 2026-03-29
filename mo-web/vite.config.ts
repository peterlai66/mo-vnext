import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { cloudflare } from "@cloudflare/vite-plugin";

const moBackendTarget =
  process.env.VITE_MO_BACKEND_URL ?? "http://127.0.0.1:8788";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), cloudflare()],
  server: {
    proxy: {
      "/api/today": {
        target: moBackendTarget,
        changeOrigin: true,
      },
      "/api/candidates": {
        target: moBackendTarget,
        changeOrigin: true,
      },
      "/api/report-preview": {
        target: moBackendTarget,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/report-preview/, "/admin/report-preview"),
      },
    },
  },
})