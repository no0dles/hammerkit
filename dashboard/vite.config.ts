import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// The app is served by the server at hammerkit.<domain> (src/server/dashboard.ts), from
// dist/dashboard. It shares types and a few helpers with the server: ../src/server.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist/dashboard',
    emptyOutDir: true,
    // the server's content security policy allows no inline script, style or data: script
    assetsInlineLimit: 0,
  },
  server: {
    fs: { allow: ['..'] },
    // `npm run dev`: the pages ask a server of `hammerkit server` on localhost for the API,
    // with a token in HAMMERKIT_TOKEN, as the dashboard host would
    proxy: {
      '/api': {
        target: process.env.HAMMERKIT_DASHBOARD ?? 'http://hammerkit.localhost:8480',
        changeOrigin: true,
        headers: process.env.HAMMERKIT_TOKEN
          ? { 'hammerkit-authorization': `Bearer ${process.env.HAMMERKIT_TOKEN}` }
          : {},
      },
    },
  },
})
