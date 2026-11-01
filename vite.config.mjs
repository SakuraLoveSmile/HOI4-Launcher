import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const match = /\/src\/locales\/([^/]+)\.json$/.exec(
            id.replaceAll("\\", "/"),
          );
          if (match)
            return `locale-${match[1].startsWith("en-") ? "en" : match[1]}`;
        },
      },
    },
  },
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
});
