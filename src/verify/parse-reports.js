export function parseTestCounts(text) {
  const raw = String(text || '');
  const tap = raw.match(/#\s*tests\s+(\d+)[\s\S]*?#\s*pass\s+(\d+)[\s\S]*?#\s*fail\s+(\d+)[\s\S]*?#\s*skipped\s+(\d+)/);
  if (tap) {
    return {
      total: Number(tap[1]),
      passed: Number(tap[2]),
      failed: Number(tap[3]),
      skipped: Number(tap[4])
    };
  }
  const jest = raw.match(/Tests:\s+(?:(\d+) failed,\s*)?(?:(\d+) skipped,\s*)?(\d+) passed,\s*(\d+) total/);
  if (jest) {
    return {
      failed: Number(jest[1] || 0),
      skipped: Number(jest[2] || 0),
      passed: Number(jest[3]),
      total: Number(jest[4])
    };
  }
  return { passed: null, failed: null, skipped: null, total: null };
}
