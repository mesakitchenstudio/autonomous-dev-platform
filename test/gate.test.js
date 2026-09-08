import test from 'node:test';
import assert from 'node:assert/strict';
import { canCompleteAutonomousWork, canEnterOwnerReview } from '../src/orchestrator/gate.js';
import { specFixture, createEvidence, EvidenceStatus, EvidenceProvenance, VerificationLevel, reviewComplete, finalComplete, verificationNotApplicable } from './helpers.js';
import { verificationSetHash } from '../src/delivery/lineage.js';
import { prepareDeliverySnapshot } from '../src/delivery/prepare.js';
import { ErrorCode } from '../src/orchestrator/errors.js';
import { evidenceFromVisual } from '../src/visual/pipeline.js';
import { mockEvidence } from '../src/orchestrator/evidence.js';

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

function attachReadyDelivery(project, sha) {
  project.cursorRuns[0].checkpointSha = sha;
  if (project.verificationRuns?.[0]) project.verificationRuns[0].checkpointSha = sha;
  const hash = verificationSetHash(project);
  project.deliveries = [{
    status: 'READY',
    current: true,
    checkpointSha: sha,
    verificationSetHash: hash,
    manifest: { files: 1 },
    manifestHash: 'aa'.repeat(32),
    ownerReport: 'Owner report',
    verificationReport: 'Verification report',
    secretScan: 'PASS',
    artifacts: [{ kind: 'SOURCE_ARCHIVE', sha256: 'bb'.repeat(32) }]
  }];
  return project;
}

test('non-demo MOCK evidence and mock checkpoint cannot enter owner review', () => {
  const project = baseProject({
    demo: false,
    verificationLevel: VerificationLevel.MOCK,
    evidence: createEvidence({
      verificationLevel: VerificationLevel.MOCK,
      execution: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.MOCK }
    })
  });
  project.cursorRuns[0].evidence = project.evidence;
  attachReadyDelivery(project, 'mock:real-project:1');
  const gate = canEnterOwnerReview(project);
  assert.equal(gate.ok, false);
  assert.ok(gate.reasons.includes('mock_evidence_not_allowed_for_real_project'));
  assert.ok(gate.reasons.includes('mock_checkpoint_not_allowed_for_real_project'));
});

test('Chair COMPLETE cannot override mock rejection for a real project', () => {
  const project = baseProject({
    demo: false,
    council: {
      discovery: { spec: specFixture() },
      review1: reviewComplete('COMPLETE'),
      final: finalComplete('COMPLETE')
    }
  });
  project.evidence = createEvidence({
    verificationLevel: VerificationLevel.MOCK,
    execution: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.MOCK }
  });
  project.cursorRuns[0].evidence = project.evidence;
  attachReadyDelivery(project, 'mock:chair-override:1');
  const gate = canEnterOwnerReview(project);
  assert.equal(gate.ok, false);
  assert.ok(gate.reasons.includes('mock_evidence_not_allowed_for_real_project'));
});

test('demo project with MOCK evidence can still enter owner review', () => {
  const project = baseProject({
    demo: true,
    evidence: mockEvidence({ prompt: 'demo' })
  });
  project.cursorRuns[0].evidence = project.evidence;
  attachReadyDelivery(project, 'mock:demo-project:1');
  const gate = canEnterOwnerReview(project);
  assert.equal(gate.ok, true);
});

test('real PLATFORM_VERIFIED and AI_REVIEWED evidence can still enter owner review', () => {
  const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const project = baseProject({
    demo: false,
    evidence: createEvidence({
      verificationLevel: VerificationLevel.PLATFORM_VERIFIED,
      execution: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.CURSOR_REPORTED },
      build: { status: EvidenceStatus.NOT_APPLICABLE, provenance: EvidenceProvenance.PLATFORM_VERIFIED },
      tests: { status: EvidenceStatus.NOT_APPLICABLE, provenance: EvidenceProvenance.PLATFORM_VERIFIED },
      visual: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.AI_REVIEWED }
    }),
    visualReviewRuns: [{
      iteration: 1,
      status: 'PASS',
      decision: 'COMPLETE',
      aiReviewed: true,
      heuristicOnly: false,
      blockingFindings: [],
      chair: { provider: 'openai', decision: { decision: 'COMPLETE', blockingFindings: [], summary: 'ok' } },
      checkpointSha: sha
    }]
  });
  project.cursorRuns[0].evidence = project.evidence;
  attachReadyDelivery(project, sha);
  const gate = canEnterOwnerReview(project);
  assert.equal(gate.ok, true, gate.reasons.join(','));
});

test('deterministic visual heuristics cannot satisfy required AI visual review', () => {
  const sha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const project = baseProject({
    demo: false,
    runtimePolicy: { runtime: 'REQUIRED', visual: 'REQUIRED' },
    runtimeRuns: [{
      id: 'r1',
      iteration: 1,
      checkpointSha: sha,
      status: 'PASS',
      completedAt: new Date().toISOString(),
      policy: { runtime: 'REQUIRED', visual: 'REQUIRED' },
      screenshots: [{ sha256: 's', checkpointSha: sha }]
    }],
    visualReviewRuns: [{
      id: 'v1',
      iteration: 1,
      runtimeRunId: 'r1',
      checkpointSha: sha,
      status: 'PASS',
      decision: 'COMPLETE',
      heuristicOnly: true,
      aiReviewed: false,
      blockingFindings: [],
      chair: { provider: 'deterministic', decision: { decision: 'COMPLETE', blockingFindings: [], summary: 'heuristic' } }
    }]
  });
  project.cursorRuns[0].checkpointSha = sha;
  attachReadyDelivery(project, sha);
  const gate = canEnterOwnerReview(project);
  assert.equal(gate.ok, false);
  assert.ok(gate.reasons.includes('deterministic_visual_not_allowed_for_required_ai_review'));
  const evidence = evidenceFromVisual(project, project.visualReviewRuns[0], project.runtimeRuns[0]);
  assert.notEqual(evidence.visual.provenance, EvidenceProvenance.AI_REVIEWED);
  assert.notEqual(evidence.visual.status, EvidenceStatus.PASS);
});

test('real delivery preparation rejects a mock checkpoint', async () => {
  const project = baseProject({
    id: '00000000-0000-4000-8000-aaaaaaaaaaaa',
    demo: false
  });
  project.cursorRuns[0].checkpointSha = 'mock:real-delivery:1';
  await assert.rejects(
    () => prepareDeliverySnapshot(project, { workspacePath: project.projectPath }),
    err => err.code === ErrorCode.DELIVERY_LINEAGE_INVALID
      && /mock_checkpoint_not_allowed_for_real_project/.test(err.message)
  );
});

