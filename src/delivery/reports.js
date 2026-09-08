import { EvidenceStatus, VerificationLevel } from '../orchestrator/evidence.js';
import { latestCursorRun, specProductName } from '../orchestrator/gate.js';
import { latestVerificationRun } from '../verify/pipeline.js';
import { latestRuntimeRun } from '../runtime/pipeline.js';
import { latestVisualRun } from '../visual/pipeline.js';
import { latestProvisioningRun } from '../provision/plan.js';
import { PolicyLevel } from '../verify/kinds.js';
import { RuntimeStatus } from '../runtime/kinds.js';
import { ScreenshotClass } from '../security/kinds.js';

export function buildVerificationSummary(project) {
  const evidence = latestCursorRun(project)?.evidence || project.evidence || {};
  const verify = latestVerificationRun(project, latestCursorRun(project)?.iteration);
  const runtime = latestRuntimeRun(project, latestCursorRun(project)?.iteration);
  const visual = latestVisualRun(project, latestCursorRun(project)?.iteration);
  const a11yBlocked = (runtime?.accessibility || []).some(item => item.findings?.some(finding => finding.blocking && finding.status === 'FAIL'));
  return {
    build: card(aspectStatus(evidence.build, verify?.policy?.build)),
    tests: card(aspectStatus(evidence.tests, verify?.policy?.tests)),
    runtime: runtimeCard(runtime, evidence),
    journeys: journeyCard(runtime),
    accessibility: a11yCard(runtime, a11yBlocked),
    visual: visualCard(visual, evidence),
    security: securityCard(project)
  };
}

export function buildOwnerReport(project, { version, checkpointSha, limitations, howToOpen, testingGuidance }) {
  const spec = project.council?.discovery?.spec || {};
  const name = specProductName(spec) || 'Application';
  const cards = buildVerificationSummary(project);
  const features = asList(spec.requirements || spec.workPackages).slice(0, 8).map(item => typeof item === 'string' ? item : item.title || item.id).filter(Boolean);
  return [
    `# ${name} is ready for your review`,
    '',
    '## What was built?',
    spec.productSummary || project.idea || name,
    '',
    '## What can I test?',
    ...(testingGuidance.length ? testingGuidance.map(item => `- ${item}`) : features.map(item => `- ${item}`)),
    '',
    '## What was automatically verified?',
    `- Build: ${cards.build.label}`,
    `- Automated tests: ${cards.tests.label}`,
    `- Runtime: ${cards.runtime.label}`,
    `- Critical user flows: ${cards.journeys.label}`,
    `- Accessibility: ${cards.accessibility.label}`,
    `- Visual review: ${cards.visual.label}`,
    `- Security sandbox: ${cards.security.label}`,
    '',
    '## How do I open it?',
    howToOpen,
    '',
    '## Are there known limitations?',
    ...(limitations.length ? limitations.map(item => `- ${item}`) : ['- None recorded for this delivery.']),
    '',
    '## What should I do now?',
    'Approve this result, or request changes in one high-level message.',
    '',
    `Delivery version: v${version}`,
    `Final checkpoint: ${checkpointSha}`
  ].join('\n');
}

export function buildVerificationReport(project, lineage) {
  const verify = latestVerificationRun(project, latestCursorRun(project)?.iteration);
  const runtime = latestRuntimeRun(project, latestCursorRun(project)?.iteration);
  const visual = latestVisualRun(project, latestCursorRun(project)?.iteration);
  const provisioning = project.provisioning || latestProvisioningRun(project);
  const cards = buildVerificationSummary(project);
  return [
    '# Verification report',
    '',
    `- Provisioning: ${provisioning?.status || 'NOT_APPLICABLE'}`,
    `- Git checkpoint: ${lineage.chain.checkpointSha || 'n/a'}`,
    `- Build: ${cards.build.label}`,
    `- Tests: ${cards.tests.label}`,
    `- Lint/static: ${aspectStatus(latestCursorRun(project)?.evidence?.lint, verify?.policy?.lint).label}`,
    `- Runtime: ${cards.runtime.label}`,
    `- Functional journeys: ${cards.journeys.label}`,
    `- Accessibility: ${cards.accessibility.label}`,
    `- Visual: ${cards.visual.label}`,
    `- Security: ${cards.security.label}`,
    `- Final review: ${project.council?.final?.decision?.decision || 'UNKNOWN'}`,
    '',
    'Statuses are copied from persisted evidence. This is not a production-security certification.'
  ].join('\n');
}

export function buildReleaseNotes(project, { version, previous, feedback }) {
  const spec = project.council?.discovery?.spec || {};
  const features = asList(spec.requirements).slice(0, 6);
  const lines = [
    `# Release notes — v${version}`,
    '',
    spec.productSummary || project.idea || 'Autonomous delivery',
    '',
    '## Major features',
    ...(features.length ? features.map(item => `- ${item}`) : ['- See owner review for the delivered workflows.'])
  ];
  if (version > 1) {
    lines.push('', '## Changes since previous review');
    if (feedback) lines.push(`- Owner requested: ${feedback}`);
    const changed = latestCursorRun(project)?.changedFiles || latestCursorRun(project)?.result?.changedFiles || [];
    if (changed.length) lines.push(...changed.slice(0, 12).map(item => `- ${typeof item === 'string' ? item : item.path}`));
    else if (previous) lines.push(`- New delivery from checkpoint ${previous.checkpointSha} to the current verified checkpoint.`);
  }
  return lines.join('\n');
}

export function collectKnownLimitations(project) {
  const out = [];
  const level = latestCursorRun(project)?.evidence?.verificationLevel || project.verificationLevel;
  if (level === VerificationLevel.MOCK || project.demo) {
    out.push('This delivery used MOCK Council/Cursor verification. It is not a production-verified application build.');
  }
  if (level === VerificationLevel.SELF_REPORTED) {
    out.push('Some evidence is Cursor-reported rather than independently platform-verified.');
  }
  out.push('Owner approval accepts the autonomous-development result. It does not deploy, merge to main, or publish to an app store.');
  out.push('Automated accessibility checks are not a complete manual accessibility certification.');
  out.push('AI visual review does not replace your own judgment of look and feel.');
  if (!project.deliveryArtifacts?.some(item => item.kind === 'BUILD') && applicationKind(project) !== 'WEB_UI') {
    out.push('No signed production package is included. Signing credentials stay with the owner.');
  }
  const findings = (project.council?.final?.decision?.findings || []).filter(item => item && !item.blocking);
  for (const finding of findings.slice(0, 5)) {
    out.push(typeof finding === 'string' ? finding : finding.summary || finding.message);
  }
  return [...new Set(out.filter(Boolean))];
}

export function selectOwnerScreenshots(project, checkpointSha) {
  const runtime = latestRuntimeRun(project, latestCursorRun(project)?.iteration);
  const shots = (runtime?.screenshots || []).filter(item => {
    if (item.classification === ScreenshotClass.EXTERNAL_REVIEW_PROHIBITED) return false;
    if (item.checkpointSha && checkpointSha && item.checkpointSha !== checkpointSha) return false;
    return Boolean(item.id || item.path);
  });
  const preferred = [];
  const rest = [];
  for (const shot of shots) {
    const label = `${shot.route || ''} ${shot.step || ''} ${shot.viewport || ''}`.toLowerCase();
    if (/home|index|search|detail|success|mobile/.test(label)) preferred.push(shot);
    else rest.push(shot);
  }
  return [...preferred, ...rest].slice(0, 5);
}

export function testingGuidance(project) {
  const runtime = latestRuntimeRun(project, latestCursorRun(project)?.iteration);
  const goals = (runtime?.scenarios || []).filter(item => item.priority === 'critical' || item.status === 'PASS').map(item => item.goal).filter(Boolean);
  if (goals.length) return goals.slice(0, 6);
  const reqs = asList(project.council?.discovery?.spec?.requirements);
  return reqs.slice(0, 4).map(item => String(item));
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
}

export function howToOpen(project) {
  const kind = applicationKind(project);
  if (kind === 'WEB_UI' || kind === 'WEB' || kind === 'APPLICATION') {
    return 'Use Open App to start a temporary review session from the verified delivery. This is not a public deployment.';
  }
  if (kind === 'ANDROID') return 'Download the verified APK when present. No Play Store submission is performed.';
  if (kind === 'DESKTOP') return 'Download the verified desktop build when present. The platform does not sign or publish the installer.';
  if (kind === 'CLI') return 'Download the verified package or binary when present and run it locally.';
  return 'Download the source archive and follow the install/run notes in Technical details.';
}

export function applicationKind(project) {
  return project.runtimePlan?.applicationKind
    || String(project.council?.discovery?.spec?.architectureChoice?.category || project.council?.discovery?.spec?.projectType || '').toUpperCase();
}

function card(status) {
  return status;
}

function aspectStatus(aspect, policy) {
  if (policy === PolicyLevel.NOT_APPLICABLE || aspect?.status === EvidenceStatus.NOT_APPLICABLE) {
    return { status: 'NOT_APPLICABLE', label: 'Not applicable' };
  }
  if (aspect?.status === EvidenceStatus.PASS) return { status: 'PASS', label: 'Passed' };
  if (aspect?.status === EvidenceStatus.FAIL) return { status: 'FAIL', label: 'Failed' };
  if (!aspect || aspect.status === EvidenceStatus.NOT_RUN) return { status: 'NOT_RUN', label: 'Not run' };
  return { status: aspect.status || 'UNKNOWN', label: aspect.status || 'Unknown' };
}

function runtimeCard(runtime, evidence) {
  if (!runtime && evidence?.runtime?.status === EvidenceStatus.NOT_APPLICABLE) {
    return { status: 'NOT_APPLICABLE', label: 'Not applicable' };
  }
  if (runtime?.status === RuntimeStatus.PASS) return { status: 'PASS', label: 'Passed' };
  if (runtime?.status === RuntimeStatus.FAIL) return { status: 'FAIL', label: 'Failed' };
  if (!runtime) return { status: 'NOT_APPLICABLE', label: 'Not applicable' };
  return { status: runtime.status, label: runtime.status };
}

function journeyCard(runtime) {
  const scenarios = runtime?.scenarios || [];
  if (!scenarios.length) return { status: 'NOT_APPLICABLE', label: 'Not applicable' };
  const failed = scenarios.filter(item => item.status === 'FAIL');
  if (failed.length) return { status: 'FAIL', label: 'Failed' };
  return { status: 'PASS', label: 'Passed' };
}

function a11yCard(runtime, blocked) {
  if (!runtime?.accessibility?.length) return { status: 'NOT_APPLICABLE', label: 'Automated checks not run' };
  if (blocked) return { status: 'FAIL', label: 'Automated checks failed' };
  return { status: 'PASS', label: 'Automated checks passed' };
}

function visualCard(visual, evidence) {
  if (!visual && evidence?.visual?.status === EvidenceStatus.NOT_APPLICABLE) {
    return { status: 'NOT_APPLICABLE', label: 'Not applicable' };
  }
  if (!visual || visual.decision === 'NOT_APPLICABLE') return { status: 'NOT_APPLICABLE', label: 'Not applicable' };
  if (visual.decision === 'COMPLETE' || visual.status === RuntimeStatus.PASS) return { status: 'PASS', label: 'Passed' };
  if (visual.decision === 'CHANGES_REQUIRED') return { status: 'FAIL', label: 'Changes required' };
  return { status: visual.decision || visual.status || 'UNKNOWN', label: visual.decision || visual.status || 'Unknown' };
}

function securityCard(project) {
  const mode = project.sandboxProvenance?.sandboxMode || project.evidence?.source?.sandboxMode;
  if (mode === 'CONTAINER_HARDENED') return { status: 'PASS', label: 'Hardened container verified' };
  if (mode === 'LOCAL_DEVELOPMENT_UNSAFE') return { status: 'LIMITATION', label: 'Local development (unsafe) — not hardened' };
  if (project.demo) return { status: 'NOT_APPLICABLE', label: 'Not applicable in MOCK demo' };
  if (project.evidence?.security?.status === 'PASS') return { status: 'PASS', label: 'Passed' };
  return { status: 'NOT_APPLICABLE', label: 'Recorded with available evidence' };
}
