export async function detectLayoutDefects(page, viewport) {
  const findings = [];
  const items = await page.evaluate(() => {
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    return [...document.querySelectorAll('button, a, input, label, h1, h2, [data-qa]')].map(node => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        tag: node.tagName.toLowerCase(),
        text: (node.innerText || node.getAttribute('aria-label') || '').slice(0, 80),
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        overflowHidden: style.overflow === 'hidden' || style.overflowX === 'hidden',
        visibility: style.visibility,
        display: style.display
      };
    }).concat([{ viewportW, viewportH, sentinel: true }]);
  });
  const box = items.find(item => item.sentinel);
  for (const item of items.filter(entry => !entry.sentinel)) {
    if (item.display === 'none' || item.visibility === 'hidden') continue;
    if (item.tag === 'button' || item.tag === 'a' || item.tag === 'input') {
      const clipped = item.x + item.width < 0 || item.y + item.height < 0
        || item.x > (box?.viewportW || 0) || item.width > (box?.viewportW || 1) + 20;
      if (clipped || (item.width > 0 && item.x < -20)) {
        findings.push({
          severity: 'HIGH',
          category: 'clipping',
          description: `${item.tag} "${item.text || 'control'}" is clipped or outside the ${viewport?.name || 'current'} viewport`,
          evidence: `x=${Math.round(item.x)} y=${Math.round(item.y)} w=${Math.round(item.width)}`,
          requiredFix: 'Keep the control fully visible in this viewport',
          screen: viewport?.name || 'unknown',
          device: viewport?.name || 'unknown',
          provenance: 'PLATFORM_VERIFIED'
        });
      }
    }
  }
  return findings;
}
