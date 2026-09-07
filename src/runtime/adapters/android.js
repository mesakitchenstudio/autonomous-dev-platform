import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ApplicationKind, RuntimeAdapterName, RuntimeFindingCode, RuntimeStatus } from '../kinds.js';
import { RuntimeAdapter } from './base.js';

export class AndroidRuntimeAdapter extends RuntimeAdapter {
  constructor() {
    super(RuntimeAdapterName.ANDROID);
  }

  canHandle(plan) {
    return plan?.applicationKind === ApplicationKind.ANDROID;
  }

  discover() {
    return discoverAndroid();
  }

  async launch({ plan }) {
    const info = discoverAndroid();
    if (!info.sdk || !info.emulator) {
      return {
        unavailable: true,
        code: RuntimeFindingCode.ANDROID_RUNTIME_INFRASTRUCTURE_UNAVAILABLE,
        message: 'ANDROID RUNTIME — NOT VERIFIED — INFRASTRUCTURE UNAVAILABLE'
      };
    }
    return {
      unavailable: false,
      profile: plan.deviceProfile || 'PHONE_STANDARD',
      sdk: info
    };
  }

  async waitUntilReady() {
    const info = discoverAndroid();
    if (!info.sdk) {
      return { unavailable: true, code: RuntimeFindingCode.EMULATOR_UNAVAILABLE };
    }
    return { ok: true };
  }

  async executeScenario() {
    const info = discoverAndroid();
    if (!info.sdk || !info.emulator) {
      return {
        status: RuntimeStatus.NOT_RUN,
        reason: 'INFRASTRUCTURE_UNAVAILABLE',
        code: RuntimeFindingCode.ANDROID_RUNTIME_INFRASTRUCTURE_UNAVAILABLE,
        steps: [],
        screenshots: [],
        failures: []
      };
    }
    return {
      status: RuntimeStatus.NOT_RUN,
      reason: 'INFRASTRUCTURE_UNAVAILABLE',
      code: RuntimeFindingCode.ANDROID_RUNTIME_INFRASTRUCTURE_UNAVAILABLE,
      steps: [],
      screenshots: [],
      failures: []
    };
  }

  async shutdown() {
    return { ok: true };
  }
}

export function discoverAndroid() {
  const home = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || null;
  const adb = which('adb');
  const emulator = which('emulator');
  const sdkmanager = which('sdkmanager');
  const avdmanager = which('avdmanager');
  return {
    sdk: Boolean(home && (adb || fs.existsSync(path.join(home, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')))),
    home,
    adb: Boolean(adb),
    emulator: Boolean(emulator),
    sdkmanager: Boolean(sdkmanager),
    avdmanager: Boolean(avdmanager),
    java: Boolean(which('java'))
  };
}

function which(bin) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? String(result.stdout || '').split(/\r?\n/).find(Boolean) : null;
}
