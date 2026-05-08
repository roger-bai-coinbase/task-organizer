import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { boardFileApiPlugin } from './vite-plugins/boardFileApi'

// https://vite.dev/config/
export default defineConfig({
  plugins: [boardFileApiPlugin(), react()],
})
