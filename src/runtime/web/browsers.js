import { boolEnv } from '../../util/env.js';

export async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch (error) {
    const err = new Error('Playwright is not installed. Run npm run setup:browsers.');
    err.cause = error;
    throw err;
  }
}

export async function browserAvailability({ launch = false } = {}) {
  const out = { chromium: false, firefox: false, webkit: false, versions: {} };
  try {
    const playwright = await loadPlaywright();
    for (const name of ['chromium', 'firefox', 'webkit']) {
      try {
        const executable = playwright[name].executablePath();
        out[name] = Boolean(executable);
        if (launch && out[name]) {
          const browser = await playwright[name].launch({ headless: true });
          out.versions[name] = browser.version();
          await browser.close();
        }
      } catch {
        out[name] = false;
      }
    }
  } catch {
    return out;
  }
  return out;
}

export async function launchChromium() {
  const playwright = await loadPlaywright();
  try {
    const browser = await playwright.chromium.launch({ headless: true });
    return { browser, version: browser.version(), name: 'chromium' };
  } catch (error) {
    if (boolEnv('PLAYWRIGHT_INSTALL_ON_PROJECT', false)) {
      throw error;
    }
    const err = new Error('Chromium is not installed for Playwright. Run npm run setup:browsers. The platform will not download browsers during an owner project.');
    err.cause = error;
    throw err;
  }
}
