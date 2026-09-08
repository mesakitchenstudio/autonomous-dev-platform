import test from 'node:test';
import assert from 'node:assert/strict';
import { canCompleteAutonomousWork, canEnterOwnerReview } from '../src/orchestrator/gate.js';
import { specFixture, createEvidence, EvidenceStatus, EvidenceProvenance, VerificationLevel, reviewComplete, finalComplete, verificationNotApplicable } from './helpers.js';

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
        execution: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.CURSOR_REPORTED },
        build: { status: EvidenceStatus.NOT_APPLICABLE, provenance: EvidenceProvenance.PLATFORM_VERIFIED },
        tests: { status: EvidenceStatus.NOT_APPLICABLE, provenance: EvidenceProvenance.PLATFORM_VERIFIED }
      })
    }],
    verificationRuns: [verificationNotApplicable(1)],
    projectPath: '/repo',
    repository: { repositoryType: 'EXISTING_LOCAL' },
    provisioning: { status: 'NOT_APPLICABLE' },
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

test('valid Phase-1 evidence plus Council decisions permits delivery preparation', () => {
  const gate = canCompleteAutonomousWork(baseProject());
  assert.equal(gate.ok, true);
  assert.equal(gate.verificationLevel, VerificationLevel.SELF_REPORTED);
});

test('owner review also requires a READY delivery snapshot', () => {
  const without = canEnterOwnerReview(baseProject());
  assert.equal(without.ok, false);
  assert.ok(without.reasons.includes('missing_delivery_snapshot'));
});

test('required platform FAIL and NOT_RUN block READY', () => {
  const failed = baseProject({
    evidence: createEvidence({
      verificationLevel: VerificationLevel.PLATFORM_VERIFIED,
      execution: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.CURSOR_REPORTED },
      build: { status: EvidenceStatus.FAIL, provenance: EvidenceProvenance.PLATFORM_VERIFIED },
      tests: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.PLATFORM_VERIFIED }
    }),
    verificationRuns: [{
      ...verificationNotApplicable(1),
      policy: { build: 'REQUIRED', tests: 'REQUIRED', lint: 'OPTIONAL', staticAnalysis: 'NOT_APPLICABLE', security: 'OPTIONAL' },
      status: 'FAIL'
    }]
  });
  failed.cursorRuns[0].evidence = failed.evidence;
  const failGate = canEnterOwnerReview(failed);
  assert.equal(failGate.ok, false);
  assert.ok(failGate.reasons.includes('required_build_failed'));

  const missing = baseProject({ verificationRuns: [] });
  const missingGate = canEnterOwnerReview(missing);
  assert.equal(missingGate.ok, false);
  assert.ok(missingGate.reasons.includes('required_verification_not_run'));
});

test('Chair cannot override required verification failure', () => {
  const project = baseProject({
    council: {
      discovery: { spec: specFixture() },
      review1: reviewComplete('COMPLETE'),
      final: finalComplete('COMPLETE')
    }
  });
  project.evidence = createEvidence({
    verificationLevel: VerificationLevel.PLATFORM_VERIFIED,
    execution: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.CURSOR_REPORTED },
    tests: { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.PLATFORM_VERIFIED }
  });
  project.cursorRuns[0].evidence = project.evidence;
  project.verificationRuns = [{
    ...verificationNotApplicable(1),
    policy: { build: 'NOT_APPLICABLE', tests: 'REQUIRED', lint: 'OPTIONAL', staticAnalysis: 'NOT_APPLICABLE', security: 'OPTIONAL' }
  }];
  const gate = canEnterOwnerReview(project);
  assert.equal(gate.ok, false);
  assert.ok(gate.reasons.includes('required_tests_not_run'));
});

test('max iterations never produces READY', () => {
  const gate = canEnterOwnerReview(baseProject({ iteration: 13 }), { maxIterations: 12 });
  assert.equal(gate.ok, false);
  assert.ok(gate.reasons.includes('iteration_limit_exceeded'));
});
