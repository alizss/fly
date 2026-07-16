// @ts-check
const { defineConfig } = require("@playwright/test");
const replayOnly = process.env.ATW_REPLAY_ONLY === "1";
const testPort = Number(process.env.ATW_TEST_PORT || 4173);

module.exports = defineConfig({
  testDir: "./tests/agent",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  webServer: replayOnly ? undefined : {
    // Deliberately not `npm run dev` — that rebuilds the whole Vite dashboard
    // (slow, unrelated to the demo checkout, which is static). The demo
    // checkout only needs the raw Node server.
    command: `PORT=${testPort} node apps/web/server.js`,
    url: `http://localhost:${testPort}/demo/checkout`,
    reuseExistingServer: true,
    timeout: 30_000
  }
});
