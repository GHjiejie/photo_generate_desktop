import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import previewLibrary from './preview-library.cjs';
import { fileURLToPath } from 'node:url';
const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const developmentCSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://127.0.0.1:5173; object-src 'none'; base-uri 'none'; form-action 'none'";
export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [previewLibrary.previewLibraryPlugin(), react(), {name: 'local-development-csp', apply: 'serve', transformIndexHtml: html => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, `<meta http-equiv="Content-Security-Policy" content="${developmentCSP}">`)}],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, cors: false, allowedHosts: ['127.0.0.1'],
    fs: { strict: true, allow: [projectRoot], deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.codex/**', '**/.agents/**', '**/.portrait-studio/**', '**/photo_repo/**', '**/assets/images/**', '**/.verification/**', '**/release*/**', '**/*.dmg', '**/*.zip'] } },
  build: { outDir: 'renderer-dist', emptyOutDir: true, assetsInlineLimit: 0 },
});
