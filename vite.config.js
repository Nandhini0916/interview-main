import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // Load env file based on `mode` in the current working directory
  const env = loadEnv(mode, process.cwd(), '')
  
  return {
    plugins: [react()],
    server: {
      port: 5173,
    },
    define: {
      'import.meta.env.VITE_GOOGLE_CLIENT_ID': JSON.stringify(env.VITE_GOOGLE_CLIENT_ID),
      'import.meta.env.VITE_NODE_API_URL': JSON.stringify(env.VITE_NODE_API_URL),
      'import.meta.env.VITE_PYTHON_API_URL': JSON.stringify(env.VITE_PYTHON_API_URL),
      'import.meta.env.VITE_PYTHON_WS_URL': JSON.stringify(env.VITE_PYTHON_WS_URL),
      'import.meta.env.VITE_SIGNALING_URL': JSON.stringify(env.VITE_SIGNALING_URL),
    }
  }
})