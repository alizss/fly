// @ts-check
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/agent",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  webServer: {
    // Deliberately not `npm run dev` — that rebuilds the whole Vite dashboard
    // (slow, unrelated to the demo checkout, which is static). The demo
    // checkout only needs the raw Node server.
    command: "node apps/web/server.js",
    url: "http://localhost:4173/demo/checkout",
    reuseExistingServer: true,
    timeout: 30_000
  }
});
