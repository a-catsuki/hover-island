import { defineConfig } from 'vite'
import solid from 'vite-plugin-solid'

export default defineConfig({
  plugins: [solid()],
  // Shown in Settings so you can tell at a glance which build is installed.
  define: { __BUILD_TIME__: JSON.stringify(new Date().toISOString()) },
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
      input: { main: 'index.html', settings: 'settings.html', ambient: 'ambient.html' },
    },
  },
})
