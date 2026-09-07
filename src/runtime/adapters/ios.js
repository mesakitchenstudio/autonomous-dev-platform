import { spawnSync } from 'node:child_process';
import { ApplicationKind, RuntimeAdapterName, RuntimeFindingCode, RuntimeStatus } from '../kinds.js';
import { RuntimeAdapter } from './base.js';

export class IOSRuntimeAdapter extends RuntimeAdapter {
  constructor() {
    super(RuntimeAdapterName.IOS);
  }

  canHandle(plan) {
    return plan?.applicationKind === ApplicationKind.IOS;
  }

  discover() {
    return discoverIos();
  }

  async launch() {
    const info = discoverIos();
    if (!info.available) {
      return {
        unavailable: true,
        code: RuntimeFindingCode.IOS_RUNTIME_INFRASTRUCTURE_UNAVAILABLE,
        message: 'IOS_RUNTIME_INFRASTRUCTURE_UNAVAILABLE'
      };
    }
    return { unavailable: false, ...info };
  }

  async executeScenario() {
    const info = discoverIos();
    return {
      status: RuntimeStatus.NOT_RUN,
      reason: info.available ? 'NOT_EXECUTED' : 'INFRASTRUCTURE_UNAVAILABLE',
      code: RuntimeFindingCode.IOS_RUNTIME_INFRASTRUCTURE_UNAVAILABLE,
      steps: [],
      screenshots: [],
      failures: []
    };
  }
}

export function discoverIos() {
  if (process.platform !== 'darwin') {
    return { available: false, macos: false, xcode: false, simctl: false };
  }
  const xcodebuild = spawnSync('xcodebuild', ['-version'], { encoding: 'utf8' });
  const simctl = spawnSync('xcrun', ['simctl', 'help'], { encoding: 'utf8' });
  return {
    available: xcodebuild.status === 0 && simctl.status === 0,
    macos: true,
    xcode: xcodebuild.status === 0,
    simctl: simctl.status === 0
  };
}
