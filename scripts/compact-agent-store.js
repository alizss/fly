const fs = require("fs");

const {
  createStore,
  DEFAULT_DB_PATH
} = require("../apps/web/agent/session-store");

const dbPath = process.env.ATW_TRANSACTION_DB || DEFAULT_DB_PATH;
const vacuum = process.argv.includes("--vacuum");

if (!fs.existsSync(dbPath)) {
  console.log(JSON.stringify({ dbPath, skipped: true, reason: "database_not_found" }, null, 2));
  process.exit(0);
}

const beforeFileBytes = fs.statSync(dbPath).size;
const store = createStore({ dbPath });
try {
  const result = store.reclaimObservationStorage({ vacuum });
  const afterFileBytes = fs.statSync(dbPath).size;
  console.log(JSON.stringify({
    dbPath,
    beforeFileBytes,
    afterFileBytes,
    ...result
  }, null, 2));
} finally {
  store.close();
}
