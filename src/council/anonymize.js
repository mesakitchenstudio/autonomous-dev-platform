const LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export function anonymizeAnalyses(analyses) {
  const mapping = {};
  const proposals = analyses.map((analysis, index) => {
    const id = `Proposal ${LABELS[index] || index + 1}`;
    mapping[id] = analysis.provider;
    return { id, content: analysis.normalized || analysis.output };
  });
  return { proposals, mapping };
}

export function assertAnonymized(text, providerNames) {
  const leaked = providerNames.filter(name => new RegExp(`\\b${name}\\b`, 'i').test(text));
  return leaked;
}
