import { ApplicationKind, RuntimeAdapterName, RuntimeStatus } from '../kinds.js';
import { RuntimeAdapter } from './base.js';

export class DesktopRuntimeAdapter extends RuntimeAdapter {
  constructor() {
    super(RuntimeAdapterName.DESKTOP);
  }

  canHandle(plan) {
    return plan?.applicationKind === ApplicationKind.DESKTOP;
  }

  async launch() {
    return {
      status: 'DETECTION_ONLY',
      classification: 'INFRASTRUCTURE_UNAVAILABLE',
      message: 'Desktop GUI automation is not executed in Phase 6 unless a dedicated adapter is present.'
    };
  }

  async executeScenario() {
    return {
      status: RuntimeStatus.NOT_RUN,
      reason: 'INFRASTRUCTURE_UNAVAILABLE',
      classification: 'DETECTION_ONLY',
      steps: [],
      screenshots: [],
      failures: []
    };
  }
}
