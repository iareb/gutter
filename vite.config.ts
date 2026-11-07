/// <reference types="vitest/config" />
import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// Set by `tauri android dev` / `tauri ios dev` so a physical device can reach the dev server
const host = process.env.TAURI_DEV_HOST

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [svelte()],
  // Keep Rust compiler errors visible in the terminal
  clearScreen: false,
  server: {
    // Tauri expects a fixed port: fail instead of picking another one
    port: 1420,
    strictPort: true,
    host: host || '127.0.0.1',
    // No dev server connection on a phone: while the system file picker is open
    // the app is in the background, the connection drops and Vite reloads the page
    // on reconnect, losing the open volume. `hmr: false` alone keeps the
    // connection (and the reload): `ws: false` removes it. Restart
    // `tauri android dev` to see code changes.
    hmr: host ? false : undefined,
    ws: host ? false : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  test: {
    include: ['src/**/*.test.ts'],
  },
})
