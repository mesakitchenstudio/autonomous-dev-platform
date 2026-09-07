import { spawnSync } from 'node:child_process';

export function git(args, { cwd, timeoutMs = 20000 } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').replace(/\s+$/, ''),
    stderr: String(result.stderr || '').replace(/\s+$/, ''),
    args
  };
}

export function gitOk(args, options) {
  const result = git(args, options);
  if (!result.ok) {
    const error = new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
    error.git = result;
    throw error;
  }
  return result.stdout;
}
