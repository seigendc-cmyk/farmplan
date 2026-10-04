import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // UI flow tests drive the whole app through jsdom; slower computers need far more than vitest's 5 s default. Few workers keep a laptop from thrashing.
  test: { environment: 'node', include: ['src/**/*.test.{ts,tsx}'], testTimeout: 120_000, hookTimeout: 60_000, maxWorkers: 4 },
})
