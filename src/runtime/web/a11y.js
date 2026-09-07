export async function runAccessibilityChecks(page, { keyboard = true } = {}) {
  const findings = [];
  const unnamed = await page.locator('button, [role="button"], a, input, select, textarea').evaluateAll(nodes => nodes.map(node => {
    const role = node.getAttribute('role') || node.tagName.toLowerCase();
    const name = (node.getAttribute('aria-label') || node.getAttribute('aria-labelledby') || node.getAttribute('alt') || node.getAttribute('title') || node.innerText || node.value || '').trim();
    const hidden = node.getAttribute('aria-hidden') === 'true' || node.hidden || node.disabled;
    return { role, name, hidden, tag: node.tagName.toLowerCase(), type: node.getAttribute('type') };
  }));
  for (const item of unnamed) {
    if (item.hidden) continue;
    if (item.tag === 'input' && ['hidden', 'submit', 'button'].includes(item.type) === false && item.name) continue;
    if (!item.name && ['button', 'a', 'role="button"'].some(() => item.tag === 'button' || item.role === 'button' || item.tag === 'a')) {
      findings.push({
        severity: 'HIGH',
        category: 'name',
        code: 'MISSING_ACCESSIBLE_NAME',
        description: `Interactive ${item.tag} has no accessible name`,
        blocking: true,
        provenance: 'PLATFORM_VERIFIED'
      });
    }
  }
  const invalid = await page.locator('[aria-labelledby], [role]').evaluateAll(nodes => nodes.flatMap(node => {
    const issues = [];
    const labelledBy = node.getAttribute('aria-labelledby');
    if (labelledBy && !labelledBy.split(/\s+/).every(id => document.getElementById(id))) {
      issues.push('INVALID_ARIA_LABELLEDBY');
    }
    return issues;
  }));
  for (const code of invalid) {
    findings.push({
      severity: 'MEDIUM',
      category: 'aria',
      code,
      description: 'Invalid ARIA reference',
      blocking: false,
      provenance: 'PLATFORM_VERIFIED'
    });
  }
  if (keyboard) {
    await page.locator('body').first().click({ position: { x: 1, y: 1 } }).catch(() => {});
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      return el.tagName;
    });
    if (!focused) {
      findings.push({
        severity: 'HIGH',
        category: 'keyboard',
        code: 'KEYBOARD_FOCUS_NOT_MOVED',
        description: 'Tab did not move focus to an actionable control',
        blocking: true,
        provenance: 'PLATFORM_VERIFIED'
      });
    }
  }
  return {
    status: findings.some(item => item.blocking) ? 'FAIL' : 'PASS',
    claim: 'AUTOMATED_ACCESSIBILITY_CHECKS_PASS',
    complianceClaim: null,
    findings
  };
}
