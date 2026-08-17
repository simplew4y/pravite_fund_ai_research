import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const API_TARGET = process.env.PRIVATE_FUND_API_URL ?? "http://127.0.0.1:6768";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 6780,
    proxy: {
      "/v1": { target: API_TARGET, changeOrigin: false },
      "/auth": { target: API_TARGET, changeOrigin: false },
      "/health": { target: API_TARGET, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
