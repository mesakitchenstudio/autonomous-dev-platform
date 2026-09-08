import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempStore, waitFor, orchestratorFor, ProjectState } from './helpers.js';
import { ownerAuthHeaders } from './security-env.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');

async function startUiServer() {
  process.env.ARTIFACT_ROOT = process.env.ARTIFACT_ROOT || path.join(root, 'artifacts');
  const { store } = await tempStore();
  const orch = orchestratorFor(store);
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const auth = req.headers.authorization;
    const json = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    try {
      if (url.pathname === '/health') return json(200, { ok: true });
      if (url.pathname.startsWith('/api/') && auth !== ownerAuthHeaders().authorization) return json(401, { error: 'authentication required' });
      if (req.method === 'GET' && url.pathname === '/api/projects') return json(200, await store.list());
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const created = await store.create({ idea: body.idea });
        orch.start(created.id);
        return json(202, created);
      }
      const approve = url.pathname.match(/^\/api\/projects\/([^/]+)\/approve$/);
      if (req.method === 'POST' && approve) return json(200, await orch.approve(approve[1]));
      const changes = url.pathname.match(/^\/api\/projects\/([^/]+)\/changes$/);
      if (req.method === 'POST' && changes) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        return json(202, await orch.requestChanges(changes[1], body.feedback));
      }
      const one = url.pathname.match(/^\/api\/projects\/([^/]+)$/);
      if (req.method === 'GET' && one) return json(200, await store.get(one[1]));
      if (req.method === 'GET' && url.pathname === '/api/notifications') {
        const list = await store.list();
        return json(200, list.flatMap(item => item.notifications || []));
      }
      let target = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const full = path.resolve(publicDir, target);
      if (!full.startsWith(publicDir)) return json(403, { error: 'forbidden' });
      const data = await fs.readFile(full);
      res.writeHead(200, { 'content-type': mime[path.extname(full)] || 'application/octet-stream' });
      res.end(data);
    } catch (error) {
      json(500, { error: error.message, code: error.code });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, store, orch, port: server.address().port };
}

test('Playwright owner flow: ready, request changes, approve', async () => {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    return;
  }
  const { server, store, port } = await startUiServer();
  const token = ownerAuthHeaders().authorization.replace('Bearer ', '');
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.fill('#token', token);
    await page.fill('#idea', 'Build a simple recipe web application.');
    await page.click('#submit');
    const created = (await store.list())[0];
    await waitFor(store, created.id, p => p.state === ProjectState.READY_FOR_OWNER_REVIEW, 25000);
    await page.click('#refresh');
    await page.waitForSelector('text=Ready for your review');
    await page.fill('.feedback', 'Make the navigation simpler.');
    await page.click('button[data-changes="1"]');
    await waitFor(store, created.id, p => p.state === ProjectState.READY_FOR_OWNER_REVIEW && (p.deliveries || []).some(item => item.version === 2), 25000);
    await page.click('#refresh');
    await page.waitForSelector('text=Ready for your review');
    await page.click('button[data-approve="1"]');
    await waitFor(store, created.id, p => p.state === ProjectState.DONE, 8000);
    await page.click('#refresh');
    await page.waitForSelector('text=Completed');

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mpage = await mobile.newPage();
    await mpage.goto(`http://127.0.0.1:${port}/`);
    await mpage.fill('#token', token);
    await mpage.click('#refresh');
    await mpage.waitForSelector('text=Completed');
    await mobile.close();
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
  assert.equal((await store.list())[0].state, ProjectState.DONE);
});
