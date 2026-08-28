const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

async function runtimeContextModule() {
  const source = fs.readFileSync(
    path.resolve(__dirname, "../../apps/extension/src/content/runtime-context.js"),
    "utf8"
  );
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

test("extension runtime context gives modules explicit read/write capabilities", async () => {
  const { createRuntimeContext } = await runtimeContextModule();
  const context = createRuntimeContext({ visible: "ready", secret: "durable", count: 0 });
  const view = context.scope("read-only-view", { read: ["visible"] });
  const controller = context.scope("controller", { read: ["visible"], write: ["count"] });

  assert.equal(view.visible, "ready");
  assert.throws(() => view.secret, /cannot read/);
  assert.throws(() => { view.visible = "changed"; }, /cannot write/);
  controller.count = 1;
  assert.equal(context.owner.count, 1);
  assert.throws(() => { controller.secret = "changed"; }, /cannot write/);
});

test("extension wiring never hands a module the unrestricted runtime owner", () => {
  const root = path.resolve(__dirname, "../..");
  const runtime = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const sidebar = fs.readFileSync(path.join(root, "apps/extension/src/content/ui/sidebar.js"), "utf8");

  assert.match(runtime, /createAgentRuntimeContext\s*\(/);
  assert.doesNotMatch(runtime, /^\s+agent,\s*$/m);
  assert.match(runtime, /agent:\s*runtimeScopes\.sidebar/);
  assert.doesNotMatch(sidebar, /agent\.[A-Za-z0-9_]+\s*=(?!=)/);
  assert.match(sidebar, /setUserGoal\(event\.target\.value\)/);
});

test("booking admission and observation support live behind owned modules", () => {
  const root = path.resolve(__dirname, "../..");
  const runtime = fs.readFileSync(path.join(root, "apps/extension/src/content/runtime.js"), "utf8");
  const admission = fs.readFileSync(path.join(root, "apps/extension/src/content/selected-booking-admission.js"), "utf8");
  const signatures = fs.readFileSync(path.join(root, "apps/extension/src/content/observation/signatures.js"), "utf8");
  const pageStateSupport = fs.readFileSync(path.join(root, "apps/extension/src/content/observation/page-state-support.js"), "utf8");

  assert.match(runtime, /createSelectedBookingAdmission\s*\(/);
  assert.match(runtime, /createObservationSignatures\s*\(/);
  assert.match(runtime, /createPageStateSupport\s*\(/);
  assert.doesNotMatch(runtime, /captureSelectedBookingFromMap/);
  assert.doesNotMatch(runtime, /function materialObservationSignature\s*\(/);
  assert.doesNotMatch(runtime, /function canonicalPageStateDiff\s*\(/);
  assert.match(admission, /async function admitForStart\s*\(/);
  assert.doesNotMatch(admission, /transactionFacts|pageStateStore|schedule|capture/);
  assert.match(signatures, /function materialObservationSignature\s*\(/);
  assert.match(pageStateSupport, /function canonicalPageStateDiff\s*\(/);
});
