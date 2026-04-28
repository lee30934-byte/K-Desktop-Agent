import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    hmr: {
      protocol: "ws",
      host: "localhost",
      port: 1421,
    },
    watch: {
      // Don't watch src-tauri; Cargo handles it
      ignored: ["**/src-tauri/**"],
    },
  },

  // 번들 최적화: 큰 라이브러리 분리
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom"],
          "markdown": ["react-markdown", "remark-gfm", "rehype-highlight"],
          "highlight": ["highlight.js"],
        },
      },
    },
    chunkSizeWarningLimit: 600, // 경고 임계치 상향
  },
}));
