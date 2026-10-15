import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'chrome120',
    minify: 'esbuild',
    sourcemap: false,
    rollupOptions: {
      input: { main: 'index.html', settings: 'settings.html' },
    },
  },
})
