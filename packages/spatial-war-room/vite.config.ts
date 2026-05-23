import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules')) {
            if (id.includes('@xyflow') || id.includes('react-flow')) {
              return 'reactflow';
            }
            if (id.includes('react') || id.includes('scheduler') || id.includes('react-dom')) {
              return 'react-core';
            }
            return 'vendor';
          }
        }
      }
    }
  }
})
