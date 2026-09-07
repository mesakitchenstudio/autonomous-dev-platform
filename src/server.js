import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDotEnv, intEnv, boolEnv } from './util/env.js';
import { JsonStore } from './storage/json-store.js';
import { createProviders } from './providers/index.js';
import { Council } from './council/council.js';
import { createCursorClient } from './cursor/index.js';
import { Orchestrator } from './orchestrator/orchestrator.js';
import { WorkspaceManager } from './storage/workspace.js';
import { ErrorCode } from './orchestrator/errors.js';

loadDotEnv();
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const demo = boolEnv('DEMO_MODE', false);
const store = new JsonStore(process.env.DATA_DIR || path.join(root, 'data'));
await store.init();
const providers = createProviders();
const council = new Council(providers, process.env.CHAIR_PROVIDER || 'openai');
const cursor = createCursorClient();
const workspace = new WorkspaceManager(process.env.WORKSPACE_DIR || path.join(root, 'workspaces'));
const orchestrator = new Orchestrator({
  store,
  council,
  cursor,
  workspace,
  maxIterations: intEnv('MAX_IMPLEMENTATION_ITERATIONS', 12),
  demo
});
const resumed = await orchestrator.recoverOnBoot();
const publicDir = path.join(root, 'public');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/projects') return json(res, 200, await store.list());
    if (req.method === 'POST' && url.pathname === '/api/projects') {
      const b = await body(req);
      if (!b.idea?.trim()) return json(res, 400, { error: 'idea is required' });
      const p = await orchestrator.submit({ idea: b.idea.trim(), projectPath: b.projectPath?.trim() || null });
      return json(res, 202, p);
    }
    const match = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (req.method === 'GET' && match) return json(res, 200, await store.get(match[1]));
    const retry = url.pathname.match(/^\/api\/projects\/([^/]+)\/retry$/);
    if (req.method === 'POST' && retry) {
      try {
        const p = await orchestrator.retry(retry[1]);
        return json(res, 202, { ok: true, id: p.id, resumeTarget: p.state });
      } catch (error) {
        const status = error?.code === ErrorCode.RETRY_NOT_ELIGIBLE ? 409 : 500;
        return json(res, status, { error: error.message, code: error.code });
      }
    }
    let target = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const full = path.resolve(publicDir, target);
    if (!full.startsWith(publicDir)) return json(res, 403, { error: 'forbidden' });
    const data = await fs.readFile(full);
    res.writeHead(200, { 'content-type': mime[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  } catch (error) {
    if (error?.code === 'ENOENT') return json(res, 404, { error: 'not found' });
    json(res, 500, { error: error.message });
  }
});

const port = intEnv('PORT', 4317);
server.listen(port, () => {
  const mode = demo ? 'DEMO (MOCK verification)' : 'live';
  console.log(`Autonomous Dev Platform (${mode}) running at http://localhost:${port}`);
  if (resumed.length) console.log(`Resumed ${resumed.length} in-flight project(s).`);
});
