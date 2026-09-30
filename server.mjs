/**
 * Static file server for local use and for `npm start`.
 *
 * The site itself is plain static files and also works on GitHub Pages; this
 * exists so that `fetch()` of the JSON data files succeeds on file:// too,
 * which it would not.
 *
 * Usage: node server.mjs [--port 8080]
 */
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const argPort = process.argv.indexOf('--port');
const PORT = Number(
  argPort > -1 ? process.argv[argPort + 1] : (process.env.PORT ?? 8080),
);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Resolve inside ROOT only: reject anything that escapes via ..
    const target = resolve(join(ROOT, normalize(pathname)));
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('403 forbidden');
      return;
    }

    const info = await stat(target).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404 not found');
      return;
    }

    res.writeHead(200, {
      'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'content-length': info.size,
      'cache-control': 'no-cache',
    });
    createReadStream(target).pipe(res);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`500 ${err.message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Zhougong Dream Dictionary -> http://localhost:${PORT}/`);
});
