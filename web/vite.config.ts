import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({ plugins: [react()], envDir: process.env.STUDIO_RELEASE_BUILD === '1' ? false : undefined })
