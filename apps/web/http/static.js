const fs = require("fs");
const path = require("path");

function createStaticHandler(publicDir) {
  return function serveStatic(_req, res, pathname) {
    const routeFile = pathname === "/" || pathname === "/login" || pathname === "/onboarding" || pathname === "/dashboard" || pathname.startsWith("/travelers") || pathname.startsWith("/trips") || pathname.startsWith("/settings")
      ? "index.html"
      : pathname === "/demo/checkout"
        ? "checkout.html"
        : pathname.slice(1);
    const filePath = path.normalize(path.join(publicDir, routeFile));
    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    };
    res.writeHead(200, { "content-type": types[path.extname(filePath)] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  };
}

module.exports = { createStaticHandler };
