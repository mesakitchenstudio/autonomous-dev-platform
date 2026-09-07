import fs from 'node:fs';
import path from 'node:path';
import { isProtectedSecretFile } from '../git/secrets.js';
import { knownBrokerValues } from './broker-values.js';

const CONTENT_RULES = [
  { id: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, confidence: 'high' },
  { id: 'openai_key', re: /\bsk-[A-Za-z0-9]{20,}\b/, confidence: 'high' },
  { id: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/, confidence: 'high' },
  { id: 'google_key', re: /\bAIza[0-9A-Za-z_-]{20,}\b/, confidence: 'high' },
  { id: 'xai_key', re: /\bxai-[A-Za-z0-9]{20,}\b/, confidence: 'high' },
  { id: 'github_pat', re: /\b(ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/, confidence: 'high' },
  { id: 'url_password', re: /\b[a-z]+:\/\/[^:\s\/]+:[^@\s\/]+@/i, confidence: 'high' },
  { id: 'assignment', re: /\b(API_KEY|SECRET|PASSWORD|TOKEN)\s*[:=]\s*['"][^'"]{8,}['"]/i, confidence: 'medium' }
];

export function scanTextForSecrets(text, filePath = 'unknown') {
  const findings = [];
  const body = String(text || '');
  const name = path.basename(filePath || '');
  if (isProtectedSecretFile(filePath) && !/\.(example|sample|template)$/i.test(name)) {
    findings.push({ id: 'protected_env_file', path: filePath, confidence: 'high', rule: 'filename' });
  }
  for (const rule of CONTENT_RULES) {
    if (rule.re.test(body)) {
      findings.push({ id: rule.id, path: filePath, confidence: rule.confidence, rule: 'content' });
    }
  }
  for (const value of knownBrokerValues()) {
    if (value && body.includes(value)) {
      findings.push({ id: 'broker_released_value', path: filePath, confidence: 'high', rule: 'broker' });
    }
  }
  return findings;
}

export function scanFilesForSecrets(files = []) {
  const findings = [];
  for (const file of files) {
    const filePath = file.path || file;
    let contents = file.contents;
    if (contents == null && filePath && fs.existsSync(filePath)) {
      try { contents = fs.readFileSync(filePath, 'utf8'); } catch { contents = ''; }
    }
    findings.push(...scanTextForSecrets(contents, filePath));
  }
  return findings.filter(item => item.confidence === 'high' || item.confidence === 'medium');
}

export function highConfidenceSecretFindings(findings = []) {
  return findings.filter(item => item.confidence === 'high');
}
