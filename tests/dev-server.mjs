// Minimal Netlify-like dev server for local verification ONLY.
// Serves the static site, the /api/* redirects from netlify.toml, and executes
// the .mjs functions with (req, context) like Netlify Functions v2.
//
// Usage: node tests/dev-server.mjs [port]
//   env: DATABASE_URL (optional; without it the API reports db_not_configured)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const root = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

const ROUTES = {
  "/api/auth/google/callback": "./netlify/functions/google-callback.mjs",
  "/api/auth/google": "./netlify/functions/google-start.mjs",
  "/api/auth": "./netlify/functions/auth.mjs",
  "/api/sync": "./netlify/functions/sync.mjs",
  "/api/health": "./netlify/functions/health.mjs",
  "/api/jobs": "./netlify/functions/jobs.mjs",
  "/api/tailoring-pickups": "./netlify/functions/pickups.mjs",
  "/api/storages": "./netlify/functions/storages.mjs",
  "/api/job-accessories": "./netlify/functions/job-items.mjs",
  "/api/job-documents": "./netlify/functions/job-items.mjs",
};

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".json": "application/json" };

export function createApp() {
  return http.createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

      if (ROUTES[pathname]) {
        const mod = await import(url.pathToFileURL(path.join(root, ROUTES[pathname])).href);
        const fnBody = await new Promise((resolve, reject) => {
          const chunks = [];
          req.on("data", (c) => chunks.push(c));
          req.on("end", () => resolve(Buffer.concat(chunks)));
          req.on("error", reject);
        });
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === "string") headers.set(k, v);
        }
        const r = new Request(`http://localhost${req.url}`, {
          method: req.method,
          headers,
          body: ["GET", "HEAD"].includes(req.method) ? undefined : fnBody,
        });
        const out = await mod.default(r, {});
        res.statusCode = out.status;
        for (const [k, v] of out.headers) res.setHeader(k, v);
        const buf = Buffer.from(await out.arrayBuffer());
        res.end(buf);
        return;
      }

      // Static files.
      let file = pathname === "/" ? "/index.html" : pathname;
      file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
      const abs = path.join(root, decodeURIComponent(file));
      if (!abs.startsWith(root) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }
      res.setHeader("Content-Type", MIME[path.extname(abs)] || "application/octet-stream");
      fs.createReadStream(abs).pipe(res);
    } catch (e) {
      res.statusCode = 500;
      res.end("Dev server error: " + e.message);
    }
  });
}

export async function startServer(port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = createApp();
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

const isMain = process.argv[1] && import.meta.url === url.pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const port = Number(process.argv[2] || process.env.PORT || 3000);
  startServer(port, "0.0.0.0").then(() => {
    console.log(`[dev-server] http://localhost:${port}  db_configured=${Boolean(process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL)}`);
  });
}
