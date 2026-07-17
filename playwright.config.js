// @ts-check
const { defineConfig } = require("@playwright/test");
const replayOnly = process.env.ATW_REPLAY_ONLY === "1";
const testPort = Number(process.env.ATW_TEST_PORT || 4273);
const transactionDb = process.env.ATW_TRANSACTION_DB
  || `/tmp/atw-agent-${testPort}-${process.pid}.sqlite`;
const testDataDir = process.env.ATW_TEST_DATA_DIR
  || `/tmp/atw-agent-data-${testPort}-${process.pid}`;
const profileDb = process.env.ATW_PROFILE_DB
  || `${testDataDir}/air-travel-wallet-db.json`;

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
    command: `PORT=${testPort} ATW_TRANSACTION_DB=${transactionDb} ATW_DATA_DIR=${testDataDir} ATW_PROFILE_DB=${profileDb} node apps/web/server.js`,
    url: `http://localhost:${testPort}/demo/checkout`,
    reuseExistingServer: false,
    timeout: 30_000
  }
});
