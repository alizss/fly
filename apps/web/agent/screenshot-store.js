const crypto = require("crypto");
const { requestBodyError } = require("../http/body");

function clampText(value, max = 4000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function createScreenshotStore({ maxEntries = 40 } = {}) {
  const uploads = new Map();

  function storeScreenshotUpload({ sessionId = "", observationId = "", screenshotDataUrl = "" } = {}) {
    if (!screenshotDataUrl.startsWith("data:image/")) {
      throw requestBodyError("SCREENSHOT_INVALID", "Screenshot upload must be a data:image URL.", 400);
    }
    const screenshotId = `shot_${crypto.randomBytes(8).toString("hex")}`;
    uploads.set(screenshotId, {
      screenshotId,
      sessionId: clampText(sessionId, 120),
      observationId: clampText(observationId, 120),
      screenshotDataUrl,
      createdAt: Date.now()
    });
    while (uploads.size > maxEntries) uploads.delete(uploads.keys().next().value);
    return screenshotId;
  }

  function screenshotForObservation(page = {}, body = {}) {
    const screenshotId = clampText(page.screenshotId, 120);
    if (!screenshotId) return { screenshotId: "", screenshotDataUrl: String(page.screenshotDataUrl || "") };
    const upload = uploads.get(screenshotId);
    if (!upload) throw requestBodyError("SCREENSHOT_REFERENCE_EXPIRED", "Screenshot reference is unknown or expired.", 409);
    if (upload.sessionId && upload.sessionId !== clampText(body.sessionId, 120)) {
      throw requestBodyError("SCREENSHOT_SESSION_MISMATCH", "Screenshot reference belongs to another checkout session.", 409);
    }
    if (upload.observationId && upload.observationId !== clampText(body.observationId, 120)) {
      throw requestBodyError("SCREENSHOT_OBSERVATION_MISMATCH", "Screenshot reference belongs to another observation.", 409);
    }
    return { screenshotId, screenshotDataUrl: upload.screenshotDataUrl };
  }

  return { screenshotForObservation, storeScreenshotUpload };
}

module.exports = { createScreenshotStore };
