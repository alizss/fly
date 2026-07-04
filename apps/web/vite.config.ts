import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: webRoot,
  publicDir: false,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "public/assets",
    emptyOutDir: true,
    rollupOptions: {
      input: "src/main.tsx",
      output: {
        entryFileNames: "app.js",
        assetFileNames: "app.css"
      }
    }
  }
});
