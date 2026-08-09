import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const extensionRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: extensionRoot,
  publicDir: false,
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: "src/content/content.js",
      formats: ["iife"],
      name: "AirTravelWalletContent",
      fileName: () => "content.js"
    }
  }
});
