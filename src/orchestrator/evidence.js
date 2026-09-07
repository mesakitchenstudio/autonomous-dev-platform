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
  AI_REVIEWED: 'AI_REVIEWED',
  MOCK: 'MOCK'
});

export const VerificationLevel = Object.freeze({
  MOCK: 'MOCK',
  SELF_REPORTED: 'SELF_REPORTED',
  PLATFORM_VERIFIED: 'PLATFORM_VERIFIED'
});

export const AspectMaturity = Object.freeze({
  MOCK: 'MOCK',
  NOT_RUN: 'NOT_RUN',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  SELF_REPORTED: 'SELF_REPORTED',
  PLATFORM_VERIFIED: 'PLATFORM_VERIFIED',
  AI_REVIEWED: 'AI_REVIEWED'
});

export const VerificationAspectName = Object.freeze({
  GIT: 'git',
  TECHNICAL: 'technical',
  RUNTIME: 'runtime',
  FUNCTIONAL: 'functional',
  ACCESSIBILITY: 'accessibility',
  VISUAL: 'visual',
  SECURITY: 'security',
  PROVISIONING: 'provisioning'
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
  const evidence = {
    verificationLevel,
    execution: aspect(input.execution || { status: EvidenceStatus.UNKNOWN, provenance: provenanceForLevel(verificationLevel) }),
    git: aspect(input.git),
    build: aspect(input.build),
    tests: aspect(input.tests),
    lint: aspect(input.lint),
    runtime: aspect(input.runtime),
    functional: aspect(input.functional),
    accessibility: aspect(input.accessibility),
    visual: aspect(input.visual),
    security: aspect(input.security),
    provisioning: aspect(input.provisioning),
    artifacts: Array.isArray(input.artifacts) ? input.artifacts : [],
    warnings: Array.isArray(input.warnings) ? input.warnings.map(String) : [],
    errors: Array.isArray(input.errors) ? input.errors.map(String) : [],
    source: input.source && typeof input.source === 'object' ? input.source : null
  };
  evidence.aspects = input.aspects && typeof input.aspects === 'object'
    ? input.aspects
    : deriveVerificationAspects(evidence);
  return evidence;
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
    functional: { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.MOCK, detail: 'Functional scenarios were not independently executed.' },
    accessibility: { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.MOCK, detail: 'Accessibility was not independently checked.' },
    visual: { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.MOCK, detail: 'Visual review was not independently performed.' },
    security: { status: EvidenceStatus.NOT_RUN, provenance: EvidenceProvenance.MOCK, detail: 'Security was not independently verified.' },
    provisioning: { status: EvidenceStatus.NOT_APPLICABLE, provenance: EvidenceProvenance.MOCK, detail: 'Demo provisioning is simulated.' },
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
  return ['execution', 'git', 'build', 'tests', 'lint', 'runtime', 'functional', 'accessibility', 'security']
    .some(key => evidence[key]?.provenance === EvidenceProvenance.PLATFORM_VERIFIED);
}

export function deriveVerificationAspects(evidence = {}) {
  const maturity = (item, fallback = AspectMaturity.NOT_RUN) => {
    if (!item) return fallback;
    if (item.status === EvidenceStatus.NOT_APPLICABLE) return AspectMaturity.NOT_APPLICABLE;
    if (item.provenance === EvidenceProvenance.MOCK || evidence.verificationLevel === VerificationLevel.MOCK) return AspectMaturity.MOCK;
    if (item.status === EvidenceStatus.NOT_RUN) return AspectMaturity.NOT_RUN;
    if (item.provenance === EvidenceProvenance.PLATFORM_VERIFIED) return AspectMaturity.PLATFORM_VERIFIED;
    if (item.provenance === EvidenceProvenance.AI_REVIEWED) return AspectMaturity.AI_REVIEWED;
    if (item.provenance === EvidenceProvenance.CURSOR_REPORTED) return AspectMaturity.SELF_REPORTED;
    return fallback;
  };
  const technical = [evidence.build, evidence.tests, evidence.lint]
    .map(item => maturity(item))
    .find(value => value === AspectMaturity.PLATFORM_VERIFIED || value === AspectMaturity.SELF_REPORTED || value === AspectMaturity.MOCK)
    || maturity(evidence.build);
  return {
    git: maturity(evidence.git),
    technical,
    runtime: maturity(evidence.runtime),
    functional: maturity(evidence.functional || evidence.runtime),
    accessibility: maturity(evidence.accessibility),
    visual: maturity(evidence.visual),
    security: maturity(evidence.security),
    provisioning: maturity(evidence.provisioning, AspectMaturity.NOT_APPLICABLE)
  };
}

export function evidenceFromCursorResult(result, { demo = false } = {}) {
  if (demo || result?.evidence?.verificationLevel === VerificationLevel.MOCK) {
    return mockEvidence({ prompt: result?.evidence?.source?.promptPreview });
  }
  if (isCanonicalEvidence(result?.evidence)) return normalizeEvidence(result.evidence, { demo });
  return normalizeEvidence(result, { demo });
}
