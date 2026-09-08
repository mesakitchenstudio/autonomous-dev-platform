import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'adp-demo-owner-token';
const RECIPE = 'Build a simple recipe web application where users can browse recipes, search recipes, open recipe details, save recipes to favorites, and create a simple weekly meal plan.';
const FEEDBACK = 'Make the homepage less busy and use larger recipe images.';

function spawnDemo({ port, dataDir }) {
  const env = { ...process.env };
  delete env.DATABASE_URL;
  return spawn(process.execPath, ['scripts/demo.js'], {
    cwd: root,
    env: {
      ...env,
      DEMO_MODE: 'true',
      APP_ROLE: 'combined',
      OWNER_TOKEN_BOOTSTRAP: TOKEN,
      SECURITY_PROFILE: 'DEVELOPMENT',
      SECRET_MASTER_KEY: '00'.repeat(32),
      PORT: String(port),
      DATA_DIR: dataDir,
      WORKSPACE_DIR: path.join(dataDir, 'ws'),
      ARTIFACT_ROOT: path.join(dataDir, 'artifacts')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { child.kill('SIGKILL'); } catch {}
}

async function waitHealth(port, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return res.json();
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`demo server on ${port} did not become healthy`);
}

test('Playwright full owner demo against scripts/demo.js: v1 Open App, Request Changes, v2, Approve', { timeout: 180_000 }, async () => {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    return;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-flow-'));
  const port = 15200 + Math.floor(Math.random() * 200);
  const child = spawnDemo({ port, dataDir: dir });
  let browser;
  try {
    await waitHealth(port);
    browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.fill('#token', TOKEN);
    await page.fill('#idea', RECIPE);
    await page.click('#submit');
    await page.waitForSelector('text=Ready for review', { timeout: 60000 });
    await page.waitForSelector('button[data-open="1"]');

    const v1PopupPromise = page.waitForEvent('popup');
    await page.click('button[data-open="1"]');
    const v1App = await v1PopupPromise;
    await v1App.waitForSelector('[data-app="demo"]');
    assert.equal(await v1App.locator('body').getAttribute('data-delivery-version'), '1');
    await v1App.fill('#search', 'pasta');
    await v1App.waitForSelector('text=Lemon Pasta');
    await v1App.click('text=Lemon Pasta');
    await v1App.click('#toggle-fav');
    await v1App.waitForSelector('text=Remove from Favorites');
    await v1App.close();

    await page.click('button[data-changes-open="1"]');
    await page.fill('.feedback', 'Make the homepage less busy');
    await page.waitForTimeout(6000);
    await page.locator('.feedback').pressSequentially(' and use larger recipe images.', { delay: 25 });
    assert.equal(await page.inputValue('.feedback'), FEEDBACK);
    await page.click('button[data-changes="1"]');
    await page.waitForSelector('text=Applying your requested changes', { timeout: 15000 });
    await page.waitForSelector('text=Ready for review', { timeout: 60000 });
    await page.waitForFunction(() => {
      const grid = document.querySelector('.tech-grid');
      return Boolean(grid && /v2/.test(grid.textContent || ''));
    }, null, { timeout: 20000 });
    const detailsOpen = await page.locator('details.tech').evaluate(el => el.open);
    assert.equal(detailsOpen, true);

    const v2PopupPromise = page.waitForEvent('popup');
    await page.click('button[data-open="1"]');
    const v2App = await v2PopupPromise;
    await v2App.waitForSelector('[data-app="demo"]');
    const body = v2App.locator('body');
    assert.equal(await body.getAttribute('data-delivery-version'), '2');
    const classes = await body.getAttribute('class');
    assert.match(classes || '', /\bcompact\b/);
    assert.match(classes || '', /\blarge-art\b/);
    await v2App.close();

    await page.click('button[data-approve="1"]');
    await page.waitForSelector('text=Complete', { timeout: 15000 });
    await page.waitForSelector('text=This project is complete.');

    const project = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    }).then(res => res.json()).then(list => list[0]);
    assert.equal(project.state, 'DONE');
    const v1 = (project.deliveries || []).find(item => Number(item.version) === 1);
    const v2 = (project.deliveries || []).find(item => Number(item.version) === 2);
    assert.equal(v1?.status, 'SUPERSEDED');
    assert.equal(v2?.status, 'APPROVED');
    const v2Sessions = (project.reviewSessions || []).filter(item => item.deliveryId === v2.id);
    assert.ok(v2Sessions.length >= 1);
    assert.equal(v2Sessions.at(-1)?.artifactHash, v2.manifestHash);
    const currentOpen = (project.reviewSessions || []).filter(item => item.status === 'ACTIVE' || item.status === 'STOPPED');
    assert.ok(currentOpen.filter(item => item.status === 'ACTIVE').every(item => item.deliveryId === v2.id));
    const v1Active = (project.reviewSessions || []).filter(item => item.deliveryId === v1.id && item.status === 'ACTIVE');
    assert.equal(v1Active.length, 0);
  } finally {
    if (browser) await browser.close().catch(() => {});
    killTree(child);
  }
});
