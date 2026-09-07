const KNOWN_PROVIDERS = Object.freeze(['openai', 'anthropic', 'gemini', 'xai']);

export function resolveModelName(envName, fallback) {
  const raw = process.env[envName];
  if (raw != null && String(raw).trim() === '') {
    throw new Error(`${envName} is set but empty. Provide a real model name.`);
  }
  const value = String(raw || fallback || '').trim();
  if (!value) throw new Error(`${envName} is required.`);
  if (/\s/.test(value) || value === 'undefined' || value === 'null') {
    throw new Error(`${envName} has an invalid model name.`);
  }
  return value;
}

export function resolveChairProvider(providers, chairName = process.env.CHAIR_PROVIDER || 'openai') {
  const name = String(chairName || 'openai').toLowerCase();
  if (!KNOWN_PROVIDERS.includes(name)) {
    throw new Error(`CHAIR_PROVIDER must be one of ${KNOWN_PROVIDERS.join(', ')}.`);
  }
  const found = providers.find(provider => provider.name === name);
  if (!found) {
    throw new Error(`CHAIR_PROVIDER=${name} is not among the configured Council providers.`);
  }
  const chairModel = String(process.env.CHAIR_MODEL || '').trim();
  if (chairModel === 'undefined' || chairModel === 'null' || /\s/.test(process.env.CHAIR_MODEL || '')) {
    throw new Error('CHAIR_MODEL has an invalid model name.');
  }
  if (chairModel && chairModel !== found.model) {
    return found.withModel(chairModel);
  }
  return found;
}
