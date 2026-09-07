const MATERIAL_CATEGORIES = new Set([
  'architecture',
  'data_ownership',
  'authentication',
  'security',
  'platform',
  'technology',
  'destructive',
  'core_requirement',
  'api_contract',
  'persistence',
  'ux_structure',
  'maintainability'
]);

const TRIVIAL = /wording|phrasing|comment|style|naming preference|typo/i;

export function collectMaterialDisagreements(critiques = []) {
  const found = [];
  for (const critique of critiques) {
    for (const item of critique.normalized?.disagreements || critique.output?.disagreements || []) {
      const category = String(item.category || '').toLowerCase();
      const topic = String(item.topic || '');
      if (TRIVIAL.test(topic) && !MATERIAL_CATEGORIES.has(category)) continue;
      if (item.material === true || MATERIAL_CATEGORIES.has(category)) {
        found.push({
          topic: item.topic,
          category: item.category,
          positions: item.positions || [],
          material: true
        });
      }
    }
  }
  return dedupe(found);
}

export function shouldRunResolution(critiques, { currentRounds, maxRounds }) {
  if (currentRounds >= maxRounds) return false;
  return collectMaterialDisagreements(critiques).length > 0;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.category}::${item.topic}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export { MATERIAL_CATEGORIES };
