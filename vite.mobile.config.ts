import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
export default defineConfig({
  root: 'mobile', publicDir: '../public', plugins: [react()],
  build: { outDir: '../sidecar/dist/mobile', emptyOutDir: true, rollupOptions: { input: resolve('mobile/index.html') } },
});
