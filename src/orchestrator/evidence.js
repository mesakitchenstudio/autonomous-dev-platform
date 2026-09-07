export const EvidenceStatus = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  NOT_RUN: 'NOT_RUN',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  UNKNOWN: 'UNKNOWN'
});

export const EvidenceProvenance = Object.freeze({
  CURSOR_REPORTED: 'CURSOR_REPORTED',
  PLATFORM_VERIFIED: 'PLATFORM_VERIFIED',
  MOCK: 'MOCK'
});

export const VerificationLevel = Object.freeze({
  MOCK: 'MOCK',
  SELF_REPORTED: 'SELF_REPORTED',
  PLATFORM_VERIFIED: 'PLATFORM_VERIFIED'
});

const STATUSES = new Set(Object.values(EvidenceStatus));
const PROVENANCES = new Set(Object.values(EvidenceProvenance));
const LEVELS = new Set(Object.values(VerificationLevel));

function aspect({ status = EvidenceStatus.NOT_RUN, provenance = EvidenceProvenance.CURSOR_REPORTED, detail = null } = {}) {
  return {
    status: STATUSES.has(status) ? status : EvidenceStatus.UNKNOWN,
    provenance: PROVENANCES.has(provenance) ? provenance : EvidenceProvenance.CURSOR_REPORTED,
    detail: detail == null ? null : String(detail)
  };
}

export function createEvidence(input = {}) {
  const verificationLevel = LEVELS.has(input.verificationLevel) ? input.verificationLevel : VerificationLevel.SELF_REPORTED;
  return {
    verificationLevel,
    execution: aspect(input.execution || { status: EvidenceStatus.UNKNOWN, provenance: provenanceForLevel(verificationLevel) }),
    git: aspect(input.git),
    build: aspect(input.build),
    tests: aspect(input.tests),
    lint: aspect(input.lint),
    runtime: aspect(input.runtime),
    visual: aspect(input.visual),
    artifacts: Array.isArray(input.artifacts) ? input.artifacts : [],
    warnings: Array.isArray(input.warnings) ? input.warnings.map(String) : [],
    errors: Array.isArray(input.errors) ? input.errors.map(String) : [],
    source: input.source && typeof input.source === 'object' ? input.source : null
  };
}

function provenanceForLevel(level) {
  if (level === VerificationLevel.MOCK) return EvidenceProvenance.MOCK;
  if (level === VerificationLevel.PLATFORM_VERIFIED) return EvidenceProvenance.PLATFORM_VERIFIED;
  return EvidenceProvenance.CURSOR_REPORTED;
}

export function isCanonicalEvidence(value) {
  return Boolean(
    value
    && LEVELS.has(value.verificationLevel)
    && value.execution
    && STATUSES.has(value.execution.status)
    && PROVENANCES.has(value.execution.provenance)
  );
}

export function mockEvidence({ prompt } = {}) {
  return createEvidence({
    verificationLevel: VerificationLevel.MOCK,
    execution: { status: EvidenceStatus.PASS, provenance: EvidenceProvenance.MOCK, detail: 'Demo Cursor execution completed (simulated).' },
    git: { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.MOCK, detail: 'Git was not inspected in demo mode.' },
    build: { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.MOCK, detail: 'Build was not independently executed.' },
    tests: { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.MOCK, detail: 'Tests were not independently executed.' },
    lint: { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.MOCK, detail: 'Lint was not independently executed.' },
    runtime: { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.MOCK, detail: 'Runtime was not independently verified.' },
    visual: { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.MOCK, detail: 'Visual review was not independently performed.' },
    artifacts: [],
    warnings: ['Demo evidence is MOCK. This run did not build a real application.'],
    source: { promptPreview: prompt ? String(prompt).slice(0, 200) : null, mode: 'demo' }
  });
}

function failStop(stopReason) {
  return ['ERROR', 'CANCELLED', 'EXPIRED', 'error', 'cancelled'].includes(stopReason);
}

export function normalizeEvidence(raw, { demo = false } = {}) {
  if (demo) return mockEvidence({ prompt: raw?.source?.promptPreview || raw?.promptReceived });
  if (isCanonicalEvidence(raw)) {
    const evidence = createEvidence(raw);
    if (evidence.verificationLevel === VerificationLevel.PLATFORM_VERIFIED && !hasPlatformVerifiedAspect(evidence)) {
      evidence.verificationLevel = VerificationLevel.SELF_REPORTED;
    }
    return evidence;
  }
  return createEvidence({
    verificationLevel: VerificationLevel.SELF_REPORTED,
    execution: {
      status: failStop(raw?.stopReason) ? EvidenceStatus.FAIL : (raw ? EvidenceStatus.PASS : EvidenceStatus.UNKNOWN),
      provenance: EvidenceProvenance.CURSOR_REPORTED,
      detail: raw?.output ? String(raw.output).slice(0, 500) : null
    },
    git: raw?.evidence?.git
      ? { status: EvidenceStatus.UNKNOWN, provenance: EvidenceProvenance.CURSOR_REPORTED, detail: JSON.stringify(raw.evidence.git).slice(0, 500) }
      : { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.CURSOR_REPORTED },
    build: { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.CURSOR_REPORTED, detail: 'Build not independently verified in Phase 1.' },
    tests: { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.CURSOR_REPORTED, detail: 'Tests not independently verified in Phase 1.' },
    lint: { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.CURSOR_REPORTED },
    runtime: { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.CURSOR_REPORTED },
    visual: { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.CURSOR_REPORTED },
    artifacts: [],
    warnings: ['Evidence is CURSOR_REPORTED / SELF_REPORTED. The platform did not independently verify build, tests, or runtime.'],
    source: { stopReason: raw?.stopReason || null, runId: raw?.evidence?.runId || null }
  });
}

function hasPlatformVerifiedAspect(evidence) {
  return ['execution', 'git', 'build', 'tests', 'lint', 'runtime', 'visual']
    .some(key => evidence[key]?.provenance === EvidenceProvenance.PLATFORM_VERIFIED);
}

export function evidenceFromCursorResult(result, { demo = false } = {}) {
  if (demo || result?.evidence?.verificationLevel === VerificationLevel.MOCK) {
    return mockEvidence({ prompt: result?.evidence?.source?.promptPreview });
  }
  if (isCanonicalEvidence(result?.evidence)) return normalizeEvidence(result.evidence, { demo });
  return normalizeEvidence(result, { demo });
}
