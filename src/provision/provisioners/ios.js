import os from 'node:os';
import { ProvisionerId, SupportStatus } from '../kinds.js';
import { templateById } from '../templates.js';
import { WorkerCapability } from '../../capabilities/kinds.js';
import { commandVersion } from '../versions.js';
import { ErrorCode, PlatformError } from '../../orchestrator/errors.js';
import { baseProvisioner } from './base.js';

export const IosProvisioner = {
  ...baseProvisioner({
    id: ProvisionerId.IOS,
    supportStatus: () => {
      if (os.platform() !== 'darwin' || !commandVersion('xcodebuild', ['-version']).available) {
        return SupportStatus.DETECTION_ONLY;
      }
      return SupportStatus.SUPPORTED_IF_TOOLCHAIN_AVAILABLE;
    },
    requiredCapabilities: [WorkerCapability.MACOS, WorkerCapability.XCODE],
    templateFor: () => templateById('mobile.ios.native')
  }),
  async provision() {
    throw new PlatformError({
      code: ErrorCode.IOS_PROVISIONING_UNAVAILABLE,
      message: os.platform() === 'darwin'
        ? 'iOS native provisioning is not live-tested on this worker and will not fabricate an Xcode project.'
        : 'IOS PROVISIONING — NOT VERIFIED — MACOS/XCODE REQUIRED',
      phase: 'PROJECT_PROVISIONING',
      retryable: true,
      details: { platform: os.platform() }
    });
  }
};
