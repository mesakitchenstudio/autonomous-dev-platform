import crypto from 'node:crypto';
import { NotificationDeliveryStatus, NotificationType } from '../delivery/kinds.js';
import { specProductName } from '../orchestrator/gate.js';
import { redactSecrets } from '../orchestrator/errors.js';

export class InAppNotificationProvider {
  name = 'in-app';
  async send({ project, delivery, type, title, body }) {
    project.notifications = project.notifications || [];
    const existing = project.notifications.find(item => item.deliveryId === delivery.id && item.type === type);
    if (existing) return existing;
    const record = {
      id: crypto.randomUUID(),
      projectId: project.id,
      deliveryId: delivery.id,
      type,
      title,
      body,
      readAt: null,
      createdAt: new Date().toISOString()
    };
    project.notifications.push(record);
    return record;
  }
}

export class WebhookNotificationProvider {
  name = 'webhook';
  constructor(url = process.env.OWNER_WEBHOOK_URL, secret = process.env.OWNER_WEBHOOK_SECRET) {
    this.url = url || null;
    this.secret = secret || null;
  }
  async send({ project, delivery, type, title }) {
    if (!this.url) return null;
    const payload = {
      event: type,
      projectId: project.id,
      projectName: specProductName(project.council?.discovery?.spec) || project.delivery?.productName,
      deliveryId: delivery.id,
      reviewUrl: `/#project-${project.id}`
    };
    const body = JSON.stringify(payload);
    const headers = { 'content-type': 'application/json' };
    if (this.secret) {
      headers['x-adp-signature'] = crypto.createHmac('sha256', this.secret).update(body).digest('hex');
    }
    const response = await fetch(this.url, { method: 'POST', headers, body });
    if (!response.ok) throw new Error(`webhook ${response.status}`);
    return { provider: this.name, payload };
  }
}

export class EmailNotificationProvider {
  name = 'email';
  constructor(config = process.env) {
    this.to = config.OWNER_EMAIL || null;
    this.configured = Boolean(config.SMTP_URL || config.OWNER_EMAIL_PROVIDER);
  }
  async send() {
    if (!this.configured || !this.to) return null;
    return { provider: this.name, skipped: 'configuration-dependent' };
  }
}

export class MockNotificationProvider {
  name = 'mock';
  constructor() {
    this.sent = [];
  }
  async send(message) {
    this.sent.push({ ...message, at: new Date().toISOString() });
    return { provider: this.name };
  }
}

export class NotificationService {
  constructor({ providers } = {}) {
    this.providers = providers || [
      new InAppNotificationProvider(),
      new WebhookNotificationProvider(),
      new EmailNotificationProvider()
    ];
  }

  readyKey(project, delivery) {
    return `project:${project.id}:delivery:${delivery.id}:ready-notification`;
  }

  async notifyReady(project, delivery) {
    const key = this.readyKey(project, delivery);
    project.notificationDeliveries = project.notificationDeliveries || [];
    const existing = project.notificationDeliveries.find(item => item.idempotencyKey === key && item.status === NotificationDeliveryStatus.SENT);
    if (existing) return { reused: true, notification: project.notifications?.find(item => item.deliveryId === delivery.id) };
    const name = specProductName(project.council?.discovery?.spec) || project.delivery?.productName || 'Your project';
    const title = `${name} is ready for review.`;
    const body = [
      'Automated implementation and verification are complete.',
      'Open the project to review the application and choose:',
      'Approve or Request Changes'
    ].join(' ');
    let notification = null;
    for (const provider of this.providers) {
      try {
        const result = await provider.send({
          project,
          delivery,
          type: NotificationType.READY_FOR_OWNER_REVIEW,
          title,
          body
        });
        if (provider.name === 'in-app') notification = result;
        if (result) {
          upsertDelivery(project, {
            id: crypto.randomUUID(),
            notificationId: notification?.id || null,
            projectId: project.id,
            provider: provider.name,
            idempotencyKey: `${key}:${provider.name}`,
            status: NotificationDeliveryStatus.SENT,
            payload: sanitizePayload(result.payload || { event: NotificationType.READY_FOR_OWNER_REVIEW, projectId: project.id, deliveryId: delivery.id }),
            sentAt: new Date().toISOString()
          });
        }
      } catch {
        upsertDelivery(project, {
          id: crypto.randomUUID(),
          notificationId: notification?.id || null,
          projectId: project.id,
          provider: provider.name,
          idempotencyKey: `${key}:${provider.name}`,
          status: NotificationDeliveryStatus.FAILED,
          payload: { event: NotificationType.READY_FOR_OWNER_REVIEW, projectId: project.id, deliveryId: delivery.id }
        });
      }
    }
    if (notification) {
      upsertDelivery(project, {
        id: crypto.randomUUID(),
        notificationId: notification.id,
        projectId: project.id,
        provider: 'ready',
        idempotencyKey: key,
        status: NotificationDeliveryStatus.SENT,
        payload: { event: NotificationType.READY_FOR_OWNER_REVIEW, projectId: project.id, deliveryId: delivery.id },
        sentAt: new Date().toISOString()
      });
    }
    return { reused: false, notification };
  }
}

function upsertDelivery(project, record) {
  project.notificationDeliveries = project.notificationDeliveries || [];
  const existing = project.notificationDeliveries.findIndex(item => item.idempotencyKey === record.idempotencyKey);
  if (existing >= 0) project.notificationDeliveries[existing] = { ...project.notificationDeliveries[existing], ...record };
  else project.notificationDeliveries.push(record);
}

function sanitizePayload(payload) {
  const safe = {
    event: payload?.event,
    projectId: payload?.projectId,
    projectName: payload?.projectName,
    deliveryId: payload?.deliveryId,
    reviewUrl: payload?.reviewUrl
  };
  return JSON.parse(redactSecrets(JSON.stringify(safe)));
}

export function markNotificationRead(project, notificationId) {
  const item = (project.notifications || []).find(row => row.id === notificationId);
  if (!item) return null;
  item.readAt = item.readAt || new Date().toISOString();
  return item;
}
