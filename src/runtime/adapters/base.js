export class RuntimeAdapter {
  constructor(name) {
    this.name = name;
  }
  canHandle(_plan) { return false; }
  async prepare() { return { ok: true }; }
  async launch() { throw new Error('Not implemented'); }
  async waitUntilReady() { return { ok: true }; }
  async executeScenario() { throw new Error('Not implemented'); }
  async captureScreenshot() { return null; }
  async collectDiagnostics() { return { consoleErrors: [], pageErrors: [], networkFailures: [] }; }
  async shutdown() { return { ok: true }; }
}
