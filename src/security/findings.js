import crypto from 'node:crypto';
import { SecurityFindingKind } from './kinds.js';

export function createSecurityFinding({
  kind = SecurityFindingKind.PROJECT_SECURITY_DEFECT,
  severity = 'HIGH',
  code,
  message,
  projectId,
  blocking = true
} = {}) {
  return {
    id: crypto.randomUUID(),
    kind,
    severity,
    code: code || kind,
    message,
    projectId: projectId || null,
    blocking,
    at: new Date().toISOString()
  };
}

export function dependencySeverityPolicy(advisories = [], { profile } = {}) {
  const blocking = [];
  for (const item of advisories) {
    const severity = String(item.severity || item.level || '').toUpperCase();
    if (severity === 'CRITICAL') blocking.push({ ...item, blocking: true, kind: SecurityFindingKind.DEPENDENCY });
    else if (severity === 'HIGH' && profile === 'HARDENED') blocking.push({ ...item, blocking: true, kind: SecurityFindingKind.DEPENDENCY });
  }
  return {
    reviewed: advisories.length,
    blocking,
    policy: 'critical_always; high_when_hardened; others_informational'
  };
}

export function classifySecurityFailure(error) {
  if (error?.code === 'SANDBOX_INFRASTRUCTURE_UNAVAILABLE') {
    return SecurityFindingKind.INFRASTRUCTURE_SECURITY_UNAVAILABLE;
  }
  return SecurityFindingKind.PROJECT_SECURITY_DEFECT;
}
