import './security-env.js';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { JsonStore, createProjectRecord } from '../src/storage/json-store.js';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { ProjectState } from '../src/orchestrator/states.js';
import { createEvidence, EvidenceProvenance, EvidenceStatus, VerificationLevel, mockEvidence } from '../src/orchestrator/evidence.js';

export async function tempStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adp-test-'));
  const store = new JsonStore(dir);
  await store.init();
  return { store, dir };
}

export async function awaitJob(orchestrator, store, id, timeoutMs = 4000) {
  const start = Date.now();
  while (orchestrator.running.has(id) && Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 15));
  }
  return store.get(id);
}

export async function waitFor(store, id, predicate, timeoutMs = 3000) {
  const start = Date.now();
  let project;
  while (Date.now() - start < timeoutMs) {
    try {
      project = await store.get(id);
      if (predicate(project)) return project;
    } catch (error) {
      if (!(error instanceof SyntaxError) && error?.code !== 'ENOENT') throw error;
    }
    await new Promise(r => setTimeout(r, 15));
  }
  throw new Error(`Timed out waiting for project condition (state=${project?.state})`);
}

export function specFixture() {
  return {
    productName: 'Test App',
    productSummary: 'Test',
    projectType: 'backend',
    requirements: ['Do the thing'],
    architecture: { platform: 'SERVER', technology: ['node'], components: ['api'] },
    architectureChoice: {
      category: 'BACKEND',
      platform: 'SERVER',
      framework: 'NODE_BACKEND',
      language: 'JAVASCRIPT',
      ui: false,
      backendRequired: true,
      databaseRequired: false,
      rationale: 'Unit-test default uses the versioned Node backend template.'
    },
    workPackages: [{ id: 'w1', title: 'Implement', acceptanceCriteria: ['Works'] }],
    cursorPrompt: 'Implement the test application completely.',
    ownerAssumptions: []
  };
}

export function reviewComplete(decision = 'COMPLETE') {
  return {
    reviews: [],
    decision: { decision, findings: [], nextCursorPrompt: decision === 'CHANGES_REQUIRED' ? 'Fix findings' : null, summary: 'ok' },
    chair: 'openai',
    failures: []
  };
}

export function finalComplete(decision = 'COMPLETE') {
  return {
    reviews: [],
    decision: { decision, blockingFindings: [], nextCursorPrompt: decision === 'CHANGES_REQUIRED' ? 'Fix blockers' : null, summary: 'ok' },
    chair: 'openai',
    failures: []
  };
}

export class FakeCouncil {
  constructor({ review = 'COMPLETE', final = 'COMPLETE', failDiscover = false, failChair = false, failReview = false } = {}) {
    this.reviewDecision = review;
    this.finalDecision = final;
    this.failDiscover = failDiscover;
    this.failChair = failChair;
    this.failReview = failReview;
    this.discoverCalls = 0;
    this.reviewCalls = 0;
    this.finalCalls = 0;
  }
  async discover() {
    this.discoverCalls += 1;
    if (this.failDiscover) throw new Error('discover failed');
    if (this.failChair) throw Object.assign(new Error('chair failed'), { code: 'CHAIR_FAILURE' });
    return { analyses: [{ provider: 'openai', output: { perspective: 'openai' } }], spec: specFixture(), chair: 'openai', failures: [] };
  }
  async review() {
    this.reviewCalls += 1;
    if (this.failReview) throw new Error('review chair failed');
    return reviewComplete(this.reviewDecision);
  }
  async finalVerify() {
    this.finalCalls += 1;
    return finalComplete(this.finalDecision);
  }
  async resolveArchitecture() {
    return {
      category: 'BACKEND',
      platform: 'SERVER',
      framework: 'NODE_BACKEND',
      language: 'JAVASCRIPT',
      ui: false,
      backendRequired: true,
      databaseRequired: false,
      rationale: 'Test architecture resolution stays on the platform Node template.'
    };
  }
  async visualReview() {
    return {
      reviewers: [],
      findings: [],
      chair: { provider: 'fake', decision: { decision: 'COMPLETE', blockingFindings: [], summary: 'ok' } },
      decision: { decision: 'COMPLETE', blockingFindings: [], summary: 'ok' },
      usage: []
    };
  }
}

export class FakeCursor {
  constructor({ fail = false, hang = false, evidence, executionFail = false } = {}) {
    this.fail = fail;
    this.hang = hang;
    this.executionFail = executionFail;
    this.evidence = evidence;
    this.runs = 0;
  }
  async run({ prompt, sessionId }) {
    this.runs += 1;
    if (this.hang) await new Promise(() => {});
    if (this.fail) throw new Error('cursor died');
    const evidence = this.evidence || createEvidence({
      verificationLevel: VerificationLevel.SELF_REPORTED,
      execution: {
        status: this.executionFail ? EvidenceStatus.FAIL : EvidenceStatus.PASS,
        provenance: EvidenceProvenance.CURSOR_REPORTED,
        detail: 'fake'
      }
    });
    return { sessionId: sessionId || 's1', stopReason: this.executionFail ? 'ERROR' : 'end_turn', output: `done:${prompt}`, updates: [], stderr: '', evidence };
  }
}

export class FakeWorkspace {
  async ensure(project) {
    return project.repository?.workspacePath || project.projectPath || '/tmp/fake-workspace';
  }
}

export function orchestratorFor(store, { council, cursor, maxIterations = 12, demo = false, cursorTimeoutMs = 2000 } = {}) {
  return new Orchestrator({
    store,
    council: council || new FakeCouncil(),
    cursor: cursor || new FakeCursor(),
    workspace: new FakeWorkspace(),
    maxIterations,
    demo,
    cursorTimeoutMs
  });
}

export async function seedProject(store, overrides = {}) {
  const project = createProjectRecord({ idea: overrides.idea || 'Build a test app', projectPath: overrides.projectPath || '/repo', demo: overrides.demo });
  Object.assign(project, overrides);
  await store.save(project);
  return project;
}

export function verificationNotApplicable(iteration = 1) {
  return {
    id: `verify-${iteration}`,
    iteration,
    status: 'PASS',
    checkpointSha: 'none',
    completedAt: new Date().toISOString(),
    policy: {
      build: 'NOT_APPLICABLE',
      tests: 'NOT_APPLICABLE',
      lint: 'NOT_APPLICABLE',
      staticAnalysis: 'NOT_APPLICABLE',
      security: 'OPTIONAL'
    },
    steps: [],
    blockingFailures: [],
    problems: []
  };
}

export function readyProjectShape() {
  return {
    state: ProjectState.SPECIFICATION_READY,
    council: { discovery: { analyses: [], spec: specFixture(), chair: 'openai', failures: [] } },
    activePrompt: specFixture().cursorPrompt,
    iteration: 0
  };
}

export { ProjectState, createEvidence, EvidenceProvenance, EvidenceStatus, VerificationLevel, mockEvidence };
export { OperationType } from '../src/orchestrator/checkpoint.js';
