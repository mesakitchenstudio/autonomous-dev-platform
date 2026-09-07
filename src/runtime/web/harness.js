import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ErrorCode, PlatformError } from '../../orchestrator/errors.js';
import { validateAction } from '../dsl.js';
import { writeBinaryArtifact } from '../artifacts.js';
import { BaselineKind, RuntimeFindingCode } from '../kinds.js';
import { launchChromium } from './browsers.js';
import { runAccessibilityChecks } from './a11y.js';
import { detectLayoutDefects } from './layout.js';

const ANIMATION_CSS = `*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}`;

export class PlaywrightHarness {
  constructor({ projectId, iteration, checkpointSha, artifactHash } = {}) {
    this.projectId = projectId;
    this.iteration = iteration;
    this.checkpointSha = checkpointSha;
    this.artifactHash = artifactHash;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.consoleErrors = [];
    this.pageErrors = [];
    this.networkFailures = [];
    this.version = null;
  }

  async open({ baseUrl, viewport, recordTrace = false } = {}) {
    const launched = await launchChromium();
    this.browser = launched.browser;
    this.version = launched.version;
    this.context = await this.browser.newContext({
      viewport: viewport ? { width: viewport.width, height: viewport.height } : { width: 1280, height: 800 },
      reducedMotion: 'reduce'
    });
    if (recordTrace) {
      await this.context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    }
    this.page = await this.context.newPage();
    this.page.on('console', message => {
      if (['error'].includes(message.type())) {
        this.consoleErrors.push({ type: message.type(), text: message.text(), severity: 'HIGH' });
      }
    });
    this.page.on('pageerror', error => {
      this.pageErrors.push({ text: error.message, severity: 'CRITICAL' });
    });
    this.page.on('requestfailed', request => {
      this.networkFailures.push({
        url: request.url(),
        failure: request.failure()?.errorText || 'failed',
        severity: 'HIGH'
      });
    });
    this.page.on('response', response => {
      if (response.status() >= 500) {
        this.networkFailures.push({ url: response.url(), failure: `HTTP ${response.status()}`, severity: 'CRITICAL' });
      }
    });
    this.baseUrl = baseUrl;
    await this.page.addStyleTag({ content: ANIMATION_CSS }).catch(() => {});
    return this;
  }

  async runAction(step) {
    const checked = validateAction(step, { baseUrl: this.baseUrl });
    if (!checked.ok) {
      throw new PlatformError({
        code: ErrorCode.SCENARIO_FAILED,
        message: checked.error,
        phase: 'RUNTIME_VERIFICATION',
        retryable: false
      });
    }
    const action = checked.action;
    const started = Date.now();
    try {
      if (action.action === 'NAVIGATE') {
        const target = action.url.startsWith('http') ? action.url : new URL(action.url, this.baseUrl).toString();
        await this.page.goto(target, { waitUntil: 'domcontentloaded' });
        await this.page.addStyleTag({ content: ANIMATION_CSS }).catch(() => {});
      } else if (action.action === 'CLICK') {
        await this.page.locator(action.selector).first().click({ timeout: 8000 });
      } else if (action.action === 'FILL') {
        await this.page.locator(action.selector).first().fill(String(action.value ?? ''), { timeout: 8000 });
      } else if (action.action === 'SELECT') {
        await this.page.locator(action.selector).first().selectOption(String(action.value ?? ''));
      } else if (action.action === 'CHECK') {
        await this.page.locator(action.selector).first().check();
      } else if (action.action === 'PRESS') {
        await this.page.keyboard.press(action.key || 'Enter');
      } else if (action.action === 'WAIT_FOR') {
        if (action.condition === 'load') await this.page.waitForLoadState('domcontentloaded');
        else if (action.selector) await this.page.locator(action.selector).first().waitFor({ state: 'visible', timeout: 8000 });
        else await this.page.waitForTimeout(50);
      } else if (action.action === 'ASSERT_VISIBLE') {
        await this.page.locator(action.selector).first().waitFor({ state: 'visible', timeout: 8000 });
      } else if (action.action === 'ASSERT_TEXT') {
        const text = await this.page.locator(action.selector).first().innerText();
        if (action.text && !text.includes(action.text)) throw new Error(`Expected text "${action.text}"`);
      } else if (action.action === 'ASSERT_URL') {
        if (action.url && !this.page.url().includes(action.url)) throw new Error(`Expected URL ${action.url}`);
      } else if (action.action === 'SCREENSHOT') {
        return {
          status: 'PASS',
          durationMs: Date.now() - started,
          screenshot: await this.captureScreenshot({ name: action.name || 'step', route: this.page.url() })
        };
      } else if (action.action === 'KEYBOARD_TAB') {
        await this.page.keyboard.press('Tab');
      } else if (action.action === 'KEYBOARD_ENTER') {
        await this.page.keyboard.press('Enter');
      }
      return { status: 'PASS', durationMs: Date.now() - started, action: action.action };
    } catch (error) {
      return { status: 'FAIL', durationMs: Date.now() - started, action: action.action, error: error.message };
    }
  }

  async captureScreenshot({ name, route, viewport, scenarioId, step } = {}) {
    await this.page.waitForTimeout(30);
    const bytes = await this.page.screenshot({ fullPage: false, animations: 'disabled' });
    const box = this.page.viewportSize() || { width: 1280, height: 800 };
    const artifact = await writeBinaryArtifact({
      projectId: this.projectId,
      iteration: this.iteration,
      kind: 'screenshot',
      fileName: `${safe(name)}.png`,
      bytes,
      extra: {
        scenarioId,
        step,
        platform: 'web',
        browser: 'chromium',
        device: viewport?.name || 'DESKTOP',
        viewport: viewport?.name || 'DESKTOP',
        width: box.width,
        height: box.height,
        route: route || this.page.url(),
        checkpointSha: this.checkpointSha,
        artifactHash: this.artifactHash,
        baselineKind: BaselineKind.NO_BASELINE,
        masks: []
      }
    });
    return artifact;
  }

  async collectDiagnostics() {
    return {
      consoleErrors: this.consoleErrors,
      pageErrors: this.pageErrors,
      networkFailures: this.networkFailures
    };
  }

  async accessibility() {
    return runAccessibilityChecks(this.page);
  }

  async layoutFindings(viewport) {
    return detectLayoutDefects(this.page, viewport);
  }

  async stopTrace(failed) {
    if (!this.context) return null;
    try {
      if (!failed) {
        await this.context.tracing.stop().catch(() => {});
        return null;
      }
      const fileName = `trace-${Date.now()}.zip`;
      const temp = path.join(path.dirname(fileURLToPath(import.meta.url)), fileName);
      await this.context.tracing.stop({ path: temp });
      const fs = await import('node:fs/promises');
      const bytes = await fs.readFile(temp);
      await fs.unlink(temp).catch(() => {});
      return writeBinaryArtifact({
        projectId: this.projectId,
        iteration: this.iteration,
        kind: 'playwright-trace',
        fileName,
        bytes
      });
    } catch {
      return null;
    }
  }

  async close() {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
  }
}

function safe(name) {
  return String(name || 'shot').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
}

export { RuntimeFindingCode };
