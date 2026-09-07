import path from 'node:path';
import { isInsideRoot, resolveCanonicalSync } from '../git/boundary.js';
import { ErrorCode, PlatformError } from '../orchestrator/errors.js';
import { artifactRoot } from '../verify/artifacts.js';

export function collectProjectArtifacts(project) {
  return [
    ...(project.verificationRuns || []).flatMap(run => run.artifacts || []),
    ...(project.runtimeRuns || []).flatMap(run => [
      ...(run.screenshots || []),
      ...(run.artifacts || [])
    ]),
    ...(project.provisioningRuns || []).flatMap(run => run.artifacts || [])
  ].filter(item => item?.id);
}

export function resolveProjectArtifact(project, artifactId) {
  const found = collectProjectArtifacts(project).find(item => item.id === artifactId);
  if (!found) {
    throw new PlatformError({
      code: ErrorCode.AUTHZ_DENIED,
      message: 'Artifact was not found for this project.',
      phase: 'API',
      retryable: false
    });
  }
  if (found.projectId && found.projectId !== project.id) {
    throw new PlatformError({
      code: ErrorCode.AUTHZ_DENIED,
      message: 'Artifact belongs to another project.',
      phase: 'API',
      retryable: false
    });
  }
  if (found.path) {
    const canonical = resolveCanonicalSync(found.path);
    const roots = [artifactRoot(), project.repository?.workspacePath].filter(Boolean);
    const ok = roots.some(root => isInsideRoot(canonical, resolveCanonicalSync(root)));
    if (!ok) {
      throw new PlatformError({
        code: ErrorCode.WORKSPACE_UNSAFE,
        message: 'Artifact path escaped approved roots.',
        phase: 'API',
        retryable: false
      });
    }
  }
  return found;
}

export function artifactPublicView(artifact) {
  return {
    id: artifact.id,
    kind: artifact.kind || artifact.type,
    type: artifact.type || artifact.kind,
    size: artifact.size || null,
    sha256: artifact.sha256 || null,
    createdAt: artifact.createdAt || null,
    name: artifact.path ? path.basename(artifact.path) : null
  };
}
