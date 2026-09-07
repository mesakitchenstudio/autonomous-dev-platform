import http from 'node:http';

const port = Number(process.env.PORT || 0);
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404).end('missing');
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`listening ${server.address().port}\n`);
});
