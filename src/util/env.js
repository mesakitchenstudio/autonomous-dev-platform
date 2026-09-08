import fs from 'node:fs';

export function loadDotEnv(path = '.env') {
  try {
    const raw = fs.readFileSync(path, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx < 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function boolEnvFrom(env, name, fallback = false) {
  const value = env?.[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function boolEnv(name, fallback = false) {
  return boolEnvFrom(process.env, name, fallback);
}

export function intEnvFrom(env, name, fallback) {
  const parsed = Number.parseInt(env?.[name] ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function intEnv(name, fallback) {
  return intEnvFrom(process.env, name, fallback);
}

export function envPresent(env, name) {
  const value = env?.[name];
  return value != null && String(value).trim() !== '';
}
