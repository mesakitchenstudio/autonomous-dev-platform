import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tempStore, waitFor, orchestratorFor, ProjectState } from './helpers.js';
import { ownerAuthHeaders } from './security-env.js';
import { startReviewSession, hydrateReviewSession, readReviewFile, liveReviewHandleCount } from '../src/delivery/session.js';
import { resolveProjectArtifact } from '../src/security/artifacts.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const RECIPE_IDEA = 'Build a simple recipe web application where users can browse recipes, search recipes, open recipe details, save recipes to favorites, and create a simple weekly meal plan.';

async function startUiServer() {
  process.env.ARTIFACT_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-ui-'));
  const { store } = await tempStore();
  const orch = orchestratorFor(store, { demo: true });
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
      const reviewPage = url.pathname.match(/^\/review\/([^/]+)(?:\/(.*))?$/);
      if (req.method === 'GET' && reviewPage) {
        const projects = await store.list();
        for (const project of projects) {
          if (hydrateReviewSession(project, reviewPage[1])) break;
        }
        const file = await readReviewFile(reviewPage[1], `/${reviewPage[2] || ''}`);
        res.writeHead(file.status, { 'content-type': file.type || 'text/plain; charset=utf-8' });
        return res.end(file.body);
      }
      if (url.pathname.startsWith('/api/') && auth !== ownerAuthHeaders().authorization) return json(401, { error: 'authentication required' });
      if (req.method === 'GET' && url.pathname === '/api/projects') return json(200, await store.list());
      if (req.method === 'POST' && url.pathname === '/api/projects') {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const created = await store.create({ idea: body.idea, demo: true });
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
      const session = url.pathname.match(/^\/api\/projects\/([^/]+)\/review-session$/);
      if (req.method === 'POST' && session) {
        const project = await store.get(session[1]);
        const origin = `http://127.0.0.1:${server.address().port}`;
        const started = await startReviewSession(project, { publicBaseUrl: origin, ttlMs: 10 * 60 * 1000 });
        await store.save(project);
        return json(201, started);
      }
      const artifact = url.pathname.match(/^\/api\/projects\/([^/]+)\/artifacts\/([^/]+)$/);
      if (req.method === 'GET' && artifact) {
        const project = await store.get(artifact[1]);
        const found = resolveProjectArtifact(project, artifact[2]);
        const data = await fs.readFile(found.path);
        res.writeHead(200, { 'content-type': found.mimeType || 'application/octet-stream' });
        return res.end(data);
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

async function createReadyProject(store, orch, idea, createdAt) {
  const created = await store.create({ idea, demo: true });
  if (createdAt) {
    created.createdAt = createdAt;
    await store.save(created);
  }
  orch.start(created.id);
  await waitFor(store, created.id, p => p.state === ProjectState.READY_FOR_OWNER_REVIEW, 25000);
  return created;
}

async function openDashboard(playwright, port, token) {
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.fill('#token', token);
  await page.click('#refresh');
  return { browser, context, page };
}

function cardById(page, id) {
  return page.locator(`.card[data-id="${id}"]`);
}

async function openReadyDashboard(playwright, idea = RECIPE_IDEA) {
  const { server, store, orch, port } = await startUiServer();
  const token = ownerAuthHeaders().authorization.replace('Bearer ', '');
  let browser;
  try {
    const created = await store.create({ idea, demo: true });
    orch.start(created.id);
    await waitFor(store, created.id, p => p.state === ProjectState.READY_FOR_OWNER_REVIEW, 25000);
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.fill('#token', token);
    await page.click('#refresh');
    await page.waitForSelector('text=Ready for review');
    return { server, store, port, token, browser, context, page, created };
  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
    throw error;
  }
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
    await page.waitForSelector('text=Ready for review');
    await page.click('button[data-changes-open="1"]');
    await page.fill('.feedback', 'Make the navigation simpler.');
    await page.click('button[data-changes="1"]');
    await waitFor(store, created.id, p => p.state === ProjectState.READY_FOR_OWNER_REVIEW && (p.deliveries || []).some(item => item.version === 2), 25000);
    await page.click('#refresh');
    await page.waitForSelector('text=Ready for review');
    await page.click('button[data-approve="1"]');
    await waitFor(store, created.id, p => p.state === ProjectState.DONE, 8000);
    await page.click('#refresh');
    await page.waitForSelector('text=Complete');

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mpage = await mobile.newPage();
    await mpage.goto(`http://127.0.0.1:${port}/`);
    await mpage.fill('#token', token);
    await mpage.click('#refresh');
    await mpage.waitForSelector('text=Complete');
    await mobile.close();
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
  assert.equal((await store.list())[0].state, ProjectState.DONE);
});

test('Playwright Open App loads the demo application from the dashboard button', { timeout: 60_000 }, async () => {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    return;
  }
  const harness = await openReadyDashboard(playwright);
  try {
    const popupPromise = harness.page.waitForEvent('popup');
    await harness.page.click('button[data-open="1"]');
    const popup = await popupPromise;
    await popup.waitForSelector('[data-app="demo"]');
    await popup.waitForSelector('.card, #grid');
    await popup.fill('#search', 'pasta');
    await popup.waitForSelector('text=Lemon Pasta');
    await popup.click('text=Lemon Pasta');
    await popup.click('#toggle-fav');
    await popup.waitForSelector('text=Remove from Favorites');
    await popup.close();
    const project = await harness.store.get(harness.created.id);
    assert.equal((project.reviewSessions || []).filter(item => item.status === 'ACTIVE').length, 1);
    assert.ok(liveReviewHandleCount() >= 1);
  } finally {
    await harness.browser.close();
    await new Promise(resolve => harness.server.close(resolve));
  }
});

test('Playwright duplicate Open App stays bounded', { timeout: 60_000 }, async () => {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    return;
  }
  const harness = await openReadyDashboard(playwright);
  try {
    for (let i = 0; i < 5; i += 1) {
      const popupPromise = harness.page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
      await harness.page.click('button[data-open="1"]');
      const popup = await popupPromise;
      if (popup) await popup.close().catch(() => {});
    }
    const project = await harness.store.get(harness.created.id);
    const active = (project.reviewSessions || []).filter(item => item.status === 'ACTIVE');
    assert.equal(active.length, 1);
    assert.ok(liveReviewHandleCount() <= 2);
  } finally {
    await harness.browser.close();
    await new Promise(resolve => harness.server.close(resolve));
  }
});

test('Playwright technical details stay open across polling unless the owner closes them', { timeout: 90_000 }, async () => {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    return;
  }
  const harness = await openReadyDashboard(playwright);
  try {
    const details = harness.page.locator('details.tech');
    assert.equal(await details.evaluate(el => el.open), true);
    await harness.page.waitForTimeout(12000);
    assert.equal(await details.evaluate(el => el.open), true);
    await details.locator('summary').click();
    assert.equal(await details.evaluate(el => el.open), false);
    await harness.page.waitForTimeout(12000);
    assert.equal(await details.evaluate(el => el.open), false);
    await details.locator('summary').click();
    assert.equal(await details.evaluate(el => el.open), true);
    await harness.page.waitForTimeout(6000);
    assert.equal(await details.evaluate(el => el.open), true);
  } finally {
    await harness.browser.close();
    await new Promise(resolve => harness.server.close(resolve));
  }
});

test('Playwright request-changes text survives dashboard polling', { timeout: 30_000 }, async () => {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    return;
  }
  const harness = await openReadyDashboard(playwright);
  try {
    await harness.page.click('button[data-changes-open="1"]');
    await harness.page.fill('.feedback', 'Make the homepage less busy');
    await harness.page.waitForTimeout(12000);
    assert.equal(await harness.page.inputValue('.feedback'), 'Make the homepage less busy');
  } finally {
    await harness.browser.close();
    await new Promise(resolve => harness.server.close(resolve));
  }
});

test('Playwright newest project is first and expanded', { timeout: 60_000 }, async () => {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    return;
  }
  const { server, store, port } = await startUiServer();
  const token = ownerAuthHeaders().authorization.replace('Bearer ', '');
  const a = await store.create({ idea: 'Oldest pantry tracker', demo: true });
  a.createdAt = '2026-09-08T09:50:00.000Z';
  await store.save(a);
  const b = await store.create({ idea: 'Middle pantry tracker', demo: true });
  b.createdAt = '2026-09-08T10:20:00.000Z';
  await store.save(b);
  const c = await store.create({ idea: 'Newest pantry tracker', demo: true });
  c.createdAt = '2026-09-08T10:30:00.000Z';
  await store.save(c);
  const { browser, page } = await openDashboard(playwright, port, token);
  try {
    await page.waitForSelector('.card[data-id]');
    const cards = page.locator('.card[data-id]');
    assert.equal(await cards.count(), 3);
    assert.equal(await cards.nth(0).getAttribute('data-id'), c.id);
    assert.equal(await cards.nth(1).getAttribute('data-id'), b.id);
    assert.equal(await cards.nth(2).getAttribute('data-id'), a.id);
    assert.equal(await cards.nth(0).getAttribute('data-expanded'), '1');
    assert.equal(await cards.nth(1).getAttribute('data-expanded'), '0');
    assert.equal(await cards.nth(2).getAttribute('data-expanded'), '0');
    assert.equal(await cardById(page, b.id).locator('button[data-open="1"], button[data-approve="1"]').count(), 0);
    assert.match(await page.locator('#project-count').innerText(), /3 projects/);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Playwright accordion keeps a single expanded project across polling', { timeout: 90_000 }, async () => {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    return;
  }
  const { server, store, orch, port } = await startUiServer();
  const token = ownerAuthHeaders().authorization.replace('Bearer ', '');
  const a = await createReadyProject(store, orch, 'Accordion project A', '2026-09-08T10:00:00.000Z');
  const b = await createReadyProject(store, orch, 'Accordion project B', '2026-09-08T10:10:00.000Z');
  const { browser, page } = await openDashboard(playwright, port, token);
  try {
    await page.waitForSelector(`.card[data-id="${b.id}"][data-expanded="1"]`);
    assert.equal(await cardById(page, a.id).getAttribute('data-expanded'), '0');
    await cardById(page, a.id).locator('.card-toggle').click();
    await page.waitForSelector(`.card[data-id="${a.id}"][data-expanded="1"]`);
    assert.equal(await cardById(page, b.id).getAttribute('data-expanded'), '0');
    await page.waitForTimeout(12000);
    assert.equal(await cardById(page, a.id).getAttribute('data-expanded'), '1');
    assert.equal(await cardById(page, b.id).getAttribute('data-expanded'), '0');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Playwright submitting a new project expands it and collapses others', { timeout: 60_000 }, async () => {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    return;
  }
  const { server, store, port } = await startUiServer();
  const token = ownerAuthHeaders().authorization.replace('Bearer ', '');
  const a = await store.create({ idea: 'Existing A', demo: true });
  a.createdAt = '2026-09-08T10:00:00.000Z';
  await store.save(a);
  const b = await store.create({ idea: 'Existing B', demo: true });
  b.createdAt = '2026-09-08T10:05:00.000Z';
  await store.save(b);
  const { browser, page } = await openDashboard(playwright, port, token);
  try {
    await cardById(page, a.id).locator('.card-toggle').click();
    await page.waitForSelector(`.card[data-id="${a.id}"][data-expanded="1"]`);
    await page.fill('#idea', 'Brand new override project');
    await page.click('#submit');
    await page.waitForFunction(ids => {
      const cards = [...document.querySelectorAll('.card[data-id]')];
      if (cards.length !== 3) return false;
      const first = cards[0];
      return first.dataset.expanded === '1' && !ids.includes(first.dataset.id);
    }, [a.id, b.id]);
    const rows = await page.$$eval('.card[data-id]', els => els.map(el => ({ id: el.dataset.id, expanded: el.dataset.expanded })));
    assert.equal(rows[0].expanded, '1');
    assert.equal(rows.find(item => item.id === a.id)?.expanded, '0');
    assert.equal(rows.find(item => item.id === b.id)?.expanded, '0');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Playwright duplicate ideas stay independent accordion items', { timeout: 60_000 }, async () => {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    return;
  }
  const { server, store, port } = await startUiServer();
  const token = ownerAuthHeaders().authorization.replace('Bearer ', '');
  const { browser, page } = await openDashboard(playwright, port, token);
  try {
    await page.fill('#idea', RECIPE_IDEA);
    await page.click('#submit');
    await page.waitForSelector('.card[data-id]');
    await page.fill('#idea', RECIPE_IDEA);
    await page.click('#submit');
    await page.waitForFunction(() => document.querySelectorAll('.card[data-id]').length === 2);
    const list = await store.list();
    assert.equal(list.length, 2);
    assert.equal(list[0].idea, list[1].idea);
    const cards = page.locator('.card[data-id]');
    assert.equal(await cards.count(), 2);
    assert.equal(await cards.nth(0).getAttribute('data-id'), list[0].id);
    assert.equal(await cards.nth(0).getAttribute('data-expanded'), '1');
    assert.equal(await cards.nth(1).getAttribute('data-expanded'), '0');
    assert.equal(await cards.nth(1).locator('button[data-approve="1"]').count(), 0);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Playwright request-changes draft survives collapsing another project', { timeout: 60_000 }, async () => {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    return;
  }
  const { server, store, orch, port } = await startUiServer();
  const token = ownerAuthHeaders().authorization.replace('Bearer ', '');
  const a = await createReadyProject(store, orch, RECIPE_IDEA, '2026-09-08T10:00:00.000Z');
  const b = await createReadyProject(store, orch, RECIPE_IDEA, '2026-09-08T10:10:00.000Z');
  const { browser, page } = await openDashboard(playwright, port, token);
  try {
    await cardById(page, a.id).locator('.card-toggle').click();
    await page.waitForSelector(`.card[data-id="${a.id}"] button[data-changes-open="1"]`);
    await page.click('button[data-changes-open="1"]');
    await page.fill('.feedback', 'Keep the recipe cards but enlarge photos.');
    await cardById(page, b.id).locator('.card-toggle').click();
    await page.waitForSelector(`.card[data-id="${b.id}"][data-expanded="1"]`);
    await cardById(page, a.id).locator('.card-toggle').click();
    await page.waitForSelector(`.card[data-id="${a.id}"] .feedback`);
    assert.equal(await page.inputValue('.feedback'), 'Keep the recipe cards but enlarge photos.');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Playwright ready notification expands the matching collapsed project', { timeout: 60_000 }, async () => {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    return;
  }
  const { server, store, orch, port } = await startUiServer();
  const token = ownerAuthHeaders().authorization.replace('Bearer ', '');
  const a = await createReadyProject(store, orch, 'Notification project A', '2026-09-08T10:00:00.000Z');
  const b = await createReadyProject(store, orch, 'Notification project B', '2026-09-08T10:10:00.000Z');
  const { browser, page } = await openDashboard(playwright, port, token);
  try {
    await page.waitForSelector(`.card[data-id="${b.id}"][data-expanded="1"]`);
    await page.click(`#inbox a[data-project="${a.id}"]`);
    await page.waitForSelector(`.card[data-id="${a.id}"][data-expanded="1"]`);
    assert.equal(await cardById(page, b.id).getAttribute('data-expanded'), '0');
    const focused = await page.evaluate(() => document.activeElement?.closest('.card')?.dataset.id);
    assert.equal(focused, a.id);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Playwright technical details restore after accordion collapse and polling', { timeout: 90_000 }, async () => {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    return;
  }
  const { server, store, orch, port } = await startUiServer();
  const token = ownerAuthHeaders().authorization.replace('Bearer ', '');
  const a = await createReadyProject(store, orch, RECIPE_IDEA, '2026-09-08T10:00:00.000Z');
  const b = await createReadyProject(store, orch, RECIPE_IDEA, '2026-09-08T10:10:00.000Z');
  const { browser, page } = await openDashboard(playwright, port, token);
  try {
    const newestDetails = page.locator(`.card[data-id="${b.id}"] details.tech`);
    assert.equal(await newestDetails.evaluate(el => el.open), true);
    assert.ok(await newestDetails.locator('text=Original request').count());
    await newestDetails.locator('summary').click();
    assert.equal(await newestDetails.evaluate(el => el.open), false);
    await cardById(page, a.id).locator('.card-toggle').click();
    await cardById(page, b.id).locator('.card-toggle').click();
    assert.equal(await page.locator(`.card[data-id="${b.id}"] details.tech`).evaluate(el => el.open), false);
    await page.waitForTimeout(12000);
    assert.equal(await page.locator(`.card[data-id="${b.id}"] details.tech`).evaluate(el => el.open), false);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('Playwright accordion stays usable on a mobile viewport', { timeout: 60_000 }, async () => {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    return;
  }
  const { server, store, orch, port } = await startUiServer();
  const token = ownerAuthHeaders().authorization.replace('Bearer ', '');
  const a = await createReadyProject(store, orch, RECIPE_IDEA, '2026-09-08T10:00:00.000Z');
  const b = await createReadyProject(store, orch, RECIPE_IDEA, '2026-09-08T10:10:00.000Z');
  const browser = await playwright.chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.fill('#token', token);
    await page.click('#refresh');
    await page.waitForSelector(`.card[data-id="${b.id}"][data-expanded="1"]`);
    assert.equal(await cardById(page, a.id).getAttribute('data-expanded'), '0');
    assert.equal(await cardById(page, a.id).locator('button[data-approve="1"]').count(), 0);
    await cardById(page, a.id).locator('.card-toggle').click();
    await page.waitForSelector(`.card[data-id="${a.id}"] button[data-open="1"]`);
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
});
