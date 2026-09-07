import { spawnSync } from 'node:child_process';

function docker(bin, args) {
  try {
    const result = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (result.error?.code === 'ENOENT') return { status: 1, stdout: '', stderr: 'ENOENT' };
    return result;
  } catch {
    return { status: 1, stdout: '', stderr: 'spawn failed' };
  }
}

export function listPlatformSandboxNames(bin = 'docker') {
  const listed = docker(bin, ['ps', '-a', '--filter', 'label=adp.sandbox=1', '--format', '{{.Names}}']);
  if (listed.status !== 0) return [];
  return String(listed.stdout || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
}

export async function cleanupOrphanSandboxes({ bin = 'docker', olderThanMs = 3_600_000 } = {}) {
  const names = listPlatformSandboxNames(bin);
  const cleaned = [];
  for (const name of names) {
    if (!name.startsWith('adp-sbx-')) continue;
    const inspect = docker(bin, ['inspect', '--format', '{{.Created}}|{{.State.FinishedAt}}|{{.State.Running}}', name]);
    const [createdAt, finishedAt, running] = String(inspect.stdout || '').trim().split('|');
    const created = Date.parse(createdAt);
    const finished = Date.parse(finishedAt);
    const ageMs = Number.isFinite(created) ? Date.now() - created : Number.POSITIVE_INFINITY;
    const finishedAgeMs = Number.isFinite(finished) ? Date.now() - finished : Number.POSITIVE_INFINITY;
    const stillActive = String(running).trim() === 'true' && ageMs < olderThanMs;
    const recentlyExited = String(running).trim() !== 'true' && finishedAgeMs < olderThanMs;
    if (stillActive || recentlyExited) continue;
    docker(bin, ['rm', '-f', name]);
    cleaned.push(name);
  }
  const volumes = docker(bin, ['volume', 'ls', '--filter', 'label=adp.sandbox=1', '--format', '{{.Name}}']);
  const volumeNames = String(volumes.stdout || '').split(/\r?\n/).map(item => item.trim()).filter(item => item.startsWith('adp-sbx-'));
  for (const volume of volumeNames) {
    docker(bin, ['volume', 'rm', '-f', volume]);
    cleaned.push(volume);
  }
  const networks = docker(bin, ['network', 'ls', '--filter', 'label=adp.sandbox=1', '--format', '{{.Name}}']);
  const networkNames = String(networks.stdout || '').split(/\r?\n/).map(item => item.trim()).filter(item => item.startsWith('adp-sbx-'));
  for (const network of networkNames) {
    docker(bin, ['network', 'rm', network]);
    cleaned.push(network);
  }
  return { cleaned, onlyPlatformOwned: true };
}
