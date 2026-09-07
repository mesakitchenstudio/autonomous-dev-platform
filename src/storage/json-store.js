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
    operations: [],
    checkpoint: emptyCheckpoint(),
    activePrompt: null,
    evidence: null,
    verificationLevel: demo ? 'MOCK' : null,
    permissionLog: [],
    delivery: null,
    error: null,
    errors: [],
    demo: Boolean(demo)
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
    const temp = `${this.file(project.id)}.tmp`;
    await fs.writeFile(temp, JSON.stringify(project, null, 2));
    await fs.rename(temp, this.file(project.id));
    return project;
  }
  async readJson(filePath) {
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw.replace(/^\uFEFF/, ''));
  }
  async get(id) { return this.readJson(this.file(id)); }
  async list() {
    await this.init();
    const files = (await fs.readdir(this.dataDir)).filter(x => x.endsWith('.json') && !x.endsWith('.tmp'));
    const projects = await Promise.all(files.map(async f => this.readJson(path.join(this.dataDir, f))));
    return projects.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
