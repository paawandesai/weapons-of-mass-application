import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 5173),
    proxy: {
      '/api': process.env.API_ORIGIN ?? 'http://localhost:3000',
      '/auth': process.env.API_ORIGIN ?? 'http://localhost:3000',
      // Public token pages served by the API; emails link to them on the web origin.
      '/confirm': process.env.API_ORIGIN ?? 'http://localhost:3000',
      '/captcha': process.env.API_ORIGIN ?? 'http://localhost:3000',
    },
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    globals: false,
    css: false,
  },
});
