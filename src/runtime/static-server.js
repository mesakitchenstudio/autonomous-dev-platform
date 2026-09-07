import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

export function startStaticServer(root, port) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.resolve(root, `.${rel}`);
    if (!file.startsWith(path.resolve(root))) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      const fallback = path.join(root, 'index.html');
      try {
        const data = await fs.readFile(fallback);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(data);
      } catch {
        res.writeHead(404).end('Not found');
      }
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('static-server.js')) {
  const root = process.argv.includes('--root') ? process.argv[process.argv.indexOf('--root') + 1] : process.cwd();
  const port = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 0);
  startStaticServer(root, port).then(server => {
    const address = server.address();
    process.stdout.write(`static-server listening ${address.port}\n`);
  });
}
