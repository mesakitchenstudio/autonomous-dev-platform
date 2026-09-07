import { ScreenshotClass } from './kinds.js';

export function classifyScreenshot(shot = {}) {
  if (shot.classification && ScreenshotClass[shot.classification]) return shot.classification;
  if (shot.externalReview === false) return ScreenshotClass.EXTERNAL_REVIEW_PROHIBITED;
  if (shot.sensitive === true) return ScreenshotClass.SENSITIVE_TEST_DATA;
  if (shot.synthetic === true) return ScreenshotClass.SYNTHETIC;
  return ScreenshotClass.PUBLIC_TEST_DATA;
}

export function maySendToExternalReview(shot) {
  const cls = classifyScreenshot(shot);
  return cls === ScreenshotClass.PUBLIC_TEST_DATA || cls === ScreenshotClass.SYNTHETIC;
}

export function filterScreensForExternalReview(screenshots = []) {
  return screenshots.filter(maySendToExternalReview);
}
