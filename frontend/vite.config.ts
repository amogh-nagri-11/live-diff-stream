import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The backend (live-diff-stream) listens on :4400 and sets no CORS headers,
// so we proxy both the REST API and the WebSocket through the dev server. The
// browser only ever talks to its own origin, sidestepping CORS entirely.
const BACKEND = process.env.VITE_BACKEND_URL ?? "http://localhost:4400";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // /api/sessions -> http://localhost:4400/sessions
      "/api": {
        target: BACKEND,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      // WebSocket diff stream.
      "/ws": {
        target: BACKEND.replace(/^http/, "ws"),
        ws: true,
        changeOrigin: true,
      },
    },
  },
});
