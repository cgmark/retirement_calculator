import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve(process.cwd());
const host = "127.0.0.1";
const port = 8080;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
};

function safePath(urlPath) {
  const clean = normalize(decodeURIComponent(urlPath.split("?")[0]));
  const rel = clean === "/" ? "/retirement.html" : clean;
  const full = resolve(join(root, rel));
  if (!full.startsWith(root)) return null;
  return full;
}

const server = createServer(async (req, res) => {
  try {
    const path = safePath(req.url || "/");
    if (!path) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    const fileStat = await stat(path);
    if (fileStat.isDirectory()) {
      res.writeHead(403);
      res.end("Directory listing disabled");
      return;
    }

    const body = await readFile(path);
    res.writeHead(200, {
      "Content-Type": mime[extname(path)] || "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

server.listen(port, host, () => {
  console.log(`Dev server running at http://${host}:${port}/retirement.html`);
});
