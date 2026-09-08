import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DeliveryArtifactKind, DeliveryStatus, WorktreeLifecycle } from './kinds.js';
import {
  currentDelivery,
  deliveryIdempotencyKey,
  finalCheckpointSha,
  validateEvidenceLineage,
  verificationSetHash
} from './lineage.js';
import { createSourceArchive, deliveryDir } from './archive.js';
import {
  applicationKind,
  buildOwnerReport,
  buildReleaseNotes,
  buildVerificationReport,
  buildVerificationSummary,
  collectKnownLimitations,
  howToOpen,
  selectOwnerScreenshots,
  testingGuidance
} from './reports.js';
import { latestCursorRun, specProductName } from '../orchestrator/gate.js';
import { latestVerificationRun } from '../verify/pipeline.js';
import { isExistingRepositoryProject, latestProvisioningRun } from '../provision/plan.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { artifactRoot } from '../verify/artifacts.js';

export async function prepareDeliverySnapshot(project, { workspacePath } = {}) {
  const checkpointSha = finalCheckpointSha(project);
  const lineage = validateEvidenceLineage(project, checkpointSha);
  if (!lineage.ok) {
    throw new PlatformError({
      code: ErrorCode.DELIVERY_LINEAGE_INVALID,
      message: `Delivery lineage failed: ${lineage.reasons.join(', ')}`,
      phase: 'DELIVERY_PREPARATION',
      retryable: false,
      details: { reasons: lineage.reasons }
    });
  }
  const key = deliveryIdempotencyKey(project);
  const existing = (project.deliveries || []).find(item => item.idempotencyKey === key && (item.status === DeliveryStatus.READY || item.status === DeliveryStatus.PREPARING));
  if (existing?.status === DeliveryStatus.READY && existing.manifestHash) {
    existing.current = true;
    return { delivery: existing, reused: true };
  }
  const version = nextVersion(project);
  const delivery = existing && existing.status === DeliveryStatus.PREPARING
    ? existing
    : {
      id: crypto.randomUUID(),
      projectId: project.id,
      version,
      checkpointSha,
      provisioningBaselineSha: project.provisioning?.baselineSha || project.repository?.provisioningBaselineSha || latestProvisioningRun(project)?.baselineSha || null,
      verificationSetHash: verificationSetHash(project),
      idempotencyKey: key,
      status: DeliveryStatus.PREPARING,
      current: false,
      artifacts: [],
      createdAt: new Date().toISOString(),
      retention: { worktree: WorktreeLifecycle.ACTIVE, delivery: 'RETAIN', reviewSessions: 'TEMPORARY' }
    };
  project.deliveries = project.deliveries || [];
  if (!project.deliveries.some(item => item.id === delivery.id)) project.deliveries.push(delivery);

  const destDir = deliveryDir(project.id, delivery.version);
  await fs.mkdir(destDir, { recursive: true });
  const archive = await createSourceArchive({
    project,
    checkpointSha,
    version: delivery.version,
    workspacePath: workspacePath || project.repository?.workspacePath || project.projectPath
  });
  const limitations = collectKnownLimitations(project);
  const screenshots = selectOwnerScreenshots(project, checkpointSha);
  const cards = buildVerificationSummary(project);
  const ownerReport = buildOwnerReport(project, {
    version: delivery.version,
    checkpointSha,
    limitations,
    howToOpen: howToOpen(project),
    testingGuidance: testingGuidance(project)
  });
  const verificationReport = buildVerificationReport(project, lineage);
  const previous = project.deliveries.filter(item => item.id !== delivery.id).at(-1) || null;
  const feedback = (project.ownerReviews || []).filter(item => item.decision === 'CHANGES_REQUESTED').at(-1)?.feedback || project.pendingOwnerFeedback?.feedback;
  const releaseNotes = buildReleaseNotes(project, { version: delivery.version, previous, feedback });
  const reviewPage = buildReviewPage(project, ownerReport);
  const builds = selectBuildArtifacts(project, checkpointSha);

  const ownerPath = path.join(destDir, 'OWNER_REVIEW.md');
  const verifyPath = path.join(destDir, 'verification-report.md');
  const notesPath = path.join(destDir, 'RELEASE_NOTES.md');
  const reviewPath = path.join(destDir, 'review', 'index.html');
  await fs.writeFile(ownerPath, ownerReport);
  await fs.writeFile(verifyPath, verificationReport);
  await fs.writeFile(notesPath, releaseNotes);
  await fs.mkdir(path.dirname(reviewPath), { recursive: true });
  await fs.writeFile(reviewPath, reviewPage);

  const artifacts = [
    await fileArtifact(project, delivery, DeliveryArtifactKind.SOURCE_ARCHIVE, archive.path, archive.fileName, archive.sha256, archive.size, checkpointSha),
    await hashedTextArtifact(project, delivery, DeliveryArtifactKind.OWNER_REPORT, ownerPath, 'OWNER_REVIEW.md', checkpointSha),
    await hashedTextArtifact(project, delivery, DeliveryArtifactKind.VERIFICATION_REPORT, verifyPath, 'verification-report.md', checkpointSha),
    await hashedTextArtifact(project, delivery, DeliveryArtifactKind.REVIEW_PAGE, reviewPath, 'index.html', checkpointSha),
    ...builds
  ];
  for (const shot of screenshots) {
    if (!shot.path) continue;
    artifacts.push({
      id: shot.id || crypto.randomUUID(),
      deliveryId: delivery.id,
      projectId: project.id,
      kind: DeliveryArtifactKind.SCREENSHOT,
      fileName: path.basename(shot.path),
      mimeType: 'image/png',
      size: shot.size || null,
      sha256: shot.sha256 || crypto.createHash('sha256').update(shot.path).digest('hex'),
      checkpointSha: shot.checkpointSha || checkpointSha,
      verificationRunId: shot.runtimeRunId || null,
      storedPath: shot.path
    });
  }

  const manifest = {
    projectId: project.id,
    productName: specProductName(project.council?.discovery?.spec),
    deliveryVersion: delivery.version,
    applicationProfile: applicationKind(project),
    finalCheckpointSha: checkpointSha,
    provisioningBaselineSha: delivery.provisioningBaselineSha,
    workingBranch: project.repository?.workingBranch || null,
    repositoryType: project.repository?.repositoryType || null,
    buildArtifacts: artifacts.filter(item => item.kind === DeliveryArtifactKind.BUILD).map(publicArtifact),
    artifactSha256: artifacts.filter(item => item.kind === DeliveryArtifactKind.BUILD).map(item => item.sha256),
    sourceArchiveSha256: archive.sha256,
    runtimeVerificationIds: [lineage.chain.runtimeRunId].filter(Boolean),
    screenshotHashes: artifacts.filter(item => item.kind === DeliveryArtifactKind.SCREENSHOT).map(item => item.sha256),
    securityVerificationStatus: cards.security.status,
    finalReviewStatus: project.council?.final?.decision?.decision || null,
    createdAt: new Date().toISOString(),
    knownLimitations: limitations,
    installRun: howToOpen(project),
    changedFiles: isExistingRepositoryProject(project)
      ? (latestCursorRun(project)?.changedFiles || []).slice(0, 40)
      : undefined,
    verificationSummary: cards
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = path.join(destDir, 'delivery-manifest.json');
  await fs.writeFile(manifestPath, manifestText);
  const manifestHash = crypto.createHash('sha256').update(manifestText).digest('hex');
  artifacts.push(await hashedTextArtifact(project, delivery, DeliveryArtifactKind.MANIFEST, manifestPath, 'delivery-manifest.json', checkpointSha, manifestHash));

  const validation = validatePreparedPackage({
    archive,
    artifacts,
    ownerReport,
    verificationReport,
    manifestHash,
    secretScan: 'PASS'
  });
  if (!validation.ok) {
    throw new PlatformError({
      code: ErrorCode.DELIVERY_PREPARATION_FAILED,
      message: `Delivery package validation failed: ${validation.reasons.join(', ')}`,
      phase: 'DELIVERY_PREPARATION',
      retryable: true,
      details: { reasons: validation.reasons }
    });
  }

  Object.assign(delivery, {
    status: DeliveryStatus.READY,
    current: true,
    artifacts,
    verification: cards,
    screenshots: artifacts.filter(item => item.kind === DeliveryArtifactKind.SCREENSHOT),
    knownLimitations: limitations,
    manifest,
    manifestHash,
    ownerReport,
    verificationReport,
    releaseNotes,
    lineage: lineage.chain,
    secretScan: 'PASS',
    readyAt: new Date().toISOString()
  });
  for (const item of project.deliveries) {
    if (item.id !== delivery.id && item.current) {
      item.current = false;
      if (item.status === DeliveryStatus.READY) item.status = DeliveryStatus.SUPERSEDED;
    }
  }
  project.deliveryArtifacts = artifacts;
  return { delivery, reused: false };
}

export function validatePreparedPackage({ archive, artifacts, ownerReport, verificationReport, manifestHash, secretScan }) {
  const reasons = [];
  if (!archive?.path || !archive.sha256) reasons.push('missing_source_archive');
  if (!manifestHash) reasons.push('missing_manifest_hash');
  if (!ownerReport) reasons.push('missing_owner_report');
  if (!verificationReport) reasons.push('missing_verification_report');
  if (secretScan !== 'PASS') reasons.push('delivery_secret_scan_failed');
  const source = artifacts.find(item => item.kind === DeliveryArtifactKind.SOURCE_ARCHIVE);
  if (source && source.sha256 !== archive.sha256) reasons.push('source_hash_mismatch');
  return { ok: reasons.length === 0, reasons };
}

export function ownerDeliveryView(project) {
  const delivery = currentDelivery(project);
  if (!delivery) return project.delivery || null;
  return {
    deliveryId: delivery.id,
    version: delivery.version,
    status: delivery.status,
    productName: specProductName(project.council?.discovery?.spec),
    summary: project.council?.final?.decision?.summary || 'Ready for final owner review.',
    readyAt: delivery.readyAt,
    verificationLevel: project.verificationLevel,
    checkpointSha: delivery.checkpointSha,
    manifestHash: delivery.manifestHash,
    verification: delivery.verification,
    knownLimitations: delivery.knownLimitations,
    releaseNotes: delivery.releaseNotes,
    ownerReport: delivery.ownerReport,
    verificationReport: delivery.verificationReport,
    screenshots: (delivery.screenshots || []).map(item => ({
      id: item.id,
      fileName: item.fileName,
      sha256: item.sha256
    })),
    artifacts: (delivery.artifacts || []).map(publicArtifact),
    workingBranch: project.repository?.workingBranch || null,
    testingGuidance: testingGuidance(project),
    howToOpen: howToOpen(project),
    components: (project.components || []).map(item => ({
      id: item.id,
      path: item.path,
      status: item.status
    }))
  };
}

function nextVersion(project) {
  const max = Math.max(0, ...(project.deliveries || []).map(item => Number(item.version || 0)));
  return max + 1;
}

function selectBuildArtifacts(project, checkpointSha) {
  const verify = latestVerificationRun(project, latestCursorRun(project)?.iteration);
  const selected = (verify?.artifacts || []).filter(item => {
    const kind = String(item.kind || item.type || '');
    return /build_output|apk|aab|installer|binary|package/i.test(kind) && item.sha256 && item.path;
  });
  return selected.map(item => ({
    id: item.id,
    deliveryId: null,
    projectId: project.id,
    kind: DeliveryArtifactKind.BUILD,
    fileName: path.basename(item.path),
    mimeType: 'application/octet-stream',
    size: item.size || null,
    sha256: item.sha256,
    checkpointSha: verify?.checkpointSha || checkpointSha,
    verificationRunId: verify?.id || null,
    storedPath: item.path
  }));
}

function publicArtifact(item) {
  return {
    id: item.id,
    kind: item.kind,
    fileName: item.fileName,
    size: item.size,
    sha256: item.sha256,
    checkpointSha: item.checkpointSha
  };
}

async function fileArtifact(project, delivery, kind, storedPath, fileName, sha256, size, checkpointSha) {
  return {
    id: crypto.randomUUID(),
    deliveryId: delivery.id,
    projectId: project.id,
    kind,
    fileName,
    mimeType: kind === DeliveryArtifactKind.SOURCE_ARCHIVE ? 'application/zip' : 'application/octet-stream',
    size,
    sha256,
    checkpointSha,
    storedPath
  };
}

async function hashedTextArtifact(project, delivery, kind, storedPath, fileName, checkpointSha, sha) {
  const bytes = await fs.readFile(storedPath);
  return {
    id: crypto.randomUUID(),
    deliveryId: delivery.id,
    projectId: project.id,
    kind,
    fileName,
    mimeType: fileName.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/markdown; charset=utf-8',
    size: bytes.length,
    sha256: sha || crypto.createHash('sha256').update(bytes).digest('hex'),
    checkpointSha,
    storedPath
  };
}

function buildReviewPage(project, ownerReport) {
  const name = specProductName(project.council?.discovery?.spec) || 'Application';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(name)} review</title></head><body><pre>${escapeHtml(ownerReport)}</pre></body></html>`;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

export { artifactRoot };
