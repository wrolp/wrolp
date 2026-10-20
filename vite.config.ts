import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // `tauri dev` starts this server while cargo is still writing src-tauri/target;
      // watching those artifacts crashes the dev server with EBUSY on a locked .o file.
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    target: 'esnext',
    minify: false,
    assetDir: 'assets',
  },
})
