import test from 'node:test';
import assert from 'node:assert/strict';
import { canEnterOwnerReview } from '../src/orchestrator/gate.js';
import { specFixture, createEvidence, EvidenceStatus, EvidenceProvenance, VerificationLevel, reviewComplete, finalComplete } from './helpers.js';

function baseProject(overrides = {}) {
  return {
    iteration: 1,
    error: null,
    council: {
      discovery: { spec: specFixture() },
      review1: reviewComplete('COMPLETE'),
      final: finalComplete('COMPLETE')
    },
    cursorRuns: [{
      iteration: 1,
      evidence: createEvidence({
        verificationLevel: VerificationLevel.SELF_REPORTED,
        execution: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.CURSOR_REPORTED }
      })
    }],
    ...overrides
  };
}

test('Chair COMPLETE alone cannot make a project ready', () => {
  const gate = canEnterOwnerReview({
    iteration: 0,
    council: { discovery: { spec: specFixture() }, final: finalComplete('COMPLETE') },
    cursorRuns: []
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.reasons.includes('no_cursor_execution'));
});

test('Cursor output alone cannot make a project ready', () => {
  const gate = canEnterOwnerReview({
    iteration: 1,
    council: { discovery: { spec: specFixture() } },
    cursorRuns: [{
      iteration: 1,
      evidence: createEvidence({
        verificationLevel: VerificationLevel.SELF_REPORTED,
        execution: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.CURSOR_REPORTED }
      })
    }]
  });
  assert.equal(gate.ok, false);
  assert.ok(gate.reasons.includes('review_not_complete'));
  assert.ok(gate.reasons.includes('final_verification_not_complete'));
});

test('missing evidence blocks READY', () => {
  const project = baseProject({
    cursorRuns: [{ iteration: 1, result: { output: 'looks done' } }]
  });
  const gate = canEnterOwnerReview(project);
  assert.equal(gate.ok, false);
  assert.ok(gate.reasons.includes('missing_canonical_evidence'));
});

test('failed execution evidence blocks READY', () => {
  const project = baseProject({
    cursorRuns: [{
      iteration: 1,
      evidence: createEvidence({
        verificationLevel: VerificationLevel.SELF_REPORTED,
        execution: { status: EvidenceStatus.FAIL, provenance: EvidenceProvenance.CURSOR_REPORTED }
      })
    }]
  });
  const gate = canEnterOwnerReview(project);
  assert.equal(gate.ok, false);
  assert.ok(gate.reasons.includes('execution_failed'));
});

test('valid Phase-1 evidence plus Council decisions permits READY', () => {
  const gate = canEnterOwnerReview(baseProject());
  assert.equal(gate.ok, true);
  assert.equal(gate.verificationLevel, VerificationLevel.SELF_REPORTED);
});

test('max iterations never produces READY', () => {
  const gate = canEnterOwnerReview(baseProject({ iteration: 13 }), { maxIterations: 12 });
  assert.equal(gate.ok, false);
  assert.ok(gate.reasons.includes('iteration_limit_exceeded'));
});
