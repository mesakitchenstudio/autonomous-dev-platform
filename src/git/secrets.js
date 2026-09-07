const SECRET_FILE_PATTERNS = [
  /^\.env$/i,
  /^\.env\./i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_rsa$/i,
  /^id_dsa$/i,
  /^id_ecdsa$/i,
  /^id_ed25519$/i,
  /credentials\.json$/i,
  /service-account.*\.json$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i
];

export function isProtectedSecretFile(filePath) {
  const name = String(filePath || '').replace(/\\/g, '/').split('/').pop();
  if (!name) return false;
  if (/\.(example|sample|template)$/i.test(name)) return false;
  return SECRET_FILE_PATTERNS.some(pattern => pattern.test(name));
}

export function findProtectedSecretFiles(paths = []) {
  return paths.filter(item => isProtectedSecretFile(typeof item === 'string' ? item : item.path));
}
