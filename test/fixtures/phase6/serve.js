import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const port = Number(process.env.PORT || 0);
const file = process.env.FIXTURE_HTML || path.join(process.cwd(), 'index.html');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  const html = fs.readFileSync(file);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`listening ${server.address().port}\n`);
});
