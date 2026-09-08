export const DeliveryStatus = Object.freeze({
  PREPARING: 'PREPARING',
  READY: 'READY',
  APPROVED: 'APPROVED',
  SUPERSEDED: 'SUPERSEDED',
  STALE: 'STALE'
});

export const OwnerDecision = Object.freeze({
  APPROVED: 'APPROVED',
  CHANGES_REQUESTED: 'CHANGES_REQUESTED'
});

export const DeliveryArtifactKind = Object.freeze({
  SOURCE_ARCHIVE: 'SOURCE_ARCHIVE',
  BUILD: 'BUILD',
  MANIFEST: 'MANIFEST',
  OWNER_REPORT: 'OWNER_REPORT',
  VERIFICATION_REPORT: 'VERIFICATION_REPORT',
  SCREENSHOT: 'SCREENSHOT',
  REVIEW_PAGE: 'REVIEW_PAGE'
});

export const ReviewSessionStatus = Object.freeze({
  ACTIVE: 'ACTIVE',
  EXPIRED: 'EXPIRED',
  STOPPED: 'STOPPED'
});

export const NotificationType = Object.freeze({
  READY_FOR_OWNER_REVIEW: 'READY_FOR_OWNER_REVIEW',
  PROJECT_FAILED: 'PROJECT_FAILED'
});

export const NotificationDeliveryStatus = Object.freeze({
  PENDING: 'PENDING',
  SENT: 'SENT',
  FAILED: 'FAILED'
});

export const WorktreeLifecycle = Object.freeze({
  ACTIVE: 'ACTIVE',
  APPROVED: 'APPROVED',
  ARCHIVABLE: 'ARCHIVABLE'
});
