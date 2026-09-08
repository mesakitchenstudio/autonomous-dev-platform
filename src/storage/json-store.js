import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { emptyCheckpoint } from '../orchestrator/checkpoint.js';

export function createProjectRecord({ idea, projectPath, demo = false, id } = {}) {
  const now = new Date().toISOString();
  return {
    id: id || crypto.randomUUID(),
    idea,
    projectPath: projectPath || null,
    state: 'IDEA_SUBMITTED',
    createdAt: now,
    updatedAt: now,
    iteration: 0,
    history: [],
    council: {},
    cursorRuns: [],
    verificationRuns: [],
    runtimeRuns: [],
    visualReviewRuns: [],
    provisioningRuns: [],
    provisioningPlan: null,
    provisioning: null,
    components: [],
    artifacts: [],
    operations: [],
    checkpoint: emptyCheckpoint(),
    activePrompt: null,
    evidence: null,
    verificationLevel: demo ? 'MOCK' : null,
    permissionLog: [],
    delivery: null,
    deliveries: [],
    ownerReviews: [],
    ownerFeedback: [],
    notifications: [],
    notificationDeliveries: [],
    reviewSessions: [],
    completion: null,
    error: null,
    errors: [],
    demo: Boolean(demo),
    repository: null,
    securityPolicy: null,
    sandboxRuns: [],
    securityFindings: [],
    secretReferences: []
  };
}

export class JsonStore {
  constructor(dataDir) { this.dataDir = path.resolve(dataDir); }
  async init() { await fs.mkdir(this.dataDir, { recursive: true }); }
  file(id) { return path.join(this.dataDir, `${id}.json`); }
  async create({ idea, projectPath, demo = false }) {
    const project = createProjectRecord({ idea, projectPath, demo });
    await this.save(project);
    return project;
  }
  async save(project) {
    project.updatedAt = new Date().toISOString();
    const dest = this.file(project.id);
    const temp = `${dest}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(project, null, 2));
    try {
      await fs.rename(temp, dest);
    } catch (error) {
      if (!['EPERM', 'EEXIST', 'EACCES'].includes(error.code)) throw error;
      await fs.copyFile(temp, dest);
      await fs.unlink(temp).catch(() => {});
    }
    return project;
  }
  async readJson(filePath) {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  }
  async get(id) { return this.readJson(this.file(id)); }
  async appendEvent() { return null; }
  async list() {
    await this.init();
    const files = (await fs.readdir(this.dataDir)).filter(x => x.endsWith('.json') && !x.endsWith('.tmp'));
    const projects = await Promise.all(files.map(async f => this.readJson(path.join(this.dataDir, f))));
    return projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
