import fs from 'node:fs';
import readline from 'node:readline';

function send(msg) {
  fs.writeSync(1, `${JSON.stringify(msg)}\n`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1 } });
    return;
  }
  if (msg.method === 'authenticate') {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'not logged in' } });
  }
});
