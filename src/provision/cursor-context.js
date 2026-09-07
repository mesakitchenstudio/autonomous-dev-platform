export function provisioningCursorContext(project, run) {
  const spec = project.council?.discovery?.spec || {};
  const plan = project.provisioningPlan || run?.plan || {};
  const identity = plan.identity || {};
  const versions = run?.toolchainVersions || {};
  return [
    'OBJECTIVE',
    spec.cursorPrompt ? 'Continue from the already-provisioned project foundation.' : 'Implement the owner idea on the provisioned foundation.',
    '',
    'PROVISIONED FOUNDATION',
    `The project foundation already exists. Provisioner: ${plan.provisioner || 'unknown'}.`,
    `Template: ${plan.templateId || 'none'}.`,
    `Generator: ${plan.generator?.name || 'platform'} ${plan.generator?.version || ''}`.trim(),
    `Product name: ${identity.productName || spec.productName || 'Application'}`,
    `Technical project name: ${identity.projectName || ''}`,
    `Package id: ${identity.packageId || ''}`,
    `Provisioning baseline SHA: ${run?.baselineSha || project.repository?.provisioningBaselineSha || ''}`,
    `Toolchain versions: ${JSON.stringify(versions)}`,
    `Workspace files: ${(run?.createdFiles || []).slice(0, 40).join(', ')}`,
    '',
    'CONSTRAINTS',
    'Build ON TOP OF the existing scaffold.',
    'Do not replace the framework or re-run an unrelated project generator.',
    'Do not delete the primary manifest or change the package manager without an explicit architecture decision.',
    'Do not invent a different stack.',
    '',
    'AUTHORITATIVE SPECIFICATION',
    JSON.stringify({
      productName: spec.productName,
      requirements: spec.requirements,
      architecture: spec.architecture,
      workPackages: spec.workPackages,
      acceptanceCriteria: spec.acceptanceCriteria
    })
  ].join('\n');
}

export function applyProvisioningToCursorPrompt(project, run) {
  const original = project.activePrompt || project.council?.discovery?.spec?.cursorPrompt || '';
  const prefix = provisioningCursorContext(project, run);
  if (original.includes('PROVISIONED FOUNDATION')) return original;
  return `${prefix}\n\n---\n\n${original}`;
}
