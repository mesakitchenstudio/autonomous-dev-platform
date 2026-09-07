import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { APPROVED_REGISTRIES } from './kinds.js';
import { SecurityProfile } from '../security/kinds.js';

export const SANDBOX_IMAGES = Object.freeze({
  node: {
    id: 'node',
    image: 'docker.io/library/node:22-bookworm',
    digest: null,
    toolchains: ['node', 'npm', 'npx'],
    networkPolicy: 'PACKAGE_REGISTRY_ONLY'
  },
  python: {
    id: 'python',
    image: 'docker.io/library/python:3.12-bookworm',
    digest: null,
    toolchains: ['python', 'pip'],
    networkPolicy: 'PACKAGE_REGISTRY_ONLY'
  },
  jdk: {
    id: 'jdk',
    image: 'docker.io/library/eclipse-temurin:21-jdk',
    digest: null,
    toolchains: ['java', 'javac'],
    networkPolicy: 'PACKAGE_REGISTRY_ONLY'
  },
  android: {
    id: 'android',
    image: 'docker.io/library/eclipse-temurin:21-jdk',
    digest: null,
    toolchains: ['java', 'android'],
    networkPolicy: 'PACKAGE_REGISTRY_ONLY'
  },
  flutter: {
    id: 'flutter',
    image: 'ghcr.io/cirruslabs/flutter:stable',
    digest: null,
    toolchains: ['flutter', 'dart'],
    networkPolicy: 'PACKAGE_REGISTRY_ONLY'
  },
  rust: {
    id: 'rust',
    image: 'docker.io/library/rust:1-bookworm',
    digest: null,
    toolchains: ['cargo', 'rustc'],
    networkPolicy: 'PACKAGE_REGISTRY_ONLY'
  },
  go: {
    id: 'go',
    image: 'docker.io/library/golang:1.23-bookworm',
    digest: null,
    toolchains: ['go'],
    networkPolicy: 'PACKAGE_REGISTRY_ONLY'
  },
  dotnet: {
    id: 'dotnet',
    image: 'mcr.microsoft.com/dotnet/sdk:8.0',
    digest: null,
    toolchains: ['dotnet'],
    networkPolicy: 'PACKAGE_REGISTRY_ONLY'
  }
});

export function imageProfileFor(toolchain = 'node') {
  const key = String(toolchain || 'node').toLowerCase();
  return SANDBOX_IMAGES[key] || SANDBOX_IMAGES.node;
}

export function assertApprovedImage(reference, { profile } = {}) {
  const ref = String(reference || '');
  if (!ref) {
    throw new PlatformError({
      code: ErrorCode.SANDBOX_VIOLATION,
      message: 'Sandbox image reference is required.',
      phase: 'SANDBOX',
      retryable: false
    });
  }
  if (profile === SecurityProfile.HARDENED && /:latest$/i.test(ref) && process.env.SANDBOX_ALLOW_LATEST !== 'true') {
    throw new PlatformError({
      code: ErrorCode.SANDBOX_VIOLATION,
      message: 'Hardened policy refuses floating :latest image tags.',
      phase: 'SANDBOX',
      retryable: false
    });
  }
  const host = ref.split('/')[0];
  const known = Object.values(SANDBOX_IMAGES).some(item => item.image === ref || ref.startsWith(item.image.split(':')[0]));
  const registryOk = APPROVED_REGISTRIES.some(item => host === item || ref.startsWith(`${item}/`) || ref.startsWith('docker.io/') || ref.startsWith('library/') || !ref.includes('/'));
  if (!known && !registryOk) {
    throw new PlatformError({
      code: ErrorCode.SANDBOX_VIOLATION,
      message: 'Sandbox refused an image outside the approved registry allowlist.',
      phase: 'SANDBOX',
      retryable: false
    });
  }
  return true;
}

export function recordImageDigest(reference, digest) {
  return { image: reference, digest: digest || null };
}
