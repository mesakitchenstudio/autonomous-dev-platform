import { ProvisionerId, SupportStatus } from '../kinds.js';
import { ErrorCode, PlatformError } from '../../orchestrator/errors.js';
import { baseProvisioner } from './base.js';

export const UnsupportedProvisioner = {
  ...baseProvisioner({
    id: ProvisionerId.UNSUPPORTED,
    supportStatus: SupportStatus.UNSUPPORTED,
    requiredCapabilities: [],
    templateFor: () => null
  }),
  async provision({ plan }) {
    throw new PlatformError({
      code: ErrorCode.PROVISIONING_UNSUPPORTED,
      message: `No approved provisioner can implement ${plan?.profile?.framework || 'the requested stack'}.`,
      phase: 'PROJECT_PROVISIONING',
      retryable: false,
      details: { profile: plan?.profile || null }
    });
  }
};
