function requestBodyError(code, message, status = 413) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.retryable = code === "OBSERVATION_TOO_LARGE";
  return error;
}

function readBody(req, { maxBytes = 6_000_000, tooLargeCode = "REQUEST_TOO_LARGE" } = {}) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let oversized = Number(req.headers["content-length"] || 0) > maxBytes;
    req.on("data", (chunk) => {
      if (oversized) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        oversized = true;
        body = "";
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (oversized) {
        reject(requestBodyError(tooLargeCode, `Request body exceeds ${maxBytes} bytes.`));
        return;
      }
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

module.exports = { readBody, requestBodyError };
