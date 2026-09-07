import { intEnv } from '../util/env.js';

export function selectScreensForReview(screenshots = [], { suspicious = [] } = {}) {
  const max = intEnv('VISUAL_MAX_SCREENSHOTS', 12);
  const criticalLimit = intEnv('VISUAL_CRITICAL_REVIEWERS', 3);
  const secondaryLimit = intEnv('VISUAL_SECONDARY_REVIEWERS', 1);
  const selected = screenshots.slice(0, max);
  return selected.map((shot, index) => {
    const critical = index === 0 || /home|launch|primary|after-primary|mobile/i.test(shot.step || shot.kind || shot.route || '')
      || shot.viewport === 'MOBILE'
      || suspicious.includes(shot.id);
    return {
      screenshot: shot,
      reviewerCount: critical ? Math.max(1, criticalLimit) : Math.max(1, secondaryLimit),
      priority: critical ? 'CRITICAL' : 'SECONDARY'
    };
  });
}
