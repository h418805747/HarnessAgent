import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT || 8787);
const types = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
};

createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  const pathname = url.pathname === "/" ? "/hermes-switchboard-light.html" : url.pathname;
  const file = join(root, decodeURIComponent(pathname));

  if (!file.startsWith(root)) {
    response.writeHead(403).end("forbidden");
    return;
  }

  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": types[extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`http://127.0.0.1:${port}/hermes-switchboard-light.html`);
});
