import { SecurityEventType } from './kinds.js';
import { recordSecurityEvent } from './events.js';

const PATTERNS = [
  { id: 'ignore_instructions', re: /ignore (all )?(previous|prior|platform) instructions/i, risk: 'HIGH' },
  { id: 'exfiltrate_env', re: /upload.{0,80}(environment variables|api[_-]?key|secret|credential)/i, risk: 'HIGH' },
  { id: 'read_control_plane_secret', re: /read.{0,60}(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|XAI_API_KEY|CURSOR_API_KEY|DATABASE_URL|SECRET_MASTER_KEY)/i, risk: 'HIGH' },
  { id: 'disable_security', re: /disable (the )?(security|sandbox|authentication|authn|authz)/i, risk: 'HIGH' },
  { id: 'force_push', re: /force\s+push|git\s+push\s+[^\n]*--force/i, risk: 'HIGH' },
  { id: 'home_access', re: /(user home|~\/|\bUSERPROFILE\b|\b\/home\/).{0,40}(read|upload|copy|exfil)/i, risk: 'HIGH' },
  { id: 'arbitrary_payload', re: /\b(curl|wget|powershell|pwsh|cmd|bash)\b.{0,100}(secret|control-plane|api[_-]?key|environment)/i, risk: 'HIGH' },
  { id: 'control_plane_files', re: /alter (control-plane|platform) files|edit .{0,40}(src\/server|src\/auth|src\/secrets)/i, risk: 'HIGH' }
];

export function classifyRepositoryInstruction(text, source = 'repository') {
  const body = String(text || '');
  const matches = PATTERNS.filter(item => item.re.test(body)).map(item => ({
    id: item.id,
    risk: item.risk,
    source
  }));
  return {
    untrusted: true,
    highRisk: matches.length > 0,
    matches,
    overridesPolicy: false
  };
}

export function auditRepositoryTexts(files = [], { projectId, store } = {}) {
  const findings = [];
  for (const file of files) {
    const classified = classifyRepositoryInstruction(file.contents || file.text || '', file.path || file.source || 'repository');
    if (!classified.highRisk) continue;
    findings.push({
      path: file.path || file.source || 'unknown',
      kind: 'PROMPT_INJECTION',
      untrusted: true,
      matches: classified.matches,
      proofOfMalice: false
    });
    recordSecurityEvent(SecurityEventType.PROMPT_INJECTION_DETECTED, {
      projectId,
      path: file.path || file.source || 'unknown',
      matches: classified.matches.map(item => item.id)
    }, { store, projectId });
  }
  return {
    untrusted: true,
    highRisk: findings.length > 0,
    findings
  };
}

export const POLICY_PRECEDENCE = Object.freeze({
  PLATFORM_SECURITY_POLICY: 100,
  OWNER_PRODUCT_INTENT: 80,
  COUNCIL_AUTHORITATIVE_SPEC: 60,
  CURSOR_TASK: 40,
  REPOSITORY_CONTENT: 10
});

export function repositoryCannotOverridePolicy() {
  return POLICY_PRECEDENCE.PLATFORM_SECURITY_POLICY > POLICY_PRECEDENCE.REPOSITORY_CONTENT;
}
