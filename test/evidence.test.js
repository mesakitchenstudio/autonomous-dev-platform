import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidence, mockEvidence, normalizeEvidence, evidenceFromCursorResult, EvidenceProvenance, VerificationLevel, EvidenceStatus } from '../src/orchestrator/evidence.js';

test('mock evidence is clearly MOCK', () => {
  const evidence = mockEvidence({ prompt: 'build it' });
  assert.equal(evidence.verificationLevel, VerificationLevel.MOCK);
  assert.equal(evidence.execution.provenance, EvidenceProvenance.MOCK);
  assert.notEqual(evidence.build.status, EvidenceStatus.PASS);
  assert.ok(evidence.warnings.some(w => /MOCK/.test(w)));
});

test('self-reported evidence cannot masquerade as PLATFORM_VERIFIED', () => {
  const evidence = normalizeEvidence({
    verificationLevel: VerificationLevel.PLATFORM_VERIFIED,
    execution: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.CURSOR_REPORTED }
  });
  assert.equal(evidence.verificationLevel, VerificationLevel.SELF_REPORTED);
  assert.notEqual(evidence.execution.provenance, EvidenceProvenance.PLATFORM_VERIFIED);
});

test('cursor result without schema becomes SELF_REPORTED', () => {
  const evidence = evidenceFromCursorResult({ stopReason: 'end_turn', output: 'changed files' });
  assert.equal(evidence.verificationLevel, VerificationLevel.SELF_REPORTED);
  assert.equal(evidence.execution.provenance, EvidenceProvenance.CURSOR_REPORTED);
});

test('demo flag forces MOCK even if raw evidence claims verified', () => {
  const evidence = evidenceFromCursorResult({
    evidence: createEvidence({
      verificationLevel: VerificationLevel.PLATFORM_VERIFIED,
      execution: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.PLATFORM_VERIFIED }
    })
  }, { demo: true });
  assert.equal(evidence.verificationLevel, VerificationLevel.MOCK);
});
