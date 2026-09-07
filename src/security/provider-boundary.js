export const ProviderDataClass = Object.freeze({
  OWNER_INTENT: 'OWNER_INTENT',
  SPEC_EXCERPT: 'SPEC_EXCERPT',
  SANITIZED_EVIDENCE: 'SANITIZED_EVIDENCE',
  SCREENSHOT_PUBLIC: 'SCREENSHOT_PUBLIC',
  PROHIBITED: 'PROHIBITED'
});

export function minimizeCouncilInput(input = {}) {
  const out = {
    idea: String(input.idea || '').slice(0, 4000),
    spec: input.spec ? {
      productName: input.spec.productName,
      productSummary: input.spec.productSummary,
      projectType: input.spec.projectType,
      requirements: (input.spec.requirements || []).slice(0, 40)
    } : null,
    platformVerification: input.platformVerification || null,
    runtimeVerification: input.runtimeVerification || null,
    visualVerification: input.visualVerification || null,
    security: input.security || null,
    dataClass: ProviderDataClass.SANITIZED_EVIDENCE
  };
  return out;
}

export function assertProviderPayloadSafe(payload = {}) {
  const text = JSON.stringify(payload);
  const banned = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'SECRET_MASTER_KEY', 'OWNER_TOKEN_BOOTSTRAP', 'DATABASE_URL'];
  const leaked = banned.filter(name => text.includes(name) && /:\s*["'][^"']{8,}/.test(text));
  return { ok: leaked.length === 0, leaked, dataClass: payload.dataClass || ProviderDataClass.SANITIZED_EVIDENCE };
}
