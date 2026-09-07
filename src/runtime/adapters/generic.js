import { RuntimeAdapterName, RuntimeStatus } from '../kinds.js';
import { RuntimeAdapter } from './base.js';

export class GenericRuntimeAdapter extends RuntimeAdapter {
  constructor() {
    super(RuntimeAdapterName.GENERIC);
  }

  canHandle(plan) {
    return !plan?.applicationKind || plan.applicationKind === 'UNKNOWN' || plan.applicationKind === 'GENERIC';
  }

  async launch() {
    return { skipped: true, status: RuntimeStatus.NOT_APPLICABLE };
  }

  async executeScenario() {
    return { status: RuntimeStatus.NOT_APPLICABLE, steps: [], screenshots: [], failures: [] };
  }
}
