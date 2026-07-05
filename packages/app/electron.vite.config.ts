import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // Workspace-пакеты бандлим (это TS-исходники), внешние зависимости — externalize.
    plugins: [externalizeDepsPlugin({ exclude: ['@slojka/shared', '@slojka/engine'] })],
    build: {
      rollupOptions: {
        // externalizeDepsPlugin смотрит только на dependencies; node-pty живёт
        // в optionalDependencies — бандлинг ломает его require('pty.node').
        external: ['node-pty'],
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@slojka/shared', '@slojka/engine'] })],
  },
  renderer: {
    plugins: [react()],
  },
})
