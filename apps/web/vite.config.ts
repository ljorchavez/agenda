import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** Same headers production sends (scripts/vercel-build.sh), so `vite preview` checks the CSP. */
const security = JSON.parse(readFileSync(new URL('./security-headers.json', import.meta.url), 'utf8')) as Record<string, string>;
const { 'Strict-Transport-Security': _hsts, ...previewHeaders } = security;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // Same-origin /api in dev, like CloudFront does in production.
    proxy: { '/api': 'http://localhost:3000' },
  },
  preview: {
    headers: previewHeaders,
    proxy: { '/api': 'http://localhost:3000' },
  },
});
